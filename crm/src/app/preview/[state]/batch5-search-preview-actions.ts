'use server';

import type { DealSearchResult, LeadSearchResult, SearchErrorCode } from '@/modules/search/contracts';
import { normaliseSearchQuery, SEARCH_FIELD } from '@/modules/search/contracts';
import { PREVIEW_SEARCH_DEALS, PREVIEW_SEARCH_LEADS, previewSearchPage } from './batch5-search-fixtures';

/*
 * LOCAL DESIGN-REVIEW GALLERY ONLY (Batch 5 search). Stand-in server actions
 * with the real action's shape: they read the posted words (POST body only),
 * match the synthetic pool with the contract's rules and answer like the real
 * search, or refuse with one fixed code. They read nothing else and write
 * nothing. The gallery is a 404 outside local preview mode.
 *
 * The plain actions also answer to trigger words (Terra's first stand-ins):
 * words containing "error" → unexpected, "missing" → not_installed,
 * "denied" → not_authorized, and words starting "slow " answer after 1.5 s
 * for the rest of the words.
 */

async function settle<T>(value: T, ms = 60): Promise<T> {
  await new Promise((resolve) => setTimeout(resolve, ms));
  return value;
}

const MESSAGE: Record<SearchErrorCode, string> = {
  too_short: 'Type at least 2 characters to search.',
  not_installed: 'Searching all records is not installed in this CRM yet.',
  not_authorized: 'Not searched: your access does not include this list.',
  unexpected: 'Search did not finish. Nothing was changed.',
};

function leads(formData: FormData): LeadSearchResult {
  const page = previewSearchPage(PREVIEW_SEARCH_LEADS, formData.get(SEARCH_FIELD.query), formData.get(SEARCH_FIELD.after));
  if ('tooShort' in page) return { ok: false, kind: 'lead', query: page.query, code: 'too_short', message: MESSAGE.too_short };
  return { ok: true, kind: 'lead', ...page };
}

function deals(formData: FormData): DealSearchResult {
  const page = previewSearchPage(PREVIEW_SEARCH_DEALS, formData.get(SEARCH_FIELD.query), formData.get(SEARCH_FIELD.after));
  if ('tooShort' in page) return { ok: false, kind: 'deal', query: page.query, code: 'too_short', message: MESSAGE.too_short };
  return { ok: true, kind: 'deal', ...page };
}

function leadRefusal(formData: FormData, code: SearchErrorCode): LeadSearchResult {
  return { ok: false, kind: 'lead', query: normaliseSearchQuery(formData.get(SEARCH_FIELD.query)), code, message: MESSAGE[code] };
}

function dealRefusal(formData: FormData, code: SearchErrorCode): DealSearchResult {
  return { ok: false, kind: 'deal', query: normaliseSearchQuery(formData.get(SEARCH_FIELD.query)), code, message: MESSAGE[code] };
}

type Trigger = { code: SearchErrorCode } | { slow: FormData } | null;

/** Trigger words in the posted query (see the note at the top). */
function trigger(formData: FormData): Trigger {
  const query = normaliseSearchQuery(formData.get(SEARCH_FIELD.query)).toLowerCase();
  if (query.includes('error')) return { code: 'unexpected' };
  if (query.includes('missing')) return { code: 'not_installed' };
  if (query.includes('denied')) return { code: 'not_authorized' };
  if (query.startsWith('slow ')) {
    const rest = new FormData();
    for (const [key, value] of formData.entries()) rest.append(key, key === SEARCH_FIELD.query && typeof value === 'string' ? value.trim().slice(5) : value);
    return { slow: rest };
  }
  return null;
}

export async function previewSearchLeadsAction(formData: FormData): Promise<LeadSearchResult> {
  const t = trigger(formData);
  if (t && 'code' in t) return settle(leadRefusal(formData, t.code));
  if (t) return settle(leads(t.slow), 1500);
  return settle(leads(formData));
}

/** Slow answer (1.5 s), so the "Searching…" state can be seen and tested. */
export async function previewSearchLeadsSlowAction(formData: FormData): Promise<LeadSearchResult> {
  return settle(leads(formData), 1500);
}

/** First page answers; "Show more" fails. */
export async function previewSearchLeadsMoreFailsAction(formData: FormData): Promise<LeadSearchResult> {
  return settle(formData.get(SEARCH_FIELD.after) ? leadRefusal(formData, 'unexpected') : leads(formData));
}

export async function previewSearchLeadsNotInstalledAction(formData: FormData): Promise<LeadSearchResult> {
  return settle(leadRefusal(formData, 'not_installed'));
}

export async function previewSearchLeadsNotAuthorizedAction(formData: FormData): Promise<LeadSearchResult> {
  return settle(leadRefusal(formData, 'not_authorized'));
}

export async function previewSearchLeadsErrorAction(formData: FormData): Promise<LeadSearchResult> {
  return settle(leadRefusal(formData, 'unexpected'));
}

export async function previewSearchDealsAction(formData: FormData): Promise<DealSearchResult> {
  const t = trigger(formData);
  if (t && 'code' in t) return settle(dealRefusal(formData, t.code));
  if (t) return settle(deals(t.slow), 1500);
  return settle(deals(formData));
}

export async function previewSearchDealsNotInstalledAction(formData: FormData): Promise<DealSearchResult> {
  return settle(dealRefusal(formData, 'not_installed'));
}

export async function previewSearchDealsErrorAction(formData: FormData): Promise<DealSearchResult> {
  return settle(dealRefusal(formData, 'unexpected'));
}
