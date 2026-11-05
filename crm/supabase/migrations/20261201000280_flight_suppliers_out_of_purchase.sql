-- Flight build, Track B (9): flight-only suppliers stay out of the Purchase
-- supplier register (lead decision, option a). Since 20261201000200
-- suppliers may serve 'flight'; Purchase's supplier reads (and their TS
-- schemas, which accept hotel/transfer/activity only) must not receive
-- suppliers whose types are only {flight}.
--
-- Replaced (same signatures, bodies of 20261005000200 plus one filter):
--   public.supplier_list()  leaves out suppliers with service_types <@ {flight}.
--   public.supplier_get()   returns null for them (the page shows "not available").
-- Hotel, transfer and activity suppliers: unchanged. Flight reads its
-- suppliers through flight_supplier_list; the branch Manager still verifies
-- them and approves their bank details from manager_approvals (its rows
-- carry serviceTypes as plain strings).
--
-- Rollback (forward-only): a NEW migration restoring the 20261005000200 bodies.

begin;
set local lock_timeout = '15s';

create or replace function public.supplier_list() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not authz.session_ok() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(authz.supplier_json(s.id) order by s.status, lower(s.name), s.id)
    from public.suppliers s
    where authz.can_review_suppliers(s.legal_entity_id)
      -- 20261201000280: flight-only suppliers belong to Flight (flight_supplier_list).
      and not (s.service_types <@ array['flight'])
  ), '[]'::jsonb);
end;
$$;

create or replace function public.supplier_get(p_supplier_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_s public.suppliers%rowtype;
  v_uid uuid := (select auth.uid());
  v_manager boolean;
  v_latest integer;
begin
  if not authz.session_ok() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_s from public.suppliers s where s.id = p_supplier_id;
  if v_s.id is null or not authz.can_review_suppliers(v_s.legal_entity_id)
     -- 20261201000280: flight-only suppliers are not in the Purchase register.
     or v_s.service_types <@ array['flight'] then
    return null;
  end if;
  v_manager := authz.can_verify_suppliers(v_s.legal_entity_id);
  select max(r.revision_no) into v_latest from public.supplier_beneficiary_revisions r where r.supplier_id = v_s.id;
  return authz.supplier_json(v_s.id) || jsonb_build_object(
    'canEdit', authz.can_manage_suppliers(v_s.legal_entity_id),
    'canVerify', v_manager and v_s.status = 'active' and v_s.verification_status = 'unverified'
                 and v_s.updated_by is distinct from v_uid,
    'beneficiaries', coalesce((
      select jsonb_agg(jsonb_build_object(
        'revisionNo', r.revision_no,
        'accountHolder', r.account_holder,
        'bankName', r.bank_name,
        'ifsc', r.ifsc,
        'accountLast4', right(r.account_number, 4),
        'status', r.status,
        'createdAt', r.created_at,
        'createdByName', p.display_name,
        'approvedAt', r.approved_at,
        'approvedByName', ap.display_name,
        'canApprove', v_manager and r.status = 'unverified' and r.revision_no = v_latest
                      and r.created_by is distinct from v_uid) order by r.revision_no desc)
      from public.supplier_beneficiary_revisions r
      left join public.staff_profiles p on p.user_id = r.created_by
      left join public.staff_profiles ap on ap.user_id = r.approved_by
      where r.supplier_id = v_s.id), '[]'::jsonb));
end;
$$;

commit;
