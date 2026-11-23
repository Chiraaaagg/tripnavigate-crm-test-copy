/*
 * Settings › Accounts › Tally mapping types: track D's DTOs (contract 8.1 D1
 * `tally_mapping_list`, D2 `tally_mapping_set`, addition
 * `tally_mapping_history`), type-only re-exports so client code imports no
 * runtime module.
 */
import type { TallyMappingHistoryView, TallyMappingView } from '@/modules/accounts-desk/contracts';

export type { TallyMappingHistoryView, TallyMappingRow, TallyMappingRowKind, TallyServiceClass } from '@/modules/accounts-desk/contracts';

/** D1 read. */
export type TallyMappingList = TallyMappingView;

/** One change of a mapping row. */
export type TallyMappingChange = TallyMappingHistoryView['items'][number];

/** Page model built by the route. */
export interface TallyMappingPageView {
  entityName: string;
  /** Companies the viewer keeps the mapping for, when more than one (links that switch `?entity=`). */
  entities?: Array<{ id: string; name: string; href: string; current: boolean }>;
  list: TallyMappingList | 'error';
  /**
   * The history the address asks for (`?history=<mappingId>`, read on the server); its
   * dialog opens on load. 'error' = the read failed; null = not available.
   */
  history?: { mappingId: string; items: TallyMappingChange[] | 'error' | null };
  /** This page's address with the company (`?entity=`); History links add `history=<id>`, closing returns here. */
  baseHref?: string;
  /** Sub-tabs of Settings › Accounts this person may open (Switches, Tally mapping); shown when two or more. */
  tabs?: Array<{ href: string; label: string; current: boolean }>;
}
