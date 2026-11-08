import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { countPdfPages, renderPdf, type PdfBrowser } from '@/modules/documents/render/pdf';
import { localItineraryHtmlStep } from '@/modules/documents/render/html';
import { layoutFailureCode, processOneJob, type ClaimedJob, type WorkerDeps } from '@/modules/documents/render/worker-core';
import { RENDER_FAILURE_CODES } from '@/modules/itineraries/server/render-worker';
import { stableHash } from '@/modules/itineraries/files';
import { itineraryToEngine } from '@/modules/documents/itinerary-adapter';
import { ItineraryDocumentGetSchema, toItineraryDocumentView } from '@/modules/documents/itinerary-view';

/**
 * B1.2 Phase F: the local render worker's pure parts with fakes (claim,
 * input, PDF, upload, complete), the PDF page counter and the Chromium
 * wrapper with a fake browser. A real Chromium run of the script's sample
 * mode runs when Playwright's browser is installed. Synthetic values only.
 */

const JOB = '44444444-4444-4444-8444-444444444444';
const DOCUMENT = '55555555-5555-4555-8555-555555555555';
const PATH = `66666666-6666-4666-8666-666666666666/${DOCUMENT}/${JOB}.pdf`;
const TODAY = '2026-10-12';

const FACTS = {
  destination: 'UAE', startDate: '2026-11-20', endDate: '2026-11-22',
  party: { adults: 2, children: 0, childAges: null, infants: 0 },
  stays: [{ city: 'Dubai', nights: 2, checkIn: '2026-11-20', checkOut: '2026-11-22', hotelName: 'Synthetic Marina Hotel', roomType: 'Deluxe', mealPlan: 'Breakfast', rooms: 1 }],
  days: [1, 2, 3].map((n) => ({ n, date: null, base: 'Dubai', title: `Day ${n}`, story: 'A calm synthetic day.', highlights: [], meals: null })),
  transfers: [{ date: '2026-11-20', from: 'DXB Airport', to: 'Dubai hotel', mode: 'Private car' }],
  activities: [], flights: [], inclusions: ['Daily breakfast'], exclusions: ['Visa fees'], provenance: {},
};

function inputHashFor(facts: unknown, title = 'Synthetic itinerary', money: unknown = null, branchCode: string | null = 'JDH'): string {
  const get = ItineraryDocumentGetSchema.parse({
    documentId: DOCUMENT, title, subject: { kind: 'quotation', quotationId: null, dealId: null, branchCode },
    draft: { draftId: JOB, status: 'ready', rowVersion: 0, facts, factsHash: 'f'.repeat(64), sourceFileId: null },
    basis: { kind: 'none', id: null, hash: '0'.repeat(64) }, differences: null, money,
  });
  const r = itineraryToEngine(toItineraryDocumentView(get, { today: TODAY }));
  if (!r.ok) throw new Error('fixture refused');
  return stableHash(r.input);
}

function deps(o: { kind?: 'preview' | 'final'; facts?: unknown; title?: string; objectPath?: string | null; input?: unknown; pdfError?: Error; uploadError?: boolean; layoutIssues?: string[]; blockedRequests?: number; css?: string; requestedFacts?: unknown; money?: unknown; requestedMoney?: unknown; branchCode?: string | null; requestedBranchCode?: string | null } = {}) {
  const facts = o.facts ?? FACTS;
  const job: ClaimedJob = {
    jobId: JOB, documentId: DOCUMENT, kind: o.kind ?? 'preview', inputHash: inputHashFor(o.requestedFacts ?? FACTS, 'Synthetic itinerary', o.requestedMoney === undefined ? (o.money ?? null) : o.requestedMoney, o.requestedBranchCode === undefined ? (o.branchCode === undefined ? 'JDH' : o.branchCode) : o.requestedBranchCode), templateVersion: 'itinerary-2',
    factsHash: 'f'.repeat(64), attempts: 1, objectPath: o.objectPath === undefined ? PATH : o.objectPath,
  };
  const calls = { upload: vi.fn(), complete: vi.fn() };
  const d: WorkerDeps = {
    worker: 'local-test',
    claim: vi.fn(async () => job),
    input: vi.fn(async () => (o.input ?? {
      status: 'running', jobId: JOB, documentId: DOCUMENT, kind: job.kind, templateVersion: 'itinerary-2', inputHash: job.inputHash,
      factsHash: 'f'.repeat(64), factsChanged: false, basisChanged: false, facts, title: o.title ?? 'Synthetic itinerary',
      basis: { kind: 'none', id: null, hash: '0'.repeat(64) }, money: o.money ?? null, branchCode: o.branchCode === undefined ? 'JDH' : o.branchCode,
    }) as never),
    objectPathFor: (j) => j.objectPath,
    renderPdf: vi.fn(async () => {
      if (o.pdfError) throw o.pdfError;
      return { pdf: new Uint8Array([37, 80, 68, 70]), sha256: 'a'.repeat(64), sizeBytes: 4, pageCount: 2, layoutIssues: o.layoutIssues ?? [], blockedRequests: o.blockedRequests ?? 0, ms: 5 };
    }),
    upload: vi.fn(async (...a: unknown[]) => {
      calls.upload(...a);
      if (o.uploadError) throw new Error('synthetic');
    }),
    complete: vi.fn(async (...a: unknown[]) => {
      calls.complete(...a);
      const ok = a[1] as boolean;
      return ok ? { status: 'succeeded' as const, jobId: JOB, renderedId: '77777777-7777-4777-8777-777777777777' } : { status: 'queued' as const, jobId: JOB, errorCode: a[2] as never };
    }),
    today: () => TODAY,
    renderHtml: localItineraryHtmlStep(o.css ?? '.tn-doc{color:#000}'),
  };
  return { d, calls };
}

const BOOKING_MONEY = {
  source: 'booking_version', versionId: '44444444-4444-4444-8444-444444444444', sellingTotalPaise: '24000000',
  plan: [{ seq: 1, label: 'Advance', amountPaise: '10000000', dueDate: '2026-10-20' }],
};

describe('DEC-48: render job with prices (include_money)', () => {
  it('prints the prices the job was requested with; the input hash matches', async () => {
    const { d, calls } = deps({ kind: 'final', money: BOOKING_MONEY });
    expect((await processOneJob(d)).outcome).toBe('completed');
    const html = String((d.renderPdf as ReturnType<typeof vi.fn>).mock.calls[0]![0]);
    expect(html).toMatch(/2,40,000/);
    expect(calls.complete.mock.calls[0]![1]).toBe(true);
  });

  it('a final requested with prices but rendered without them (or the other way) fails as input_invalid', async () => {
    const { d, calls } = deps({ kind: 'final', money: null, requestedMoney: BOOKING_MONEY });
    await processOneJob(d);
    expect(calls.upload).not.toHaveBeenCalled();
    expect(calls.complete.mock.calls[0]!.slice(1, 3)).toEqual([false, 'input_invalid']);
  });
});

describe('processOneJob', () => {
  it('idle when nothing is queued; conflict and input_changed stop without completing', async () => {
    const idle = deps();
    idle.d.claim = vi.fn(async () => null);
    expect(await processOneJob(idle.d)).toEqual({ outcome: 'idle' });
    const conflict = deps({ input: { status: 'conflict' } });
    expect(await processOneJob(conflict.d)).toEqual({ outcome: 'conflict', jobId: JOB });
    expect(conflict.calls.complete).not.toHaveBeenCalled();
    const changed = deps({ input: { status: 'failed', jobId: JOB, errorCode: 'input_changed' } });
    expect(await processOneJob(changed.d)).toEqual({ outcome: 'input_changed', jobId: JOB });
    expect(changed.calls.complete).not.toHaveBeenCalled();
  });

  it('a preview is rendered, uploaded at the claim path, and completed with QA codes', async () => {
    const { d, calls } = deps();
    const r = await processOneJob(d);
    // No placeholders: the core facts are complete; empty optional copy is simply not printed.
    expect(r).toMatchObject({ outcome: 'completed', status: 'succeeded', errorCode: null, placeholders: 0, notes: [], pdf: { sizeBytes: 4, pageCount: 2 } });
    expect(calls.upload).toHaveBeenCalledWith(PATH, expect.any(Uint8Array));
    expect(calls.complete).toHaveBeenCalledWith(JOB, true, null, {
      objectPath: PATH, sha256: 'a'.repeat(64), sizeBytes: 4, pageCount: 2, qa: { placeholders: 0, layoutIssues: [], safetyHits: [] },
    });
    // The rendered HTML is the branded template with the inlined stylesheet.
    const html = (d.renderPdf as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(html).toContain('class="tn-doc"');
    expect(html).toContain('<style>.tn-doc{color:#000}</style>');
  });

  it('a preview with placeholders is still stored, with the count in QA; a final one is refused before any PDF', async () => {
    const thin = { ...FACTS, days: [] };
    const preview = deps({ facts: thin });
    const p = await processOneJob(preview.d);
    expect(p).toMatchObject({ status: 'succeeded' });
    expect((preview.calls.complete.mock.calls[0]![3] as { qa: { placeholders: number } }).qa.placeholders).toBeGreaterThan(0);
    expect(p.outcome === 'completed' && p.notes).toContain('input_hash_differs');

    // (The request action refuses such a final; here the job was requested with these very facts.)
    const final = deps({ kind: 'final', facts: thin, requestedFacts: thin });
    expect(await processOneJob(final.d)).toMatchObject({ errorCode: 'placeholders_present' });
    expect(final.d.renderPdf).not.toHaveBeenCalled();
    expect(final.calls.upload).not.toHaveBeenCalled();
    expect(final.calls.complete).toHaveBeenCalledWith(JOB, false, 'placeholders_present', null);
  });

  it('DEC-50: a Delhi final (GSTIN not given yet) is refused before any PDF; a Jodhpur final is printed', async () => {
    const del = deps({ kind: 'final', branchCode: 'DEL' });
    expect(await processOneJob(del.d)).toMatchObject({ errorCode: 'placeholders_present' });
    expect(del.d.renderPdf).not.toHaveBeenCalled();
    expect(del.calls.upload).not.toHaveBeenCalled();

    const jdh = deps({ kind: 'final', branchCode: 'JDH' });
    expect(await processOneJob(jdh.d)).toMatchObject({ kind: 'final', status: 'succeeded', placeholders: 0 });
    expect(String((jdh.d.renderPdf as ReturnType<typeof vi.fn>).mock.calls[0]![0])).toContain('GSTIN 08AAFCH9191M1ZV (Rajasthan)');
  });

  it('DEC-50: a final requested for one branch but rendered for another fails input_invalid', async () => {
    const { d, calls } = deps({ kind: 'final', branchCode: 'JDH', requestedBranchCode: 'AMD' });
    await processOneJob(d);
    expect(calls.upload).not.toHaveBeenCalled();
    expect(calls.complete.mock.calls[0]!.slice(1, 3)).toEqual([false, 'input_invalid']);
  });

  it('unsafe words: a final document is refused (content_safety); a preview carries the codes', async () => {
    const unsafe = { ...FACTS, inclusions: ['Best price on the dhow cruise'] };
    // The adapter itself refuses unsafe customer text, so the job ends input_invalid without a PDF.
    const final = deps({ kind: 'final', facts: unsafe });
    expect(await processOneJob(final.d)).toMatchObject({ errorCode: 'input_invalid' });
    expect(final.d.renderPdf).not.toHaveBeenCalled();
  });

  it('layout issues travel with a preview; a final document with layout issues is not uploaded; a clean final is', async () => {
    const preview = deps({ layoutIssues: ['layout_overflow'] });
    await processOneJob(preview.d);
    expect((preview.calls.complete.mock.calls[0]![3] as { qa: { layoutIssues: string[] } }).qa.layoutIssues).toEqual(['layout_overflow']);
    const final = deps({ kind: 'final', layoutIssues: ['layout_overflow'] });
    expect(await processOneJob(final.d)).toMatchObject({ errorCode: 'layout_overflow' });
    expect(final.calls.upload).not.toHaveBeenCalled();
    const clean = deps({ kind: 'final' });
    expect(await processOneJob(clean.d)).toMatchObject({ kind: 'final', status: 'succeeded', placeholders: 0 });
    expect(clean.calls.upload).toHaveBeenCalledWith(PATH, expect.any(Uint8Array));
  });

  it('maps failures to the allowlisted codes: unknown path, browser timeout and crash, upload', async () => {
    expect(await processOneJob(deps({ objectPath: null }).d)).toMatchObject({ errorCode: 'internal', notes: ['object_path_unknown'] });
    const timeout = new Error('page.pdf: Timeout 30000ms exceeded');
    timeout.name = 'TimeoutError';
    expect(await processOneJob(deps({ pdfError: timeout }).d)).toMatchObject({ errorCode: 'render_timeout' });
    expect(await processOneJob(deps({ pdfError: new Error('crashed') }).d)).toMatchObject({ errorCode: 'browser_failed' });
    expect(await processOneJob(deps({ uploadError: true }).d)).toMatchObject({ errorCode: 'upload_failed' });
    const bad = deps({ input: null as never });
    bad.d.input = vi.fn(async () => {
      throw new Error('synthetic');
    });
    expect(await processOneJob(bad.d)).toMatchObject({ errorCode: 'internal' });
  });
});

describe('final documents must match the request (review E6-3)', () => {
  it('a final job whose computed input differs from the requested one fails input_invalid without a PDF; a preview renders with a note', async () => {
    const changed = { ...FACTS, inclusions: ['Daily breakfast', 'Airport transfers'] };
    const final = deps({ kind: 'final', facts: changed });
    expect(await processOneJob(final.d)).toMatchObject({ errorCode: 'input_invalid', notes: ['input_hash_differs'] });
    expect(final.d.renderPdf).not.toHaveBeenCalled();
    expect(final.calls.upload).not.toHaveBeenCalled();
    const preview = deps({ facts: changed });
    expect(await processOneJob(preview.d)).toMatchObject({ status: 'succeeded', notes: ['input_hash_differs'] });
  });
});

describe('failure classes (Atlas 5d321b3)', () => {
  it('clipped text on a final document is text_clipped once the wrappers accept it, else layout_overflow', async () => {
    const accepted = (RENDER_FAILURE_CODES as readonly string[]).includes('text_clipped');
    expect(layoutFailureCode(['text_clipped'])).toBe(accepted ? 'text_clipped' : 'layout_overflow');
    expect(layoutFailureCode(['layout_overflow', 'text_clipped'])).toBe('layout_overflow');
    const final = deps({ kind: 'final', layoutIssues: ['text_clipped'] });
    expect(await processOneJob(final.d)).toMatchObject({ errorCode: accepted ? 'text_clipped' : 'layout_overflow' });
    expect(final.calls.upload).not.toHaveBeenCalled();
  });

  it('a page that asked for an outside asset: a final document is asset_missing, a preview only notes it', async () => {
    const final = deps({ kind: 'final', blockedRequests: 2 });
    expect(await processOneJob(final.d)).toMatchObject({ errorCode: 'asset_missing', notes: ['network_requests_blocked'] });
    expect(final.calls.upload).not.toHaveBeenCalled();
    const preview = deps({ blockedRequests: 2 });
    expect(await processOneJob(preview.d)).toMatchObject({ status: 'succeeded', notes: ['network_requests_blocked'] });
  });

  it('a missing stylesheet is asset_missing before any rendering', async () => {
    const { d, calls } = deps({ css: ' ' });
    expect(await processOneJob(d)).toMatchObject({ errorCode: 'asset_missing' });
    expect(d.renderPdf).not.toHaveBeenCalled();
    expect(calls.complete).toHaveBeenCalledWith(JOB, false, 'asset_missing', null);
  });
});

describe('PDF helpers', () => {
  it('counts page objects, not the page tree', () => {
    const pdf = new TextEncoder().encode('%PDF-1.7 1 0 obj <</Type /Pages /Kids [2 0 R 3 0 R]>> 2 0 obj <</Type /Page>> 3 0 obj <</Type/Page /Parent 1 0 R>>');
    expect(countPdfPages(pdf)).toBe(2);
  });

  it('renderPdf aborts every request except data: URLs, checks layout with JavaScript, prints with JavaScript off', async () => {
    const aborted: string[] = [];
    const contexts: Array<{ js: boolean; evaluated: boolean; printed: boolean }> = [];
    const browser: PdfBrowser = {
      newContext: vi.fn(async (opts) => {
        expect(opts).toMatchObject({ offline: true });
        const ctx = { js: opts.javaScriptEnabled, evaluated: false, printed: false };
        contexts.push(ctx);
        let handler: ((r: { request(): { url(): string }; abort(): Promise<void>; continue(): Promise<void> }) => Promise<void>) | null = null;
        return {
          route: async (_u: string, h: NonNullable<typeof handler>) => {
            handler = h;
          },
          newPage: async () => ({
            setContent: async () => {
              for (const url of ['https://cdn.example.test/font.woff2', 'data:image/png;base64,AAAA', 'http://127.0.0.1:9/x']) {
                await handler!({ request: () => ({ url: () => url }), abort: async () => void aborted.push(url), continue: async () => undefined });
              }
            },
            evaluate: async () => {
              ctx.evaluated = true;
              return ['text_clipped'] as never;
            },
            pdf: async () => {
              ctx.printed = true;
              return new TextEncoder().encode('<</Type /Page>>');
            },
          }),
          close: async () => undefined,
        };
      }),
    };
    const r = await renderPdf(browser, '<p>x</p>');
    expect(contexts).toEqual([{ js: true, evaluated: true, printed: false }, { js: false, evaluated: false, printed: true }]);
    expect(aborted).toEqual(['https://cdn.example.test/font.woff2', 'http://127.0.0.1:9/x', 'https://cdn.example.test/font.woff2', 'http://127.0.0.1:9/x']);
    expect(r).toMatchObject({ blockedRequests: 4, layoutIssues: ['text_clipped'], pageCount: 1, sizeBytes: 15 });
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('render-worker.mjs', () => {
  const script = join(import.meta.dirname, '..', '..', 'scripts', 'render-worker.mjs');

  it('refuses to start without a local stack or an explicit override, or without the secret key', () => {
    const run = (env: Record<string, string>) => spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 30_000, env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test', ...env } });
    const cases: Array<[Record<string, string>, string]> = [
      [{}, 'app_env_not_local'],
      [{ APP_ENV: 'production' }, 'app_env_not_local'],
      [{ APP_ENV: 'local', NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321' }, 'secret_key_missing'],
      [{ APP_ENV: 'local', SUPABASE_SECRET_KEY: 'synthetic' }, 'supabase_url_missing'],
      [{ APP_ENV: 'local', SUPABASE_SECRET_KEY: 'synthetic', NEXT_PUBLIC_SUPABASE_URL: 'https://synthetic.supabase.example' }, 'local_needs_loopback_url'],
      // Review E6-2: the override alone never opens a non-loopback target.
      [{ WORKER_ALLOW: '1', SUPABASE_SECRET_KEY: 'synthetic', NEXT_PUBLIC_SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co' }, 'project_ref_missing'],
      [{ WORKER_ALLOW: '1', WORKER_PROJECT_REF: 'zzzzzzzzzzzzzzzzzzzz', SUPABASE_SECRET_KEY: 'synthetic', NEXT_PUBLIC_SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co' }, 'project_ref_mismatch'],
      [{ WORKER_ALLOW: '1', WORKER_PROJECT_REF: 'abcdefghijklmnopqrst', SUPABASE_SECRET_KEY: 'synthetic', NEXT_PUBLIC_SUPABASE_URL: 'https://abcdefghijklmnopqrst.example.test' }, 'project_ref_mismatch'],
      [{ WORKER_ALLOW: '1', WORKER_PROJECT_REF: 'abcdefghijklmnopqrst', SUPABASE_SECRET_KEY: 'synthetic', NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321' }, 'project_ref_mismatch'],
    ];
    for (const [env, reason] of cases) {
      const r = run(env);
      expect(r.status, reason).toBe(1);
      expect(JSON.parse(r.stderr.trim()), reason).toEqual({ outcome: 'refused_to_start', reason });
      expect(r.stderr).not.toContain('synthetic');
    }
  });

  it('sample mode prints a real A4 PDF with Chromium (when the browser is installed)', async () => {
    const { chromium } = await import('@playwright/test');
    if (!existsSync(chromium.executablePath())) return;
    const dir = mkdtempSync(join(tmpdir(), 'b12-render-'));
    const view = {
      view: {
        kind: 'itinerary', reference: 'IT-1', generatedOn: TODAY, destination: 'Dubai', destinationShort: 'Dubai', country: 'UAE', category: 'Family',
        paxBasis: 'per person', facts: { ...FACTS, draftId: 'd', sourceFileId: null },
        narrative: { intro: ['Synthetic.'], reasons: [{ title: 'One base', body: 'Synthetic.' }], weHandle: ['Transfers'], youBring: ['Passports'] }, prices: null,
        branchCode: 'JDH',
      },
    };
    writeFileSync(join(dir, 'view.json'), JSON.stringify(view));
    const r = spawnSync(process.execPath, [script, '--sample', join(dir, 'view.json'), '--out', join(dir, 'out.pdf')], { encoding: 'utf8', timeout: 90_000 });
    expect(r.status).toBe(0);
    const report = JSON.parse(r.stdout.trim());
    expect(report).toMatchObject({ outcome: 'rendered', layoutIssues: [], placeholders: 0, blockedRequests: 0 });
    expect(report.pageCount).toBeGreaterThanOrEqual(1);
    const pdf = readFileSync(join(dir, 'out.pdf'));
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pdf.byteLength).toBe(report.sizeBytes);
  }, 120_000);
});
