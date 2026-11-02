-- TripNavigate CRM - Direction A Batch 5: search across Leads and Deals.
--
-- Sources: docs/implementation/frontend-redesign-2026-10-15/contracts.md
-- section E (E.3-E.6), plan.md section 12f (DEC-58, lead scope rulings) and
-- the frozen TypeScript contract crm/src/modules/search/contracts.ts.
-- Shapes: Atlas notes atlas-batch5-shapes.md.
--
-- What changes:
--   1. New read public.crm_search(p_query, p_kind, p_after, p_limit) returning
--      one page of matching Leads or Deals (one kind per call, as the frozen
--      contract says). It is SECURITY INVOKER: it runs as the caller, so the
--      existing row-level security decides every row, unchanged:
--        crm_leads  require_valid_session + scoped_read (the authz.can_read_lead
--                   rule, written set-based from 20261127000200 with the same
--                   meaning; it gives a Purchase holder no Lead at all)
--        deals      scoped_read + hide_removed (removed Deals are never
--                   readable); the read also states removed_at is null.
--      No definer function, no privileged client, no new policy.
--
-- Fields searched (contracts E.4), nothing else (never mobile numbers,
-- e-mails, contacts or commercial values):
--   reference (BX-<n>, BXL-<n>, synthetic references)  case-insensitive prefix
--                                                       (exact is a prefix)
--   plain Bitrix number (query of digits only)          prefix of the number
--   title (only when the query has 3+ characters, is    case-insensitive contains
--          not digits only and has no '@')
--
-- A query of digits only or with '@' could be a mobile number or an e-mail
-- written into a title, so it matches references and Bitrix numbers only
-- (owner rule: never mobile or e-mail, even through titles); the reply then
-- says titlesSearched false.
--
-- Input: the query is normalised as normaliseSearchQuery does in TypeScript
-- (inner whitespace collapsed, trimmed, cut to 60 characters (code points),
-- trimmed again) and must keep at
-- least 2 characters. %, _ and \ are escaped and every match is ILIKE/LIKE with
-- ESCAPE '\' on PL/pgSQL variables, so the text is a bound value matched
-- literally; no SQL or filter text is ever built from it.
--
-- Order and pagination: the same order as each list's default (highest Bitrix
-- number first, then id): Leads (source_lead_id desc, id), Deals
-- (source_deal_id desc nulls last, id; synthetic Deals without a Bitrix
-- number come last). Keyset: p_after is the previous reply's next
-- {n: decimal string | null, id: uuid}; the page holds the rows strictly after
-- it, so rows inserted between pages never cause repeats or skips. p_limit
-- 1-50, default 20. The reply has hasMore and no total count.
--
-- Reply: {kind, titlesSearched, hits: [{kind, id, reference}], hasMore, next}.
--
-- Refusals: 22023 invalid_input with hint kind | query | limit | after. The
-- messages are fixed words; the query text is never put in an error, a notice,
-- an audit row or a log line by this function. The read writes nothing.
--
-- Performance: no new index (contracts E.5). Measured on 10,000 synthetic
-- Leads and 10,000 synthetic Deals in crm/tests/db/batch5-search.test.ts;
-- the results are recorded in the Atlas Batch 5 notes. A trigram index would
-- need the pg_trgm extension, a schema change that needs its own approval.
--
-- Rollback (forward-only): a new migration that revokes execute on
-- public.crm_search (the screens then show "not installed") or drops it.
--
-- Apply history: this file has run only on disposable local stacks. It was
-- amended in place on 23 October 2026 after the Echo-A Batch 5 review (L1:
-- no title search for digits-only or '@' queries; L2: the function pins
-- standard_conforming_strings = on so the backslash escapes always mean the
-- same), and again the same day after the recheck (phone-like queries such as
-- "+91 98765-43210" never search titles either), before any kept or live
-- database applied it.

begin;
set local lock_timeout = '15s';

create function public.crm_search(
  p_query text,
  p_kind text,
  p_after jsonb default null,
  p_limit integer default 20
) returns jsonb
language plpgsql stable security invoker
set search_path = ''
set standard_conforming_strings = on
as $$
declare
  v_limit integer := coalesce(p_limit, 20);
  v_q text;
  v_like text;
  v_num text;
  v_titles boolean;
  v_has_after boolean := false;
  v_after_n bigint;
  v_after_id uuid;
  v_rows jsonb;
  v_found integer;
  v_last jsonb;
begin
  if p_kind is null or p_kind not in ('lead', 'deal') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'kind';
  end if;
  if v_limit < 1 or v_limit > 50 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'limit';
  end if;

  -- Same steps as normaliseSearchQuery: collapse whitespace, trim, cut to 60
  -- characters (code points; left() and char_length() count characters, never
  -- bytes), trim again.
  v_q := btrim(left(btrim(regexp_replace(coalesce(p_query, ''), '\s+', ' ', 'g')), 60));
  if char_length(v_q) < 2 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'query';
  end if;
  v_like := replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_');
  v_num := case when v_q ~ '^[0-9]{1,19}$' then v_q end;
  -- Echo-A L1 and recheck: a query made only of digits and phone punctuation
  -- (a possible mobile number, also "+91 98765-43210" or "(0291) 2611") or
  -- one containing '@' (a possible e-mail) never searches titles.
  v_titles := char_length(v_q) >= 3
    and not (v_q ~ '^[0-9 +().-]+$' and v_q ~ '[0-9]')
    and strpos(v_q, '@') = 0;

  -- Keyset cursor: {n, id} exactly, checked before any cast.
  if p_after is not null and jsonb_typeof(p_after) <> 'null' then
    if jsonb_typeof(p_after) <> 'object' then
      raise exception 'invalid_input' using errcode = '22023', hint = 'after';
    end if;
    if exists (select 1 from jsonb_object_keys(p_after) k where k not in ('n', 'id'))
       or not (p_after ? 'n') or not (p_after ? 'id')
       or jsonb_typeof(p_after -> 'id') <> 'string'
       or (p_after ->> 'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or jsonb_typeof(p_after -> 'n') not in ('string', 'null') then
      raise exception 'invalid_input' using errcode = '22023', hint = 'after';
    end if;
    if jsonb_typeof(p_after -> 'n') = 'string' then
      if (p_after ->> 'n') !~ '^[1-9][0-9]{0,17}$' then
        raise exception 'invalid_input' using errcode = '22023', hint = 'after';
      end if;
      v_after_n := (p_after ->> 'n')::bigint;
    elsif p_kind = 'lead' then
      -- Every Lead has a Bitrix number; a null key cannot come from a Lead page.
      raise exception 'invalid_input' using errcode = '22023', hint = 'after';
    end if;
    v_after_id := (p_after ->> 'id')::uuid;
    v_has_after := true;
  end if;

  if p_kind = 'lead' then
    with m as (
      select l.id, l.reference, l.source_lead_id as n
      from public.crm_leads l
      where (
          l.reference ilike (v_like || '%') escape '\'
          or (v_num is not null and l.source_lead_id::text like (v_num || '%'))
          or (v_titles and l.title ilike ('%' || v_like || '%') escape '\')
        )
        and (
          not v_has_after
          or l.source_lead_id < v_after_n
          or (l.source_lead_id = v_after_n and l.id > v_after_id)
        )
      order by l.source_lead_id desc, l.id
      limit v_limit + 1
    )
    select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'reference', m.reference, 'n', m.n::text)
                              order by m.n desc, m.id), '[]'::jsonb),
           count(*)::integer
    into v_rows, v_found
    from m;
  else
    with m as (
      select d.id, d.reference, d.source_deal_id as n
      from public.deals d
      where d.removed_at is null
        and (
          d.reference ilike (v_like || '%') escape '\'
          or (v_num is not null and d.source_deal_id::text like (v_num || '%'))
          or (v_titles and d.title ilike ('%' || v_like || '%') escape '\')
        )
        and (
          not v_has_after
          or (v_after_n is not null and (
                d.source_deal_id < v_after_n
                or (d.source_deal_id = v_after_n and d.id > v_after_id)
                or d.source_deal_id is null))
          or (v_after_n is null and d.source_deal_id is null and d.id > v_after_id)
        )
      order by d.source_deal_id desc nulls last, d.id
      limit v_limit + 1
    )
    select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'reference', m.reference, 'n', m.n::text)
                              order by m.n desc nulls last, m.id), '[]'::jsonb),
           count(*)::integer
    into v_rows, v_found
    from m;
  end if;

  if v_found > v_limit then
    v_last := v_rows -> (v_limit - 1);
  end if;

  return jsonb_build_object(
    'kind', p_kind,
    'titlesSearched', v_titles,
    'hits', (
      select coalesce(jsonb_agg(jsonb_build_object('kind', p_kind, 'id', e ->> 'id', 'reference', e ->> 'reference')
                                order by o), '[]'::jsonb)
      from jsonb_array_elements(v_rows) with ordinality as t (e, o)
      where o <= v_limit
    ),
    'hasMore', v_found > v_limit,
    'next', case when v_last is null then null
                 else jsonb_build_object('n', v_last -> 'n', 'id', v_last -> 'id') end
  );
end;
$$;

comment on function public.crm_search(text, text, jsonb, integer) is
  'Batch 5 list search (contracts E). Security invoker: the caller''s row-level security decides every row. '
  'Reference / Bitrix number prefix from 2 characters, title contains from 3; one kind per call; keyset pages; '
  'never logs or stores the query.';

revoke all on function public.crm_search(text, text, jsonb, integer) from public, anon, authenticated, service_role;
grant execute on function public.crm_search(text, text, jsonb, integer) to authenticated;

commit;
