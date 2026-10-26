import type { DealDetail, DealListItem } from '@/modules/deals/dto';
import { bitrixNameKey, dealFilters, dealSortLinks, dealStageEntity, dealsListHref, leadFilters, leadsListHref, listPager } from '@/modules/deals/list-model';
import { buildDealWorkspace, type DealWorkspaceInput } from '@/modules/deals/workspace';
import { buildLeadWorkspace, type LeadWorkspaceInput } from '@/modules/leads/record';
import type {
  BitrixNameVM,
  DealDocumentRow,
  DealListFilter,
  DealTab,
  DealWorkspaceVM,
  LeadLinkVM,
  LeadTab,
  LeadWorkspaceVM,
  LeadListFilter,
  ListFreshnessVM,
  RecordOwnerVM,
} from '@/modules/deals/workspace-contract';
import type { DealsListScreenProps, DealListRowVM } from '@/views/deals-list-view';
import type { LeadsListScreenProps, LeadListRowVM } from '@/views/lead-views';

/*
 * Direction A Batch 1 preview fixtures (synthetic only). Turn the gallery's
 * older synthetic list items into the Batch 1 list view models, the way the
 * routes do on the server, so every list state can be reviewed in the new
 * screens. Nothing here reads data.
 */

/** A Bitrix code as the name map would return it while switched off (the default), or named. */
export function previewName(code: string, name?: string | null): BitrixNameVM {
  return name ? { code, name, labelState: 'named' } : { code, name: null, labelState: 'switched_off' };
}

function ownerOf(item: DealListItem): RecordOwnerVM {
  if (item.relation === 'waiting') return { kind: 'waiting' };
  if (item.relation === 'owner') return { kind: 'you' };
  return item.ownerName ? { kind: 'colleague', displayName: item.ownerName } : { kind: 'colleague' };
}

/** Older DealListItem fixture to a Batch 1 row. */
export function previewDealRow(item: DealListItem): DealListRowVM {
  const s = item.source;
  return {
    id: item.id,
    reference: item.reference,
    title: item.title,
    branchName: item.branchName,
    owner: ownerOf(item),
    ...(s ? { stage: previewName(s.stageId, s.stageLabel) } : {}),
    testRecord: !s,
    late: Boolean(s?.stale),
    details: {
      relation: item.relation,
      createdOn: item.createdOn,
      ...(s ? { sourceDealId: s.sourceDealId, lastCheckedAt: s.lastVerifiedAt, lastChangeAt: s.lastSyncedAt } : {}),
    },
  };
}

export function previewFreshness(rows: Array<{ lastCheckedAt?: string; late: boolean }>): ListFreshnessVM {
  const known = rows.filter((r) => r.lastCheckedAt);
  if (known.length === 0) return { state: 'unknown' };
  const oldest = known.reduce((a, b) => (Date.parse(a.lastCheckedAt!) <= Date.parse(b.lastCheckedAt!) ? a : b));
  return { state: 'known', oldestCheckedAt: oldest.lastCheckedAt!, anyLate: known.some((r) => r.late) };
}

/** Full DealsListScreen props for a preview state, built with the route's own list-model helpers. */
export function previewDealsProps(input: {
  items: DealListItem[];
  total?: number | null;
  page?: number;
  pageSize?: number;
  filter?: DealListFilter;
  sort?: 'id_desc' | 'id_asc';
  counts?: Partial<Record<DealListFilter, number | null>>;
}): Pick<DealsListScreenProps, 'rows' | 'filters' | 'freshness' | 'pager' | 'sort'> {
  const { items, page = 1, pageSize = 50, filter = 'all', sort = 'id_desc' } = input;
  const total = input.total === undefined ? items.length : input.total;
  const rows = items.map(previewDealRow);
  const counts: Record<DealListFilter, number | null> = {
    all: filter === 'all' ? total : (input.counts?.all ?? total),
    owned: input.counts?.owned ?? items.filter((i) => i.relation === 'owner').length,
    assigned: input.counts?.assigned ?? items.filter((i) => i.relation === 'assigned').length,
  };
  return {
    rows,
    filters: dealFilters(counts, filter, sort),
    freshness: previewFreshness(rows.map((r) => ({ lastCheckedAt: r.details.lastCheckedAt, late: r.late }))),
    pager: listPager({ page, pageSize, shown: rows.length, total, href: (p) => dealsListHref(filter, p, sort) }),
    sort: dealSortLinks(filter, sort),
  };
}

/** Full LeadsListScreen props for a preview state, built with the route's own list-model helpers. */
export function previewLeadsProps(input: {
  rows: LeadListRowVM[];
  total?: number | null;
  page?: number;
  pageSize?: number;
  filter?: LeadListFilter;
  mine?: number | null;
}): Pick<LeadsListScreenProps, 'rows' | 'filters' | 'freshness' | 'pager'> {
  const { rows, page = 1, pageSize = 50, filter = 'all' } = input;
  const total = input.total === undefined ? rows.length : input.total;
  const all = filter === 'all' ? total : null;
  const mine = input.mine === undefined ? rows.filter((r) => r.owner.kind === 'you').length : input.mine;
  return {
    rows,
    filters: leadFilters({ all, mine }, filter),
    freshness: previewFreshness(rows.map((r) => ({ lastCheckedAt: r.details.lastCheckedAt, late: r.late }))),
    pager: listPager({ page, pageSize, shown: rows.length, total, href: (p) => leadsListHref(filter, p) }),
  };
}

// ---------------------------------------------------------------------------
// Deal and Lead workspace previews (DE-02, LE-02): built ONLY through the
// route's own builders (buildDealWorkspace, buildLeadWorkspace) from synthetic
// reads, so the gallery never shows a state the route cannot produce (Echo M2).
// Tab and same-page links are then pointed at the matching preview states.
// ---------------------------------------------------------------------------

type BuildInput = Omit<DealWorkspaceInput, 'tab' | 'book' | 'legacyBooking' | 'services' | 'quotations' | 'itinerariesReadable' | 'leadLink' | 'dealId'> &
  Partial<Pick<DealWorkspaceInput, 'book' | 'legacyBooking' | 'services' | 'quotations' | 'itinerariesReadable' | 'leadLink'>>;

/** `/app/deals/{id}?tab=x` to the preview state of that tab. */
function previewDealHref(href: string, dealId: string, stem: string, servicesFirst: boolean): string {
  const base = `/app/deals/${dealId}`;
  const [path, hash] = href.split('#') as [string, string | undefined];
  if (path !== base && !path.startsWith(`${base}?`)) return href;
  const tab = new URLSearchParams(path.slice(base.length).replace(/^\?/, '')).get('tab') ?? 'overview';
  const target = servicesFirst
    ? tab === 'services' ? `/preview/${stem}` : `/preview/${stem}-${tab}`
    : tab === 'overview' ? `/preview/${stem}` : `/preview/${stem}-${tab}`;
  return hash ? `${target}#${hash}` : target;
}

/**
 * The Deal workspace exactly as the route builds it from these reads.
 * `stem` names the preview family; `servicesFirst` when the family's base
 * state opens on Services and tasks (older booking states).
 */
export function previewBuiltDeal(input: BuildInput & { stem: string; tab: DealTab; servicesFirst?: boolean }): DealWorkspaceVM {
  const { stem, tab, servicesFirst = false, ...rest } = input;
  const ws = buildDealWorkspace({
    dealId: rest.deal.id,
    book: { state: 'none' },
    legacyBooking: { ok: true, exists: false },
    services: { ok: true, view: null },
    quotations: null,
    itinerariesReadable: false,
    leadLink: null,
    ...rest,
    tab,
  });
  const map = (href: string) => previewDealHref(href, rest.deal.id, stem, servicesFirst);
  ws.tabs = ws.tabs.map((t) => ({ ...t, href: map(t.href) }));
  const p = ws.header.primary;
  if (p && 'href' in p) ws.header.primary = { ...p, href: map(p.href) } as typeof p;
  return ws;
}

/** Synthetic Documents read rows (the B1-2 shape); the builder copies them through its allowlist. */
export const PREVIEW_DOCUMENT_ROWS: DealDocumentRow[] = [
  { kind: 'quotation_acceptance', id: 'doc1', fileName: 'synthetic-acceptance.png', mime: 'image/png', uploadedAt: '2026-10-06T07:00:00Z', href: '/preview/ws-deal-sales-documents', context: { quotationReference: 'TQ-1042', versionNo: 1, evidenceKind: 'acceptance_message' } },
  { kind: 'id_proof', id: 'doc2', fileName: 'synthetic-id-traveller-1.pdf', mime: 'application/pdf', uploadedAt: '2026-10-08T05:00:00Z', href: '/preview/ws-deal-sales-documents', context: { travellerSeq: 1 } },
  { kind: 'itinerary_pdf', id: 'doc3', fileName: 'synthetic-itinerary.pdf', mime: 'application/pdf', uploadedAt: '2026-10-09T05:00:00Z', href: '/preview/ws-deal-sales-documents', context: { pdfKind: 'final', documentId: 'it-1' } },
];

/**
 * Older gallery fixtures (DealDetail) as a Batch 1 workspace, through the
 * builder: money only for price readers, owner and stage from the detail,
 * Bitrix facts in Overview, status only what the given reads prove.
 */
export function previewWorkspaceFromDetail(
  detail: DealDetail,
  input: { stem: string; current: DealTab; servicesFirst?: boolean; leadLink?: LeadLinkVM | null; read?: Partial<BuildInput> },
): DealWorkspaceVM {
  // The older fixtures carry a Bitrix stage name; give the builder the name map as if the switch were on.
  const s = detail.source;
  const names = s?.stageLabel ? { state: 'on' as const, names: new Map([[bitrixNameKey(dealStageEntity(s.stageId), s.stageId), { name: s.stageLabel, missing: false }]]) } : undefined;
  return previewBuiltDeal({ deal: detail, stem: input.stem, tab: input.current, servicesFirst: input.servicesFirst, leadLink: input.leadLink ?? null, ...(names ? { names } : {}), ...input.read });
}

/** `/app/leads/{id}?tab=x` to the preview state of that tab. */
function previewLeadHref(href: string, leadId: string, stem: string): string {
  const base = `/app/leads/${leadId}`;
  if (href !== base && !href.startsWith(`${base}?`)) return href;
  const tab = new URLSearchParams(href.slice(base.length).replace(/^\?/, '')).get('tab') ?? 'overview';
  return tab === 'overview' ? `/preview/${stem}` : `/preview/${stem}-${tab}`;
}

/** The Lead workspace exactly as the route builds it, with preview tab links. */
export function previewBuiltLead(input: Omit<LeadWorkspaceInput, 'tab'> & { stem: string; tab: LeadTab }): LeadWorkspaceVM {
  const { stem, tab, ...rest } = input;
  const ws = buildLeadWorkspace({ ...rest, tab });
  ws.tabs = ws.tabs.map((t) => ({ ...t, href: previewLeadHref(t.href, rest.lead.id, stem) }));
  return ws;
}
