-- TripNavigate CRM - speed plan E1 (docs/implementation/current/speed-plan-2026-10-09.md).
--
-- public.accounts_queue evaluated two SECURITY DEFINER checks,
-- authz.can_accounts(entity) and authz.finance_gate_issue(entity, synthetic),
-- once for EVERY deal row before any cheaper filter. They cannot be inlined, so
-- the Accounts queue cost grew with the number of deals: about 550 ms with
-- 2 000 synthetic deals on a local stack (230 us + 57 us per deal).
--
-- Both checks depend only on (legal entity, is_synthetic) and the caller's
-- session, never on the deal itself. This replacement evaluates them once per
-- (entity, synthetic flag) pair in a materialized CTE and joins deals to the
-- allowed pairs. Rows, order, paging, cursor format, totalCount, errors and
-- grants are unchanged: deals.legal_entity_id always references a legal entity
-- (deals -> branches -> legal_entities) and deals.is_synthetic is NOT NULL, so
-- the join keeps exactly the deals the per-row checks kept.
--
-- Signature unchanged: CREATE OR REPLACE keeps the owner and the grants from
-- 20261103000100 (execute to authenticated only).
-- Rollback: re-run the accounts_queue definition from 20261103000100_cash_overview_repairs.sql.

create or replace function public.accounts_queue(p_filter text, p_after text default null, p_limit integer default 50)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_after_id uuid;
  v_after_ref text;
  v_result jsonb;
begin
  perform authz.finance_require_accounts_anywhere();
  if p_filter is null or p_filter not in ('all', 'needs_review', 'returned', 'awaiting_verification', 'cheques_pending') then
    perform authz.finance_invalid();
  end if;
  if p_after is not null then
    -- "<dealId>:<dealReference>" of the previous page's last item.
    if length(p_after) < 38 or substr(p_after, 37, 1) <> ':'
       or substr(p_after, 1, 36) !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      perform authz.finance_invalid();
    end if;
    v_after_id := substr(p_after, 1, 36)::uuid;
    v_after_ref := substr(p_after, 38);
  end if;

  with gate as materialized (
    -- The caller's Accounts access and the finance gate, once per entity and
    -- synthetic flag instead of once per deal.
    select e.id as legal_entity_id, s.is_synthetic
    from public.legal_entities e
    cross join (values (true), (false)) as s(is_synthetic)
    where authz.can_accounts(e.id)
      and authz.finance_gate_issue(e.id, s.is_synthetic) is null
  ), matched as (
    select d.id, d.reference
    from public.deals d
    join gate g on g.legal_entity_id = d.legal_entity_id and g.is_synthetic = d.is_synthetic
    left join public.booking_versions v on v.deal_id = d.id and v.status = 'confirmed'
    left join public.accounts_booking_reviews rv on rv.booking_version_id = v.id
    where (v.id is not null or exists (select 1 from public.customer_receipts r where r.deal_id = d.id))
      and case p_filter
        when 'all' then true
        when 'needs_review' then v.id is not null and coalesce(rv.status, 'pending') = 'pending'
        when 'returned' then rv.status is not distinct from 'returned'
        when 'awaiting_verification' then exists (
          select 1 from public.customer_receipts r where r.deal_id = d.id and r.status = 'recorded')
        else exists (
          select 1 from public.customer_receipts r
          where r.deal_id = d.id and r.mode = 'cheque' and r.status in ('recorded', 'pending_clearance'))
      end
  ), page as (
    -- One extra row tells whether another page exists.
    select m.id, m.reference, row_number() over (order by m.reference, m.id) as n
    from (select m.id, m.reference from matched m
          where v_after_id is null or (m.reference, m.id) > (v_after_ref, v_after_id)
          order by m.reference, m.id
          limit v_limit + 1) m
  )
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(authz.finance_queue_item_json(p.id) order by p.n) from page p where p.n <= v_limit),
                      '[]'::jsonb),
    'hasMore', exists (select 1 from page p where p.n > v_limit),
    'nextAfter', case when exists (select 1 from page p where p.n > v_limit)
      then (select p.id::text || ':' || p.reference from page p where p.n = v_limit) end,
    'totalCount', (select count(*) from matched))
  into v_result;
  return v_result;
end;
$$;
