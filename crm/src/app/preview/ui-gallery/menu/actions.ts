'use server';

import { PREVIEW_SEARCH_DEALS, PREVIEW_SEARCH_LEADS, previewSearchPage } from '@/app/preview/[state]/batch5-search-fixtures';
import { isUiPreviewEnabled } from '@/lib/config';
import type { DealSearchResult, LeadSearchResult } from '@/modules/search/contracts';
import { normaliseSearchQuery, SEARCH_FIELD } from '@/modules/search/contracts';
import { searchMessage } from '@/modules/search/text';

/*
 * LOCAL DESIGN-REVIEW GALLERY ONLY (UX redesign R1, quick search). Stand-in
 * actions with the real search actions' shape over the Batch 5 synthetic
 * pool. They read the posted words only and write nothing; they refuse to run
 * unless the preview gallery is enabled. The "error" pair always fails, as a
 * search that did not finish.
 */

function guard() {
  if (!isUiPreviewEnabled(process.env)) throw new Error('Preview only.');
}

export async function previewMenuSearchDeals(formData: FormData): Promise<DealSearchResult> {
  guard();
  const page = previewSearchPage(PREVIEW_SEARCH_DEALS, formData.get(SEARCH_FIELD.query), null);
  if ('tooShort' in page) return { ok: false, kind: 'deal', query: page.query, code: 'too_short', message: searchMessage('deal', 'too_short') };
  return { ok: true, kind: 'deal', ...page };
}

export async function previewMenuSearchLeads(formData: FormData): Promise<LeadSearchResult> {
  guard();
  const page = previewSearchPage(PREVIEW_SEARCH_LEADS, formData.get(SEARCH_FIELD.query), null);
  if ('tooShort' in page) return { ok: false, kind: 'lead', query: page.query, code: 'too_short', message: searchMessage('lead', 'too_short') };
  return { ok: true, kind: 'lead', ...page };
}

export async function previewMenuSearchDealsError(formData: FormData): Promise<DealSearchResult> {
  guard();
  return { ok: false, kind: 'deal', query: normaliseSearchQuery(formData.get(SEARCH_FIELD.query)), code: 'unexpected', message: searchMessage('deal', 'unexpected') };
}
