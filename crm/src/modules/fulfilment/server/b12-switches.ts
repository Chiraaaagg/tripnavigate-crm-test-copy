import 'server-only';
import { z } from 'zod';
import type { StaffContext } from '@/modules/identity/server/session';
import { bitrixIdProofCopyAlerts } from '../b11-commands';
import { asRpcClient } from '../commands';
import { PDF_RENDER_ONLINE_ENV } from '@/modules/documents/render/print-token';
import { B12_READ_ONLY_SWITCH_TEXT, B12_SWITCH_KEYS, B12_SWITCH_TEXT, type B12SwitchesView } from '../contracts';

/**
 * B1.2 switches on the Workflow page: read under the staff member's own
 * session (the intake config row is readable to integration.manage holders;
 * RLS). null when the row is not readable for this person (no card). A
 * column a database does not have yet reads as unknown, never as off.
 * The online PDF maker (DEC-49) is a server setting: shown as on or off,
 * never changed here. canSwitch mirrors the database rule (Super Admin of the pilot company); the
 * database decides again on every change.
 */

type Staff = Pick<StaffContext, 'supabase' | 'access'>;

const RowSchema = z.object({
  pilot_legal_entity_id: z.uuid(),
  bitrix_trip_facts_read: z.boolean().optional(),
  lead_intake_unowned: z.boolean().optional(),
  bitrix_id_proof_copy: z.boolean().optional(),
});

const COLUMNS = 'pilot_legal_entity_id, bitrix_trip_facts_read, lead_intake_unowned, bitrix_id_proof_copy';

export async function loadB12Switches(staff: Staff): Promise<B12SwitchesView | null> {
  const { data, error } = await staff.supabase.from('integration_intake_config').select(COLUMNS).eq('source_system', 'bitrix');
  if (error || !data || data.length !== 1) return null;
  const row = RowSchema.safeParse(data[0]);
  if (!row.success) return null;
  const r = row.data;
  // Open automatic stops (Super Admin read; null for others or before 0700).
  let openStops: number | undefined;
  try {
    const alerts = await bitrixIdProofCopyAlerts(asRpcClient(staff.supabase));
    openStops = alerts ? alerts.stops.filter((s) => s.acknowledgedAt === null).length : undefined;
  } catch {
    openStops = undefined;
  }
  const state: Record<(typeof B12_SWITCH_KEYS)[number], boolean | null> = {
    bitrix_trip_facts_read: r.bitrix_trip_facts_read ?? null,
    lead_intake_unowned: r.lead_intake_unowned ?? null,
    bitrix_id_proof_copy: r.bitrix_id_proof_copy ?? null,
  };
  return {
    switches: B12_SWITCH_KEYS.map((key) => ({
      key,
      title: B12_SWITCH_TEXT[key].title,
      detail: B12_SWITCH_TEXT[key].detail,
      on: state[key],
      ...(key === 'bitrix_id_proof_copy' && openStops !== undefined ? { openStops } : {}),
    })),
    // DEC-49: a server setting; only whether it is on (never any other server value).
    readOnly: [{ key: 'pdf_render_online', ...B12_READ_ONLY_SWITCH_TEXT.pdf_render_online, on: process.env[PDF_RENDER_ONLINE_ENV] === 'on' }],
    canSwitch: staff.access.memberships.some((m) => m.roleCode === 'super_admin' && m.legalEntityId === r.pilot_legal_entity_id),
  };
}
