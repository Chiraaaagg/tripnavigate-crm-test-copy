import { describe, expect, it, vi } from 'vitest';
import { PrefillSchema } from '@/modules/fulfilment/b11-commands';
import { mergeBookChecklist, toPrefillView } from '@/modules/fulfilment/b11-dto';
import { PREFILL_FIELD, parsePrefillForm } from '@/modules/fulfilment/b11-forms';
import { CHECKLIST_STEP } from '@/modules/fulfilment/contracts';
import { FIELD } from '@/modules/fulfilment/forms';

/**
 * B1.2 Bitrix prefill (0600) pure layers and the render worker wrapper's
 * reply handling: form parsing per target, the prefill schema's leniency on
 * unknown codes, the view (notes hidden, mobile format, availability), the
 * prefill_unchecked routing, quote_party_differs placement. Synthetic only.
 */

vi.mock('@/lib/supabase/admin', () => ({
  createSupabaseAdminClient: () => {
    throw new Error('not used');
  },
}));
const { itineraryRenderClaimForWorker, itineraryRenderCompleteForWorker, itineraryRenderInputForWorker, RENDER_JOB_ERROR_CODES } = await import('@/modules/itineraries/server/render-worker');
const { RENDER_ERROR_TEXT } = await import('@/modules/itineraries/contracts');

const VERSION = 'a2000000-0000-4000-8000-000000000001';
const DEAL = 'd1000000-0000-4000-8000-000000000001';
const JOB = 'c4000000-0000-4000-8000-000000000001';
const DOC = 'c1000000-0000-4000-8000-000000000001';
const HASH = 'a'.repeat(64);

function form(fields: Record<string, string | string[]>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const x of Array.isArray(v) ? v : [v]) f.append(k, x);
  return f;
}

const record = (over: Record<string, unknown> = {}) =>
  PrefillSchema.parse({
    available: true,
    sourceModifiedAt: '2026-10-01T10:00:00Z',
    lastVerifiedAt: '2026-10-02T10:00:00Z',
    issues: [],
    notesHidden: false,
    fields: {
      bookingNotes: 'Synthetic notes',
      travellerTotal: 3,
      tourStart: '2026-12-10',
      tourEnd: '2026-12-14',
      customerType: { code: 'corporate' },
      contact: { name: 'Synthetic Contact', mobile: '+91 98765 00033', email: null },
      company: { name: 'Synthetic Company', phone: null, email: null },
    },
    marks: [],
    ...over,
  });

describe('prefill form', () => {
  it('booking target needs the Deal and only booking codes; repeated codes collapse', () => {
    expect(parsePrefillForm(form({ [PREFILL_FIELD.target]: 'booking_version', [FIELD.versionId]: VERSION, [FIELD.rowVersion]: '3', [FIELD.dealId]: DEAL, [PREFILL_FIELD.field]: ['trip.start', 'trip.start', 'contacts.mobile'] }))).toEqual({
      ok: true,
      value: { targetKind: 'booking_version', versionId: VERSION, expectedRowVersion: 3, dealId: DEAL, fields: ['trip.start', 'contacts.mobile'] },
    });
    expect(parsePrefillForm(form({ [PREFILL_FIELD.target]: 'booking_version', [FIELD.versionId]: VERSION, [FIELD.rowVersion]: '3', [PREFILL_FIELD.field]: 'requirementsNote' }))).toEqual({
      ok: false,
      fields: [FIELD.dealId, PREFILL_FIELD.field],
    });
  });

  it('quotation target accepts the notes and company; refuses an unknown target, no fields, a value instead of a code', () => {
    expect(parsePrefillForm(form({ [PREFILL_FIELD.target]: 'quotation_version', [FIELD.versionId]: VERSION, [FIELD.rowVersion]: '1', [PREFILL_FIELD.field]: ['requirementsNote', 'contacts.companyName'] }))).toMatchObject({
      ok: true,
      value: { dealId: null, fields: ['requirementsNote', 'contacts.companyName'] },
    });
    expect(parsePrefillForm(form({ [PREFILL_FIELD.target]: 'deal', [FIELD.versionId]: VERSION, [FIELD.rowVersion]: '1' }))).toMatchObject({ ok: false, fields: expect.arrayContaining([PREFILL_FIELD.target, PREFILL_FIELD.field]) });
    expect(parsePrefillForm(form({ [PREFILL_FIELD.target]: 'quotation_version', [FIELD.versionId]: VERSION, [FIELD.rowVersion]: '1', [PREFILL_FIELD.field]: '9876500033' }))).toMatchObject({ ok: false, fields: [PREFILL_FIELD.field] });
  });
});

describe('prefill view', () => {
  it('booking fields with values; a mobile the database would skip is shown but not offered; Customer Type label only', () => {
    const v = toPrefillView(record({ fields: { ...record().fields, contact: { name: 'Synthetic Contact', mobile: '12345', email: null } } }), { target: 'booking', canEdit: true });
    expect(v.fields.map((f) => [f.field, f.canUse])).toEqual([
      ['trip.start', true],
      ['trip.end', true],
      ['contacts.contactName', true],
      ['contacts.mobile', false],
      ['contacts.email', false],
      ['contacts.bookingFor', true],
    ]);
    expect(v).toMatchObject({ customerType: 'corporate', customerTypeLabel: 'Corporate', bookingNotes: 'Synthetic notes', notesHidden: false });
    // DEC-45: any known Customer Type means a business booking.
    expect(v.fields.find((f) => f.field === 'contacts.bookingFor')).toMatchObject({ label: 'Booking for', bitrixValue: 'business' });
  });

  it('notes hidden: no notes value and the requirements note is not offered; read-only viewers get nothing to press', () => {
    const v = toPrefillView(record({ notesHidden: true, fields: { ...record().fields, bookingNotes: null } }), { target: 'quotation', canEdit: true });
    expect(v.notesHidden).toBe(true);
    expect(v.bookingNotes).toBeNull();
    expect(v.fields.find((f) => f.field === 'requirementsNote')).toMatchObject({ bitrixValue: null, canUse: false });
    const ro = toPrefillView(record({ marks: [{ fieldCode: 'trip.start', state: 'from_bitrix', appliedAt: '2026-10-03T10:00:00Z', checkedAt: null }] }), { target: 'booking', canEdit: false });
    expect(ro.fields.every((f) => !f.canUse && !f.canMarkChecked)).toBe(true);
    expect(ro.unchecked).toEqual(['trip.start']);
  });

  it('unknown field codes and Customer Type options never fail the read', () => {
    const r = record({
      fields: { ...record().fields, customerType: { code: 'vip_new_option' } },
      marks: [
        { fieldCode: 'trip.start', state: 'checked', appliedAt: '2026-10-03T10:00:00Z', checkedAt: '2026-10-03T11:00:00Z' },
        { fieldCode: 'future.field', state: 'from_bitrix', appliedAt: '2026-10-03T10:00:00Z', checkedAt: null },
      ],
    });
    expect(r.fields.customerType).toEqual({ code: null });
    // DEC-45: an unknown Customer Type fills nothing.
    expect(toPrefillView(r, { target: 'booking', canEdit: true }).fields.find((f) => f.field === 'contacts.bookingFor')).toMatchObject({ bitrixValue: null, canUse: false });
    expect(r.marks.map((m) => m.fieldCode)).toEqual(['trip.start']);
    expect(toPrefillView(r, { target: 'booking', canEdit: true }).fields[0]).toMatchObject({ state: 'checked', stateText: 'From Bitrix, checked', canMarkChecked: false });
  });

  it('unavailable: no values, nothing offered', () => {
    const v = toPrefillView(record({ available: false }), { target: 'booking', canEdit: true });
    expect(v.fields.every((f) => f.bitrixValue === null && !f.canUse)).toBe(true);
    expect(v.bookingNotes).toBeNull();
    expect(v.customerType).toBeNull();
  });
});

describe('checklist', () => {
  it('prefill_unchecked splits into customer (contact) and trip (dates) warnings naming the fields', () => {
    const rows = mergeBookChecklist({ items: [{ code: 'prefill_unchecked', blocking: false, owner: 'sales', itemNos: [], fields: ['contacts.mobile', 'trip.end'] }], canConfirm: true }, []);
    expect(rows).toEqual([
      expect.objectContaining({ step: 'travellers', section: 'customer', field: null, blocking: false, prefillFields: ['contacts.mobile'], text: expect.stringContaining('(Contact mobile)') }),
      expect.objectContaining({ step: 'stay', section: 'trip', field: 'tripEnd', blocking: false, prefillFields: ['trip.end'], text: expect.stringContaining('(Trip end date)') }),
    ]);
  });

  it('quote_party_differs is a step 1 passengers warning', () => {
    expect(CHECKLIST_STEP.quote_party_differs).toEqual({ step: 'travellers', section: 'passengers', field: 'travellerName' });
    const [row] = mergeBookChecklist({ items: [{ code: 'quote_party_differs', blocking: false, owner: 'sales', itemNos: [] }], canConfirm: true }, []);
    expect(row).toMatchObject({ section: 'passengers', blocking: false });
  });
});

describe('render worker input wrapper', () => {
  const client = (reply: { data?: unknown; error?: { code: string; message: string } }) => ({ rpc: vi.fn().mockResolvedValue({ data: reply.data ?? null, error: reply.error ?? null }) });

  it('input_changed (final job failed by the database) and task_conflict are answers, not errors', async () => {
    await expect(itineraryRenderInputForWorker({ jobId: JOB, worker: 'w1' }, client({ data: { jobId: JOB, status: 'failed', errorCode: 'input_changed' } }))).resolves.toEqual({
      status: 'failed',
      jobId: JOB,
      errorCode: 'input_changed',
    });
    await expect(itineraryRenderInputForWorker({ jobId: JOB, worker: 'w1' }, client({ error: { code: '40001', message: 'task_conflict' } }))).resolves.toEqual({ status: 'conflict' });
  });

  it('a running reply parses (basisChanged read as false when absent); bad input or a malformed reply throws without database text', async () => {
    const c = client({
      data: { jobId: JOB, status: 'running', documentId: DOC, kind: 'final', templateVersion: 'itinerary-2', inputHash: HASH, factsHash: HASH, factsChanged: false, facts: {}, title: 'Synthetic', basis: { kind: 'none', id: null, hash: HASH }, money: null },
    });
    await expect(itineraryRenderInputForWorker({ jobId: JOB, worker: 'w1' }, c)).resolves.toMatchObject({ status: 'running', basisChanged: false, money: null });
    expect(c.rpc).toHaveBeenCalledWith('itinerary_render_input', { p_job_id: JOB, p_worker: 'w1' });
    await expect(itineraryRenderInputForWorker({ jobId: 'nope', worker: 'w1' }, c)).rejects.toThrow('itinerary_render_input failed');
    await expect(itineraryRenderInputForWorker({ jobId: JOB, worker: 'x'.repeat(61) }, c)).rejects.toThrow('itinerary_render_input failed');
    await expect(itineraryRenderInputForWorker({ jobId: JOB, worker: 'w1' }, client({ data: { jobId: JOB, status: 'running' } }))).rejects.toThrow(/^itinerary_render_input failed$/);
    await expect(itineraryRenderInputForWorker({ jobId: JOB, worker: 'w1' }, client({ error: { code: '42501', message: 'permission denied for function itinerary_render_input' } }))).rejects.toThrow(/^itinerary_render_input failed \(42501\)$/);
  });
});

describe('render worker claim and complete wrappers', () => {
  const client = (reply: { data?: unknown; error?: { code: string; message: string; hint?: string } }) => ({ rpc: vi.fn().mockResolvedValue({ data: reply.data ?? null, error: reply.error ?? null }) });
  const ENTITY = 'e0000000-0000-4000-8000-000000000001';
  const FILE = { objectPath: `${ENTITY}/${DOC}/${JOB}.pdf`, sha256: 'b'.repeat(64), sizeBytes: 1000, pageCount: 2, qa: { placeholders: 0, layoutIssues: [], safetyHits: [] } };

  it('claim: null when nothing waits; builds the upload path when the reply names the legal entity', async () => {
    await expect(itineraryRenderClaimForWorker({ worker: 'w1', leaseSeconds: 60 }, client({ data: null }))).resolves.toBeNull();
    const c = client({ data: { jobId: JOB, documentId: DOC, kind: 'final', inputHash: HASH, templateVersion: 'itinerary-2', factsHash: HASH, attempts: 1, legalEntityId: ENTITY } });
    await expect(itineraryRenderClaimForWorker({ worker: ' w1 ', leaseSeconds: 60 }, c)).resolves.toMatchObject({ jobId: JOB, objectPath: FILE.objectPath });
    expect(c.rpc).toHaveBeenCalledWith('itinerary_render_claim', { p_worker: 'w1', p_lease_seconds: 60 });
  });

  it('complete: sends the report as the database takes it; qa_blocked and input_changed are answers; bad files refused before any call', async () => {
    const ok = client({ data: { jobId: JOB, status: 'failed', renderedId: null, errorCode: 'qa_blocked' } });
    await expect(itineraryRenderCompleteForWorker({ jobId: JOB, worker: 'w1', outcome: { ok: true, file: FILE } }, ok)).resolves.toEqual({ status: 'failed', jobId: JOB, errorCode: 'qa_blocked' });
    expect(ok.rpc).toHaveBeenCalledWith('itinerary_render_complete', { p_job_id: JOB, p_worker: 'w1', p_ok: true, p_error_code: null, p_file: FILE });
    await expect(itineraryRenderCompleteForWorker({ jobId: JOB, worker: 'w1', outcome: { ok: true, file: FILE } }, client({ data: { jobId: JOB, status: 'failed', renderedId: null, errorCode: 'input_changed' } }))).resolves.toMatchObject({ errorCode: 'input_changed' });
    const never = client({ data: null });
    await expect(itineraryRenderCompleteForWorker({ jobId: JOB, worker: 'w1', outcome: { ok: true, file: { ...FILE, objectPath: 'elsewhere/file.pdf' } } }, never)).rejects.toThrow('failed: file');
    await expect(itineraryRenderCompleteForWorker({ jobId: JOB, worker: 'w1', outcome: { ok: true, file: { ...FILE, qa: { ...FILE.qa, safetyHits: ['Contains a phrase'] } } } }, never)).rejects.toThrow('failed: file');
    expect(never.rpc).not.toHaveBeenCalled();
    await expect(itineraryRenderCompleteForWorker({ jobId: JOB, worker: 'w1', outcome: { ok: false, errorCode: 'internal' } }, client({ error: { code: '22023', message: 'invalid_input', hint: 'errorCode' } }))).rejects.toThrow(/^itinerary_render_complete failed \(22023\): errorCode$/);
  });
});

describe('render failure wording', () => {
  it('every code a job can end with has plain words (incl. text_clipped, input_changed, lease_expired)', () => {
    for (const code of RENDER_JOB_ERROR_CODES) expect(RENDER_ERROR_TEXT[code], code).toEqual(expect.any(String));
  });
});
