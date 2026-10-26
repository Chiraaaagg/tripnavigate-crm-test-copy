-- TripNavigate CRM - B1.2 Phase E: quotation money (Mercury).
--
-- Contract: docs/implementation/frontend-first-plan-2026-10-10/b1.2/
--   b1.2-freeze-note-part-2.md sections 1 and 3 (FROZEN 12 Oct 2026); owner
--   decisions DEC-33 (units), DEC-34 (typed total, no GST), DEC-35 (editors,
--   acceptance); mercury-quotation-money-proposal.md where the freeze is silent.
-- Depends on 20261120000200_b12_quotations.sql (Atlas): quotation tables,
--   authz.lock_quotation_draft, authz.bump_quotation_version,
--   authz.quotation_can_edit, authz.quotation_conversion_item_map and the
--   stubs replaced here (same names and parameter names).
--
-- What changes (additive):
--   * quotation_version_lines: commercial lines. Selling price per unit in
--     whole rupees, our estimated supplier cost per unit in paise (internal),
--     staff-typed quantities. No age bands, no tax column.
--   * quotation_version_tier_money: the quoted total typed by Sales per tier
--     (quoted, upgrade). The component sum is a comparison only (DEC-34).
--   * quotation_version_instalments: optional payment plan per tier; it must
--     add up to the tier's typed total before the version is marked ready.
--   * Commands: quotation_lines_save, quotation_total_save,
--     quotation_plan_save, quotation_cost_estimates_save.
--   * Atlas stubs replaced: authz.quotation_money_check,
--     authz.quotation_money_hash, authz.quotation_money_json,
--     authz.quotation_copy_lines, authz.quotation_money_to_booking,
--     authz.quotation_money_can_read, authz.quotation_money_can_edit.
--   * New read for the document adapters (Phase F): public
--     quotation_customer_money (selling side only, no cost; money readers
--     only) over authz.quotation_customer_money_json.
--
-- Rules (freeze note section 3):
--   * Whole paise; every customer-visible amount is a whole rupee; nothing is
--     rounded. Cost estimates may hold paise.
--   * Units: hotel room_night, cab trip, flight/visa/passport line_total,
--     activity line_total or person; night/person otherwise only on extra-bed,
--     child-without-bed and other charge lines. Quantities are stored exactly
--     as typed; never derived from stay counts.
--   * The typed total wins; a different component sum is the warning
--     component_mismatch, never a refusal and never an adjustment.
--   * Per-person price only when the total divides exactly, in whole rupees,
--     by the paying travellers (adults + children with and without a bed).
--   * No GST/TCS anywhere. Conversion fills the selling total, the plan and the
--     purchase budgets; never list price or discount.
--   * Money is read and edited only by quotation editors who also hold
--     deal.read_commercial and no Purchase role (Sales owner/assignee, branch
--     Manager with commercial scope). Accounts, Flight, the desk and Super
--     Admin: none in B1.2.
--   * The money hash covers lines, typed totals and plans; never cost or
--     remarks. Cost estimates may be refreshed after sending (not hashed).
--   * Nothing here writes a finance table except the booking draft's
--     commercials, plan and purchase budgets during conversion.
--
-- Refusal tokens (message is exactly the token): existing invalid_input
-- (22023, hint names the field), not_authorized (42501), version_changed
-- (40001), wrong_state (55000), deal_removed (55000). New:
--   22023 internal_wording   (hint names the field)
--
-- Rollback (forward-only): the quotation switch (Atlas) off. Emergency: a NEW
-- migration revoking execute on the four commands. Rows are kept.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Tables
-- ===========================================================================

create table public.quotation_version_lines (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null,
  quotation_version_id uuid not null,
  line_no integer not null check (line_no between 1 and 60),
  option_key text not null check (option_key in ('common', 'quoted', 'upgrade')),
  item_id uuid,
  charge_kind text not null default 'main' check (charge_kind in ('main', 'extra_bed', 'child_no_bed', 'other')),
  category_key text not null check (category_key in ('flights', 'hotels', 'transfers', 'tours', 'visas', 'insurance', 'other')),
  description text not null check (length(description) between 1 and 200 and description !~ E'[\\x01-\\x1f\\x7f]'),
  unit_kind text not null check (unit_kind in ('room_night', 'trip', 'line_total', 'night', 'person')),
  units integer not null check (units between 1 and 999),
  periods integer not null check (periods between 1 and 366),
  unit_sell_paise bigint not null check (unit_sell_paise between 0 and 9999999999900 and unit_sell_paise % 100 = 0),
  unit_cost_paise bigint check (unit_cost_paise between 0 and 9999999999999),
  -- Exact products; the bounds keep them far below the bigint limit.
  line_sell_paise bigint generated always as (unit_sell_paise * units * periods) stored,
  line_cost_paise bigint generated always as (unit_cost_paise * units * periods) stored,
  remark text check (remark is null or (length(remark) between 1 and 300 and remark !~ E'[\\x01-\\x1f\\x7f]')),
  created_by uuid not null references public.staff_profiles (user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (legal_entity_id, quotation_version_id) references public.quotation_versions (legal_entity_id, id),
  -- Removing a service item from a draft removes the lines that price it.
  foreign key (legal_entity_id, quotation_version_id, item_id)
    references public.quotation_version_items (legal_entity_id, quotation_version_id, id) on delete cascade,
  unique (quotation_version_id, line_no),
  check (unit_kind <> 'line_total' or (units = 1 and periods = 1)),
  check (unit_kind <> 'person' or periods = 1),
  check (charge_kind not in ('extra_bed', 'child_no_bed') or (unit_kind in ('night', 'person', 'line_total') and item_id is not null))
);
comment on table public.quotation_version_lines is
  'Commercial lines of one quotation version: customer selling price per unit (whole rupees) and our estimated supplier cost per unit (internal). Quantities are staff-typed (DEC-33). Commercial quotation editors only; never Purchase, Flight, the desk, Accounts or Super Admin. No tax.';

create table public.quotation_version_tier_money (
  quotation_version_id uuid not null,
  legal_entity_id uuid not null,
  tier_key text not null check (tier_key in ('quoted', 'upgrade')),
  quoted_total_paise bigint not null check (quoted_total_paise between 100 and 9999999999999900 and quoted_total_paise % 100 = 0),
  show_per_person boolean not null default true,
  updated_by uuid not null references public.staff_profiles (user_id),
  updated_at timestamptz not null default now(),
  primary key (quotation_version_id, tier_key),
  foreign key (legal_entity_id, quotation_version_id) references public.quotation_versions (legal_entity_id, id)
);
comment on table public.quotation_version_tier_money is
  'Quoted total typed by Sales for one tier of a quotation version (DEC-34). The component selling sum is shown as a comparison only. Whole rupees; no tax.';

create table public.quotation_version_instalments (
  id uuid primary key default gen_random_uuid(),
  quotation_version_id uuid not null,
  legal_entity_id uuid not null,
  tier_key text not null check (tier_key in ('quoted', 'upgrade')),
  seq integer not null check (seq between 1 and 12),
  label text not null check (length(label) between 1 and 60 and label !~ E'[\\x01-\\x1f\\x7f]'),
  amount_paise bigint not null check (amount_paise between 100 and 999999999999900 and amount_paise % 100 = 0),
  due_rule text not null check (due_rule in ('on_acceptance', 'days_before_start', 'fixed_date')),
  due_days integer check (due_days between 1 and 365),
  due_date date check (due_date between date '2000-01-01' and date '2100-12-31'),
  created_at timestamptz not null default now(),
  foreign key (legal_entity_id, quotation_version_id) references public.quotation_versions (legal_entity_id, id),
  unique (quotation_version_id, tier_key, seq),
  check ((due_rule = 'days_before_start') = (due_days is not null)),
  check ((due_rule = 'fixed_date') = (due_date is not null))
);
comment on table public.quotation_version_instalments is
  'Optional customer payment schedule of one tier of a quotation version (same limits as booking_version_instalments). Adds up to the tier''s typed total before the version is marked ready. Commercial quotation editors only.';

create index quotation_version_lines_version_idx on public.quotation_version_lines (legal_entity_id, quotation_version_id);
create index quotation_version_lines_item_idx on public.quotation_version_lines (legal_entity_id, quotation_version_id, item_id)
  where item_id is not null;
create index quotation_version_lines_created_by_idx on public.quotation_version_lines (created_by);
create index quotation_version_tier_money_entity_idx on public.quotation_version_tier_money (legal_entity_id, quotation_version_id);
create index quotation_version_tier_money_updated_by_idx on public.quotation_version_tier_money (updated_by);
create index quotation_version_instalments_entity_idx on public.quotation_version_instalments (legal_entity_id, quotation_version_id);

-- ===========================================================================
-- 2. Guard: money rows change only while the version is a draft
-- ===========================================================================

-- One exception: the internal cost estimate of a line on a ready, sent or
-- accepted version that was not converted (freeze note section 3), and only
-- inside quotation_cost_estimates_save (transaction-local session marker).
-- Security invoker (Echo E3-3): only table owners and definer commands write
-- these tables, and they can read the parent rows the guard checks.
create function authz.quotation_rows_guard() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare
  v_ids uuid[] := array_remove(array[
    case when tg_op = 'INSERT' then null else old.quotation_version_id end,
    case when tg_op = 'DELETE' then null else new.quotation_version_id end], null);
  v_cost_only boolean := false;
begin
  if tg_op = 'UPDATE' and new.quotation_version_id is distinct from old.quotation_version_id then
    raise exception '% identity columns are immutable', tg_table_name using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and tg_table_name = 'quotation_version_lines' then
    -- Generated columns are not computed yet in a BEFORE trigger: compare without them.
    v_cost_only := (to_jsonb(new) - array['unit_cost_paise', 'line_cost_paise', 'line_sell_paise', 'updated_at'])
                   = (to_jsonb(old) - array['unit_cost_paise', 'line_cost_paise', 'line_sell_paise', 'updated_at']);
  end if;
  if exists (select 1 from public.quotation_versions v where v.id = any (v_ids) and v.status <> 'draft') then
    if not (v_cost_only
            and coalesce(current_setting('tripnavigate.quotation_cost_refresh', true), '') = new.quotation_version_id::text
            and exists (select 1 from public.quotation_versions v
                        where v.id = new.quotation_version_id and v.status in ('ready', 'sent', 'accepted'))
            and not exists (select 1 from public.quotation_conversions c where c.quotation_version_id = new.quotation_version_id)) then
      raise exception '% rows of a quotation version that is not a draft are immutable', tg_table_name using errcode = '42501';
    end if;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger quotation_version_lines_a_guard
  before insert or update or delete on public.quotation_version_lines
  for each row execute function authz.quotation_rows_guard();
create trigger quotation_version_tier_money_a_guard
  before insert or update or delete on public.quotation_version_tier_money
  for each row execute function authz.quotation_rows_guard();
create trigger quotation_version_instalments_a_guard
  before insert or update or delete on public.quotation_version_instalments
  for each row execute function authz.quotation_rows_guard();

-- ===========================================================================
-- 3. RLS and grants: no Data API access at all (definer reads only)
-- ===========================================================================

alter table public.quotation_version_lines enable row level security;
alter table public.quotation_version_tier_money enable row level security;
alter table public.quotation_version_instalments enable row level security;
create policy require_valid_session on public.quotation_version_lines as restrictive for all to authenticated
  using ((select authz.session_valid())) with check ((select authz.session_valid()));
create policy require_valid_session on public.quotation_version_tier_money as restrictive for all to authenticated
  using ((select authz.session_valid())) with check ((select authz.session_valid()));
create policy require_valid_session on public.quotation_version_instalments as restrictive for all to authenticated
  using ((select authz.session_valid())) with check ((select authz.session_valid()));
revoke all on public.quotation_version_lines, public.quotation_version_tier_money, public.quotation_version_instalments
  from public, anon, authenticated, service_role;

-- ===========================================================================
-- 4. Pure helpers
-- ===========================================================================

-- Customer text never carries internal rate words or pushy sales words (the
-- owner's quotation engine lists; whole phrase, case-insensitive). Words that
-- the scope guard forbids as SQL literals (agent-portal concepts) are left out
-- here; the full list runs in TypeScript (documents safety words) at save time
-- and on the rendered page.
create function authz.quotation_wording_ok(p_text text) returns boolean
language sql immutable set search_path = '' as $$
  select p_text is null or not exists (
    select 1 from unnest(array[
      'net rate', 'net cost', 'net price', 'supplier rate', 'markup', 'mark-up', 'margin',
      'profit', 'cost price', 'buying price', 'tariff sheet',
      'internal cost', 'internal rate', 'internal note', 'sales note',
      'discount ceiling',
      'best price', 'price guarantee', 'guaranteed lowest', 'hurry', 'book immediately',
      'cheapest', 'give us a chance', 'huge discount', 'unbeatable', 'limited offer',
      'best possible rate', 'special deal only for you', 'act now', 'don''t miss',
      'lowest price', 'once in a lifetime offer', 'last chance']) w
    where lower(p_text) ~ ('(^|[^a-z0-9])' || replace(w, '-', '\-') || '($|[^a-z0-9])'))
$$;

-- Paise from a JSON string or number of digits (no sign, no fraction); null
-- when not valid.
create function authz.quotation_paise(p_value jsonb) returns bigint
language sql immutable set search_path = '' as $$
  select case when p_value is not null and jsonb_typeof(p_value) in ('string', 'number')
               and (p_value #>> '{}') ~ '^(0|[1-9][0-9]{0,15})$'
              then (p_value #>> '{}')::bigint end
$$;

-- Units allowed for a line (DEC-33). p_service_type is null for a line that
-- prices no service item.
create function authz.quotation_unit_allowed(p_service_type text, p_charge_kind text, p_unit_kind text) returns boolean
language sql immutable set search_path = '' as $$
  select case
    when p_charge_kind in ('extra_bed', 'child_no_bed')
      then p_service_type = 'hotel' and p_unit_kind in ('night', 'person', 'line_total')
    when p_charge_kind = 'other' then p_unit_kind in ('night', 'person', 'line_total')
    when p_service_type = 'hotel' then p_unit_kind = 'room_night'
    when p_service_type = 'transfer' then p_unit_kind = 'trip'
    when p_service_type in ('flight', 'visa', 'passport') then p_unit_kind = 'line_total'
    when p_service_type = 'activity' then p_unit_kind in ('person', 'line_total')
    when p_service_type is null then p_unit_kind = 'line_total'
    else false end
$$;

-- ===========================================================================
-- 5. Access predicates (replace Atlas's stubs; same names and parameters)
-- ===========================================================================

-- Quotation editors who also may see commercial values: no Purchase role in
-- the entity, and deal.read_commercial as for the Deal (Deal quotation, or a
-- Lead quotation linked to a Deal) or, for a Lead quotation, as the Lead's
-- owner (own scope), entity scope or a branch grant (same shape as
-- authz.can_read_deal_commercial).
create or replace function authz.quotation_money_can_read(p_quotation uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select authz.quotation_can_edit(q.id)
       and not authz.holds_role('purchase', q.legal_entity_id)
       and (case when q.deal_id is not null then authz.can_read_deal_commercial(q.deal_id)
                 else (l.owner_user_id = (select auth.uid())
                         and authz.has_role_permission('deal.read_commercial', q.legal_entity_id, 'own'))
                   or authz.has_role_permission('deal.read_commercial', q.legal_entity_id, 'entity')
                   or authz.has_grant('deal.read_commercial', q.legal_entity_id, q.branch_id) end
            or (q.linked_deal_id is not null and authz.can_read_deal_commercial(q.linked_deal_id)))
    from public.quotations q
    left join public.crm_leads l on l.id = q.lead_id
    where q.id = p_quotation), false)
$$;

-- Editing money needs the same right (the draft state is checked by
-- authz.lock_quotation_draft).
create or replace function authz.quotation_money_can_edit(p_quotation uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select authz.quotation_money_can_read(p_quotation)
$$;

-- ===========================================================================
-- 6. Figures, checks and hash
-- ===========================================================================

-- Paying travellers (engine rule: adults + children with and without a bed;
-- infants are not counted). No age bands (DEC-33).
create function authz.quotation_paying_travellers(p_version uuid) returns integer
language sql stable security definer set search_path = '' as $$
  select coalesce(v.adults, 0) + coalesce(v.children_with_bed, 0) + coalesce(v.children_no_bed, 0)
  from public.quotation_versions v where v.id = p_version
$$;

-- Tiers that carry money on a version: quoted always; upgrade when the
-- version has an upgrade tier label, upgrade lines, an upgrade total or an
-- upgrade plan.
create function authz.quotation_tier_keys(p_version uuid) returns text[]
language sql stable security definer set search_path = '' as $$
  select array['quoted'] || case when exists (select 1 from public.quotation_version_tiers t
                                              where t.quotation_version_id = p_version and t.tier_key = 'upgrade')
                                   or exists (select 1 from public.quotation_version_lines l
                                              where l.quotation_version_id = p_version and l.option_key = 'upgrade')
                                   or exists (select 1 from public.quotation_version_tier_money m
                                              where m.quotation_version_id = p_version and m.tier_key = 'upgrade')
                                   or exists (select 1 from public.quotation_version_instalments i
                                              where i.quotation_version_id = p_version and i.tier_key = 'upgrade')
                                 then array['upgrade'] else '{}'::text[] end
$$;

-- Money figures of one tier (internal; commercial readers only). Amounts are
-- decimal strings of paise. differencePaise = typed total - component sum.
create function authz.quotation_tier_figures(p_version uuid, p_tier text) returns jsonb
language sql stable security definer set search_path = '' as $$
  with l as (
    select coalesce(sum(x.line_sell_paise), 0) as sell,
           case when bool_and(x.line_cost_paise is not null) then sum(x.line_cost_paise) end as cost,
           count(*) as n
    from public.quotation_version_lines x
    where x.quotation_version_id = p_version and x.option_key in ('common', p_tier)
  ), m as (
    select t.quoted_total_paise, t.show_per_person from public.quotation_version_tier_money t
    where t.quotation_version_id = p_version and t.tier_key = p_tier
  ), p as (select coalesce(authz.quotation_paying_travellers(p_version), 0) as pax)
  select jsonb_build_object(
    'tierKey', p_tier,
    'label', (select t.label from public.quotation_version_tiers t
              where t.quotation_version_id = p_version and t.tier_key = p_tier),
    'quotedTotalPaise', (select m.quoted_total_paise::text from m),
    'showPerPerson', coalesce((select m.show_per_person from m), true),
    'lineCount', l.n,
    'componentSellPaise', l.sell::text,
    'differencePaise', (select (m.quoted_total_paise - l.sell)::text from m),
    'costTotalPaise', l.cost::text,
    'costComplete', l.n > 0 and l.cost is not null,
    'marginPaise', (select (m.quoted_total_paise - l.cost)::text from m where l.n > 0 and l.cost is not null),
    'payingTravellers', p.pax,
    'perPersonPaise', (select (m.quoted_total_paise / p.pax)::text from m
                       where p.pax > 0 and m.quoted_total_paise % (p.pax::bigint * 100) = 0),
    'planTotalPaise', (select sum(i.amount_paise)::text from public.quotation_version_instalments i
                       where i.quotation_version_id = p_version and i.tier_key = p_tier),
    'planCount', (select count(*) from public.quotation_version_instalments i
                  where i.quotation_version_id = p_version and i.tier_key = p_tier))
  from l cross join p
$$;

-- Money codes of a version. Blocking codes and the warnings Atlas never
-- blocks on (component_mismatch, cost_incomplete, margin_negative,
-- extra_bed_not_priced, child_no_bed_not_priced, per_person_not_exact).
create or replace function authz.quotation_money_check(p_version uuid) returns text[]
language sql stable security definer set search_path = '' as $$
  with v as (select * from public.quotation_versions where id = p_version),
  tiers as (select unnest(authz.quotation_tier_keys(p_version)) as tier_key),
  f as (select t.tier_key, authz.quotation_tier_figures(p_version, t.tier_key) as j from tiers t)
  select array_remove(array[
    -- Blocking.
    case when not exists (select 1 from public.quotation_version_lines l
                          where l.quotation_version_id = p_version and l.option_key in ('common', 'quoted'))
      then 'lines_missing' end,
    case when not exists (select 1 from public.quotation_version_tier_money m
                          where m.quotation_version_id = p_version and m.tier_key = 'quoted')
      then 'quoted_total_missing' end,
    case when 'upgrade' = any (authz.quotation_tier_keys(p_version))
          and not exists (select 1 from public.quotation_version_tier_money m
                          where m.quotation_version_id = p_version and m.tier_key = 'upgrade')
      then 'upgrade_total_missing' end,
    case when 'upgrade' = any (authz.quotation_tier_keys(p_version))
          and not exists (select 1 from public.quotation_version_tiers t
                          where t.quotation_version_id = p_version and t.tier_key = 'upgrade')
      then 'upgrade_tier_missing' end,
    case when exists (select 1 from f where (f.j ->> 'planCount')::integer > 0
                        and (f.j ->> 'planTotalPaise') is distinct from (f.j ->> 'quotedTotalPaise'))
      then 'plan_total_mismatch' end,
    case when exists (
      select 1 from public.quotation_version_instalments i cross join v
      where i.quotation_version_id = p_version
        and ((i.due_rule = 'fixed_date' and i.due_date < authz.finance_today())
          or (i.due_rule = 'days_before_start'
              and (v.trip_start is null or v.trip_start - i.due_days < authz.finance_today()))))
      then 'plan_due_invalid' end,
    case when coalesce(authz.quotation_paying_travellers(p_version), 0) < 1 then 'traveller_count_missing' end,
    case when exists (
      select 1 from public.quotation_version_lines l
      left join public.quotation_version_items i on i.id = l.item_id
      where l.quotation_version_id = p_version
        and not authz.quotation_unit_allowed(i.service_type, l.charge_kind, l.unit_kind))
      then 'unit_not_allowed' end,
    case when exists (
      select 1 from public.quotation_version_lines l
      join public.quotation_version_items i on i.id = l.item_id
      where l.quotation_version_id = p_version and i.tier_key is not null and l.option_key <> i.tier_key)
      then 'line_tier_mismatch' end,
    -- Warnings (never block).
    case when exists (select 1 from f where f.j ->> 'differencePaise' is not null and (f.j ->> 'differencePaise')::bigint <> 0)
      then 'component_mismatch' end,
    case when exists (select 1 from f where (f.j ->> 'lineCount')::integer > 0 and not (f.j ->> 'costComplete')::boolean)
      then 'cost_incomplete' end,
    case when exists (select 1 from f where f.j ->> 'marginPaise' is not null and (f.j ->> 'marginPaise')::bigint < 0)
      then 'margin_negative' end,
    case when exists (select 1 from f where f.j ->> 'quotedTotalPaise' is not null and (f.j ->> 'showPerPerson')::boolean
                        and f.j ->> 'perPersonPaise' is null)
      then 'per_person_not_exact' end,
    case when exists (
      select 1 from public.quotation_version_items i
      where i.quotation_version_id = p_version and i.service_type = 'hotel'
        and (i.facts ->> 'extraBeds') ~ '^[1-9][0-9]*$'
        and not exists (select 1 from public.quotation_version_lines l
                        where l.quotation_version_id = p_version and l.item_id = i.id and l.charge_kind = 'extra_bed'))
      then 'extra_bed_not_priced' end,
    case when exists (
      select 1 from public.quotation_version_items i
      where i.quotation_version_id = p_version and i.service_type = 'hotel'
        and (i.facts ->> 'childrenWithoutBed') ~ '^[1-9][0-9]*$'
        and not exists (select 1 from public.quotation_version_lines l
                        where l.quotation_version_id = p_version and l.item_id = i.id and l.charge_kind = 'child_no_bed'))
      then 'child_no_bed_not_priced' end
  ], null)
$$;

-- Customer money part of the version's content hash: lines (item by item_no,
-- which survives copying), typed totals and plans. Never cost or remarks.
create or replace function authz.quotation_money_hash(p_version uuid) returns text
language sql stable security definer set search_path = '' as $$
  select encode(sha256(convert_to(jsonb_build_array(
    coalesce((select jsonb_agg(jsonb_build_array(l.line_no, l.option_key, i.item_no, l.charge_kind, l.category_key,
                                                 l.description, l.unit_kind, l.units, l.periods, l.unit_sell_paise::text)
                               order by l.line_no)
              from public.quotation_version_lines l
              left join public.quotation_version_items i on i.id = l.item_id
              where l.quotation_version_id = p_version), '[]'::jsonb),
    coalesce((select jsonb_agg(jsonb_build_array(m.tier_key, m.quoted_total_paise::text, m.show_per_person) order by m.tier_key)
              from public.quotation_version_tier_money m where m.quotation_version_id = p_version), '[]'::jsonb),
    coalesce((select jsonb_agg(jsonb_build_array(p.tier_key, p.seq, p.label, p.amount_paise::text, p.due_rule,
                                                 p.due_days, p.due_date::text) order by p.tier_key, p.seq)
              from public.quotation_version_instalments p where p.quotation_version_id = p_version), '[]'::jsonb)
  )::text, 'UTF8')), 'hex')
$$;

-- ===========================================================================
-- 7. Reads
-- ===========================================================================

-- Full money view for the editor (quotation_get.money). Null for anyone who
-- may not read quotation money (Atlas gates too).
create or replace function authz.quotation_money_json(p_version uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when authz.quotation_money_can_read(v.quotation_id) then jsonb_build_object(
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
        'lineNo', l.line_no, 'optionKey', l.option_key, 'itemId', l.item_id, 'itemNo', i.item_no,
        'chargeKind', l.charge_kind, 'categoryKey', l.category_key, 'description', l.description,
        'unitKind', l.unit_kind, 'units', l.units, 'periods', l.periods, 'quantity', l.units * l.periods,
        'unitSellPaise', l.unit_sell_paise::text, 'lineSellPaise', l.line_sell_paise::text,
        'unitCostPaise', l.unit_cost_paise::text, 'lineCostPaise', l.line_cost_paise::text,
        'remark', l.remark) order by l.line_no)
      from public.quotation_version_lines l
      left join public.quotation_version_items i on i.id = l.item_id
      where l.quotation_version_id = v.id), '[]'::jsonb),
    'tiers', (select jsonb_agg(authz.quotation_tier_figures(v.id, t) order by t)
              from unnest(authz.quotation_tier_keys(v.id)) t),
    'instalments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'tierKey', p.tier_key, 'seq', p.seq, 'label', p.label, 'amountPaise', p.amount_paise::text,
        'dueRule', p.due_rule, 'dueDays', p.due_days, 'dueDate', p.due_date) order by p.tier_key, p.seq)
      from public.quotation_version_instalments p where p.quotation_version_id = v.id), '[]'::jsonb),
    'codes', to_jsonb(authz.quotation_money_check(v.id)),
    'costRefreshAllowed', v.status in ('draft', 'ready', 'sent', 'accepted')
      and not exists (select 1 from public.quotation_conversions c where c.quotation_version_id = v.id))
  end
  from public.quotation_versions v where v.id = p_version
$$;

-- Selling side for the customer document adapters (Phase F). No cost,
-- margin, remark or difference amount. Breakdown amounts only when the
-- component sum equals the typed total; per-person only when exact.
create function authz.quotation_customer_money_json(p_version uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'tiers', (
      select jsonb_agg(jsonb_build_object(
        'tierKey', t, 'label', f.j ->> 'label',
        'quotedTotalPaise', f.j ->> 'quotedTotalPaise',
        'payingTravellers', (f.j ->> 'payingTravellers')::integer,
        'perPersonPaise', case when (f.j ->> 'showPerPerson')::boolean then f.j ->> 'perPersonPaise' end,
        'breakdownHasAmounts', (f.j ->> 'differencePaise') = '0',
        'breakdown', coalesce((
          select jsonb_agg(jsonb_build_object(
            'categoryKey', c.category_key,
            'descriptions', c.descriptions,
            'amountPaise', case when (f.j ->> 'differencePaise') = '0' then c.sell::text end) order by c.first_line)
          from (select l.category_key, min(l.line_no) as first_line, sum(l.line_sell_paise) as sell,
                       jsonb_agg(l.description order by l.line_no) as descriptions
                from public.quotation_version_lines l
                where l.quotation_version_id = p_version and l.option_key in ('common', t)
                group by l.category_key) c), '[]'::jsonb),
        'plan', coalesce((
          select jsonb_agg(jsonb_build_object('seq', p.seq, 'label', p.label, 'amountPaise', p.amount_paise::text,
                                              'dueRule', p.due_rule, 'dueDays', p.due_days, 'dueDate', p.due_date)
                           order by p.seq)
          from public.quotation_version_instalments p
          where p.quotation_version_id = p_version and p.tier_key = t), '[]'::jsonb)) order by t)
      from unnest(authz.quotation_tier_keys(p_version)) t
      cross join lateral (select authz.quotation_tier_figures(p_version, t) as j) f))
$$;

-- Public read of the customer side for the document adapters (Phase F):
-- null for anyone who may not read quotation money (Purchase, Flight, the
-- desk, Accounts, Super Admin, other Sales) and for an unknown version.
-- Read only; no audit row.
create function public.quotation_customer_money(p_version_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_quotation uuid;
begin
  if not authz.session_ok() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select v.quotation_id into v_quotation from public.quotation_versions v where v.id = p_version_id;
  if v_quotation is null or not authz.quotation_money_can_read(v_quotation) then
    return null;
  end if;
  return authz.quotation_customer_money_json(p_version_id);
end;
$$;

-- ===========================================================================
-- 8. Copy and conversion (called inside Atlas's commands)
-- ===========================================================================

-- quotation_new_version: Atlas copied the items with the same item_no; lines
-- point to the target item with the same item_no. The target is a new draft.
create or replace function authz.quotation_copy_lines(p_from_version uuid, p_to_version uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_to public.quotation_versions%rowtype;
begin
  select * into v_to from public.quotation_versions v where v.id = p_to_version;
  if v_to.id is null or v_to.status <> 'draft' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  insert into public.quotation_version_lines (legal_entity_id, quotation_version_id, line_no, option_key, item_id,
    charge_kind, category_key, description, unit_kind, units, periods, unit_sell_paise, unit_cost_paise, remark, created_by)
  select v_to.legal_entity_id, v_to.id, l.line_no, l.option_key, ti.id, l.charge_kind, l.category_key, l.description,
    l.unit_kind, l.units, l.periods, l.unit_sell_paise, l.unit_cost_paise, l.remark, (select auth.uid())
  from public.quotation_version_lines l
  left join public.quotation_version_items fi on fi.id = l.item_id
  left join public.quotation_version_items ti on ti.quotation_version_id = v_to.id and ti.item_no = fi.item_no
  where l.quotation_version_id = p_from_version
    and (l.item_id is null or ti.id is not null);
  insert into public.quotation_version_tier_money (quotation_version_id, legal_entity_id, tier_key, quoted_total_paise,
    show_per_person, updated_by)
  select v_to.id, v_to.legal_entity_id, m.tier_key, m.quoted_total_paise, m.show_per_person, (select auth.uid())
  from public.quotation_version_tier_money m where m.quotation_version_id = p_from_version;
  insert into public.quotation_version_instalments (quotation_version_id, legal_entity_id, tier_key, seq, label,
    amount_paise, due_rule, due_days, due_date)
  select v_to.id, v_to.legal_entity_id, p.tier_key, p.seq, p.label, p.amount_paise, p.due_rule, p.due_days, p.due_date
  from public.quotation_version_instalments p where p.quotation_version_id = p_from_version;
end;
$$;

-- quotation_convert_to_booking: the empty draft now holds the copied items.
-- Fills the selling total (the accepted tier's typed total), the plan with
-- resolved due dates and each item's purchase budget: the sum of that item's
-- line costs (common + accepted tier) only when every one of those lines has
-- a cost; otherwise 0, which B1 treats as "budget not set" (its warning
-- shows). Never list price or discount.
-- Due dates: on_acceptance -> the conversion day (IST; acceptance is never
-- later); days_before_start -> trip start - n days; fixed_date -> the date.
-- A row whose date cannot be resolved is not copied (readiness then shows the
-- plan as not adding up, and Sales types it).
create or replace function authz.quotation_money_to_booking(p_quotation_version uuid, p_booking_version uuid, p_tier_key text)
returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_q public.quotation_versions%rowtype;
  v_b public.booking_versions%rowtype;
  v_total bigint;
begin
  select * into v_q from public.quotation_versions v where v.id = p_quotation_version;
  select * into v_b from public.booking_versions v where v.id = p_booking_version for update;
  if v_q.id is null or v_b.id is null or v_b.status <> 'draft' or v_q.legal_entity_id <> v_b.legal_entity_id
     or p_tier_key is null or p_tier_key not in ('quoted', 'upgrade') then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  select m.quoted_total_paise into v_total from public.quotation_version_tier_money m
  where m.quotation_version_id = v_q.id and m.tier_key = p_tier_key;
  if v_total is null then
    raise exception 'wrong_state' using errcode = '55000', hint = 'tierKey';
  end if;

  insert into public.booking_version_commercials (version_id, legal_entity_id, selling_total_paise)
  values (v_b.id, v_b.legal_entity_id, v_total);

  insert into public.booking_version_instalments (booking_version_id, deal_id, legal_entity_id, seq, label, amount_paise, due_date)
  select v_b.id, v_b.deal_id, v_b.legal_entity_id, r.seq, r.label, r.amount_paise, r.due
  from (
    select p.seq, p.label, p.amount_paise,
      case p.due_rule when 'on_acceptance' then authz.finance_today()
                      when 'days_before_start' then v_q.trip_start - p.due_days
                      else p.due_date end as due
    from public.quotation_version_instalments p
    where p.quotation_version_id = v_q.id and p.tier_key = p_tier_key
  ) r
  where r.due between date '2000-01-01' and date '2100-12-31';

  update public.service_item_facts f
  set purchase_budget_paise = b.budget, updated_at = now()
  from (
    select m.service_item_id,
           case when count(l.id) > 0 and bool_and(l.line_cost_paise is not null)
                then sum(l.line_cost_paise) else 0 end as budget
    from authz.quotation_conversion_item_map(v_b.id) m
    left join public.quotation_version_lines l
      on l.item_id = m.quotation_item_id and l.quotation_version_id = v_q.id
     and l.option_key in ('common', p_tier_key)
    group by m.service_item_id
  ) b
  where f.booking_version_id = v_b.id and f.service_item_id = b.service_item_id
    and f.purchase_budget_paise is distinct from b.budget;
end;
$$;

-- ===========================================================================
-- 9. Commands
-- ===========================================================================

-- Replaces the lines of a draft version. Each line:
--   {lineNo 1..60, optionKey common|quoted|upgrade, itemId uuid|null,
--    chargeKind main|extra_bed|child_no_bed|other (default main),
--    categoryKey, description 1..200, unitKind, units 1..999, periods 1..366,
--    unitSellPaise (whole rupees), unitCostPaise|null, remark ≤300|null}
-- Refusals: invalid_input hint lines | lines[n].<key>; internal_wording hint
-- lines[n].description. Quantities are stored exactly as given.
create function public.quotation_lines_save(p_version_id uuid, p_expected_row_version integer, p_lines jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.quotation_versions%rowtype;
  v_row jsonb;
  v_n integer := 0;
  v_nos integer[] := '{}'::integer[];
  v_item public.quotation_version_items%rowtype;
  v_bad text;
  v_charge text; v_unit text; v_option text; v_units integer; v_periods integer; v_sell bigint;
begin
  v_ver := authz.lock_quotation_draft(p_version_id);
  if not authz.quotation_money_can_edit(v_ver.quotation_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.require_row_version(p_expected_row_version, v_ver.row_version);
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) > 60 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'lines';
  end if;
  for v_row in select e from jsonb_array_elements(p_lines) e loop
    v_n := v_n + 1;
    if jsonb_typeof(v_row) <> 'object' then
      raise exception 'invalid_input' using errcode = '22023', hint = 'lines[' || v_n || ']';
    end if;
    v_bad := (authz.b11_unknown_keys(v_row, array['lineNo', 'optionKey', 'itemId', 'chargeKind', 'categoryKey',
      'description', 'unitKind', 'units', 'periods', 'unitSellPaise', 'unitCostPaise', 'remark']))[1];
    v_charge := coalesce(nullif(v_row ->> 'chargeKind', ''), 'main');
    v_unit := v_row ->> 'unitKind';
    v_option := v_row ->> 'optionKey';
    v_sell := authz.quotation_paise(v_row -> 'unitSellPaise');
    v_item := null;
    if v_bad is null and jsonb_typeof(v_row -> 'itemId') = 'string' then
      if (v_row ->> 'itemId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        v_bad := 'itemId';
      else
        select * into v_item from public.quotation_version_items i
        where i.id = (v_row ->> 'itemId')::uuid and i.quotation_version_id = v_ver.id;
        if v_item.id is null then v_bad := 'itemId'; end if;
      end if;
    end if;
    v_bad := coalesce(v_bad,
      case when not authz.sf_int_ok(v_row -> 'lineNo', 1, 60, true) or (v_row ->> 'lineNo')::integer = any (v_nos) then 'lineNo' end,
      case when v_option is null or v_option not in ('common', 'quoted', 'upgrade') then 'optionKey' end,
      case when v_row ? 'itemId' and jsonb_typeof(v_row -> 'itemId') not in ('string', 'null') then 'itemId' end,
      case when v_item.id is not null and v_item.tier_key is not null and v_option <> v_item.tier_key then 'optionKey' end,
      case when v_charge not in ('main', 'extra_bed', 'child_no_bed', 'other')
                or (v_row ? 'chargeKind' and jsonb_typeof(v_row -> 'chargeKind') <> 'string') then 'chargeKind' end,
      case when coalesce(v_row ->> 'categoryKey', '') not in ('flights', 'hotels', 'transfers', 'tours', 'visas', 'insurance', 'other')
           then 'categoryKey' end,
      case when not authz.sf_text_ok(v_row -> 'description', 200, true) or (v_row ->> 'description') ~ E'[\\n\\r\\t]' then 'description' end,
      case when coalesce(v_unit, '') not in ('room_night', 'trip', 'line_total', 'night', 'person') then 'unitKind' end,
      case when not authz.sf_int_ok(v_row -> 'units', 1, 999, true) then 'units' end,
      case when not authz.sf_int_ok(v_row -> 'periods', 1, 366, true) then 'periods' end,
      case when v_sell is null or v_sell % 100 <> 0 or v_sell > 9999999999900 then 'unitSellPaise' end,
      case when v_row ? 'unitCostPaise' and jsonb_typeof(v_row -> 'unitCostPaise') <> 'null'
                and coalesce(authz.quotation_paise(v_row -> 'unitCostPaise'), -1) not between 0 and 9999999999999
           then 'unitCostPaise' end,
      case when not authz.sf_text_ok(v_row -> 'remark', 300, false) or (v_row ->> 'remark') ~ E'[\\n\\r\\t]' then 'remark' end);
    if v_bad is null then
      v_units := (v_row ->> 'units')::integer;
      v_periods := (v_row ->> 'periods')::integer;
      v_bad := coalesce(
        case when v_charge in ('extra_bed', 'child_no_bed') and v_item.id is null then 'itemId' end,
        case when not authz.quotation_unit_allowed(v_item.service_type, v_charge, v_unit) then 'unitKind' end,
        case when v_unit = 'line_total' and v_units <> 1 then 'units' end,
        case when v_unit in ('line_total', 'person') and v_periods <> 1 then 'periods' end);
    end if;
    if v_bad is not null then
      raise exception 'invalid_input' using errcode = '22023', hint = 'lines[' || v_n || '].' || v_bad;
    end if;
    if not authz.quotation_wording_ok(authz.b11_text(v_row -> 'description')) then
      raise exception 'internal_wording' using errcode = '22023', hint = 'lines[' || v_n || '].description';
    end if;
    v_nos := v_nos || (v_row ->> 'lineNo')::integer;
  end loop;

  delete from public.quotation_version_lines l where l.quotation_version_id = v_ver.id;
  insert into public.quotation_version_lines (legal_entity_id, quotation_version_id, line_no, option_key, item_id,
    charge_kind, category_key, description, unit_kind, units, periods, unit_sell_paise, unit_cost_paise, remark, created_by)
  select v_ver.legal_entity_id, v_ver.id, (e ->> 'lineNo')::integer, e ->> 'optionKey', nullif(e ->> 'itemId', '')::uuid,
    coalesce(nullif(e ->> 'chargeKind', ''), 'main'), e ->> 'categoryKey', authz.b11_text(e -> 'description'),
    e ->> 'unitKind', (e ->> 'units')::integer, (e ->> 'periods')::integer, authz.quotation_paise(e -> 'unitSellPaise'),
    authz.quotation_paise(e -> 'unitCostPaise'), authz.b11_text(e -> 'remark'), (select auth.uid())
  from jsonb_array_elements(p_lines) e;

  v_ver := authz.bump_quotation_version(v_ver.id);
  perform authz.write_audit('quotation.lines_saved', v_ver.legal_entity_id, authz.quotation_branch(v_ver.quotation_id),
    'quotation_version', v_ver.id, null,
    jsonb_build_object('quotationId', v_ver.quotation_id, 'versionNo', v_ver.version_no, 'lineCount', v_n,
      'rowVersion', v_ver.row_version));
  return jsonb_build_object('rowVersion', v_ver.row_version, 'status', v_ver.status);
end;
$$;

-- Typed quoted total of one tier (DEC-34). p_total_paise null removes it.
create function public.quotation_total_save(p_version_id uuid, p_expected_row_version integer, p_tier_key text,
  p_total_paise bigint, p_show_per_person boolean)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.quotation_versions%rowtype;
begin
  v_ver := authz.lock_quotation_draft(p_version_id);
  if not authz.quotation_money_can_edit(v_ver.quotation_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.require_row_version(p_expected_row_version, v_ver.row_version);
  if p_tier_key is null or p_tier_key not in ('quoted', 'upgrade') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'tierKey';
  end if;
  if p_total_paise is not null and (p_total_paise < 100 or p_total_paise % 100 <> 0 or p_total_paise > 9999999999999900) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'totalPaise';
  end if;
  if p_total_paise is null then
    delete from public.quotation_version_tier_money m where m.quotation_version_id = v_ver.id and m.tier_key = p_tier_key;
  else
    insert into public.quotation_version_tier_money (quotation_version_id, legal_entity_id, tier_key, quoted_total_paise,
      show_per_person, updated_by)
    values (v_ver.id, v_ver.legal_entity_id, p_tier_key, p_total_paise, coalesce(p_show_per_person, true), (select auth.uid()))
    on conflict (quotation_version_id, tier_key) do update
      set quoted_total_paise = excluded.quoted_total_paise, show_per_person = excluded.show_per_person,
          updated_by = excluded.updated_by, updated_at = now();
  end if;
  v_ver := authz.bump_quotation_version(v_ver.id);
  perform authz.write_audit('quotation.total_saved', v_ver.legal_entity_id, authz.quotation_branch(v_ver.quotation_id),
    'quotation_version', v_ver.id, null,
    jsonb_build_object('quotationId', v_ver.quotation_id, 'versionNo', v_ver.version_no, 'tierKey', p_tier_key,
      'cleared', p_total_paise is null, 'rowVersion', v_ver.row_version));
  return jsonb_build_object('rowVersion', v_ver.row_version, 'status', v_ver.status);
end;
$$;

-- Payment plan of one tier: replaces the set. Rows
--   {seq 1..12, label 1..60, amountPaise (whole rupees), dueRule,
--    dueDays 1..365 (days_before_start), dueDate (fixed_date)}
-- The total is checked by quotation_money_check (plan_total_mismatch).
create function public.quotation_plan_save(p_version_id uuid, p_expected_row_version integer, p_tier_key text,
  p_instalments jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.quotation_versions%rowtype;
  v_row jsonb;
  v_n integer := 0;
  v_seqs integer[] := '{}'::integer[];
  v_amount bigint;
  v_rule text;
begin
  v_ver := authz.lock_quotation_draft(p_version_id);
  if not authz.quotation_money_can_edit(v_ver.quotation_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.require_row_version(p_expected_row_version, v_ver.row_version);
  if p_tier_key is null or p_tier_key not in ('quoted', 'upgrade') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'tierKey';
  end if;
  if p_instalments is null or jsonb_typeof(p_instalments) <> 'array' or jsonb_array_length(p_instalments) > 12 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'instalments';
  end if;
  for v_row in select e from jsonb_array_elements(p_instalments) e loop
    v_n := v_n + 1;
    v_amount := authz.quotation_paise(v_row -> 'amountPaise');
    v_rule := v_row ->> 'dueRule';
    if jsonb_typeof(v_row) <> 'object'
       or cardinality(authz.b11_unknown_keys(v_row, array['seq', 'label', 'amountPaise', 'dueRule', 'dueDays', 'dueDate'])) > 0
       or not authz.sf_int_ok(v_row -> 'seq', 1, 12, true)
       or (v_row ->> 'seq')::integer = any (v_seqs)
       or not authz.sf_text_ok(v_row -> 'label', 60, true) or (v_row ->> 'label') ~ E'[\\n\\r\\t]'
       or v_amount is null or v_amount < 100 or v_amount % 100 <> 0 or v_amount > 999999999999900
       or coalesce(v_rule, '') not in ('on_acceptance', 'days_before_start', 'fixed_date')
       or (v_rule = 'days_before_start') <> authz.sf_int_ok(v_row -> 'dueDays', 1, 365, true)
       or (v_rule <> 'days_before_start' and coalesce(jsonb_typeof(v_row -> 'dueDays'), 'null') <> 'null')
       or (v_rule = 'fixed_date') <> (authz.sf_date(v_row -> 'dueDate') is not null)
       or (v_rule <> 'fixed_date' and coalesce(jsonb_typeof(v_row -> 'dueDate'), 'null') <> 'null') then
      raise exception 'invalid_input' using errcode = '22023', hint = 'instalments[' || v_n || ']';
    end if;
    if not authz.quotation_wording_ok(authz.b11_text(v_row -> 'label')) then
      raise exception 'internal_wording' using errcode = '22023', hint = 'instalments[' || v_n || '].label';
    end if;
    v_seqs := v_seqs || (v_row ->> 'seq')::integer;
  end loop;

  delete from public.quotation_version_instalments p where p.quotation_version_id = v_ver.id and p.tier_key = p_tier_key;
  insert into public.quotation_version_instalments (quotation_version_id, legal_entity_id, tier_key, seq, label,
    amount_paise, due_rule, due_days, due_date)
  select v_ver.id, v_ver.legal_entity_id, p_tier_key, (e ->> 'seq')::integer, authz.b11_text(e -> 'label'),
    authz.quotation_paise(e -> 'amountPaise'), e ->> 'dueRule',
    case when e ->> 'dueRule' = 'days_before_start' then (e ->> 'dueDays')::integer end,
    case when e ->> 'dueRule' = 'fixed_date' then authz.sf_date(e -> 'dueDate') end
  from jsonb_array_elements(p_instalments) e;

  v_ver := authz.bump_quotation_version(v_ver.id);
  perform authz.write_audit('quotation.plan_saved', v_ver.legal_entity_id, authz.quotation_branch(v_ver.quotation_id),
    'quotation_version', v_ver.id, null,
    jsonb_build_object('quotationId', v_ver.quotation_id, 'versionNo', v_ver.version_no, 'tierKey', p_tier_key,
      'count', v_n, 'rowVersion', v_ver.row_version));
  return jsonb_build_object('rowVersion', v_ver.row_version, 'status', v_ver.status);
end;
$$;

-- Internal cost estimates of existing lines (freeze note section 3): on a
-- draft, ready, sent or accepted version that was not converted. Not hashed,
-- no new version, no row_version change. Costs: [{lineNo, unitCostPaise|null}].
create function public.quotation_cost_estimates_save(p_version_id uuid, p_costs jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.quotation_versions%rowtype;
  v_q public.quotations%rowtype;
  v_row jsonb;
  v_n integer := 0;
  v_nos integer[] := '{}'::integer[];
  v_updated integer;
begin
  -- Same lock order and checks as Atlas's commands: quotation row, removed
  -- Deal (own or linked), editor, persisted expiry, then the version row.
  v_ver := authz.lock_quotation_version(p_version_id);
  select * into v_q from public.quotations q where q.id = v_ver.quotation_id;
  if v_ver.id is null or not authz.quotation_money_can_edit(v_ver.quotation_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_ver.status not in ('draft', 'ready', 'sent', 'accepted')
     or exists (select 1 from public.quotation_conversions c where c.quotation_version_id = v_ver.id) then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  if p_costs is null or jsonb_typeof(p_costs) <> 'array' or jsonb_array_length(p_costs) not between 1 and 60 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'costs';
  end if;
  for v_row in select e from jsonb_array_elements(p_costs) e loop
    v_n := v_n + 1;
    if jsonb_typeof(v_row) <> 'object'
       or cardinality(authz.b11_unknown_keys(v_row, array['lineNo', 'unitCostPaise'])) > 0
       or not authz.sf_int_ok(v_row -> 'lineNo', 1, 60, true)
       or (v_row ->> 'lineNo')::integer = any (v_nos)
       or not exists (select 1 from public.quotation_version_lines l
                      where l.quotation_version_id = v_ver.id and l.line_no = (v_row ->> 'lineNo')::integer)
       or not (v_row ? 'unitCostPaise')
       or (jsonb_typeof(v_row -> 'unitCostPaise') <> 'null'
           and coalesce(authz.quotation_paise(v_row -> 'unitCostPaise'), -1) not between 0 and 9999999999999) then
      raise exception 'invalid_input' using errcode = '22023', hint = 'costs[' || v_n || ']';
    end if;
    v_nos := v_nos || (v_row ->> 'lineNo')::integer;
  end loop;

  perform set_config('tripnavigate.quotation_cost_refresh', v_ver.id::text, true);
  update public.quotation_version_lines l
  set unit_cost_paise = authz.quotation_paise(e -> 'unitCostPaise'), updated_at = now()
  from jsonb_array_elements(p_costs) e
  where l.quotation_version_id = v_ver.id and l.line_no = (e ->> 'lineNo')::integer
    and l.unit_cost_paise is distinct from authz.quotation_paise(e -> 'unitCostPaise');
  get diagnostics v_updated = row_count;
  perform set_config('tripnavigate.quotation_cost_refresh', '', true);

  perform authz.write_audit('quotation.costs_saved', v_ver.legal_entity_id, v_q.branch_id, 'quotation_version', v_ver.id, null,
    jsonb_build_object('quotationId', v_ver.quotation_id, 'versionNo', v_ver.version_no, 'status', v_ver.status,
      'lineCount', v_updated));
  return jsonb_build_object('versionId', v_ver.id, 'updated', v_updated);
end;
$$;

-- Branch of a quotation (audit rows carry it).
create function authz.quotation_branch(p_quotation uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select q.branch_id from public.quotations q where q.id = p_quotation
$$;

-- ===========================================================================
-- 10. Privileges
-- ===========================================================================

revoke all on function
  authz.quotation_rows_guard(), authz.quotation_wording_ok(text), authz.quotation_paise(jsonb),
  authz.quotation_unit_allowed(text, text, text), authz.quotation_money_can_read(uuid), authz.quotation_money_can_edit(uuid),
  authz.quotation_paying_travellers(uuid), authz.quotation_tier_keys(uuid), authz.quotation_tier_figures(uuid, text),
  authz.quotation_money_check(uuid), authz.quotation_money_hash(uuid), authz.quotation_money_json(uuid),
  authz.quotation_customer_money_json(uuid), authz.quotation_copy_lines(uuid, uuid),
  authz.quotation_money_to_booking(uuid, uuid, text), authz.quotation_branch(uuid)
from public, anon, authenticated, service_role;

revoke all on function
  public.quotation_lines_save(uuid, integer, jsonb),
  public.quotation_total_save(uuid, integer, text, bigint, boolean),
  public.quotation_plan_save(uuid, integer, text, jsonb),
  public.quotation_cost_estimates_save(uuid, jsonb),
  public.quotation_customer_money(uuid)
from public, anon, service_role;
grant execute on function
  public.quotation_lines_save(uuid, integer, jsonb),
  public.quotation_total_save(uuid, integer, text, bigint, boolean),
  public.quotation_plan_save(uuid, integer, text, jsonb),
  public.quotation_cost_estimates_save(uuid, jsonb),
  public.quotation_customer_money(uuid)
to authenticated;

commit;
