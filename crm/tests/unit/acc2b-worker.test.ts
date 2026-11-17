import { describe, expect, it, vi } from 'vitest';
import type { CustomerDocumentContent } from '@/modules/customer-documents/content';
import { DealDocumentsSchema, DocumentRowSchema, screenPdfState } from '@/modules/customer-documents/dto';
import { documentStatusLines } from '@/modules/customer-documents/status';
import { mapDocumentError } from '@/modules/customer-documents/commands';
import { checkDocumentMarkup } from '@/modules/documents/render/checks';
import { CustomerRenderClaimSchema, CustomerRenderInputSchema } from '@/modules/documents/render/customer-job-input';
import type { PdfResult } from '@/modules/documents/render/pdf';
import { processOneCustomerJob, RenderStepError, type CustomerWorkerDeps } from '@/modules/documents/render/worker-core';

/**
 * Accounts phase 2, Track B: the customer document queue of the render
 * worker with fakes (contract 6.7 worker commands, 6.8), the read DTOs
 * (every key listed; Sales owners and Managers carry no Accounts-only
 * values) and the error mapping. Synthetic values only.
 */

const JOB = '44444444-4444-4444-8444-444444444444';
const DOC = '55555555-5555-4555-8555-555555555555';
const ENTITY = '66666666-6666-4666-8666-666666666666';
const PATH = `${ENTITY}/customer-documents/${DOC}/${JOB}.pdf`;
const SHA = 'a'.repeat(64);

const CONTENT: CustomerDocumentContent = {
  schema: 'cdoc-1', kind: 'advance_invoice', title: 'Advance Invoice', number: 'SYN-DEL-001-ADV-1', issueDate: '2026-11-12',
  company: { legalName: 'Holiday Chacha Pvt Ltd', registeredAddress: '59A, Synthetic Road', pan: 'AAAAA0000A', gstin: '08AAAAA0000A1Z5', gstinState: 'Rajasthan' },
  branch: { code: 'DEL', name: 'Delhi' },
  customer: { billingName: 'Synthetic Billing', addressLine1: '1 Synthetic Road', addressLine2: null, city: 'Delhi', stateCode: '07', postalCode: '110001', gstin: null },
  deal: { reference: 'SYN-DEL-001', dealNumber: null },
  trip: { destination: null, startDate: null, endDate: null, travellerCount: null },
  lines: [{ label: 'Advance received', amountPaise: '2500000' }], totalPaise: '2500000', paidPaise: '2500000',
  payment: { reference: 'R-2026-27-000123', receivedOn: '2026-11-10', mode: 'bank_transfer' }, credits: null, gstInvoiceNumber: null, replaces: null,
};

const PDF: PdfResult = { pdf: new Uint8Array([37, 80, 68, 70]), sha256: 'b'.repeat(64), sizeBytes: 4, pageCount: 1, layoutIssues: [], blockedRequests: 0, ms: 5 };

function deps(o: { content?: unknown; input?: unknown; html?: string; pdf?: Partial<PdfResult>; uploadError?: boolean; renderError?: Error; claim?: null } = {}) {
  const complete = vi.fn(async (_jobId: string, outcome: { ok: boolean }) => ({ jobId: JOB, status: outcome.ok ? 'succeeded' : 'failed', fileId: null }));
  const upload = vi.fn(async () => {
    if (o.uploadError) throw new Error('nope');
  });
  const d: CustomerWorkerDeps = {
    worker: 'local-test',
    claim: vi.fn(async () => (o.claim === null ? null : { jobId: JOB, documentId: DOC, contentSha256: SHA, templateVersion: 'cdoc-1', attempts: 1, legalEntityId: ENTITY, objectPath: PATH })),
    input: vi.fn(async () => (o.input ?? { status: 'running', jobId: JOB, documentId: DOC, templateVersion: 'cdoc-1', contentSha256: SHA, content: o.content ?? CONTENT, objectPath: PATH }) as never),
    renderHtml: vi.fn(async () => {
      if (o.renderError) throw o.renderError;
      const markup = o.html ?? '<article>Advance Invoice SYN-DEL-001-ADV-1</article>';
      return checkDocumentMarkup(markup);
    }),
    renderPdf: vi.fn(async () => ({ ...PDF, ...o.pdf })),
    upload,
    complete: complete as never,
  };
  return { d, complete, upload };
}

describe('processOneCustomerJob', () => {
  it('idle without a job; content_changed and conflict stop without complete', async () => {
    expect(await processOneCustomerJob(deps({ claim: null }).d)).toEqual({ outcome: 'idle' });
    const changed = deps({ input: { status: 'failed', jobId: JOB, errorCode: 'content_changed' } });
    expect(await processOneCustomerJob(changed.d)).toEqual({ outcome: 'content_changed', jobId: JOB });
    expect(changed.complete).not.toHaveBeenCalled();
    expect(await processOneCustomerJob(deps({ input: { status: 'conflict' } }).d)).toEqual({ outcome: 'conflict', jobId: JOB });
  });

  it('happy path: uploads at the claim path and completes with sha256, size and pages', async () => {
    const { d, complete, upload } = deps();
    const out = await processOneCustomerJob(d);
    expect(out).toMatchObject({ outcome: 'completed', queue: 'customer', status: 'succeeded' });
    expect(upload).toHaveBeenCalledWith(PATH, PDF.pdf);
    expect(complete).toHaveBeenCalledWith(JOB, { ok: true, file: { objectPath: PATH, sha256: PDF.sha256, sizeBytes: 4, pageCount: 1 } });
  });

  it('fails without a PDF: bad content, unsafe words, placeholders, layout, blocked requests, upload, missing stylesheet', async () => {
    const cases: Array<[Parameters<typeof deps>[0], string]> = [
      [{ content: { ...CONTENT, extra: 1 } }, 'input_invalid'],
      [{ content: { ...CONTENT, lines: [{ label: 'supplier cost', amountPaise: '1' }] } }, 'content_safety'],
      [{ html: '<article>Our best price</article>' }, 'content_safety'],
      [{ html: '<article><span class="fill">Billing details</span></article>' }, 'placeholders_present'],
      [{ pdf: { layoutIssues: ['layout_overflow'] } }, 'layout_overflow'],
      [{ pdf: { blockedRequests: 1 } }, 'asset_missing'],
      [{ uploadError: true }, 'upload_failed'],
      [{ renderError: new RenderStepError('asset_missing') }, 'asset_missing'],
    ];
    for (const [o, code] of cases) {
      const { d, complete, upload } = deps(o);
      await processOneCustomerJob(d);
      expect(complete, code).toHaveBeenCalledWith(JOB, { ok: false, errorCode: code });
      if (code !== 'upload_failed') expect(upload).not.toHaveBeenCalled();
    }
  });
});

describe('worker replies and DTOs', () => {
  it('claim and input replies are strict', () => {
    expect(CustomerRenderClaimSchema.safeParse({ jobId: JOB, documentId: DOC, contentSha256: SHA, templateVersion: 'cdoc-1', attempts: 1,
      legalEntityId: ENTITY, objectPath: PATH }).success).toBe(true);
    expect(CustomerRenderClaimSchema.safeParse({ jobId: JOB, documentId: DOC, contentSha256: SHA, templateVersion: 'cdoc-1', attempts: 1,
      legalEntityId: ENTITY, objectPath: `${ENTITY}/${DOC}/${JOB}.pdf` }).success).toBe(false);
    expect(CustomerRenderInputSchema.safeParse({ status: 'failed', jobId: JOB, errorCode: 'content_changed' }).success).toBe(true);
  });

  const row = {
    documentId: DOC, kind: 'invoice', title: 'Invoice', number: 'SYN-DEL-001-INV-1', status: 'replaced', totalPaise: '9123457', issueDate: '2026-11-12',
    createdAt: '2026-11-12T10:00:00+05:30', releasedAt: '2026-11-12T10:00:00+05:30', releasedByName: null, rowVersion: 3, contentSha256: SHA,
    stale: false, bookingChangedSinceRelease: false, paymentReversed: false, pdf: { state: 'queued', fileId: null }, tallyLinked: false,
    gstInvoiceNumber: null, replacesNumber: null, replacedByNumber: 'SYN-DEL-001-INV-2', endReason: null, warnings: [],
    can: { refresh: false, release: false, discard: false, cancel: false, replace: false, linkTally: false, retryPdf: false, download: false, printView: true },
  };

  it('document row: strict; a selling breakdown or cost key is refused', () => {
    expect(DocumentRowSchema.safeParse(row).success).toBe(true);
    expect(DocumentRowSchema.safeParse({ ...row, marginPaise: '1' }).success).toBe(false);
    // Accounts phase 3 (6.5; 16.6 setup update, lead OK 13 Nov): the Deal documents answer gains autoBills.
    expect(DealDocumentsSchema.safeParse({ dealId: DOC, viewer: 'sales', enabled: true, autoBills: { drafts: false, release: true },
      billing: { verified: true, missing: false }, candidates: null, documents: [row] }).success).toBe(true);
    expect(screenPdfState('queued', false)).toBe('off');
    expect(screenPdfState('queued', true)).toBe('queued');
    expect(screenPdfState('ready', false)).toBe('ready');
    expect(documentStatusLines({ ...row, status: 'replaced' } as never)).toEqual(['Replaced by SYN-DEL-001-INV-2']);
    expect(documentStatusLines({ ...row, status: 'cancelled', endReason: 'Synthetic wrong payment', paymentReversed: true } as never))
      .toEqual(['Cancelled — Synthetic wrong payment', 'Payment reversed']);
  });

  it('errors map by SQLSTATE and exact token', () => {
    expect(mapDocumentError({ code: '40001', message: 'document_stale' })).toBe('document_stale');
    expect(mapDocumentError({ code: '55000', message: 'documents_off' })).toBe('documents_off');
    expect(mapDocumentError({ code: '55000', message: 'document_stale' })).toBeNull();
    expect(mapDocumentError({ code: '42501', message: 'whatever' })).toBe('not_authorized');
  });
});
