import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PrefillSchema } from '@/modules/fulfilment/b11-commands';
import { toPrefillView } from '@/modules/fulfilment/b11-dto';
import { PREFILL_FIELD, parsePrefillDismissForm, parsePrefillTargetForm } from '@/modules/fulfilment/b11-forms';
import { BOOKING_ERROR_STATES, mapBookingError } from '@/modules/fulfilment/commands';
import { ERROR_TEXT, PREFILL_SKIP_TEXT } from '@/modules/fulfilment/contracts';
import { prefillUiMode, toPrefillUi } from '@/modules/fulfilment/prefill-ui';

/**
 * Batch 2 automatic fill, application layer (T-1): "Start booking" through
 * booking_start_draft with the older-database fallback, "Fill empty fields"
 * and "Keep mine" actions (session first, own session, no values from the
 * browser), the prefill read with the Batch 2 keys, kept handling, the D1
 * panel/inline choice and the inline view model. Synthetic values only.
 */

const requireStaff = vi.fn();
const rpc = vi.fn();
const revalidatePath = vi.fn();
vi.mock('@/modules/identity/server/session', () => ({ requireStaff: () => requireStaff() }));
vi.mock('next/cache', () => ({ revalidatePath: (p: string) => revalidatePath(p) }));
vi.mock('@/lib/supabase/admin', () => ({ createSupabaseAdminClient: () => ({}) }));

const book = await import('@/modules/fulfilment/server/book-now-actions');
const prefill = await import('@/modules/fulfilment/server/book-now-prefill-actions');
const quoteCommands = await import('@/modules/quotations/commands');

const USER = 'a0000000-0000-4000-8000-000000000001';
const DEAL = 'd0000000-0000-4000-8000-000000000001';
const VERSION = '11111111-1111-4111-8111-111111111111';
const QVERSION = '33333333-3333-4333-8333-333333333333';

function form(fields: Record<string, string | string[]>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const x of Array.isArray(v) ? v : [v]) fd.append(k, x);
  return fd;
}

type RpcReply = { data?: unknown; error?: { code: string; message: string; hint?: string } | null };
function rpcReplies(map: Record<string, RpcReply>) {
  rpc.mockImplementation(async (fn: string) => {
    const reply = map[fn];
    if (!reply) throw new Error(`unexpected rpc ${fn}`);
    return { data: reply.data ?? null, error: reply.error ?? null };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  requireStaff.mockResolvedValue({ userId: USER, supabase: { rpc }, access: { userId: USER, memberships: [], rolePermissions: [], grants: [] } });
});

const bookingTarget = { prefillTarget: 'booking_version', versionId: VERSION, dealId: DEAL, rowVersion: '5' };
const quoteTarget = { prefillTarget: 'quotation_version', versionId: QVERSION, rowVersion: '3' };

describe('Start booking (booking_start_draft)', () => {
  it('calls booking_start_draft under the own session; the reply carries the fill outcome; no fill message', async () => {
    rpcReplies({ booking_start_draft: { data: { versionId: VERSION, versionNo: 1, rowVersion: 2, created: true, autoFill: 'filled', filled: ['trip.start', 'contacts.mobile'], skipped: [{ field: 'contacts.email', reason: 'no_value' }] } } });
    const r = await book.startBookNowAction(null, form({ dealId: DEAL }));
    expect(rpc).toHaveBeenCalledWith('booking_start_draft', { p_deal_id: DEAL });
    expect(r).toMatchObject({ ok: true, data: { rowVersion: 2, autoFill: 'filled', filled: ['trip.start', 'contacts.mobile'] } });
    expect(r.ok && r.message).toBe('Booking started.');
  });

  it('older database (function missing): falls back to booking_open_draft, autoFill off', async () => {
    rpcReplies({
      booking_start_draft: { error: { code: 'PGRST202', message: 'Could not find the function' } },
      booking_open_draft: { data: { versionId: VERSION, versionNo: 1, rowVersion: 0, created: false } },
    });
    const r = await book.startBookNowAction(null, form({ dealId: DEAL }));
    expect(rpc).toHaveBeenCalledWith('booking_open_draft', { p_deal_id: DEAL });
    expect(r).toMatchObject({ ok: true, data: { autoFill: 'off', filled: [], created: false }, message: 'Draft booking opened.' });
  });

  it('refusals keep today’s wording; an unknown outcome is never "nothing changed"', async () => {
    rpcReplies({ booking_start_draft: { error: { code: '55000', message: 'deal_not_active' } } });
    await expect(book.startBookNowAction(null, form({ dealId: DEAL }))).resolves.toMatchObject({ ok: false, code: 'deal_not_active', message: ERROR_TEXT.deal_not_active });
    rpcReplies({ booking_start_draft: { error: { code: 'XX000', message: 'boom' } } });
    await expect(book.startBookNowAction(null, form({ dealId: DEAL }))).rejects.toThrow();
  });
});

describe('Fill empty fields from Bitrix (prefill_fill_empty)', () => {
  it('session first: nothing runs without a staff session', async () => {
    requireStaff.mockRejectedValue(new Error('NEXT_REDIRECT /mfa/challenge'));
    await expect(prefill.fillEmptyPrefillAction(null, form(bookingTarget))).rejects.toThrow('NEXT_REDIRECT');
    await expect(prefill.dismissPrefillNoticeAction(null, form(bookingTarget))).rejects.toThrow('NEXT_REDIRECT');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('posts target, version and row version only; names filled and skipped fields (cleared by staff kept empty)', async () => {
    rpcReplies({ prefill_fill_empty: { data: { rowVersion: 6, filled: ['trip.start'], skipped: [{ field: 'contacts.email', reason: 'cleared_by_staff' }] } } });
    const r = await prefill.fillEmptyPrefillAction(null, form({ ...bookingTarget, contactName: 'not used' }));
    expect(rpc).toHaveBeenCalledWith('prefill_fill_empty', { p_target_kind: 'booking_version', p_target_id: VERSION, p_expected_row_version: 5 });
    expect(r).toMatchObject({ ok: true, data: { rowVersion: 6 } });
    expect(r.ok && r.message).toContain('Filled from Bitrix: Trip start date. Check them with the customer.');
    expect(r.ok && r.message).toContain(PREFILL_SKIP_TEXT.cleared_by_staff);
    expect(revalidatePath).toHaveBeenCalledWith(`/app/deals/${DEAL}/book`);
  });

  it('stale row version and quotation refusals in their own words; a malformed post makes no call', async () => {
    rpcReplies({ prefill_fill_empty: { error: { code: '40001', message: 'version_changed' } } });
    await expect(prefill.fillEmptyPrefillAction(null, form(bookingTarget))).resolves.toMatchObject({ ok: false, code: 'version_changed' });
    rpcReplies({ prefill_fill_empty: { error: { code: '55000', message: 'wrong_state', hint: 'copy' } } });
    await expect(prefill.fillEmptyPrefillAction(null, form(quoteTarget))).resolves.toMatchObject({ ok: false, code: 'wrong_state' });
    rpc.mockClear();
    await expect(prefill.fillEmptyPrefillAction(null, form({ prefillTarget: 'booking_version', versionId: VERSION, rowVersion: '5' }))).resolves.toMatchObject({ ok: false, code: 'invalid_input', fields: ['dealId'] });
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('Keep mine (prefill_notice_dismiss)', () => {
  const at = '2026-10-18T09:30:00Z';
  it('one field of the target and the snapshot time; no value; no row-version bump in the reply', async () => {
    rpcReplies({ prefill_notice_dismiss: { data: { field: 'trip.start', sourceModifiedAt: at, dismissed: true } } });
    const r = await prefill.dismissPrefillNoticeAction(null, form({ ...bookingTarget, [PREFILL_FIELD.field]: 'trip.start', [PREFILL_FIELD.sourceModifiedAt]: at }));
    expect(rpc).toHaveBeenCalledWith('prefill_notice_dismiss', { p_target_kind: 'booking_version', p_target_id: VERSION, p_expected_row_version: 5, p_field: 'trip.start', p_source_modified_at: at });
    expect(r).toMatchObject({ ok: true, data: { field: 'trip.start', dismissed: true } });
  });

  it('parsers refuse two fields, a field of the other target, or a bad time', () => {
    expect(parsePrefillDismissForm(form({ ...bookingTarget, [PREFILL_FIELD.field]: ['trip.start', 'trip.end'], [PREFILL_FIELD.sourceModifiedAt]: at }))).toMatchObject({ ok: false, fields: [PREFILL_FIELD.field] });
    expect(parsePrefillDismissForm(form({ ...bookingTarget, [PREFILL_FIELD.field]: 'requirementsNote', [PREFILL_FIELD.sourceModifiedAt]: at }))).toMatchObject({ ok: false });
    expect(parsePrefillDismissForm(form({ ...quoteTarget, [PREFILL_FIELD.field]: 'requirementsNote', [PREFILL_FIELD.sourceModifiedAt]: at }))).toMatchObject({ ok: true });
    expect(parsePrefillDismissForm(form({ ...bookingTarget, [PREFILL_FIELD.field]: 'trip.start', [PREFILL_FIELD.sourceModifiedAt]: 'yesterday' }))).toMatchObject({ ok: false, fields: [PREFILL_FIELD.sourceModifiedAt] });
    expect(parsePrefillTargetForm(form(quoteTarget))).toEqual({ ok: true, value: { targetKind: 'quotation_version', versionId: QVERSION, expectedRowVersion: 3, dealId: null } });
  });

  it('Fill empty fields posts no field codes: none are required, and any posted are ignored (the database picks the fields)', () => {
    expect(parsePrefillTargetForm(form(bookingTarget))).toEqual({ ok: true, value: { targetKind: 'booking_version', versionId: VERSION, expectedRowVersion: 5, dealId: DEAL } });
    expect(parsePrefillTargetForm(form({ ...bookingTarget, [PREFILL_FIELD.field]: ['contacts.fax', 'trip.start'] }))).toEqual({ ok: true, value: { targetKind: 'booking_version', versionId: VERSION, expectedRowVersion: 5, dealId: DEAL } });
    expect(parsePrefillTargetForm(form({ ...bookingTarget, rowVersion: 'x' }))).toMatchObject({ ok: false, fields: ['rowVersion'] });
  });
});

describe('workflow switch refusal', () => {
  it('settings_busy maps only with 55P03 and has words', () => {
    expect(BOOKING_ERROR_STATES.settings_busy).toBe('55P03');
    expect(mapBookingError({ code: '55P03', message: 'settings_busy' })).toBe('settings_busy');
    expect(mapBookingError({ code: '55000', message: 'settings_busy' })).toBeNull();
    expect(ERROR_TEXT.settings_busy).toMatch(/Nothing was changed/);
  });
});

// ---------------------------------------------------------------------------
// Reads and view model
// ---------------------------------------------------------------------------

const block = (over: Record<string, unknown> = {}) =>
  PrefillSchema.parse({
    available: true,
    sourceModifiedAt: '2026-10-18T09:30:00Z',
    lastVerifiedAt: '2026-10-19T09:30:00Z',
    issues: [],
    notesHidden: false,
    fields: { bookingNotes: null, travellerTotal: 2, tourStart: '2026-12-10', tourEnd: '2026-12-14', customerType: null, contact: { name: 'Synthetic Contact', mobile: '9876500033', email: null }, company: null },
    marks: [
      { fieldCode: 'trip.start', state: 'kept', appliedAt: '2026-10-19T09:30:00Z', checkedAt: null },
      { fieldCode: 'contacts.mobile', state: 'from_bitrix', appliedAt: '2026-10-19T09:30:00Z', checkedAt: null },
      { fieldCode: 'contacts.contactName', state: 'changed', appliedAt: '2026-10-19T09:30:00Z', checkedAt: null },
    ],
    ...over,
  });

const autoOn = { enabled: true, run: { mode: 'create', ranAt: '2026-10-19T09:30:00Z', filled: ['trip.start', 'contacts.mobile'], skipped: [{ field: 'contacts.email', reason: 'no_value' }] }, canFillEmpty: false };
const fieldStates = [
  { field: 'trip.start', state: 'kept', filledBy: 'auto_fill', staffTouched: false, clearedByStaff: false, notice: { bitrixValue: '2026-12-11', sourceModifiedAt: '2026-10-20T08:00:00Z', inline: true } },
  { field: 'contacts.mobile', state: 'from_bitrix', filledBy: 'auto_fill', staffTouched: false, clearedByStaff: false, notice: null },
  { field: 'contacts.email', state: null, filledBy: null, staffTouched: true, clearedByStaff: true, notice: { bitrixValue: 'x@example.com', sourceModifiedAt: '2026-10-20T08:00:00Z', inline: false } },
  { field: 'contacts.fax', state: 'from_bitrix', filledBy: 'auto_fill', staffTouched: false, clearedByStaff: false, notice: null },
];

describe('prefill read with the Batch 2 keys', () => {
  it('kept counts as unchecked and checkable; changed does not', () => {
    const v = toPrefillView(block(), { target: 'booking', canEdit: true });
    expect(v.unchecked.sort()).toEqual(['contacts.mobile', 'trip.start']);
    expect(v.fields.find((f) => f.field === 'trip.start')?.canMarkChecked).toBe(true);
    expect(v.fields.find((f) => f.field === 'contacts.contactName')?.canMarkChecked).toBe(false);
  });

  it('autoFill and fieldStates pass through; unknown field codes dropped; absent on an older database', () => {
    const v = toPrefillView(block({ autoFill: autoOn, fieldStates }), { target: 'booking', canEdit: true });
    expect(v.autoFill?.enabled).toBe(true);
    expect(v.fieldStates?.map((f) => f.field)).toEqual(['trip.start', 'contacts.mobile', 'contacts.email']);
    const old = toPrefillView(block(), { target: 'booking', canEdit: true });
    expect(old.autoFill).toBeUndefined();
    expect(old.fieldStates).toBeUndefined();
  });

  it('quotation_create reply keeps the fill keys when present and parses without them', async () => {
    const reply = { quotationId: QVERSION, reference: 'TQ-1', versionId: QVERSION, versionNo: 1, rowVersion: 2, created: true };
    const client = { rpc: vi.fn(async (): Promise<{ data: Record<string, unknown>; error: null }> => ({ data: { ...reply, autoFill: 'filled', filled: ['contacts.mobile'], skipped: [] }, error: null })) };
    await expect(quoteCommands.quotationCreate(client as never, { subjectKind: 'lead', subjectId: DEAL, title: 'Synthetic', requestId: USER })).resolves.toMatchObject({ autoFill: 'filled', filled: ['contacts.mobile'] });
    client.rpc.mockResolvedValue({ data: reply, error: null });
    const old = await quoteCommands.quotationCreate(client as never, { subjectKind: 'lead', subjectId: DEAL, title: 'Synthetic', requestId: USER });
    expect(old.autoFill).toBeUndefined();
  });
});

describe('D1: panel when off or unknown, inline when on', () => {
  it('mode follows the switch as read', () => {
    expect(prefillUiMode(undefined)).toBe('panel');
    expect(prefillUiMode({ enabled: false, run: null, canFillEmpty: true })).toBe('panel');
    expect(prefillUiMode({ enabled: true, run: null, canFillEmpty: false })).toBe('inline');
    const view = toPrefillView(block({ autoFill: { ...autoOn, enabled: false } }), { target: 'booking', canEdit: true });
    expect(toPrefillUi(view, { target: 'booking', editable: true })).toEqual({ mode: 'panel', view });
  });

  it('inline: markers per section (booking form ids), section check posts from_bitrix + kept, no notices on the booking form, not-filled reasons', () => {
    const ui = toPrefillUi(toPrefillView(block({ autoFill: autoOn, fieldStates }), { target: 'booking', canEdit: true }), { target: 'booking', editable: true });
    if (ui.mode !== 'inline') throw new Error('expected inline');
    const [customer, trip] = ui.sections;
    expect(customer?.section).toBe('customer');
    expect(customer?.fields.find((f) => f.field === 'contacts.mobile')).toMatchObject({ fieldId: 'bf-contact-mobile', marker: 'from_bitrix', markerText: 'From Bitrix' });
    expect(customer?.checkable).toEqual(['contacts.mobile']);
    expect(customer?.notices).toEqual([]);
    expect(customer?.details.notFilled).toEqual([{ field: 'contacts.email', label: 'Contact email', reasonText: PREFILL_SKIP_TEXT.no_value }]);
    expect(trip?.fields.find((f) => f.field === 'trip.start')?.markerText).toBe('From Bitrix, saved, not checked');
    // Booking form (lead ruling 22 Oct 2026): passive markers only, no "Use it / Keep mine" notice.
    expect(trip?.fields.find((f) => f.field === 'trip.start')?.fieldId).toBe('bf-trip-start');
    expect(trip?.notices).toEqual([]);
    expect(ui.fillEmpty).toEqual({ offered: false, disabledReason: null });
  });

  it('inline for a read-only viewer: nothing to press; Fill empty fields only for a draft without a creation fill', () => {
    const ro = toPrefillUi(toPrefillView(block({ autoFill: autoOn, fieldStates }), { target: 'booking', canEdit: false }), { target: 'booking', editable: false });
    if (ro.mode !== 'inline') throw new Error('expected inline');
    expect(ro.sections.every((s) => !s.canCheck && s.notices.every((n) => !n.canUse && !n.canKeep))).toBe(true);
    const older = toPrefillUi(toPrefillView(block({ autoFill: { enabled: true, run: null, canFillEmpty: true } }), { target: 'quotation', canEdit: true }), { target: 'quotation', editable: true });
    if (older.mode !== 'inline') throw new Error('expected inline');
    expect(older.fillEmpty.offered).toBe(true);
    expect(older.sections.map((s) => s.section)).toEqual(['details', 'contact']);
  });

  it('billing, GSTIN, consent and the contact tick are never prefill fields', () => {
    const ui = toPrefillUi(toPrefillView(block({ autoFill: autoOn, fieldStates }), { target: 'booking', canEdit: true }), { target: 'booking', editable: true });
    if (ui.mode !== 'inline') throw new Error('expected inline');
    const ids = ui.sections.flatMap((s) => s.fields.map((f) => f.fieldId));
    for (const forbidden of ['bf-bill-name', 'bf-bill-gstin', 'bf-contact-confirmed', 'customer-billing-name', 'customer-gstin', 'customer-contact-confirmed']) expect(ids).not.toContain(forbidden);
  });
});
