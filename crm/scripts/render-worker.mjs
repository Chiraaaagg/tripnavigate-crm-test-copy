#!/usr/bin/env node
// LOCAL render worker for itinerary documents (B1.2 Phase F). The rendering location is
// PENDING the owner: this runs on a local stack only, never against the live project
// unless WORKER_ALLOW=1 is set on purpose with the owner's approval.
//
// Usage:
//   APP_ENV=local SUPABASE_SECRET_KEY=... NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 \
//     node scripts/render-worker.mjs [--once | --loop [--interval-ms 5000]] [--worker local-1]
//   node scripts/render-worker.mjs --sample view.json --out document.pdf   (no database)
//
// A non-local target (review E6-2) needs BOTH WORKER_ALLOW=1 and WORKER_PROJECT_REF equal to
// the project ref in the Supabase URL (https://<ref>.supabase.co). Never put either in a shared
// env file; live use needs the owner's APPROVE for the rendering location.
//
// One job: claim -> render input -> adapter -> branded HTML -> page checks -> PDF
// (Playwright Chromium, headless, every request except data: aborted, system fonts)
// -> layout checks -> upload to the private bucket rendered-documents -> complete with QA
// codes. A final document with placeholders, unsafe words or layout issues is never
// uploaded. Output: one JSON line per job with ids, codes, sizes and timings only;
// never facts, names, amounts, keys or URLs.
//
// Exit codes: 0 done (or idle), 1 refused to start / failure, 2 sample refused.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const crm = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const line = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const stop = (reason) => {
  process.stderr.write(`${JSON.stringify({ outcome: 'refused_to_start', reason })}\n`);
  process.exit(1);
};

const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/;
const sample = value('--sample');

if (!sample) {
  // Environment guard: local stack, or an explicit, approved override.
  const local = process.env.APP_ENV === 'local';
  if (!local && process.env.WORKER_ALLOW !== '1') stop('app_env_not_local');
  if (!process.env.SUPABASE_SECRET_KEY) stop('secret_key_missing');
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  if (!url) stop('supabase_url_missing');
  if (local && !LOOPBACK.test(url)) stop('local_needs_loopback_url');
  if (!local) {
    // Override: the named project must be exactly the URL's project.
    let ref = null;
    try {
      const host = new URL(url).hostname.toLowerCase();
      const m = /^([a-z0-9]{20})\.supabase\.co$/.exec(host);
      ref = m ? m[1] : null;
    } catch {
      ref = null;
    }
    const named = (process.env.WORKER_PROJECT_REF ?? '').trim().toLowerCase();
    if (!named) stop('project_ref_missing');
    if (!ref || ref !== named) stop('project_ref_mismatch');
  }
}

async function load() {
  const { runnerImport } = await import('vite');
  const { module } = await runnerImport(join(crm, 'src/modules/documents/render/worker-entry.ts'), {
    root: crm,
    logLevel: 'silent',
    resolve: {
      alias: [
        { find: /^@\//, replacement: `${join(crm, 'src')}/` },
        { find: /^server-only$/, replacement: join(crm, 'scripts/lib/server-only-empty.mjs') },
      ],
    },
  });
  return module;
}

const mod = await load().catch(() => stop('renderer_unavailable'));
const { chromium } = await import('@playwright/test');
const browser = await chromium.launch({ headless: true }).catch(() => stop('browser_unavailable'));

try {
  if (sample) {
    // Measurement / smoke mode: one view JSON -> PDF file, no database.
    const started = Date.now();
    const rendered = mod.renderView(JSON.parse(readFileSync(sample, 'utf8')));
    const htmlMs = Date.now() - started;
    if (rendered.outcome !== 'rendered') {
      line({ outcome: rendered.outcome });
      process.exitCode = 2;
    } else {
      const pdf = await mod.renderPdf(browser, rendered.html);
      const out = value('--out');
      if (out) writeFileSync(out, pdf.pdf);
      line({
        outcome: 'rendered', htmlMs, pdfMs: pdf.ms, sizeBytes: pdf.sizeBytes, pageCount: pdf.pageCount,
        layoutIssues: pdf.layoutIssues, placeholders: rendered.placeholders.length, blockedRequests: pdf.blockedRequests,
      });
    }
  } else {
    const worker = (value('--worker') ?? `local-${process.pid}`).slice(0, 60);
    const deps = mod.createLocalWorkerDeps({ worker, browser });
    const loop = flag('--loop');
    const interval = Math.max(1000, Number(value('--interval-ms') ?? 5000) || 5000);
    for (;;) {
      let result;
      try {
        result = await mod.processOneJob(deps);
      } catch (error) {
        // Codes only: a database call or an unexpected failure (no message text).
        result = { outcome: 'error', code: error?.name === 'RenderWorkerError' ? `${error.command}:${error.sqlState ?? 'unknown'}${error.hint ? `:${error.hint}` : ''}` : 'unexpected' };
      }
      line({ at: new Date().toISOString(), ...result });
      if (!loop) break;
      if (result.outcome === 'idle' || result.outcome === 'error') await new Promise((r) => setTimeout(r, interval));
    }
  }
} finally {
  await browser.close().catch(() => undefined);
}
