-- TripNavigate CRM - Accounts phase 3, track C (fix): the Tally company name
-- in the reads (lead, 13 Nov 2026; additive only).
-- Replaces public.accounts_tally_file_preview (20261205000310, same
-- signature): + companyName (the entity's saved Tally company, null when not
-- set). Replaces public.accounts_tally_exports (20261205000310, same
-- signature): entities[] + companyName; items[] + companyName (frozen with an
-- XML file, null for CSV exports).
-- Refusal tokens: unchanged. Rollback (forward-only): a NEW migration
-- restoring the 20261205000310 bodies.

begin;
set local lock_timeout = '15s';

create or replace function public.accounts_tally_file_preview(p_entity uuid, p_from date, p_to date, p_kinds text[], p_branch_ids uuid[])
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  a record;
  v_out jsonb;
  c_limit constant integer := 200;
begin
  if p_entity is null or not coalesce(authz.session_ok(), false) or not (p_entity = any(authz.acct_a_entities())) then
    return null;
  end if;
  select * into a from authz.tally_file_args(p_entity, p_from, p_to, p_kinds, p_branch_ids) x;
  with c as materialized (
    select * from authz.tally_file_candidates(p_entity, p_from, p_to, a.kinds, a.branches, false, authz.acct_synthetic())
  ),
  n as (select count(*) filter (where c.verdict = 'line')::int as lines, count(*) filter (where c.verdict <> 'line')::int as left_out from c)
  select jsonb_build_object(
    'lines', coalesce((select jsonb_agg(jsonb_build_object('recordKind', l.kind, 'recordId', l.record_id, 'reference', l.reference,
        'dealReference', l.deal_ref, 'voucherType', l.voucher_type, 'date', to_char(l.rec_date, 'YYYY-MM-DD'),
        'amountPaise', l.amount_paise::text) order by l.rec_date, l.kind, l.record_id)
      from (select * from c where c.verdict = 'line' order by c.rec_date, c.kind, c.record_id limit c_limit) l), '[]'::jsonb),
    'leftOut', coalesce((select jsonb_agg(jsonb_build_object('recordKind', l.kind, 'recordId', l.record_id, 'reference', l.reference,
        'reason', l.verdict, 'detail', l.detail) order by l.kind, l.record_id)
      from (select * from c where c.verdict <> 'line' order by c.kind, c.record_id limit c_limit) l), '[]'::jsonb),
    'counts', jsonb_build_object('lines', n.lines, 'leftOut', n.left_out,
      'byReason', coalesce((select jsonb_object_agg(r.verdict, r.cnt) from (
        select c.verdict, count(*)::int as cnt from c where c.verdict <> 'line' group by c.verdict) r), '{}'::jsonb)),
    'truncated', n.lines > c_limit or n.left_out > c_limit,
    -- Accounts phase 3 (20261205000340): the Tally company the file would be made for (null: not set).
    'companyName', (select s.tally_company_name from public.accounts_settings s where s.legal_entity_id = p_entity))
  into v_out
  from n;
  return v_out;
end;
$$;

create or replace function public.accounts_tally_exports(p_limit integer default 50) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_a uuid[];
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
begin
  if not coalesce(authz.session_ok(), false) then
    return null;
  end if;
  v_a := authz.acct_a_entities();
  if cardinality(v_a) = 0 then
    return null;
  end if;
  return jsonb_build_object(
    'entities', coalesce((select jsonb_agg(jsonb_build_object('entityId', e.id, 'name', e.legal_name,
        'exportEnabled', coalesce(s.tally_export_enabled, false),
        'branches', coalesce((select jsonb_agg(jsonb_build_object('branchId', b.id, 'name', b.name) order by b.name)
                              from public.branches b where b.legal_entity_id = e.id and b.status = 'enabled'), '[]'::jsonb),
        'mappingMissingCount', (select count(*)::int from public.tally_ledger_mappings m
                                where m.legal_entity_id = e.id
                                  and authz.tally_mapping_missing(m.debit_ledger, m.credit_ledger, m.voucher_type)),
        -- Accounts phase 3 (20261205000310)
        'xmlEnabled', coalesce(s.tally_xml_enabled, false),
        -- Accounts phase 3 (20261205000340)
        'companyName', s.tally_company_name)
        order by e.legal_name)
      from public.legal_entities e left join public.accounts_settings s on s.legal_entity_id = e.id
      where e.id = any(v_a)), '[]'::jsonb),
    'items', coalesce((select jsonb_agg(authz.tally_export_json(x.id) || jsonb_build_object(
          -- Accounts phase 3 (20261205000310)
          'format', x.format,
          'leftOutCount', (select count(*)::int from public.tally_export_left_out o where o.export_id = x.id),
          'includeReason', x.include_reason,
          -- Accounts phase 3 (20261205000340): the company frozen with an XML file (null for CSV exports).
          'companyName', x.company_name)
        || case when x.format = 'xml' then jsonb_build_object('fileName', x.export_no || '.xml') else '{}'::jsonb end
        order by x.created_at desc, x.id)
                       from (select t.id, t.created_at, t.format, t.include_reason, t.export_no, t.company_name from public.tally_exports t
                             where t.legal_entity_id = any(v_a)
                             order by t.created_at desc, t.id limit v_limit) x), '[]'::jsonb));
end;
$$;

commit;
