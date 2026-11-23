import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const renderInput = vi.fn();
vi.mock('@/lib/supabase/admin', () => ({ createSupabaseAdminClient: () => ({}) }));
vi.mock('@/modules/itineraries/server/render-worker', async (orig) => ({
  ...(await orig<typeof import('@/modules/itineraries/server/render-worker')>()),
  itineraryRenderInputForWorker: (...a: unknown[]) => renderInput(...a),
}));

import { placeholderTexts } from '@/modules/documents/render/checks';
import { localItineraryHtmlStep } from '@/modules/documents/render/html';
import { htmlToText } from '@/modules/documents/safety';
import { adaptRenderJobInput } from '@/modules/documents/render/job-input';
import { createUrlPdfRenderer, type UrlPdfBrowser, type UrlPdfPage } from '@/modules/documents/render/pdf-url';
import { PRINT_TOKEN_HEADER, PRINT_TOKEN_TTL_SECONDS, signPrintToken, verifyPrintToken } from '@/modules/documents/render/print-token';
import { RenderStepError, type ClaimedJob } from '@/modules/documents/render/worker-core';
import { loadPrintJobInput } from '@/modules/documents/server/print-page';
import { handleOnlineRenderRequest, runOnlineRenderJob, type OnlineRenderEnv, type OnlineRunDeps } from '@/modules/documents/server/render-online';
import { stableHash } from '@/modules/itineraries/files';
import type { ItineraryRenderInput } from '@/modules/itineraries/server/render-worker';

/**
 * B1.2 DEC-49: the online PDF maker (built, not deployed) with fakes only:
 * the signed print link, the URL renderer (fake Chromium), one job end to end
 * (fake Supabase and Chromium), the worker route's auth and switch, the print
 * page's refusals, and the import graph (no react-dom/server). Synthetic data.
 */

const SECRET = 'synthetic-print-token-secret-0123456789abcdef';
const JOB = '44444444-4444-4444-8444-444444444444';
const DOCUMENT = '55555555-5555-4555-8555-555555555555';
const PATH = `66666666-6666-4666-8666-666666666666/${DOCUMENT}/${JOB}.pdf`;
const DAY = '2026-10-13';
const NOW = Date.parse('2026-10-13T06:00:00Z');
const SITE = 'https://crm.synthetic.example';

const FACTS = {
  destination: 'UAE', startDate: '2026-11-20', endDate: '2026-11-22',
  party: { adults: 2, children: 0, childAges: null, infants: 0 },
  stays: [{ city: 'Dubai', nights: 2, checkIn: '2026-11-20', checkOut: '2026-11-22', hotelName: 'Synthetic Marina Hotel', roomType: 'Deluxe', mealPlan: 'Breakfast', rooms: 1 }],
  days: [1, 2, 3].map((n) => ({ n, date: null, base: 'Dubai', title: `Day ${n}`, story: 'A calm synthetic day.', highlights: [], meals: null })),
  transfers: [{ date: '2026-11-20', from: 'DXB Airport', to: 'Dubai hotel', mode: 'Private car' }],
  activities: [], flights: [], inclusions: ['Daily breakfast'], exclusions: ['Visa fees'], provenance: {},
};

const RUNNING: Extract<ItineraryRenderInput, { status: 'running' }> = {
  status: 'running', jobId: JOB, documentId: DOCUMENT, kind: 'preview', templateVersion: 'itinerary-2', inputHash: '0'.repeat(64),
  factsHash: 'f'.repeat(64), factsChanged: false, basisChanged: false, facts: FACTS as never, title: 'Synthetic itinerary',
  basis: { kind: 'none', id: null, hash: '0'.repeat(64) }, money: null, branchCode: 'JDH',
};

describe('print link (signed, two minutes, one job)', () => {
  it('verifies only a genuine, unexpired link for the same job', () => {
    const token = signPrintToken({ jobId: JOB, worker: 'online-abc12345', day: DAY }, SECRET, NOW);
    expect(verifyPrintToken(token, JOB, SECRET, NOW)).toMatchObject({ j: JOB, w: 'online-abc12345', d: DAY });
    expect(verifyPrintToken(token, '55555555-5555-4555-8555-555555555555', SECRET, NOW)).toBeNull();
    expect(verifyPrintToken(token, JOB, `${SECRET}x`, NOW)).toBeNull();
    expect(verifyPrintToken(token, JOB, SECRET, NOW + (PRINT_TOKEN_TTL_SECONDS + 1) * 1000)).toBeNull();
    const [body, sig] = token.split('.') as [string, string];
    const forged = Buffer.from(JSON.stringify({ j: JOB, w: 'online-abc12345', d: DAY, e: Math.floor(NOW / 1000) + 60 })).toString('base64url');
    expect(verifyPrintToken(`${forged}.${sig}`, JOB, SECRET, NOW)).toBeNull();
    expect(verifyPrintToken(`${body}.`, JOB, SECRET, NOW)).toBeNull();
    expect(verifyPrintToken(null, JOB, SECRET, NOW)).toBeNull();
    // A short or missing secret never verifies and never signs.
    expect(verifyPrintToken(token, JOB, 'short', NOW)).toBeNull();
    expect(() => signPrintToken({ jobId: JOB, worker: 'w', day: DAY }, 'short', NOW)).toThrow();
    // The lifetime is capped at two minutes whatever is asked.
    const long = signPrintToken({ jobId: JOB, worker: 'w', day: DAY }, SECRET, NOW, 3600);
    expect(verifyPrintToken(long, JOB, SECRET, NOW + 121_000)).toBeNull();
  });
});

/** A fake Chromium: records contexts, routes and navigations; serves one page. */
function fakeBrowser(o: { status?: number; markup?: string | null; issues?: string[]; requests?: string[]; stray?: string } = {}) {
  const log: Array<{ js: boolean; gotos: string[]; allowed: string[]; aborted: string[]; printed: boolean; headers: Record<string, string> }> = [];
  const browser: UrlPdfBrowser = {
    async newContext({ javaScriptEnabled }) {
      const entry = { js: javaScriptEnabled, gotos: [] as string[], allowed: [] as string[], aborted: [] as string[], printed: false, headers: {} as Record<string, string> };
      log.push(entry);
      let handler: Parameters<Awaited<ReturnType<UrlPdfBrowser['newContext']>>['route']>[1] | null = null;
      return {
        async route(_p, h) {
          handler = h;
        },
        async setExtraHTTPHeaders(h) {
          entry.headers = h;
        },
        async newPage(): Promise<UrlPdfPage> {
          return {
            async goto(url) {
              entry.gotos.push(url);
              for (const r of [url, ...(o.requests ?? [])]) {
                await handler!({ request: () => ({ url: () => r }), abort: async () => void entry.aborted.push(r), continue: async () => void entry.allowed.push(r) });
              }
              return { status: () => o.status ?? 200 };
            },
            async evaluate() {
              const markup = o.markup === undefined ? '<article id="itinerary-document">Synthetic</article>' : o.markup;
              const bodyText = `${o.stray ? `${o.stray}\n` : ''}${markup ? htmlToText(markup) : ''}`;
              return { markup, bodyText, placeholders: markup ? placeholderTexts(markup) : [], strayText: !!o.stray, issues: o.issues ?? [] } as never;
            },
            async pdf() {
              entry.printed = true;
              return new TextEncoder().encode('%PDF-1.7 /Type /Page /Type /Page');
            },
          };
        },
        async close() {},
      };
    },
  };
  return { browser, log };
}

describe('URL renderer (fake Chromium)', () => {
  it('checks with JavaScript on, prints with JavaScript off; only the app origin is reachable', async () => {
    const { browser, log } = fakeBrowser({ requests: [`${SITE}/_next/static/css/app.css`, 'https://fonts.example.net/x.woff2', 'data:font/woff2;base64,AA'] });
    const r = createUrlPdfRenderer({ browser, origin: SITE });
    const url = `${SITE}/print/itinerary/${JOB}?t=x`;
    const checked = await r.check(url);
    const pdf = await r.print(url, checked);
    expect(log.map((c) => c.js)).toEqual([true, false]);
    expect(log[1]!.printed).toBe(true);
    expect(log[0]!.aborted).toEqual(['https://fonts.example.net/x.woff2']);
    expect(log[0]!.allowed).toHaveLength(3);
    expect(pdf).toMatchObject({ pageCount: 2, blockedRequests: 2, layoutIssues: [] });
  });

  it('refuses another origin, a non-200 page and a page without the template', async () => {
    const r = createUrlPdfRenderer({ browser: fakeBrowser().browser, origin: SITE });
    await expect(r.check(`https://elsewhere.example/print/itinerary/${JOB}`)).rejects.toBeInstanceOf(RenderStepError);
    await expect(createUrlPdfRenderer({ browser: fakeBrowser({ status: 404 }).browser, origin: SITE }).check(`${SITE}/p`)).rejects.toMatchObject({ code: 'internal' });
    await expect(createUrlPdfRenderer({ browser: fakeBrowser({ markup: null }).browser, origin: SITE }).check(`${SITE}/p`)).rejects.toMatchObject({ code: 'internal' });
  });
});

function env(o: Partial<OnlineRenderEnv> = {}): OnlineRenderEnv {
  return { on: true, printTokenSecret: SECRET, siteUrl: SITE, workerSecret: 'w'.repeat(40), cronSecret: 'c'.repeat(40), ...o };
}

async function realMarkup(): Promise<string> {
  const adapted = adaptRenderJobInput(JOB, RUNNING, DAY);
  if (!adapted.ok) throw new Error('fixture refused');
  const doc = await localItineraryHtmlStep('.tn-doc{}')(null, adapted.input, 'Itinerary Synthetic itinerary');
  const m = /<article[\s\S]*<\/article>/.exec(doc.html);
  return m![0];
}

function runDeps(o: { env?: Partial<OnlineRenderEnv>; markup?: string; launchFails?: boolean; stray?: string; kind?: 'preview' | 'final' } = {}) {
  const adapted = adaptRenderJobInput(JOB, RUNNING, DAY);
  if (!adapted.ok) throw new Error('fixture refused');
  const job: ClaimedJob = { jobId: JOB, documentId: DOCUMENT, kind: o.kind ?? 'preview', inputHash: stableHash(adapted.input), templateVersion: 'itinerary-2', factsHash: 'f'.repeat(64), attempts: 1, objectPath: PATH } as ClaimedJob;
  const fake = fakeBrowser({ markup: o.markup, stray: o.stray });
  const calls = { complete: vi.fn(), upload: vi.fn(), closed: false };
  const deps: OnlineRunDeps = {
    env: env(o.env),
    launch: async () => {
      if (o.launchFails) throw new Error('no browser');
      return {
        ...fake.browser,
        close: async () => {
          calls.closed = true;
        },
      };
    },
    supabase: () => ({
      claim: async () => job,
      input: async () => ({ ...RUNNING, kind: job.kind, inputHash: job.inputHash }),
      upload: async (p) => void calls.upload(p),
      complete: async (...a) => {
        calls.complete(...a);
        return { status: 'succeeded', jobId: JOB, renderedId: '77777777-7777-4777-8777-777777777777' } as never;
      },
    }),
    now: () => NOW,
    today: () => DAY,
  };
  return { deps, calls, log: fake.log };
}

describe('one online job (fake Supabase and Chromium)', () => {
  it('opens the print page on the configured site with a signed header token, checks the page, prints, uploads, completes', async () => {
    const { deps, calls, log } = runDeps({ markup: await realMarkup() });
    const r = await runOnlineRenderJob(deps);
    expect(r).toMatchObject({ status: 'ran', outcome: { outcome: 'completed', status: 'succeeded', errorCode: null } });
    expect(calls.upload).toHaveBeenCalledWith(PATH);
    expect(calls.complete.mock.calls[0]![1]).toBe(true);
    expect(calls.closed).toBe(true);
    const url = new URL(log[0]!.gotos[0]!);
    expect(url.origin).toBe(SITE);
    expect(url.pathname).toBe(`/print/itinerary/${JOB}`);
    // Review E10-6: no token in the URL; a fresh one in a header for each page load.
    expect(url.search).toBe('');
    expect(log[1]!.headers[PRINT_TOKEN_HEADER]).toBeTruthy();
    const link = verifyPrintToken(log[0]!.headers[PRINT_TOKEN_HEADER], JOB, SECRET, NOW);
    expect(link).toMatchObject({ j: JOB, d: DAY });
    expect(link!.w).toMatch(/^online-[0-9a-f]{8}$/);
    // The result carries codes and sizes only, never the link.
    expect(JSON.stringify(r)).not.toContain('t=');
  });

  it('a placeholder or unsafe word on the page is caught from the page markup', async () => {
    const { deps, calls } = runDeps({ markup: '<article id="itinerary-document"><span class="fill">Hotel name</span></article>' });
    const r = await runOnlineRenderJob(deps);
    expect(r).toMatchObject({ status: 'ran', outcome: { placeholders: 1 } });
    expect(calls.complete).toHaveBeenCalled();
  });

  it('E10-2: visible text outside the template fails a final as content_safety; a preview keeps the code', async () => {
    const markup = await realMarkup();
    const final = runDeps({ markup, stray: 'Staging environment: synthetic data only.', kind: 'final' });
    await runOnlineRenderJob(final.deps);
    expect(final.calls.upload).not.toHaveBeenCalled();
    expect(final.calls.complete.mock.calls[0]!.slice(1, 3)).toEqual([false, 'content_safety']);
    const preview = runDeps({ markup, stray: 'Skip to main content' });
    await runOnlineRenderJob(preview.deps);
    expect(preview.calls.complete.mock.calls[0]![3]).toMatchObject({ qa: { safetyHits: ['page_chrome'] } });
  });

  it('E10-2: an unsafe word anywhere on the printed page is caught', async () => {
    const markup = await realMarkup();
    const r = runDeps({ markup, stray: 'Supplier rate sheet attached', kind: 'final' });
    await runOnlineRenderJob(r.deps);
    expect(r.calls.complete.mock.calls[0]!.slice(1, 3)).toEqual([false, 'content_safety']);
  });

  it('does nothing while switched off or not configured; a missing browser is reported', async () => {
    expect(await runOnlineRenderJob(runDeps({ env: { on: false } }).deps)).toEqual({ status: 'switched_off' });
    expect(await runOnlineRenderJob(runDeps({ env: { printTokenSecret: 'short' } }).deps)).toEqual({ status: 'not_configured', code: 'print_token_secret_missing' });
    expect(await runOnlineRenderJob(runDeps({ env: { siteUrl: null } }).deps)).toEqual({ status: 'not_configured', code: 'site_url_missing' });
    expect(await runOnlineRenderJob(runDeps({ launchFails: true }).deps)).toEqual({ status: 'browser_unavailable' });
  });
});

describe('worker route', () => {
  const req = (auth?: string) => new Request('https://crm.synthetic.example/api/integrations/render/worker', { method: 'POST', headers: auth ? { authorization: auth } : {} });
  it('needs the right bearer; off = 404 after auth; cron uses CRON_SECRET', async () => {
    const off = runDeps({ env: { on: false } }).deps;
    expect((await handleOnlineRenderRequest(req(), 'manual', off)).status).toBe(401);
    expect((await handleOnlineRenderRequest(req(`Bearer ${'c'.repeat(40)}`), 'manual', off)).status).toBe(401);
    expect((await handleOnlineRenderRequest(req(`Bearer ${'w'.repeat(40)}`), 'manual', off)).status).toBe(404);
    expect((await handleOnlineRenderRequest(req(`Bearer ${'c'.repeat(40)}`), 'cron', off)).status).toBe(404);
    const noSecret = runDeps({ env: { workerSecret: 'short' } }).deps;
    expect((await handleOnlineRenderRequest(req(`Bearer short`), 'manual', noSecret)).status).toBe(503);
  });
});

describe('print page data', () => {
  it('refuses while off, without a genuine link, or when the lease is gone; prints the adapted input otherwise', async () => {
    const token = signPrintToken({ jobId: JOB, worker: 'online-abc12345', day: DAY }, SECRET, Date.now());
    vi.stubEnv('RENDER_PRINT_TOKEN_SECRET', SECRET);
    vi.stubEnv('PDF_RENDER_ONLINE', '');
    expect(await loadPrintJobInput(JOB, token)).toBeNull();
    vi.stubEnv('PDF_RENDER_ONLINE', 'on');
    expect(await loadPrintJobInput(JOB, 'nope')).toBeNull();
    expect(await loadPrintJobInput('not-a-uuid', token)).toBeNull();
    expect(renderInput).not.toHaveBeenCalled();
    renderInput.mockResolvedValueOnce({ status: 'conflict' });
    expect(await loadPrintJobInput(JOB, token)).toBeNull();
    renderInput.mockResolvedValueOnce(RUNNING);
    const input = await loadPrintJobInput(JOB, token);
    expect(input).toMatchObject({ destination: expect.any(String) });
    expect(renderInput).toHaveBeenLastCalledWith({ jobId: JOB, worker: 'online-abc12345' }, expect.anything());
    vi.unstubAllEnvs();
  });
});

describe('the print page and the worker route stay renderable in the Next.js server layer', () => {
  const SRC = resolve(__dirname, '..', '..', 'src');
  const FORBIDDEN = [/react-dom\/server/, /render\/html(\.tsx)?$/, /render\/render-view(\.ts)?$/];
  const resolveImport = (from: string, spec: string): string | null => {
    const base = spec.startsWith('@/') ? join(SRC, spec.slice(2)) : spec.startsWith('.') ? resolve(dirname(from), spec) : null;
    if (!base) return null;
    for (const ext of ['.ts', '.tsx', '/index.ts', '/index.tsx', '']) if (existsSync(base + ext) && /\.(ts|tsx)$/.test(base + ext)) return base + ext;
    return null;
  };
  for (const route of ['app/print/itinerary/[jobId]/page.tsx', 'app/api/integrations/render/worker/route.ts']) {
    it(`${route} never reaches react-dom/server or the Node render seam`, () => {
      const seen = new Set<string>();
      const bad: string[] = [];
      const stack = [join(SRC, route)];
      while (stack.length) {
        const file = stack.pop()!;
        if (seen.has(file)) continue;
        seen.add(file);
        const text = readFileSync(file, 'utf8');
        for (const m of text.matchAll(/(?:import|export)\s[^'"]*?from\s+'([^']+)'|import\s+'([^']+)'/g)) {
          const spec = (m[1] ?? m[2])!;
          if (FORBIDDEN.some((re) => re.test(spec)) && !/import type/.test(m[0])) bad.push(`${file.slice(SRC.length + 1)} imports ${spec}`);
          const next = resolveImport(file, spec);
          if (next) stack.push(next);
        }
      }
      expect(seen.size).toBeGreaterThan(3);
      expect(bad).toEqual([]);
    });
  }
});
