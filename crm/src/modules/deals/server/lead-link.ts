import 'server-only';
import { z } from 'zod';
import { leadAccessDenied } from '@/modules/leads/server/queries';
import type { StaffContext } from '@/modules/identity/server/session';

/**
 * "Came from Lead BXL-<id>" on the Deal page (sync completion §3).
 *
 * The link appears only when a crm_leads row with the Deal's own source portal
 * and Bitrix LEAD_ID (deals.source_lead_id, written by the Deal apply) exists
 * AND the viewer may read it. Both reads use the viewer's own session client,
 * so row-level security decides; Purchase is refused before any query, as on
 * the Lead pages. Never matched by name, phone, title or contact. Any error or
 * missing row shows nothing: the link is a convenience, never a reason for the
 * Deal page to fail.
 */

export interface DealLeadLink {
  /** /app/leads/<crm_leads.id> */
  href: string;
  /** BXL-<Bitrix LEAD_ID> */
  reference: string;
}

type LinkStaff = Pick<StaffContext, 'access' | 'supabase'>;

interface QueryResult {
  data: unknown;
  error: unknown;
}

/** Minimal PostgREST surface for the two bounded reads below. */
interface LinkQuery extends PromiseLike<QueryResult> {
  eq(column: string, value: unknown): LinkQuery;
  limit(count: number): LinkQuery;
  maybeSingle(): PromiseLike<QueryResult>;
}
interface LinkClient {
  from(table: 'deals' | 'crm_leads'): { select(columns: string): LinkQuery };
}

const DealSourceSchema = z.object({
  source_portal: z.string().min(1),
  source_lead_id: z.union([z.number().int().positive(), z.string().regex(/^[1-9][0-9]{0,15}$/)]).transform(String),
});

const LeadRowSchema = z.object({ id: z.uuid() });

export async function loadDealLeadLink(staff: LinkStaff, dealId: string): Promise<DealLeadLink | null> {
  if (leadAccessDenied(staff.access)) return null;
  // The Deal page starts this read together with the deal read (speed plan C4), so the id can
  // still be the raw URL segment here: anything but a UUID shows nothing, without a query.
  if (!z.uuid().safeParse(dealId).success) return null;
  // deals.source_lead_id is not in the generated Database types yet (lead owns them).
  const client = staff.supabase as unknown as LinkClient;
  try {
    const deal = await client.from('deals').select('source_portal, source_lead_id').eq('id', dealId).maybeSingle();
    if (deal.error || !deal.data) return null;
    const source = DealSourceSchema.safeParse(deal.data);
    if (!source.success) return null;
    const lead = await client
      .from('crm_leads')
      .select('id')
      .eq('source_system', 'bitrix')
      .eq('source_portal', source.data.source_portal)
      .eq('source_lead_id', source.data.source_lead_id)
      .limit(1)
      .maybeSingle();
    if (lead.error || !lead.data) return null;
    const row = LeadRowSchema.safeParse(lead.data);
    if (!row.success) return null;
    return { href: `/app/leads/${row.data.id}`, reference: `BXL-${source.data.source_lead_id}` };
  } catch {
    return null;
  }
}
