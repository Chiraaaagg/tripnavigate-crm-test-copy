'use server';

import { LOOKUP_OK } from './acc3-rates-fixtures';

/*
 * LOCAL DESIGN-REVIEW GALLERY ONLY. Stand-in server actions for the rate
 * contract states (acc3-rates-), so a press shows the real success or
 * refusal path without a database. They read nothing and write nothing; the
 * gallery is a 404 outside the local preview mode. Refusal texts are the
 * frozen §13 messages (track E's modules/rate-contracts/contracts.ts).
 */

type Result = { ok: true; data?: unknown; message: string } | { ok: false; code: string; message: string; field?: string };

async function settle<T>(value: T): Promise<T> {
  await new Promise((resolve) => setTimeout(resolve, 60));
  return value;
}

export async function rcCreateOk(): Promise<Result> {
  return settle({ ok: true, message: 'Synthetic preview: draft RC-2026-000047 made.', data: { contractId: 'a0003503-0000-4000-8000-000000003503' } });
}
export async function rcLinkNotAllowed(): Promise<Result> {
  return settle({ ok: false, code: 'link_not_allowed', message: 'This supplier is not linked to this hotel, or does not sell hotels.', field: 'hotelId' });
}
export async function rcSaveOk(): Promise<Result> {
  return settle({ ok: true, message: 'Synthetic preview: details saved.' });
}
export async function rcVersionChanged(): Promise<Result> {
  return settle({ ok: false, code: 'version_changed', message: 'Someone changed this contract while you were working. Reload the page to see the latest version.' });
}
export async function rcLinesOk(): Promise<Result> {
  return settle({ ok: true, message: 'Synthetic preview: 4 rate lines and 2 blackouts saved.' });
}
export async function rcLinesOverlap(): Promise<Result> {
  return settle({ ok: false, code: 'lines_overlap', message: 'Two rate lines for the same room and meal plan overlap in dates.', field: 'lines[3].seasonFrom' });
}
export async function rcLinesInvalid(): Promise<Result> {
  return settle({ ok: false, code: 'invalid_input', message: 'Check the highlighted field.', field: 'lines[1].ratePaise' });
}
export async function rcSubmitOk(): Promise<Result> {
  return settle({ ok: true, message: 'Synthetic preview: sent to the Managers for approval.' });
}
export async function rcOff(): Promise<Result> {
  return settle({ ok: false, code: 'rate_contracts_off', message: 'Rate contracts are not switched on yet.' });
}
export async function rcDecideOk(): Promise<Result> {
  return settle({ ok: true, message: 'Synthetic preview: decision saved.' });
}
export async function rcNotSelf(): Promise<Result> {
  return settle({ ok: false, code: 'not_self_approval', message: 'You cannot approve a contract you entered. Ask another Manager.' });
}
export async function rcReasonShort(): Promise<Result> {
  return settle({ ok: false, code: 'invalid_input', message: 'Write at least 10 characters.', field: 'reason' });
}
export async function rcEndOk(): Promise<Result> {
  return settle({ ok: true, message: 'Synthetic preview: contract ended.' });
}
export async function rcRoomTypeOk(): Promise<Result> {
  return settle({ ok: true, message: 'Synthetic preview: room type added.' });
}
export async function rcInUse(): Promise<Result> {
  return settle({ ok: false, code: 'in_use', message: 'This is used by an active contract.' });
}
export async function rcFileOk(): Promise<Result> {
  return settle({ ok: true, message: 'Synthetic preview: file uploaded.' });
}

export async function rcLookup(input: { roomTypeId: string; mealPlanCode: string }): Promise<{ ok: true; data: typeof LOOKUP_OK | null } | { ok: false; message: string }> {
  await settle(null);
  if (input.mealPlanCode === 'AI') return { ok: true, data: { ...LOOKUP_OK, state: 'no_contract', contractIds: [], nights: [], perRoomTotalPaise: null, totalPaise: null } };
  return { ok: true, data: LOOKUP_OK };
}
