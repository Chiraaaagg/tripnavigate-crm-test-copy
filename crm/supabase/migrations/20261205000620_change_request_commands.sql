-- TripNavigate CRM - Accounts phase 3, track G (3 of 6): change request
-- commands G1-G5.
-- Contract: accounts-phase3-2026-11-12/contract.md sections 4 (Approver), 10.2
-- (G1), 10.3 (G2-G5), 13, 14, 17.1, 17.3, 21 LD23, LD24, LD36, LD37, Addendum O1.
--
-- New commands (security definer, session first, execute to authenticated):
--   G1 public.admin_set_booking_changes_enabled(p_enabled, p_reason) - Super
--      Admin; audit settings.booking_changes_changed (trigger).
--   G2 public.booking_change_request_create(p_deal_id, p_fields, p_request_id)
--   G3 public.booking_change_request_resubmit(p_id, p_expected_row_version, p_fields, p_request_id)
--      public.booking_change_request_withdraw(p_id, p_expected_row_version, p_reason, p_request_id)
--   G4 public.booking_change_request_decide(p_id, p_decision, p_reason, p_expected_row_version, p_request_id)
--   G5 public.booking_change_open_version(p_change_request_id, p_request_id)
-- New internal helpers (no grant): authz.booking_changes_enabled,
--   authz.cr_requester_role, authz.cr_is_approver, authz.cr_next_ref,
--   authz.cr_invalid, authz.cr_text, authz.cr_item_ids, authz.cr_json,
--   authz.booking_change_approve_block (a hook for track H: returns null here;
--   H replaces it for the booked-removal checks of 11.3 - charges_missing and
--   "never by a person who entered a current charge"), authz.cr_discard_version,
--   authz.booking_revision_copy(p_base, p_change_request) (the copy block of
--   booking_open_revision, 20261129000110:1001-1052, moved here unchanged and
--   used by both).
-- Replaced (latest bodies, same signatures; changed lines marked
-- "Accounts phase 3 (20261205000620)"):
--   public.booking_open_revision (20261129000110:956): uses
--     authz.booking_revision_copy; keeps its two refusals; an open change
--     version of the base answers use_change_flow instead of being returned as
--     the ordinary revision draft.
--   authz.deal_change_open (B's stub, 20261205000200:446): true while a live
--     change request (requested | returned | approved | submitted) exists.
--
-- Refusal tokens: changes_off, service_changes_off, change_open_exists (23505),
-- change_not_supported, not_ready (55000, hint not_committed | trip_cancelled |
-- refund_open | revision_open), not_self_approval (42501), wrong_state (55000),
-- version_changed (40001), version_superseded (55000), use_change_flow (55000),
-- request_conflict (40001), invalid_input (22023, hint names the field),
-- not_authorized (42501), not_found (P0002), deal_removed (55000).
-- Audit: booking.change_requested | change_resubmitted | change_withdrawn |
-- change_approved | change_returned | change_version_opened. Details carry ids,
-- kinds and counts only; reasons go in the reason argument.
-- Rollback (forward-only): a NEW migration restoring booking_open_revision
-- (20261129000110) and B's stub of authz.deal_change_open, and revoking the
-- new commands.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Helpers
-- ===========================================================================

create function authz.booking_changes_enabled() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select s.changes_enabled from public.booking_change_settings s where s.id), false)
$$;

create function authz.cr_invalid(p_hint text) returns void
language plpgsql volatile set search_path = '' as $$
begin
  raise exception 'invalid_input' using errcode = '22023', hint = p_hint;
end;
$$;

-- A trimmed text field of p_fields (min..max, no control characters except
-- line breaks); null when absent and p_optional; invalid_input names the key.
create function authz.cr_text(p_fields jsonb, p_key text, p_min integer, p_max integer, p_optional boolean) returns text
language plpgsql volatile set search_path = '' as $$
declare
  v jsonb := p_fields -> p_key;
  t text;
begin
  if v is null or jsonb_typeof(v) = 'null' then
    if p_optional then
      return null;
    end if;
    perform authz.cr_invalid(p_key);
  end if;
  if jsonb_typeof(v) <> 'string' then
    perform authz.cr_invalid(p_key);
  end if;
  t := btrim(v #>> '{}', E' \t\r\n');
  if t = '' and p_optional then
    return null;
  end if;
  if length(t) < p_min or length(t) > p_max or t ~ E'[\\x01-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f]' then
    perform authz.cr_invalid(p_key);
  end if;
  return t;
end;
$$;

-- A plain reason argument (10..500).
create function authz.cr_reason(p_reason text, p_hint text) returns text
language plpgsql volatile set search_path = '' as $$
begin
  return authz.cr_text(jsonb_build_object(p_hint, p_reason), p_hint, 10, 500, false);
end;
$$;

-- itemIds: distinct uuids of services that have facts in p_version, p_min..p_max.
create function authz.cr_item_ids(p_fields jsonb, p_version uuid, p_min integer, p_max integer) returns uuid[]
language plpgsql volatile security definer set search_path = '' as $$
declare
  v jsonb := p_fields -> 'itemIds';
  v_ids uuid[];
begin
  if v is null or jsonb_typeof(v) <> 'array' or jsonb_array_length(v) < p_min or jsonb_array_length(v) > p_max
     or exists (select 1 from jsonb_array_elements(v) e
                where jsonb_typeof(e) <> 'string'
                   or (e #>> '{}') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') then
    perform authz.cr_invalid('itemIds');
  end if;
  select coalesce(array_agg(distinct (e #>> '{}')::uuid), '{}'::uuid[]) into v_ids from jsonb_array_elements(v) e;
  if cardinality(v_ids) <> jsonb_array_length(v)
     or exists (select 1 from unnest(v_ids) i
                where not exists (select 1 from public.service_item_facts f
                                  where f.booking_version_id = p_version and f.service_item_id = i)) then
    perform authz.cr_invalid('itemIds');
  end if;
  return (select array_agg(i order by i) from unnest(v_ids) i);
end;
$$;

-- How the caller may ask for a change on the Deal: 'sales_owner' (SO) or
-- 'manager' (an active branch Manager without P/F/V membership), else null.
create function authz.cr_requester_role(p_deal uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when authz.refund_is_so(p_deal) then 'sales_owner'
    when authz.refund_is_m(p_deal) then 'manager'
  end
$$;

-- Another active branch Manager of the Deal's branch (without P/F/V) than p_user.
create function authz.cr_other_branch_manager(p_deal uuid, p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.deals d
    join public.memberships m on m.legal_entity_id = d.legal_entity_id and m.branch_id = d.branch_id
    join public.staff_profiles p on p.user_id = m.user_id
    join public.legal_entities e on e.id = m.legal_entity_id
    join public.branches b on b.id = m.branch_id
    where d.id = p_deal and m.role_code = 'manager' and m.status = 'active' and m.user_id <> p_user
      and p.status = 'active' and e.status = 'enabled' and b.status = 'enabled'
      and not exists (select 1 from public.memberships x
                      where x.user_id = m.user_id and x.legal_entity_id = d.legal_entity_id
                        and x.role_code in ('purchase', 'flight', 'visa') and x.status = 'active'))
$$;

-- Approver of a change request, ignoring self-approval (contract 4, LD37): a
-- branch Manager of the Deal's branch; when the only branch Manager is the
-- requester, any other active Manager of the entity.
create function authz.cr_is_approver(p_change_request uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select authz.refund_is_m(r.deal_id)
        or (authz.refund_entity_manager(r.legal_entity_id) and not authz.cr_other_branch_manager(r.deal_id, r.requested_by))
    from public.booking_change_requests r where r.id = p_change_request), false)
$$;

-- Hook for track H (11.3): a reason the request may not be approved by the
-- caller yet (for example 'charges_missing'), or null. G: always null.
create function authz.booking_change_approve_block(p_change_request uuid) returns text
language plpgsql stable security definer set search_path = '' as $$
begin
  return null;
end;
$$;

-- Next CR-YYYY-NNNNNN of the entity (India year).
create function authz.cr_next_ref(p_entity uuid) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_year integer := extract(year from (now() at time zone 'Asia/Kolkata'))::integer;
  v_no integer;
begin
  insert into public.booking_change_counters as c (legal_entity_id, year, last_no) values (p_entity, v_year, 1)
  on conflict (legal_entity_id, year) do update set last_no = c.last_no + 1
  returning c.last_no into v_no;
  return 'CR-' || v_year::text || '-' || lpad(v_no::text, 6, '0');
end;
$$;

-- Command answer of a change request.
create function authz.cr_json(p public.booking_change_requests) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('changeRequestId', p.id, 'dealId', p.deal_id, 'refNo', p.ref_no, 'kind', p.kind,
    'status', p.status, 'changeVersionId', p.change_version_id, 'rowVersion', p.row_version)
$$;

-- The internals of booking_discard_draft (20261119000300:1158) for a change
-- version: evidence marked removed, the version discarded. No refusal here.
create function authz.cr_discard_version(p_version uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.booking_versions%rowtype;
begin
  select * into v_ver from public.booking_versions v where v.id = p_version for update;
  if v_ver.id is null or v_ver.status <> 'draft' then
    return;
  end if;
  -- A submitted change version is otherwise frozen (authz.booking_versions_change_guard, 20261205000630).
  perform set_config('tripnavigate.change_apply', v_ver.id::text, true);
  update public.booking_evidence e set status = 'removed', updated_at = now()
  where e.version_id = v_ver.id and e.status <> 'removed';
  update public.booking_versions v
  set status = 'discarded', discarded_at = now(), discarded_by = (select auth.uid()), updated_at = now(),
      updated_by = (select auth.uid())
  where v.id = v_ver.id;
  perform set_config('tripnavigate.change_apply', '', true);
  perform authz.write_audit('booking.draft_discarded', v_ver.legal_entity_id, v_ver.branch_id, 'booking_version', v_ver.id,
    null, jsonb_build_object('dealId', v_ver.deal_id, 'versionNo', v_ver.version_no, 'baseVersionId', v_ver.revises_version_id,
      'changeRequestId', v_ver.change_request_id));
end;
$$;

-- ===========================================================================
-- 2. Live change request (replaces B's stub, 20261205000200:446)
-- ===========================================================================

create or replace function authz.deal_change_open(p_deal uuid) returns boolean
language plpgsql stable security definer set search_path = '' as $$
begin
  -- Accounts phase 3 (20261205000620): a live change request on the Deal.
  return exists (select 1 from public.booking_change_requests r
                 where r.deal_id = p_deal and r.status in ('requested', 'returned', 'approved', 'submitted'));
end;
$$;

-- ===========================================================================
-- 3. Revision copy (moved out of booking_open_revision, 20261129000110:1001-1052)
-- ===========================================================================

create function authz.booking_revision_copy(p_base uuid, p_change_request uuid) returns public.booking_versions
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_base public.booking_versions%rowtype;
  v_ver public.booking_versions%rowtype;
begin
  select * into v_base from public.booking_versions v where v.id = p_base;
  -- Booking form: party counts copied; form rules follow the base (trigger).
  insert into public.booking_versions (deal_id, legal_entity_id, branch_id, version_no, created_by, service_type,
    trip_destination, trip_scope, trip_start, trip_end, revises_version_id, updated_by,
    pax_total, children_count, infants_count,
    change_request_id)  -- Accounts phase 3 (20261205000620)
  values (v_base.deal_id, v_base.legal_entity_id, v_base.branch_id,
    (select max(v.version_no) from public.booking_versions v where v.deal_id = v_base.deal_id) + 1,
    (select auth.uid()), 'package', v_base.trip_destination, v_base.trip_scope, v_base.trip_start, v_base.trip_end,
    v_base.id, (select auth.uid()), v_base.pax_total, v_base.children_count, v_base.infants_count,
    p_change_request)
  returning * into v_ver;
  -- BF2: the automatic budget flag is copied too.
  insert into public.service_item_facts (service_item_id, booking_version_id, legal_entity_id, facts, purchase_budget_paise, facts_hash,
    purchase_budget_auto)
  select f.service_item_id, v_ver.id, f.legal_entity_id, f.facts, f.purchase_budget_paise, f.facts_hash, f.purchase_budget_auto
  from public.service_item_facts f where f.booking_version_id = v_base.id;
  insert into public.service_item_travellers (booking_version_id, service_item_id, legal_entity_id, traveller_seq)
  select v_ver.id, f.service_item_id, f.legal_entity_id, s
  from public.service_item_facts f cross join unnest(authz.item_participant_seqs(f.service_item_id, v_base.id)) s
  where f.booking_version_id = v_base.id;
  insert into public.booking_version_contacts (booking_version_id, legal_entity_id, deal_id, contact_name, mobile, email,
    contact_confirmed, confirmed_by, confirmed_at, booking_for, payer_different, payer_name, updated_by,
    customer_type, market)
  select v_ver.id, c.legal_entity_id, c.deal_id, c.contact_name, c.mobile, c.email, c.contact_confirmed, c.confirmed_by,
    c.confirmed_at, c.booking_for, c.payer_different, c.payer_name, c.updated_by, c.customer_type, c.market
  from public.booking_version_contacts c where c.booking_version_id = v_base.id;
  insert into public.booking_version_commercials (version_id, legal_entity_id, selling_total_paise, list_price_paise, discount_paise)
  select v_ver.id, c.legal_entity_id, c.selling_total_paise, c.list_price_paise, c.discount_paise
  from public.booking_version_commercials c where c.version_id = v_base.id;
  insert into public.booking_version_instalments (booking_version_id, deal_id, legal_entity_id, seq, label, amount_paise, due_date)
  select v_ver.id, p.deal_id, p.legal_entity_id, p.seq, p.label, p.amount_paise, p.due_date
  from public.booking_version_instalments p where p.booking_version_id = v_base.id;
  -- Booking form: per-person prices and supplier estimates.
  insert into public.booking_version_price_lines (booking_version_id, legal_entity_id, deal_id, category, quantity,
    purchase_paise, sale_paise, updated_by)
  select v_ver.id, l.legal_entity_id, l.deal_id, l.category, l.quantity, l.purchase_paise, l.sale_paise, l.updated_by
  from public.booking_version_price_lines l where l.booking_version_id = v_base.id;
  -- BF2: fare per person.
  insert into public.service_item_cost_estimates (booking_version_id, service_item_id, legal_entity_id, room_rate_paise,
    extra_bed_rate_paise, no_bed_rate_paise, vehicle_rate_paise, fare_total_paise,
    fare_adult_paise, fare_child_paise, fare_infant_paise, updated_by)
  select v_ver.id, e.service_item_id, e.legal_entity_id, e.room_rate_paise, e.extra_bed_rate_paise, e.no_bed_rate_paise,
    e.vehicle_rate_paise, e.fare_total_paise, e.fare_adult_paise, e.fare_child_paise, e.fare_infant_paise, e.updated_by
  from public.service_item_cost_estimates e where e.booking_version_id = v_base.id;
  -- BF2: typed total fare per person of all flights.
  insert into public.booking_version_flight_fares (booking_version_id, legal_entity_id, adult_paise, child_paise, infant_paise,
    updated_by)
  select v_ver.id, x.legal_entity_id, x.adult_paise, x.child_paise, x.infant_paise, x.updated_by
  from public.booking_version_flight_fares x where x.booking_version_id = v_base.id;
  select * into v_ver from public.booking_versions v where v.id = v_ver.id;
  return v_ver;
end;
$$;

-- Replaces 20261129000110:956 (same signature and refusals; lines marked).
create or replace function public.booking_open_revision(p_base_version_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_base public.booking_versions%rowtype;
  v_ver public.booking_versions%rowtype;
  v_deal public.deals%rowtype;
  v_review text;
begin
  select * into v_base from public.booking_versions v where v.id = p_base_version_id;
  perform authz.refuse_removed_deal(v_base.deal_id);
  if v_base.id is null or not authz.can_edit_booking_draft(v_base.deal_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if not authz.service_items_enabled() then
    raise exception 'service_items_disabled' using errcode = '55000';
  end if;
  if authz.deal_not_active(v_base.deal_id) then
    raise exception 'deal_not_active' using errcode = '55000';
  end if;
  -- Lock order: Deal, base version, base review.
  select * into v_deal from public.deals d where d.id = v_base.deal_id for no key update;
  select * into v_base from public.booking_versions v where v.id = p_base_version_id for update;
  if v_base.status = 'superseded' then
    raise exception 'version_superseded' using errcode = '55000';
  end if;
  if v_base.status <> 'confirmed' then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v_base.service_type <> 'package' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'version';
  end if;
  select * into v_ver from public.booking_versions v
  where v.revises_version_id = v_base.id and v.status = 'draft';
  -- Accounts phase 3 (20261205000620): a change version is worked through the change flow only.
  if v_ver.id is not null and v_ver.change_request_id is not null then
    raise exception 'use_change_flow' using errcode = '55000';
  end if;
  if v_ver.id is not null then
    return jsonb_build_object('versionId', v_ver.id, 'versionNo', v_ver.version_no, 'rowVersion', v_ver.row_version,
      'revisesVersionId', v_base.id, 'created', false);
  end if;
  select rv.status into v_review from public.accounts_booking_reviews rv where rv.booking_version_id = v_base.id for share;
  if v_review is distinct from 'returned' then
    raise exception 'revision_not_allowed' using errcode = '55000';
  end if;
  if authz.deal_committed(v_base.deal_id) then
    raise exception 'already_committed' using errcode = '55000';
  end if;

  -- Accounts phase 3 (20261205000620): the copy block moved to authz.booking_revision_copy.
  v_ver := authz.booking_revision_copy(v_base.id, null);

  perform authz.write_audit('booking.revision_opened', v_ver.legal_entity_id, v_ver.branch_id, 'booking_version', v_ver.id,
    null, jsonb_build_object('dealId', v_ver.deal_id, 'versionNo', v_ver.version_no, 'baseVersionId', v_base.id,
      'baseVersionNo', v_base.version_no));
  return jsonb_build_object('versionId', v_ver.id, 'versionNo', v_ver.version_no, 'rowVersion', v_ver.row_version,
    'revisesVersionId', v_base.id, 'created', true);
end;
$$;

-- ===========================================================================
-- 4. G1 switch (Super Admin)
-- ===========================================================================

create function public.admin_set_booking_changes_enabled(p_enabled boolean, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_before boolean;
  v_after public.booking_change_settings%rowtype;
  v_reason text;
  v_prev text[];
begin
  if not coalesce(authz.session_ok(), false) or not authz.can_switch_live_settings(null) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_enabled is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'enabled';
  end if;
  v_reason := authz.cr_reason(p_reason, 'reason');
  select s.changes_enabled into v_before from public.booking_change_settings s where s.id for update;
  if not found then
    raise exception 'settings row missing' using errcode = '55000';
  end if;
  v_prev := authz.settings_begin_change('admin_set_booking_changes_enabled', v_reason);
  update public.booking_change_settings s set changes_enabled = p_enabled, updated_at = now() where s.id returning * into v_after;
  perform authz.settings_end_change(v_prev);
  return jsonb_build_object('changed', v_before is distinct from v_after.changes_enabled,
    'changesEnabled', v_after.changes_enabled, 'serviceChangesEnabled', v_after.service_changes_enabled,
    'updatedAt', v_after.updated_at);
end;
$$;

-- ===========================================================================
-- 5. G2 create
-- ===========================================================================

create function public.booking_change_request_create(p_deal_id uuid, p_fields jsonb, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_deal public.deals%rowtype;
  v_role text;
  v_payload jsonb := jsonb_build_object('dealId', p_deal_id, 'fields', p_fields);
  v_result jsonb;
  v_key text;
  v_kind text;
  v_base public.booking_versions%rowtype;
  v_items uuid[];
  v_summary text;
  v_reason text;
  v_row public.booking_change_requests%rowtype;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_deal from public.deals d where d.id = p_deal_id;
  v_role := authz.cr_requester_role(v_deal.id);
  if v_deal.id is null or v_role is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.refuse_removed_deal(v_deal.id);
  if p_request_id is null then
    perform authz.cr_invalid('requestId');
  end if;
  -- Lock order (17.1): finance head, the Deal row, then the subject.
  perform authz.finance_lock_deal(v_deal.id);
  select * into v_deal from public.deals d where d.id = p_deal_id for no key update;
  v_result := authz.finance_replay(v_deal.legal_entity_id, p_request_id, 'booking_change_request_create', v_payload);
  if v_result is not null then
    return v_result;
  end if;

  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    perform authz.cr_invalid('fields');
  end if;
  for v_key in select k from jsonb_object_keys(p_fields) k order by k loop
    if v_key <> all (array['kind', 'itemIds', 'changeSummary', 'reason']) then
      perform authz.cr_invalid(v_key);
    end if;
  end loop;
  v_kind := authz.cr_text(p_fields, 'kind', 1, 20, false);
  if v_kind not in ('change', 'add_service', 'remove_service') then
    perform authz.cr_invalid('kind');
  end if;
  -- Adding or removing services is track H (11): until H, refused as switched off or not supported.
  if v_kind <> 'change' then
    if not coalesce((select s.service_changes_enabled from public.booking_change_settings s where s.id), false) then
      raise exception 'service_changes_off' using errcode = '55000';
    end if;
    raise exception 'change_not_supported' using errcode = '55000';
  end if;
  if not authz.booking_changes_enabled() then
    raise exception 'changes_off' using errcode = '55000';
  end if;

  -- The accepted version (base).
  select * into v_base from public.booking_versions v
  where v.deal_id = v_deal.id and v.status = 'confirmed' order by v.version_no desc limit 1 for update;
  if v_base.id is not null and v_base.service_type <> 'package' then
    raise exception 'change_not_supported' using errcode = '55000';  -- LD36
  end if;
  if v_base.id is null or not authz.deal_committed(v_deal.id) then
    raise exception 'not_ready' using errcode = '55000', hint = 'not_committed';
  end if;
  if authz.deal_trip_cancelled(v_deal.id) then
    raise exception 'not_ready' using errcode = '55000', hint = 'trip_cancelled';
  end if;
  if exists (select 1 from public.customer_refund_requests r
             where r.deal_id = v_deal.id
               and (r.status in ('requested', 'returned') or (r.status = 'approved' and r.outcome = 'payout'))) then
    raise exception 'not_ready' using errcode = '55000', hint = 'refund_open';
  end if;
  if authz.deal_change_open(v_deal.id) then
    raise exception 'change_open_exists' using errcode = '23505';
  end if;

  v_items := authz.cr_item_ids(p_fields, v_base.id, 1, 20);
  v_summary := authz.cr_text(p_fields, 'changeSummary', 10, 500, false);
  v_reason := authz.cr_text(p_fields, 'reason', 10, 500, false);

  begin
    insert into public.booking_change_requests (legal_entity_id, branch_id, deal_id, ref_no, kind, base_version_id, item_ids,
      change_summary, reason, requested_as, requested_by, request_id)
    values (v_deal.legal_entity_id, v_deal.branch_id, v_deal.id, authz.cr_next_ref(v_deal.legal_entity_id), v_kind, v_base.id,
      v_items, v_summary, v_reason, v_role, v_uid, p_request_id)
    returning * into v_row;
  exception when unique_violation then
    raise exception 'change_open_exists' using errcode = '23505';
  end;

  perform authz.write_audit('booking.change_requested', v_row.legal_entity_id, v_row.branch_id, 'booking_change_request', v_row.id,
    v_reason, jsonb_build_object('changeRequestId', v_row.id, 'dealId', v_row.deal_id, 'kind', v_row.kind,
      'itemCount', cardinality(v_row.item_ids)));
  v_result := authz.cr_json(v_row) || jsonb_build_object('outcome', 'created');
  return authz.finance_remember(v_row.legal_entity_id, p_request_id, 'booking_change_request_create', v_payload, v_result);
end;
$$;

-- Locks the request's Deal (finance head, Deal row) and then the request; the
-- caller must still check who may act.
create function authz.cr_lock(p_id uuid) returns public.booking_change_requests
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_deal uuid;
  v_row public.booking_change_requests%rowtype;
begin
  select r.deal_id into v_deal from public.booking_change_requests r where r.id = p_id;
  if v_deal is null then
    return null;
  end if;
  perform authz.finance_lock_deal(v_deal);
  perform 1 from public.deals d where d.id = v_deal for no key update;
  select * into v_row from public.booking_change_requests r where r.id = p_id for update;
  return v_row;
end;
$$;

-- ===========================================================================
-- 6. G3 resubmit and withdraw
-- ===========================================================================

create function public.booking_change_request_resubmit(p_id uuid, p_expected_row_version integer, p_fields jsonb, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_row public.booking_change_requests%rowtype;
  v_payload jsonb := jsonb_build_object('id', p_id, 'expectedRowVersion', p_expected_row_version, 'fields', p_fields);
  v_result jsonb;
  v_key text;
  v_kind text;
  v_items uuid[];
  v_summary text;
  v_reason text;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_row from public.booking_change_requests r where r.id = p_id;
  if v_row.id is null or v_row.requested_by is distinct from v_uid or authz.cr_requester_role(v_row.deal_id) is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_request_id is null then
    perform authz.cr_invalid('requestId');
  end if;
  v_row := authz.cr_lock(p_id);
  v_result := authz.finance_replay(v_row.legal_entity_id, p_request_id, 'booking_change_request_resubmit', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if v_row.status <> 'returned' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  perform authz.require_row_version(p_expected_row_version, v_row.row_version);
  if v_row.kind = 'change' and not authz.booking_changes_enabled() then
    raise exception 'changes_off' using errcode = '55000';
  end if;
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    perform authz.cr_invalid('fields');
  end if;
  for v_key in select k from jsonb_object_keys(p_fields) k order by k loop
    if v_key <> all (array['kind', 'itemIds', 'changeSummary', 'reason']) then
      perform authz.cr_invalid(v_key);
    end if;
  end loop;
  v_kind := coalesce(authz.cr_text(p_fields, 'kind', 1, 20, true), v_row.kind);
  if v_kind <> v_row.kind then
    perform authz.cr_invalid('kind');
  end if;
  if not exists (select 1 from public.booking_versions v where v.id = v_row.base_version_id and v.status = 'confirmed') then
    raise exception 'version_superseded' using errcode = '55000';
  end if;
  v_items := authz.cr_item_ids(p_fields, v_row.base_version_id, 1, 20);
  v_summary := authz.cr_text(p_fields, 'changeSummary', 10, 500, false);
  v_reason := authz.cr_text(p_fields, 'reason', 10, 500, false);

  update public.booking_change_requests r
  set status = 'requested', item_ids = v_items, change_summary = v_summary, reason = v_reason,
      decided_by = null, decided_at = null, decision_request_id = null, row_version = r.row_version + 1
  where r.id = v_row.id
  returning * into v_row;
  perform authz.write_audit('booking.change_resubmitted', v_row.legal_entity_id, v_row.branch_id, 'booking_change_request', v_row.id,
    v_reason, jsonb_build_object('changeRequestId', v_row.id, 'dealId', v_row.deal_id, 'kind', v_row.kind,
      'itemCount', cardinality(v_row.item_ids), 'rowVersion', v_row.row_version));
  v_result := authz.cr_json(v_row) || jsonb_build_object('outcome', 'updated');
  return authz.finance_remember(v_row.legal_entity_id, p_request_id, 'booking_change_request_resubmit', v_payload, v_result);
end;
$$;

-- Ends a live request: discards its change version and voids its open
-- reconfirmations (their Purchase people are told by track N, notice 56).
create function authz.cr_close(p_row public.booking_change_requests, p_status text, p_reason text)
returns public.booking_change_requests
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_row public.booking_change_requests%rowtype;
begin
  if p_row.change_version_id is not null then
    perform authz.cr_discard_version(p_row.change_version_id);
  end if;
  update public.task_reconfirmations x
  set status = 'void', row_version = x.row_version + 1
  where x.change_request_id = p_row.id and x.status in ('pending', 'recorded');
  update public.booking_change_requests r
  set status = p_status, closed_by = (select auth.uid()), closed_at = now(), close_reason = p_reason,
      row_version = r.row_version + 1
  where r.id = p_row.id
  returning * into v_row;
  return v_row;
end;
$$;

create function public.booking_change_request_withdraw(p_id uuid, p_expected_row_version integer, p_reason text, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_row public.booking_change_requests%rowtype;
  v_payload jsonb := jsonb_build_object('id', p_id, 'expectedRowVersion', p_expected_row_version, 'reason', p_reason);
  v_result jsonb;
  v_reason text;
  v_voided integer;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_row from public.booking_change_requests r where r.id = p_id;
  if v_row.id is null
     or not ((v_row.requested_by = v_uid and authz.cr_requester_role(v_row.deal_id) is not null)
             or authz.refund_is_m(v_row.deal_id)) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_request_id is null then
    perform authz.cr_invalid('requestId');
  end if;
  v_row := authz.cr_lock(p_id);
  v_result := authz.finance_replay(v_row.legal_entity_id, p_request_id, 'booking_change_request_withdraw', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if v_row.status not in ('requested', 'returned', 'approved', 'submitted') then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  perform authz.require_row_version(p_expected_row_version, v_row.row_version);
  v_reason := authz.cr_reason(p_reason, 'reason');
  -- Lock order: change version, then reconfirmations (inside cr_close).
  perform 1 from public.task_reconfirmations x where x.change_request_id = v_row.id order by x.task_id for update;
  select count(*)::integer into v_voided from public.task_reconfirmations x
  where x.change_request_id = v_row.id and x.status = 'recorded';
  v_row := authz.cr_close(v_row, 'withdrawn', v_reason);
  perform authz.write_audit('booking.change_withdrawn', v_row.legal_entity_id, v_row.branch_id, 'booking_change_request', v_row.id,
    v_reason, jsonb_build_object('changeRequestId', v_row.id, 'dealId', v_row.deal_id, 'kind', v_row.kind,
      'voidedReconfirmations', v_voided, 'changeVersionId', v_row.change_version_id));
  v_result := authz.cr_json(v_row) || jsonb_build_object('outcome', 'updated');
  return authz.finance_remember(v_row.legal_entity_id, p_request_id, 'booking_change_request_withdraw', v_payload, v_result);
end;
$$;

-- ===========================================================================
-- 7. G4 decide (the only approval of the change)
-- ===========================================================================

create function public.booking_change_request_decide(p_id uuid, p_decision text, p_reason text, p_expected_row_version integer,
  p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_row public.booking_change_requests%rowtype;
  v_payload jsonb := jsonb_build_object('id', p_id, 'decision', p_decision, 'reason', p_reason,
    'expectedRowVersion', p_expected_row_version);
  v_result jsonb;
  v_reason text;
  v_block text;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_row from public.booking_change_requests r where r.id = p_id;
  if v_row.id is null or not authz.cr_is_approver(v_row.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_row.requested_by = v_uid then
    raise exception 'not_self_approval' using errcode = '42501';
  end if;
  if p_request_id is null then
    perform authz.cr_invalid('requestId');
  end if;
  if p_decision is null or p_decision not in ('approve', 'return') then
    perform authz.cr_invalid('decision');
  end if;
  v_row := authz.cr_lock(p_id);
  v_result := authz.finance_replay(v_row.legal_entity_id, p_request_id, 'booking_change_request_decide', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if v_row.status <> 'requested' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  perform authz.require_row_version(p_expected_row_version, v_row.row_version);
  if v_row.kind = 'change' and not authz.booking_changes_enabled() then
    raise exception 'changes_off' using errcode = '55000';
  end if;
  if p_decision = 'return' or nullif(btrim(coalesce(p_reason, '')), '') is not null then
    v_reason := authz.cr_reason(p_reason, 'reason');
  end if;

  if p_decision = 'approve' then
    -- The base must still be the accepted version.
    if not exists (select 1 from public.booking_versions v where v.id = v_row.base_version_id and v.status = 'confirmed') then
      raise exception 'version_superseded' using errcode = '55000';
    end if;
    v_block := authz.booking_change_approve_block(v_row.id);  -- track H hook (11.3)
    if v_block is not null then
      raise exception '%', v_block using errcode = case when v_block = 'not_self_approval' then '42501' else '55000' end;
    end if;
    update public.booking_change_requests r
    set status = 'approved', decided_by = v_uid, decided_at = now(), decision_request_id = p_request_id,
        row_version = r.row_version + 1
    where r.id = v_row.id
    returning * into v_row;
    perform authz.write_audit('booking.change_approved', v_row.legal_entity_id, v_row.branch_id, 'booking_change_request', v_row.id,
      v_reason, jsonb_build_object('changeRequestId', v_row.id, 'dealId', v_row.deal_id, 'kind', v_row.kind,
        'rowVersion', v_row.row_version));
  else
    update public.booking_change_requests r
    set status = 'returned', decided_by = v_uid, decided_at = now(), decision_request_id = p_request_id,
        return_reason = v_reason, row_version = r.row_version + 1
    where r.id = v_row.id
    returning * into v_row;
    perform authz.write_audit('booking.change_returned', v_row.legal_entity_id, v_row.branch_id, 'booking_change_request', v_row.id,
      v_reason, jsonb_build_object('changeRequestId', v_row.id, 'dealId', v_row.deal_id, 'kind', v_row.kind,
        'rowVersion', v_row.row_version));
  end if;
  v_result := authz.cr_json(v_row) || jsonb_build_object('outcome', 'updated');
  return authz.finance_remember(v_row.legal_entity_id, p_request_id, 'booking_change_request_decide', v_payload, v_result);
end;
$$;

-- ===========================================================================
-- 8. G5 open the change version
-- ===========================================================================

create function public.booking_change_open_version(p_change_request_id uuid, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_row public.booking_change_requests%rowtype;
  v_payload jsonb := jsonb_build_object('changeRequestId', p_change_request_id);
  v_result jsonb;
  v_base public.booking_versions%rowtype;
  v_ver public.booking_versions%rowtype;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_row from public.booking_change_requests r where r.id = p_change_request_id;
  if v_row.id is null
     or not ((v_row.requested_by = v_uid and authz.cr_requester_role(v_row.deal_id) is not null)
             or authz.refund_is_so(v_row.deal_id)) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.refuse_removed_deal(v_row.deal_id);
  if p_request_id is null then
    perform authz.cr_invalid('requestId');
  end if;
  v_row := authz.cr_lock(p_change_request_id);
  v_result := authz.finance_replay(v_row.legal_entity_id, p_request_id, 'booking_change_open_version', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if v_row.status <> 'approved' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  if v_row.kind = 'change' and not authz.booking_changes_enabled() then
    raise exception 'changes_off' using errcode = '55000';
  end if;
  if v_row.change_version_id is not null then
    select * into v_ver from public.booking_versions v where v.id = v_row.change_version_id;
    v_result := jsonb_build_object('changeRequestId', v_row.id, 'versionId', v_ver.id, 'versionNo', v_ver.version_no,
      'rowVersion', v_ver.row_version, 'contentHash', v_ver.content_hash, 'outcome', 'existing');
    return authz.finance_remember(v_row.legal_entity_id, p_request_id, 'booking_change_open_version', v_payload, v_result);
  end if;
  -- Lock order: base version (17.1).
  select * into v_base from public.booking_versions v where v.id = v_row.base_version_id for update;
  if v_base.status <> 'confirmed' then
    raise exception 'version_superseded' using errcode = '55000';
  end if;
  if exists (select 1 from public.booking_versions v where v.revises_version_id = v_base.id and v.status = 'draft') then
    raise exception 'not_ready' using errcode = '55000', hint = 'revision_open';
  end if;

  v_ver := authz.booking_revision_copy(v_base.id, v_row.id);
  update public.booking_change_requests r set change_version_id = v_ver.id, row_version = r.row_version + 1
  where r.id = v_row.id
  returning * into v_row;

  perform authz.write_audit('booking.change_version_opened', v_row.legal_entity_id, v_row.branch_id, 'booking_change_request',
    v_row.id, null, jsonb_build_object('changeRequestId', v_row.id, 'dealId', v_row.deal_id, 'versionId', v_ver.id,
      'versionNo', v_ver.version_no, 'baseVersionId', v_base.id));
  v_result := jsonb_build_object('changeRequestId', v_row.id, 'versionId', v_ver.id, 'versionNo', v_ver.version_no,
    'rowVersion', v_ver.row_version, 'contentHash', v_ver.content_hash, 'outcome', 'created');
  return authz.finance_remember(v_row.legal_entity_id, p_request_id, 'booking_change_open_version', v_payload, v_result);
end;
$$;

-- ===========================================================================
-- 9. Grants
-- ===========================================================================

revoke all on function authz.booking_changes_enabled(), authz.cr_invalid(text),
  authz.cr_text(jsonb, text, integer, integer, boolean), authz.cr_reason(text, text),
  authz.cr_item_ids(jsonb, uuid, integer, integer), authz.cr_requester_role(uuid),
  authz.cr_other_branch_manager(uuid, uuid), authz.cr_is_approver(uuid), authz.booking_change_approve_block(uuid),
  authz.cr_next_ref(uuid), authz.cr_json(public.booking_change_requests), authz.cr_discard_version(uuid),
  authz.booking_revision_copy(uuid, uuid), authz.cr_lock(uuid),
  authz.cr_close(public.booking_change_requests, text, text)
from public, anon, authenticated, service_role;

revoke all on function public.admin_set_booking_changes_enabled(boolean, text),
  public.booking_change_request_create(uuid, jsonb, uuid),
  public.booking_change_request_resubmit(uuid, integer, jsonb, uuid),
  public.booking_change_request_withdraw(uuid, integer, text, uuid),
  public.booking_change_request_decide(uuid, text, text, integer, uuid),
  public.booking_change_open_version(uuid, uuid)
from public, anon, authenticated, service_role;
grant execute on function public.admin_set_booking_changes_enabled(boolean, text),
  public.booking_change_request_create(uuid, jsonb, uuid),
  public.booking_change_request_resubmit(uuid, integer, jsonb, uuid),
  public.booking_change_request_withdraw(uuid, integer, text, uuid),
  public.booking_change_request_decide(uuid, text, text, integer, uuid),
  public.booking_change_open_version(uuid, uuid)
to authenticated;

commit;
