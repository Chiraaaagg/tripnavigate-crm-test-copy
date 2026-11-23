-- TripNavigate CRM - Accounts phase 3, track H (10): with no active Sales
-- owner (SO* = branch Managers) the branch Manager fills the change version
-- (lead decision, 13 November 2026, after Addendum O2).
--
-- New internal helper (no grant): authz.cr_manager_may_edit(p_version): the
--   version is the change version of a draft or returned change request, the
--   Deal has no active Sales owner, and the caller is a branch Manager of the
--   Deal without Purchase / Flight / Visa (authz.refund_is_m).
-- Replaced (latest bodies, same signatures; changed lines marked
-- "Accounts phase 3 (20261205000790)"): public.booking_save_draft (selling total),
--   public.booking_instalments_save, public.booking_commercials_save: such a
--   Manager may set the selling total and payment plan of that change version
--   only (ordinary drafts unchanged). authz.booking_change_approve_block:
--   not_self_approval for anyone who edited or sent the change version
--   (another Manager of the entity approves, LD37).
-- Rollback (forward-only): a NEW migration restoring the cited bodies.

begin;
set local lock_timeout = '15s';

create function authz.cr_manager_may_edit(p_version uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(authz.session_ok(), false) and exists (
    select 1 from public.booking_versions v
    join public.booking_change_requests r on r.id = v.change_request_id and r.change_version_id = v.id
    join public.deals d on d.id = v.deal_id
    where v.id = p_version and v.status = 'draft' and r.status in ('draft', 'returned')
      and not (d.owner_user_id is not null and authz.is_active_department_person(d.owner_user_id, d.legal_entity_id, 'sales'))
      and authz.refund_is_m(d.id))
$$;
revoke all on function authz.cr_manager_may_edit(uuid) from public, anon, authenticated, service_role;

-- Replaces 20261124000110_booking_form_commands.sql:981 (latest body; changed lines marked).
create or replace function public.booking_save_draft(
  p_version_id uuid, p_expected_row_version integer, p_facts jsonb, p_selling_total_paise bigint,
  p_selling_total_provided boolean
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.booking_versions%rowtype;
  v_keys constant text[] := array['hotelName', 'city', 'checkIn', 'checkOut', 'rooms', 'roomType', 'mealPlan',
    'adults', 'children', 'inclusions', 'specialRequests', 'purchaseBudgetPaise'];
  v_hotel text; v_city text; v_in date; v_out date; v_rooms integer; v_room_type text; v_meal text;
  v_adults integer; v_children integer; v_incl text; v_req text; v_budget bigint;
begin
  select * into v_ver from public.booking_versions v where v.id = p_version_id for update;
  -- Stage 0: a Deal removed by the Bitrix sync takes no new booking work.
  perform authz.refuse_removed_deal(v_ver.deal_id);
  if v_ver.id is null or not authz.can_edit_booking_draft(v_ver.deal_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_ver.status <> 'draft' then  -- B1.1 revision: superseded and discarded too
    raise exception 'already_confirmed' using errcode = '55000';
  end if;
  if p_expected_row_version is null or p_expected_row_version <> v_ver.row_version then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  if p_facts is null or jsonb_typeof(p_facts) <> 'object'
     or exists (select 1 from jsonb_object_keys(p_facts) k where k <> all (v_keys))
     or exists (select 1 from unnest(v_keys) k where not (p_facts ? k)) then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  if p_selling_total_provided is null
     or (p_selling_total_provided and p_selling_total_paise is not null and p_selling_total_paise < 0) then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  -- A4 M3: only a caller who may read the commercial value may send it.
  if p_selling_total_provided and not (authz.can_read_deal_commercial(v_ver.deal_id) or authz.cr_manager_may_edit(v_ver.id)) then  -- Accounts phase 3 (20261205000790)
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  -- Booking form: the total follows from per-person prices while they are in use.
  if p_selling_total_provided and authz.prices_in_use(v_ver.id) then
    raise exception 'priced_per_person' using errcode = '55000';
  end if;

  v_hotel := authz.booking_fact_text(p_facts, 'hotelName', 200, false);
  v_city := authz.booking_fact_text(p_facts, 'city', 120, false);
  v_in := authz.booking_fact_date(p_facts, 'checkIn');
  v_out := authz.booking_fact_date(p_facts, 'checkOut');
  v_rooms := authz.booking_fact_int(p_facts, 'rooms', 1, 50);
  v_room_type := authz.booking_fact_text(p_facts, 'roomType', 120, false);
  v_meal := authz.booking_fact_text(p_facts, 'mealPlan', 60, false);
  v_adults := authz.booking_fact_int(p_facts, 'adults', 1, 100);
  v_children := authz.booking_fact_int(p_facts, 'children', 0, 100);
  v_incl := authz.booking_fact_text(p_facts, 'inclusions', 2000, true);
  v_req := authz.booking_fact_text(p_facts, 'specialRequests', 2000, true);
  v_budget := authz.booking_fact_paise(p_facts, 'purchaseBudgetPaise');

  -- A4 M3 (supersedes A1): not provided -> the commercial row is untouched;
  -- provided -> null clears, a value sets (authorization checked above).
  if p_selling_total_provided then
    if p_selling_total_paise is null then
      delete from public.booking_version_commercials c where c.version_id = v_ver.id;
    else
      insert into public.booking_version_commercials (version_id, legal_entity_id, selling_total_paise)
      values (v_ver.id, v_ver.legal_entity_id, p_selling_total_paise)
      on conflict (version_id) do update
        set selling_total_paise = excluded.selling_total_paise, updated_at = now();
    end if;
  end if;

  update public.booking_versions v
  set hotel_name = v_hotel, city = v_city, check_in = v_in, check_out = v_out, rooms = v_rooms,
      room_type = v_room_type, meal_plan = v_meal, adults = v_adults, children = v_children,
      inclusions = v_incl, special_requests = v_req, purchase_budget_paise = v_budget,
      row_version = v.row_version + 1, updated_at = now()
  where v.id = v_ver.id
  returning * into v_ver;

  -- No amounts or customer content in the audit record.
  perform authz.write_audit('booking.draft_saved', v_ver.legal_entity_id, v_ver.branch_id,
    'booking_version', v_ver.id, null,
    jsonb_build_object('dealId', v_ver.deal_id, 'versionNo', v_ver.version_no, 'rowVersion', v_ver.row_version));
  return jsonb_build_object('versionId', v_ver.id, 'rowVersion', v_ver.row_version, 'contentHash', v_ver.content_hash);
end;
$$;
-- Replaces 20261119000100_b11_book_now.sql:2002 (latest body; changed lines marked).
create or replace function public.booking_instalments_save(p_version_id uuid, p_expected_row_version integer, p_instalments jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.booking_versions%rowtype;
  v_row jsonb;
  v_n integer := 0;
  v_seqs integer[] := '{}'::integer[];
  v_amount text;
begin
  v_ver := authz.lock_package_draft(p_version_id);
  if not (authz.can_read_deal_commercial(v_ver.deal_id) or authz.cr_manager_may_edit(v_ver.id)) then  -- Accounts phase 3 (20261205000790)
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.require_row_version(p_expected_row_version, v_ver.row_version);
  if p_instalments is null or jsonb_typeof(p_instalments) <> 'array' or jsonb_array_length(p_instalments) > 12 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'instalments';
  end if;
  for v_row in select e from jsonb_array_elements(p_instalments) e loop
    v_n := v_n + 1;
    v_amount := case when jsonb_typeof(v_row -> 'amountPaise') in ('string', 'number') then v_row #>> '{amountPaise}' end;
    if jsonb_typeof(v_row) <> 'object'
       or cardinality(authz.b11_unknown_keys(v_row, array['seq', 'label', 'amountPaise', 'dueDate'])) > 0
       or not authz.sf_int_ok(v_row -> 'seq', 1, 12, true)
       or not authz.sf_text_ok(v_row -> 'label', 60, true)
       or v_amount is null or v_amount !~ '^[1-9][0-9]{0,14}$'
       or authz.sf_date(v_row -> 'dueDate') is null
       or (v_row #>> '{seq}')::integer = any (v_seqs) then
      raise exception 'invalid_input' using errcode = '22023', hint = 'instalments[' || v_n::text || ']';
    end if;
    v_seqs := v_seqs || (v_row #>> '{seq}')::integer;
  end loop;
  delete from public.booking_version_instalments p where p.booking_version_id = v_ver.id;
  insert into public.booking_version_instalments (booking_version_id, deal_id, legal_entity_id, seq, label, amount_paise, due_date)
  select v_ver.id, v_ver.deal_id, v_ver.legal_entity_id, (e #>> '{seq}')::integer, authz.b11_text(e -> 'label'),
    (e #>> '{amountPaise}')::bigint, authz.sf_date(e -> 'dueDate')
  from jsonb_array_elements(p_instalments) e;
  v_ver := authz.bump_package_version(v_ver.id);
  perform authz.write_audit('booking.plan_saved', v_ver.legal_entity_id, v_ver.branch_id, 'booking_version', v_ver.id, null,
    jsonb_build_object('dealId', v_ver.deal_id, 'versionNo', v_ver.version_no, 'count', v_n, 'rowVersion', v_ver.row_version));
  return jsonb_build_object('rowVersion', v_ver.row_version, 'contentHash', v_ver.content_hash);
end;
$$;
-- Replaces 20261124000110_booking_form_commands.sql:941 (latest body; changed lines marked).
create or replace function public.booking_commercials_save(p_version_id uuid, p_expected_row_version integer,
  p_list_paise bigint, p_discount_paise bigint, p_total_paise bigint)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.booking_versions%rowtype;
begin
  v_ver := authz.lock_package_draft(p_version_id);
  if not (authz.can_read_deal_commercial(v_ver.deal_id) or authz.cr_manager_may_edit(v_ver.id)) then  -- Accounts phase 3 (20261205000790)
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.require_row_version(p_expected_row_version, v_ver.row_version);
  -- Booking form.
  if authz.prices_in_use(v_ver.id) then
    raise exception 'priced_per_person' using errcode = '55000';
  end if;
  if p_total_paise is null or p_total_paise <= 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'totalPaise';
  end if;
  if p_discount_paise is not null and (p_discount_paise < 0 or p_list_paise is null) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'discountPaise';
  end if;
  if p_list_paise is not null and (p_list_paise < 0 or p_list_paise - coalesce(p_discount_paise, 0) <> p_total_paise) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'listPaise';
  end if;
  insert into public.booking_version_commercials (version_id, legal_entity_id, selling_total_paise, list_price_paise, discount_paise)
  values (v_ver.id, v_ver.legal_entity_id, p_total_paise, p_list_paise, p_discount_paise)
  on conflict (version_id) do update
    set selling_total_paise = excluded.selling_total_paise, list_price_paise = excluded.list_price_paise,
        discount_paise = excluded.discount_paise, updated_at = now();
  v_ver := authz.bump_package_version(v_ver.id);
  -- No amounts in the audit record.
  perform authz.write_audit('booking.commercials_saved', v_ver.legal_entity_id, v_ver.branch_id, 'booking_version', v_ver.id,
    null, jsonb_build_object('dealId', v_ver.deal_id, 'versionNo', v_ver.version_no, 'rowVersion', v_ver.row_version));
  return jsonb_build_object('rowVersion', v_ver.row_version, 'contentHash', v_ver.content_hash);
end;
$$;
-- Replaces 20261205000710_service_change_requests.sql:474 (latest body; changed lines marked).
create or replace function authz.booking_change_approve_block(p_change_request uuid) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  v_row public.booking_change_requests%rowtype;
begin
  -- Accounts phase 3 (20261205000710): switch, route and supplier charges of a service removal (11.1, 11.3, LD30).
  select * into v_row from public.booking_change_requests r where r.id = p_change_request;
  if v_row.id is null then
    return null;
  end if;
  -- Accounts phase 3 (20261205000790) (lead, SO*): nobody who edited or sent the change version approves it.
  if v_row.change_version_id is not null and exists (
       select 1 from public.audit_events a
       where a.legal_entity_id = v_row.legal_entity_id and a.actor_user_id = (select auth.uid())
         and a.occurred_at >= v_row.requested_at and a.action like 'booking.%'
         and ((a.target_type = 'booking_version' and a.target_id = v_row.change_version_id)
              or a.details ->> 'versionId' = v_row.change_version_id::text
              or (a.target_type = 'booking_change_request' and a.target_id = v_row.id and a.action = 'booking.change_submitted'))) then
    return 'not_self_approval';
  end if;
  if v_row.kind = 'change' then
    return null;
  end if;
  if not authz.service_changes_enabled() then
    return 'service_changes_off';
  end if;
  if v_row.kind = 'remove_service' then
    -- Something was booked or paid since the request: it must go through the charges (returned, then sent again).
    if v_row.removal_route = 'simple' and authz.cr_removal_route(v_row.item_ids[1]) = 'cancellation' then
      return 'charges_missing';
    end if;
    if v_row.removal_route = 'cancellation' then
      if exists (select 1 from authz.cr_removal_charges(v_row.id) c where not c.complete) then
        return 'charges_missing';
      end if;
      -- Never approved by a person who entered a current charge.
      if exists (select 1 from authz.cr_removal_charges(v_row.id) c where c.entered_by = (select auth.uid())) then
        return 'not_self_approval';
      end if;
    end if;
  end if;
  return null;
end;
$$;

commit;
