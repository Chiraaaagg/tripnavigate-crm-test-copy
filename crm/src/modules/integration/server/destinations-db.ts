import 'server-only';
import { z } from 'zod';
import type { RpcClient } from '@/modules/fulfilment/commands';
import { callVn } from '@/modules/parties/server/parties-db';

/**
 * Typed wrappers for the voice-note batch Bitrix trip details (migration
 * 20261128000100; shapes: Atlas notes atlas-vn-shapes.md section a and v2):
 * the switch bitrix_trip_details_read, its state, the destination options
 * with their domestic / international classification, and the Super Admin
 * classification command. Under the caller's own session; refusals throw
 * VnDbError (parties-db; 'not_configured' when the Bitrix connection is
 * missing or ambiguous).
 */

export const DESTINATION_SCOPES = ['domestic', 'international'] as const;
export type DestinationScope = (typeof DESTINATION_SCOPES)[number];
export const DESTINATION_LIST_IDS = ['DEAL_DESTINATION', 'DEAL_DESTINATION_MULTI'] as const;
export type DestinationListId = (typeof DESTINATION_LIST_IDS)[number];

const OptionSchema = z.object({
  listId: z.enum(DESTINATION_LIST_IDS),
  optionId: z.string().regex(/^[1-9][0-9]{0,9}$/),
  label: z.string(),
  missing: z.boolean(),
  scope: z.enum(DESTINATION_SCOPES).nullable(),
  /** 0 = never set (send it as the expected row version). */
  rowVersion: z.number().int().min(0),
  setByName: z.string().nullable(),
  setAt: z.string().nullable(),
});
export type DestinationOption = z.infer<typeof OptionSchema>;
const OptionsSchema = z.object({
  enabled: z.boolean(),
  readAt: z.string().nullable(),
  canSet: z.boolean(),
  options: z.array(OptionSchema),
});
export type DestinationOptionsView = z.infer<typeof OptionsSchema>;

const ScopeSetSchema = z.object({ changed: z.boolean(), scope: z.enum(DESTINATION_SCOPES).nullable(), rowVersion: z.number().int().min(0) });
const SwitchSchema = z.object({ changed: z.boolean(), enabled: z.boolean() });
const StateSchema = z.object({
  enabled: z.boolean(),
  connectionEnabled: z.boolean(),
  effective: z.boolean(),
  canSwitch: z.boolean(),
  lastChange: z.object({
    at: z.string(),
    byName: z.string().nullable(),
    via: z.string().nullable(),
    to: z.boolean().nullable(),
    reason: z.string().nullable(),
  }).nullable(),
});
export type TripDetailsReadState = z.infer<typeof StateSchema>;

/** Super Admin and booking editors (Sales / Manager) of the entity; enabled:false and no options while the switch is off. */
export function listDestinationOptions(client: RpcClient): Promise<DestinationOptionsView> {
  return callVn(client, 'bitrix_destination_options', {}, OptionsSchema);
}

/** Super Admin: sets (domestic | international) or clears (null) one option's trip type, with a reason (audited). */
export function setDestinationScope(
  client: RpcClient,
  args: { listId: DestinationListId; optionId: string; scope: DestinationScope | null; expectedRowVersion: number; reason: string },
): Promise<z.infer<typeof ScopeSetSchema>> {
  return callVn(client, 'bitrix_destination_scope_set', {
    p_list_id: args.listId, p_option_id: args.optionId, p_scope: args.scope, p_expected_row_version: args.expectedRowVersion,
    p_reason: args.reason,
  }, ScopeSetSchema);
}

/** Super Admin: the switch itself (live use needs the owner's APPROVE). */
export function setTripDetailsRead(client: RpcClient, enabled: boolean, reason: string): Promise<z.infer<typeof SwitchSchema>> {
  return callVn(client, 'integration_set_bitrix_trip_details_read', { p_enabled: enabled, p_reason: reason }, SwitchSchema);
}

export function tripDetailsReadState(client: RpcClient): Promise<TripDetailsReadState> {
  return callVn(client, 'bitrix_trip_details_read_state', {}, StateSchema);
}
