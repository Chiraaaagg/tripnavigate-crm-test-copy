'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { type FormState, fieldValue } from '@/lib/forms';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { requireStaff } from '@/modules/identity/server/session';
import { createBitrixClient } from '../bitrix/client';
import { BitrixConfigError, getIntegrationEnv, resolveBitrixRestTarget } from '../bitrix/config';
import { runBitrixSync } from '../bitrix/sync';
import { asRpcClient, IntakeCommandError, loadActiveManifest, queueResync, requestReconcile, retryInbox } from '../commands';
import { selectActiveConfig, selectIntakeConfig } from '../intake-config';
import { heldDealIds, leadWatermarkStore, manifestVerifiedAt } from './runtime';

/**
 * Admin commands for /app/admin/integration (contract §6). Pattern:
 *   1. requireStaff(): verified aal2 session, active staff.
 *   2. Authorization by the database under the actor's own session
 *      (integration_retry_inbox / integration_request_reconcile: integration.manage,
 *      audit, reconcile cooldown).
 *   3. Only then the privileged client (reconcile enqueue is service-role only).
 * Messages are truthful and never contain provider URLs, tokens or SQL text.
 */

const ADMIN_PATH = '/app/admin/integration';
const DENIED = 'You do not have permission to manage the Bitrix intake.';

const RetryInput = z.object({ inboxId: z.uuid() });

export async function retryInboxItemAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const staff = await requireStaff();
  const parsed = RetryInput.safeParse({ inboxId: fieldValue(formData, 'inboxId') });
  if (!parsed.success) return { status: 'error', message: 'Select a valid intake item.' };
  try {
    await retryInbox(asRpcClient(staff.supabase), parsed.data.inboxId);
  } catch (error) {
    const state = error instanceof IntakeCommandError ? error.sqlState : null;
    if (state === '42501') return { status: 'error', message: DENIED };
    if (state === 'P0002' || state === '22023' || state === '23514') {
      return { status: 'error', message: 'This item cannot be retried (it may already be queued or processed).' };
    }
    return { status: 'error', message: 'The retry could not be recorded. Please try again.' };
  }
  revalidatePath(ADMIN_PATH);
  return {
    status: 'success',
    message: 'Queued for another attempt. It is processed on the next worker run; check back for the result.',
  };
}

// Signature fixed by useActionState (prev, formData); neither carries input here.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function runReconcileNowAction(_prev: FormState, _formData: FormData): Promise<FormState> {
  const staff = await requireStaff();

  // 1. Authorization, audit and cooldown by the database under the actor's own
  //    session (integration.manage, aal2/session) BEFORE Bitrix is listed.
  let request;
  try {
    request = await requestReconcile(asRpcClient(staff.supabase));
  } catch (error) {
    const state = error instanceof IntakeCommandError ? error.sqlState : null;
    if (state === '42501') return { status: 'error', message: DENIED };
    if (error instanceof IntakeCommandError && error.refusal === 'environment_unset') {
      return { status: 'error', message: 'This CRM environment is not set up yet (environment unset). Nothing was checked.' };
    }
    if (state === '55000') {
      return { status: 'error', message: 'Bitrix intake is not configured or not enabled. Nothing was checked.' };
    }
    return { status: 'error', message: 'The check could not be authorized. Please retry.' };
  }
  if (!request.allowed) {
    const minutes = Math.max(1, Math.ceil(request.retryAfterSeconds / 60));
    return {
      status: 'error',
      message: `A check for missed deals ran recently. Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}. Nothing was checked now.`,
    };
  }

  // 2. The config row (RLS: integration.manage) for category/stages/watermark.
  const visible = await selectIntakeConfig((columns) =>
    staff.supabase.from('integration_intake_config').select(columns).eq('source_system', 'bitrix'),
  );
  if (visible.error) {
    return { status: 'error', message: visible.error.code === '42501' ? DENIED : 'Could not read the intake settings. Please retry.' };
  }
  const active = selectActiveConfig(visible.data ?? []);
  if (!active.config || active.config.portalMemberId !== request.portalMemberId) {
    return {
      status: 'error',
      message:
        !active.config && active.reason === 'ambiguous'
          ? 'More than one Bitrix portal is enabled. Disable all but one before checking for missed deals.'
          : 'Bitrix intake is not configured or not enabled. Nothing was checked.',
    };
  }

  let bitrix;
  try {
    const target = resolveBitrixRestTarget(getIntegrationEnv().bitrixWebhookBaseUrl, active.config.portalDomain, process.env.APP_ENV);
    bitrix = createBitrixClient({ target });
  } catch (error) {
    if (error instanceof BitrixConfigError) {
      return {
        status: 'error',
        message:
          error.code === 'missing'
            ? 'The Bitrix connection credential is not configured on the server. Nothing was checked.'
            : 'The Bitrix connection credential does not match the configured portal. Nothing was checked.',
      };
    }
    return { status: 'error', message: 'Could not start the check. Please retry.' };
  }

  // 3. Queue a full resync (unless one is open), then exactly the run the
  //    scheduler makes; the scheduler continues the resync until complete.
  //    Phase 6: the reconcile pass is scoped by the active approved Lead/Deal lists.
  const config = active.config;
  const rpc = asRpcClient(createSupabaseAdminClient());
  await queueResync(rpc, config.portalMemberId).catch(() => null);
  const summary = await runBitrixSync({
    rpc,
    bitrix,
    config,
    heldDealIds: (ids) => heldDealIds(config.portalMemberId, ids),
    verifiedAt: (object, ids) => manifestVerifiedAt(config.portalMemberId, object, ids),
    activeManifestIds: async (object) => (await loadActiveManifest(rpc, config.portalMemberId, object))?.ids ?? null,
    leadWatermark: leadWatermarkStore(config.portalMemberId),
    trigger: 'manual',
  }).catch(() => null);
  revalidatePath(ADMIN_PATH);
  if (!summary) {
    return { status: 'error', message: 'The sync did not complete. Deals queued before the failure stay queued; please retry.' };
  }
  if (summary.reconcileError) {
    return {
      status: 'error',
      message: `Bitrix could not be read (${summary.reconcileError}). Nothing was changed; queued deals stay queued and the next automatic sync tries again.`,
    };
  }
  const r = summary.reconcile!;
  const w = summary.worker;
  const rs = summary.resync;
  const full = rs?.result
    ? ` Full check: Bitrix ${rs.result.bitrix} · CRM ${rs.result.crm}${rs.result.inSync ? ' · in sync' : ''}.`
    : rs
      ? ` Full check in progress: ${rs.scanned}${rs.bitrixTotal !== null ? ` of ${rs.bitrixTotal}` : ''} Bitrix deals listed.`
      : '';
  const lead = r.manifest.lead;
  const leads = lead.scoped
    ? ` Approved lead list: ${lead.found} of ${lead.items} found in Bitrix, ${lead.enqueued} newly queued${lead.missing ? `, ${lead.missing} not found` : ''}.`
    : ' No approved lead list is active, so no leads were checked.';
  const scope = r.manifest.deal.scoped ? 'on the approved deal list' : 'in the pipeline';
  const more =
    summary.budgetReached || r.truncated || (rs && !rs.result)
      ? ' More work remains; the automatic sync continues it every 30 seconds.'
      : '';
  return {
    status: summary.outcome === 'ok' || summary.outcome === 'partial' ? 'success' : 'error',
    message: `Checked ${r.scanned} Bitrix record(s) ${scope}: ${r.enqueued} queued, ${r.alreadyCurrent} already up to date${r.notInManifest ? `, ${r.notInManifest} outside the approved list` : ''}. Processed ${w.claimed}: ${w.created} new, ${w.updated} updated, ${w.ignored} not eligible, ${w.needsReview} need review${w.failed + w.deadLettered ? `, ${w.failed + w.deadLettered} failed` : ''}.${leads}${full}${more}`,
  };
}
