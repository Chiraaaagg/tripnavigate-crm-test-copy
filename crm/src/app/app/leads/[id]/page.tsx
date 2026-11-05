import type { Metadata } from 'next';
import { requireStaff } from '@/modules/identity/server/session';
import { loadBitrixNameLookup } from '@/modules/deals/server/queries';
import { buildLeadWorkspace } from '@/modules/leads/record';
import { loadLead } from '@/modules/leads/server/queries';
import { loadQuotationsForLead, QUOTATIONS_NOT_INSTALLED } from '@/modules/quotations/server/queries';
import { SubjectQuotationsCard } from '@/views/b12/quote-page';
import { LeadNotFoundView, LeadsNoPermissionView, LeadWorkspaceView } from '@/views/lead-views';
import { QUOTE_ACTIONS } from '../../quotations/quote-actions';

export const metadata: Metadata = { title: 'Lead' };

export default async function LeadPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const query = (await searchParams) ?? {};
  const staff = await requireStaff();
  // B1.2 quotations: null for anyone who is not the Lead's Sales owner or the branch Manager (no tab),
  // and on an older database; a failed read hides the tab and never hides the Lead. Started together
  // with the Lead read; used only after the Lead is known to be visible.
  const quotationsRead = loadQuotationsForLead(staff, id).catch(() => null);
  // Bitrix names (B1-1, switch Off by default): a failure shows the fallback wording, never blocks.
  const namesRead = loadBitrixNameLookup(staff).catch(() => ({ state: 'list_unreadable' as const }));
  const lead = await loadLead(staff, id);
  if (lead === 'no_permission') return <LeadsNoPermissionView />;
  // Same response for "does not exist" and "not visible to you" so ids cannot be probed.
  if (!lead) return <LeadNotFoundView />;
  const [list, names] = await Promise.all([quotationsRead, namesRead]);
  const quotations = list && list !== QUOTATIONS_NOT_INSTALLED ? list : null;
  const workspace = buildLeadWorkspace({ lead, tab: query.tab, quotations, names });
  // Only the open tab's body is rendered; the quotation card (and its create form) lives on the Quotations tab.
  const quotationsTab =
    workspace.current === 'quotations' && quotations ? (
      <SubjectQuotationsCard list={quotations} subjectId={lead.id} defaultTitle={lead.title} createAction={QUOTE_ACTIONS.create} />
    ) : undefined;
  return <LeadWorkspaceView workspace={workspace} quotationsTab={quotationsTab} />;
}
