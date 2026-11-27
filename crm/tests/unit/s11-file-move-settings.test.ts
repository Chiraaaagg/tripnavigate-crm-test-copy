import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkDealNumber,
  checkItemKey,
  checkMinutes,
  errorCodeOf,
  FILE_MOVE_FIELD,
  FileMoveAlertsSchema,
  fileMoveAlertsModel,
  fileMoveSectionModel,
  FileMoveSettingsSchema,
  parseAcceptLost,
  parseBoxChange,
  parseHoldChange,
  parsePilotChange,
  parseRelocate,
  parseSwitchChange,
  refusalText,
  type FileMoveAlerts,
  type FileMoveSettings,
} from '@/modules/settings/file-move-rows';
import { FILE_MOVE_TEXT, SETTINGS_TEXT } from '@/modules/settings/text';
import { FILE_UNAVAILABLE_TEXT, fileUnavailableHtml } from '@/views/files/file-unavailable-page';

/*
 * S11 "files to Bitrix" (file 14 sections 2.5 to 2.7): Settings › Bitrix
 * connection › "Files kept in Bitrix". The pure rows and alert models, the
 * form checks (the review's confirm=yes is required on the server), the
 * refusal words (pilot_required, open_stops), the actions against a mocked
 * database, and the two "file not available" pages. Synthetic data only.
 */

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), revalidatePath: vi.fn(), ended: false }));
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: (p: string) => mocks.revalidatePath(p) }));
vi.mock('@/modules/identity/server/session', () => {
  const SESSION_ENDED = Symbol('session_ended');
  return {
    SESSION_ENDED,
    staffForAction: async () =>
      mocks.ended ? SESSION_ENDED : { supabase: { rpc: (...a: unknown[]) => mocks.rpc(...a) }, access: { memberships: [{ roleCode: 'super_admin' }] } },
  };
});

const MOVE = 'a0001101-0000-4000-8000-000000001101';
const STOP = 'a0001102-0000-4000-8000-000000001102';
const REASON = 'Owner APPROVE 27 Nov, step 3 part 1';

const settings = (over: Partial<FileMoveSettings> = {}): FileMoveSettings => ({
  checkIdProofCopies: false,
  moveAccountsFiles: false,
  deleteAfterHold: false,
  deleteHoldMinutes: 15,
  accountsHoldDays: 90,
  accountsBox: null,
  pilotBitrixDealId: null,
  deleteEverOn: false,
  enqueueEnabled: true,
  openStops: 0,
  updatedAt: null,
  ...over,
});

const alerts = (over: Partial<FileMoveAlerts> = {}): FileMoveAlerts => ({
  stops: [],
  items: [],
  counts: { noTarget: 0, missedEnqueue: 0, waitingAccounts: 0, soleCopies: 0 },
  ...over,
});

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

describe('reply shapes', () => {
  it('accepts the frozen settings shape and a deal number given as a JSON number', () => {
    expect(FileMoveSettingsSchema.safeParse(settings({ pilotBitrixDealId: '4501' })).success).toBe(true);
    const asNumber = FileMoveSettingsSchema.parse({ ...settings(), pilotBitrixDealId: 4501 });
    expect(asNumber.pilotBitrixDealId).toBe('4501');
  });

  it('refuses a hold under 15 minutes, an Accounts wait under 90 days and a box that is not an item key', () => {
    expect(FileMoveSettingsSchema.safeParse(settings({ deleteHoldMinutes: 14 })).success).toBe(false);
    expect(FileMoveSettingsSchema.safeParse(settings({ accountsHoldDays: 89 })).success).toBe(false);
    expect(FileMoveSettingsSchema.safeParse({ ...settings(), accountsBox: 'UF_CRM_1' }).success).toBe(false);
  });

  it('accepts the alert shape with an acknowledged stop and an item', () => {
    const ok = FileMoveAlertsSchema.safeParse(
      alerts({
        stops: [{ stopId: STOP, moveId: MOVE, bitrixDealId: '4501', reasonCode: 'copy_mismatch', openedAt: '2026-11-27T05:00:00Z', acknowledgedAt: null }],
        items: [{ moveId: MOVE, kind: 'lost_in_bitrix', fileClass: 'accounts', sourceTable: 'finance_evidence', state: 'lost_in_bitrix', lastErrorCode: null, bitrixDealId: '4501', updatedAt: '2026-11-27T05:10:00Z' }],
      }),
    );
    expect(ok.success).toBe(true);
  });
});

describe('section model', () => {
  it('shows nothing when the database answered null (not the Super Admin)', () => {
    expect(fileMoveSectionModel({ kind: 'hidden' })).toBeNull();
    expect(fileMoveAlertsModel({ kind: 'hidden' })).toBeNull();
  });

  it('says "not installed" or "could not be read", with no change controls', () => {
    expect(fileMoveSectionModel({ kind: 'not_installed' })).toEqual({ kind: 'not_installed', text: FILE_MOVE_TEXT.notInstalled });
    expect(fileMoveSectionModel({ kind: 'error' })).toEqual({ kind: 'error', text: FILE_MOVE_TEXT.readFailed });
    expect(fileMoveAlertsModel({ kind: 'not_installed' })).toBeNull();
  });

  it('builds the three switches in order with their plain names and states', () => {
    const m = fileMoveSectionModel({ kind: 'ready', settings: settings({ checkIdProofCopies: true }), alerts: alerts() });
    if (m?.kind !== 'ready') throw new Error('expected ready');
    expect(m.switches.map((r) => [r.key, r.title, r.state])).toEqual([
      ['check_id_proof_copies', 'Check ID proof copies in Bitrix', 'on'],
      ['move_accounts_files', 'Move Accounts files after 90 days', 'off'],
      ['delete_after_hold', 'Delete the CRM’s copy after the hold', 'off'],
    ]);
    expect(m.switches[0]!.confirmLabel).toBe('Turn Check ID proof copies in Bitrix off');
    expect(m.switches[0]!.tone).toBe('danger');
    expect(m.hold.valueText).toBe('15 minutes');
    expect(m.box).toMatchObject({ valueText: 'Not set', empty: true });
    expect(m.pilot).toMatchObject({ valueText: 'None set', empty: true, clear: null });
    expect(m.updatedLine).toBe(FILE_MOVE_TEXT.updatedNever);
  });

  it('blocks deleting the first time without a pilot, and while a stop is open', () => {
    const first = fileMoveSectionModel({ kind: 'ready', settings: settings(), alerts: alerts() });
    if (first?.kind !== 'ready') throw new Error('expected ready');
    expect(first.switches[2]!.blockedText).toBe(FILE_MOVE_TEXT.deleteNeedsPilot);

    const pilot = fileMoveSectionModel({ kind: 'ready', settings: settings({ pilotBitrixDealId: '4501' }), alerts: alerts() });
    if (pilot?.kind !== 'ready') throw new Error('expected ready');
    expect(pilot.switches[2]!.blockedText).toBeNull();
    expect(pilot.switches[2]!.effect).toContain('Bitrix deal 4501 only');
    expect(pilot.switches[2]!.tone).toBe('danger');

    const stops = fileMoveSectionModel({ kind: 'ready', settings: settings({ pilotBitrixDealId: '4501', openStops: 2 }), alerts: alerts() });
    if (stops?.kind !== 'ready') throw new Error('expected ready');
    expect(stops.switches[2]!.blockedText).toBe(FILE_MOVE_TEXT.deleteNeedsAck);
    expect(stops.notices[0]).toBe('2 automatic stops are still open. Deleting cannot be switched on until each one is acknowledged on the Clean-up tab.');
  });

  it('says plainly that clearing the pilot is the company-wide start', () => {
    const m = fileMoveSectionModel({ kind: 'ready', settings: settings({ pilotBitrixDealId: '4501', deleteAfterHold: true, deleteEverOn: true }), alerts: alerts() });
    if (m?.kind !== 'ready') throw new Error('expected ready');
    expect(m.pilot.valueText).toBe('Bitrix deal 4501');
    expect(m.pilot.clear?.effect).toMatch(/^Clearing the pilot is the company-wide start\./);
    expect(m.pilot.clear?.effect).toContain('not only Bitrix deal 4501');
    expect(m.switches[2]!.effect).toBe(FILE_MOVE_TEXT.deleteOff);
  });

  it('Accounts switch on without a box says nothing moves until the box is set', () => {
    const m = fileMoveSectionModel({ kind: 'ready', settings: settings(), alerts: alerts() });
    if (m?.kind !== 'ready') throw new Error('expected ready');
    expect(m.switches[1]!.effect).toContain('The Accounts box is not set yet');
    const withBox = fileMoveSectionModel({ kind: 'ready', settings: settings({ accountsBox: 'ufCrm_1790000000' }), alerts: alerts() });
    if (withBox?.kind !== 'ready') throw new Error('expected ready');
    expect(withBox.switches[1]!.effect).toContain('(ufCrm_1790000000)');
    expect(withBox.box).toMatchObject({ valueText: 'ufCrm_1790000000', empty: false, inputValue: 'ufCrm_1790000000' });
  });

  it('says when the listing of new uploads is stopped', () => {
    const m = fileMoveSectionModel({ kind: 'ready', settings: settings({ enqueueEnabled: false }), alerts: alerts() });
    expect(m?.kind === 'ready' && m.notices).toEqual([FILE_MOVE_TEXT.listingOff]);
  });
});

describe('alerts model', () => {
  const ready = (a: FileMoveAlerts | 'error') => fileMoveAlertsModel({ kind: 'ready', settings: settings(), alerts: a });

  it('a failed read is never "nothing open"', () => {
    expect(ready('error')).toEqual({ kind: 'error', text: FILE_MOVE_TEXT.alertsReadFailed });
  });

  it('lists open stops first, maps codes to sentences and offers the right buttons', () => {
    const m = ready(
      alerts({
        stops: [
          { stopId: 'a0001103-0000-4000-8000-000000001103', moveId: null, bitrixDealId: '4502', reasonCode: 'deal_not_found', openedAt: '2026-11-26T05:00:00Z', acknowledgedAt: '2026-11-26T06:00:00Z' },
          { stopId: STOP, moveId: MOVE, bitrixDealId: '4501', reasonCode: 'copy_mismatch', openedAt: '2026-11-27T05:00:00Z', acknowledgedAt: null },
        ],
        items: [
          { moveId: MOVE, kind: 'lost_in_bitrix', fileClass: 'accounts', sourceTable: 'finance_evidence', state: 'lost_in_bitrix', lastErrorCode: 'not_in_box', bitrixDealId: '4501', updatedAt: '2026-11-27T05:10:00Z' },
          { moveId: 'a0001104-0000-4000-8000-000000001104', kind: 'deletion_waiting', fileClass: 'id_proof', sourceTable: 'traveller_id_proofs', state: 'verified', lastErrorCode: null, bitrixDealId: '4503', updatedAt: '2026-11-27T05:20:00Z' },
          { moveId: 'a0001105-0000-4000-8000-000000001105', kind: 'something_new', fileClass: 'id_proof', sourceTable: 'traveller_id_proofs', state: 'waiting', lastErrorCode: null, bitrixDealId: null, updatedAt: '2026-11-27T05:30:00Z' },
        ],
        counts: { noTarget: 3, missedEnqueue: 1, waitingAccounts: 0, soleCopies: 2 },
      }),
    );
    if (m?.kind !== 'ready') throw new Error('expected ready');
    expect(m.stops.map((s) => [s.stopId, s.open])).toEqual([
      [STOP, true],
      ['a0001103-0000-4000-8000-000000001103', false],
    ]);
    expect(m.stops[0]!.reasonText).toContain('did not match');
    expect(m.stops[1]!.timeText).toContain('acknowledged on');
    expect(m.summary).toEqual({ open: 1, items: 3, text: '1 open stop · 3 files to check' });

    const [lost, waiting, unknown] = m.items;
    expect(lost).toMatchObject({ label: 'Lost in Bitrix', canRetry: true, canRelocate: true, canAcceptLost: true, dealText: 'Bitrix deal 4501', errorText: 'Last problem: not in box.' });
    expect(lost!.whatText).toBe('Customer payment paper · Accounts paper · Lost in Bitrix');
    expect(waiting).toMatchObject({ canRetry: false, canRelocate: false, canAcceptLost: false });
    expect(unknown).toMatchObject({ label: 'Needs a look', dealText: 'No Bitrix deal', nameTail: 'for the file with no Bitrix deal' });
    expect(unknown!.text).toContain('(code: something new)');
    expect(m.countLines).toEqual([
      'Files kept only in Bitrix now (the CRM’s copy was deleted after the checks): 2.',
      'Files with no Bitrix deal, staying in the CRM: 3.',
      'Uploads listed late by the 10-minute check: 1.',
    ]);
  });

  it('nothing open says so', () => {
    const m = ready(alerts());
    expect(m?.kind === 'ready' && m.summary.text).toBe(FILE_MOVE_TEXT.alertsNothing);
  });
});

describe('form checks', () => {
  it('values: minutes 15 to 43200, deal numbers as digits, item keys not the identity box', () => {
    expect([checkMinutes('14'), checkMinutes('15'), checkMinutes('43200'), checkMinutes('43201'), checkMinutes('1.5'), checkMinutes('')]).toEqual([null, 15, 43200, null, null, null]);
    expect([checkDealNumber(' 4501 '), checkDealNumber('0451'), checkDealNumber('12a')]).toEqual(['4501', null, null]);
    expect(checkDealNumber('9223372036854775807')).toBe('9223372036854775807');
    expect([checkItemKey('ufCrm_1790000000'), checkItemKey('ufCrm_1784359513'), checkItemKey('UF_CRM_1')]).toEqual(['ufCrm_1790000000', 'same_as_identity', null]);
  });

  it('a switch change needs a known switch, on/off, a 10 to 500 character reason and the review confirm', () => {
    const good = { [FILE_MOVE_FIELD.switch]: 'delete_after_hold', state: 'on', reason: REASON, confirm: 'yes' };
    expect(parseSwitchChange(form(good))).toEqual({ ok: true, value: { switch: 'delete_after_hold', on: true, reason: REASON } });
    expect(parseSwitchChange(form({ ...good, reason: 'too short' }))).toEqual({ ok: false, code: 'invalid_input', fields: ['reason'] });
    expect(parseSwitchChange(form({ ...good, [FILE_MOVE_FIELD.switch]: 'bitrix_id_proof_copy' }))).toMatchObject({ ok: false, fields: ['fileMoveSwitch'] });
    expect(parseSwitchChange(form({ ...good, confirm: '' }))).toEqual({ ok: false, code: 'review_required', fields: ['confirm'] });
  });

  it('hold, box, pilot (set and clear), relocate and accept-lost', () => {
    expect(parseHoldChange(form({ minutes: '30', reason: REASON, confirm: 'yes' }))).toEqual({ ok: true, value: { minutes: 30, reason: REASON } });
    expect(parseHoldChange(form({ minutes: '5', reason: REASON, confirm: 'yes' }))).toMatchObject({ ok: false, fields: ['minutes'] });
    expect(parseBoxChange(form({ itemKey: 'ufCrm_1784359513', reason: REASON, confirm: 'yes' }))).toMatchObject({ ok: false, fields: ['itemKey'], sameAsIdentity: true });
    expect(parsePilotChange(form({ dealId: '4501', reason: REASON, confirm: 'yes' }))).toEqual({ ok: true, value: { dealId: '4501', reason: REASON } });
    expect(parsePilotChange(form({ clear: 'yes', reason: REASON, confirm: 'yes' }))).toEqual({ ok: true, value: { dealId: null, reason: REASON } });
    expect(parsePilotChange(form({ dealId: '', reason: REASON, confirm: 'yes' }))).toMatchObject({ ok: false, fields: ['dealId'] });
    expect(parseRelocate(form({ moveId: MOVE, dealId: '4600', confirm: 'yes' }))).toEqual({ ok: true, value: { moveId: MOVE, dealId: '4600' } });
    expect(parseAcceptLost(form({ moveId: 'not-a-uuid', reason: REASON, confirm: 'yes' }))).toMatchObject({ ok: false, fields: ['moveId'] });
  });
});

describe('refusal words', () => {
  it('maps the frozen error states', () => {
    expect(['42501', '22023', '55000', 'P0002', 'PT409', 'PT429', 'PGRST202', '42883', 'PGRST301', 'XX000'].map(errorCodeOf)).toEqual([
      'not_authorized',
      'invalid_input',
      'wrong_state',
      'not_found',
      'conflict',
      'view_limit',
      'not_installed',
      'not_installed',
      'session',
      'unexpected',
    ]);
  });

  it('pilot_required and open_stops get their own plain sentences; unknown outcomes never say "not saved"', () => {
    expect(refusalText('wrong_state', 'pilot_required')).toBe(FILE_MOVE_TEXT.refusedPilotRequired);
    expect(refusalText('wrong_state', 'open_stops')).toBe(FILE_MOVE_TEXT.refusedOpenStops);
    expect(refusalText('wrong_state', 'other')).toBe(FILE_MOVE_TEXT.refusedWrongState);
    expect(refusalText('invalid_input', 'p_reason')).toBe(FILE_MOVE_TEXT.refusedReason);
    expect(refusalText('unexpected')).toBe(SETTINGS_TEXT.unknownOutcome);
  });
});

describe('actions (mocked database, own session)', () => {
  beforeEach(() => {
    mocks.rpc.mockReset();
    mocks.revalidatePath.mockReset();
    mocks.ended = false;
  });

  it('switch: calls file_move_set_switch with the parsed values and says what changed', async () => {
    const { setFileMoveSwitchAction } = await import('@/modules/integration/server/file-move-admin-actions');
    mocks.rpc.mockResolvedValue({ data: { changed: true, switch: 'check_id_proof_copies', on: true }, error: null });
    const r = await setFileMoveSwitchAction(null, form({ [FILE_MOVE_FIELD.switch]: 'check_id_proof_copies', state: 'on', reason: REASON, confirm: 'yes' }));
    expect(mocks.rpc).toHaveBeenCalledWith('file_move_set_switch', { p_switch: 'check_id_proof_copies', p_on: true, p_reason: REASON });
    expect(r).toEqual({ ok: true, changed: true, message: 'Check ID proof copies in Bitrix is now on. Recorded with your name and reason.' });
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/app/admin/integration');
  });

  it('switch: no review confirm, no database call', async () => {
    const { setFileMoveSwitchAction } = await import('@/modules/integration/server/file-move-admin-actions');
    const r = await setFileMoveSwitchAction(null, form({ [FILE_MOVE_FIELD.switch]: 'delete_after_hold', state: 'on', reason: REASON }));
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: false, code: 'review_required', message: FILE_MOVE_TEXT.refusedReview });
  });

  it('switch: pilot_required refusal in plain words, database message never shown', async () => {
    const { setFileMoveSwitchAction } = await import('@/modules/integration/server/file-move-admin-actions');
    mocks.rpc.mockResolvedValue({ data: null, error: { code: '55000', message: 'wrong_state', hint: 'pilot_required' } });
    const r = await setFileMoveSwitchAction(null, form({ [FILE_MOVE_FIELD.switch]: 'delete_after_hold', state: 'on', reason: REASON, confirm: 'yes' }));
    expect(r).toEqual({ ok: false, code: 'wrong_state', hint: 'pilot_required', message: FILE_MOVE_TEXT.refusedPilotRequired });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('hold: a 22023 naming p_minutes marks the minutes field', async () => {
    const { setFileMoveHoldAction } = await import('@/modules/integration/server/file-move-admin-actions');
    mocks.rpc.mockResolvedValue({ data: null, error: { code: '22023', message: 'invalid_input', hint: 'p_minutes' } });
    const r = await setFileMoveHoldAction(null, form({ minutes: '20', reason: REASON, confirm: 'yes' }));
    expect(r).toMatchObject({ ok: false, code: 'invalid_input', fields: ['minutes'] });
  });

  it('pilot clear sends null; a reply of the wrong shape is "could not confirm"', async () => {
    const { setFileMovePilotAction } = await import('@/modules/integration/server/file-move-admin-actions');
    mocks.rpc.mockResolvedValue({ data: { changed: true, pilotBitrixDealId: null }, error: null });
    const r = await setFileMovePilotAction(null, form({ clear: 'yes', reason: REASON, confirm: 'yes' }));
    expect(mocks.rpc).toHaveBeenCalledWith('file_move_set_pilot', { p_source_deal_id: null, p_reason: REASON });
    expect(r).toEqual({ ok: true, changed: true, message: FILE_MOVE_TEXT.savedPilotCleared });

    mocks.rpc.mockResolvedValue({ data: { surprise: true }, error: null });
    const odd = await setFileMovePilotAction(null, form({ dealId: '4501', reason: REASON, confirm: 'yes' }));
    expect(odd).toMatchObject({ ok: false, code: 'unexpected', message: SETTINGS_TEXT.unknownOutcome });
  });

  it('an ended session answers "session" without a database call', async () => {
    const { acceptFileMoveLostAction } = await import('@/modules/integration/server/file-move-admin-actions');
    mocks.ended = true;
    const r = await acceptFileMoveLostAction(null, form({ moveId: MOVE, reason: REASON, confirm: 'yes' }));
    expect(r).toMatchObject({ ok: false, code: 'session', message: SETTINGS_TEXT.signedOut });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('load: not the Super Admin is hidden; an older database is "not installed" for a Super Admin only', async () => {
    const { loadFileMoveAdmin } = await import('@/modules/integration/server/file-move-admin');
    const staff = { supabase: { rpc: (...a: unknown[]) => mocks.rpc(...a) } } as never;
    mocks.rpc.mockResolvedValue({ data: null, error: null });
    expect(await loadFileMoveAdmin(staff, { superAdminSomewhere: true })).toEqual({ kind: 'hidden' });
    mocks.rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'not found' } });
    expect(await loadFileMoveAdmin(staff, { superAdminSomewhere: true })).toEqual({ kind: 'not_installed' });
    expect(await loadFileMoveAdmin(staff, { superAdminSomewhere: false })).toEqual({ kind: 'hidden' });
    mocks.rpc.mockResolvedValueOnce({ data: settings(), error: null }).mockResolvedValueOnce({ data: null, error: { code: 'XX000' } });
    expect(await loadFileMoveAdmin(staff, { superAdminSomewhere: true })).toEqual({ kind: 'ready', settings: settings(), alerts: 'error' });
  });
});

describe('file not available pages', () => {
  it.each(['bitrix_unavailable', 'needs_attention'] as const)('%s: complete document, English, no script, the approved words, a link to /app', (kind) => {
    const html = fileUnavailableHtml(kind);
    expect(html.startsWith('<!doctype html><html lang="en">')).toBe(true);
    expect(html.endsWith('</html>')).toBe(true);
    expect(html).not.toMatch(/<script|javascript:|\son[a-z]+=/i);
    expect(html).toContain(`<h1>${FILE_UNAVAILABLE_TEXT[kind].heading}</h1>`);
    expect(html).toContain(`<p>${FILE_UNAVAILABLE_TEXT[kind].text}</p>`);
    expect(html).toContain('<a href="/app">Back to the CRM</a>');
    expect(html).not.toMatch(/https?:\/\//);
  });

  it('keeps the approved sentences word for word (file 14 section 2.5)', () => {
    expect(FILE_UNAVAILABLE_TEXT.bitrix_unavailable.text).toBe('This file is kept in Bitrix and Bitrix is not answering right now. Nothing is lost. Please try again in a few minutes.');
    expect(FILE_UNAVAILABLE_TEXT.needs_attention.text).toBe('This file needs attention. Please tell your administrator.');
  });
});
