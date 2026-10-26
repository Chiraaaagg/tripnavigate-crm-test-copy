'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireStaff } from '@/modules/identity/server/session';
import { refreshDealNow, type RefreshDealOutcome } from '@/modules/integration/server';
import type { BitrixRefreshRefusal, BitrixRefreshResult } from '../booking-form-contract';
import { type BookingActionResult, type BookingErrorCode, ERROR_TEXT } from '../contracts';

/**
 * Book now v2: "Refresh from Bitrix now" (build plan section 3, step 4).
 *
 * requireStaff() first; the integration module's refreshDealNow then asks the
 * database under the staff member's own session (booking editor of this
 * Deal, Bitrix Deal, read switch on, 20 s cooldown) before Bitrix is read.
 * Bitrix is only read, never written. Messages are plain text for the
 * toast; they never carry Bitrix values or provider text.
 */

const DealId = z.uuid();

const REFRESH_TEXT = {
  updated: 'Updated from Bitrix. The trip facts now match the Deal.',
  unchanged: 'Checked Bitrix. Nothing has changed on this Deal yet. If you have just edited it, wait a few seconds and try again.',
  unchangedOutsideSync:
    'Checked Bitrix, but this Deal is outside what the CRM copies from Bitrix, so nothing was brought in.',
  tooSoon: 'This Deal was refreshed a moment ago. Try again in {seconds} seconds.',
  staffLimit: 'You have refreshed from Bitrix 10 times in the last minute. Try again in {seconds} seconds.',
  syncPaused: 'Bitrix updates are paused by an admin, so this Deal cannot be refreshed now.',
  switchedOff: 'Reading trip facts from Bitrix is switched off, so this Deal cannot be refreshed now. Ask an admin.',
  notBitrixDeal: 'This Deal did not come from Bitrix, so there is nothing to refresh.',
  dealRemoved: 'This Deal is no longer copied from Bitrix, so it cannot be refreshed.',
  dealNotFound: 'Bitrix cannot find this Deal any more. It may have been deleted, or the CRM may no longer have access. Nothing was changed here.',
  provider: 'Bitrix did not answer just now. Nothing was changed. Try again in a minute.',
  partial:
    'Bitrix stopped answering part-way, so some details may not be up to date yet. Try again in a minute.',
  notApplied:
    'Bitrix answered, but the CRM could not take these details. The Bitrix sync admin can see why. Nothing was changed here.',
  notConfigured: 'The Bitrix connection is not set up on this server, so nothing was read. Ask an admin.',
  unconfirmed: 'We could not confirm the refresh. Reload the page to see the latest details.',
} as const;

function refusal(code: BitrixRefreshRefusal, message: string): BookingActionResult<BitrixRefreshResult> {
  return { ok: false, code, message };
}

function fail(code: BookingErrorCode): BookingActionResult<BitrixRefreshResult> {
  return { ok: false, code, message: ERROR_TEXT[code] };
}

const UNAVAILABLE_TEXT: Record<Extract<RefreshDealOutcome, { kind: 'bitrix_unavailable' }>['detail'], string> = {
  provider: REFRESH_TEXT.provider,
  partial: REFRESH_TEXT.partial,
  not_applied: REFRESH_TEXT.notApplied,
  not_configured: REFRESH_TEXT.notConfigured,
  unconfirmed: REFRESH_TEXT.unconfirmed,
};

function toResult(outcome: RefreshDealOutcome): BookingActionResult<BitrixRefreshResult> {
  switch (outcome.kind) {
    case 'updated':
      return { ok: true, data: { outcome: 'updated', readAt: outcome.readAt }, message: REFRESH_TEXT.updated };
    case 'unchanged':
      return {
        ok: true,
        data: { outcome: 'unchanged', readAt: outcome.readAt },
        message: outcome.readAt === null ? REFRESH_TEXT.unchangedOutsideSync : REFRESH_TEXT.unchanged,
      };
    case 'too_soon':
      return refusal(
        'refresh_too_soon',
        (outcome.scope === 'staff' ? REFRESH_TEXT.staffLimit : REFRESH_TEXT.tooSoon).replace('{seconds}', String(outcome.retryAfterSeconds)),
      );
    case 'switched_off':
      return refusal('refresh_switched_off', REFRESH_TEXT.switchedOff);
    case 'sync_paused':
      return refusal('refresh_switched_off', REFRESH_TEXT.syncPaused);
    case 'not_bitrix_deal':
      return refusal('refresh_not_bitrix_deal', REFRESH_TEXT.notBitrixDeal);
    case 'deal_removed':
      return refusal('refresh_not_bitrix_deal', REFRESH_TEXT.dealRemoved);
    case 'bitrix_deal_not_found':
      return refusal('bitrix_deal_not_found', REFRESH_TEXT.dealNotFound);
    case 'bitrix_unavailable':
      return refusal('bitrix_unavailable', UNAVAILABLE_TEXT[outcome.detail]);
    case 'not_authorized':
      return fail('not_authorized');
    case 'environment_unset':
      return fail('environment_unset');
    case 'invalid_input':
      return fail('invalid_input');
  }
}

/** Whether the CRM may hold new Bitrix values after this outcome (the page is refreshed). */
function mayHaveChanged(outcome: RefreshDealOutcome): boolean {
  return (
    outcome.kind === 'updated' ||
    outcome.kind === 'unchanged' ||
    outcome.kind === 'bitrix_deal_not_found' ||
    (outcome.kind === 'bitrix_unavailable' && outcome.detail !== 'not_configured')
  );
}

/**
 * "Refresh from Bitrix now" for the booking form of one Deal. Reads that
 * Deal from Bitrix at once (not at the next sync) and stores it through the
 * normal sync commands. Never writes to Bitrix.
 */
export async function refreshFromBitrixAction(dealId: string): Promise<BookingActionResult<BitrixRefreshResult>> {
  const staff = await requireStaff();
  const parsed = DealId.safeParse(dealId);
  if (!parsed.success) return fail('invalid_input');
  const outcome = await refreshDealNow(staff, parsed.data);
  if (mayHaveChanged(outcome)) {
    revalidatePath(`/app/deals/${parsed.data}`);
    revalidatePath(`/app/deals/${parsed.data}/book`);
    revalidatePath('/app/deals/[id]/book', 'layout'); // the booking form layout (route group) and its steps
  }
  return toResult(outcome);
}
