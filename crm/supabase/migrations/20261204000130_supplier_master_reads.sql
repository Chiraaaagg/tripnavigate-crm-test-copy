-- Accounts phase 2, Track A (4): supplier and hotel master — reads.
-- Contract: accounts-phase2-2026-11-11/contract.md sections 5.5 (A10), 5.7
-- (R-A1..R-A3), 10 (fences), 13.4.
--
-- Readers (section 4 / 10): A = Accounts of the entity without Purchase
-- (authz.vn_party_accounts); M = an active Manager of the entity without a
-- Purchase, Flight or Visa membership (AL7); P = Purchase (suppliers that do
-- not serve only flights); F = Flight (suppliers serving flights). Everyone
-- else: null (never a partial object). PAN is masked (XXXXX1234X) except for
-- A and M; the Tally ledger name is for A and M only. No bank account
-- number, IFSC or holder leaves these reads (bank state and the last 4
-- digits only).
--
-- New:
--   public.supplier_register(p_filter jsonb, p_after text, p_limit integer)
--     -> {items [{supplierId, name, kind, serviceTypes, city, stateCode, gstin,
--        panMasked, verification, bankState, primaryContact {name, phone,
--        email}|null, hotelCount, rowVersion, status}], nextAfter}
--     filter keys: q (name prefix on the name key, or an exact GSTIN / PAN),
--     kind, serviceType, city, verification, bankState
--     (approved|on_hold|none), hotelId, status. Keyset on (name_key, id):
--     p_after = '<nameKey>|<supplierId>'; limit 1..100 (default 50).
--   public.supplier_master_get(p_supplier_id uuid) -> the register row plus
--     {legalEntityId, pan, address, tallyLedgerName, sourceRef, paymentTerms,
--     bank {revisionNo, status, accountLast4}|null, contacts, hotels,
--     duplicates, history (last 100), can {edit, verify, linkHotel, approveBank}}.
--   public.hotel_suppliers(p_hotel_id uuid) -> {hotelId, suppliers
--     [{supplierId, name, kind, verification, bankState}]} for P, M, A.
-- Replaced (additive keys only):
--   public.purchase_workspace (M/20261130000120:110): catalogueHotelId,
--     catalogueHotelName, hotelSuppliers (13.4) — hotel tasks; null / [] otherwise.
--   public.booking_form_get (M/20261203000100:445): hotel items gain an
--     item-level catalogueHotelId (from service_item_facts.catalogue_hotel_id;
--     not inside facts, whose readers use a fixed key list).
--
-- Refusal tokens: 42501 not_authorized (no valid session); 22023
-- invalid_input (hint filter | after | limit).
--
-- Rollback (forward-only): a new migration revoking the new reads and
-- restoring purchase_workspace and booking_form_get from the migrations cited.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Helpers
-- ===========================================================================

-- {a, m, p, f}: the supplier reader roles of the caller in an entity.
create function authz.supplier_reader(p_entity uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'a', coalesce(authz.vn_party_accounts(p_entity), false),
    'm', coalesce(authz.session_ok(), false) and authz.holds_active_role('manager', p_entity)
         and not exists (select 1 from public.memberships m
                         where m.user_id = (select auth.uid()) and m.legal_entity_id = p_entity
                           and m.role_code in ('purchase', 'flight', 'visa') and m.status = 'active'),
    'p', coalesce(authz.session_ok(), false) and authz.holds_active_role('purchase', p_entity),
    'f', coalesce(authz.session_ok(), false) and authz.holds_active_role('flight', p_entity))
$$;

-- The caller may read this supplier (a or m, or p for non-flight-only, or f for flight suppliers).
create function authz.supplier_visible(p_reader jsonb, p_types text[]) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce((p_reader ->> 'a')::boolean or (p_reader ->> 'm')::boolean
    or ((p_reader ->> 'p')::boolean and not (p_types <@ array['flight']))
    or ((p_reader ->> 'f')::boolean and 'flight' = any (p_types)), false)
$$;

-- approved | on_hold (latest revision not approved) | none.
create function authz.supplier_bank_state(p_supplier uuid) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce((select case when r.status = 'approved' then 'approved' else 'on_hold' end
                   from public.supplier_beneficiary_revisions r
                   where r.supplier_id = p_supplier order by r.revision_no desc limit 1), 'none')
$$;

-- Active suppliers linked to a hotel (R-A3 rows; the quote picker lists them first).
create function authz.hotel_supplier_rows(p_hotel uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('supplierId', s.id, 'name', s.name, 'kind', s.supplier_kind,
      'verification', s.verification_status, 'bankState', authz.supplier_bank_state(s.id))
      order by (s.verification_status = 'verified') desc, s.name_key, s.id), '[]'::jsonb)
  from public.supplier_hotels l
  join public.suppliers s on s.id = l.supplier_id
  where l.hotel_id = p_hotel and l.status = 'active' and s.status = 'active'
$$;

-- ===========================================================================
-- 2. R-A1 supplier register
-- ===========================================================================

create function public.supplier_register(p_filter jsonb, p_after text, p_limit integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_filter jsonb := coalesce(p_filter, '{}'::jsonb);
  v_am uuid[] := '{}';
  v_p uuid[] := '{}';
  v_f uuid[] := '{}';
  v_e uuid;
  v_r jsonb;
  v_limit integer := coalesce(p_limit, 50);
  v_after_key text;
  v_after_id uuid;
  v_q text;
  v_qkey text;
  v_qcode text;
  v_hotel uuid;
  v_rows jsonb;
  v_n integer;
  v_last jsonb;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  foreach v_e in array authz.vn_member_entities() loop
    v_r := authz.supplier_reader(v_e);
    if (v_r ->> 'a')::boolean or (v_r ->> 'm')::boolean then v_am := v_am || v_e; end if;
    if (v_r ->> 'p')::boolean then v_p := v_p || v_e; end if;
    if (v_r ->> 'f')::boolean then v_f := v_f || v_e; end if;
  end loop;
  if cardinality(v_am) + cardinality(v_p) + cardinality(v_f) = 0 then
    return null;
  end if;
  if jsonb_typeof(v_filter) <> 'object'
     or (v_filter - array['q', 'kind', 'serviceType', 'city', 'verification', 'bankState', 'hotelId', 'status']) <> '{}'::jsonb
     or exists (select 1 from jsonb_each(v_filter) e where jsonb_typeof(e.value) not in ('string', 'null'))
     or coalesce(v_filter ->> 'kind', 'direct') not in ('direct', 'channel')
     or coalesce(v_filter ->> 'serviceType', 'hotel') not in ('hotel', 'transfer', 'activity', 'flight')
     or coalesce(v_filter ->> 'verification', 'verified') not in ('verified', 'unverified')
     or coalesce(v_filter ->> 'bankState', 'none') not in ('approved', 'on_hold', 'none')
     or coalesce(v_filter ->> 'status', 'active') not in ('active', 'archived')
     or coalesce(v_filter ->> 'hotelId', '00000000-0000-4000-8000-000000000000')
        !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or char_length(coalesce(v_filter ->> 'q', '')) > 100 or char_length(coalesce(v_filter ->> 'city', '')) > 120 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'filter';
  end if;
  if v_limit < 1 or v_limit > 100 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'limit';
  end if;
  if p_after is not null then
    if p_after !~ '^[a-z0-9]*\|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'invalid_input' using errcode = '22023', hint = 'after';
    end if;
    v_after_key := split_part(p_after, '|', 1);
    v_after_id := split_part(p_after, '|', 2)::uuid;
  end if;
  v_q := nullif(btrim(coalesce(v_filter ->> 'q', '')), '');
  v_qcode := upper(regexp_replace(coalesce(v_q, ''), '\s', '', 'g'));
  v_qkey := authz.supplier_name_key(v_q);
  v_hotel := (v_filter ->> 'hotelId')::uuid;

  select coalesce(jsonb_agg(x.row order by x.name_key, x.id), '[]'::jsonb), count(*)::integer
  into v_rows, v_n
  from (
    select s.id, s.name_key, jsonb_build_object(
        'supplierId', s.id, 'name', s.name, 'kind', s.supplier_kind, 'serviceTypes', to_jsonb(s.service_types),
        'city', s.city, 'stateCode', s.state_code, 'gstin', s.gstin, 'panMasked', authz.acct_mask_pan(s.pan),
        'verification', s.verification_status,
        'bankState', case when br.status is null then 'none' when br.status = 'approved' then 'approved' else 'on_hold' end,
        'primaryContact', (select jsonb_build_object('name', c.name, 'phone', c.phone, 'email', c.email)
                           from public.supplier_contacts c
                           where c.supplier_id = s.id and c.status = 'active' and c.is_primary),
        'hotelCount', (select count(*) from public.supplier_hotels l where l.supplier_id = s.id and l.status = 'active'),
        'rowVersion', s.row_version, 'status', s.status) as row
    from public.suppliers s
    left join lateral (select r.status from public.supplier_beneficiary_revisions r
                       where r.supplier_id = s.id order by r.revision_no desc limit 1) br on true
    where (s.legal_entity_id = any (v_am)
           or (s.legal_entity_id = any (v_p) and not (s.service_types <@ array['flight']))
           or (s.legal_entity_id = any (v_f) and 'flight' = any (s.service_types)))
      and (v_q is null
           or (v_qcode ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$' and s.gstin = v_qcode)
           or (v_qcode ~ '^[A-Z]{5}[0-9]{4}[A-Z]$' and s.pan = v_qcode)
           or (v_qkey <> '' and s.name_key like v_qkey || '%'))
      and (v_filter ->> 'kind' is null or s.supplier_kind = v_filter ->> 'kind')
      and (v_filter ->> 'serviceType' is null or (v_filter ->> 'serviceType') = any (s.service_types))
      and (nullif(btrim(coalesce(v_filter ->> 'city', '')), '') is null or lower(s.city) = lower(btrim(v_filter ->> 'city')))
      and (v_filter ->> 'verification' is null or s.verification_status = v_filter ->> 'verification')
      and (v_filter ->> 'status' is null or s.status = v_filter ->> 'status')
      and (v_filter ->> 'bankState' is null
           or (v_filter ->> 'bankState' = 'none' and br.status is null)
           or (v_filter ->> 'bankState' = 'approved' and br.status = 'approved')
           or (v_filter ->> 'bankState' = 'on_hold' and br.status is not null and br.status <> 'approved'))
      and (v_hotel is null or exists (select 1 from public.supplier_hotels l
                                      where l.supplier_id = s.id and l.hotel_id = v_hotel and l.status = 'active'))
      and (v_after_id is null or (s.name_key, s.id) > (v_after_key, v_after_id))
    order by s.name_key, s.id
    limit v_limit + 1
  ) x;
  if v_n > v_limit then
    v_rows := v_rows - v_limit;
    v_last := v_rows -> (v_limit - 1);
  end if;
  return jsonb_build_object('items', v_rows,
    'nextAfter', case when v_last is null then null
                      else (select s.name_key || '|' || s.id from public.suppliers s where s.id = (v_last ->> 'supplierId')::uuid) end);
end;
$$;

-- ===========================================================================
-- 3. R-A2 supplier master (one supplier)
-- ===========================================================================

create function public.supplier_master_get(p_supplier_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_s public.suppliers%rowtype;
  v_r jsonb;
  v_unmask boolean;
  v_uid uuid := (select auth.uid());
  v_bank public.supplier_beneficiary_revisions%rowtype;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_s from public.suppliers s where s.id = p_supplier_id;
  if v_s.id is null then
    return null;
  end if;
  v_r := authz.supplier_reader(v_s.legal_entity_id);
  if not authz.supplier_visible(v_r, v_s.service_types) then
    return null;
  end if;
  v_unmask := (v_r ->> 'a')::boolean or (v_r ->> 'm')::boolean;
  select * into v_bank from public.supplier_beneficiary_revisions b
  where b.supplier_id = v_s.id order by b.revision_no desc limit 1;
  return jsonb_build_object(
    'supplierId', v_s.id, 'legalEntityId', v_s.legal_entity_id, 'name', v_s.name, 'kind', v_s.supplier_kind,
    'serviceTypes', to_jsonb(v_s.service_types), 'city', v_s.city, 'stateCode', v_s.state_code, 'gstin', v_s.gstin,
    'panMasked', authz.acct_mask_pan(v_s.pan),
    'pan', case when v_unmask then v_s.pan else authz.acct_mask_pan(v_s.pan) end,
    'verification', v_s.verification_status,
    'verifiedAt', v_s.verified_at,
    'verifiedByName', (select p.display_name from public.staff_profiles p where p.user_id = v_s.verified_by),
    'bankState', case when v_bank.id is null then 'none' when v_bank.status = 'approved' then 'approved' else 'on_hold' end,
    'bank', case when v_bank.id is null then null else jsonb_build_object('revisionNo', v_bank.revision_no,
      'status', v_bank.status, 'accountLast4', right(v_bank.account_number, 4)) end,
    'primaryContact', (select jsonb_build_object('name', c.name, 'phone', c.phone, 'email', c.email)
                       from public.supplier_contacts c
                       where c.supplier_id = v_s.id and c.status = 'active' and c.is_primary),
    'hotelCount', (select count(*) from public.supplier_hotels l where l.supplier_id = v_s.id and l.status = 'active'),
    'rowVersion', v_s.row_version, 'status', v_s.status,
    'address', v_s.address,
    'tallyLedgerName', case when v_unmask then v_s.tally_ledger_name end,
    'sourceRef', v_s.source_ref,
    'paymentTerms', v_s.payment_terms,
    'updatedAt', v_s.updated_at,
    'contacts', coalesce((
      select jsonb_agg(jsonb_build_object('contactId', c.id, 'name', c.name, 'roleLabel', c.role_label, 'phone', c.phone,
          'email', c.email, 'isPrimary', c.is_primary, 'rowVersion', c.row_version, 'updatedAt', c.updated_at)
          order by c.is_primary desc, c.name, c.id)
      from public.supplier_contacts c where c.supplier_id = v_s.id and c.status = 'active'), '[]'::jsonb),
    'hotels', coalesce((
      select jsonb_agg(jsonb_build_object('linkId', l.id, 'hotelId', h.id, 'name', h.name, 'city', h.city,
          'source', l.source, 'createdAt', l.created_at) order by h.name_key, h.city, l.id)
      from public.supplier_hotels l join public.hotel_catalogue h on h.id = l.hotel_id
      where l.supplier_id = v_s.id and l.status = 'active'), '[]'::jsonb),
    'duplicates', authz.supplier_warnings(v_s.id),
    'history', coalesce((
      select jsonb_agg(jsonb_build_object('changedAt', y.changed_at, 'changedByName', y.display_name, 'source', y.source,
          'field', y.field,
          'oldValue', case when y.field = 'pan' and not v_unmask then authz.acct_mask_pan(y.old_value) else y.old_value end,
          'newValue', case when y.field = 'pan' and not v_unmask then authz.acct_mask_pan(y.new_value) else y.new_value end)
          order by y.changed_at desc, y.id desc)
      from (select c.*, p.display_name from public.supplier_changes c
            left join public.staff_profiles p on p.user_id = c.changed_by
            where c.supplier_id = v_s.id and (v_unmask or c.field <> 'tally_ledger_name')
            order by c.changed_at desc, c.id desc limit 100) y), '[]'::jsonb),
    'can', jsonb_build_object(
      'edit', authz.supplier_can_edit(v_s.id),
      'verify', authz.can_verify_suppliers(v_s.legal_entity_id) and v_s.status = 'active'
                and v_s.verification_status = 'unverified' and v_s.updated_by is distinct from v_uid
                and v_s.created_by is distinct from v_uid,
      'linkHotel', authz.can_manage_suppliers(v_s.legal_entity_id) and 'hotel' = any (v_s.service_types),
      'approveBank', authz.can_verify_suppliers(v_s.legal_entity_id) and v_bank.id is not null
                     and v_bank.status = 'unverified' and v_bank.created_by is distinct from v_uid));
end;
$$;

-- ===========================================================================
-- 4. R-A3 suppliers of one hotel
-- ===========================================================================

create function public.hotel_suppliers(p_hotel_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_h public.hotel_catalogue%rowtype;
  v_r jsonb;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_h from public.hotel_catalogue h where h.id = p_hotel_id;
  if v_h.id is null then
    return null;
  end if;
  v_r := authz.supplier_reader(v_h.legal_entity_id);
  if not ((v_r ->> 'a')::boolean or (v_r ->> 'm')::boolean or (v_r ->> 'p')::boolean) then
    return null;
  end if;
  return jsonb_build_object('hotelId', v_h.id, 'suppliers', authz.hotel_supplier_rows(v_h.id));
end;
$$;

-- ===========================================================================
-- 5. Purchase workspace (13.4; replaces 20261130000120, additive keys)
-- ===========================================================================

create or replace function public.purchase_workspace(p_task_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_uid uuid := (select auth.uid());
  v_manager boolean;
  v_latest public.purchase_cost_versions;
  v_budget bigint;
  v_hotel_id uuid;  -- Accounts phase 2
begin
  if not authz.session_ok() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id;
  if v_task.id is null or not authz.can_read_purchase_workspace(v_task.id) then
    return null;
  end if;
  v_manager := authz.can_manage_purchase_task(v_task.id);
  v_latest := authz.purchase_latest_cost(v_task.id);
  v_budget := authz.task_budget(v_task.id);
  -- Accounts phase 2: hotel tasks carry the booking's catalogue hotel (service_item_facts column).
  if v_task.service_purpose = 'hotel' then
    select f.catalogue_hotel_id into v_hotel_id from public.service_item_facts f
    where f.service_item_id = v_task.service_item_id and f.booking_version_id = authz.task_current_version(v_task.id);
  end if;
  return jsonb_build_object(
    'task', authz.purchase_task_json(v_task.id, true),
    'canWork', authz.can_work_purchase_task(v_task.id) and v_task.status = 'in_progress',
    'canRelease', authz.can_work_purchase_task(v_task.id) and v_task.status = 'in_progress',
    'canReassign', v_manager and v_task.status = 'in_progress',
    'canApproveOverBudget', v_manager and v_task.status = 'in_progress' and v_latest.id is not null
      and v_latest.stage = 'proposed' and (v_budget is null or v_latest.amount_paise > v_budget)
      and not authz.cost_version_approved(v_task.id, v_latest.version_no)
      and v_latest.created_by is distinct from v_uid
      and authz.procurement_gate_issue(v_task.id) is null,
    'assigneeUserId', v_task.assignee_user_id,
    'reassignCandidates', case when v_manager and v_task.status = 'in_progress' then coalesce((
      select jsonb_agg(jsonb_build_object('userId', p.user_id, 'name', p.display_name) order by p.display_name, p.user_id)
      from public.staff_profiles p
      where p.user_id is distinct from v_task.assignee_user_id
        -- Batch 6: candidates of the task's department (same rule as purchase_task_reassign).
        and authz.is_active_department_person(p.user_id, v_task.legal_entity_id, v_task.department)), '[]'::jsonb)
      else '[]'::jsonb end,
    'gateIssue', authz.procurement_gate_issue(v_task.id),
    'issues', case when v_task.status = 'in_progress' then to_jsonb(authz.procurement_issues(v_task.id))
                   else '[]'::jsonb end,
    'supplierReference', v_task.supplier_reference,
    'selectedQuoteId', v_task.selected_quote_id,
    'supplierConfirmedByName', (select p.display_name from public.staff_profiles p
                                where p.user_id = v_task.supplier_confirmed_by),
    'quotes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'quoteId', q.id,
        'supplierId', q.supplier_id,
        'supplierName', s.name,
        'supplierVerification', s.verification_status,
        'hotelName', q.hotel_name,
        'roomType', q.room_type,
        'mealPlan', q.meal_plan,
        'quotedCostPaise', q.quoted_cost_paise::text,
        'holdUntil', to_char(q.hold_until, 'YYYY-MM-DD'),
        'cancellationTerms', q.cancellation_terms,
        'status', q.status,
        'createdAt', q.created_at,
        'createdByName', p.display_name,
        -- Purchase build.
        'perRoomNightPaise', q.per_room_night_paise::text,
        'note', q.note) order by q.created_at, q.id)
      from public.purchase_quotes q
      join public.suppliers s on s.id = q.supplier_id
      left join public.staff_profiles p on p.user_id = q.created_by
      where q.task_id = v_task.id), '[]'::jsonb),
    'costVersions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'versionNo', c.version_no,
        'quoteId', c.quote_id,
        'stage', c.stage,
        'amountPaise', c.amount_paise::text,
        'dueDate', to_char(c.due_date, 'YYYY-MM-DD'),
        'note', c.note,
        'payableStatus', c.payable_status,
        'createdAt', c.created_at,
        'createdByName', p.display_name,
        'overBudgetApprovedAt', a.approved_at,
        'overBudgetApprovedByName', ap.display_name) order by c.version_no desc)
      from public.purchase_cost_versions c
      left join public.staff_profiles p on p.user_id = c.created_by
      left join public.purchase_cost_approvals a on a.task_id = c.task_id and a.version_no = c.version_no
      left join public.staff_profiles ap on ap.user_id = a.approved_by
      where c.task_id = v_task.id), '[]'::jsonb),
    'evidence', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', e.id,
        'kind', e.kind,
        'fileName', e.file_name,
        'mime', e.mime,
        'sizeBytes', e.size_bytes,
        'status', e.status,
        'createdAt', e.created_at,
        'uploadedByName', p.display_name) order by e.created_at, e.id)
      from public.purchase_evidence e
      left join public.staff_profiles p on p.user_id = e.uploaded_by
      where e.task_id = v_task.id and e.status <> 'removed'), '[]'::jsonb),
    -- Purchase build: go-ahead, e-mails (no provider details), trip cancellation, e-mail switch.
    'goAhead', authz.purchase_go_ahead_json(v_task.id),
    'emails', coalesce((
      select jsonb_agg(jsonb_build_object(
        'emailId', m.id,
        'kind', m.kind,
        'supplierId', m.supplier_id,
        'supplierName', s.name,
        'toEmail', m.to_email,
        'ccEmails', to_jsonb(m.cc_emails),
        'subject', m.subject,
        'body', m.body,
        'status', m.status,
        'costVersionNo', m.cost_version_no,
        'sentAt', m.sent_at,
        'sentByName', p.display_name,
        'failed', m.status = 'failed') order by m.sent_at desc, m.id desc)
      from public.purchase_supplier_emails m
      join public.suppliers s on s.id = m.supplier_id
      left join public.staff_profiles p on p.user_id = m.sent_by
      where m.task_id = v_task.id), '[]'::jsonb),
    'cancellation', authz.task_cancellation_json(v_task.id),
    'emailSendingEnabled', authz.supplier_email_sending_enabled())
    -- Accounts phase 2 (20261204000130, 13.4): the booking's catalogue hotel and who sells it.
    || jsonb_build_object(
      'catalogueHotelId', v_hotel_id,
      'catalogueHotelName', (select h.name from public.hotel_catalogue h where h.id = v_hotel_id),
      'hotelSuppliers', case when v_hotel_id is null then '[]'::jsonb
                             else coalesce(authz.hotel_supplier_rows(v_hotel_id), '[]'::jsonb) end);
end;
$$;

-- ===========================================================================
-- 6. Booking form (A10; replaces 20261203000100, hotel items + catalogueHotelId)
-- ===========================================================================

create or replace function public.booking_form_get(p_deal_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_ver public.booking_versions;
  v_result jsonb;
  v_billing public.customer_billing_profiles;
  v_id_proof_view boolean;  -- B1.2
begin
  if not authz.session_ok() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_deal_id is null or not (authz.can_edit_booking_draft(p_deal_id) or authz.can_confirm_booking(p_deal_id)) then
    return null;
  end if;
  v_ver := authz.deal_current_version(p_deal_id);
  select * into v_billing from public.customer_billing_profiles b where b.deal_id = p_deal_id;
  -- B1.2: identity-proof viewer (DEC-41), never on a Deal removed by the sync (review D3-4, D3-8).
  v_id_proof_view := authz.id_proof_viewer_role(p_deal_id) is not null
    and not exists (select 1 from public.deals d where d.id = p_deal_id and d.removed_at is not null);

  v_result := jsonb_build_object(
    'dealId', p_deal_id,
    'canEdit', coalesce(v_ver.status, 'draft') = 'draft' and authz.can_edit_booking_draft(p_deal_id),
    'canConfirm', v_ver.status = 'draft' and authz.can_confirm_booking(p_deal_id),
    -- Review A3: may see and edit the selling price and payment plan.
    'canEditCommercials', authz.can_read_deal_commercial(p_deal_id),
    'serviceItemsEnabled', authz.service_items_enabled(),
    'visaPassportTasksEnabled', authz.visa_passport_tasks_enabled(),
    'dealNotActive', authz.deal_not_active(p_deal_id),
    'version', case when v_ver.id is null then null else jsonb_build_object(
      'versionId', v_ver.id, 'versionNo', v_ver.version_no, 'status', v_ver.status, 'serviceType', v_ver.service_type,
      'rowVersion', v_ver.row_version, 'contentHash', v_ver.content_hash, 'updatedAt', v_ver.updated_at,
      'updatedByName', (select p.display_name from public.staff_profiles p where p.user_id = v_ver.updated_by),
      'confirmedAt', v_ver.confirmed_at,
      'formRules', v_ver.form_rules) end,
    -- Booking form: party counts.
    'party', case when v_ver.id is null then null
                  else jsonb_build_object('total', v_ver.pax_total, 'children', v_ver.children_count,
                                          'infants', v_ver.infants_count,
                                          'adults', v_ver.adults_count) end,  -- VN
    'coverage', case when v_ver.id is null then null else authz.bf_hotel_coverage(v_ver.id) end,
    'itemFilesCanEdit', authz.id_proof_can_edit(p_deal_id),
    'trip', jsonb_build_object('destination', v_ver.trip_destination, 'scope', v_ver.trip_scope,
      'start', to_char(v_ver.trip_start, 'YYYY-MM-DD'), 'end', to_char(v_ver.trip_end, 'YYYY-MM-DD')),
    'contacts', (select jsonb_build_object('contactName', c.contact_name, 'mobile', c.mobile, 'email', c.email,
        'contactConfirmed', c.contact_confirmed, 'confirmedAt', c.confirmed_at,
        'confirmedByName', (select p.display_name from public.staff_profiles p where p.user_id = c.confirmed_by),
        'bookingFor', c.booking_for, 'payerDifferent', c.payer_different, 'payerName', c.payer_name,
        'customerType', c.customer_type, 'market', c.market)
      from public.booking_version_contacts c where c.booking_version_id = v_ver.id),
    'billing', case when v_billing.deal_id is null
      then jsonb_build_object('status', 'none', 'prefillSource', null, 'rowVersion', 0)
      else jsonb_build_object('status', v_billing.status, 'prefillSource', v_billing.prefill_source,
        'rowVersion', v_billing.row_version, 'billingName', v_billing.billing_name,
        'addressLine1', v_billing.address_line1, 'addressLine2', v_billing.address_line2, 'city', v_billing.city,
        'stateCode', v_billing.state_code, 'postalCode', v_billing.postal_code, 'gstin', v_billing.gstin,
        -- Booking form: Bill To.
        'billToType', v_billing.bill_to_type, 'contactPerson', v_billing.contact_person, 'phone', v_billing.phone,
        'email', v_billing.email, 'gstStatus', v_billing.gst_status, 'gstReason', v_billing.gst_reason,
        'verifiedByName', (select p.display_name from public.staff_profiles p where p.user_id = v_billing.verified_by),
        'verifiedAt', v_billing.verified_at,
        -- VN: the bill-to party this billing was copied from (reference) and its current check state.
        'partyId', v_billing.party_id,
        'partyCheckStatus', (select cp.check_status from public.customer_parties cp where cp.id = v_billing.party_id)) end,
    'travellers', coalesce((
      select jsonb_agg(jsonb_build_object('travellerId', t.id, 'seq', t.seq, 'fullName', t.full_name, 'type', t.traveller_type,
          'ageYears', t.age_years, 'specialNeeds', t.special_needs,
          'specialRequests', to_jsonb(t.special_requests),  -- VN
          'identity', case when authz.can_read_traveller_identity(p_deal_id, t.seq)
                           then authz.booking_identity_json(p_deal_id, t.seq, null)
                                -- Booking form: passenger extras (live identity row); VN extraPhones.
                                || coalesce((select jsonb_build_object('dateOfMarriage', to_char(x.date_of_marriage, 'YYYY-MM-DD'),
                                               'phone', x.phone, 'email', x.email, 'extraPhones', to_jsonb(x.extra_phones))
                                             from public.traveller_identities x where x.traveller_id = t.id),
                                            jsonb_build_object('dateOfMarriage', null, 'phone', null, 'email', null,
                                                               'extraPhones', '[]'::jsonb)) end)
          -- B1.2: identity proofs of this traveller, only for identity-proof viewers (DEC-41).
          || case when v_id_proof_view
                  then jsonb_build_object('idProofs', authz.traveller_id_proofs_json(t.id)) else '{}'::jsonb end
          order by t.seq)
      from public.deal_travellers t where t.deal_id = p_deal_id), '[]'::jsonb),
    'items', coalesce((
      -- BF2 (review round 1): the Purchase budget for commercial readers only.
      select jsonb_agg(authz.service_item_json(i.id, v_ver.id, authz.can_read_deal_commercial(p_deal_id))
          || jsonb_build_object('participants', to_jsonb(authz.item_participant_seqs(i.id, v_ver.id)))
          -- Accounts phase 2 (20261204000130, LD22): hotel items carry the catalogue hotel id (kept in a
          -- column, not in facts; item-level key because readers parse hotel facts with a fixed key list).
          || case when i.service_type = 'hotel' then jsonb_build_object('catalogueHotelId', (
               select f.catalogue_hotel_id from public.service_item_facts f
               where f.service_item_id = i.id and f.booking_version_id = v_ver.id)) else '{}'::jsonb end
          -- Booking form: supplier estimate (commercial readers) and item files (file viewers).
          || case when authz.can_read_deal_commercial(p_deal_id)
                  then jsonb_build_object('estimate', authz.bf_estimate_json(i.id, v_ver.id)) else '{}'::jsonb end
          || case when i.service_type = 'flight' and authz.service_item_file_viewer(i.id) is not null
                  then jsonb_build_object('files', authz.service_item_files_json(i.id)) else '{}'::jsonb end
          order by i.item_no)
      from public.service_items i where i.deal_id = p_deal_id), '[]'::jsonb),
    'evidence', coalesce((
      select jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'fileName', e.file_name, 'mime', e.mime,
          'sizeBytes', e.size_bytes, 'status', e.status, 'uploadedByYou', e.uploaded_by = (select auth.uid()),
          'createdAt', e.created_at, 'storedAt', e.stored_at) order by e.created_at, e.id)
      from public.booking_evidence e where e.version_id = v_ver.id and e.status <> 'removed'), '[]'::jsonb));

  if authz.can_read_deal_commercial(p_deal_id) then
    v_result := v_result
      || jsonb_build_object('commercials', (select jsonb_build_object(
           'listPricePaise', c.list_price_paise::text, 'discountPaise', c.discount_paise::text,
           'sellingTotalPaise', c.selling_total_paise::text)
         from public.booking_version_commercials c where c.version_id = v_ver.id))
      || jsonb_build_object('plan', coalesce((
           select jsonb_agg(jsonb_build_object('seq', p.seq, 'label', p.label, 'amountPaise', p.amount_paise::text,
             'dueDate', to_char(p.due_date, 'YYYY-MM-DD')) order by p.seq)
           from public.booking_version_instalments p where p.booking_version_id = v_ver.id), '[]'::jsonb))
      -- Booking form: per-person prices (commercial readers only; absent otherwise).
      || case when v_ver.id is null then '{}'::jsonb else jsonb_build_object('prices', authz.bf_prices_json(v_ver.id)) end
      -- BF2: typed total fare per person of all flights (commercial readers only; null = none typed).
      || case when v_ver.id is null then '{}'::jsonb
              else jsonb_build_object('flightFareTotals', authz.bf2_flight_fare_totals_json(v_ver.id)) end;
  end if;
  -- B1.2: identity-proof limits as the commands enforce them, and whether the
  -- caller may attach or remove proofs now (also after submission).
  v_result := v_result || jsonb_build_object('idProofLimits',
    jsonb_build_object('maxFilesPerTraveller', 4, 'maxBytes', authz.id_proof_max_bytes()),
    'idProofCanEdit', authz.id_proof_can_edit(p_deal_id),
    'idProofCanRemove', authz.id_proof_can_remove(p_deal_id));
  -- B1.2 (quotations): the accepted quotation version this draft came from (null otherwise).
  v_result := v_result || jsonb_build_object('sourceQuotation', (
    select jsonb_build_object('quotationId', q.id, 'reference', q.reference, 'versionId', qv.id, 'versionNo', qv.version_no,
      'acceptedAt', qv.accepted_at, 'acceptedTierKey', qv.accepted_tier, 'acceptanceEvidenceId', qv.acceptance_evidence_id)
    from public.quotation_versions qv join public.quotations q on q.id = qv.quotation_id
    where qv.id = v_ver.source_quotation_version_id));
  -- B1.2 0600: Bitrix values for "Use Bitrix values" (DEC-36); the caller is a booking editor or acceptor.
  v_result := v_result || jsonb_build_object('prefill', authz.prefill_view('deal', p_deal_id, 'booking_version', v_ver.id,
    authz.can_read_deal_commercial(p_deal_id)));
  -- VN: trip facts from Bitrix and their source per field.
  v_result := v_result || jsonb_build_object('tripFacts', authz.vn_trip_facts_json(p_deal_id, v_ver.id));
  -- BF2: the Deal's page in Bitrix ("Open the Deal in Bitrix"); null for a Deal not imported from Bitrix.
  v_result := v_result || jsonb_build_object('bitrixDealHref', (
    select 'https://' || c.portal_domain || '/crm/deal/details/' || d.source_deal_id::text || '/'
    from public.deals d
    join public.integration_intake_config c on c.portal_member_id = d.source_portal
    where d.id = p_deal_id and d.source_system = 'bitrix' and d.source_deal_id is not null));
  -- BF2 (ruling D5, review round 1): an ID proof stored now would also be copied to
  -- the Bitrix Deal (same rule as authz.id_proof_copy_enqueue, 20261120000700).
  v_result := v_result || jsonb_build_object('idProofCopyApplies', exists (
    select 1 from public.deals d
    join public.integration_intake_config c on c.portal_member_id = d.source_portal and c.enabled and c.bitrix_id_proof_copy
    where d.id = p_deal_id and d.source_system = 'bitrix' and d.source_deal_id is not null and d.removed_at is null));
  -- Visa build (20261202000200) (QB1): the highest traveller number this Deal ever used;
  -- the form numbers new passengers above it.
  v_result := v_result || jsonb_build_object('travellerSeqHigh', authz.deal_traveller_seq_high(p_deal_id));
  -- Accounts phase (20261203000100): adults need a stored ID proof unless the
  -- version the form shows is flight-only (true without a version or services).
  v_result := v_result || jsonb_build_object('idProofRequired', not authz.version_flight_only(v_ver.id));
  return v_result;
end;
$$;
-- ===========================================================================
-- 7. Privileges
-- ===========================================================================

revoke all on function authz.supplier_reader(uuid), authz.supplier_visible(jsonb, text[]),
  authz.supplier_bank_state(uuid), authz.hotel_supplier_rows(uuid)
from public, anon, authenticated, service_role;
revoke all on function public.supplier_register(jsonb, text, integer), public.supplier_master_get(uuid),
  public.hotel_suppliers(uuid)
from public, anon, authenticated, service_role;
grant execute on function public.supplier_register(jsonb, text, integer), public.supplier_master_get(uuid),
  public.hotel_suppliers(uuid)
to authenticated;

commit;
