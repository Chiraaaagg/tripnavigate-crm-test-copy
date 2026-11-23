-- TripNavigate CRM - B1-1 stage 2a: every remaining business refusal raises PT409
--
-- Booking reliability fix, item B1-1 (build contract section 6, B1-1; addendum 2, gate G0).
-- PostgREST 14 treats SQLSTATE 40001 as a serialization failure and re-runs the
-- whole request without end after the client has gone. Business refusals
-- ("someone changed this", "duplicate request", ...) therefore move from 40001
-- to PT409: PostgREST's custom-status prefix, answered once as HTTP 409, with
-- code, message and hint intact (proved on PostgREST 14.18 by gate G0). The app
-- accepts both codes before this runs (src/lib/sqlstate.ts).
--
-- How this file was made: every function below is restated from its newest
-- definition in the migration history (source file named next to it), with
-- only the code literal changed. "create function" becomes "create or replace
-- function"; the body, the argument list, the return type, language,
-- volatility, security definer and set search_path are restated exactly as
-- written there. Owner, grants and comments are kept by create or replace.
-- Message tokens, hints and every condition that raises stay as they are.
-- tests/db/br-conflict-code.test.ts compares each function before and after
-- (definition with the literal put back, security definer, configuration,
-- volatility, grants, owner) and fails on any other difference.
-- Function list and live pre-check: supabase/conflict-code/.

-- Stage 2a. Every remaining function in public and authz that raised a
-- business refusal with 40001 now raises it with PT409 (100 functions).

-- Replaces (newest definition, source migration):
--   authz.b11_billing_propose(uuid, integer, jsonb, uuid)  (20261124000110_booking_form_commands.sql)
--   authz.booking_change_apply(uuid)  (20261205000780_manager_approves_final.sql)
--   authz.booking_create_item_tasks(uuid, uuid[])  (20261205000720_service_change_apply.sql)
--   authz.cdoc_check_version(public.customer_documents, integer)  (20261204000210_customer_documents_commands.sql)
--   authz.cdoc_release_core(uuid, uuid, text, uuid)  (20261205000210_auto_bills.sql)
--   authz.finance_expense_review(uuid, integer, text, uuid, boolean)  (20261119000500_b11_department_forms.sql)
--   authz.finance_remember(uuid, uuid, text, jsonb, jsonb)  (20261101000100_accounts_receipts.sql)
--   authz.finance_replay(uuid, uuid, text, jsonb)  (20261101000100_accounts_receipts.sql)
--   authz.flight_change_apply_approval(uuid)  (20261201000110_flight_workspace_commands.sql)
--   authz.referral_draft_start(uuid, jsonb, text, uuid, text)  (20261123000100_referral_drafts.sql)
--   authz.sm_payment_create(uuid, jsonb, uuid, uuid, text)  (20261205000780_manager_approves_final.sql)
--   authz.sm_payment_still_valid(uuid)  (20261201000210_flight_money_commands.sql)
--   public.accounts_billing_save(uuid, integer, jsonb, uuid)  (20261124000110_booking_form_commands.sql)
--   public.accounts_billing_verify(uuid, integer, uuid)  (20261101000100_accounts_receipts.sql)
--   public.accounts_review_approve(uuid, integer, uuid)  (20261101000100_accounts_receipts.sql)
--   public.accounts_tally_exception(text, uuid, integer, jsonb, uuid)  (20261205000320_tally_match_upload.sql)
--   public.accounts_tally_invoice_withdraw(uuid, integer, text, uuid)  (20261203000250_accounts_tally_commands.sql)
--   public.accounts_tally_match(text, uuid, integer, jsonb, uuid)  (20261205000320_tally_match_upload.sql)
--   public.accounts_tally_match_apply(uuid, text, uuid)  (20261205000320_tally_match_upload.sql)
--   public.accounts_tally_reopen(text, uuid, integer, text, uuid)  (20261203000330_accounts_review2_fixes.sql)
--   public.admin_set_customer_message_switch(uuid, text, text, boolean, text, integer)  (20261205000120_customer_message_commands.sql)
--   public.bitrix_destination_scope_set(text, text, text, integer, text)  (20261128000100_vn_bitrix_trip_details.sql)
--   public.bitrix_id_proof_copy_complete(uuid, uuid, text, text, bigint)  (20261120000700_b12_id_proof_bitrix_copy.sql)
--   public.bitrix_id_proof_copy_mark_sending(uuid, uuid, bigint[])  (20261120000700_b12_id_proof_bitrix_copy.sql)
--   public.bitrix_id_proof_copy_stop(uuid, uuid, text)  (20261120000700_b12_id_proof_bitrix_copy.sql)
--   public.booking_change_request_decide(uuid, text, text, integer, uuid)  (20261205000780_manager_approves_final.sql)
--   public.booking_change_submit(uuid, text, uuid[], uuid)  (20261205000780_manager_approves_final.sql)
--   public.booking_confirm(uuid, text)  (20261205000720_service_change_apply.sql)
--   public.booking_save_draft(uuid, integer, jsonb, bigint, boolean)  (20261205000790_manager_fills_change_without_owner.sql)
--   public.company_destination_approve(uuid, integer, uuid)  (20261110000100_company_destinations.sql)
--   public.company_destination_retire(uuid, integer, text, uuid)  (20261110000100_company_destinations.sql)
--   public.company_destination_return(uuid, integer, text, uuid)  (20261110000100_company_destinations.sql)
--   public.company_destination_submit(uuid, uuid, jsonb, integer, uuid)  (20261110000100_company_destinations.sql)
--   public.company_funding_decide(uuid, text, text, integer, uuid)  (20261130000200_supplier_money.sql)
--   public.company_funding_mark_recovered(uuid, text, integer, uuid)  (20261130000200_supplier_money.sql)
--   public.customer_document_release(uuid, integer, text, uuid)  (20261205000210_auto_bills.sql)
--   public.customer_document_render_complete(uuid, text, boolean, text, jsonb)  (20261204000220_customer_documents_render.sql)
--   public.customer_document_render_input(uuid, text)  (20261204000220_customer_documents_render.sql)
--   public.customer_party_document_begin(uuid, text, uuid, boolean, text, text, integer, text)  (20261128000130_vn_customer_parties.sql)
--   public.customer_party_tally_name_set(uuid, integer, text, uuid)  (20261205000300_tally_xml_schema.sql)
--   public.customer_refund_decide(uuid, text, bigint, bigint, text, integer, uuid)  (20261204000380_refund_limits_cumulative.sql)
--   public.deal_cancellation_decide(uuid, text, text, integer, uuid)  (20261204000330_cancellation_flight_visa.sql)
--   public.deal_cancellation_send(uuid, integer, uuid)  (20261204000330_cancellation_flight_visa.sql)
--   public.deal_message_prefs_set(uuid, integer, jsonb, uuid)  (20261205000120_customer_message_commands.sql)
--   public.deal_traveller_name_fill(uuid, uuid, integer, text, text, uuid)  (20261201000190_flight_traveller_name_fill.sql)
--   public.flight_booking_change_apply(uuid, uuid, uuid, uuid)  (20261201000160_flight_review_fixes.sql)
--   public.flight_cancellation_charge_set(uuid, jsonb, integer, uuid)  (20261205000780_manager_approves_final.sql)
--   public.flight_change_decide(uuid, text, text, integer, uuid)  (20261201000160_flight_review_fixes.sql)
--   public.flight_direct_payment_save(uuid, integer, jsonb, uuid)  (20261205000770_removed_flight_visa_work.sql)
--   public.flight_fare_approval_decide(uuid, text, text, integer, uuid)  (20261201000210_flight_money_commands.sql)
--   public.flight_fare_approval_withdraw(uuid, integer, uuid)  (20261201000210_flight_money_commands.sql)
--   public.flight_group_claim(uuid, uuid)  (20261205000750_closed_tasks_work_lists.sql)
--   public.flight_group_complete(uuid, uuid[], uuid)  (20261205000770_removed_flight_visa_work.sql)
--   public.flight_group_reassign(uuid, uuid, uuid, text, uuid)  (20261201000160_flight_review_fixes.sql)
--   public.flight_supplier_update(uuid, integer, jsonb)  (20261204000110_supplier_master_commands.sql)
--   public.flight_ticket_correct(uuid, integer, integer, jsonb, text, uuid)  (20261201000160_flight_review_fixes.sql)
--   public.hotel_catalogue_save(uuid, uuid, integer, jsonb, text)  (20261128000120_vn_hotel_catalogue.sql)
--   public.import_batch_apply(uuid, integer, text, text, jsonb)  (20261205000530_rate_sheet_import.sql)
--   public.import_batch_stage(uuid, text, uuid, text, text, jsonb, uuid, boolean)  (20261205000530_rate_sheet_import.sql)
--   public.integration_apply_sync_settings(uuid, text)  (20261125000100_settings_preview_audit.sql)
--   public.itinerary_create_standalone(uuid, jsonb, text, uuid)  (20261123000100_referral_drafts.sql)
--   public.itinerary_differences_save(uuid, integer, text, uuid, text, jsonb)  (20261120000500_b12_itineraries.sql)
--   public.itinerary_document_create(text, uuid, text, uuid)  (20261123000100_referral_drafts.sql)
--   public.itinerary_render_complete(uuid, text, boolean, text, jsonb)  (20261120000500_b12_itineraries.sql)
--   public.itinerary_render_input(uuid, text)  (20261120000800_b12_document_branch_code.sql)
--   public.payment_claim_report(uuid, jsonb, uuid)  (20261119000200_b11_payment_claims.sql)
--   public.payment_claim_withdraw(uuid, integer, text, uuid)  (20261119000200_b11_payment_claims.sql)
--   public.purchase_booking_change_ack(uuid, uuid, uuid)  (20261203000430_purchase_booking_change.sql)
--   public.purchase_booking_request_send(uuid, integer, text, text[], text, text, uuid)  (20261130000110_purchase_workflow_commands.sql)
--   public.purchase_cancellation_charge_set(uuid, bigint, bigint, text, uuid, integer, uuid)  (20261205000780_manager_approves_final.sql)
--   public.purchase_cost_approve_over_budget(uuid, integer)  (20261205000600_cost_approval_booking_version.sql)
--   public.purchase_cost_propose(uuid, uuid, integer, bigint, date, text, uuid)  (20261130000110_purchase_workflow_commands.sql)
--   public.purchase_go_ahead_decide(uuid, text, text, integer, uuid)  (20261130000110_purchase_workflow_commands.sql)
--   public.purchase_supplier_confirm(uuid, integer, text)  (20261205000780_manager_approves_final.sql)
--   public.purchase_task_claim(uuid)  (20261205000780_manager_approves_final.sql)
--   public.purchase_task_reassign(uuid, uuid, uuid)  (20261201000110_flight_workspace_commands.sql)
--   public.purchase_task_release(uuid)  (20261005000200_procurement_owner_decisions.sql)
--   public.quotation_accept(uuid, text, uuid, text, uuid)  (20261120000200_b12_quotations.sql)
--   public.quotation_convert_to_booking(uuid, text, uuid)  (20261128000110_vn_booking_trip_rules.sql)
--   public.quotation_create(text, uuid, text, uuid)  (20261123000100_referral_drafts.sql)
--   public.quotation_create_standalone(uuid, jsonb, text, uuid)  (20261123000100_referral_drafts.sql)
--   public.quotation_mark_sent(uuid, text, text, uuid)  (20261120000200_b12_quotations.sql)
--   public.service_item_file_begin(uuid, uuid, text, jsonb, uuid)  (20261124000110_booking_form_commands.sql)
--   public.supplier_approve_beneficiary(uuid, integer)  (20261005000200_procurement_owner_decisions.sql)
--   public.supplier_contact_remove(uuid, integer, text, uuid)  (20261204000110_supplier_master_commands.sql)
--   public.supplier_contact_save(uuid, uuid, integer, jsonb, uuid)  (20261204000110_supplier_master_commands.sql)
--   public.supplier_document_review(uuid, text, text, integer, uuid)  (20261130000200_supplier_money.sql)
--   public.supplier_payment_decide(uuid, text, text, integer, uuid)  (20261201000210_flight_money_commands.sql)
--   public.supplier_payment_record(uuid, date, text, text, uuid, integer, uuid)  (20261130000200_supplier_money.sql)
--   public.supplier_payment_request_cancel(uuid, integer, uuid)  (20261203000120_phase0_flight_cancel.sql)
--   public.supplier_payment_verify(uuid, integer, uuid)  (20261130000200_supplier_money.sql)
--   public.supplier_update(uuid, integer, jsonb)  (20261204000110_supplier_master_commands.sql)
--   public.supplier_verify(uuid, integer)  (20261005000200_procurement_owner_decisions.sql)
--   public.tally_mapping_set(uuid, integer, jsonb, text, uuid)  (20261204000400_tally_mapping.sql)
--   public.traveller_id_proof_begin(uuid, integer, uuid, boolean, text, text, integer, text)  (20261120000100_b12_traveller_id_proof.sql)
--   public.visa_cancellation_fee_set(uuid, bigint, text, integer, uuid)  (20261205000780_manager_approves_final.sql)
--   public.visa_task_claim(uuid)  (20261202000110_visa_desk_commands.sql)
--   public.write_off_decide(uuid, text, bigint, text, integer, uuid)  (20261205000220_write_off_commands.sql)
--   public.write_off_undo(uuid, integer, text, uuid)  (20261205000220_write_off_commands.sql)
--   public.write_off_withdraw(uuid, integer, text, uuid)  (20261205000220_write_off_commands.sql)

begin;

-- authz.b11_billing_propose(uuid, integer, jsonb, uuid): from 20261124000110_booking_form_commands.sql
create or replace function authz.b11_billing_propose(p_deal uuid, p_expected_row_version integer, p_fields jsonb, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_deal public.deals%rowtype;
  v_old public.customer_billing_profiles%rowtype;
  v_payload jsonb := jsonb_build_object('dealId', p_deal, 'expectedRowVersion', p_expected_row_version, 'fields', p_fields);
  v_result jsonb;
  v_name text; v_line1 text; v_line2 text; v_city text; v_state text; v_postal text; v_gstin text;
  v_changed text[] := '{}';
  v_row integer;
  v_x jsonb;        -- booking form
  v_bad text[];     -- booking form
begin
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  v_deal := authz.finance_lock_deal(p_deal);
  v_result := authz.finance_replay(v_deal.legal_entity_id, p_request_id, 'booking_billing_propose', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if p_fields is null or jsonb_typeof(p_fields) <> 'object'
     or (p_fields - array['billingName', 'addressLine1', 'addressLine2', 'city', 'stateCode', 'postalCode', 'gstin',
                          'billToType', 'contactPerson', 'phone', 'email', 'gstStatus', 'gstReason']) <> '{}'::jsonb
     or p_expected_row_version is null or p_expected_row_version < 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'billing';
  end if;
  -- Text fields must be strings (the finance helpers raise without a hint).
  if exists (select 1 from unnest(array['billingName', 'addressLine1', 'addressLine2', 'city', 'stateCode', 'postalCode', 'gstin']) k
             where p_fields ? k and jsonb_typeof(p_fields -> k) not in ('string', 'null')) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'billing';
  end if;
  v_name := btrim(coalesce(p_fields ->> 'billingName', ''), E' \t\r\n');
  v_name := case when v_name = '' or length(v_name) > 200 or v_name ~ E'[\\x01-\\x1f\\x7f]' then null else v_name end;
  v_line1 := btrim(coalesce(p_fields ->> 'addressLine1', ''), E' \t\r\n');
  v_line1 := case when v_line1 = '' or length(v_line1) > 200 or v_line1 ~ E'[\\x01-\\x1f\\x7f]' then null else v_line1 end;
  v_line2 := nullif(btrim(coalesce(p_fields ->> 'addressLine2', ''), E' \t\r\n'), '');
  v_city := btrim(coalesce(p_fields ->> 'city', ''), E' \t\r\n');
  v_city := case when v_city = '' or length(v_city) > 120 or v_city ~ E'[\\x01-\\x1f\\x7f]' then null else v_city end;
  v_state := nullif(btrim(coalesce(p_fields ->> 'stateCode', ''), E' \t\r\n'), '');
  v_postal := nullif(btrim(coalesce(p_fields ->> 'postalCode', ''), E' \t\r\n'), '');
  v_gstin := nullif(upper(btrim(coalesce(p_fields ->> 'gstin', ''), E' \t\r\n')), '');

  select * into v_old from public.customer_billing_profiles b where b.deal_id = v_deal.id for update;
  v_x := authz.bf_bill_to(p_fields, v_old, v_gstin);
  v_bad := array_remove(array[
      case when v_name is null then 'billingName' end,
      case when v_line1 is null then 'addressLine1' end,
      case when v_line2 is not null and (length(v_line2) > 200 or v_line2 ~ E'[\\x01-\\x1f\\x7f]') then 'addressLine2' end,
      case when v_city is null then 'city' end,
      case when v_state is null or v_state !~ '^(0[1-9]|[12][0-9]|3[0-8]|97)$' then 'stateCode' end,
      case when v_postal is null or v_postal !~ '^[1-9][0-9]{5}$' then 'postalCode' end,
      case when v_gstin is not null and (v_gstin !~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'
                                        or left(v_gstin, 2) is distinct from v_state) then 'gstin' end], null)
    || array(select jsonb_array_elements_text(v_x -> 'bad'));
  if cardinality(v_bad) > 0 then
    raise exception 'invalid_input' using errcode = '22023',
      hint = array_to_string(array(select distinct b from unnest(v_bad) b order by b), ',');
  end if;

  if coalesce(v_old.row_version, 0) <> p_expected_row_version then
    raise exception 'version_changed' using errcode = 'PT409';
  end if;
  if v_old.status = 'verified' then
    raise exception 'billing_verified' using errcode = '55000';
  end if;

  if v_old.deal_id is null then
    insert into public.customer_billing_profiles (deal_id, legal_entity_id, billing_name, address_line1, address_line2,
      city, state_code, postal_code, gstin, status, prefill_source, updated_by,
      bill_to_type, contact_person, phone, email, gst_status, gst_reason)
    values (v_deal.id, v_deal.legal_entity_id, v_name, v_line1, v_line2, v_city, v_state, v_postal, v_gstin, 'draft',
      'sales', (select auth.uid()),
      v_x ->> 'type', v_x ->> 'contactPerson', v_x ->> 'phone', v_x ->> 'email', v_x ->> 'gstStatus', v_x ->> 'gstReason')
    returning row_version into v_row;
    v_changed := array['billingName', 'addressLine1', 'addressLine2', 'city', 'stateCode', 'postalCode', 'gstin',
      'billToType', 'contactPerson', 'phone', 'email', 'gstStatus', 'gstReason'];
  else
    v_changed := array_remove(array[
      case when v_old.billing_name is distinct from v_name then 'billingName' end,
      case when v_old.address_line1 is distinct from v_line1 then 'addressLine1' end,
      case when v_old.address_line2 is distinct from v_line2 then 'addressLine2' end,
      case when v_old.city is distinct from v_city then 'city' end,
      case when v_old.state_code is distinct from v_state then 'stateCode' end,
      case when v_old.postal_code is distinct from v_postal then 'postalCode' end,
      case when v_old.gstin is distinct from v_gstin then 'gstin' end,
      case when v_old.bill_to_type is distinct from v_x ->> 'type' then 'billToType' end,
      case when v_old.contact_person is distinct from v_x ->> 'contactPerson' then 'contactPerson' end,
      case when v_old.phone is distinct from v_x ->> 'phone' then 'phone' end,
      case when v_old.email is distinct from v_x ->> 'email' then 'email' end,
      case when v_old.gst_status is distinct from v_x ->> 'gstStatus' then 'gstStatus' end,
      case when v_old.gst_reason is distinct from v_x ->> 'gstReason' then 'gstReason' end], null);
    update public.customer_billing_profiles b
    set billing_name = v_name, address_line1 = v_line1, address_line2 = v_line2, city = v_city,
        state_code = v_state, postal_code = v_postal, gstin = v_gstin, prefill_source = 'sales',
        bill_to_type = v_x ->> 'type', contact_person = v_x ->> 'contactPerson', phone = v_x ->> 'phone',
        email = v_x ->> 'email', gst_status = v_x ->> 'gstStatus', gst_reason = v_x ->> 'gstReason',
        row_version = b.row_version + 1, updated_by = (select auth.uid()), updated_at = now()
    where b.deal_id = v_deal.id
    returning row_version into v_row;
  end if;

  v_result := jsonb_build_object('outcome', case when v_old.deal_id is null then 'created' else 'updated' end,
    'status', 'draft', 'rowVersion', v_row);
  perform authz.finance_remember(v_deal.legal_entity_id, p_request_id, 'booking_billing_propose', v_payload, v_result);
  perform authz.write_audit('booking.billing_proposed', v_deal.legal_entity_id, v_deal.branch_id, 'deal', v_deal.id, null,
    jsonb_build_object('changedFields', to_jsonb(v_changed), 'rowVersion', v_row));
  return v_result;
end;
$$;

-- authz.booking_change_apply(uuid): from 20261205000780_manager_approves_final.sql
create or replace function authz.booking_change_apply(p_change_request uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_row public.booking_change_requests%rowtype;
  v_base public.booking_versions%rowtype;
  v_ver public.booking_versions%rowtype;
  v_task public.fulfilment_tasks%rowtype;
  v_cost public.purchase_cost_versions;
  r public.task_reconfirmations%rowtype;
  v_next integer;
  v_conf integer;
  v_tasks uuid[] := '{}'::uuid[];
  v_pre public.booking_change_requests%rowtype;  -- Accounts phase 3 (20261205000720)
  v_added uuid[] := '{}'::uuid[];
  v_closed uuid[] := '{}'::uuid[];
  v_t public.fulfilment_tasks%rowtype;
  v_state text;
begin
  -- Accounts phase 3 (20261205000720): lock order 17.1 for a removal - the removed service's
  -- tasks (by id) are locked after the versions and before the request row
  -- (authz.cr_lock_apply then takes the same locks again and the rest).
  select * into v_pre from public.booking_change_requests q where q.id = p_change_request;
  if v_pre.kind = 'remove_service' then
    perform authz.finance_lock_deal(v_pre.deal_id);
    perform 1 from public.deals d where d.id = v_pre.deal_id for no key update;
    perform 1 from public.booking_versions b where b.id = v_pre.base_version_id for update;
    perform 1 from public.booking_versions b where b.id = v_pre.change_version_id for update;
    perform 1 from public.fulfilment_tasks t
    where t.deal_id = v_pre.deal_id and t.service_item_id = any (v_pre.item_ids) order by t.id for update;
  end if;
  v_row := authz.cr_lock_apply(p_change_request);
  if v_row.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v_row.status <> 'approved' or v_row.change_version_id is null then  -- Accounts phase 3 (20261205000780) (O2)
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  -- The version must be exactly the one the Manager approved.
  if v_row.approved_content_hash is distinct from authz.booking_content_hash(v_row.change_version_id) then
    raise exception 'version_changed' using errcode = 'PT409';
  end if;
  if exists (select 1 from public.task_reconfirmations x
             where x.change_request_id = v_row.id
               and (x.status = 'pending' or (x.status = 'recorded' and x.over_budget and x.over_budget_approved_by is null))) then
    raise exception 'not_ready' using errcode = '55000', hint = 'reconfirmation_open';
  end if;
  select * into v_base from public.booking_versions b where b.id = v_row.base_version_id;
  select * into v_ver from public.booking_versions b where b.id = v_row.change_version_id;
  if v_base.status <> 'confirmed' then
    raise exception 'version_superseded' using errcode = '55000';
  end if;
  if v_ver.status <> 'draft' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;

  -- 5 (first, so the automatic bill checks below see no live change).
  update public.booking_change_requests q set status = 'applied', applied_at = now(), row_version = q.row_version + 1
  where q.id = v_row.id
  returning * into v_row;

  -- 1. Freeze the change version and supersede the base.
  perform set_config('tripnavigate.change_apply', v_ver.id::text, true);
  v_ver := authz.booking_version_freeze(v_ver.id, v_base.id);
  perform set_config('tripnavigate.change_apply', '', true);

  -- 2. The Manager's approval stands in for the Accounts review (LD24).
  insert into public.accounts_booking_reviews (booking_version_id, deal_id, legal_entity_id, status, approval_source,
    change_request_id)
  values (v_ver.id, v_ver.deal_id, v_ver.legal_entity_id, 'approved', 'change_request', v_row.id);

  -- 3. Recorded reconfirmations become the task's new committed cost and confirmation.
  for r in
    select * from public.task_reconfirmations x
    where x.change_request_id = v_row.id and x.status = 'recorded' order by x.task_id
  loop
    select * into v_task from public.fulfilment_tasks t where t.id = r.task_id;
    v_cost := authz.purchase_latest_cost(v_task.id);
    select coalesce(max(c.version_no), 0) into v_next from public.purchase_cost_versions c where c.task_id = v_task.id;
    select coalesce(max(c.confirmation_no), 0) + 1 into v_conf from public.task_confirmations c where c.task_id = v_task.id;
    insert into public.purchase_cost_versions (task_id, legal_entity_id, version_no, quote_id, request_id, stage,
      amount_paise, due_date, note, created_by, confirmation_no, change_fee_paise)
    values (v_task.id, v_task.legal_entity_id, v_next + 1, v_task.selected_quote_id, gen_random_uuid(), 'proposed',
      r.new_rate_paise + r.supplier_fee_paise, v_cost.due_date, null, r.recorded_by, v_conf, r.supplier_fee_paise);
    insert into public.purchase_cost_versions (task_id, legal_entity_id, version_no, quote_id, request_id, stage,
      amount_paise, due_date, note, created_by, confirmation_no, change_fee_paise)
    values (v_task.id, v_task.legal_entity_id, v_next + 2, v_task.selected_quote_id, gen_random_uuid(), 'committed',
      r.new_rate_paise + r.supplier_fee_paise, v_cost.due_date, null, coalesce(v_uid, r.recorded_by), v_conf, r.supplier_fee_paise);
    if r.over_budget then
      -- The agreed (proposed) cost carries the approval, bound to the new version.
      insert into public.purchase_cost_approvals (task_id, legal_entity_id, version_no, approved_by, approved_at,
        booking_version_id, reconfirmation_id)
      values (v_task.id, v_task.legal_entity_id, v_next + 1, r.over_budget_approved_by, r.over_budget_approved_at,
        v_ver.id, r.id);
    end if;
    perform set_config('authz.task_transition', 'reconfirm', true);
    update public.fulfilment_tasks t
    set supplier_reference = r.new_reference, supplier_confirmed_by = r.recorded_by, supplier_confirmed_at = r.recorded_at,
        updated_at = now()
    where t.id = v_task.id;
    perform set_config('authz.task_transition', '', true);
    insert into public.task_confirmations (legal_entity_id, task_id, confirmation_no, quote_id, committed_version_no, amount_paise,
      change_fee_paise, supplier_reference, evidence_ids, booking_version_id, change_request_id, confirmed_by, confirmed_at)
    values (v_task.legal_entity_id, v_task.id, v_conf, v_task.selected_quote_id, v_next + 2, r.new_rate_paise + r.supplier_fee_paise,
      r.supplier_fee_paise, r.new_reference, array[r.evidence_id], v_ver.id, v_row.id, r.recorded_by, r.recorded_at);
    -- The Purchase person reconfirmed against the change version: that is their new basis.
    insert into public.purchase_task_basis (task_id, legal_entity_id, deal_id, basis_version_id, seen_by, seen_at)
    values (v_task.id, v_task.legal_entity_id, v_task.deal_id, v_ver.id, r.recorded_by, now())
    on conflict (task_id) do update
      set basis_version_id = excluded.basis_version_id, seen_by = excluded.seen_by, seen_at = excluded.seen_at,
          row_version = public.purchase_task_basis.row_version + 1, updated_at = now();
    update public.task_reconfirmations x set status = 'applied', row_version = x.row_version + 1 where x.id = r.id;
  end loop;

  -- Accounts phase 3 (20261205000720): add a service - one task per new service for its
  -- department (the task-creation loop of booking_confirm, 11.2).
  if v_row.kind = 'add_service' then
    v_added := authz.booking_create_item_tasks(v_ver.id, v_row.item_ids);
  end if;
  -- Accounts phase 3 (20261205000720): remove a service - its open task(s) close (withdrawn for
  -- a simple removal, cancelled for a booked one; status unchanged, LD31) and
  -- the service is cancelled. Supplier refunds expected follow from the charge
  -- rows of this request (authz.supplier_refund_sources); no deal_cancellations
  -- row is written (LD30).
  if v_row.kind = 'remove_service' then
    v_state := case when v_row.removal_route = 'cancellation' then 'cancelled' else 'withdrawn' end;
    for v_t in
      select t.* from public.fulfilment_tasks t
      where t.deal_id = v_row.deal_id and t.service_item_id = any (v_row.item_ids) and t.closed_state is null
      order by t.id
    loop
      perform set_config('authz.task_transition', 'close', true);
      update public.fulfilment_tasks t
      set closed_state = v_state, closed_at = now(), closed_by = coalesce(v_uid, v_row.decided_by),
          closed_change_request_id = v_row.id, updated_at = now()
      where t.id = v_t.id;
      perform set_config('authz.task_transition', '', true);
      perform authz.write_audit('fulfilment.task_closed', v_t.legal_entity_id, v_t.branch_id, 'fulfilment_task', v_t.id, null,
        jsonb_build_object('taskId', v_t.id, 'dealId', v_t.deal_id, 'changeRequestId', v_row.id, 'closedState', v_state,
          'department', v_t.department, 'serviceItemId', v_t.service_item_id));
      v_closed := v_closed || v_t.id;
    end loop;
    perform set_config('tripnavigate.service_item_cancel', v_row.item_ids[1]::text, true);
    update public.service_items i set state = 'cancelled', updated_at = now()
    where i.id = v_row.item_ids[1] and i.state <> 'cancelled';
    perform set_config('tripnavigate.service_item_cancel', '', true);
  end if;

  -- Every task of the new version's services (the history and notices name them).
  select coalesce(array_agg(t.id order by i.item_no, t.created_at), '{}'::uuid[]) into v_tasks
  from public.fulfilment_tasks t join public.service_items i on i.id = t.service_item_id
  where t.service_item_id in (select f.service_item_id from public.service_item_facts f where f.booking_version_id = v_ver.id);

  -- 4. Supplier money: a supplier refund expected is computed from verified
  -- payments and the new committed cost (authz.supplier_refund_sources).

  -- 5. Outbox and audit.
  insert into public.outbox_events (legal_entity_id, aggregate_type, aggregate_id, event_type, payload)
  values (v_ver.legal_entity_id, 'booking_version', v_ver.id, 'booking.version_revised',
    jsonb_build_object('version_id', v_ver.id, 'deal_id', v_ver.deal_id, 'version_no', v_ver.version_no,
      'base_version_id', v_base.id))
  on conflict (event_type, aggregate_id) do nothing;
  perform authz.write_audit('booking.version_superseded', v_base.legal_entity_id, v_base.branch_id, 'booking_version',
    v_base.id, null, jsonb_build_object('dealId', v_base.deal_id, 'versionNo', v_base.version_no,
      'supersededByVersionId', v_ver.id, 'changeRequestId', v_row.id));
  perform authz.write_audit('booking.change_applied', v_row.legal_entity_id, v_row.branch_id, 'booking_change_request', v_row.id,
    null, jsonb_build_object('changeRequestId', v_row.id, 'versionId', v_ver.id, 'baseVersionId', v_base.id,
      'taskIds', to_jsonb(v_tasks),
      -- Accounts phase 3 (20261205000720): ids only.
      'kind', v_row.kind, 'addedTaskIds', to_jsonb(v_added), 'closedTaskIds', to_jsonb(v_closed)));

  -- 6. Bills and the customer message (never fail this transaction).
  perform authz.cdoc_auto_run(v_row.deal_id, 'inv_replace_on_change');
  perform authz.cmsg_enqueue(v_row.deal_id, 'booking_changed', 'cr:' || v_row.id::text, '{}'::jsonb, null);

  return jsonb_build_object('changeRequestId', v_row.id, 'status', v_row.status, 'versionId', v_ver.id,
    'baseVersionId', v_base.id, 'taskIds', to_jsonb(v_tasks),
    'addedTaskIds', to_jsonb(v_added), 'closedTaskIds', to_jsonb(v_closed));  -- Accounts phase 3 (20261205000720)
end;
$$;

-- authz.booking_create_item_tasks(uuid, uuid[]): from 20261205000720_service_change_apply.sql
create or replace function authz.booking_create_item_tasks(p_version uuid, p_item_ids uuid[]) returns uuid[]
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.booking_versions%rowtype;
  v_item record;
  v_key text;
  v_task uuid;
  v_task_version uuid;
  v_tasks uuid[] := '{}'::uuid[];
begin
  select * into v_ver from public.booking_versions v where v.id = p_version;
    -- Review V3: read the desk switch under a share lock so a concurrent
    -- switch-on either sees this version's items or is seen here.
    perform 1 from public.workflow_settings s where s.id for share;
    update public.service_items i set state = 'active', updated_at = now()
    where i.state = 'planned'
      and i.id in (select f.service_item_id from public.service_item_facts f where f.booking_version_id = v_ver.id)
      and (p_item_ids is null or i.id = any (p_item_ids));
    for v_item in
      select i.id, i.item_no, i.service_type, i.department
      from public.service_item_facts f join public.service_items i on i.id = f.service_item_id
      where f.booking_version_id = v_ver.id
        and (p_item_ids is null or i.id = any (p_item_ids))
        -- B1.1: visa/passport tasks wait for the desk launch.
        and (i.service_type not in ('visa', 'passport') or authz.visa_passport_tasks_enabled())
      order by i.item_no
    loop
      v_key := 'item:' || v_item.id::text || ':' || v_item.service_type;
      v_task := null;
      insert into public.fulfilment_tasks
        (deal_id, legal_entity_id, branch_id, booking_version_id, service_purpose, task_key, created_by,
         service_item_id, department)
      values (v_ver.deal_id, v_ver.legal_entity_id, v_ver.branch_id, v_ver.id, v_item.service_type, v_key,
        (select auth.uid()), v_item.id, v_item.department)
      on conflict (task_key) do nothing
      returning id into v_task;
      if v_task is null then
        select t.id, t.booking_version_id into v_task, v_task_version
        from public.fulfilment_tasks t where t.task_key = v_key;
        if v_task_version is distinct from v_ver.id then
          raise exception 'task_conflict' using errcode = 'PT409';
        end if;
      end if;
      v_tasks := v_tasks || v_task;
      -- 9. Outbox per task (ids and types only).
      insert into public.outbox_events (legal_entity_id, aggregate_type, aggregate_id, event_type, payload)
      values (v_ver.legal_entity_id, 'fulfilment_task', v_task, 'fulfilment.task_created',
        jsonb_build_object('task_id', v_task, 'version_id', v_ver.id, 'deal_id', v_ver.deal_id,
          'version_no', v_ver.version_no, 'service_purpose', v_item.service_type,
          'service_item_id', v_item.id, 'service_type', v_item.service_type))
      on conflict (event_type, aggregate_id) do nothing;
      -- 10. Audit per task.
      perform authz.write_audit('fulfilment.task_created', v_ver.legal_entity_id, v_ver.branch_id,
        'fulfilment_task', v_task, null,
        jsonb_build_object('dealId', v_ver.deal_id, 'versionId', v_ver.id, 'versionNo', v_ver.version_no,
          'serviceItemId', v_item.id, 'serviceType', v_item.service_type));
    end loop;
  return v_tasks;
end;
$$;

-- authz.cdoc_check_version(public.customer_documents, integer): from 20261204000210_customer_documents_commands.sql
create or replace function authz.cdoc_check_version(p_doc public.customer_documents, p_expected integer) returns void
language plpgsql immutable set search_path = '' as $$
begin
  if p_expected is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'expectedRowVersion';
  end if;
  if p_doc.row_version <> p_expected then
    raise exception 'version_changed' using errcode = 'PT409';
  end if;
end;
$$;

-- authz.cdoc_release_core(uuid, uuid, text, uuid): from 20261205000210_auto_bills.sql
create or replace function authz.cdoc_release_core(p_doc uuid, p_released_by uuid, p_rule text, p_request uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v public.customer_documents%rowtype;
  v_old public.customer_documents%rowtype;
  v_seq integer;
  v_number text;
  v_today date := authz.finance_today();
  v_content jsonb;
  v_job uuid;
  v_prefix text;
  v_other text;
  v_rule text := case when p_released_by is null then p_rule end;
begin
  if p_released_by is null and not authz.system_rule_ok(p_rule) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'rule';
  end if;
  if p_request is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  select * into v from public.customer_documents c where c.id = p_doc for update;
  if v.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v.status <> 'draft' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  if not exists (select 1 from public.customer_billing_profiles b where b.deal_id = v.deal_id and b.status = 'verified') then
    raise exception 'billing_not_verified' using errcode = '55000';
  end if;
  if v.kind = 'advance_invoice' and not exists (
       select 1 from public.customer_receipts r where r.id = v.receipt_id and r.status in ('verified', 'cleared')) then
    raise exception 'receipt_not_verified' using errcode = '55000';
  end if;
  -- L7 review 5: never release with the company GSTIN placeholder.
  if coalesce(v.content -> 'company' ->> 'gstin', '[') like '[%' then
    raise exception 'company_identity_missing' using errcode = '55000';
  end if;
  if authz.cdoc_source_hash(v.id) is distinct from v.source_hash then
    raise exception 'document_stale' using errcode = 'PT409';
  end if;
  if v.replaces_document_id is not null then
    select * into v_old from public.customer_documents c where c.id = v.replaces_document_id for update;
    if v_old.status <> 'released' then
      raise exception 'wrong_state' using errcode = '55000', hint = 'replacesDocumentId';
    end if;
  end if;

  -- Number (6.3, LD4; L7 review 7): the prefix is fixed at the Deal's first
  -- release and kept on its counter rows; another Deal of the entity holding
  -- the same prefix refuses number_conflict.
  v_prefix := authz.cdoc_number_prefix(v.deal_id);
  v_other := authz.cdoc_prefix_other_deal(v.deal_id, v.legal_entity_id, v_prefix);
  if v_other is not null then
    raise exception 'number_conflict' using errcode = '23505', hint = 'otherDealReference=' || v_other;
  end if;
  insert into public.customer_document_counters (deal_id, kind, prefix) values (v.deal_id, v.kind, v_prefix) on conflict do nothing;
  update public.customer_document_counters k set prefix = v_prefix where k.deal_id = v.deal_id and k.prefix is null;
  update public.customer_document_counters k set last_no = k.last_no + 1
  where k.deal_id = v.deal_id and k.kind = v.kind returning k.last_no into v_seq;
  v_number := v_prefix || '-' || authz.cdoc_code(v.kind) || '-' || v_seq::text;
  if exists (select 1 from public.customer_documents x where x.legal_entity_id = v.legal_entity_id and x.number = v_number) then
    raise exception 'number_conflict' using errcode = '23505', hint = 'otherDealReference=' ||
      coalesce((select d.reference from public.customer_documents x join public.deals d on d.id = x.deal_id
                where x.legal_entity_id = v.legal_entity_id and x.number = v_number), '');
  end if;
  v_content := v.content || jsonb_build_object('number', v_number, 'issueDate', to_char(v_today, 'YYYY-MM-DD'));

  update public.customer_documents c
  set status = 'released', number = v_number, seq = v_seq, content = v_content,
      content_sha256 = authz.finance_payload_hash(v_content), issue_date = v_today,
      released_by = p_released_by, release_rule = v_rule, released_at = now(), release_request_id = p_request,
      auto_state = null, hold_reasons = array[]::text[],
      row_version = c.row_version + 1, updated_at = now()
  where c.id = v.id returning * into v;

  if v_old.id is not null then
    update public.customer_documents c
    set status = 'replaced', ended_by = p_released_by, end_rule = v_rule, ended_at = now(),
        end_reason = coalesce(v.replace_reason, 'Replaced by ' || v.number), row_version = c.row_version + 1, updated_at = now()
    where c.id = v_old.id;
  end if;

  insert into public.customer_document_render_jobs (legal_entity_id, document_id, content_sha256, template_version, requested_by)
  values (v.legal_entity_id, v.id, v.content_sha256, 'cdoc-1', p_released_by)
  returning id into v_job;

  return jsonb_build_object('documentId', v.id, 'kind', v.kind, 'seq', v.seq, 'number', v.number,
    'issueDate', to_char(v.issue_date, 'YYYY-MM-DD'), 'renderJobId', v_job, 'replacedDocumentId', v_old.id,
    'replacesDocumentId', v.replaces_document_id, 'rowVersion', v.row_version);
end;
$$;

-- authz.finance_expense_review(uuid, integer, text, uuid, boolean): from 20261119000500_b11_department_forms.sql
create or replace function authz.finance_expense_review(p_entry uuid, p_expected_row_version integer, p_reason text,
  p_request_id uuid, p_accept boolean)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_entry public.department_cost_entries%rowtype;
  v_deal public.deals%rowtype;
  v_command text := case when p_accept then 'expense_record_accept' else 'expense_record_return' end;
  v_payload jsonb := jsonb_build_object('entryId', p_entry, 'expectedRowVersion', p_expected_row_version, 'reason', p_reason);
  v_result jsonb;
  v_reason text;
begin
  select * into v_entry from public.department_cost_entries c where c.id = p_entry;
  if v_entry.id is null then
    if coalesce(authz.session_ok(), false) then
      raise exception 'not_found' using errcode = 'P0002';
    end if;
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_deal from public.deals d where d.id = v_entry.deal_id;
  perform authz.finance_require_accounts(v_entry.legal_entity_id, v_deal.is_synthetic);
  if p_request_id is null or p_expected_row_version is null then
    perform authz.finance_invalid();
  end if;
  perform authz.finance_lock_deal(v_deal.id);
  v_result := authz.finance_replay(v_entry.legal_entity_id, p_request_id, v_command, v_payload);
  if v_result is not null then
    return v_result;
  end if;
  select * into v_entry from public.department_cost_entries c where c.id = p_entry for update;
  if v_entry.row_version <> p_expected_row_version then
    raise exception 'version_changed' using errcode = 'PT409';
  end if;
  if v_entry.expense_status is distinct from 'submitted' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  if v_entry.submitted_by = (select auth.uid()) or v_entry.created_by = (select auth.uid())
     or authz.finance_deal_conflict(v_deal.id) then
    raise exception 'not_self_approval' using errcode = '42501';
  end if;
  if not p_accept then
    v_reason := authz.finance_reason(p_reason);
  elsif not authz.expense_receipt_ok(v_entry.id) then
    raise exception 'receipt_required' using errcode = '55000';
  end if;
  update public.department_cost_entries c
  set expense_status = case when p_accept then 'accepted' else 'returned' end, reviewed_by = (select auth.uid()),
      reviewed_at = now(), return_reason = v_reason, row_version = c.row_version + 1, updated_at = now()
  where c.id = v_entry.id
  returning * into v_entry;
  v_result := jsonb_build_object('outcome', 'updated', 'id', v_entry.id, 'entryId', v_entry.id,
    'status', v_entry.expense_status, 'rowVersion', v_entry.row_version);
  perform authz.finance_remember(v_entry.legal_entity_id, p_request_id, v_command, v_payload, v_result);
  perform authz.write_audit(case when p_accept then 'finance.expense_record_accepted' else 'finance.expense_record_returned' end,
    v_entry.legal_entity_id, v_entry.branch_id, 'department_cost_entry', v_entry.id, v_reason,
    jsonb_build_object('department', v_entry.department, 'costKind', v_entry.cost_kind, 'rowVersion', v_entry.row_version));
  return v_result;
end;
$$;

-- authz.finance_remember(uuid, uuid, text, jsonb, jsonb): from 20261101000100_accounts_receipts.sql
create or replace function authz.finance_remember(p_entity uuid, p_request uuid, p_command text, p_payload jsonb, p_result jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  begin
    insert into public.finance_command_results (legal_entity_id, request_id, actor, command, payload_hash, result)
    values (p_entity, p_request, (select auth.uid()), p_command, authz.finance_payload_hash(p_payload), p_result);
  exception when unique_violation then
    raise exception 'request_conflict' using errcode = 'PT409';
  end;
  return p_result;
end;
$$;

-- authz.finance_replay(uuid, uuid, text, jsonb): from 20261101000100_accounts_receipts.sql
create or replace function authz.finance_replay(p_entity uuid, p_request uuid, p_command text, p_payload jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v public.finance_command_results%rowtype;
begin
  if p_request is null then
    perform authz.finance_invalid();
  end if;
  select * into v from public.finance_command_results r
  where r.legal_entity_id = p_entity and r.request_id = p_request;
  if v.request_id is null then
    return null;
  end if;
  if v.actor is distinct from (select auth.uid()) or v.command <> p_command
     or v.payload_hash <> authz.finance_payload_hash(p_payload) then
    raise exception 'request_conflict' using errcode = 'PT409';
  end if;
  return v.result || jsonb_build_object('outcome', 'existing');
end;
$$;

-- authz.flight_change_apply_approval(uuid): from 20261201000110_flight_workspace_commands.sql
create or replace function authz.flight_change_apply_approval(p_change uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v public.flight_changes%rowtype;
begin
  select * into v from public.flight_changes c where c.id = p_change;
  if v.kind <> 'added_extra' and exists (
       select 1 from unnest(v.from_sector_ids) fs cross join unnest(v.traveller_seqs) sq
       where not exists (select 1 from public.flight_sector_passengers p
                         join public.flight_sectors x on x.id = p.sector_id and x.status = 'active'
                         where p.sector_id = fs and p.traveller_seq = sq and p.ended_at is null
                           and p.held_by_change_id = v.id)) then
    raise exception 'version_changed' using errcode = 'PT409';
  end if;
  if exists (select 1 from public.flight_sector_passengers p
             where p.held_by_change_id = v.id and p.ended_at is null
               and exists (select 1 from public.flight_ticket_revisions r
                           where r.sector_id = p.sector_id and r.traveller_seq = p.traveller_seq)) then
    raise exception 'version_changed' using errcode = 'PT409';
  end if;
  perform set_config('authz.flight_transition', 'change_decide', true);
  update public.flight_sectors s
  set status = 'active', row_version = s.row_version + 1, updated_at = now()
  where s.change_id = v.id and s.status = 'pending';
  update public.flight_sector_passengers p
  set held_by_change_id = null, ended_at = now(), ended_by = (select auth.uid()), ended_by_change_id = v.id,
      ended_reason = 'change_approved'
  where p.held_by_change_id = v.id and p.ended_at is null;
end;
$$;

-- authz.referral_draft_start(uuid, jsonb, text, uuid, text): from 20261123000100_referral_drafts.sql
create or replace function authz.referral_draft_start(p_branch_id uuid, p_customer jsonb, p_title text, p_request_id uuid, p_via text,
  out o_draft public.referral_drafts, out o_created boolean)
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_bad text[];
  v_title text := btrim(coalesce(p_title, ''), E' \t\r\n');
  v_entity uuid;
  v_no integer;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_branch_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'branchId';
  end if;
  if not authz.referral_branch_creator(p_branch_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  select * into o_draft from public.referral_drafts r where r.created_by = (select auth.uid()) and r.request_id = p_request_id;
  if o_draft.id is not null then
    if o_draft.branch_id is distinct from p_branch_id or o_draft.created_via is distinct from p_via
       or o_draft.customer_name is distinct from authz.b11_text(p_customer -> 'customerName') then
      raise exception 'request_conflict' using errcode = 'PT409';
    end if;
    o_created := false;
    return;
  end if;
  -- F.3.1: no new draft while the switch is off (existing drafts keep working).
  if not authz.referral_drafts_enabled() then
    raise exception 'referral_drafts_disabled' using errcode = '55000';
  end if;
  v_bad := authz.referral_customer_bad(p_customer, true);
  if length(v_title) not between 1 and 200 then
    v_bad := v_bad || 'title'::text;
  end if;
  if cardinality(v_bad) > 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = array_to_string(v_bad, ',');
  end if;
  select b.legal_entity_id into v_entity from public.branches b where b.id = p_branch_id;
  begin
    insert into public.referral_draft_counters as c (legal_entity_id, last_no) values (v_entity, 1)
    on conflict (legal_entity_id) do update set last_no = c.last_no + 1
    returning c.last_no into v_no;
    insert into public.referral_drafts (legal_entity_id, branch_id, draft_no, reference, owner_user_id, customer_name, mobile, email,
      company_name, source_kind, source_note, created_via, request_id, created_by)
    values (v_entity, p_branch_id, v_no, 'TD-' || v_no::text, (select auth.uid()), authz.b11_text(p_customer -> 'customerName'),
      authz.b11_text(p_customer -> 'mobile'), authz.b11_text(p_customer -> 'email'), authz.b11_text(p_customer -> 'companyName'),
      authz.b11_text(p_customer -> 'sourceKind'), authz.b11_text(p_customer -> 'sourceNote'), p_via, p_request_id,
      (select auth.uid()))
    returning * into o_draft;
  exception when unique_violation then
    -- Echo-A L5: the same request committed by a concurrent call: answer as its replay.
    select * into o_draft from public.referral_drafts r where r.created_by = (select auth.uid()) and r.request_id = p_request_id;
    if o_draft.id is null or o_draft.branch_id is distinct from p_branch_id or o_draft.created_via is distinct from p_via
       or o_draft.customer_name is distinct from authz.b11_text(p_customer -> 'customerName') then
      raise exception 'request_conflict' using errcode = 'PT409';
    end if;
    o_created := false;
    return;
  end;
  perform authz.write_audit('referral.draft_created', v_entity, p_branch_id, 'referral_draft', o_draft.id, null,
    jsonb_build_object('reference', o_draft.reference, 'createdVia', p_via, 'sourceKind', o_draft.source_kind));
  o_created := true;
end;
$$;

-- authz.sm_payment_create(uuid, jsonb, uuid, uuid, text): from 20261205000780_manager_approves_final.sql
create or replace function authz.sm_payment_create(p_task_id uuid, p_fields jsonb, p_request_id uuid, p_resubmits uuid, p_command text)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_task public.fulfilment_tasks%rowtype;
  v_old public.supplier_payment_requests%rowtype;
  v_cost public.purchase_cost_versions;
  v_supplier uuid;
  v_quote_status text;
  v_gate text;
  v_payload jsonb;
  v_result jsonb;
  v_part text;
  v_amount bigint;
  v_due date;
  v_note text;
  v_proforma uuid;
  v_reason text;
  v_expected integer;
  v_budget bigint;
  v_live bigint;
  v_available bigint;
  v_funding bigint;
  v_route text;
  v_funding_route text;
  v_go_ahead uuid;
  v_id uuid := gen_random_uuid();
  v_ref text;
begin
  -- Flight build (20261201000210): flight tasks pay per ticket batch.
  if exists (select 1 from public.fulfilment_tasks t where t.id = p_task_id and t.department = 'flight') then
    -- Accounts phase 3 (20261205000730): a removed Flight service takes no new payment.
    if exists (select 1 from public.fulfilment_tasks t where t.id = p_task_id and t.closed_state is not null)
       and authz.flight_owns_task(p_task_id) then
      raise exception 'service_removed' using errcode = '55000';
    end if;
    return authz.sm_payment_create_flight(p_task_id, p_fields, p_request_id, p_resubmits, p_command);
  end if;

  -- 1. Who: the assignee of this Purchase task (unlocked read, then locks).
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id;
  -- Accounts phase 3 (20261205000750): its assignee hears service_removed (can_work_purchase_task
  -- is false for a closed task, so this is checked first).
  if v_task.closed_state is not null and v_task.department = 'purchase' and v_task.assignee_user_id = (select auth.uid())
     and authz.holds_active_role('purchase', v_task.legal_entity_id) then
    raise exception 'service_removed' using errcode = '55000';
  end if;
  if v_task.id is null or v_task.department is distinct from 'purchase' or not authz.can_work_purchase_task(v_task.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.finance_lock_deal(v_task.deal_id);
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id for update;
  -- Wait for an in-flight removal of the Deal so the gate reads its result.
  perform 1 from public.deals d where d.id = v_task.deal_id for key share;
  if not authz.can_work_purchase_task(v_task.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  -- Accounts phase 3 (20261205000730): a removed service takes no new payment (11.1); one
  -- being removed waits until the removal is settled.
  if v_task.closed_state is not null then
    raise exception 'service_removed' using errcode = '55000';
  end if;
  if exists (select 1 from public.booking_change_requests r
             where r.deal_id = v_task.deal_id and r.kind = 'remove_service' and v_task.service_item_id = any (r.item_ids)
               and r.status in ('draft', 'requested', 'returned', 'approved', 'submitted')) then
    raise exception 'change_in_progress' using errcode = '55000';
  end if;
  v_gate := authz.procurement_gate_issue(v_task.id);
  if v_gate is not null then
    raise exception '%', v_gate using errcode = '55000';
  end if;

  v_payload := jsonb_build_object('taskId', p_task_id, 'resubmitsId', p_resubmits, 'fields', p_fields);
  v_result := authz.sm_replay(v_task.legal_entity_id, p_request_id, p_command, v_payload);
  if v_result is not null then
    return v_result;
  end if;

  -- 2. Input.
  if p_fields is null or jsonb_typeof(p_fields) <> 'object'
     or (p_fields - array['expectedCostVersionNo', 'part', 'amountPaise', 'dueDate', 'note', 'proformaEvidenceId',
                          'askFunding', 'fundingReason']) <> '{}'::jsonb
     or jsonb_typeof(p_fields -> 'expectedCostVersionNo') is distinct from 'number'
     or (p_fields ->> 'expectedCostVersionNo') !~ '^[0-9]{1,9}$'
     or (p_fields ? 'askFunding' and jsonb_typeof(p_fields -> 'askFunding') not in ('boolean', 'null')) then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  v_expected := (p_fields ->> 'expectedCostVersionNo')::integer;
  v_part := authz.finance_field(p_fields, 'part');
  v_amount := authz.finance_paise(p_fields, 'amountPaise', 1);
  v_due := authz.finance_date(authz.finance_field(p_fields, 'dueDate'));
  v_note := authz.finance_text(authz.finance_field(p_fields, 'note'), 1, 500, true);
  v_proforma := authz.finance_uuid(authz.finance_field(p_fields, 'proformaEvidenceId'));
  -- Optional note for Accounts (10-500), stored as the company funding
  -- reason only when funding is needed. askFunding is accepted and ignored
  -- (earlier clients): Purchase gets no customer money signal at all.
  v_reason := authz.finance_text(authz.finance_field(p_fields, 'fundingReason'), 10, 500, true);
  if v_part is null or v_part not in ('deposit', 'balance', 'full') or v_amount is null
     or v_amount > 999999999999999 or v_proforma is null
     or (v_due is not null and v_due not between date '2000-01-01' and date '2100-12-31') then
    raise exception 'invalid_input' using errcode = '22023';
  end if;

  -- 3. The returned request being sent again.
  if p_resubmits is not null then
    select * into v_old from public.supplier_payment_requests p where p.id = p_resubmits for update;
    if v_old.id is null or v_old.task_id <> v_task.id then
      raise exception 'invalid_input' using errcode = '22023';
    end if;
    if v_old.status <> 'returned'
       or exists (select 1 from public.supplier_payment_requests p where p.resubmits_id = v_old.id) then
      raise exception 'already_decided' using errcode = '55000';
    end if;
  end if;

  -- 4. Business checks, in contract order.
  if authz.deal_trip_cancelled(v_task.deal_id) then
    raise exception 'trip_cancelled' using errcode = '55000';
  end if;
  -- Accounts phase 3 (20261205000640): a change waiting for this supplier
  -- (pending or recorded reconfirmation) takes no new payment request.
  if exists (select 1 from public.task_reconfirmations x
             where x.task_id = v_task.id and x.status in ('pending', 'recorded')) then
    raise exception 'change_in_progress' using errcode = '55000';
  end if;
  v_cost := authz.purchase_agreed_cost(v_task.id);
  if v_cost.id is null then
    raise exception 'not_ready' using errcode = '55000';
  end if;
  if v_expected is distinct from v_cost.version_no then
    raise exception 'version_changed' using errcode = 'PT409';
  end if;
  select q.supplier_id, q.status into v_supplier, v_quote_status
  from public.purchase_quotes q where q.id = v_cost.quote_id;
  if v_part in ('balance', 'full') and not authz.sm_task_confirmed(v_task.status) then
    raise exception 'not_ready' using errcode = '55000';
  end if;
  if not authz.sm_task_confirmed(v_task.status) then
    if v_quote_status is distinct from 'open' then
      raise exception 'not_ready' using errcode = '55000';
    end if;
    v_budget := authz.task_budget(v_task.id);
    if (v_budget is null or v_cost.amount_paise > v_budget)
       and not authz.cost_version_approved(v_task.id, v_cost.version_no) then
      raise exception 'over_budget' using errcode = '55000';
    end if;
    if authz.purchase_go_ahead_needed(v_task.id) then
      -- The booking request e-mail must have gone (sent or marked sent), not
      -- merely be queued or failed.
      if not authz.purchase_booking_request_sent(v_task.id) then
        raise exception 'booking_request_not_sent' using errcode = '55000';
      end if;
      if not authz.purchase_go_ahead_valid(v_task.id) then
        raise exception 'go_ahead_missing' using errcode = '55000';
      end if;
    end if;
  end if;
  if not exists (select 1 from public.supplier_money_evidence e
                 where e.id = v_proforma and e.task_id = v_task.id and e.kind = 'proforma' and e.status = 'stored') then
    raise exception 'evidence_rejected' using errcode = '22023';
  end if;
  select coalesce(sum(p.amount_paise), 0) into v_live from public.supplier_payment_requests p
  where p.task_id = v_task.id and p.status in ('pending', 'approved', 'paid', 'verified');
  if v_live + v_amount > v_cost.amount_paise then
    raise exception 'over_agreed_cost' using errcode = '55000';
  end if;
  -- Customer money (lead decision, review F1): Purchase gets no signal and
  -- no refusal. When the Deal's available customer money does not cover the
  -- amount, the company funding request for the difference is created here
  -- automatically; nothing in the reply depends on it.
  v_available := greatest(authz.sm_customer_money_available(v_task.deal_id, null), 0);
  v_funding := greatest(v_amount - v_available, 0);

  -- 5. Route: every live request for this supplier on this Deal, this one included.
  v_route := authz.sm_route(authz.sm_supplier_running_total(v_task.deal_id, v_supplier) + v_amount);
  select g.id into v_go_ahead from public.purchase_go_ahead_requests g
  where g.task_id = v_task.id and g.status = 'approved'
  order by g.decided_at desc nulls last, g.requested_at desc limit 1;

  v_ref := authz.sm_next_ref(v_task.legal_entity_id);
  insert into public.supplier_payment_requests (id, legal_entity_id, branch_id, deal_id, task_id, supplier_id, ref_no,
    cost_version_no, go_ahead_request_id, part, amount_paise, customer_money_paise, due_date, note,
    proforma_evidence_id, route, resubmits_id, request_id, requested_by)
  values (v_id, v_task.legal_entity_id, v_task.branch_id, v_task.deal_id, v_task.id, v_supplier, v_ref,
    v_cost.version_no, v_go_ahead, v_part, v_amount, v_amount - v_funding, v_due, v_note,
    v_proforma, v_route, p_resubmits, p_request_id, v_uid);

  if v_funding > 0 then
    v_funding_route := authz.sm_route(authz.sm_funding_running_total(v_task.deal_id) + v_funding);
    insert into public.company_funding_requests (legal_entity_id, branch_id, deal_id, payment_request_id, amount_paise,
      reason, route, requested_by)
    values (v_task.legal_entity_id, v_task.branch_id, v_task.deal_id, v_id, v_funding,
      coalesce(v_reason, 'No note from Purchase'), v_funding_route, v_uid);
  end if;

  perform authz.write_audit(case when p_resubmits is null then 'purchase.payment_requested' else 'purchase.payment_resubmitted' end,
    v_task.legal_entity_id, v_task.branch_id, 'fulfilment_task', v_task.id, null,
    jsonb_build_object('paymentRequestId', v_id, 'refNo', v_ref, 'part', v_part, 'route', v_route,
      'costVersionNo', v_cost.version_no, 'resubmitsId', p_resubmits));

  v_result := jsonb_build_object('outcome', 'created', 'id', v_id, 'refNo', v_ref, 'route', v_route,
    'status', 'pending');
  return authz.sm_remember(v_task.legal_entity_id, p_request_id, p_command, v_payload, v_result);
end;
$$;

-- authz.sm_payment_still_valid(uuid): from 20261201000210_flight_money_commands.sql
create or replace function authz.sm_payment_still_valid(p_payment uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
declare
  v public.supplier_payment_requests%rowtype;
  v_status text;
begin
  select * into v from public.supplier_payment_requests p where p.id = p_payment;
  if v.flight_batch_id is not null then
    if authz.deal_trip_cancelled(v.deal_id) then
      raise exception 'trip_cancelled' using errcode = '55000';
    end if;
    if not exists (select 1 from public.flight_ticket_batches b where b.id = v.flight_batch_id)
       or exists (select 1 from public.department_cost_entries c
                  where c.flight_batch_id = v.flight_batch_id and c.expense_status is distinct from 'returned') then
      raise exception 'version_changed' using errcode = 'PT409';
    end if;
    return;
  end if;
  if authz.deal_trip_cancelled(v.deal_id) then
    raise exception 'trip_cancelled' using errcode = '55000';
  end if;
  if (authz.purchase_agreed_cost(v.task_id)).version_no is distinct from v.cost_version_no then
    raise exception 'version_changed' using errcode = 'PT409';
  end if;
  select t.status into v_status from public.fulfilment_tasks t where t.id = v.task_id;
  if not authz.sm_task_confirmed(v_status)
     and authz.purchase_go_ahead_needed(v.task_id) and not authz.purchase_go_ahead_valid(v.task_id) then
    raise exception 'version_changed' using errcode = 'PT409';
  end if;
end;
$$;

-- public.accounts_billing_save(uuid, integer, jsonb, uuid): from 20261124000110_booking_form_commands.sql
create or replace function public.accounts_billing_save(
  p_deal_id uuid, p_expected_row_version integer, p_fields jsonb, p_request_id uuid
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_deal public.deals%rowtype;
  v_old public.customer_billing_profiles%rowtype;
  v_payload jsonb := jsonb_build_object('dealId', p_deal_id, 'expectedRowVersion', p_expected_row_version, 'fields', p_fields);
  v_result jsonb;
  v_name text;
  v_line1 text;
  v_line2 text;
  v_city text;
  v_state text;
  v_postal text;
  v_gstin text;
  v_changed text[] := '{}';
  v_row integer;
  v_review public.accounts_booking_reviews%rowtype;
  v_x jsonb;  -- booking form
begin
  select * into v_deal from public.deals d where d.id = p_deal_id;
  perform authz.finance_require_accounts(v_deal.legal_entity_id, v_deal.is_synthetic);
  if p_request_id is null then
    perform authz.finance_invalid();
  end if;
  perform authz.finance_lock_deal(v_deal.id);
  v_result := authz.finance_replay(v_deal.legal_entity_id, p_request_id, 'accounts_billing_save', v_payload);
  if v_result is not null then
    return v_result;
  end if;

  if p_fields is null or jsonb_typeof(p_fields) <> 'object'
     or (p_fields - array['billingName', 'addressLine1', 'addressLine2', 'city', 'stateCode', 'postalCode', 'gstin',
                          'billToType', 'contactPerson', 'phone', 'email', 'gstStatus', 'gstReason']) <> '{}'::jsonb
     or p_expected_row_version is null or p_expected_row_version < 0 then
    perform authz.finance_invalid();
  end if;
  v_name := authz.finance_text(authz.finance_field(p_fields, 'billingName'), 1, 200, false);
  v_line1 := authz.finance_text(authz.finance_field(p_fields, 'addressLine1'), 1, 200, false);
  v_line2 := authz.finance_text(authz.finance_field(p_fields, 'addressLine2'), 1, 200, false);
  v_city := authz.finance_text(authz.finance_field(p_fields, 'city'), 1, 120, false);
  v_state := authz.finance_text(authz.finance_field(p_fields, 'stateCode'), 1, 2, false);
  v_postal := authz.finance_text(authz.finance_field(p_fields, 'postalCode'), 1, 6, false);
  v_gstin := upper(authz.finance_text(authz.finance_field(p_fields, 'gstin'), 1, 15, false));
  if v_name is null or v_line1 is null or v_city is null or v_state is null or v_postal is null
     or v_state !~ '^(0[1-9]|[12][0-9]|3[0-8]|97)$' or v_postal !~ '^[1-9][0-9]{5}$'
     or (v_gstin is not null and (v_gstin !~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$' or left(v_gstin, 2) <> v_state)) then
    perform authz.finance_invalid();
  end if;

  select * into v_old from public.customer_billing_profiles b where b.deal_id = v_deal.id for update;
  if coalesce(v_old.row_version, 0) <> p_expected_row_version then
    raise exception 'version_changed' using errcode = 'PT409';
  end if;
  -- Booking form: Bill To extras (absent = unchanged).
  v_x := authz.bf_bill_to(p_fields, v_old, v_gstin);
  if jsonb_array_length(v_x -> 'bad') > 0 then
    raise exception 'invalid_input' using errcode = '22023',
      hint = array_to_string(array(select jsonb_array_elements_text(v_x -> 'bad')), ',');
  end if;

  if v_old.deal_id is null then
    insert into public.customer_billing_profiles (deal_id, legal_entity_id, billing_name, address_line1, address_line2,
      city, state_code, postal_code, gstin, status, updated_by,
      bill_to_type, contact_person, phone, email, gst_status, gst_reason)
    values (v_deal.id, v_deal.legal_entity_id, v_name, v_line1, v_line2, v_city, v_state, v_postal, v_gstin, 'draft',
      (select auth.uid()),
      v_x ->> 'type', v_x ->> 'contactPerson', v_x ->> 'phone', v_x ->> 'email', v_x ->> 'gstStatus', v_x ->> 'gstReason')
    returning row_version into v_row;
    -- Review A L6: the Bill To names too.
    v_changed := array['billingName', 'addressLine1', 'addressLine2', 'city', 'stateCode', 'postalCode', 'gstin',
      'billToType', 'contactPerson', 'phone', 'email', 'gstStatus', 'gstReason'];
  else
    v_changed := array_remove(array[
      case when v_old.billing_name is distinct from v_name then 'billingName' end,
      case when v_old.address_line1 is distinct from v_line1 then 'addressLine1' end,
      case when v_old.address_line2 is distinct from v_line2 then 'addressLine2' end,
      case when v_old.city is distinct from v_city then 'city' end,
      case when v_old.state_code is distinct from v_state then 'stateCode' end,
      case when v_old.postal_code is distinct from v_postal then 'postalCode' end,
      case when v_old.gstin is distinct from v_gstin then 'gstin' end,
      case when v_old.bill_to_type is distinct from v_x ->> 'type' then 'billToType' end,
      case when v_old.contact_person is distinct from v_x ->> 'contactPerson' then 'contactPerson' end,
      case when v_old.phone is distinct from v_x ->> 'phone' then 'phone' end,
      case when v_old.email is distinct from v_x ->> 'email' then 'email' end,
      case when v_old.gst_status is distinct from v_x ->> 'gstStatus' then 'gstStatus' end,
      case when v_old.gst_reason is distinct from v_x ->> 'gstReason' then 'gstReason' end], null);
    update public.customer_billing_profiles b
    set billing_name = v_name, address_line1 = v_line1, address_line2 = v_line2, city = v_city,
        state_code = v_state, postal_code = v_postal, gstin = v_gstin, status = 'draft',
        bill_to_type = v_x ->> 'type', contact_person = v_x ->> 'contactPerson', phone = v_x ->> 'phone',
        email = v_x ->> 'email', gst_status = v_x ->> 'gstStatus', gst_reason = v_x ->> 'gstReason',
        verified_by = null, verified_at = null, row_version = b.row_version + 1,
        updated_by = (select auth.uid()), updated_at = now()
    where b.deal_id = v_deal.id
    returning row_version into v_row;
  end if;

  -- An approved review of the deal's confirmed booking returns to pending.
  select rv.* into v_review
  from public.accounts_booking_reviews rv
  join public.booking_versions v on v.id = rv.booking_version_id
  where v.deal_id = v_deal.id and v.status = 'confirmed'
  for update of rv;
  if v_review.status = 'approved' then
    update public.accounts_booking_reviews rv
    set status = 'pending', row_version = rv.row_version + 1, updated_at = now()
    where rv.id = v_review.id;
    perform authz.write_audit('finance.review_reset', v_deal.legal_entity_id, v_deal.branch_id, 'booking_version',
      v_review.booking_version_id, null, jsonb_build_object('cause', 'billing_saved'));
  end if;

  v_result := jsonb_build_object('outcome', case when v_old.deal_id is null then 'created' else 'updated' end,
    'id', v_deal.id, 'status', 'draft', 'rowVersion', v_row);
  perform authz.finance_remember(v_deal.legal_entity_id, p_request_id, 'accounts_billing_save', v_payload, v_result);
  perform authz.write_audit('finance.billing_saved', v_deal.legal_entity_id, v_deal.branch_id, 'deal', v_deal.id, null,
    jsonb_build_object('changedFields', to_jsonb(v_changed), 'rowVersion', v_row));
  return v_result;
end;
$$;

-- public.accounts_billing_verify(uuid, integer, uuid): from 20261101000100_accounts_receipts.sql
create or replace function public.accounts_billing_verify(p_deal_id uuid, p_expected_row_version integer, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_deal public.deals%rowtype;
  v_old public.customer_billing_profiles%rowtype;
  v_payload jsonb := jsonb_build_object('dealId', p_deal_id, 'expectedRowVersion', p_expected_row_version);
  v_result jsonb;
  v_row integer;
begin
  select * into v_deal from public.deals d where d.id = p_deal_id;
  perform authz.finance_require_accounts(v_deal.legal_entity_id, v_deal.is_synthetic);
  if p_request_id is null or p_expected_row_version is null then
    perform authz.finance_invalid();
  end if;
  perform authz.finance_lock_deal(v_deal.id);
  v_result := authz.finance_replay(v_deal.legal_entity_id, p_request_id, 'accounts_billing_verify', v_payload);
  if v_result is not null then
    return v_result;
  end if;

  select * into v_old from public.customer_billing_profiles b where b.deal_id = v_deal.id for update;
  if v_old.deal_id is null then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  if v_old.row_version <> p_expected_row_version then
    raise exception 'version_changed' using errcode = 'PT409';
  end if;
  if v_old.status = 'verified' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  -- The editor may verify: a data-quality step, not a money approval (contract 7).
  update public.customer_billing_profiles b
  set status = 'verified', verified_by = (select auth.uid()), verified_at = now(), row_version = b.row_version + 1
  where b.deal_id = v_deal.id
  returning row_version into v_row;

  v_result := jsonb_build_object('outcome', 'updated', 'id', v_deal.id, 'status', 'verified', 'rowVersion', v_row);
  perform authz.finance_remember(v_deal.legal_entity_id, p_request_id, 'accounts_billing_verify', v_payload, v_result);
  perform authz.write_audit('finance.billing_verified', v_deal.legal_entity_id, v_deal.branch_id, 'deal', v_deal.id, null,
    jsonb_build_object('editedBy', v_old.updated_by, 'verifiedBy', (select auth.uid()), 'rowVersion', v_row));
  return v_result;
end;
$$;

-- public.accounts_review_approve(uuid, integer, uuid): from 20261101000100_accounts_receipts.sql
create or replace function public.accounts_review_approve(p_booking_version_id uuid, p_expected_row_version integer, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.booking_versions%rowtype;
  v_review public.accounts_booking_reviews%rowtype;
  v_payload jsonb := jsonb_build_object('bookingVersionId', p_booking_version_id, 'expectedRowVersion', p_expected_row_version);
  v_result jsonb;
begin
  v_ver := authz.finance_confirmed_version(p_booking_version_id);
  if p_request_id is null or p_expected_row_version is null then
    perform authz.finance_invalid();
  end if;
  perform authz.finance_lock_deal(v_ver.deal_id);
  v_result := authz.finance_replay(v_ver.legal_entity_id, p_request_id, 'accounts_review_approve', v_payload);
  if v_result is not null then
    return v_result;
  end if;

  select * into v_review from public.accounts_booking_reviews rv where rv.booking_version_id = v_ver.id for update;
  if coalesce(v_review.row_version, 0) <> p_expected_row_version then
    raise exception 'version_changed' using errcode = 'PT409';
  end if;
  perform authz.finance_raise_block(authz.finance_approve_block(v_ver.id));

  -- Approval posts no money, issues no document and never changes the booking.
  if v_review.id is null then
    insert into public.accounts_booking_reviews (booking_version_id, deal_id, legal_entity_id, status, reviewed_by, reviewed_at)
    values (v_ver.id, v_ver.deal_id, v_ver.legal_entity_id, 'approved', (select auth.uid()), now())
    returning * into v_review;
  else
    update public.accounts_booking_reviews rv
    set status = 'approved', reviewed_by = (select auth.uid()), reviewed_at = now(),
        row_version = rv.row_version + 1, updated_at = now()
    where rv.id = v_review.id
    returning * into v_review;
  end if;

  v_result := jsonb_build_object('outcome', 'updated', 'id', v_review.id, 'status', 'approved', 'rowVersion', v_review.row_version);
  perform authz.finance_remember(v_ver.legal_entity_id, p_request_id, 'accounts_review_approve', v_payload, v_result);
  perform authz.write_audit('finance.review_approved', v_ver.legal_entity_id, v_ver.branch_id, 'booking_version', v_ver.id,
    null, jsonb_build_object('reviewId', v_review.id));
  return v_result;
end;
$$;

-- public.accounts_tally_exception(text, uuid, integer, jsonb, uuid): from 20261205000320_tally_match_upload.sql
create or replace function public.accounts_tally_exception(p_kind text, p_record_id uuid, p_expected_row_version integer, p_fields jsonb,
  p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  t record;
  v_tr public.tally_records%rowtype;
  v_payload jsonb := jsonb_build_object('kind', p_kind, 'recordId', p_record_id, 'expectedRowVersion', p_expected_row_version,
    'fields', p_fields);
  v_result jsonb;
  v_reason text;
  v_amount bigint;
  v_raw jsonb;
  v_from text;
begin
  select * into t from authz.tally_prelude(p_kind, p_record_id, p_request_id) x limit 1;
  select * into v_tr from public.tally_records r where r.record_kind = p_kind and r.record_id = p_record_id for update;
  v_result := authz.finance_replay(t.entity, p_request_id, 'accounts_tally_exception', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if p_expected_row_version is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'expectedRowVersion';
  end if;
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' or (p_fields - array['reason', 'tallyAmountPaise']) <> '{}'::jsonb then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fields';
  end if;
  begin
    v_reason := authz.finance_reason(authz.finance_field(p_fields, 'reason'));
  exception when sqlstate '22023' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'reason';
  end;
  v_raw := p_fields -> 'tallyAmountPaise';
  if v_raw is not null and jsonb_typeof(v_raw) <> 'null' then
    if jsonb_typeof(v_raw) <> 'string' or (v_raw #>> '{}') !~ '^[1-9][0-9]{0,14}$' then
      raise exception 'invalid_input' using errcode = '22023', hint = 'tallyAmountPaise';
    end if;
    v_amount := (v_raw #>> '{}')::bigint;
  end if;
  if coalesce(v_tr.row_version, 0) <> p_expected_row_version then
    raise exception 'version_changed' using errcode = 'PT409';
  end if;
  v_from := authz.tally_effective(t.computed, v_tr.status);
  if v_from in ('not_ready', 'not_applicable') then
    raise exception 'tally_not_ready' using errcode = '55000';
  elsif v_from = 'exception' then
    raise exception 'tally_exception_open' using errcode = '55000';
  end if;

  -- Accounts phase 3 (20261205000320): shared internal.
  v_tr := authz.tally_apply_exception(p_kind, p_record_id, t.entity, t.branch_id, t.deal_id, v_tr, v_reason, v_amount, v_from);
  v_result := jsonb_build_object('outcome', 'updated', 'tallyRecordId', v_tr.id, 'status', v_tr.status, 'rowVersion', v_tr.row_version);
  return authz.finance_remember(t.entity, p_request_id, 'accounts_tally_exception', v_payload, v_result);
end;
$$;

-- public.accounts_tally_invoice_withdraw(uuid, integer, text, uuid): from 20261203000250_accounts_tally_commands.sql
create or replace function public.accounts_tally_invoice_withdraw(p_id uuid, p_expected_row_version integer, p_reason text, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_inv public.deal_tally_invoices%rowtype;
  v_synthetic boolean;
  v_payload jsonb := jsonb_build_object('id', p_id, 'expectedRowVersion', p_expected_row_version, 'reason', p_reason);
  v_result jsonb;
  v_reason text;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  select * into v_inv from public.deal_tally_invoices g where g.id = p_id;
  if v_inv.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select d.is_synthetic into v_synthetic from public.deals d where d.id = v_inv.deal_id;
  perform authz.finance_require_accounts(v_inv.legal_entity_id, v_synthetic);
  perform authz.finance_lock_deal(v_inv.deal_id);
  select * into v_inv from public.deal_tally_invoices g where g.id = p_id for update;
  v_result := authz.finance_replay(v_inv.legal_entity_id, p_request_id, 'accounts_tally_invoice_withdraw', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if p_expected_row_version is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'expectedRowVersion';
  end if;
  begin
    v_reason := authz.finance_reason(p_reason);
  exception when sqlstate '22023' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'reason';
  end;
  if v_inv.row_version <> p_expected_row_version then
    raise exception 'version_changed' using errcode = 'PT409';
  end if;
  if v_inv.status <> 'active' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  update public.deal_tally_invoices g
  set status = 'withdrawn', withdrawn_by = (select auth.uid()), withdrawn_at = now(), withdraw_reason = v_reason,
      row_version = g.row_version + 1, updated_at = now()
  where g.id = v_inv.id
  returning * into v_inv;
  perform authz.write_audit('accounts.tally_invoice_withdrawn', v_inv.legal_entity_id, v_inv.branch_id, 'deal', v_inv.deal_id,
    v_reason, jsonb_build_object('dealId', v_inv.deal_id, 'tallyInvoiceId', v_inv.id, 'rowVersion', v_inv.row_version));
  v_result := jsonb_build_object('outcome', 'updated', 'id', v_inv.id, 'status', v_inv.status, 'rowVersion', v_inv.row_version);
  return authz.finance_remember(v_inv.legal_entity_id, p_request_id, 'accounts_tally_invoice_withdraw', v_payload, v_result);
end;
$$;

-- public.accounts_tally_match(text, uuid, integer, jsonb, uuid): from 20261205000320_tally_match_upload.sql
create or replace function public.accounts_tally_match(p_kind text, p_record_id uuid, p_expected_row_version integer, p_fields jsonb,
  p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  t record;
  v_tr public.tally_records%rowtype;
  v_payload jsonb := jsonb_build_object('kind', p_kind, 'recordId', p_record_id, 'expectedRowVersion', p_expected_row_version,
    'fields', p_fields);
  v_result jsonb;
  v_ref text;
  v_date date;
  v_from text;
begin
  select * into t from authz.tally_prelude(p_kind, p_record_id, p_request_id) x limit 1;
  select * into v_tr from public.tally_records r where r.record_kind = p_kind and r.record_id = p_record_id for update;
  v_result := authz.finance_replay(t.entity, p_request_id, 'accounts_tally_match', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if p_expected_row_version is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'expectedRowVersion';
  end if;
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' or (p_fields - array['voucherRef', 'voucherDate']) <> '{}'::jsonb then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fields';
  end if;
  begin
    v_ref := authz.finance_text(authz.finance_field(p_fields, 'voucherRef'), 1, 60, false);
  exception when sqlstate '22023' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'voucherRef';
  end;
  if v_ref is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'voucherRef';
  end if;
  v_date := authz.tally_voucher_date(authz.finance_field(p_fields, 'voucherDate'));
  if coalesce(v_tr.row_version, 0) <> p_expected_row_version then
    raise exception 'version_changed' using errcode = 'PT409';
  end if;
  v_from := authz.tally_effective(t.computed, v_tr.status);
  if v_from in ('not_ready', 'not_applicable') then
    raise exception 'tally_not_ready' using errcode = '55000';
  elsif v_from = 'matched' then
    raise exception 'already_matched' using errcode = '55000';
  elsif v_from = 'exception' then
    raise exception 'tally_exception_open' using errcode = '55000';
  end if;

  -- Accounts phase 3 (20261205000320): shared internal.
  v_tr := authz.tally_apply_match(p_kind, p_record_id, t.entity, t.branch_id, t.deal_id, v_tr, v_ref, v_date, v_from);
  v_result := jsonb_build_object('outcome', 'updated', 'tallyRecordId', v_tr.id, 'status', v_tr.status, 'rowVersion', v_tr.row_version);
  return authz.finance_remember(t.entity, p_request_id, 'accounts_tally_match', v_payload, v_result);
end;
$$;

-- public.accounts_tally_match_apply(uuid, text, uuid): from 20261205000320_tally_match_upload.sql
create or replace function public.accounts_tally_match_apply(p_batch_id uuid, p_expected_proposal_hash text, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_batch public.tally_match_batches%rowtype;
  v_payload jsonb := jsonb_build_object('batchId', p_batch_id, 'expectedProposalHash', p_expected_proposal_hash);
  v_result jsonb;
  v_rows jsonb;
  w record;
  t record;
  v_tr public.tally_records%rowtype;
  v_from text;
  v_matched integer := 0;
  v_exceptions integer := 0;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_batch_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'batchId';
  end if;
  select * into v_batch from public.tally_match_batches b where b.id = p_batch_id;
  if v_batch.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform authz.finance_require_accounts(v_batch.legal_entity_id, null);
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  v_result := authz.finance_replay(v_batch.legal_entity_id, p_request_id, 'accounts_tally_match_apply', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if p_expected_proposal_hash is null or p_expected_proposal_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'expectedProposalHash';
  end if;

  -- Lock order 17.1 (4): the Tally entity lock exclusive, then the batch, then Tally rows by id.
  perform authz.tally_entity_lock(v_batch.legal_entity_id, true);
  select * into v_batch from public.tally_match_batches b where b.id = p_batch_id for update;
  if v_batch.status <> 'staged' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  if v_batch.proposal_hash <> p_expected_proposal_hash then
    raise exception 'version_changed' using errcode = 'PT409';
  end if;
  v_rows := authz.tally_match_batch_rows(v_batch.id);
  if authz.tally_match_hash(v_batch.legal_entity_id, v_rows) <> v_batch.proposal_hash then
    raise exception 'version_changed' using errcode = 'PT409';
  end if;
  perform 1 from public.tally_records r
  where r.id in (select x.tally_record_id from public.tally_match_rows x
                 where x.batch_id = v_batch.id and x.outcome in ('matched', 'amount_differs'))
  order by r.id for update;

  for w in
    select x.* from public.tally_match_rows x
    where x.batch_id = v_batch.id and x.outcome in ('matched', 'amount_differs') order by x.row_no
  loop
    select * into v_tr from public.tally_records r where r.id = w.tally_record_id;
    select * into t from authz.tally_target(v_tr.record_kind, v_tr.record_id) x limit 1;
    v_from := authz.tally_effective(t.computed, v_tr.status);
    if w.outcome = 'matched' then
      perform authz.tally_apply_match(v_tr.record_kind, v_tr.record_id, v_tr.legal_entity_id, v_tr.branch_id, v_tr.deal_id, v_tr,
        w.voucher_ref, w.voucher_date, v_from);
      v_matched := v_matched + 1;
    else
      perform authz.tally_apply_exception(v_tr.record_kind, v_tr.record_id, v_tr.legal_entity_id, v_tr.branch_id, v_tr.deal_id, v_tr,
        left('Tally amount differs from the CRM amount (Tally voucher ' || w.voucher_ref || ' of '
             || to_char(w.voucher_date, 'YYYY-MM-DD') || ', matching upload).', 500),
        nullif(w.amount_paise, 0), v_from);
      v_exceptions := v_exceptions + 1;
    end if;
  end loop;

  update public.tally_match_batches b
  set status = 'applied', applied_by = (select auth.uid()), applied_at = now(), apply_request_id = p_request_id,
      row_version = b.row_version + 1
  where b.id = v_batch.id;
  perform authz.write_audit('accounts.tally_match.applied', v_batch.legal_entity_id, null, 'tally_match_batch', v_batch.id, null,
    jsonb_build_object('batchId', v_batch.id, 'matched', v_matched, 'exceptions', v_exceptions));
  v_result := jsonb_build_object('outcome', 'updated', 'batchId', v_batch.id, 'status', 'applied', 'matched', v_matched,
    'exceptions', v_exceptions);
  return authz.finance_remember(v_batch.legal_entity_id, p_request_id, 'accounts_tally_match_apply', v_payload, v_result);
end;
$$;

-- public.accounts_tally_reopen(text, uuid, integer, text, uuid): from 20261203000330_accounts_review2_fixes.sql
create or replace function public.accounts_tally_reopen(p_kind text, p_record_id uuid, p_expected_row_version integer, p_reason text,
  p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  t record;
  v_tr public.tally_records%rowtype;
  v_payload jsonb := jsonb_build_object('kind', p_kind, 'recordId', p_record_id, 'expectedRowVersion', p_expected_row_version,
    'reason', p_reason);
  v_result jsonb;
  v_reason text;
  v_from text;
  v_to text;
  v_prev_ref text;
  v_prev_date date;
begin
  select * into t from authz.tally_prelude(p_kind, p_record_id, p_request_id) x limit 1;
  select * into v_tr from public.tally_records r where r.record_kind = p_kind and r.record_id = p_record_id for update;
  v_result := authz.finance_replay(t.entity, p_request_id, 'accounts_tally_reopen', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if p_expected_row_version is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'expectedRowVersion';
  end if;
  begin
    v_reason := authz.finance_reason(p_reason);
  exception when sqlstate '22023' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'reason';
  end;
  if coalesce(v_tr.row_version, 0) <> p_expected_row_version then
    raise exception 'version_changed' using errcode = 'PT409';
  end if;
  v_from := authz.tally_effective(t.computed, v_tr.status);
  -- Accounts phase (20261203000300, Addendum L1): no dead ends.
  v_to := case
    when v_from = 'exception' and v_tr.status_before_exception = 'matched' and v_tr.voucher_ref is not null then 'matched'
    when v_from = 'exception' and (v_tr.status_before_exception = 'exported'
                                   or (v_tr.status_before_exception = 'ready' and v_tr.export_count > 0)) then 'exported'
    when v_from = 'exception' and v_tr.status_before_exception = 'ready' and v_tr.export_count = 0 then 'ready'
    when v_from = 'matched' and p_kind <> 'tally_gst_invoice' and v_tr.export_count > 0 then 'exported'
    when v_from = 'matched' and p_kind <> 'tally_gst_invoice' and v_tr.id is not null and v_tr.export_count = 0 then 'ready'
    else null end;
  if v_to is null then
    raise exception 'wrong_state' using errcode = '55000', hint = 'notReopenable';
  end if;

  v_prev_ref := v_tr.voucher_ref;
  v_prev_date := v_tr.voucher_date;
  -- Accounts phase (20261203000330): back to ready stores NULL (the computed status applies).
  update public.tally_records r
  set status = case when v_to = 'ready' then null else v_to end,
      voucher_ref = case when v_to = 'matched' then r.voucher_ref end,
      voucher_date = case when v_to = 'matched' then r.voucher_date end,
      matched_by = case when v_to = 'matched' then (select auth.uid()) end,
      matched_at = case when v_to = 'matched' then now() end,
      exception_reason = null, exception_tally_amount_paise = null, exception_by = null, exception_at = null,
      status_before_exception = null,
      row_version = r.row_version + 1, updated_at = now(), updated_by = (select auth.uid())
  where r.id = v_tr.id
  returning * into v_tr;
  perform authz.write_audit('accounts.tally_reopened', t.entity, t.branch_id, p_kind, p_record_id, v_reason,
    jsonb_build_object('tallyRecordId', v_tr.id, 'rowVersion', v_tr.row_version, 'fromStatus', v_from, 'toStatus', v_to,
      'previousVoucherRef', v_prev_ref, 'previousVoucherDate', to_char(v_prev_date, 'YYYY-MM-DD')));
  v_result := jsonb_build_object('outcome', 'updated', 'tallyRecordId', v_tr.id, 'status', coalesce(v_tr.status, v_to),
    'rowVersion', v_tr.row_version);
  return authz.finance_remember(t.entity, p_request_id, 'accounts_tally_reopen', v_payload, v_result);
end;
$$;

-- public.admin_set_customer_message_switch(uuid, text, text, boolean, text, integer): from 20261205000120_customer_message_commands.sql
create or replace function public.admin_set_customer_message_switch(
  p_entity uuid, p_type text, p_channel text, p_enabled boolean, p_reason text, p_expected_row_version integer
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_reason text := authz.cmsg_admin_check(p_entity, p_reason);
  v_row public.customer_message_switches%rowtype;
  v_prev text[];
begin
  if p_type is null or not (p_type = any (authz.cmsg_types())) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'type';
  end if;
  if p_channel is null or p_channel not in ('email', 'whatsapp') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'channel';
  end if;
  if p_enabled is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'enabled';
  end if;
  select * into v_row from public.customer_message_switches s
  where s.legal_entity_id = p_entity and s.message_type = p_type and s.channel = p_channel for update;
  if v_row.legal_entity_id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if p_expected_row_version is distinct from v_row.row_version then
    raise exception 'version_changed' using errcode = 'PT409';
  end if;
  if v_row.enabled = p_enabled then
    return jsonb_build_object('changed', false, 'enabled', v_row.enabled, 'rowVersion', v_row.row_version);
  end if;
  if p_enabled and p_channel = 'whatsapp' and exists (
       select 1 from unnest(array['en', 'hi']) l(l)
       where coalesce((select t.status from public.whatsapp_templates t
                       where t.legal_entity_id = p_entity and t.template_code = authz.cmsg_template_code(p_type, l.l)), '') <> 'approved') then
    raise exception 'template_not_approved' using errcode = '55000';
  end if;
  v_prev := authz.settings_begin_change('admin_set_customer_message_switch', v_reason);
  update public.customer_message_switches s
  set enabled = p_enabled, updated_by = (select auth.uid()), updated_at = now(), row_version = s.row_version + 1
  where s.legal_entity_id = p_entity and s.message_type = p_type and s.channel = p_channel
  returning * into v_row;
  perform authz.settings_end_change(v_prev);
  return jsonb_build_object('changed', true, 'enabled', v_row.enabled, 'rowVersion', v_row.row_version);
end;
$$;

-- public.bitrix_destination_scope_set(text, text, text, integer, text): from 20261128000100_vn_bitrix_trip_details.sql
create or replace function public.bitrix_destination_scope_set(
  p_list_id text, p_option_id text, p_scope text, p_expected_row_version integer, p_reason text
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_cfg public.integration_intake_config%rowtype;
  v_n integer;
  v_reason text;
  v_old public.bitrix_destination_scopes%rowtype;
  v_row integer;
begin
  select count(*) into v_n from public.integration_intake_config;
  if v_n <> 1 then
    raise exception 'intake is not configured' using errcode = '55000';
  end if;
  select * into v_cfg from public.integration_intake_config;
  if not authz.can_switch_live_settings(v_cfg.pilot_legal_entity_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  v_reason := authz.settings_change_reason(p_reason);
  if p_list_id is null or p_list_id not in ('DEAL_DESTINATION', 'DEAL_DESTINATION_MULTI') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'listId';
  end if;
  if p_option_id is null or p_option_id !~ '^[1-9][0-9]{0,9}$' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'optionId';
  end if;
  if p_scope is not null and p_scope not in ('domestic', 'international') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'scope';
  end if;
  if p_expected_row_version is null or p_expected_row_version < 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'expectedRowVersion';
  end if;
  if not exists (select 1 from public.bitrix_name_lists l
                 where l.source_portal = v_cfg.portal_member_id and l.entity_id = p_list_id and l.code = p_option_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select * into v_old from public.bitrix_destination_scopes s
  where s.source_portal = v_cfg.portal_member_id and s.list_entity_id = p_list_id and s.option_id = p_option_id
  for update;
  if coalesce(v_old.row_version, 0) <> p_expected_row_version then
    raise exception 'version_changed' using errcode = 'PT409';
  end if;
  if v_old.option_id is not null and v_old.scope is not distinct from p_scope then
    return jsonb_build_object('changed', false, 'scope', p_scope, 'rowVersion', v_old.row_version);
  end if;
  if v_old.option_id is null and p_scope is null then
    return jsonb_build_object('changed', false, 'scope', null, 'rowVersion', 0);
  end if;
  insert into public.bitrix_destination_scopes as s
    (source_portal, list_entity_id, option_id, legal_entity_id, scope, reason, set_by)
  values (v_cfg.portal_member_id, p_list_id, p_option_id, v_cfg.pilot_legal_entity_id, p_scope, v_reason,
    (select auth.uid()))
  on conflict (source_portal, list_entity_id, option_id) do update
  set scope = excluded.scope, reason = excluded.reason, set_by = excluded.set_by, set_at = now(),
      row_version = s.row_version + 1
  returning row_version into v_row;
  perform authz.write_audit('integration.destination_scope_set', v_cfg.pilot_legal_entity_id, null,
    'integration_intake_config', v_cfg.id, v_reason,
    jsonb_build_object('listId', p_list_id, 'optionId', p_option_id, 'before', v_old.scope, 'after', p_scope,
      'rowVersion', v_row));
  return jsonb_build_object('changed', true, 'scope', p_scope, 'rowVersion', v_row);
end;
$$;

-- public.bitrix_id_proof_copy_complete(uuid, uuid, text, text, bigint): from 20261120000700_b12_id_proof_bitrix_copy.sql
create or replace function public.bitrix_id_proof_copy_complete(
  p_job_id uuid, p_lease_token uuid, p_outcome text, p_error_code text, p_bitrix_file_id bigint
) returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_job public.bitrix_id_proof_copy_jobs%rowtype;
begin
  select * into v_job from public.bitrix_id_proof_copy_jobs j where j.id = p_job_id for update;
  if v_job.id is null or v_job.lease_token is distinct from p_lease_token then
    raise exception 'task_conflict' using errcode = 'PT409';
  end if;
  if p_outcome is null or p_outcome not in ('sent', 'retry', 'failed', 'unknown')
     or (p_error_code is not null and p_error_code !~ '^[a-z_]{1,60}$')
     or (p_outcome = 'sent' and (p_bitrix_file_id is null or p_bitrix_file_id <= 0))
     or (p_outcome in ('retry', 'failed', 'unknown') and p_error_code is null) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'outcome';
  end if;
  -- A job that ends before mark_sending (read or download failed, Deal gone,
  -- file changed) still uses an attempt, so retries stay bounded.
  if v_job.status = 'pending' and p_outcome <> 'sent' then
    update public.bitrix_id_proof_copy_jobs j set attempts = j.attempts + 1 where j.id = v_job.id returning * into v_job;
  end if;
  if p_outcome = 'sent' then
    update public.bitrix_id_proof_copy_jobs j
    set status = 'sent', bitrix_file_id = p_bitrix_file_id, sent_at = now(), last_error_code = null, read_back_attempts = 0,
        lease_token = null, locked_until = null, updated_at = now()
    where j.id = v_job.id returning * into v_job;
    perform authz.id_proof_copy_audit('integration.id_proof_copy_sent', v_job, jsonb_build_object('bitrixFileId', p_bitrix_file_id));
  elsif p_outcome = 'unknown' and v_job.read_back_attempts + 1 >= 5 then
    -- Review E8-2: five undecided read-backs in a row: stop trying, free the
    -- Deal, and leave it to the Super Admin (alerts, manual retry).
    update public.bitrix_id_proof_copy_jobs j
    set status = 'needs_manual_check', read_back_attempts = j.read_back_attempts + 1, last_error_code = p_error_code,
        lease_token = null, locked_until = null, updated_at = now()
    where j.id = v_job.id returning * into v_job;
    perform authz.id_proof_copy_audit('integration.id_proof_copy_needs_manual_check', v_job,
      jsonb_build_object('errorCode', p_error_code, 'readBackAttempts', v_job.read_back_attempts));
  elsif p_outcome = 'unknown' then
    update public.bitrix_id_proof_copy_jobs j
    set status = 'unknown', read_back_attempts = j.read_back_attempts + 1, last_error_code = p_error_code,
        next_attempt_at = now() + authz.id_proof_copy_backoff(j.read_back_attempts + 1),
        lease_token = null, locked_until = null, updated_at = now()
    where j.id = v_job.id returning * into v_job;
    perform authz.id_proof_copy_audit('integration.id_proof_copy_unknown', v_job, jsonb_build_object('errorCode', p_error_code));
  elsif p_outcome = 'retry' and v_job.attempts < v_job.max_attempts then
    update public.bitrix_id_proof_copy_jobs j
    set status = 'pending', read_back_attempts = 0, last_error_code = p_error_code, next_attempt_at = now() + authz.id_proof_copy_backoff(j.attempts),
        lease_token = null, locked_until = null, updated_at = now()
    where j.id = v_job.id returning * into v_job;
    perform authz.id_proof_copy_audit('integration.id_proof_copy_retry_scheduled', v_job, jsonb_build_object('errorCode', p_error_code));
  else
    update public.bitrix_id_proof_copy_jobs j
    set status = 'failed', last_error_code = p_error_code, lease_token = null, locked_until = null, updated_at = now()
    where j.id = v_job.id returning * into v_job;
    perform authz.id_proof_copy_audit('integration.id_proof_copy_failed', v_job, jsonb_build_object('errorCode', p_error_code));
  end if;
  return jsonb_build_object('jobId', v_job.id, 'status', v_job.status, 'attempts', v_job.attempts, 'errorCode', v_job.last_error_code);
end;
$$;

-- public.bitrix_id_proof_copy_mark_sending(uuid, uuid, bigint[]): from 20261120000700_b12_id_proof_bitrix_copy.sql
create or replace function public.bitrix_id_proof_copy_mark_sending(p_job_id uuid, p_lease_token uuid, p_prior_file_ids bigint[])
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_job public.bitrix_id_proof_copy_jobs%rowtype;
begin
  select * into v_job from public.bitrix_id_proof_copy_jobs j where j.id = p_job_id for update;
  if v_job.id is null or v_job.lease_token is distinct from p_lease_token or v_job.locked_until < now() then
    raise exception 'task_conflict' using errcode = 'PT409';
  end if;
  if v_job.status <> 'pending' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  if p_prior_file_ids is null or cardinality(p_prior_file_ids) > 200
     or exists (select 1 from unnest(p_prior_file_ids) x where x is null or x <= 0) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'priorFileIds';
  end if;
  update public.bitrix_id_proof_copy_jobs j
  set status = 'unknown', attempts = j.attempts + 1, prior_file_ids = p_prior_file_ids, updated_at = now()
  where j.id = v_job.id
  returning * into v_job;
  return jsonb_build_object('jobId', v_job.id, 'status', v_job.status, 'attempts', v_job.attempts);
end;
$$;

-- public.bitrix_id_proof_copy_stop(uuid, uuid, text): from 20261120000700_b12_id_proof_bitrix_copy.sql
create or replace function public.bitrix_id_proof_copy_stop(p_job_id uuid, p_lease_token uuid, p_reason_code text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_job public.bitrix_id_proof_copy_jobs%rowtype;
  v_cfg public.integration_intake_config%rowtype;
  v_prev text[];
  v_stop uuid;
begin
  if p_reason_code is null or p_reason_code not in ('prior_files_lost') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'reason';
  end if;
  select * into v_job from public.bitrix_id_proof_copy_jobs j where j.id = p_job_id for update;
  if v_job.id is null or v_job.lease_token is distinct from p_lease_token then
    raise exception 'task_conflict' using errcode = 'PT409';
  end if;
  update public.bitrix_id_proof_copy_jobs j
  set status = 'failed', last_error_code = p_reason_code, lease_token = null, locked_until = null, updated_at = now()
  where j.id = v_job.id returning * into v_job;
  perform authz.id_proof_copy_audit('integration.id_proof_copy_failed', v_job, jsonb_build_object('errorCode', p_reason_code));

  select * into v_cfg from public.integration_intake_config c where c.portal_member_id = v_job.source_portal for update;
  if v_cfg.id is not null and v_cfg.bitrix_id_proof_copy then
    v_prev := authz.settings_begin_change('bitrix_id_proof_copy_stop', 'automatic stop: ' || p_reason_code);
    update public.integration_intake_config c
    set bitrix_id_proof_copy = false, updated_at = now()
    where c.id = v_cfg.id;
    perform authz.settings_end_change(v_prev);
  end if;
  insert into public.bitrix_id_proof_copy_stops (legal_entity_id, portal_member_id, job_id, source_deal_id, reason_code)
  values (v_job.legal_entity_id, v_job.source_portal, v_job.id, v_job.source_deal_id, p_reason_code)
  returning id into v_stop;
  perform authz.id_proof_copy_audit('integration.id_proof_copy_auto_stopped', v_job,
    jsonb_build_object('reasonCode', p_reason_code, 'stopId', v_stop, 'switchWasOn', coalesce(v_cfg.bitrix_id_proof_copy, false)));
  return jsonb_build_object('stopId', v_stop, 'jobId', v_job.id, 'switchOn', false);
end;
$$;

-- public.booking_change_request_decide(uuid, text, text, integer, uuid): from 20261205000780_manager_approves_final.sql
create or replace function public.booking_change_request_decide(p_id uuid, p_decision text, p_reason text, p_expected_row_version integer,
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
  v_n integer := 0;  -- Accounts phase 3 (20261205000780)
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
  v_row := authz.cr_lock_h(p_id);  -- Accounts phase 3 (20261205000780): 17.1 (decide may apply)
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
    -- Accounts phase 3 (20261205000780) (O2): the Manager approves exactly the version sent.
    if not exists (select 1 from public.booking_versions v where v.id = v_row.change_version_id and v.status = 'draft')
       or v_row.submitted_content_hash is distinct from authz.booking_content_hash(v_row.change_version_id) then
      raise exception 'version_changed' using errcode = 'PT409';
    end if;
    v_block := authz.booking_change_approve_block(v_row.id);  -- track H hook (11.3)
    if v_block is not null then
      raise exception '%', v_block using errcode = case when v_block = 'not_self_approval' then '42501' else '55000' end;
    end if;
    update public.booking_change_requests r
    set status = 'approved', decided_by = v_uid, decided_at = now(), decision_request_id = p_request_id,
        approved_content_hash = r.submitted_content_hash,  -- Accounts phase 3 (20261205000780)
        row_version = r.row_version + 1
    where r.id = v_row.id
    returning * into v_row;
    perform authz.write_audit('booking.change_approved', v_row.legal_entity_id, v_row.branch_id, 'booking_change_request', v_row.id,
      v_reason, jsonb_build_object('changeRequestId', v_row.id, 'dealId', v_row.deal_id, 'kind', v_row.kind,
        'rowVersion', v_row.row_version));
    -- Accounts phase 3 (20261205000780) (O2, moved from submit): one pending reconfirmation per
    -- changed Purchase service whose supplier confirmed (a change only; LD27);
    -- with none the change applies at once.
    insert into public.task_reconfirmations (legal_entity_id, change_request_id, task_id, booking_version_id, budget_paise)
    select t.legal_entity_id, v_row.id, t.id, v_row.change_version_id, f.purchase_budget_paise
    from public.fulfilment_tasks t
    left join public.service_item_facts f on f.service_item_id = t.service_item_id and f.booking_version_id = v_row.change_version_id
    where v_row.kind = 'change' and t.deal_id = v_row.deal_id
      and t.service_item_id = any (authz.cr_changed_item_ids(v_row.change_version_id))
      and t.department = 'purchase' and t.status = 'supplier_confirmed' and t.closed_state is null
    order by t.id;
    get diagnostics v_n = row_count;
    if v_n = 0 then
      perform authz.cr_apply_if_ready(v_row.id);
    end if;
    select * into v_row from public.booking_change_requests r where r.id = v_row.id;
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
  v_result := authz.cr_json(v_row) || jsonb_build_object('outcome', 'updated',
    'reconfirmations', v_n, 'applied', v_row.status = 'applied');  -- Accounts phase 3 (20261205000780)
  return authz.finance_remember(v_row.legal_entity_id, p_request_id, 'booking_change_request_decide', v_payload, v_result);
end;
$$;

-- public.booking_change_submit(uuid, text, uuid[], uuid): from 20261205000780_manager_approves_final.sql
create or replace function public.booking_change_submit(p_change_request_id uuid, p_expected_content_hash text,
  p_expected_changed_item_ids uuid[], p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_row public.booking_change_requests%rowtype;
  v_payload jsonb := jsonb_build_object('changeRequestId', p_change_request_id, 'contentHash', p_expected_content_hash,
    'changedItemIds', to_jsonb(p_expected_changed_item_ids));
  v_result jsonb;
  v_ver public.booking_versions%rowtype;
  v_fields text[];
  v_changed uuid[];
  v_outside text;
  v_expected uuid[];
  v_class text;
  v_issues text[];
  v_n integer := 0;
  v_applied boolean := false;
  v_added uuid[];  -- Accounts phase 3 (20261205000720)
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
  v_row := authz.cr_lock_apply(p_change_request_id);
  v_result := authz.finance_replay(v_row.legal_entity_id, p_request_id, 'booking_change_submit', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if v_row.status not in ('draft', 'returned') or v_row.change_version_id is null then  -- Accounts phase 3 (20261205000780) (O2)
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  if v_row.kind = 'change' and not authz.booking_changes_enabled() then
    raise exception 'changes_off' using errcode = '55000';
  end if;
  -- Accounts phase 3 (20261205000720): adding or removing a service needs its own switch.
  if v_row.kind <> 'change' and not authz.service_changes_enabled() then
    raise exception 'service_changes_off' using errcode = '55000';
  end if;
  if not exists (select 1 from public.booking_versions b where b.id = v_row.base_version_id and b.status = 'confirmed') then
    raise exception 'version_superseded' using errcode = '55000';
  end if;
  select * into v_ver from public.booking_versions v where v.id = v_row.change_version_id;
  if v_ver.status <> 'draft' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  if p_expected_content_hash is null or p_expected_content_hash <> authz.booking_content_hash(v_ver.id) then
    raise exception 'version_changed' using errcode = 'PT409';
  end if;
  v_fields := authz.revision_changed_fields(v_ver.id);
  if cardinality(v_fields) = 0 then
    raise exception 'not_ready' using errcode = '55000', hint = 'no_changes';
  end if;
  -- LD28: every service whose facts changed is named in the approved request.
  v_changed := authz.cr_changed_item_ids(v_ver.id);
  -- Accounts phase 3 (20261205000720): add - the request names exactly the services added
  -- in the change version (no existing service may change, 11.2); remove - the
  -- service is gone from the version, and a simple removal must still be simple.
  if v_row.kind = 'add_service' then
    select coalesce(array_agg(f.service_item_id order by f.service_item_id), '{}'::uuid[]) into v_added
    from public.service_item_facts f
    where f.booking_version_id = v_ver.id
      and not exists (select 1 from public.service_item_facts b
                      where b.booking_version_id = v_row.base_version_id and b.service_item_id = f.service_item_id);
    if cardinality(v_added) = 0 then
      raise exception 'not_ready' using errcode = '55000', hint = 'no_service_added';
    end if;
    if v_added is distinct from v_row.item_ids then
      update public.booking_change_requests r set item_ids = v_added where r.id = v_row.id
      returning * into v_row;
    end if;
  elsif v_row.kind = 'remove_service' then
    if exists (select 1 from public.service_item_facts f
               where f.booking_version_id = v_ver.id and f.service_item_id = any (v_row.item_ids)) then
      raise exception 'not_ready' using errcode = '55000', hint = 'service_not_removed';
    end if;
    if v_row.removal_route = 'simple' and authz.cr_removal_route(v_row.item_ids[1]) = 'cancellation' then
      raise exception 'not_ready' using errcode = '55000', hint = 'service_booked';
    end if;
  end if;
  select string_agg(i.item_no::text, ',' order by i.item_no) into v_outside
  from public.service_items i
  where i.id = any (v_changed) and not (i.id = any (v_row.item_ids));
  if v_outside is not null then
    raise exception 'change_outside_request' using errcode = '22023', hint = v_outside;
  end if;
  -- The set the screen showed.
  select coalesce(array_agg(distinct x order by x), '{}'::uuid[]) into v_expected
  from unnest(coalesce(p_expected_changed_item_ids, '{}'::uuid[])) x;
  if v_expected is distinct from v_changed then
    raise exception 'version_changed' using errcode = 'PT409';
  end if;
  -- The weakest allowed class, for the history view.
  v_class := (authz.revision_allowed_classes(v_fields))[1];
  update public.booking_versions v set change_class = v_class, changed_fields = v_fields, updated_at = now(),
    updated_by = v_uid
  where v.id = v_ver.id
  returning * into v_ver;
  v_issues := authz.booking_issues(v_ver.id);
  if cardinality(v_issues) > 0 then
    raise exception 'not_ready' using errcode = '55000', hint = v_issues[1];
  end if;

  -- Accounts phase 3 (20261205000780) (O2): reconfirmations are written when the Manager
  -- approves this exact version (booking_change_request_decide).
  v_n := 0;

  update public.booking_change_requests r
  set status = 'requested', submitted_by = v_uid, submitted_at = now(), changed_fields = v_fields, change_class = v_class,
      -- Accounts phase 3 (20261205000780) (O2): sent to the Manager with the version's content hash.
      submitted_content_hash = authz.booking_content_hash(v_ver.id),
      decided_by = null, decided_at = null, decision_request_id = null,
      row_version = r.row_version + 1
  where r.id = v_row.id
  returning * into v_row;
  perform authz.write_audit('booking.change_submitted', v_row.legal_entity_id, v_row.branch_id, 'booking_change_request', v_row.id,
    null, jsonb_build_object('changeRequestId', v_row.id, 'dealId', v_row.deal_id, 'versionId', v_ver.id,
      'reconfirmations', v_n, 'changedItemCount', cardinality(v_changed)));
  if v_n = 0 then
    v_applied := authz.cr_apply_if_ready(v_row.id);
  end if;
  select * into v_row from public.booking_change_requests r where r.id = v_row.id;
  v_result := authz.cr_json(v_row) || jsonb_build_object('outcome', 'updated', 'reconfirmations', v_n, 'applied', v_applied);
  return authz.finance_remember(v_row.legal_entity_id, p_request_id, 'booking_change_submit', v_payload, v_result);
end;
$$;

-- public.booking_confirm(uuid, text): from 20261205000720_service_change_apply.sql
create or replace function public.booking_confirm(p_version_id uuid, p_expected_content_hash text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.booking_versions%rowtype;
  v_deal public.deals%rowtype;
  v_task uuid;
  v_task_version uuid;
  v_key text;
  v_env text;
  v_item record;
  v_hotel_item uuid;
  v_tasks uuid[] := '{}'::uuid[];
  -- B1.1 revision
  v_base public.booking_versions%rowtype;
  v_review text;
begin
  -- 1. Row lock: a concurrent confirmation waits here, then sees 'confirmed'.
  select * into v_ver from public.booking_versions v where v.id = p_version_id for update;
  -- Stage 0: a Deal removed by the Bitrix sync takes no new booking work.
  perform authz.refuse_removed_deal(v_ver.deal_id);
  -- 2. Existence is not revealed.
  if v_ver.id is null or not authz.can_confirm_booking(v_ver.deal_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  -- 3. Repeat / concurrent confirmation: every task of the version, item order.
  if v_ver.status = 'confirmed' then
    -- B1.1 revision: a package version's tasks are its items' tasks (a revision creates none).
    select coalesce(array_agg(t.id order by i.item_no, t.created_at), '{}'::uuid[]) into v_tasks
    from public.fulfilment_tasks t join public.service_items i on i.id = t.service_item_id
    where t.booking_version_id = v_ver.id
       or (v_ver.service_type = 'package' and t.service_item_id in (
             select f.service_item_id from public.service_item_facts f where f.booking_version_id = v_ver.id));
    if cardinality(v_tasks) > 0 or v_ver.service_type = 'package' then
      return jsonb_build_object('outcome', 'existing', 'taskId', v_tasks[1], 'versionId', v_ver.id,
        'taskIds', to_jsonb(v_tasks));
    end if;
    raise exception 'already_confirmed' using errcode = '55000';
  end if;
  -- Accounts phase 3 (20261205000630): a change version is confirmed only by the change flow.
  if v_ver.change_request_id is not null then
    raise exception 'use_change_flow' using errcode = '55000';
  end if;
  -- B1: a package version confirms only while the switch is on.
  if v_ver.service_type = 'package' and not authz.service_items_enabled() then
    raise exception 'service_items_disabled' using errcode = '55000';
  end if;
  -- 4. Optimistic check against the live hash.
  if p_expected_content_hash is null or p_expected_content_hash <> authz.booking_content_hash(v_ver.id) then
    raise exception 'version_changed' using errcode = 'PT409';
  end if;
  -- 5. Gate.
  select * into v_deal from public.deals d where d.id = v_ver.deal_id;
  v_env := authz.deployment_environment();
  if v_env = 'unset' then
    raise exception 'environment_unset' using errcode = '55000';
  end if;
  if not v_deal.is_synthetic
     and not coalesce((select s.real_booking_enabled from public.booking_settings s where s.id), false) then
    raise exception 'booking_disabled' using errcode = '55000';
  end if;
  if v_deal.is_synthetic and v_env <> 'test' then
    raise exception 'booking_disabled' using errcode = '55000';
  end if;
  -- B1.1 revision: the base must still be the accepted version, returned by
  -- Accounts, with no supplier-confirmed or completed work on the Deal.
  if v_ver.revises_version_id is not null then
    select * into v_base from public.booking_versions b where b.id = v_ver.revises_version_id for update;
    if v_base.status <> 'confirmed' then
      raise exception 'version_superseded' using errcode = '55000';
    end if;
    select rv.status into v_review from public.accounts_booking_reviews rv where rv.booking_version_id = v_base.id for update;
    if v_review is distinct from 'returned' then
      raise exception 'revision_not_allowed' using errcode = '55000';
    end if;
    if authz.deal_committed(v_ver.deal_id) then
      raise exception 'already_committed' using errcode = '55000';
    end if;
    -- Review R1: the recorded class must still match the actual changes.
    if v_ver.change_class is null or v_ver.changed_fields is distinct from authz.revision_changed_fields(v_ver.id)
       or not (v_ver.change_class = any (authz.revision_allowed_classes(authz.revision_changed_fields(v_ver.id)))) then
      raise exception 'not_ready' using errcode = '55000';
    end if;
  end if;
  -- 6. Readiness (package versions: includes stage_not_confirmed, no_services, ...).
  if cardinality(authz.booking_issues(v_ver.id)) > 0 then
    raise exception 'not_ready' using errcode = '55000';
  end if;
  if v_ver.service_type <> 'package' then
    -- Legacy hotel version: the Deal's hotel item and its facts snapshot.
    v_hotel_item := authz.hotel_item_for_deal(v_ver.deal_id, v_ver.created_by, v_ver.created_at);
    perform authz.hotel_facts_sync(v_ver.id, v_hotel_item);
  end if;
  -- Accounts phase 3 (20261205000630): traveller snapshot, supersede and freeze moved to authz.booking_version_freeze.
  v_ver := authz.booking_version_freeze(v_ver.id, case when v_ver.revises_version_id is not null then v_base.id end);
  -- B1.1 revision: no new task; the items' existing tasks continue.
  if v_ver.revises_version_id is not null then
    select coalesce(array_agg(t.id order by i.item_no, t.created_at), '{}'::uuid[]) into v_tasks
    from public.fulfilment_tasks t join public.service_items i on i.id = t.service_item_id
    where t.service_item_id in (select f.service_item_id from public.service_item_facts f where f.booking_version_id = v_ver.id);
    insert into public.outbox_events (legal_entity_id, aggregate_type, aggregate_id, event_type, payload)
    values (v_ver.legal_entity_id, 'booking_version', v_ver.id, 'booking.version_revised',
      jsonb_build_object('version_id', v_ver.id, 'deal_id', v_ver.deal_id, 'version_no', v_ver.version_no,
        'base_version_id', v_base.id))
    on conflict (event_type, aggregate_id) do nothing;
    perform authz.write_audit('booking.version_superseded', v_base.legal_entity_id, v_base.branch_id, 'booking_version',
      v_base.id, null, jsonb_build_object('dealId', v_base.deal_id, 'versionNo', v_base.version_no,
        'supersededByVersionId', v_ver.id));
    perform authz.write_audit('booking.version_revised', v_ver.legal_entity_id, v_ver.branch_id, 'booking_version',
      v_ver.id, null, jsonb_build_object('dealId', v_ver.deal_id, 'versionNo', v_ver.version_no, 'baseVersionId', v_base.id,
        'changeClass', v_ver.change_class, 'changedFields', to_jsonb(coalesce(v_ver.changed_fields, '{}'::text[])),
        'taskIds', to_jsonb(v_tasks)));
    return jsonb_build_object('outcome', 'revised', 'versionId', v_ver.id, 'supersededVersionId', v_base.id,
      'taskId', v_tasks[1], 'taskIds', to_jsonb(v_tasks));
  end if;
  -- 8. Exactly one task per item (hotel path: one task, legacy key).
  if v_ver.service_type = 'package' then
    -- Accounts phase 3 (20261205000720): the task-creation loop moved unchanged to
    -- authz.booking_create_item_tasks (used by the change apply too, 11.2).
    v_tasks := authz.booking_create_item_tasks(v_ver.id, null);
    insert into public.outbox_events (legal_entity_id, aggregate_type, aggregate_id, event_type, payload)
    values (v_ver.legal_entity_id, 'booking_version', v_ver.id, 'booking.version_confirmed',
      jsonb_strip_nulls(jsonb_build_object('version_id', v_ver.id, 'deal_id', v_ver.deal_id, 'task_id', v_tasks[1],
        'version_no', v_ver.version_no, 'service_purpose', 'package')))
    on conflict (event_type, aggregate_id) do nothing;
    perform authz.write_audit('booking.version_confirmed', v_ver.legal_entity_id, v_ver.branch_id,
      'booking_version', v_ver.id, null,
      jsonb_build_object('dealId', v_ver.deal_id, 'versionNo', v_ver.version_no, 'taskId', v_tasks[1],
        'taskIds', to_jsonb(v_tasks), 'serviceType', 'package'));
    return jsonb_build_object('outcome', 'created', 'taskId', v_tasks[1], 'versionId', v_ver.id,
      'taskIds', to_jsonb(v_tasks));
  end if;

  v_key := 'booking:' || v_ver.id::text || ':hotel';
  insert into public.fulfilment_tasks
    (deal_id, legal_entity_id, branch_id, booking_version_id, service_purpose, task_key, created_by, service_item_id)
  values (v_ver.deal_id, v_ver.legal_entity_id, v_ver.branch_id, v_ver.id, 'hotel', v_key, (select auth.uid()),
    v_hotel_item)
  on conflict (task_key) do nothing
  returning id into v_task;
  if v_task is null then
    select t.id, t.booking_version_id into v_task, v_task_version
    from public.fulfilment_tasks t where t.task_key = v_key;
    if v_task_version is distinct from v_ver.id then
      raise exception 'task_conflict' using errcode = 'PT409';
    end if;
  end if;
  update public.service_items i set state = 'active', updated_at = now()
  where i.id = v_hotel_item and i.state = 'planned';
  -- 9. Outbox (ids only).
  insert into public.outbox_events (legal_entity_id, aggregate_type, aggregate_id, event_type, payload)
  values
    (v_ver.legal_entity_id, 'booking_version', v_ver.id, 'booking.version_confirmed',
     jsonb_build_object('version_id', v_ver.id, 'deal_id', v_ver.deal_id, 'task_id', v_task,
       'version_no', v_ver.version_no, 'service_purpose', 'hotel')),
    (v_ver.legal_entity_id, 'fulfilment_task', v_task, 'fulfilment.task_created',
     jsonb_build_object('task_id', v_task, 'version_id', v_ver.id, 'deal_id', v_ver.deal_id,
       'version_no', v_ver.version_no, 'service_purpose', 'hotel'))
  on conflict (event_type, aggregate_id) do nothing;
  -- 10. Audit: ids and version_no only.
  perform authz.write_audit('booking.version_confirmed', v_ver.legal_entity_id, v_ver.branch_id,
    'booking_version', v_ver.id, null,
    jsonb_build_object('dealId', v_ver.deal_id, 'versionNo', v_ver.version_no, 'taskId', v_task));
  perform authz.write_audit('fulfilment.task_created', v_ver.legal_entity_id, v_ver.branch_id,
    'fulfilment_task', v_task, null,
    jsonb_build_object('dealId', v_ver.deal_id, 'versionId', v_ver.id, 'versionNo', v_ver.version_no));
  -- 11.
  return jsonb_build_object('outcome', 'created', 'taskId', v_task, 'versionId', v_ver.id,
    'taskIds', jsonb_build_array(v_task));
end;
$$;

-- public.booking_save_draft(uuid, integer, jsonb, bigint, boolean): from 20261205000790_manager_fills_change_without_owner.sql
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
    raise exception 'version_changed' using errcode = 'PT409';
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

-- public.company_destination_approve(uuid, integer, uuid): from 20261110000100_company_destinations.sql
create or replace function public.company_destination_approve(p_version_id uuid, p_expected_row_version integer, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_dest public.company_destinations%rowtype;
  v_ver public.company_destination_versions%rowtype;
  v_payload jsonb := jsonb_build_object('versionId', p_version_id, 'expectedRowVersion', p_expected_row_version);
  v_result jsonb;
  v_previous uuid;
begin
  v_ver := authz.destination_lock_for_decision(p_version_id);
  select * into v_dest from public.company_destinations d where d.id = v_ver.destination_id;
  if p_request_id is null then
    perform authz.finance_invalid();
  end if;
  v_result := authz.finance_replay(v_dest.legal_entity_id, p_request_id, 'company_destination_approve', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if p_expected_row_version is distinct from v_dest.row_version then
    raise exception 'version_changed' using errcode = 'PT409';
  end if;
  if v_ver.status <> 'submitted' or v_dest.retired_at is not null then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  if v_ver.maker = (select auth.uid()) then
    raise exception 'not_self_approval' using errcode = '42501';
  end if;

  v_previous := v_dest.current_version_id;
  if v_previous is not null then
    update public.company_destination_versions v set status = 'superseded' where v.id = v_previous;
  end if;
  update public.company_destination_versions v
  set status = 'approved', decided_by = (select auth.uid()), decided_at = now()
  where v.id = v_ver.id;
  update public.company_destinations d
  set current_version_id = v_ver.id, row_version = d.row_version + 1, updated_at = now()
  where d.id = v_dest.id returning * into v_dest;

  v_result := jsonb_build_object('outcome', 'updated', 'id', v_ver.id, 'destinationId', v_dest.id, 'versionId', v_ver.id,
    'versionNo', v_ver.version_no, 'status', 'approved', 'rowVersion', v_dest.row_version);
  perform authz.finance_remember(v_dest.legal_entity_id, p_request_id, 'company_destination_approve', v_payload, v_result);
  perform authz.write_audit('finance.destination_approved', v_dest.legal_entity_id, null, 'company_destination', v_dest.id, null,
    jsonb_build_object('versionId', v_ver.id, 'versionNo', v_ver.version_no, 'supersededVersionId', v_previous));
  return v_result;
end;
$$;

-- public.company_destination_retire(uuid, integer, text, uuid): from 20261110000100_company_destinations.sql
create or replace function public.company_destination_retire(
  p_destination_id uuid, p_expected_row_version integer, p_reason text, p_request_id uuid
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_dest public.company_destinations%rowtype;
  v_entity uuid;
  v_payload jsonb := jsonb_build_object('destinationId', p_destination_id, 'expectedRowVersion', p_expected_row_version,
    'reason', p_reason);
  v_result jsonb;
  v_reason text;
begin
  select d.legal_entity_id into v_entity from public.company_destinations d where d.id = p_destination_id;
  perform authz.finance_require_accounts(v_entity, null);
  select * into v_dest from public.company_destinations d where d.id = p_destination_id for update;
  if p_request_id is null then
    perform authz.finance_invalid();
  end if;
  v_result := authz.finance_replay(v_entity, p_request_id, 'company_destination_retire', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  v_reason := authz.finance_reason(p_reason);
  if p_expected_row_version is distinct from v_dest.row_version then
    raise exception 'version_changed' using errcode = 'PT409';
  end if;
  if v_dest.retired_at is not null then
    raise exception 'wrong_state' using errcode = '55000';
  end if;

  update public.company_destinations d
  set retired_at = now(), retired_by = (select auth.uid()), retire_reason = v_reason,
      row_version = d.row_version + 1, updated_at = now()
  where d.id = v_dest.id returning * into v_dest;

  v_result := jsonb_build_object('outcome', 'updated', 'id', v_dest.id, 'destinationId', v_dest.id, 'status', 'retired',
    'rowVersion', v_dest.row_version);
  perform authz.finance_remember(v_entity, p_request_id, 'company_destination_retire', v_payload, v_result);
  perform authz.write_audit('finance.destination_retired', v_entity, null, 'company_destination', v_dest.id, null,
    jsonb_build_object('currentVersionId', v_dest.current_version_id));
  return v_result;
end;
$$;

-- public.company_destination_return(uuid, integer, text, uuid): from 20261110000100_company_destinations.sql
create or replace function public.company_destination_return(
  p_version_id uuid, p_expected_row_version integer, p_reason text, p_request_id uuid
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_dest public.company_destinations%rowtype;
  v_ver public.company_destination_versions%rowtype;
  v_payload jsonb := jsonb_build_object('versionId', p_version_id, 'expectedRowVersion', p_expected_row_version,
    'reason', p_reason);
  v_result jsonb;
  v_reason text;
begin
  v_ver := authz.destination_lock_for_decision(p_version_id);
  select * into v_dest from public.company_destinations d where d.id = v_ver.destination_id;
  if p_request_id is null then
    perform authz.finance_invalid();
  end if;
  v_result := authz.finance_replay(v_dest.legal_entity_id, p_request_id, 'company_destination_return', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  v_reason := authz.finance_reason(p_reason);
  if p_expected_row_version is distinct from v_dest.row_version then
    raise exception 'version_changed' using errcode = 'PT409';
  end if;
  if v_ver.status <> 'submitted' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  if v_ver.maker = (select auth.uid()) then
    raise exception 'not_self_approval' using errcode = '42501';
  end if;

  update public.company_destination_versions v
  set status = 'returned', decided_by = (select auth.uid()), decided_at = now(), decision_reason = v_reason
  where v.id = v_ver.id;
  update public.company_destinations d set row_version = d.row_version + 1, updated_at = now()
  where d.id = v_dest.id returning * into v_dest;

  v_result := jsonb_build_object('outcome', 'updated', 'id', v_ver.id, 'destinationId', v_dest.id, 'versionId', v_ver.id,
    'versionNo', v_ver.version_no, 'status', 'returned', 'rowVersion', v_dest.row_version);
  perform authz.finance_remember(v_dest.legal_entity_id, p_request_id, 'company_destination_return', v_payload, v_result);
  perform authz.write_audit('finance.destination_returned', v_dest.legal_entity_id, null, 'company_destination', v_dest.id, null,
    jsonb_build_object('versionId', v_ver.id, 'versionNo', v_ver.version_no));
  return v_result;
end;
$$;

-- public.company_destination_submit(uuid, uuid, jsonb, integer, uuid): from 20261110000100_company_destinations.sql
create or replace function public.company_destination_submit(
  p_entity_id uuid, p_destination_id uuid, p_fields jsonb, p_expected_row_version integer, p_request_id uuid
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_payload jsonb := jsonb_build_object('entityId', p_entity_id, 'destinationId', p_destination_id, 'fields', p_fields,
    'expectedRowVersion', p_expected_row_version);
  v_result jsonb;
  v_dest public.company_destinations%rowtype;
  v_prev public.company_destination_versions%rowtype;
  v_kind text;
  v_label text;
  v_values jsonb;
  v_version uuid := gen_random_uuid();
  v_version_no integer := 1;
  v_changed text[] := '{}';
  v_key text;
begin
  perform authz.finance_require_accounts(p_entity_id, null);
  if p_request_id is null or p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    perform authz.finance_invalid();
  end if;
  if p_destination_id is not null then
    select * into v_dest from public.company_destinations d
    where d.id = p_destination_id and d.legal_entity_id = p_entity_id for update;
    if v_dest.id is null then
      perform authz.finance_invalid();
    end if;
  end if;
  v_result := authz.finance_replay(p_entity_id, p_request_id, 'company_destination_submit', v_payload);
  if v_result is not null then
    return v_result;
  end if;

  if (p_fields - array['kind', 'label', 'holderName', 'bankName', 'accountNumber', 'ifsc', 'payeeName', 'upiId'])
     <> '{}'::jsonb then
    perform authz.finance_invalid();
  end if;

  if v_dest.id is null then
    v_kind := authz.finance_field(p_fields, 'kind');
    v_label := authz.finance_text(authz.finance_field(p_fields, 'label'), 1, 80, false);
    -- Separators are ignored, so a label can never carry an account number or UPI ID.
    if v_kind is null or v_kind not in ('bank', 'upi') or v_label is null
       or regexp_replace(v_label, '[[:space:]./_-]', '', 'g') ~ '[0-9]{6,}' or position('@' in v_label) > 0 then
      perform authz.finance_invalid();
    end if;
  else
    if authz.finance_field(p_fields, 'kind') is not null or authz.finance_field(p_fields, 'label') is not null then
      perform authz.finance_invalid();
    end if;
    v_kind := v_dest.kind;
    if p_expected_row_version is distinct from v_dest.row_version then
      raise exception 'version_changed' using errcode = 'PT409';
    end if;
    if v_dest.retired_at is not null or exists (
         select 1 from public.company_destination_versions v where v.destination_id = v_dest.id and v.status = 'submitted') then
      raise exception 'wrong_state' using errcode = '55000';
    end if;
    select * into v_prev from public.company_destination_versions v
    where v.destination_id = v_dest.id order by v.version_no desc limit 1;
    v_version_no := v_prev.version_no + 1;
  end if;
  v_values := authz.destination_values(v_kind, p_fields - array['kind', 'label']);

  begin
    if v_dest.id is null then
      insert into public.company_destinations (legal_entity_id, kind, label, is_synthetic, created_by)
      values (p_entity_id, v_kind, v_label, authz.deployment_environment() = 'test', (select auth.uid()))
      returning * into v_dest;
    else
      update public.company_destinations d set row_version = d.row_version + 1, updated_at = now()
      where d.id = v_dest.id returning * into v_dest;
    end if;
    insert into public.company_destination_versions (id, legal_entity_id, destination_id, version_no, predecessor_version_id,
      holder_name, bank_name, account_number, ifsc, payee_name, upi_id, maker, request_id)
    values (v_version, p_entity_id, v_dest.id, v_version_no, v_prev.id,
      v_values ->> 'holderName', v_values ->> 'bankName', v_values ->> 'accountNumber', v_values ->> 'ifsc',
      v_values ->> 'payeeName', v_values ->> 'upiId', (select auth.uid()), p_request_id);
  exception
    when unique_violation then
      raise exception 'wrong_state' using errcode = '55000';
    when check_violation or not_null_violation or foreign_key_violation then
      raise exception 'invalid_input' using errcode = '22023';
  end;

  -- Changed field NAMES only (never values) for the audit trail.
  if v_prev.id is not null then
    foreach v_key in array array['holderName', 'bankName', 'accountNumber', 'ifsc', 'payeeName', 'upiId'] loop
      if (v_values ->> v_key) is distinct from (case v_key
            when 'holderName' then v_prev.holder_name when 'bankName' then v_prev.bank_name
            when 'accountNumber' then v_prev.account_number when 'ifsc' then v_prev.ifsc
            when 'payeeName' then v_prev.payee_name else v_prev.upi_id end) then
        v_changed := v_changed || v_key;
      end if;
    end loop;
  end if;

  v_result := jsonb_build_object('outcome', 'created', 'id', v_version, 'destinationId', v_dest.id, 'versionId', v_version,
    'versionNo', v_version_no, 'status', 'submitted', 'rowVersion', v_dest.row_version);
  perform authz.finance_remember(p_entity_id, p_request_id, 'company_destination_submit', v_payload, v_result);
  perform authz.write_audit('finance.destination_submitted', p_entity_id, null, 'company_destination', v_dest.id, null,
    jsonb_build_object('versionId', v_version, 'versionNo', v_version_no, 'kind', v_kind, 'changedFields', to_jsonb(v_changed)));
  return v_result;
end;
$$;

-- public.company_funding_decide(uuid, text, text, integer, uuid): from 20261130000200_supplier_money.sql
create or replace function public.company_funding_decide(
  p_funding_id uuid, p_decision text, p_reason text, p_expected_row_version integer, p_request_id uuid
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v public.company_funding_requests%rowtype;
  v_pay public.supplier_payment_requests%rowtype;
  v_reason text;
  v_payload jsonb := jsonb_build_object('fundingId', p_funding_id, 'decision', p_decision, 'reason', p_reason,
    'expectedRowVersion', p_expected_row_version);
  v_result jsonb;
begin
  v := authz.sm_funding_for_command(p_funding_id, 'decider');
  v_result := authz.sm_replay(v.legal_entity_id, p_request_id, 'company_funding_decide', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if p_decision is null or p_decision not in ('approve', 'return') then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  if v.requested_by = v_uid or authz.finance_deal_conflict(v.deal_id) then
    raise exception 'not_self_approval' using errcode = '42501';
  end if;
  select * into v_pay from public.supplier_payment_requests p where p.id = v.payment_request_id;
  if v.status <> 'pending' or v_pay.status in ('returned', 'cancelled') then
    raise exception 'already_decided' using errcode = '55000';
  end if;
  if p_expected_row_version is distinct from v.row_version then
    raise exception 'version_changed' using errcode = 'PT409';
  end if;
  if p_decision = 'approve' then
    update public.company_funding_requests f
    set status = 'approved', decided_by = v_uid, decided_at = now(), row_version = f.row_version + 1, updated_at = now()
    where f.id = v.id returning * into v;
  else
    v_reason := authz.finance_reason(p_reason);
    update public.company_funding_requests f
    set status = 'returned', return_reason = v_reason, decided_by = v_uid, decided_at = now(),
        row_version = f.row_version + 1, updated_at = now()
    where f.id = v.id returning * into v;
  end if;
  -- Funding audits target the funding row: Purchase's task history never shows them.
  perform authz.write_audit(case when p_decision = 'approve' then 'finance.company_funding_approved'
                                 else 'finance.company_funding_returned' end,
    v.legal_entity_id, v.branch_id, 'company_funding_request', v.id, null,
    jsonb_build_object('paymentRequestId', v.payment_request_id, 'route', v.route));
  v_result := jsonb_build_object('outcome', 'created', 'id', v.id, 'status', v.status, 'rowVersion', v.row_version);
  return authz.sm_remember(v.legal_entity_id, p_request_id, 'company_funding_decide', v_payload, v_result);
end;
$$;

-- public.company_funding_mark_recovered(uuid, text, integer, uuid): from 20261130000200_supplier_money.sql
create or replace function public.company_funding_mark_recovered(
  p_funding_id uuid, p_note text, p_expected_row_version integer, p_request_id uuid
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v public.company_funding_requests%rowtype;
  v_pay_status text;
  v_note text;
  v_payload jsonb := jsonb_build_object('fundingId', p_funding_id, 'note', p_note,
    'expectedRowVersion', p_expected_row_version);
  v_result jsonb;
begin
  v := authz.sm_funding_for_command(p_funding_id, 'accounts');
  v_result := authz.sm_replay(v.legal_entity_id, p_request_id, 'company_funding_mark_recovered', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if v.status <> 'approved' then
    raise exception 'already_decided' using errcode = '55000';
  end if;
  if p_expected_row_version is distinct from v.row_version then
    raise exception 'version_changed' using errcode = 'PT409';
  end if;
  select p.status into v_pay_status from public.supplier_payment_requests p where p.id = v.payment_request_id;
  if v_pay_status not in ('paid', 'verified') then
    raise exception 'not_ready' using errcode = '55000';
  end if;
  v_note := authz.finance_reason(p_note);
  update public.company_funding_requests f
  set status = 'recovered', recovered_by = v_uid, recovered_at = now(), recovery_note = v_note,
      row_version = f.row_version + 1, updated_at = now()
  where f.id = v.id returning * into v;
  perform authz.write_audit('finance.company_funding_recovered', v.legal_entity_id, v.branch_id,
    'company_funding_request', v.id, null, jsonb_build_object('paymentRequestId', v.payment_request_id));
  v_result := jsonb_build_object('outcome', 'created', 'id', v.id, 'status', v.status, 'rowVersion', v.row_version);
  return authz.sm_remember(v.legal_entity_id, p_request_id, 'company_funding_mark_recovered', v_payload, v_result);
end;
$$;

-- public.customer_document_release(uuid, integer, text, uuid): from 20261205000210_auto_bills.sql
create or replace function public.customer_document_release(p_document_id uuid, p_expected_row_version integer, p_expected_content_sha256 text,
  p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v public.customer_documents%rowtype;
  v_payload jsonb := jsonb_build_object('documentId', p_document_id, 'expectedRowVersion', p_expected_row_version,
    'expectedContentSha256', p_expected_content_sha256);
  v_result jsonb;
  v_core jsonb;
begin
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  v := authz.cdoc_lock(p_document_id);
  v_result := authz.finance_replay(v.legal_entity_id, p_request_id, 'customer_document_release', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  perform authz.cdoc_require_enabled(v.legal_entity_id);
  if v.status <> 'draft' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  perform authz.cdoc_check_version(v, p_expected_row_version);
  if p_expected_content_sha256 is null or p_expected_content_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'expectedContentSha256';
  end if;
  if v.content_sha256 <> p_expected_content_sha256 then
    raise exception 'version_changed' using errcode = 'PT409';
  end if;
  -- Accounts phase 3 (20261205000210): the rest is the shared release core (also clears auto_state).
  v_core := authz.cdoc_release_core(v.id, (select auth.uid()), null, p_request_id);
  select * into v from public.customer_documents c where c.id = v.id;

  perform authz.write_audit('accounts.customer_document.released', v.legal_entity_id, v.branch_id, 'customer_document', v.id, null,
    jsonb_build_object('documentId', v.id, 'kind', v.kind, 'seq', v.seq, 'replacesDocumentId', v.replaces_document_id,
      'renderJobId', v_core ->> 'renderJobId', 'rowVersion', v.row_version));
  v_result := authz.cdoc_result('updated', v) || jsonb_build_object('seq', v.seq, 'issueDate', to_char(v.issue_date, 'YYYY-MM-DD'),
    'renderJobId', v_core ->> 'renderJobId', 'replacedDocumentId', v_core ->> 'replacedDocumentId');
  return authz.finance_remember(v.legal_entity_id, p_request_id, 'customer_document_release', v_payload, v_result);
end;
$$;

-- public.customer_document_render_complete(uuid, text, boolean, text, jsonb): from 20261204000220_customer_documents_render.sql
create or replace function public.customer_document_render_complete(p_job_id uuid, p_worker text, p_ok boolean, p_error_code text, p_file jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_job public.customer_document_render_jobs%rowtype;
  v_path text;
  v_size bigint;
  v_file uuid;
  v_code text := p_error_code;
  v_ok boolean := p_ok;
  v_status text;
begin
  select * into v_job from public.customer_document_render_jobs j where j.id = p_job_id for update;
  if v_job.id is null or v_job.status <> 'running' or v_job.lease_owner is distinct from p_worker then
    raise exception 'task_conflict' using errcode = 'PT409';
  end if;
  if v_ok is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'ok';
  end if;
  if v_ok then
    v_path := authz.cdoc_object_path(v_job.legal_entity_id, v_job.document_id, v_job.id);
    if p_file is null or jsonb_typeof(p_file) <> 'object'
       or exists (select 1 from jsonb_object_keys(p_file) k where k not in ('objectPath', 'sha256', 'sizeBytes', 'pageCount'))
       or (p_file ->> 'objectPath') is distinct from v_path
       or coalesce(p_file ->> 'sha256', '') !~ '^[0-9a-f]{64}$'
       or not authz.sf_int_ok(p_file -> 'sizeBytes', 1, 15728640, true)
       or not authz.sf_int_ok(p_file -> 'pageCount', 1, 50, true) then
      raise exception 'invalid_input' using errcode = '22023', hint = 'file';
    end if;
    v_size := (p_file ->> 'sizeBytes')::bigint;
    if to_regclass('storage.objects') is null or not exists (
         select 1 from storage.objects o
         where o.bucket_id = 'rendered-documents' and o.name = v_path
           and (o.metadata ->> 'size') ~ '^[0-9]{1,18}$' and (o.metadata ->> 'size')::bigint = v_size) then
      v_ok := false;
      v_code := 'upload_failed';
    else
      insert into public.customer_document_files (legal_entity_id, document_id, render_job_id, object_path, sha256, size_bytes, page_count)
      values (v_job.legal_entity_id, v_job.document_id, v_job.id, v_path, p_file ->> 'sha256', v_size::integer,
        (p_file ->> 'pageCount')::integer)
      returning id into v_file;
      update public.customer_document_render_jobs j
      set status = 'succeeded', lease_owner = null, lease_until = null, finished_at = now(), last_error_code = null
      where j.id = v_job.id;
      return jsonb_build_object('jobId', v_job.id, 'status', 'succeeded', 'fileId', v_file);
    end if;
  end if;
  if v_code is null or v_code not in ('render_timeout', 'browser_failed', 'asset_missing', 'input_invalid', 'upload_failed',
                                      'internal', 'content_safety', 'layout_overflow', 'placeholders_present', 'text_clipped',
                                      'qa_blocked') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'errorCode';
  end if;
  -- Deterministic failures end the job at once; transient ones go back to the
  -- queue while attempts remain (at most 3).
  if v_job.attempts < v_job.max_attempts
     and v_code not in ('placeholders_present', 'content_safety', 'input_invalid', 'layout_overflow', 'text_clipped',
                        'qa_blocked', 'asset_missing') then
    update public.customer_document_render_jobs j
    set status = 'queued', last_error_code = v_code, lease_owner = null, lease_until = null,
        available_at = now() + make_interval(secs => 30 * v_job.attempts)
    where j.id = v_job.id returning j.status into v_status;
  else
    update public.customer_document_render_jobs j
    set status = 'failed', last_error_code = v_code, lease_owner = null, lease_until = null, finished_at = now()
    where j.id = v_job.id returning j.status into v_status;
  end if;
  return jsonb_build_object('jobId', v_job.id, 'status', v_status, 'fileId', null, 'errorCode', v_code);
end;
$$;

-- public.customer_document_render_input(uuid, text): from 20261204000220_customer_documents_render.sql
create or replace function public.customer_document_render_input(p_job_id uuid, p_worker text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_job public.customer_document_render_jobs%rowtype;
  v_doc public.customer_documents%rowtype;
begin
  select * into v_job from public.customer_document_render_jobs j where j.id = p_job_id for update;
  if v_job.id is null or v_job.status <> 'running' or v_job.lease_owner is distinct from p_worker or v_job.lease_until < now() then
    raise exception 'task_conflict' using errcode = 'PT409';
  end if;
  select * into v_doc from public.customer_documents c where c.id = v_job.document_id;
  if v_doc.content_sha256 is distinct from v_job.content_sha256 or v_doc.status not in ('released', 'replaced', 'cancelled') then
    update public.customer_document_render_jobs j
    set status = 'failed', last_error_code = 'content_changed', lease_owner = null, lease_until = null, finished_at = now()
    where j.id = v_job.id;
    return jsonb_build_object('jobId', v_job.id, 'status', 'failed', 'errorCode', 'content_changed');
  end if;
  return jsonb_build_object('jobId', v_job.id, 'status', 'running', 'documentId', v_doc.id, 'templateVersion', v_job.template_version,
    'contentSha256', v_job.content_sha256, 'content', v_doc.content,
    'objectPath', authz.cdoc_object_path(v_job.legal_entity_id, v_job.document_id, v_job.id));
end;
$$;

-- public.customer_party_document_begin(uuid, text, uuid, boolean, text, text, integer, text): from 20261128000130_vn_customer_parties.sql
create or replace function public.customer_party_document_begin(p_party_id uuid, p_kind text, p_request_id uuid, p_consent boolean,
  p_file_name text, p_mime text, p_size_bytes integer, p_sha256 text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_party public.customer_parties%rowtype;
  v_existing public.customer_party_documents%rowtype;
  v_name text := btrim(left(btrim(regexp_replace(coalesce(p_file_name, ''), '[^A-Za-z0-9._ -]', '_', 'g')), 120));
  v_sha text := lower(btrim(coalesce(p_sha256, '')));
  v_id uuid := gen_random_uuid();
  v_path text;
begin
  select * into v_party from public.customer_parties p where p.id = p_party_id for no key update;
  if v_party.id is null or not authz.vn_party_doc_writer(v_party) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  if p_kind is null or p_kind not in (case when v_party.party_type = 'personal' then 'id_proof' else 'gst_certificate' end, 'other') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'kind';
  end if;
  if p_kind = 'id_proof' and p_consent is distinct from true then
    raise exception 'consent_required' using errcode = '22023';
  end if;
  select * into v_existing from public.customer_party_documents f where f.party_id = p_party_id and f.request_id = p_request_id;
  if v_existing.id is not null then
    if v_existing.uploaded_by is distinct from (select auth.uid()) or v_existing.kind is distinct from p_kind
       or v_existing.file_name is distinct from v_name or v_existing.mime is distinct from p_mime
       or v_existing.size_bytes is distinct from p_size_bytes or v_existing.sha256 is distinct from v_sha then
      raise exception 'request_conflict' using errcode = 'PT409';
    end if;
    return jsonb_build_object('fileId', v_existing.id, 'outcome', 'existing', 'status', v_existing.status,
      'rowVersion', v_existing.row_version,
      'objectPath', case when v_existing.status = 'pending_upload' then v_existing.object_path end);
  end if;
  if v_name = '' or v_name ~ '^[. ]+$'
     or p_mime is null or p_mime not in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')
     or p_size_bytes is null or p_size_bytes < 1 or p_size_bytes > 4194304
     or v_sha !~ '^[0-9a-f]{64}$' then
    raise exception 'evidence_rejected' using errcode = '22023';
  end if;
  if (select count(*) from public.customer_party_documents f
      where f.party_id = v_party.id and f.status in ('pending_upload', 'stored')) >= 6 then
    raise exception 'party_doc_limit' using errcode = '55000';
  end if;
  v_path := v_party.legal_entity_id::text || '/' || v_party.id::text || '/' || v_id::text;
  insert into public.customer_party_documents (id, party_id, legal_entity_id, kind, request_id, consent_by, consent_at,
    object_path, file_name, mime, size_bytes, sha256, uploaded_by)
  values (v_id, v_party.id, v_party.legal_entity_id, p_kind, p_request_id,
    case when p_kind = 'id_proof' then (select auth.uid()) end, case when p_kind = 'id_proof' then now() end,
    v_path, v_name, p_mime, p_size_bytes, v_sha, (select auth.uid()));
  -- No file name in the audit record (it may carry a person's name).
  perform authz.write_audit('party.document_started', v_party.legal_entity_id, v_party.branch_id,
    'customer_party_document', v_id, null,
    jsonb_build_object('partyId', v_party.id, 'kind', p_kind, 'mime', p_mime, 'sizeBytes', p_size_bytes,
      'consent', p_kind = 'id_proof'));
  return jsonb_build_object('fileId', v_id, 'outcome', 'created', 'status', 'pending_upload', 'rowVersion', 1,
    'objectPath', v_path);
end;
$$;

-- public.customer_party_tally_name_set(uuid, integer, text, uuid): from 20261205000300_tally_xml_schema.sql
create or replace function public.customer_party_tally_name_set(p_party_id uuid, p_expected_row_version integer, p_name text, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v public.customer_parties%rowtype;
  v_payload jsonb := jsonb_build_object('partyId', p_party_id, 'expectedRowVersion', p_expected_row_version, 'name', p_name);
  v_result jsonb;
  v_name text;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_party_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'partyId';
  end if;
  select * into v from public.customer_parties c where c.id = p_party_id;
  if v.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform authz.finance_require_accounts(v.legal_entity_id, null);
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  v_result := authz.finance_replay(v.legal_entity_id, p_request_id, 'customer_party_tally_name_set', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if p_expected_row_version is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'expectedRowVersion';
  end if;
  v_name := nullif(btrim(coalesce(p_name, '')), '');
  if v_name is not null and not authz.tally_name_ok(v_name, 100) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'name';
  end if;
  select * into v from public.customer_parties c where c.id = p_party_id for update;
  if v.row_version <> p_expected_row_version then
    raise exception 'version_changed' using errcode = 'PT409';
  end if;
  if v.tally_ledger_name is not distinct from v_name then
    v_result := jsonb_build_object('outcome', 'existing', 'partyId', v.id, 'name', v.tally_ledger_name, 'rowVersion', v.row_version);
  else
    update public.customer_parties c
    set tally_ledger_name = v_name, row_version = c.row_version + 1, updated_by = (select auth.uid()), updated_at = now()
    where c.id = v.id
    returning * into v;
    perform authz.write_audit('accounts.tally_party_named', v.legal_entity_id, v.branch_id, 'customer_party', v.id, null,
      jsonb_build_object('partyId', v.id, 'rowVersion', v.row_version, 'cleared', v_name is null));
    v_result := jsonb_build_object('outcome', 'updated', 'partyId', v.id, 'name', v.tally_ledger_name, 'rowVersion', v.row_version);
  end if;
  return authz.finance_remember(v.legal_entity_id, p_request_id, 'customer_party_tally_name_set', v_payload, v_result);
end;
$$;

-- public.customer_refund_decide(uuid, text, bigint, bigint, text, integer, uuid): from 20261204000380_refund_limits_cumulative.sql
create or replace function public.customer_refund_decide(p_id uuid, p_decision text, p_expected_amount_paise bigint,
  p_expected_charge_paise bigint, p_reason text, p_expected_row_version integer, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  r public.customer_refund_requests%rowtype;
  v_uid uuid := (select auth.uid());
  v_payload jsonb := jsonb_build_object('refundRequestId', p_id, 'decision', p_decision, 'expectedAmountPaise', p_expected_amount_paise,
    'expectedChargePaise', p_expected_charge_paise, 'reason', p_reason, 'expectedRowVersion', p_expected_row_version);
  v_result jsonb;
  v_reason text;
  v_status text;
begin
  if p_request_id is null then
    perform authz.refund_invalid('requestId');
  end if;
  r := authz.refund_for_command(p_id);
  if not authz.refund_decider(r.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if r.requested_by = v_uid then
    raise exception 'not_self_approval' using errcode = '42501';
  end if;
  v_result := authz.finance_replay(r.legal_entity_id, p_request_id, 'customer_refund_decide', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if p_decision is null or p_decision not in ('approve', 'return') then
    perform authz.refund_invalid('decision');
  end if;
  if not authz.refunds_enabled(r.legal_entity_id) then
    raise exception 'refunds_off' using errcode = '55000';
  end if;
  if r.status <> 'requested' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  perform authz.require_row_version(p_expected_row_version, r.row_version);
  -- The decision binds the exact amounts the Manager saw.
  if p_expected_amount_paise is distinct from r.amount_paise or p_expected_charge_paise is distinct from r.customer_charge_paise then
    raise exception 'version_changed' using errcode = 'PT409';
  end if;
  if p_decision = 'approve' then
    if r.kind = 'cancellation' and not authz.deal_cancellation_approved(r.deal_id) then
      raise exception 'not_ready' using errcode = '55000', hint = 'cancellation';
    end if;
    -- Accounts phase 2 (20261204000380, Addendum L7): another settlement approved meanwhile with a higher charge.
    if r.kind = 'cancellation' and r.customer_charge_paise < coalesce(authz.refund_approved_charge(r.deal_id, r.id), 0) then
      raise exception 'charge_below_approved' using errcode = '22023', hint = 'approvedChargePaise';
    end if;
    if not authz.refund_limit_ok(r) then
      raise exception 'refund_exceeds_money' using errcode = '22023', hint = 'amountPaise';
    end if;
    v_status := 'approved';
  else
    begin
      v_reason := authz.finance_reason(p_reason);
    exception when sqlstate '22023' then
      perform authz.refund_invalid('reason');
    end;
    if v_reason is null then
      perform authz.refund_invalid('reason');
    end if;
    v_status := 'returned';
  end if;
  update public.customer_refund_requests x
  set status = v_status, decided_by = v_uid, decided_at = now(), decision_request_id = p_request_id,
      return_reason = v_reason, row_version = x.row_version + 1, updated_at = now()
  where x.id = r.id;
  v_result := authz.refund_result(r.id, 'updated');
  perform authz.finance_remember(r.legal_entity_id, p_request_id, 'customer_refund_decide', v_payload, v_result);
  perform authz.write_audit(case when v_status = 'approved' then 'refund.approved' else 'refund.returned' end,
    r.legal_entity_id, r.branch_id, 'customer_refund_request', r.id, v_reason,
    jsonb_build_object('refundRequestId', r.id, 'dealId', r.deal_id, 'kind', r.kind, 'outcome', r.outcome,
      'rowVersion', r.row_version + 1));
  return v_result;
end;
$$;

-- public.deal_cancellation_decide(uuid, text, text, integer, uuid): from 20261204000330_cancellation_flight_visa.sql
create or replace function public.deal_cancellation_decide(
  p_cancellation_id uuid, p_decision text, p_reason text, p_expected_row_version integer, p_request_id uuid
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_c public.deal_cancellations%rowtype;
  v_reason text;
  v_status text;
begin
  select * into v_c from public.deal_cancellations c where c.id = p_cancellation_id for update;
  if v_c.id is null or not coalesce(authz.session_ok(), false) or not authz.is_branch_sales_manager(v_c.deal_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_request_id is null or p_decision is null or p_decision not in ('approve', 'return') then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  v_status := case p_decision when 'approve' then 'approved' else 'charges_entered' end;
  if v_c.decision_request_id = p_request_id and v_c.decided_by = v_uid and v_c.status = v_status then
    return jsonb_build_object('cancellationId', v_c.id, 'status', v_c.status, 'rowVersion', v_c.row_version,
      'outcome', 'existing');
  end if;
  if v_c.status = 'approved' then
    raise exception 'already_decided' using errcode = '55000';
  end if;
  if p_expected_row_version is distinct from v_c.row_version then
    raise exception 'version_changed' using errcode = 'PT409';
  end if;
  -- Accounts phase 2 (20261204000330, LD14): with nothing to charge (no Purchase task with a
  -- cost, no ticket batch) the Manager approves straight from open.
  if v_c.status <> 'sent_to_manager'
     and not (p_decision = 'approve' and v_c.status in ('open', 'charges_entered')
              and not authz.cancellation_needs_charges(v_c.id)) then
    raise exception 'not_ready' using errcode = '55000';
  end if;
  -- Review F8: nobody who entered any charge revision of this case, or sent
  -- it to the Manager, decides it.
  if v_c.sent_by = v_uid or exists (
    select 1 from public.purchase_cancellation_charges x
    where x.cancellation_id = v_c.id and x.entered_by = v_uid)
    -- Accounts phase 2 (20261204000330): nor anyone who entered a Flight charge revision.
    or exists (select 1 from public.flight_cancellation_charges y
               where y.cancellation_id = v_c.id and y.entered_by = v_uid) then
    raise exception 'not_self_approval' using errcode = '42501';
  end if;
  if p_decision = 'return' then
    v_reason := authz.purchase_reason(p_reason);
  end if;

  update public.deal_cancellations c
  set status = v_status, decided_by = v_uid, decided_at = now(), decision_request_id = p_request_id,
      return_reason = v_reason, row_version = c.row_version + 1, updated_at = now()
  where c.id = v_c.id
  returning * into v_c;

  perform authz.write_audit(case when p_decision = 'approve' then 'deal.cancellation_approved' else 'deal.cancellation_returned' end,
    v_c.legal_entity_id, v_c.branch_id, 'deal_cancellation', v_c.id, v_reason, jsonb_build_object('dealId', v_c.deal_id));
  return jsonb_build_object('cancellationId', v_c.id, 'status', v_c.status, 'rowVersion', v_c.row_version,
    'outcome', 'created');
end;
$$;

-- public.deal_cancellation_send(uuid, integer, uuid): from 20261204000330_cancellation_flight_visa.sql
create or replace function public.deal_cancellation_send(p_cancellation_id uuid, p_expected_row_version integer, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_c public.deal_cancellations%rowtype;
begin
  select * into v_c from public.deal_cancellations c where c.id = p_cancellation_id for update;
  if v_c.id is null or not coalesce(authz.session_ok(), false)
     -- Accounts phase 2 (20261204000330): Purchase or Flight sends the charges.
     or not (authz.holds_active_role('purchase', v_c.legal_entity_id) or authz.holds_active_role('flight', v_c.legal_entity_id)) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  if v_c.status = 'sent_to_manager' and v_c.sent_request_id = p_request_id and v_c.sent_by = v_uid then
    return jsonb_build_object('cancellationId', v_c.id, 'status', v_c.status, 'rowVersion', v_c.row_version,
      'outcome', 'existing');
  end if;
  if v_c.status in ('sent_to_manager', 'approved') then
    raise exception 'already_decided' using errcode = '55000';
  end if;
  if p_expected_row_version is distinct from v_c.row_version then
    raise exception 'version_changed' using errcode = 'PT409';
  end if;
  if authz.cancellation_charges_missing(v_c.id) > 0 then
    raise exception 'not_ready' using errcode = '55000';
  end if;

  update public.deal_cancellations c
  set status = 'sent_to_manager', sent_by = v_uid, sent_at = now(), sent_request_id = p_request_id,
      return_reason = null, row_version = c.row_version + 1, updated_at = now()
  where c.id = v_c.id
  returning * into v_c;

  perform authz.write_audit('deal.cancellation_charges_sent', v_c.legal_entity_id, v_c.branch_id,
    'deal_cancellation', v_c.id, null, jsonb_build_object('dealId', v_c.deal_id));
  return jsonb_build_object('cancellationId', v_c.id, 'status', v_c.status, 'rowVersion', v_c.row_version,
    'outcome', 'created');
end;
$$;

-- public.deal_message_prefs_set(uuid, integer, jsonb, uuid): from 20261205000120_customer_message_commands.sql
create or replace function public.deal_message_prefs_set(p_deal_id uuid, p_expected_row_version integer, p_fields jsonb, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_deal public.deals%rowtype;
  v_row public.deal_message_prefs%rowtype;
  v_old public.deal_message_prefs%rowtype;
  v_created boolean := false;
  v_key text;
  v_text text;
  v_changed text[] := '{}';
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_deal from public.deals d where d.id = p_deal_id;
  if v_deal.id is null
     or not (authz.cmsg_can_act(v_deal.id)
             or (not exists (select 1 from public.booking_versions v where v.deal_id = v_deal.id and v.status in ('confirmed', 'superseded'))
                 and coalesce(authz.can_edit_booking_draft(v_deal.id), false))) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fields';
  end if;
  for v_key in select jsonb_object_keys(p_fields) loop
    if v_key not in ('language', 'whatsappMobile', 'whatsappSameAsMobile', 'emailOverride', 'whatsappOff', 'emailOff', 'offReason') then
      raise exception 'invalid_input' using errcode = '22023', hint = v_key;
    end if;
  end loop;

  insert into public.deal_message_prefs (deal_id, legal_entity_id, branch_id, updated_by)
  values (v_deal.id, v_deal.legal_entity_id, v_deal.branch_id, (select auth.uid()))
  on conflict (deal_id) do nothing;
  v_created := found;
  select * into v_row from public.deal_message_prefs p where p.deal_id = v_deal.id for update;
  if not v_created then
    if v_row.last_request_id = p_request_id then
      return jsonb_build_object('outcome', 'existing', 'dealId', v_deal.id, 'rowVersion', v_row.row_version);
    end if;
    if p_expected_row_version is distinct from v_row.row_version then
      raise exception 'version_changed' using errcode = 'PT409';
    end if;
  elsif coalesce(p_expected_row_version, 0) <> 0 then
    raise exception 'version_changed' using errcode = 'PT409';
  end if;
  v_old := v_row;

  if p_fields ? 'language' then
    if p_fields ->> 'language' not in ('en', 'hi') then
      raise exception 'invalid_input' using errcode = '22023', hint = 'language';
    end if;
    v_row.language := p_fields ->> 'language';
  end if;
  if p_fields ? 'whatsappSameAsMobile' then
    if jsonb_typeof(p_fields -> 'whatsappSameAsMobile') <> 'boolean' then
      raise exception 'invalid_input' using errcode = '22023', hint = 'whatsappSameAsMobile';
    end if;
    if (p_fields ->> 'whatsappSameAsMobile')::boolean then
      v_row.whatsapp_mobile := null;
    end if;
  end if;
  if p_fields ? 'whatsappMobile' and not coalesce((p_fields ->> 'whatsappSameAsMobile')::boolean, false) then
    v_text := nullif(regexp_replace(coalesce(p_fields ->> 'whatsappMobile', ''), '[\s-]', '', 'g'), '');
    if v_text is not null and v_text !~ '^[6-9][0-9]{9}$' then
      raise exception 'invalid_input' using errcode = '22023', hint = 'whatsappMobile';
    end if;
    v_row.whatsapp_mobile := v_text;
  end if;
  if p_fields ? 'emailOverride' then
    v_text := nullif(lower(btrim(coalesce(p_fields ->> 'emailOverride', ''))), '');
    if v_text is not null and (length(v_text) > 254 or v_text !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') then
      raise exception 'invalid_input' using errcode = '22023', hint = 'emailOverride';
    end if;
    v_row.email_override := v_text;
  end if;
  foreach v_key in array array['whatsappOff', 'emailOff'] loop
    if p_fields ? v_key then
      if jsonb_typeof(p_fields -> v_key) <> 'boolean' then
        raise exception 'invalid_input' using errcode = '22023', hint = v_key;
      end if;
      if v_key = 'whatsappOff' then v_row.whatsapp_off := (p_fields ->> v_key)::boolean;
      else v_row.email_off := (p_fields ->> v_key)::boolean; end if;
    end if;
  end loop;
  if p_fields ? 'offReason' then
    v_row.off_reason := nullif(btrim(coalesce(p_fields ->> 'offReason', ''), E' \t\r\n'), '');
  end if;
  if not (v_row.whatsapp_off or v_row.email_off) then
    v_row.off_reason := null;
  elsif v_row.off_reason is null or length(v_row.off_reason) not between 10 and 300 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'offReason';
  end if;

  if v_row.language is distinct from v_old.language then v_changed := array_append(v_changed, 'language'); end if;
  if v_row.whatsapp_mobile is distinct from v_old.whatsapp_mobile then v_changed := array_append(v_changed, 'whatsappMobile'); end if;
  if v_row.email_override is distinct from v_old.email_override then v_changed := array_append(v_changed, 'emailOverride'); end if;
  if v_row.whatsapp_off is distinct from v_old.whatsapp_off then v_changed := array_append(v_changed, 'whatsappOff'); end if;
  if v_row.email_off is distinct from v_old.email_off then v_changed := array_append(v_changed, 'emailOff'); end if;
  if v_row.off_reason is distinct from v_old.off_reason then v_changed := array_append(v_changed, 'offReason'); end if;

  update public.deal_message_prefs p
  set language = v_row.language, whatsapp_mobile = v_row.whatsapp_mobile, email_override = v_row.email_override,
      whatsapp_off = v_row.whatsapp_off, email_off = v_row.email_off, off_reason = v_row.off_reason,
      last_request_id = p_request_id,
      row_version = case when v_created then p.row_version else p.row_version + 1 end,
      updated_by = (select auth.uid()), updated_at = now()
  where p.deal_id = v_deal.id
  returning * into v_row;

  if v_created or cardinality(v_changed) > 0 then
    -- Field names only, never the values (contract 5.3).
    perform authz.write_audit('messages.prefs_changed', v_deal.legal_entity_id, v_deal.branch_id, 'deal', v_deal.id, null,
      jsonb_build_object('dealId', v_deal.id, 'fields', to_jsonb(v_changed)));
  end if;
  return jsonb_build_object('outcome', case when v_created then 'created' else 'updated' end, 'dealId', v_deal.id,
    'rowVersion', v_row.row_version);
end;
$$;

-- public.deal_traveller_name_fill(uuid, uuid, integer, text, text, uuid): from 20261201000190_flight_traveller_name_fill.sql
create or replace function public.deal_traveller_name_fill(
  p_deal_id uuid, p_version_id uuid, p_seq integer, p_full_name text, p_traveller_type text, p_request_id uuid
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_deal public.deals%rowtype;
  v_ver public.booking_versions%rowtype;
  v_uid uuid := (select auth.uid());
  v_name text := btrim(coalesce(p_full_name, ''), E' \t\r\n');
  v_payload jsonb;
  v_replay jsonb;
  v_result jsonb;
  v_slots jsonb;
  v_flight_items uuid[];
  v_item record;
  v_task record;
  v_sectors integer := 0;
  v_n integer;
  v_cap integer;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_deal from public.deals d where d.id = p_deal_id;
  if v_deal.id is null or not authz.flight_can_fill_names(p_deal_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.flight_refuse_gate(p_deal_id);
  -- Book now's traveller name rule (authz.sf_text_ok, 120 characters, trimmed).
  if p_full_name is null or not authz.sf_text_ok(to_jsonb(p_full_name), 120, true) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fullName';
  end if;
  if p_traveller_type is null or p_traveller_type not in ('adult', 'child', 'infant') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'type';
  end if;
  if p_seq is null or p_seq not between 1 and 100 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'seq';
  end if;
  if p_version_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'versionId';
  end if;
  v_payload := jsonb_build_object('dealId', p_deal_id, 'versionId', p_version_id, 'seq', p_seq, 'fullName', v_name,
    'type', p_traveller_type);
  v_replay := authz.flight_replay(v_deal.legal_entity_id, p_request_id, 'deal_traveller_name_fill', v_payload);
  if v_replay is not null then
    return v_replay;
  end if;
  perform authz.flight_lock_group(p_deal_id);
  v_replay := authz.flight_replay(v_deal.legal_entity_id, p_request_id, 'deal_traveller_name_fill', v_payload);
  if v_replay is not null then
    return v_replay;
  end if;
  select * into v_ver from public.booking_versions v where v.deal_id = p_deal_id and v.status = 'confirmed' for update;
  if v_ver.id is distinct from p_version_id then
    raise exception 'version_changed' using errcode = 'PT409';
  end if;
  -- Only a blank: the seq is free and a name is still missing.
  if exists (select 1 from public.booking_version_travellers s where s.booking_version_id = v_ver.id and s.seq = p_seq)
     or exists (select 1 from public.deal_travellers t where t.deal_id = p_deal_id and t.seq = p_seq) then
    raise exception 'name_already_set' using errcode = '55000';
  end if;
  v_slots := authz.flight_name_slots(p_deal_id);
  if jsonb_array_length(v_slots) = 0 then
    raise exception 'name_already_set' using errcode = '55000';
  end if;
  if not exists (select 1 from jsonb_array_elements(v_slots) e where (e ->> 'seq')::integer = p_seq) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'seq';
  end if;
  -- The type must still be missing when the party counts are recorded.
  if coalesce(v_ver.adults_count, v_ver.pax_total) is not null then
    select count(*) into v_n from public.booking_version_travellers s
    where s.booking_version_id = v_ver.id and s.traveller_type = p_traveller_type;
    v_cap := case p_traveller_type
                  when 'adult' then coalesce(v_ver.adults_count,
                                             v_ver.pax_total - coalesce(v_ver.children_count, 0) - coalesce(v_ver.infants_count, 0))
                  when 'child' then coalesce(v_ver.children_count, 0)
                  else coalesce(v_ver.infants_count, 0) end;
    if v_n >= v_cap then
      raise exception 'invalid_input' using errcode = '22023', hint = 'type';
    end if;
  end if;

  -- Flight items that miss a name get the traveller.
  select coalesce(array_agg(t.service_item_id), '{}'::uuid[]) into v_flight_items
  from public.fulfilment_tasks t
  where t.deal_id = p_deal_id and t.department = 'flight' and t.status <> 'completed'
    and authz.task_current_version(t.id) = v_ver.id and authz.flight_unnamed_count(t.id) > 0;

  perform set_config('authz.traveller_fill', 'fill:' || txid_current()::text, true);
  -- Every other item that follows "every traveller" keeps exactly its current participants.
  for v_item in
    select f.service_item_id, f.legal_entity_id from public.service_item_facts f
    where f.booking_version_id = v_ver.id and not (f.service_item_id = any (v_flight_items))
      and not exists (select 1 from public.service_item_travellers p
                      where p.booking_version_id = v_ver.id and p.service_item_id = f.service_item_id)
  loop
    insert into public.service_item_travellers (booking_version_id, service_item_id, legal_entity_id, traveller_seq)
    select v_ver.id, v_item.service_item_id, v_item.legal_entity_id, s.seq
    from public.booking_version_travellers s where s.booking_version_id = v_ver.id;
  end loop;
  insert into public.deal_travellers (deal_id, legal_entity_id, seq, full_name, traveller_type)
  values (p_deal_id, v_deal.legal_entity_id, p_seq, v_name, p_traveller_type);
  insert into public.booking_version_travellers (booking_version_id, legal_entity_id, seq, full_name, traveller_type)
  values (v_ver.id, v_ver.legal_entity_id, p_seq, v_name, p_traveller_type);
  insert into public.service_item_travellers (booking_version_id, service_item_id, legal_entity_id, traveller_seq)
  select v_ver.id, p.service_item_id, p.legal_entity_id, p_seq
  from (select distinct pp.service_item_id, pp.legal_entity_id from public.service_item_travellers pp
        where pp.booking_version_id = v_ver.id and pp.service_item_id = any (v_flight_items)) p;
  perform set_config('authz.traveller_fill', '', true);

  -- Taken flights whose itinerary reflects this version: on every active booking / screenshot sector.
  for v_task in
    select t.id, t.legal_entity_id, t.deal_id, t.service_item_id from public.fulfilment_tasks t
    join public.flight_task_state s on s.task_id = t.id and s.basis_version_id = v_ver.id
    where t.deal_id = p_deal_id and t.department = 'flight' and t.status = 'in_progress'
      and p_seq = any (authz.item_participant_seqs(t.service_item_id, v_ver.id))
  loop
    insert into public.flight_sector_passengers (legal_entity_id, deal_id, task_id, sector_id, traveller_seq, created_by)
    select v_task.legal_entity_id, v_task.deal_id, v_task.id, x.id, p_seq, v_uid
    from public.flight_sectors x
    where x.task_id = v_task.id and x.status = 'active' and x.origin in ('booking', 'screenshot')
      and not exists (select 1 from public.flight_sector_passengers p
                      where p.sector_id = x.id and p.traveller_seq = p_seq and p.ended_at is null);
    get diagnostics v_n = row_count;
    v_sectors := v_sectors + v_n;
  end loop;

  insert into public.deal_traveller_fills (legal_entity_id, deal_id, booking_version_id, traveller_seq, traveller_type, filled_by,
    request_id)
  values (v_deal.legal_entity_id, p_deal_id, v_ver.id, p_seq, p_traveller_type, v_uid, p_request_id);
  perform authz.write_audit('booking.traveller_name_filled', v_deal.legal_entity_id, v_deal.branch_id,
    'booking_version', v_ver.id, null,
    jsonb_build_object('dealId', p_deal_id, 'versionId', v_ver.id, 'versionNo', v_ver.version_no, 'seq', p_seq,
      'type', p_traveller_type, 'flightItemCount', cardinality(v_flight_items), 'sectorCount', v_sectors));
  v_result := jsonb_build_object('dealId', p_deal_id, 'versionId', v_ver.id, 'seq', p_seq, 'type', p_traveller_type,
    'flightItemCount', cardinality(v_flight_items), 'outcome', 'created');
  return authz.flight_remember(v_deal.legal_entity_id, p_request_id, 'deal_traveller_name_fill', v_payload, v_result);
end;
$$;

-- public.flight_booking_change_apply(uuid, uuid, uuid, uuid): from 20261201000160_flight_review_fixes.sql
create or replace function public.flight_booking_change_apply(
  p_task_id uuid, p_expected_basis_version_id uuid, p_target_version_id uuid, p_request_id uuid
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_state public.flight_task_state%rowtype;
  v_uid uuid := (select auth.uid());
  v_payload jsonb;
  v_replay jsonb;
  v_result jsonb;
  v_diff jsonb;
  v_facts jsonb;
  v_new_legs jsonb;
  v_seqs integer[];
  v_old_seqs integer[];
  v_e jsonb;
  v_c record;
  v_superseded uuid[] := '{}'::uuid[];
  v_removed uuid[] := '{}'::uuid[];
  v_kept integer := 0;
  v_added integer := 0;
  v_new_ids uuid[] := '{}'::uuid[];
  v_id uuid;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id;
  if v_task.id is null or v_task.department <> 'flight' or not authz.flight_can_work(v_task.deal_id)
     or v_task.assignee_user_id is distinct from v_uid then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.flight_refuse_gate(v_task.deal_id);
  if p_expected_basis_version_id is null or p_target_version_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'versionId';
  end if;
  v_payload := jsonb_build_object('taskId', p_task_id, 'expectedBasisVersionId', p_expected_basis_version_id,
    'targetVersionId', p_target_version_id);
  v_replay := authz.flight_replay(v_task.legal_entity_id, p_request_id, 'flight_booking_change_apply', v_payload);
  if v_replay is not null then
    return v_replay;
  end if;
  perform authz.flight_lock_group(v_task.deal_id);
  -- 20261201000160: a duplicate that raced the first call returns its stored result.
  v_replay := authz.flight_replay(v_task.legal_entity_id, p_request_id, 'flight_booking_change_apply', v_payload);
  if v_replay is not null then
    return v_replay;
  end if;
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id;
  if v_task.status <> 'in_progress' then
    raise exception 'not_ready' using errcode = '55000';
  end if;
  select * into v_state from public.flight_task_state s where s.task_id = p_task_id;
  if v_state.task_id is null then
    raise exception 'not_ready' using errcode = '55000';
  end if;
  if v_state.basis_version_id <> p_expected_basis_version_id
     or p_target_version_id <> authz.task_current_version(p_task_id) then
    raise exception 'version_changed' using errcode = 'PT409';
  end if;
  if v_state.basis_version_id = p_target_version_id then
    raise exception 'not_ready' using errcode = '55000';
  end if;
  v_diff := authz.flight_booking_diff(p_task_id);
  select f.facts into v_facts from public.service_item_facts f
  where f.service_item_id = v_task.service_item_id and f.booking_version_id = p_target_version_id;
  v_new_legs := authz.flight_facts_legs(v_facts);
  v_seqs := authz.item_participant_seqs(v_task.service_item_id, p_target_version_id);
  v_old_seqs := authz.item_participant_seqs(v_task.service_item_id, v_state.basis_version_id);

  perform set_config('authz.flight_transition', 'booking_apply', true);

  -- 1. Pending changes of the task are superseded (holds cleared).
  for v_c in select c.id, c.row_version from public.flight_changes c where c.task_id = p_task_id and c.status = 'pending' order by c.change_no loop
    perform authz.flight_change_close(v_c.id, 'superseded', 'change_superseded');
    update public.flight_changes c set status = 'superseded', ended_by = v_uid, ended_at = now(),
      row_version = c.row_version + 1, updated_at = now()
    where c.id = v_c.id;
    v_superseded := v_superseded || v_c.id;
  end loop;

  -- 2. Legs. Unchanged legs keep their sector (and tickets) under the new basis.
  for v_e in select e from jsonb_array_elements(v_diff #> '{legs,unchanged}') e loop
    update public.flight_sectors s
    set basis_version_id = p_target_version_id, booking_leg_no = (v_e ->> 'newLegNo')::smallint,
        row_version = s.row_version + 1, updated_at = now()
    where s.task_id = p_task_id and s.origin = 'booking' and s.status = 'active'
      and s.basis_version_id = v_state.basis_version_id and s.booking_leg_no = (v_e ->> 'oldLegNo')::smallint;
    v_kept := v_kept + 1;
  end loop;
  -- Changed and removed legs (and typed screenshot sectors when the flight is
  -- no longer a screenshot flight) end; their tickets stay in history.
  select coalesce(array_agg(s.id), '{}'::uuid[]) into v_removed
  from public.flight_sectors s
  where s.task_id = p_task_id and s.status = 'active'
    and ((s.origin = 'booking' and s.basis_version_id = v_state.basis_version_id
          and s.booking_leg_no in (select (e ->> 'oldLegNo')::integer
                                   from jsonb_array_elements((v_diff #> '{legs,changed}') || (v_diff #> '{legs,removed}')) e))
         or (s.origin = 'screenshot' and v_diff #>> '{entryMode,new}' <> 'screenshot'));
  perform authz.flight_end_sector_passengers(v_removed, 'booking_changed');
  update public.flight_sectors s
  set status = 'booking_removed', ended_at = now(), ended_by = v_uid, row_version = s.row_version + 1, updated_at = now()
  where s.id = any (v_removed);
  -- New and changed legs get new booking sectors with every participant.
  for v_e in select e from jsonb_array_elements((v_diff #> '{legs,changed}') || (v_diff #> '{legs,added}')) e loop
    v_id := authz.flight_insert_booking_sector(p_task_id, p_target_version_id,
      v_new_legs -> (((v_e ->> 'newLegNo')::integer) - 1), v_facts ->> 'cabin', v_seqs);
    v_new_ids := v_new_ids || v_id;
    v_added := v_added + 1;
  end loop;

  -- 3. Travellers no longer on the item leave every sector of the task.
  update public.flight_sector_passengers p
  set held_by_change_id = null, ended_at = now(), ended_by = v_uid, ended_reason = 'traveller_removed'
  where p.task_id = p_task_id and p.ended_at is null and not (p.traveller_seq = any (v_seqs));
  -- New travellers join every active booking (and screenshot) sector.
  insert into public.flight_sector_passengers (legal_entity_id, deal_id, task_id, sector_id, traveller_seq, created_by)
  select v_task.legal_entity_id, v_task.deal_id, v_task.id, s.id, q, v_uid
  from public.flight_sectors s cross join unnest(v_seqs) q
  where s.task_id = p_task_id and s.status = 'active' and s.origin in ('booking', 'screenshot')
    and not (q = any (v_old_seqs))
    and not exists (select 1 from public.flight_sector_passengers p
                    where p.sector_id = s.id and p.traveller_seq = q and p.ended_at is null);

  -- 4. The itinerary now reflects the target version.
  update public.flight_task_state s
  set basis_version_id = p_target_version_id, row_version = s.row_version + 1, updated_at = now()
  where s.task_id = p_task_id;

  perform authz.write_audit('flight.booking_change_applied', v_task.legal_entity_id, v_task.branch_id,
    'fulfilment_task', v_task.id, null,
    jsonb_build_object('dealId', v_task.deal_id, 'fromVersionId', v_state.basis_version_id, 'toVersionId', p_target_version_id,
      'keptSectors', v_kept, 'removedSectors', cardinality(v_removed), 'addedSectors', v_added,
      'supersededChangeIds', to_jsonb(v_superseded)));
  v_result := jsonb_build_object('taskId', v_task.id,
    'fromVersionNo', v_diff -> 'fromVersionNo', 'toVersionNo', v_diff -> 'toVersionNo',
    'keptSectors', v_kept, 'removedSectors', cardinality(v_removed), 'addedSectors', v_added,
    'flaggedTickets', coalesce((v_diff #>> '{impact,ticketsOnRemoved}')::integer, 0)
                      + coalesce((v_diff #>> '{impact,ticketsOfRemovedTravellers}')::integer, 0),
    'stateRowVersion', v_state.row_version + 1, 'outcome', 'updated');
  return authz.flight_remember(v_task.legal_entity_id, p_request_id, 'flight_booking_change_apply', v_payload, v_result);
end;
$$;

-- public.flight_cancellation_charge_set(uuid, jsonb, integer, uuid): from 20261205000780_manager_approves_final.sql
create or replace function public.flight_cancellation_charge_set(p_batch_id uuid, p_fields jsonb, p_expected_revision integer,
  p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_batch public.flight_ticket_batches%rowtype;
  v_c public.deal_cancellations%rowtype;
  v_prev public.flight_cancellation_charges%rowtype;
  v_existing public.flight_cancellation_charges%rowtype;
  v_key text;
  v_airline bigint;
  v_expected bigint;
  v_reported bigint;
  v_note text;
  v_rev integer;
  v_cr public.booking_change_requests%rowtype;  -- Accounts phase 3 (20261205000730)
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_batch from public.flight_ticket_batches b where b.id = p_batch_id;
  if v_batch.id is null or not authz.holds_active_role('flight', v_batch.legal_entity_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if authz.deployment_environment() = 'unset' then
    raise exception 'environment_unset' using errcode = '55000';
  end if;
  if p_request_id is null then
    perform authz.refund_invalid('requestId');
  end if;
  perform authz.refuse_removed_deal(v_batch.deal_id);
  -- Lock order (13.1): finance head, the Deal's Flight tasks, the cancellation row.
  perform authz.finance_lock_deal(v_batch.deal_id);
  perform 1 from authz.flight_lock_group(v_batch.deal_id);
  select * into v_c from public.deal_cancellations c where c.deal_id = v_batch.deal_id for update;
  -- Accounts phase 3 (20261205000730): without a trip cancellation, the charge belongs to the
  -- live remove_service request (route cancellation) whose service this batch
  -- serves (its cost task or one of its sectors, 11.3). Who: the batch's cost-task
  -- owner, or any active Flight person while that task has no assignee (C9).
  if v_c.id is null then
    select r.* into v_cr from public.booking_change_requests r
    where r.deal_id = v_batch.deal_id and r.kind = 'remove_service' and r.removal_route = 'cancellation'
      and r.status in ('draft', 'requested', 'returned', 'approved', 'submitted')
      and (exists (select 1 from public.fulfilment_tasks t where t.id = v_batch.cost_task_id and t.service_item_id = any (r.item_ids))
           or exists (select 1 from public.flight_sectors s where s.id = any (v_batch.sector_ids) and s.service_item_id = any (r.item_ids)))
    for update;
    if v_cr.id is null then
      raise exception 'not_ready' using errcode = '55000', hint = 'cancellation';
    end if;
    if not exists (select 1 from public.fulfilment_tasks t
                   where t.id = v_batch.cost_task_id
                     and (authz.flight_owns_task_record(t.id)  -- Accounts phase 3 (20261205000770): also after the removal applied (LD13)
                          or (t.assignee_user_id is null and authz.holds_active_role('flight', t.legal_entity_id)))) then
      raise exception 'not_authorized' using errcode = '42501';
    end if;
  elsif not authz.flight_can_enter_charge(v_batch.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_existing from public.flight_cancellation_charges x
  where x.legal_entity_id = v_batch.legal_entity_id and x.request_id = p_request_id;
  if v_existing.id is not null then
    if v_existing.batch_id = v_batch.id and v_existing.entered_by = v_uid
       and (v_existing.cancellation_id = v_c.id or v_existing.change_request_id = v_cr.id) then  -- Accounts phase 3 (20261205000730)
      return jsonb_build_object('outcome', 'existing', 'cancellationId', v_c.id, 'batchId', v_batch.id,
        'revisionNo', v_existing.revision_no, 'status', coalesce(v_c.status, 'charges_entered'), 'changeRequestId', v_cr.id);
    end if;
    raise exception 'duplicate_request' using errcode = '23505';
  end if;
  select * into v_prev from public.flight_cancellation_charges x
  where (x.cancellation_id = v_c.id or x.change_request_id = v_cr.id) and x.batch_id = v_batch.id  -- Accounts phase 3 (20261205000730)
  order by x.revision_no desc limit 1;
  v_rev := coalesce(v_prev.revision_no, 0);
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    perform authz.refund_invalid('fields');
  end if;
  for v_key in select k from jsonb_object_keys(p_fields) k order by k loop
    if v_key <> all (array['airlineChargePaise', 'refundExpectedPaise', 'refundReportedPaise', 'note']) then
      perform authz.refund_invalid(v_key);
    end if;
  end loop;
  v_airline := authz.refund_paise(p_fields, 'airlineChargePaise');
  if v_airline is null or v_airline > 999999999999 then
    perform authz.refund_invalid('airlineChargePaise');
  end if;
  v_expected := authz.refund_paise(p_fields, 'refundExpectedPaise');
  if v_expected is null or v_expected > 999999999999 then
    perform authz.refund_invalid('refundExpectedPaise');
  end if;
  v_reported := authz.refund_paise(p_fields, 'refundReportedPaise');
  if v_reported > 999999999999 then
    perform authz.refund_invalid('refundReportedPaise');
  end if;
  v_note := authz.refund_text(p_fields, 'note', 1, 500, true);
  -- LD13: after approval only the Flight-reported refund may change.
  if (v_c.status = 'approved' or v_cr.status in ('approved', 'submitted'))  -- Accounts phase 3 (20261205000730): the same after the removal was approved
     and (v_prev.id is null or v_airline is distinct from v_prev.airline_charge_paise
          or v_expected is distinct from v_prev.refund_expected_paise) then
    raise exception 'already_decided' using errcode = '55000';
  end if;
  if p_expected_revision is distinct from v_rev then
    raise exception 'version_changed' using errcode = 'PT409';
  end if;

  insert into public.flight_cancellation_charges (cancellation_id, legal_entity_id, deal_id, batch_id, cost_task_id, supplier_id,
    revision_no, supplier_cost_paise, airline_charge_paise, refund_expected_paise, refund_reported_paise, note, entered_by, request_id,
    change_request_id)  -- Accounts phase 3 (20261205000730)
  values (v_c.id, v_batch.legal_entity_id, v_batch.deal_id, v_batch.id, v_batch.cost_task_id, v_batch.supplier_id, v_rev + 1,
    v_batch.supplier_cost_paise, v_airline, v_expected, v_reported, v_note, v_uid, p_request_id, v_cr.id);
  -- Purchase rule: a change before approval (also after sending) puts the case back to charges_entered.
  if v_c.status <> 'approved' then
    update public.deal_cancellations c
    set status = 'charges_entered', row_version = c.row_version + 1, updated_at = now()
    where c.id = v_c.id;
  end if;
  perform authz.write_audit('flight.cancellation_charge_set', v_batch.legal_entity_id, v_batch.branch_id,
    'flight_ticket_batch', v_batch.id, null,
    jsonb_build_object('cancellationId', v_c.id, 'batchId', v_batch.id, 'revisionNo', v_rev + 1, 'previousStatus', v_c.status,
      'changeRequestId', v_cr.id));  -- Accounts phase 3 (20261205000730)
  return jsonb_build_object('outcome', 'created', 'cancellationId', v_c.id, 'batchId', v_batch.id, 'revisionNo', v_rev + 1,
    'status', case when v_c.status = 'approved' or v_cr.status in ('approved', 'submitted') then 'approved' else 'charges_entered' end,
    'changeRequestId', v_cr.id);
end;
$$;

-- public.flight_change_decide(uuid, text, text, integer, uuid): from 20261201000160_flight_review_fixes.sql
create or replace function public.flight_change_decide(
  p_change_id uuid, p_decision text, p_reason text, p_expected_row_version integer, p_request_id uuid
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_change public.flight_changes%rowtype;
  v_task public.fulfilment_tasks%rowtype;
  v_uid uuid := (select auth.uid());
  v_reason text := authz.flight_norm_text(p_reason);
  v_payload jsonb;
  v_replay jsonb;
  v_result jsonb;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_change from public.flight_changes c where c.id = p_change_id;
  if v_change.id is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_change.decider_kind <> 'flight_owner' and v_change.requested_by = v_uid then
    raise exception 'not_self_approval' using errcode = '42501';
  end if;
  if not authz.flight_can_decide_change(p_change_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.flight_refuse_gate(v_change.deal_id);
  if p_decision is null or p_decision not in ('approve', 'reject') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'decision';
  end if;
  if p_decision = 'reject' and (v_reason is null or length(v_reason) not between 10 and 500) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'reason';
  end if;
  v_payload := jsonb_build_object('changeId', p_change_id, 'decision', p_decision,
    'reason', case when p_decision = 'reject' then v_reason end, 'expectedRowVersion', p_expected_row_version);
  v_replay := authz.flight_replay(v_change.legal_entity_id, p_request_id, 'flight_change_decide', v_payload);
  if v_replay is not null then
    return v_replay;
  end if;
  perform authz.flight_lock_group(v_change.deal_id);
  -- 20261201000160: a duplicate that raced the first call returns its stored result.
  v_replay := authz.flight_replay(v_change.legal_entity_id, p_request_id, 'flight_change_decide', v_payload);
  if v_replay is not null then
    return v_replay;
  end if;
  select * into v_change from public.flight_changes c where c.id = p_change_id;
  select * into v_task from public.fulfilment_tasks t where t.id = v_change.task_id;
  if v_change.status <> 'pending' then
    raise exception 'already_decided' using errcode = '55000';
  end if;
  perform authz.require_row_version(p_expected_row_version, v_change.row_version);
  if v_change.basis_version_id <> authz.task_current_version(v_change.task_id) then
    raise exception 'version_changed' using errcode = 'PT409';
  end if;

  if p_decision = 'approve' then
    perform authz.flight_change_apply_approval(p_change_id);
    update public.flight_changes c
    set status = 'approved', decided_by = v_uid, decided_at = now(),
        flight_seen_at = case when c.decider_kind = 'flight_owner' then now() end,
        row_version = c.row_version + 1, updated_at = now()
    where c.id = p_change_id;
    perform authz.write_audit('flight.change_approved', v_task.legal_entity_id, v_task.branch_id,
      'fulfilment_task', v_task.id, null,
      jsonb_build_object('dealId', v_task.deal_id, 'changeId', p_change_id, 'changeNo', v_change.change_no,
        'deciderKind', v_change.decider_kind));
  else
    perform authz.flight_change_close(p_change_id, 'rejected', 'change_rejected');
    update public.flight_changes c
    set status = 'rejected', decided_by = v_uid, decided_at = now(), reject_reason = v_reason,
        row_version = c.row_version + 1, updated_at = now()
    where c.id = p_change_id;
    perform authz.write_audit('flight.change_rejected', v_task.legal_entity_id, v_task.branch_id,
      'fulfilment_task', v_task.id, v_reason,
      jsonb_build_object('dealId', v_task.deal_id, 'changeId', p_change_id, 'changeNo', v_change.change_no,
        'deciderKind', v_change.decider_kind));
  end if;
  v_result := jsonb_build_object('changeId', p_change_id, 'changeNo', v_change.change_no,
    'status', case when p_decision = 'approve' then 'approved' else 'rejected' end,
    'rowVersion', v_change.row_version + 1, 'outcome', 'updated');
  return authz.flight_remember(v_change.legal_entity_id, p_request_id, 'flight_change_decide', v_payload, v_result);
end;
$$;

-- public.flight_direct_payment_save(uuid, integer, jsonb, uuid): from 20261205000770_removed_flight_visa_work.sql
create or replace function public.flight_direct_payment_save(p_batch_id uuid, p_expected_row_version integer, p_fields jsonb,
  p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_batch public.flight_ticket_batches%rowtype;
  v_task public.fulfilment_tasks%rowtype;
  v_old public.department_cost_entries%rowtype;
  v_entry public.department_cost_entries%rowtype;
  v_mode text;
  v_on date;
  v_ref text;
  v_proof uuid;
  v_payload jsonb := jsonb_build_object('batchId', p_batch_id, 'expectedRowVersion', p_expected_row_version,
    'fields', p_fields);
  v_result jsonb;
  v_outcome text;
  v_due bigint;
begin
  select * into v_batch from public.flight_ticket_batches b where b.id = p_batch_id;
  -- Accounts phase 3 (20261205000770): a removed flight takes no new payment (its assignee hears why).
  if exists (select 1 from public.fulfilment_tasks t where t.id = v_batch.cost_task_id and t.closed_state is not null)
     and authz.flight_owns_task_record(v_batch.cost_task_id) then
    raise exception 'service_removed' using errcode = '55000';
  end if;
  if v_batch.id is null or not authz.flight_owns_task(v_batch.cost_task_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.finance_lock_deal(v_batch.deal_id);
  perform authz.flight_lock_group(v_batch.deal_id);
  select * into v_task from public.fulfilment_tasks t where t.id = v_batch.cost_task_id;
  if not authz.flight_owns_task(v_task.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.flight_money_gate(v_batch.deal_id);
  v_result := authz.flight_replay(v_batch.legal_entity_id, p_request_id, 'flight_direct_payment_save', v_payload);
  if v_result is not null then
    return v_result;
  end if;

  if p_fields is null or jsonb_typeof(p_fields) <> 'object'
     or (p_fields - array['paymentMode', 'paidOn', 'reference', 'proofEvidenceId']) <> '{}'::jsonb then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fields';
  end if;
  begin
    v_mode := authz.finance_field(p_fields, 'paymentMode');
  exception when sqlstate '22023' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'paymentMode';
  end;
  if v_mode is null or v_mode not in ('bank_transfer', 'upi', 'card', 'cash', 'other') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'paymentMode';
  end if;
  begin
    v_on := authz.finance_date(authz.finance_field(p_fields, 'paidOn'));
  exception when sqlstate '22023' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'paidOn';
  end;
  if v_on is null or v_on < date '2000-01-01' or v_on > authz.finance_today() then
    raise exception 'invalid_input' using errcode = '22023', hint = 'paidOn';
  end if;
  begin
    v_ref := authz.finance_text(authz.finance_field(p_fields, 'reference'), 1, 120, false);
  exception when sqlstate '22023' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'reference';
  end;
  begin
    v_proof := authz.finance_uuid(authz.finance_field(p_fields, 'proofEvidenceId'));
  exception when sqlstate '22023' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'proofEvidenceId';
  end;

  if authz.deal_trip_cancelled(v_batch.deal_id) then
    raise exception 'trip_cancelled' using errcode = '55000';
  end if;
  if exists (select 1 from public.supplier_payment_requests p
             where p.flight_batch_id = v_batch.id and p.status in ('pending', 'approved', 'paid', 'verified')) then
    raise exception 'payment_in_progress' using errcode = '55000';
  end if;
  select * into v_old from public.department_cost_entries c where c.flight_batch_id = v_batch.id for update;
  if v_old.id is not null then
    if v_old.expense_status in ('submitted', 'accepted') then
      raise exception 'cost_locked' using errcode = '55000';
    end if;
    if p_expected_row_version is distinct from v_old.row_version then
      raise exception 'version_changed' using errcode = 'PT409';
    end if;
  end if;
  -- 20261201000250: less what old-form payments linked to the batch already cover.
  v_due := authz.flight_batch_due(v_batch.id);
  if v_due <= 0 then
    raise exception 'not_ready' using errcode = '55000';
  end if;
  if v_proof is null or not exists (
       select 1 from public.department_evidence e
       where e.id = v_proof and e.task_id = v_task.id and e.kind = 'direct_payment_proof' and e.status = 'stored') then
    raise exception 'receipt_required' using errcode = '55000';
  end if;
  -- C1: cumulative per (Deal, supplier), this payment included; exactly INR 50,000 is direct.
  if authz.sm_supplier_running_total(v_batch.deal_id, v_batch.supplier_id) + v_due > 5000000 then
    raise exception 'direct_payment_over_limit' using errcode = '22023';
  end if;

  if v_old.id is null then
    insert into public.department_cost_entries (task_id, deal_id, legal_entity_id, branch_id, department, cost_kind,
      amount_paise, paid_by, payment_mode, paid_on, reference, receipt_evidence_id, expense_status, submitted_by,
      submitted_at, request_id, created_by, supplier_id, flight_batch_id)
    values (v_task.id, v_batch.deal_id, v_batch.legal_entity_id, v_batch.branch_id, 'flight', 'fare',
      v_due, 'company', v_mode, v_on, v_ref, v_proof, 'submitted', v_uid,
      now(), p_request_id, v_uid, v_batch.supplier_id, v_batch.id)
    returning * into v_entry;
    v_outcome := 'created';
  else
    update public.department_cost_entries c
    set amount_paise = v_due, payment_mode = v_mode, paid_on = v_on, reference = v_ref,
        receipt_evidence_id = v_proof, expense_status = 'submitted', submitted_by = v_uid, submitted_at = now(),
        reviewed_by = null, reviewed_at = null, return_reason = null,
        row_version = c.row_version + 1, updated_at = now()
    where c.id = v_old.id
    returning * into v_entry;
    v_outcome := 'updated';
  end if;

  -- The existing cost audits (History, Accounts) plus the flight one; no amounts.
  perform authz.write_audit('department.cost_saved', v_task.legal_entity_id, v_task.branch_id, 'department_cost_entry',
    v_entry.id, null, jsonb_build_object('taskId', v_task.id, 'department', 'flight', 'costKind', 'fare',
      'paidBy', 'company', 'rowVersion', v_entry.row_version));
  perform authz.write_audit('department.cost_submitted', v_task.legal_entity_id, v_task.branch_id, 'department_cost_entry',
    v_entry.id, null, jsonb_build_object('taskId', v_task.id, 'department', 'flight', 'costKind', 'fare',
      'rowVersion', v_entry.row_version));
  perform authz.write_audit('flight.direct_payment_recorded', v_task.legal_entity_id, v_task.branch_id, 'fulfilment_task',
    v_task.id, null, jsonb_build_object('dealId', v_batch.deal_id, 'batchId', v_batch.id, 'entryId', v_entry.id));
  v_result := jsonb_build_object('outcome', v_outcome, 'batchId', v_batch.id, 'entryId', v_entry.id,
    'rowVersion', v_entry.row_version, 'expenseStatus', v_entry.expense_status);
  return authz.flight_remember(v_batch.legal_entity_id, p_request_id, 'flight_direct_payment_save', v_payload, v_result);
end;
$$;

-- public.flight_fare_approval_decide(uuid, text, text, integer, uuid): from 20261201000210_flight_money_commands.sql
create or replace function public.flight_fare_approval_decide(
  p_approval_id uuid, p_decision text, p_reason text, p_expected_row_version integer, p_request_id uuid
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v public.flight_fare_approvals%rowtype;
  v_reason text;
  v_task uuid;
  v_payload jsonb := jsonb_build_object('approvalId', p_approval_id, 'decision', p_decision, 'reason', p_reason,
    'expectedRowVersion', p_expected_row_version);
  v_result jsonb;
begin
  select * into v from public.flight_fare_approvals a where a.id = p_approval_id;
  if v.id is null then
    if coalesce(authz.session_ok(), false) then
      raise exception 'not_found' using errcode = 'P0002';
    end if;
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  -- A manager who also holds Purchase never decides (or sees) flight money.
  if not coalesce(authz.session_ok(), false) or not authz.is_branch_sales_manager(v.deal_id)
     or authz.holds_role('purchase', v.legal_entity_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.finance_lock_deal(v.deal_id);
  perform authz.flight_lock_group(v.deal_id);
  select * into v from public.flight_fare_approvals a where a.id = p_approval_id for update;
  perform authz.flight_money_gate(v.deal_id);
  v_result := authz.flight_replay(v.legal_entity_id, p_request_id, 'flight_fare_approval_decide', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if p_decision is null or p_decision not in ('approve', 'return') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'decision';
  end if;
  if v.requested_by = v_uid or authz.flight_is_deal_assignee(v.deal_id) then
    raise exception 'not_self_approval' using errcode = '42501';
  end if;
  if v.status <> 'pending' then
    raise exception 'already_decided' using errcode = '55000';
  end if;
  if p_expected_row_version is distinct from v.row_version then
    raise exception 'version_changed' using errcode = 'PT409';
  end if;
  if p_decision = 'approve' then
    update public.flight_fare_approvals a
    set status = 'approved', decided_by = v_uid, decided_at = now(), row_version = a.row_version + 1, updated_at = now()
    where a.id = v.id returning * into v;
  else
    begin
      v_reason := authz.finance_reason(p_reason);
    exception when sqlstate '22023' then
      raise exception 'invalid_input' using errcode = '22023', hint = 'reason';
    end;
    update public.flight_fare_approvals a
    set status = 'returned', return_reason = v_reason, decided_by = v_uid, decided_at = now(),
        row_version = a.row_version + 1, updated_at = now()
    where a.id = v.id returning * into v;
  end if;
  select coalesce(
    (select s.task_id from public.flight_sectors s
     where s.id::text in (select jsonb_array_elements_text(v.payload -> 'sectorIds'))
     order by s.depart_date, s.depart_time nulls last, s.id limit 1),
    (select t.id from public.fulfilment_tasks t where t.deal_id = v.deal_id and t.department = 'flight' order by t.id limit 1))
  into v_task;
  perform authz.write_audit(case when p_decision = 'approve' then 'flight.fare_approval_approved' else 'flight.fare_approval_returned' end,
    v.legal_entity_id, v.branch_id, 'fulfilment_task', v_task, v_reason,
    jsonb_build_object('dealId', v.deal_id, 'approvalId', v.id));
  v_result := jsonb_build_object('outcome', 'updated', 'approvalId', v.id, 'status', v.status, 'rowVersion', v.row_version);
  return authz.flight_remember(v.legal_entity_id, p_request_id, 'flight_fare_approval_decide', v_payload, v_result);
end;
$$;

-- public.flight_fare_approval_withdraw(uuid, integer, uuid): from 20261201000210_flight_money_commands.sql
create or replace function public.flight_fare_approval_withdraw(p_approval_id uuid, p_expected_row_version integer, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v public.flight_fare_approvals%rowtype;
  v_task uuid;
  v_payload jsonb := jsonb_build_object('approvalId', p_approval_id, 'expectedRowVersion', p_expected_row_version);
  v_result jsonb;
begin
  select * into v from public.flight_fare_approvals a where a.id = p_approval_id;
  if v.id is null then
    if coalesce(authz.session_ok(), false) then
      raise exception 'not_found' using errcode = 'P0002';
    end if;
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if not coalesce(authz.session_ok(), false) or v.requested_by is distinct from (select auth.uid())
     or not authz.holds_active_role('flight', v.legal_entity_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.finance_lock_deal(v.deal_id);
  perform authz.flight_lock_group(v.deal_id);
  select * into v from public.flight_fare_approvals a where a.id = p_approval_id for update;
  v_result := authz.flight_replay(v.legal_entity_id, p_request_id, 'flight_fare_approval_withdraw', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if v.status <> 'pending' then
    raise exception 'already_decided' using errcode = '55000';
  end if;
  if p_expected_row_version is distinct from v.row_version then
    raise exception 'version_changed' using errcode = 'PT409';
  end if;
  update public.flight_fare_approvals a
  set status = 'withdrawn', row_version = a.row_version + 1, updated_at = now()
  where a.id = v.id returning * into v;
  select coalesce(
    (select s.task_id from public.flight_sectors s
     where s.id::text in (select jsonb_array_elements_text(v.payload -> 'sectorIds'))
     order by s.depart_date, s.depart_time nulls last, s.id limit 1),
    (select t.id from public.fulfilment_tasks t where t.deal_id = v.deal_id and t.department = 'flight' order by t.id limit 1))
  into v_task;
  perform authz.write_audit('flight.fare_approval_withdrawn', v.legal_entity_id, v.branch_id, 'fulfilment_task', v_task,
    null, jsonb_build_object('dealId', v.deal_id, 'approvalId', v.id));
  v_result := jsonb_build_object('outcome', 'updated', 'approvalId', v.id, 'status', v.status, 'rowVersion', v.row_version);
  return authz.flight_remember(v.legal_entity_id, p_request_id, 'flight_fare_approval_withdraw', v_payload, v_result);
end;
$$;

-- public.flight_group_claim(uuid, uuid): from 20261205000750_closed_tasks_work_lists.sql
create or replace function public.flight_group_claim(p_deal_id uuid, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
  -- Accounts phase 3 (20261205000750): a task closed by a service removal (LD31) is not open work;
  -- every task read below reads open tasks only.
declare
  v_deal public.deals%rowtype;
  v_uid uuid := (select auth.uid());
  v_task public.fulfilment_tasks%rowtype;
  v_ids uuid[];
  v_claimed uuid[] := '{}'::uuid[];
  v_payload jsonb := jsonb_build_object('dealId', p_deal_id);
  v_replay jsonb;
  v_result jsonb;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_deal from public.deals d where d.id = p_deal_id;
  if v_deal.id is null or not authz.holds_active_role('flight', v_deal.legal_entity_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.flight_refuse_gate(p_deal_id);
  v_replay := authz.flight_replay(v_deal.legal_entity_id, p_request_id, 'flight_group_claim', v_payload);
  if v_replay is not null then
    return v_replay;
  end if;
  perform authz.flight_lock_group(p_deal_id);
  -- 20261201000160: a duplicate that raced the first call returns its stored result.
  v_replay := authz.flight_replay(v_deal.legal_entity_id, p_request_id, 'flight_group_claim', v_payload);
  if v_replay is not null then
    return v_replay;
  end if;
  select array_agg(t.id order by i.item_no, t.id) into v_ids
  from (select x.* from public.fulfilment_tasks x where x.closed_state is null) t join public.service_items i on i.id = t.service_item_id
  where t.deal_id = p_deal_id and t.department = 'flight';
  if v_ids is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if exists (select 1 from (select x.* from public.fulfilment_tasks x where x.closed_state is null) t
             where t.deal_id = p_deal_id and t.department = 'flight' and t.status in ('in_progress', 'completed')
               and t.assignee_user_id is distinct from v_uid) then
    raise exception 'task_conflict' using errcode = 'PT409';
  end if;

  for v_task in
    select t.* from (select x.* from public.fulfilment_tasks x where x.closed_state is null) t join public.service_items i on i.id = t.service_item_id
    where t.deal_id = p_deal_id and t.department = 'flight' and t.status = 'not_started'
    order by i.item_no, t.id
  loop
    update public.fulfilment_tasks t set assignee_user_id = v_uid, status = 'in_progress', updated_at = now()
    where t.id = v_task.id;
    v_claimed := v_claimed || v_task.id;
    perform authz.write_audit('fulfilment.task_claimed', v_task.legal_entity_id, v_task.branch_id,
      'fulfilment_task', v_task.id, null,
      jsonb_build_object('dealId', v_task.deal_id, 'versionId', authz.task_current_version(v_task.id),
        'serviceItemId', v_task.service_item_id, 'department', 'flight', 'group', true));
  end loop;

  -- Every task of the caller without a state (claimed now, or earlier with the
  -- old per-task command) gets its itinerary from its current version.
  for v_task in
    select t.* from (select x.* from public.fulfilment_tasks x where x.closed_state is null) t
    where t.deal_id = p_deal_id and t.department = 'flight' and t.status = 'in_progress' and t.assignee_user_id = v_uid
      and not exists (select 1 from public.flight_task_state s where s.task_id = t.id)
  loop
    insert into public.flight_task_state (task_id, legal_entity_id, deal_id, service_item_id, basis_version_id, built_by)
    values (v_task.id, v_task.legal_entity_id, v_task.deal_id, v_task.service_item_id,
            authz.task_current_version(v_task.id), v_uid);
    perform authz.flight_build_sectors(v_task.id);
  end loop;

  if cardinality(v_claimed) > 0 then
    insert into public.deal_assignments (deal_id, legal_entity_id, user_id, assignment_kind, assigned_by)
    values (p_deal_id, v_deal.legal_entity_id, v_uid, 'flight', v_uid)
    on conflict (deal_id, user_id, assignment_kind) where ended_at is null do nothing;
    perform authz.write_audit('flight.group_claimed', v_deal.legal_entity_id, v_deal.branch_id,
      'fulfilment_task', v_ids[1], null, jsonb_build_object('dealId', p_deal_id, 'taskIds', to_jsonb(v_claimed)));
  end if;

  v_result := jsonb_build_object('dealId', p_deal_id, 'taskIds', to_jsonb(v_ids), 'claimedTaskIds', to_jsonb(v_claimed),
    'outcome', case when cardinality(v_claimed) = 0 then 'existing' else 'created' end);
  return authz.flight_remember(v_deal.legal_entity_id, p_request_id, 'flight_group_claim', v_payload, v_result);
end;
$$;

-- public.flight_group_complete(uuid, uuid[], uuid): from 20261205000770_removed_flight_visa_work.sql
create or replace function public.flight_group_complete(p_deal_id uuid, p_expected_task_ids uuid[], p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
  -- Accounts phase 3 (20261205000770): a task closed by a service removal is not open work.
declare
  v_deal public.deals%rowtype;
  v_uid uuid := (select auth.uid());
  v_ids uuid[];
  v_issues text[];
  v_task public.fulfilment_tasks%rowtype;
  v_payload jsonb;
  v_replay jsonb;
  v_result jsonb;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_deal from public.deals d where d.id = p_deal_id;
  if v_deal.id is null or not authz.holds_active_role('flight', v_deal.legal_entity_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_expected_task_ids is null or cardinality(p_expected_task_ids) = 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'taskIds';
  end if;
  v_payload := jsonb_build_object('dealId', p_deal_id,
    'taskIds', (select to_jsonb(array_agg(x order by x)) from (select distinct unnest(p_expected_task_ids) x) q));
  -- An exact retry by the same person returns the stored result (the tasks
  -- are completed by then, so the work check below no longer holds).
  v_replay := authz.flight_replay(v_deal.legal_entity_id, p_request_id, 'flight_group_complete', v_payload);
  if v_replay is not null then
    return v_replay;
  end if;
  if not authz.flight_can_work(p_deal_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.flight_refuse_gate(p_deal_id);
  perform authz.flight_lock_group(p_deal_id);
  -- 20261201000160: a duplicate that raced the first call returns its stored result.
  v_replay := authz.flight_replay(v_deal.legal_entity_id, p_request_id, 'flight_group_complete', v_payload);
  if v_replay is not null then
    return v_replay;
  end if;
  if not authz.flight_can_work(p_deal_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select array_agg(t.id order by t.id) into v_ids from (select x.* from public.fulfilment_tasks x where x.closed_state is null) t
  where t.deal_id = p_deal_id and t.department = 'flight' and t.status = 'in_progress';
  if v_ids is distinct from (select array_agg(x order by x) from (select distinct unnest(p_expected_task_ids) x) q) then
    raise exception 'version_changed' using errcode = 'PT409';
  end if;
  v_issues := authz.flight_done_issues(p_deal_id);
  if cardinality(v_issues) > 0 then
    raise exception 'not_ready' using errcode = '55000', hint = array_to_string(v_issues, ',');
  end if;
  for v_task in select t.* from (select x.* from public.fulfilment_tasks x where x.closed_state is null) t where t.id = any (v_ids) order by t.id loop
    update public.fulfilment_tasks t set status = 'completed', completed_by = v_uid, completed_at = now(), updated_at = now()
    where t.id = v_task.id;
    insert into public.outbox_events (legal_entity_id, aggregate_type, aggregate_id, event_type, payload)
    values (v_task.legal_entity_id, 'fulfilment_task', v_task.id, 'fulfilment.task_completed',
      jsonb_build_object('task_id', v_task.id, 'deal_id', v_task.deal_id, 'service_item_id', v_task.service_item_id,
        'service_type', v_task.service_purpose))
    on conflict (event_type, aggregate_id) do nothing;
    perform authz.write_audit('fulfilment.task_completed', v_task.legal_entity_id, v_task.branch_id, 'fulfilment_task',
      v_task.id, null, jsonb_build_object('dealId', v_task.deal_id, 'serviceItemId', v_task.service_item_id,
        'department', 'flight', 'group', true));
  end loop;
  perform authz.write_audit('flight.group_completed', v_deal.legal_entity_id, v_deal.branch_id, 'fulfilment_task',
    v_ids[1], null, jsonb_build_object('dealId', p_deal_id, 'taskIds', to_jsonb(v_ids)));
  v_result := jsonb_build_object('dealId', p_deal_id, 'taskIds', to_jsonb(v_ids), 'status', 'completed', 'outcome', 'updated');
  return authz.flight_remember(v_deal.legal_entity_id, p_request_id, 'flight_group_complete', v_payload, v_result);
end;
$$;

-- public.flight_group_reassign(uuid, uuid, uuid, text, uuid): from 20261201000160_flight_review_fixes.sql
create or replace function public.flight_group_reassign(
  p_deal_id uuid, p_expected_assignee uuid, p_to_user_id uuid, p_reason text, p_request_id uuid
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_deal public.deals%rowtype;
  v_uid uuid := (select auth.uid());
  v_reason text := authz.flight_norm_text(p_reason);
  v_task public.fulfilment_tasks%rowtype;
  v_moved uuid[] := '{}'::uuid[];
  v_from uuid[] := '{}'::uuid[];
  v_payload jsonb;
  v_replay jsonb;
  v_result jsonb;
  v_first uuid;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_deal from public.deals d where d.id = p_deal_id;
  if v_deal.id is null or not authz.is_branch_sales_manager(p_deal_id) or authz.holds_role('flight', v_deal.legal_entity_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.flight_refuse_gate(p_deal_id);
  if p_expected_assignee is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'expectedAssignee';
  end if;
  if p_to_user_id is null or not authz.is_active_department_person(p_to_user_id, v_deal.legal_entity_id, 'flight') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'toUserId';
  end if;
  if v_reason is null or length(v_reason) not between 10 and 300 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'reason';
  end if;
  v_payload := jsonb_build_object('dealId', p_deal_id, 'expectedAssignee', p_expected_assignee, 'toUserId', p_to_user_id,
    'reason', v_reason);
  v_replay := authz.flight_replay(v_deal.legal_entity_id, p_request_id, 'flight_group_reassign', v_payload);
  if v_replay is not null then
    return v_replay;
  end if;
  perform authz.flight_lock_group(p_deal_id);
  -- 20261201000160: a duplicate that raced the first call returns its stored result.
  v_replay := authz.flight_replay(v_deal.legal_entity_id, p_request_id, 'flight_group_reassign', v_payload);
  if v_replay is not null then
    return v_replay;
  end if;
  if not exists (select 1 from public.fulfilment_tasks t
                 where t.deal_id = p_deal_id and t.department = 'flight' and t.status = 'in_progress') then
    raise exception 'not_ready' using errcode = '55000';
  end if;
  -- Every in-progress task is held by the expected person (or already by the
  -- new one: a group split by the old per-task claims is joined this way).
  if exists (select 1 from public.fulfilment_tasks t
             where t.deal_id = p_deal_id and t.department = 'flight' and t.status = 'in_progress'
               and t.assignee_user_id not in (p_expected_assignee, p_to_user_id)) then
    raise exception 'task_conflict' using errcode = 'PT409';
  end if;
  select t.id into v_first from public.fulfilment_tasks t join public.service_items i on i.id = t.service_item_id
  where t.deal_id = p_deal_id and t.department = 'flight' order by i.item_no, t.id limit 1;

  perform set_config('authz.task_transition', 'reassign', true);
  for v_task in
    select t.* from public.fulfilment_tasks t join public.service_items i on i.id = t.service_item_id
    where t.deal_id = p_deal_id and t.department = 'flight' and t.status = 'in_progress'
      and t.assignee_user_id is distinct from p_to_user_id
    order by i.item_no, t.id
  loop
    update public.fulfilment_tasks t set assignee_user_id = p_to_user_id, updated_at = now() where t.id = v_task.id;
    v_moved := v_moved || v_task.id;
    if not (v_task.assignee_user_id = any (v_from)) then
      v_from := v_from || v_task.assignee_user_id;
    end if;
    perform authz.write_audit('fulfilment.task_reassigned', v_task.legal_entity_id, v_task.branch_id,
      'fulfilment_task', v_task.id, v_reason,
      jsonb_build_object('dealId', p_deal_id, 'fromUserId', v_task.assignee_user_id, 'toUserId', p_to_user_id,
        'group', true));
  end loop;
  perform set_config('authz.task_transition', '', true);

  if cardinality(v_moved) > 0 then
    update public.deal_assignments a set ended_at = now()
    where a.deal_id = p_deal_id and a.assignment_kind = 'flight' and a.user_id = any (v_from) and a.ended_at is null
      and not exists (select 1 from public.fulfilment_tasks t
                      where t.deal_id = p_deal_id and t.department = 'flight' and t.status = 'in_progress'
                        and t.assignee_user_id = a.user_id);
    insert into public.deal_assignments (deal_id, legal_entity_id, user_id, assignment_kind, assigned_by)
    values (p_deal_id, v_deal.legal_entity_id, p_to_user_id, 'flight', v_uid)
    on conflict (deal_id, user_id, assignment_kind) where ended_at is null do nothing;
    perform authz.write_audit('flight.group_reassigned', v_deal.legal_entity_id, v_deal.branch_id,
      'fulfilment_task', v_first, v_reason,
      jsonb_build_object('dealId', p_deal_id, 'taskIds', to_jsonb(v_moved), 'fromUserIds', to_jsonb(v_from),
        'toUserId', p_to_user_id));
  end if;

  v_result := jsonb_build_object('dealId', p_deal_id, 'taskIds', to_jsonb(v_moved), 'toUserId', p_to_user_id,
    'outcome', case when cardinality(v_moved) = 0 then 'existing' else 'updated' end);
  return authz.flight_remember(v_deal.legal_entity_id, p_request_id, 'flight_group_reassign', v_payload, v_result);
end;
$$;

-- public.flight_supplier_update(uuid, integer, jsonb): from 20261204000110_supplier_master_commands.sql
create or replace function public.flight_supplier_update(p_supplier_id uuid, p_expected_row_version integer, p_fields jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_s public.suppliers%rowtype;
  v_name text;
  v_status text;
  v_city text;
  v_contact text;
  v_phone text;
  v_email text;
  v_m jsonb;
  v_details_changed boolean;
  v_contact_changed boolean;
  v_reset boolean;
  v_changed text[];
begin
  select * into v_s from public.suppliers s where s.id = p_supplier_id for update;
  if v_s.id is null or not coalesce(authz.session_ok(), false)
     or not authz.holds_active_role('flight', v_s.legal_entity_id) or v_s.service_types <> array['flight'] then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if authz.deployment_environment() = 'unset' then
    raise exception 'environment_unset' using errcode = '55000';
  end if;
  if p_expected_row_version is distinct from v_s.row_version then
    raise exception 'version_changed' using errcode = 'PT409';
  end if;
  if p_fields is null or jsonb_typeof(p_fields) <> 'object'
     or (p_fields - array['name', 'city', 'contactName', 'contactPhone', 'contactEmail', 'status',
                          -- Accounts phase 2 (20261204000110)
                          'supplierKind', 'gstin', 'pan', 'stateCode', 'address']) <> '{}'::jsonb then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fields';
  end if;
  begin
    v_name := authz.booking_fact_text(p_fields, 'name', 200, false);
  exception when sqlstate '22023' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'name';
  end;
  if v_name is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'name';
  end if;
  begin
    v_status := coalesce(authz.booking_fact_text(p_fields, 'status', 20, false), v_s.status);
  exception when sqlstate '22023' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'status';
  end;
  if v_status not in ('active', 'archived') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'status';
  end if;
  begin
    v_city := authz.booking_fact_text(p_fields, 'city', 120, false);
    v_contact := authz.booking_fact_text(p_fields, 'contactName', 120, false);
    v_phone := authz.booking_fact_text(p_fields, 'contactPhone', 40, false);
    v_email := authz.booking_fact_text(p_fields, 'contactEmail', 254, false);
  exception when sqlstate '22023' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fields';
  end;
  if exists (select 1 from public.suppliers s
             where s.legal_entity_id = v_s.legal_entity_id and lower(s.name) = lower(v_name) and s.id <> v_s.id) then
    raise exception 'duplicate_supplier' using errcode = '23505';
  end if;
  v_m := authz.supplier_master_values(p_fields, v_s);
  v_details_changed := (v_name, v_city, v_contact, v_phone, v_email)
    is distinct from (v_s.name, v_s.city, v_s.contact_name, v_s.contact_phone, v_s.contact_email)
    or (v_m ->> 'supplierKind', v_m ->> 'gstin', v_m ->> 'pan', v_m ->> 'stateCode', v_m ->> 'address')
       is distinct from (v_s.supplier_kind, v_s.gstin, v_s.pan, v_s.state_code, v_s.address);
  v_contact_changed := (v_contact, v_phone, v_email) is distinct from (v_s.contact_name, v_s.contact_phone, v_s.contact_email);
  v_reset := v_details_changed and v_s.verification_status = 'verified';

  begin
    update public.suppliers s set
      name = v_name,
      city = v_city,
      contact_name = v_contact,
      contact_phone = v_phone,
      contact_email = v_email,
      supplier_kind = v_m ->> 'supplierKind',
      gstin = v_m ->> 'gstin',
      pan = v_m ->> 'pan',
      state_code = v_m ->> 'stateCode',
      address = v_m ->> 'address',
      status = v_status,
      verification_status = case when v_details_changed then 'unverified' else s.verification_status end,
      verified_by = case when v_details_changed then null else s.verified_by end,
      verified_at = case when v_details_changed then null else s.verified_at end,
      row_version = s.row_version + 1,
      updated_by = case when v_details_changed then (select auth.uid()) else s.updated_by end,
      updated_at = now()
    where s.id = v_s.id
    returning * into v_s;
  exception
    when unique_violation then
      raise exception 'duplicate_supplier' using errcode = '23505';
    when check_violation then
      raise exception 'invalid_input' using errcode = '22023', hint = 'fields';
  end;
  if v_contact_changed then
    perform authz.supplier_primary_from_legacy(v_s);
  end if;

  -- Field names only; contact values are not copied into the audit trail.
  select coalesce(array_agg(k order by k), '{}') into v_changed from jsonb_object_keys(p_fields) k;
  perform authz.write_audit('supplier.updated', v_s.legal_entity_id, null, 'supplier', v_s.id, null,
    jsonb_build_object('fields', to_jsonb(v_changed), 'rowVersion', v_s.row_version, 'status', v_s.status,
      'detailsChanged', v_details_changed, 'verificationReset', v_reset, 'department', 'flight'));
  return jsonb_build_object('supplierId', v_s.id, 'rowVersion', v_s.row_version,
    'warnings', authz.supplier_warnings(v_s.id));
end;
$$;

-- public.flight_ticket_correct(uuid, integer, integer, jsonb, text, uuid): from 20261201000160_flight_review_fixes.sql
create or replace function public.flight_ticket_correct(
  p_sector_id uuid, p_traveller_seq integer, p_expected_revision_no integer, p_fields jsonb, p_reason text, p_request_id uuid
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_sector public.flight_sectors%rowtype;
  v_task public.fulfilment_tasks%rowtype;
  v_cur public.flight_ticket_revisions%rowtype;
  v_uid uuid := (select auth.uid());
  v_reason text := authz.flight_norm_text(p_reason);
  v_norm jsonb;
  v_issue text;
  v_payload jsonb;
  v_replay jsonb;
  v_result jsonb;
  v_id uuid;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_sector from public.flight_sectors s where s.id = p_sector_id;
  select * into v_task from public.fulfilment_tasks t where t.id = v_sector.task_id;
  if v_sector.id is null
     or not ((v_task.assignee_user_id = v_uid and v_task.status in ('in_progress', 'completed')
              and authz.holds_active_role('flight', v_task.legal_entity_id))
             or authz.is_branch_sales_manager(v_task.deal_id)) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.flight_refuse_gate(v_task.deal_id);
  if p_traveller_seq is null or p_traveller_seq not between 1 and 100 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'travellerSeq';
  end if;
  if p_fields is null or jsonb_typeof(p_fields) <> 'object'
     or exists (select 1 from jsonb_object_keys(p_fields) k where k not in ('crsType', 'crsPnr', 'airlinePnr', 'ticketNumber')) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fields';
  end if;
  v_issue := authz.flight_ticket_fields_issue(p_fields);
  if v_issue is not null then
    raise exception 'invalid_input' using errcode = '22023', hint = v_issue;
  end if;
  if v_reason is null or length(v_reason) not between 10 and 300 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'reason';
  end if;
  v_norm := authz.flight_ticket_fields_normalize(p_fields);
  v_payload := jsonb_build_object('sectorId', p_sector_id, 'travellerSeq', p_traveller_seq,
    'expectedRevisionNo', p_expected_revision_no, 'fields', v_norm, 'reason', v_reason);
  v_replay := authz.flight_replay(v_task.legal_entity_id, p_request_id, 'flight_ticket_correct', v_payload);
  if v_replay is not null then
    return v_replay;
  end if;
  perform authz.flight_lock_group(v_task.deal_id);
  -- 20261201000160: a duplicate that raced the first call returns its stored result.
  v_replay := authz.flight_replay(v_task.legal_entity_id, p_request_id, 'flight_ticket_correct', v_payload);
  if v_replay is not null then
    return v_replay;
  end if;
  select * into v_cur from public.flight_ticket_revisions r
  where r.sector_id = p_sector_id and r.traveller_seq = p_traveller_seq order by r.revision_no desc limit 1;
  if v_cur.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if p_expected_revision_no is null or p_expected_revision_no <> v_cur.revision_no then
    raise exception 'version_changed' using errcode = 'PT409';
  end if;
  if (v_cur.crs_type, v_cur.crs_pnr, v_cur.airline_pnr, v_cur.ticket_number)
     is not distinct from (v_norm ->> 'crsType', v_norm ->> 'crsPnr', v_norm ->> 'airlinePnr', v_norm ->> 'ticketNumber')
     and exists (select 1 from public.booking_version_travellers s
                 where s.booking_version_id = authz.task_current_version(v_task.id) and s.seq = p_traveller_seq
                   and s.full_name = v_cur.traveller_name and s.traveller_type = v_cur.traveller_type) then
    raise exception 'no_difference' using errcode = '22023';
  end if;
  v_id := authz.flight_insert_ticket_revision(p_sector_id, p_traveller_seq, v_cur.batch_id, v_norm, v_reason, p_request_id);
  perform authz.write_audit('flight.ticket_corrected', v_task.legal_entity_id, v_task.branch_id,
    'fulfilment_task', v_task.id, v_reason,
    jsonb_build_object('dealId', v_task.deal_id, 'sectorId', p_sector_id, 'travellerSeq', p_traveller_seq,
      'revisionNo', v_cur.revision_no + 1));
  v_result := jsonb_build_object('revisionId', v_id, 'sectorId', p_sector_id, 'travellerSeq', p_traveller_seq,
    'revisionNo', v_cur.revision_no + 1, 'outcome', 'created');
  return authz.flight_remember(v_task.legal_entity_id, p_request_id, 'flight_ticket_correct', v_payload, v_result);
end;
$$;

-- public.hotel_catalogue_save(uuid, uuid, integer, jsonb, text): from 20261128000120_vn_hotel_catalogue.sql
create or replace function public.hotel_catalogue_save(p_legal_entity_id uuid, p_id uuid, p_expected_row_version integer,
  p_fields jsonb, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_reason text;
  v_old public.hotel_catalogue%rowtype;
  v_merged jsonb;
  v_chk jsonb;
  v_vals jsonb;
  v_ver text;
  v_id uuid;
  v_row integer;
  v_changed text[];
begin
  if p_legal_entity_id is null or not authz.can_switch_live_settings(p_legal_entity_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  v_reason := authz.settings_change_reason(p_reason);
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fields';
  end if;
  if p_expected_row_version is null or p_expected_row_version < 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'expectedRowVersion';
  end if;
  if p_id is not null then
    select * into v_old from public.hotel_catalogue h where h.id = p_id and h.legal_entity_id = p_legal_entity_id for update;
    if v_old.id is null then
      raise exception 'not_found' using errcode = 'P0002';
    end if;
  end if;
  if coalesce(v_old.row_version, 0) <> p_expected_row_version then
    raise exception 'version_changed' using errcode = 'PT409';
  end if;
  v_merged := case when v_old.id is null then '{}'::jsonb else jsonb_build_object('name', v_old.name, 'city', v_old.city,
      'area', v_old.area, 'address', v_old.address, 'starCategory', v_old.star_category, 'sourceRef', v_old.source_ref,
      'status', v_old.status, 'verification', v_old.verification) end || p_fields;
  v_chk := authz.vn_hotel_check(v_merged);
  if jsonb_array_length(v_chk -> 'keys') > 0 then
    raise exception 'invalid_input' using errcode = '22023',
      hint = array_to_string(array(select jsonb_array_elements_text(v_chk -> 'keys')), ',');
  end if;
  v_vals := v_chk -> 'values';
  v_ver := coalesce(v_vals ->> 'verification', 'not_checked');
  if v_vals ->> 'sourceRef' is not null and exists (
       select 1 from public.hotel_catalogue h
       where h.legal_entity_id = p_legal_entity_id and h.source_ref = v_vals ->> 'sourceRef'
         and h.id is distinct from v_old.id) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'sourceRef';
  end if;

  if v_old.id is null then
    insert into public.hotel_catalogue (legal_entity_id, name, city, area, address, star_category, source_ref, status,
      verification, checked_by, checked_at, created_by, updated_by)
    values (p_legal_entity_id, v_vals ->> 'name', v_vals ->> 'city', v_vals ->> 'area', v_vals ->> 'address',
      v_vals ->> 'starCategory', v_vals ->> 'sourceRef', v_vals ->> 'status', v_ver,
      case when v_ver = 'checked' then (select auth.uid()) end, case when v_ver = 'checked' then now() end,
      (select auth.uid()), (select auth.uid()))
    returning id, row_version into v_id, v_row;
    v_changed := array['name', 'city', 'area', 'address', 'starCategory', 'sourceRef', 'status', 'verification'];
  else
    v_changed := array_remove(array[
      case when v_old.name is distinct from v_vals ->> 'name' then 'name' end,
      case when v_old.city is distinct from v_vals ->> 'city' then 'city' end,
      case when v_old.area is distinct from v_vals ->> 'area' then 'area' end,
      case when v_old.address is distinct from v_vals ->> 'address' then 'address' end,
      case when v_old.star_category is distinct from v_vals ->> 'starCategory' then 'starCategory' end,
      case when v_old.source_ref is distinct from v_vals ->> 'sourceRef' then 'sourceRef' end,
      case when v_old.status is distinct from v_vals ->> 'status' then 'status' end,
      case when v_old.verification is distinct from v_ver then 'verification' end], null);
    if cardinality(v_changed) = 0 then
      return jsonb_build_object('id', v_old.id, 'rowVersion', v_old.row_version, 'outcome', 'unchanged');
    end if;
    update public.hotel_catalogue h
    set name = v_vals ->> 'name', city = v_vals ->> 'city', area = v_vals ->> 'area', address = v_vals ->> 'address',
        star_category = v_vals ->> 'starCategory', source_ref = v_vals ->> 'sourceRef', status = v_vals ->> 'status',
        verification = v_ver,
        checked_by = case when v_ver = 'checked' then case when v_old.verification = 'checked' then v_old.checked_by
                                                          else (select auth.uid()) end end,
        checked_at = case when v_ver = 'checked' then case when v_old.verification = 'checked' then v_old.checked_at
                                                          else now() end end,
        row_version = h.row_version + 1, updated_by = (select auth.uid()), updated_at = now()
    where h.id = v_old.id
    returning id, row_version into v_id, v_row;
  end if;
  perform authz.write_audit('hotel.catalogue_saved', p_legal_entity_id, null, 'hotel_catalogue', v_id, v_reason,
    jsonb_build_object('outcome', case when v_old.id is null then 'created' else 'updated' end,
      'changedFields', to_jsonb(v_changed), 'rowVersion', v_row));
  return jsonb_build_object('id', v_id, 'rowVersion', v_row,
    'outcome', case when v_old.id is null then 'created' else 'updated' end);
end;
$$;

-- public.import_batch_apply(uuid, integer, text, text, jsonb): from 20261205000530_rate_sheet_import.sql
create or replace function public.import_batch_apply(p_batch_id uuid, p_expected_row_version integer, p_reason text,
  p_proposal_hash text default null, p_bank jsonb default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  b public.import_batches%rowtype;
  v_reason text;
  v_summary jsonb;
  r public.import_rows%rowtype;
  v_v jsonb;
  v_id uuid;
  v_hotel public.hotel_catalogue%rowtype;
  v_party public.customer_parties%rowtype;
  v_created integer := 0;
  v_updated integer := 0;
  v_result jsonb;
  v_counts jsonb;  -- Accounts phase 2
  v_rs jsonb;      -- Accounts phase 3 (20261205000530)
begin
  b := authz.vn_import_lock(p_batch_id);
  if b.status = 'applied' then
    return b.apply_result || jsonb_build_object('outcome', 'existing');
  end if;
  if b.status = 'cancelled' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  if b.status <> 'validated' then
    raise exception 'import_not_validated' using errcode = '55000';
  end if;
  perform authz.require_row_version(p_expected_row_version, b.row_version);
  v_reason := authz.settings_change_reason(p_reason);
  -- Accounts phase 3 (20261205000530): rate sheets need the rate contracts switch.
  if b.kind = 'rate_sheet' then
    perform authz.rc_require_on();
  end if;

  -- Writers of the target table wait for this apply; readers do not.
  if b.kind = 'hotel' then
    lock table public.hotel_catalogue in share row exclusive mode;
  elsif b.kind = 'supplier' then
    lock table public.suppliers in share row exclusive mode;
  -- Accounts phase 3 (20261205000530): room types are matched by name; their writers wait.
  elsif b.kind = 'rate_sheet' then
    lock table public.hotel_room_types in share row exclusive mode;
  else
    lock table public.customer_parties in share row exclusive mode;
  end if;
  v_summary := authz.vn_import_evaluate(b);
  -- Echo-A L3: the screen posts the row version (and optionally the
  -- proposal hash) of the summary it showed; the re-run must give the same
  -- rows, outcomes, targets and target versions.
  if (p_proposal_hash is not null and p_proposal_hash is distinct from b.summary ->> 'proposalHash')
     or v_summary ->> 'proposalHash' is distinct from b.summary ->> 'proposalHash' then
    raise exception 'import_stale' using errcode = 'PT409';
  end if;

  if b.kind = 'supplier' then
    -- Accounts phase 2 (20261204000140, L7): bank numbers come from the same file sent
    -- again (its sha256 must be the staged file's); rows that need one without it are refused.
    if p_bank is not null and (jsonb_typeof(p_bank) <> 'object' or p_bank ->> 'fileSha256' is distinct from b.source_sha256
                               or jsonb_typeof(coalesce(p_bank -> 'accounts', '{}'::jsonb)) <> 'object') then
      raise exception 'invalid_input' using errcode = '22023', hint = 'file';
    end if;
    v_counts := authz.vn_import_apply_supplier(b, coalesce(p_bank -> 'accounts', '{}'::jsonb));
    v_created := (v_counts ->> 'created')::integer;
    v_updated := (v_counts ->> 'updated')::integer;
  -- Accounts phase 3 (20261205000530): draft contracts, lines, blackouts and new room types.
  elsif b.kind = 'rate_sheet' then
    v_rs := authz.vn_import_apply_rate_sheet(b);
    v_created := (v_rs ->> 'created')::integer;
  else
  for r in select * from public.import_rows x where x.batch_id = b.id and x.outcome in ('create', 'update') order by x.row_no loop
    if b.kind = 'hotel' then
      v_v := authz.vn_hotel_check(r.data - 'verification') -> 'values';
      if r.outcome = 'create' then
        insert into public.hotel_catalogue (legal_entity_id, name, city, area, address, star_category, source_ref, status,
          import_batch_id, created_by, updated_by)
        values (b.legal_entity_id, v_v ->> 'name', v_v ->> 'city', v_v ->> 'area', v_v ->> 'address',
          v_v ->> 'starCategory', v_v ->> 'sourceRef', v_v ->> 'status', b.id, (select auth.uid()), (select auth.uid()))
        returning id into v_id;
        v_created := v_created + 1;
        update public.import_rows x set target_id = v_id where x.batch_id = r.batch_id and x.row_no = r.row_no;
      else
        select * into v_hotel from public.hotel_catalogue h where h.id = r.target_id for update;
        -- Columns missing from the file keep the stored value.
        v_v := authz.vn_hotel_fields(v_hotel) || (authz.vn_import_present(v_v, r.data) - 'sourceRef');
        update public.hotel_catalogue h
        set name = v_v ->> 'name', city = v_v ->> 'city', area = v_v ->> 'area', address = v_v ->> 'address',
            star_category = v_v ->> 'starCategory', status = v_v ->> 'status', import_batch_id = b.id,
            row_version = h.row_version + 1, updated_by = (select auth.uid()), updated_at = now()
        where h.id = v_hotel.id and h.verification <> 'checked';
        v_updated := v_updated + 1;
        update public.import_rows x
        set before = jsonb_build_object('name', v_hotel.name, 'city', v_hotel.city, 'area', v_hotel.area,
              'address', v_hotel.address, 'starCategory', v_hotel.star_category, 'status', v_hotel.status)
        where x.batch_id = r.batch_id and x.row_no = r.row_no;
      end if;
    else
      v_v := authz.vn_party_check(r.data, false) -> 'values';
      if r.outcome = 'create' then
        insert into public.customer_parties (legal_entity_id, branch_id, party_type, name, contact_person, phone, email,
          address_line1, address_line2, city, state_code, postal_code, gst_status, gstin, gst_reason, source_ref,
          import_batch_id, created_by, updated_by)
        values (b.legal_entity_id, b.branch_id, v_v ->> 'partyType', v_v ->> 'name', v_v ->> 'contactPerson',
          v_v ->> 'phone', v_v ->> 'email', v_v ->> 'addressLine1', v_v ->> 'addressLine2', v_v ->> 'city',
          v_v ->> 'stateCode', v_v ->> 'postalCode', v_v ->> 'gstStatus', v_v ->> 'gstin', v_v ->> 'gstReason',
          v_v ->> 'sourceRef', b.id, (select auth.uid()), (select auth.uid()))
        returning id into v_id;
        v_created := v_created + 1;
        update public.import_rows x set target_id = v_id where x.batch_id = r.batch_id and x.row_no = r.row_no;
      else
        select * into v_party from public.customer_parties p where p.id = r.target_id for update;
        -- Columns missing from the file keep the stored value.
        v_v := authz.vn_party_fields(v_party) || (authz.vn_import_present(v_v, r.data) - 'sourceRef');
        update public.customer_parties p
        set party_type = v_v ->> 'partyType', name = v_v ->> 'name', contact_person = v_v ->> 'contactPerson',
            phone = v_v ->> 'phone', email = v_v ->> 'email', address_line1 = v_v ->> 'addressLine1',
            address_line2 = v_v ->> 'addressLine2', city = v_v ->> 'city', state_code = v_v ->> 'stateCode',
            postal_code = v_v ->> 'postalCode', gst_status = v_v ->> 'gstStatus', gstin = v_v ->> 'gstin',
            gst_reason = v_v ->> 'gstReason',
            -- Never checked by an import; a returned party goes back to not_checked.
            check_status = 'not_checked', check_reason = null, checked_by = null, checked_at = null,
            import_batch_id = b.id, row_version = p.row_version + 1, updated_by = (select auth.uid()), updated_at = now()
        where p.id = v_party.id and p.check_status <> 'checked';
        v_updated := v_updated + 1;
        update public.import_rows x set before = authz.vn_party_fields(v_party)
        where x.batch_id = r.batch_id and x.row_no = r.row_no;
      end if;
    end if;
  end loop;
  end if;

  v_result := jsonb_build_object('batchId', b.id, 'status', 'applied', 'created', v_created, 'updated', v_updated,
    'unchanged', (v_summary -> 'proposed' -> 'unchanged')::integer,
    'skippedChecked', (v_summary -> 'proposed' -> 'skippedChecked')::integer,
    'invalid', (v_summary ->> 'invalid')::integer + (v_summary ->> 'duplicatesInFile')::integer);
  if b.kind = 'rate_sheet' then
    -- Accounts phase 3 (20261205000530): counts only; the staged cells are kept (no personal data).
    v_result := v_result || jsonb_build_object('lines', (v_rs ->> 'lines')::integer, 'roomTypes', (v_rs ->> 'roomTypes')::integer);
  elsif b.kind = 'supplier' then
    -- Accounts phase 2 (LD21): staged account numbers become XXXX<last4>.
    perform authz.vn_supplier_mask_rows(b.id);
  else
    -- Echo-A L4: the staged cells (personal data for customers) are blanked;
    -- source reference, outcome, reasons, target and previous values stay.
    update public.import_rows x set data = '{}'::jsonb where x.batch_id = b.id;
  end if;
  update public.import_batches x
  set status = 'applied', summary = v_summary, apply_result = v_result, apply_reason = v_reason,
      applied_by = (select auth.uid()), applied_at = now(), row_version = x.row_version + 1, updated_at = now()
  where x.id = b.id;
  perform authz.write_audit('import.applied', b.legal_entity_id, b.branch_id, 'import_batch', b.id, v_reason,
    jsonb_build_object('kind', b.kind) || (v_result - 'batchId' - 'status'));
  return v_result;
end;
$$;

-- public.import_batch_stage(uuid, text, uuid, text, text, jsonb, uuid, boolean): from 20261205000530_rate_sheet_import.sql
create or replace function public.import_batch_stage(p_legal_entity_id uuid, p_kind text, p_branch_id uuid, p_file_name text,
  p_sha256 text, p_rows jsonb, p_request_id uuid, p_entity_wide boolean default false) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_existing public.import_batches%rowtype;
  v_name text := btrim(left(btrim(regexp_replace(coalesce(p_file_name, ''), '[^A-Za-z0-9._ -]', '_', 'g')), 120));
  v_sha text := lower(btrim(coalesce(p_sha256, '')));
  v_id uuid := gen_random_uuid();
  v_n integer;
begin
  -- Accounts phase 2 (20261204000120): 'supplier'.
  -- Accounts phase 3 (20261205000530): 'rate_sheet'.
  if p_kind is null or p_kind not in ('hotel', 'customer', 'supplier', 'rate_sheet') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'kind';
  end if;
  if p_legal_entity_id is null or not authz.vn_import_role(p_legal_entity_id, p_kind) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  -- Accounts phase 3 (20261205000530): rate sheets need the rate contracts switch.
  if p_kind = 'rate_sheet' then
    perform authz.rc_require_on();
  end if;
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  select * into v_existing from public.import_batches b
  where b.legal_entity_id = p_legal_entity_id and b.request_id = p_request_id;
  if v_existing.id is not null then
    if v_existing.uploaded_by is distinct from (select auth.uid()) or v_existing.kind <> p_kind
       or v_existing.source_sha256 <> v_sha or v_existing.branch_id is distinct from p_branch_id
       -- Accounts phase 3 (20261205000530): a rate sheet is always for the whole entity (the flag is ignored).
       or v_existing.entity_wide <> (case when p_kind = 'rate_sheet' then false else coalesce(p_entity_wide, false) end) then
      raise exception 'request_conflict' using errcode = 'PT409';
    end if;
    return jsonb_build_object('batchId', v_existing.id, 'rowCount', v_existing.row_count, 'outcome', 'existing');
  end if;
  if v_name = '' or v_name ~ '^[. ]+$' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fileName';
  end if;
  if v_sha !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'sha256';
  end if;
  if p_kind in ('hotel', 'supplier', 'rate_sheet') and p_branch_id is not null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'branchId';
  end if;
  -- Echo-A M1: customers need a branch, or the explicit whole-company choice (never both).
  if p_kind = 'customer' and p_branch_id is null and coalesce(p_entity_wide, false) is false then
    raise exception 'invalid_input' using errcode = '22023', hint = 'branchId';
  end if;
  -- Accounts phase 3 (20261205000530): rate sheets ignore the flag (always the whole entity).
  if coalesce(p_entity_wide, false) and ((p_kind <> 'customer' and p_kind <> 'rate_sheet') or p_branch_id is not null) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'entityWide';
  end if;
  if p_branch_id is not null and not exists (
       select 1 from public.branches b where b.id = p_branch_id and b.legal_entity_id = p_legal_entity_id) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'branchId';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'rows';
  end if;
  v_n := jsonb_array_length(p_rows);
  if v_n > 5000 then
    raise exception 'import_too_large' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_rows) e
             where jsonb_typeof(e) <> 'object'
                or (select count(*) from jsonb_object_keys(e)) > 40
                or exists (select 1 from jsonb_each(e) f
                           where f.key !~ '^[A-Za-z][A-Za-z0-9]{0,39}$'
                              or (jsonb_typeof(f.value) = 'string' and char_length(f.value #>> '{}') > 1000))) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'rows';
  end if;
  insert into public.import_batches (id, legal_entity_id, kind, branch_id, entity_wide, request_id, source_file_name,
    source_sha256, row_count, uploaded_by)
  values (v_id, p_legal_entity_id, p_kind, p_branch_id, p_kind = 'customer' and coalesce(p_entity_wide, false), p_request_id,
    v_name, v_sha, v_n, (select auth.uid()));
  insert into public.import_rows (batch_id, row_no, legal_entity_id, data)
  select v_id, e.ordinality::integer, p_legal_entity_id,
    -- Accounts phase 2 (20261204000140, L7): a supplier row never stores a full
    -- account number: XXXX<last4> only (the full number comes again with Import).
    case when p_kind = 'supplier' and jsonb_typeof(e.value -> 'accountNumber') = 'string'
              and btrim(e.value ->> 'accountNumber') <> ''
         then authz.vn_supplier_stage_account(e.value)
         else e.value - 'accountNumberHash' end
  from jsonb_array_elements(p_rows) with ordinality e;
  -- Counts and the file hash only (never a file name or a value).
  perform authz.write_audit('import.staged', p_legal_entity_id, p_branch_id, 'import_batch', v_id, null,
    jsonb_build_object('kind', p_kind, 'rows', v_n, 'sha256', v_sha, 'entityWide', p_kind = 'customer' and coalesce(p_entity_wide, false)));
  return jsonb_build_object('batchId', v_id, 'rowCount', v_n, 'outcome', 'created');
end;
$$;

-- public.integration_apply_sync_settings(uuid, text): from 20261125000100_settings_preview_audit.sql
create or replace function public.integration_apply_sync_settings(p_preview_id uuid, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_cfg public.integration_intake_config%rowtype;
  v_cutoff timestamptz;
  v_changed boolean;
  v_requeued integer := 0;
  v_removed integer := 0;
  v_restored integer := 0;
  v_ids uuid[];
  v_job uuid;
  r record;
  -- Stage 6: intake mode changes (review M1).
  v_lead_mode text;
  v_deal_mode text;
  v_scope_requeued_leads integer := 0;
  v_scope_requeued_deals integer := 0;
  v_scope_requeue_cap constant integer := 5000;
  -- Batch 4
  v_reason text;
  v_p public.integration_sync_previews%rowtype;
  v_timeout text;
  v_prev text[];
  v_counts jsonb;
  v_hide_before uuid[];
  v_hide_pipeline uuid[];
  v_hide_stage uuid[];
  v_back uuid[];
  v_category_ids bigint[];
  v_stage_ids text[];
  v_locked uuid[];     -- Echo-A L2
  v_unlocked boolean;  -- Echo-A L2
begin
  v_cfg := authz.sync_settings_manager();
  v_reason := authz.settings_change_reason(p_reason);
  if p_preview_id is null then
    raise exception 'preview_required' using errcode = '55000';
  end if;
  -- Wait at most 5 s for the configuration row only (settings_busy).
  v_timeout := current_setting('lock_timeout');
  begin
    perform set_config('lock_timeout', '5s', true);
    select * into v_cfg from public.integration_intake_config c where c.id = v_cfg.id for update;
    perform set_config('lock_timeout', v_timeout, true);
  exception when lock_not_available then
    raise exception 'settings_busy' using errcode = '55P03';
  end;
  select * into v_p from public.integration_sync_previews p where p.id = p_preview_id for update;
  if v_p.id is null or v_p.actor_user_id is distinct from (select auth.uid()) or v_p.config_id <> v_cfg.id then
    raise exception 'preview_required' using errcode = '55000';
  end if;
  if v_p.used_at is not null then
    raise exception 'preview_used' using errcode = '55000';
  end if;
  if v_p.expires_at <= now() then
    raise exception 'preview_stale' using errcode = 'PT409', hint = 'expired';
  end if;
  if authz.sync_scope_snapshot(v_cfg) is distinct from v_p.config_snapshot then
    raise exception 'preview_stale' using errcode = 'PT409', hint = 'settings_changed';
  end if;
  v_category_ids := v_p.category_ids;
  v_stage_ids := v_p.stage_ids;
  v_cutoff := v_p.cutoff_at;

  -- B1.1d: while Won-only intake is on, every entry stage's pipeline stays
  -- ticked (unticking it would stop new Deals silently).
  if v_cfg.deal_entry_stage_ids is not null and exists (
       select 1 from unnest(v_cfg.deal_entry_stage_ids) s
       where not (authz.bitrix_stage_category(s) = any (v_category_ids))) then
    raise exception 'entry_stage_pipeline_required' using errcode = '22023';
  end if;
  -- Stage 6
  v_lead_mode := coalesce(v_p.lead_intake_mode, v_cfg.lead_intake_mode);
  v_deal_mode := coalesce(v_p.deal_intake_mode, v_cfg.deal_intake_mode);
  v_changed := authz.sync_scope_changed(v_cfg, v_category_ids, v_stage_ids, v_cutoff, v_p.lead_intake_mode,
                                        v_p.deal_intake_mode);

  -- Batch 4: the exact Deal sets the preview showed. Echo-A L2: lock the
  -- planned Deals first (configuration row -> Deals in id order, as the old
  -- command), then read the plan again under those locks. Echo-A L1: its
  -- counts AND its identity (which Deals, which action and reason) must equal
  -- the preview; every planned Deal must be one this call holds locked.
  select array_agg(x.id) into v_locked from (
    select d.id from public.deals d
    where d.id = any (array(select p.deal_id
                            from authz.sync_scope_plan(v_cfg, v_category_ids, v_stage_ids, v_cutoff, v_changed) p))
    order by d.id
    for update of d
  ) x;
  v_counts := authz.sync_scope_counts(v_cfg, v_category_ids, v_stage_ids, v_cutoff, v_changed);
  if v_counts is distinct from v_p.counts
     or authz.sync_scope_hash(v_cfg, v_category_ids, v_stage_ids, v_cutoff, v_changed) is distinct from v_p.plan_hash then
    raise exception 'preview_stale' using errcode = 'PT409', hint = 'counts_changed';
  end if;
  select array_agg(p.deal_id order by p.deal_id) filter (where p.action = 'hide' and p.reason = 'before_sync_date'),
         array_agg(p.deal_id order by p.deal_id) filter (where p.action = 'hide' and p.reason = 'pipeline_not_eligible'),
         array_agg(p.deal_id order by p.deal_id) filter (where p.action = 'hide' and p.reason = 'stage_not_eligible'),
         array_agg(p.deal_id order by p.deal_id) filter (where p.action = 'bring_back'),
         bool_or(not (p.deal_id = any (coalesce(v_locked, '{}'::uuid[]))))
  into v_hide_before, v_hide_pipeline, v_hide_stage, v_back, v_unlocked
  from authz.sync_scope_plan(v_cfg, v_category_ids, v_stage_ids, v_cutoff, v_changed) p;
  if coalesce(v_unlocked, false) then
    raise exception 'preview_stale' using errcode = 'PT409', hint = 'counts_changed';
  end if;

  v_prev := authz.settings_begin_change('integration_apply_sync_settings', v_reason);  -- Batch 4
  update public.integration_intake_config c
  set eligible_category_ids = v_category_ids, category_id = v_category_ids[1],
      eligible_stage_ids = v_stage_ids, cutoff_at = v_cutoff,
      -- Stage 6
      lead_intake_mode = coalesce(v_p.lead_intake_mode, c.lead_intake_mode),
      deal_intake_mode = coalesce(v_p.deal_intake_mode, c.deal_intake_mode),
      -- Lead watermark: a new scope pass or a new sync date lists from the start.
      lead_reconciled_at = case
        when (v_lead_mode = 'scope' and c.lead_intake_mode is distinct from 'scope')
             or c.cutoff_at is distinct from v_cutoff then null
        else c.lead_reconciled_at end,
      updated_at = now(), updated_by = auth.uid()
  where c.id = v_cfg.id;
  perform authz.settings_end_change(v_prev);  -- Batch 4

  if v_changed then
    -- Remove stored deals that no longer belong (Batch 4: exactly the previewed sets).
    if v_hide_pipeline is not null then
      v_removed := v_removed + authz.remove_bitrix_deals(v_hide_pipeline, 'pipeline_not_eligible');
    end if;
    if v_hide_before is not null then
      v_removed := v_removed + authz.remove_bitrix_deals(v_hide_before, 'before_sync_date');
    end if;
    if v_hide_stage is not null then
      v_removed := v_removed + authz.remove_bitrix_deals(v_hide_stage, 'stage_not_eligible');
    end if;
    if v_removed <> (v_p.counts -> 'hide' ->> 'total')::integer then
      raise exception 'preview_stale' using errcode = 'PT409', hint = 'counts_changed';
    end if;

    -- Restore removed deals that belong again: owner mapping re-applied,
    -- then a fresh crm.deal.get (inbox row) confirms the current state.
    -- Batch 4: exactly the previewed set, each still matching.
    if v_back is not null then
      with restored as (
        update public.deals d set removed_at = null, removed_reason = null
        where d.id = any (v_back) and d.removed_at is not null
          and d.source_category_id = any (v_category_ids) and d.source_created_at >= v_cutoff
          and (d.source_stage_id = any (coalesce(v_cfg.deal_entry_stage_ids, v_stage_ids))
               or (v_cfg.deal_entry_stage_ids is null and d.removed_reason = 'outside_entry_stage'))
        returning d.id
      )
      select array_agg(x.id) into v_ids from restored x;
      if coalesce(cardinality(v_ids), 0) <> cardinality(v_back) then
        raise exception 'preview_stale' using errcode = 'PT409', hint = 'counts_changed';
      end if;
    end if;
    if v_ids is not null then
      for r in select d.id, d.source_assigned_by_id, d.source_deal_id from public.deals d where d.id = any (v_ids) loop
        perform authz.set_deal_owner(r.id,
          authz.bitrix_owner_for(v_cfg.portal_member_id, v_cfg.pilot_legal_entity_id, r.source_assigned_by_id));
        insert into public.integration_inbox (portal_member_id, event_type, source_deal_id, source_ts, dedupe_key, origin)
        select v_cfg.portal_member_id, 'RECONCILE', r.source_deal_id, extract(epoch from now())::bigint,
          authz.intake_dedupe_key(v_cfg.portal_member_id, 'RESTORE:' || gen_random_uuid()::text, r.source_deal_id, 0),
          'manual_retry'
        where not exists (select 1 from public.integration_inbox i
                          where i.portal_member_id = v_cfg.portal_member_id and i.source_deal_id = r.source_deal_id
                            and i.status in ('pending', 'processing', 'failed'));
      end loop;
      v_restored := cardinality(v_ids);
      perform authz.touch_deal_list(v_cfg.pilot_legal_entity_id, 0, v_restored);
    end if;

    -- Deals skipped before are evaluated again.
    update public.integration_inbox i
    set status = 'pending', attempts = 0, next_attempt_at = now(), reason_code = null,
        origin = 'manual_retry', updated_at = now()
    where i.portal_member_id = v_cfg.portal_member_id and i.status = 'ignored'
      and i.reason_code in ('not_eligible_category', 'not_eligible_stage', 'before_cutoff');
    get diagnostics v_requeued = row_count;

    -- Stage 6 (review M1): switching an object type to scope evaluates again
    -- the events refused as not_in_manifest that were recorded on/after the
    -- sync date: the newest row per Bitrix record, none already queued, at
    -- most v_scope_requeue_cap records per object type.
    if v_lead_mode = 'scope' and v_cfg.lead_intake_mode is distinct from 'scope' then
      with picked as (
        select distinct on (i.source_deal_id) i.id
        from public.integration_inbox i
        where i.portal_member_id = v_cfg.portal_member_id and i.source_object = 'lead'
          and i.status = 'ignored' and i.reason_code = 'not_in_manifest' and i.received_at >= v_cutoff
          and not exists (select 1 from public.integration_inbox q
                          where q.portal_member_id = i.portal_member_id and q.source_object = 'lead'
                            and q.source_deal_id = i.source_deal_id and q.status in ('pending', 'processing', 'failed'))
        order by i.source_deal_id, i.received_at desc, i.id
        limit v_scope_requeue_cap
      )
      update public.integration_inbox i
      set status = 'pending', attempts = 0, next_attempt_at = now(), reason_code = null,
          origin = 'manual_retry', updated_at = now()
      from picked where i.id = picked.id;
      get diagnostics v_scope_requeued_leads = row_count;
    end if;
    if v_deal_mode = 'scope' and v_cfg.deal_intake_mode is distinct from 'scope' then
      with picked as (
        select distinct on (i.source_deal_id) i.id
        from public.integration_inbox i
        where i.portal_member_id = v_cfg.portal_member_id and i.source_object = 'deal'
          and i.status = 'ignored' and i.reason_code = 'not_in_manifest' and i.received_at >= v_cutoff
          and not exists (select 1 from public.integration_inbox q
                          where q.portal_member_id = i.portal_member_id and q.source_object = 'deal'
                            and q.source_deal_id = i.source_deal_id and q.status in ('pending', 'processing', 'failed'))
        order by i.source_deal_id, i.received_at desc, i.id
        limit v_scope_requeue_cap
      )
      update public.integration_inbox i
      set status = 'pending', attempts = 0, next_attempt_at = now(), reason_code = null,
          origin = 'manual_retry', updated_at = now()
      from picked where i.id = picked.id;
      get diagnostics v_scope_requeued_deals = row_count;
    end if;

    -- Full resync with the new filter (the 30 s scheduler runs it to the end).
    update public.integration_resync_jobs j set status = 'superseded', lock_token = null, locked_until = null
    where j.portal_member_id = v_cfg.portal_member_id and j.status in ('queued', 'running');
    v_job := authz.queue_resync(v_cfg.portal_member_id, 'settings_changed', auth.uid());
  end if;

  update public.integration_sync_schedule s set enabled = v_p.sync_enabled, updated_at = now() where s.id;
  update public.integration_sync_previews p set used_at = now() where p.id = v_p.id;  -- Batch 4

  perform authz.write_audit('integration.settings_updated', v_cfg.pilot_legal_entity_id, null,
    'integration_intake_config', v_cfg.id, v_reason,  -- Batch 4: reason
    jsonb_build_object('categoryIds', v_category_ids, 'stageCount', cardinality(v_stage_ids),
      'cutoffAt', v_cutoff, 'previousCutoffAt', v_cfg.cutoff_at, 'syncEnabled', v_p.sync_enabled,
      'requeued', v_requeued, 'removed', v_removed, 'restored', v_restored, 'resyncJobId', v_job,
      -- Stage 6
      'leadIntakeMode', coalesce(v_p.lead_intake_mode, v_cfg.lead_intake_mode),
      'previousLeadIntakeMode', v_cfg.lead_intake_mode,
      'dealIntakeMode', coalesce(v_p.deal_intake_mode, v_cfg.deal_intake_mode),
      'previousDealIntakeMode', v_cfg.deal_intake_mode,
      'scopeRequeuedLeads', v_scope_requeued_leads, 'scopeRequeuedDeals', v_scope_requeued_deals,
      -- Batch 4
      'previewId', v_p.id, 'hiddenByReason', v_p.counts -> 'hide', 'previousSyncEnabled', v_p.config_snapshot -> 'autoSync'));
  return jsonb_build_object('requeued', v_requeued, 'removed', v_removed, 'restored', v_restored,
    'resyncQueued', v_job is not null, 'cutoffAt', v_cutoff,
    -- Stage 6
    'leadIntakeMode', coalesce(v_p.lead_intake_mode, v_cfg.lead_intake_mode),
    'dealIntakeMode', coalesce(v_p.deal_intake_mode, v_cfg.deal_intake_mode),
    'scopeRequeuedLeads', v_scope_requeued_leads, 'scopeRequeuedDeals', v_scope_requeued_deals,
    -- Batch 4
    'previewId', v_p.id, 'hidden', v_p.counts -> 'hide', 'broughtBack', v_restored);
end;
$$;

-- public.itinerary_create_standalone(uuid, jsonb, text, uuid): from 20261123000100_referral_drafts.sql
create or replace function public.itinerary_create_standalone(p_branch_id uuid, p_customer jsonb, p_title text, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_start record;
  v_res jsonb;
  v_doc public.itinerary_documents%rowtype;
begin
  select * into v_start from authz.referral_draft_start(p_branch_id, p_customer, p_title, p_request_id, 'itinerary');
  if not v_start.o_created then
    select * into v_doc from public.itinerary_documents d
    where d.referral_draft_id = (v_start.o_draft).id and d.created_by = (select auth.uid()) and d.request_id = p_request_id;
    if v_doc.id is null or v_doc.title is distinct from btrim(coalesce(p_title, ''), E' \t\r\n') then
      raise exception 'request_conflict' using errcode = 'PT409';
    end if;
    return jsonb_build_object('referralDraftId', (v_start.o_draft).id, 'referralReference', (v_start.o_draft).reference,
      'documentId', v_doc.id, 'draftId', (select f.id from public.itinerary_fact_drafts f where f.document_id = v_doc.id),
      'rowVersion', (select f.row_version from public.itinerary_fact_drafts f where f.document_id = v_doc.id),
      'created', false, 'possibleDuplicates', authz.referral_duplicates((v_start.o_draft).id));
  end if;
  v_res := public.itinerary_document_create('referral', (v_start.o_draft).id, p_title, p_request_id);
  return jsonb_build_object('referralDraftId', (v_start.o_draft).id, 'referralReference', (v_start.o_draft).reference,
    'documentId', v_res -> 'documentId', 'draftId', v_res -> 'draftId', 'rowVersion', v_res -> 'rowVersion', 'created', true,
    'possibleDuplicates', authz.referral_duplicates((v_start.o_draft).id));
end;
$$;

-- public.itinerary_differences_save(uuid, integer, text, uuid, text, jsonb): from 20261120000500_b12_itineraries.sql
create or replace function public.itinerary_differences_save(p_draft_id uuid, p_expected_row_version integer, p_basis_kind text,
  p_basis_id uuid, p_basis_hash text, p_differences jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_draft public.itinerary_fact_drafts%rowtype;
  v_basis jsonb;
  v_run public.itinerary_difference_runs%rowtype;
  v_previous uuid;
  v_row jsonb;
  v_n integer := 0;
  v_seen text[] := '{}'::text[];
  v_open integer;
begin
  perform authz.lock_itinerary_document((select f.document_id from public.itinerary_fact_drafts f where f.id = p_draft_id));
  select * into v_draft from public.itinerary_fact_drafts f where f.id = p_draft_id for update;
  perform authz.require_row_version(p_expected_row_version, v_draft.row_version);
  v_basis := authz.itinerary_basis(v_draft.document_id);
  if p_basis_kind is distinct from (v_basis ->> 'kind') or p_basis_id is distinct from (v_basis ->> 'id')::uuid
     or p_basis_hash is distinct from (v_basis ->> 'hash') then
    raise exception 'basis_changed' using errcode = 'PT409';
  end if;
  if p_differences is null or jsonb_typeof(p_differences) <> 'array' or jsonb_array_length(p_differences) > 500 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'differences';
  end if;
  for v_row in select e from jsonb_array_elements(p_differences) e loop
    v_n := v_n + 1;
    if jsonb_typeof(v_row) <> 'object'
       or exists (select 1 from jsonb_object_keys(v_row) k where k not in ('path', 'kind', 'factsValueHash', 'basisValueHash'))
       or (v_row ? 'factsValueHash' and jsonb_typeof(v_row -> 'factsValueHash') <> 'null'
           and coalesce(v_row ->> 'factsValueHash', '') !~ '^[0-9a-f]{32,64}$')
       or (v_row ? 'basisValueHash' and jsonb_typeof(v_row -> 'basisValueHash') <> 'null'
           and coalesce(v_row ->> 'basisValueHash', '') !~ '^[0-9a-f]{32,64}$')
       or jsonb_typeof(v_row -> 'path') is distinct from 'string'
       or (v_row ->> 'path') !~ '^[A-Za-z][A-Za-z0-9_.\[\]-]{0,119}$'
       or (v_row ->> 'kind') is null or (v_row ->> 'kind') not in ('missing', 'different', 'extra')
       or ((v_row ->> 'path') || '|' || (v_row ->> 'kind')) = any (v_seen) then
      raise exception 'invalid_input' using errcode = '22023', hint = 'differences[' || v_n::text || ']';
    end if;
    v_seen := v_seen || ((v_row ->> 'path') || '|' || (v_row ->> 'kind'));
  end loop;

  select * into v_run from public.itinerary_difference_runs r
  where r.draft_id = v_draft.id and r.facts_hash = v_draft.facts_hash and r.basis_hash = p_basis_hash;
  if v_run.id is not null then
    if (select coalesce(array_agg(d.field_path || '|' || d.difference order by 1), '{}'::text[])
        from public.itinerary_fact_differences d where d.run_id = v_run.id)
       is distinct from (select coalesce(array_agg(s order by s), '{}'::text[]) from unnest(v_seen) s) then
      raise exception 'request_conflict' using errcode = 'PT409';
    end if;
    select count(*) into v_open from public.itinerary_fact_differences d where d.run_id = v_run.id and d.acknowledged_at is null;
    return jsonb_build_object('runId', v_run.id, 'differenceCount', v_run.difference_count, 'openCount', v_open, 'outcome', 'existing');
  end if;

  -- The latest earlier run against the same basis (its acknowledgements carry over).
  select r.id into v_previous from public.itinerary_difference_runs r
  where r.draft_id = v_draft.id and r.basis_hash = p_basis_hash order by r.created_at desc, r.id desc limit 1;
  insert into public.itinerary_difference_runs (draft_id, legal_entity_id, facts_hash, basis_kind, basis_id, basis_hash,
    difference_count, created_by)
  values (v_draft.id, v_draft.legal_entity_id, v_draft.facts_hash, p_basis_kind, p_basis_id, p_basis_hash, v_n, (select auth.uid()))
  returning * into v_run;
  -- Review E3-9: an acknowledgement carries over only when both sides' value hashes are given and unchanged.
  insert into public.itinerary_fact_differences (run_id, legal_entity_id, field_path, difference, facts_value_hash, basis_value_hash,
    acknowledged_by, acknowledged_at, note)
  select v_run.id, v_draft.legal_entity_id, e ->> 'path', e ->> 'kind', e ->> 'factsValueHash', e ->> 'basisValueHash',
    p.acknowledged_by, p.acknowledged_at, p.note
  from jsonb_array_elements(p_differences) e
  left join public.itinerary_fact_differences p
    on p.run_id = v_previous and p.field_path = e ->> 'path' and p.difference = e ->> 'kind'
   and p.facts_value_hash is not null and p.basis_value_hash is not null
   and p.facts_value_hash = e ->> 'factsValueHash' and p.basis_value_hash = e ->> 'basisValueHash';
  select count(*) into v_open from public.itinerary_fact_differences d where d.run_id = v_run.id and d.acknowledged_at is null;
  perform authz.itinerary_audit('itinerary.differences_saved', v_draft.document_id, 'itinerary_document', v_draft.document_id,
    jsonb_build_object('runId', v_run.id, 'count', v_n, 'open', v_open, 'basisKind', p_basis_kind));
  return jsonb_build_object('runId', v_run.id, 'differenceCount', v_n, 'openCount', v_open, 'outcome', 'created');
end;
$$;

-- public.itinerary_document_create(text, uuid, text, uuid): from 20261123000100_referral_drafts.sql
create or replace function public.itinerary_document_create(p_subject_kind text, p_subject_id uuid, p_title text, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_title text := btrim(coalesce(p_title, ''), E' \t\r\n');
  v_entity uuid;
  v_branch uuid;
  v_doc public.itinerary_documents%rowtype;
  v_draft public.itinerary_fact_drafts%rowtype;
  v_rd public.referral_drafts%rowtype;  -- Batch 3
begin
  if p_subject_kind is null or p_subject_kind not in ('quotation', 'deal', 'referral') or p_subject_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'subjectKind';
  end if;
  if p_subject_kind = 'deal' then
    perform authz.refuse_removed_deal(p_subject_id);
    if not authz.can_edit_booking_draft(p_subject_id) then
      raise exception 'not_authorized' using errcode = '42501';
    end if;
    select d.legal_entity_id, d.branch_id into v_entity, v_branch from public.deals d where d.id = p_subject_id;
  elsif p_subject_kind = 'referral' then
    -- Batch 3: authorization first, then the draft row (draft_closed).
    if not authz.referral_draft_can_edit(p_subject_id) then
      raise exception 'not_authorized' using errcode = '42501';
    end if;
    v_rd := authz.referral_draft_lock_write(p_subject_id);
    v_entity := v_rd.legal_entity_id;
    v_branch := v_rd.branch_id;
  else
    perform authz.refuse_removed_deal(authz.quotation_deal(p_subject_id));
    if not authz.quotation_can_edit(p_subject_id) then
      raise exception 'not_authorized' using errcode = '42501';
    end if;
    select q.legal_entity_id, q.branch_id into v_entity, v_branch from public.quotations q where q.id = p_subject_id;
    -- Batch 3: a referral quotation's draft is locked (draft_closed).
    if (select q.referral_draft_id from public.quotations q where q.id = p_subject_id) is not null then
      perform authz.referral_draft_lock_write((select q.referral_draft_id from public.quotations q where q.id = p_subject_id));
    end if;
  end if;
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  if length(v_title) not between 1 and 200 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'title';
  end if;
  select * into v_doc from public.itinerary_documents d where d.created_by = (select auth.uid()) and d.request_id = p_request_id;
  if v_doc.id is not null then
    if v_doc.title is distinct from v_title or coalesce(v_doc.quotation_id, v_doc.deal_id, v_doc.referral_draft_id) is distinct from p_subject_id then
      raise exception 'request_conflict' using errcode = 'PT409';
    end if;
    select * into v_draft from public.itinerary_fact_drafts f where f.document_id = v_doc.id;
    return jsonb_build_object('documentId', v_doc.id, 'draftId', v_draft.id, 'rowVersion', v_draft.row_version, 'created', false);
  end if;
  insert into public.itinerary_documents (legal_entity_id, branch_id, quotation_id, deal_id, referral_draft_id, title, request_id,
    created_by)
  values (v_entity, v_branch, case when p_subject_kind = 'quotation' then p_subject_id end,
    case when p_subject_kind = 'deal' then p_subject_id end,
    case when p_subject_kind = 'referral' then p_subject_id end,  -- Batch 3
    v_title, p_request_id, (select auth.uid()))
  returning * into v_doc;
  insert into public.itinerary_fact_drafts (document_id, legal_entity_id, facts, facts_hash, created_by, updated_by)
  values (v_doc.id, v_entity, '{}'::jsonb, authz.itinerary_facts_hash('{}'::jsonb), (select auth.uid()), (select auth.uid()))
  returning * into v_draft;
  perform authz.itinerary_audit('itinerary.document_created', v_doc.id, 'itinerary_document', v_doc.id,
    jsonb_build_object('subjectKind', p_subject_kind, 'subjectId', p_subject_id));
  return jsonb_build_object('documentId', v_doc.id, 'draftId', v_draft.id, 'rowVersion', v_draft.row_version, 'created', true);
end;
$$;

-- public.itinerary_render_complete(uuid, text, boolean, text, jsonb): from 20261120000500_b12_itineraries.sql
create or replace function public.itinerary_render_complete(p_job_id uuid, p_worker text, p_ok boolean, p_error_code text, p_file jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_job public.itinerary_render_jobs%rowtype;
  v_path text;
  v_size bigint;
  v_qa jsonb;
  v_blocked boolean;
  v_rendered uuid;
  v_code text := p_error_code;
begin
  select * into v_job from public.itinerary_render_jobs j where j.id = p_job_id for update;
  if v_job.id is null or v_job.status <> 'running' or v_job.lease_owner is distinct from p_worker then
    raise exception 'task_conflict' using errcode = 'PT409';
  end if;
  if p_ok is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'ok';
  end if;
  if p_ok and authz.itinerary_fail_changed_final(v_job) then
    return jsonb_build_object('jobId', v_job.id, 'status', 'failed', 'renderedId', null, 'errorCode', 'input_changed');
  end if;
  if p_ok then
    v_path := v_job.legal_entity_id::text || '/' || v_job.document_id::text || '/' || v_job.id::text || '.pdf';
    v_qa := p_file -> 'qa';
    if p_file is null or jsonb_typeof(p_file) <> 'object' or (p_file ->> 'objectPath') is distinct from v_path
       or coalesce(p_file ->> 'sha256', '') !~ '^[0-9a-f]{64}$'
       or not authz.sf_int_ok(p_file -> 'sizeBytes', 1, 15728640, true)
       or not authz.sf_int_ok(p_file -> 'pageCount', 1, 200, true)
       or v_qa is null or jsonb_typeof(v_qa) <> 'object'
       or exists (select 1 from jsonb_object_keys(v_qa) k where k not in ('placeholders', 'layoutIssues', 'safetyHits'))
       or not authz.sf_int_ok(v_qa -> 'placeholders', 0, 1000, true)
       or not authz.itin_value_ok(v_qa -> 'layoutIssues', 'texts:60:100') or jsonb_typeof(v_qa -> 'layoutIssues') is distinct from 'array'
       or not authz.itin_value_ok(v_qa -> 'safetyHits', 'texts:60:100') or jsonb_typeof(v_qa -> 'safetyHits') is distinct from 'array'
       or exists (select 1 from jsonb_array_elements_text(v_qa -> 'layoutIssues') c where c !~ '^[a-z_]{1,60}$')
       or exists (select 1 from jsonb_array_elements_text(v_qa -> 'safetyHits') c where c !~ '^[a-z_]{1,60}$') then
      raise exception 'invalid_input' using errcode = '22023', hint = 'file';
    end if;
    v_size := (p_file ->> 'sizeBytes')::bigint;
    if to_regclass('storage.objects') is null or not exists (
         select 1 from storage.objects o
         where o.bucket_id = 'rendered-documents' and o.name = v_path
           and (o.metadata ->> 'size') ~ '^[0-9]{1,18}$' and (o.metadata ->> 'size')::bigint = v_size) then
      p_ok := false;
      v_code := 'upload_failed';
    else
      v_blocked := v_job.kind = 'final' and ((v_qa ->> 'placeholders')::integer > 0
        or jsonb_array_length(v_qa -> 'layoutIssues') > 0 or jsonb_array_length(v_qa -> 'safetyHits') > 0);
      if v_blocked then
        update public.itinerary_render_jobs j
        set status = 'failed', last_error_code = 'qa_blocked', lease_owner = null, lease_until = null, finished_at = now()
        where j.id = v_job.id;
        perform authz.itinerary_audit('itinerary.render_failed', v_job.document_id, 'itinerary_render_job', v_job.id,
          jsonb_build_object('jobId', v_job.id, 'errorCode', 'qa_blocked'));
        return jsonb_build_object('jobId', v_job.id, 'status', 'failed', 'renderedId', null, 'errorCode', 'qa_blocked');
      end if;
      insert into public.itinerary_rendered_documents (render_job_id, document_id, legal_entity_id, kind, object_path, sha256,
        size_bytes, page_count, qa)
      values (v_job.id, v_job.document_id, v_job.legal_entity_id, v_job.kind, v_path, p_file ->> 'sha256', v_size::integer,
        (p_file ->> 'pageCount')::integer, v_qa)
      returning id into v_rendered;
      update public.itinerary_render_jobs j
      set status = 'succeeded', lease_owner = null, lease_until = null, finished_at = now(), last_error_code = null
      where j.id = v_job.id;
      perform authz.itinerary_audit('itinerary.render_succeeded', v_job.document_id, 'itinerary_render_job', v_job.id,
        jsonb_build_object('jobId', v_job.id, 'renderedId', v_rendered, 'kind', v_job.kind));
      return jsonb_build_object('jobId', v_job.id, 'status', 'succeeded', 'renderedId', v_rendered);
    end if;
  end if;
  if v_code is null or v_code not in ('render_timeout', 'browser_failed', 'asset_missing', 'input_invalid', 'upload_failed',
                                      'internal', 'content_safety', 'layout_overflow', 'placeholders_present', 'text_clipped',
                                      'qa_blocked') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'errorCode';
  end if;
  -- Deterministic failures (the same input fails the same way) end the job at
  -- once; transient ones (upload_failed, internal, render_timeout, browser_failed)
  -- go back to the queue while attempts remain.
  if v_job.attempts < v_job.max_attempts
     and v_code not in ('placeholders_present', 'content_safety', 'input_invalid', 'layout_overflow', 'text_clipped',
                        'qa_blocked', 'asset_missing') then
    update public.itinerary_render_jobs j
    set status = 'queued', last_error_code = v_code, lease_owner = null, lease_until = null,
        available_at = now() + make_interval(secs => 30 * v_job.attempts)
    where j.id = v_job.id;
  else
    update public.itinerary_render_jobs j
    set status = 'failed', last_error_code = v_code, lease_owner = null, lease_until = null, finished_at = now()
    where j.id = v_job.id;
  end if;
  perform authz.itinerary_audit('itinerary.render_failed', v_job.document_id, 'itinerary_render_job', v_job.id,
    jsonb_build_object('jobId', v_job.id, 'errorCode', v_code, 'attempt', v_job.attempts,
      'final', (select j.status from public.itinerary_render_jobs j where j.id = v_job.id) = 'failed'));
  return jsonb_build_object('jobId', v_job.id,
    'status', (select j.status from public.itinerary_render_jobs j where j.id = v_job.id),
    'renderedId', null, 'errorCode', v_code);
end;
$$;

-- public.itinerary_render_input(uuid, text): from 20261120000800_b12_document_branch_code.sql
create or replace function public.itinerary_render_input(p_job_id uuid, p_worker text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_job public.itinerary_render_jobs;
  v_draft public.itinerary_fact_drafts;
  v_basis jsonb;
begin
  select * into v_job from public.itinerary_render_jobs j where j.id = p_job_id for update;
  if v_job.id is null or v_job.status <> 'running' or v_job.lease_owner is distinct from p_worker or v_job.lease_until < now() then
    raise exception 'task_conflict' using errcode = 'PT409';
  end if;
  if authz.itinerary_fail_changed_final(v_job) then
    return jsonb_build_object('jobId', v_job.id, 'status', 'failed', 'errorCode', 'input_changed');
  end if;
  select * into v_draft from public.itinerary_fact_drafts f where f.document_id = v_job.document_id;
  v_basis := authz.itinerary_basis(v_job.document_id);
  return jsonb_build_object('jobId', v_job.id, 'status', 'running', 'documentId', v_job.document_id, 'kind', v_job.kind,
    'templateVersion', v_job.template_version, 'inputHash', v_job.input_hash,
    'factsHash', v_draft.facts_hash, 'factsChanged', v_draft.facts_hash <> v_job.facts_hash,
    'basisChanged', (v_basis ->> 'hash') <> v_job.basis_hash,
    'facts', v_draft.facts,
    'title', (select d.title from public.itinerary_documents d where d.id = v_job.document_id),
    -- B1.2 0800 (DEC-50): same source as itinerary_document_get subject.branchCode.
    'branchCode', (select b.code from public.itinerary_documents d join public.branches b on b.id = d.branch_id
                   where d.id = v_job.document_id),
    'basis', v_basis,
    -- DEC-48: customer prices only when the requester could read them.
    'money', case when v_job.include_money then authz.itinerary_money_json(v_basis) end);
end;
$$;

-- public.payment_claim_report(uuid, jsonb, uuid): from 20261119000200_b11_payment_claims.sql
create or replace function public.payment_claim_report(p_deal_id uuid, p_fields jsonb, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_deal public.deals%rowtype;
  v_payload jsonb := jsonb_build_object('dealId', p_deal_id, 'fields', p_fields);
  v_result jsonb;
  v_issue text;
  v_today date := authz.finance_today();
  v_policy public.finance_policy_versions%rowtype;
  v_mode text;
  v_amount_text text;
  v_amount bigint;
  v_paid date;
  v_payer text;
  v_reference text;
  v_norm text;
  v_cheque_no text;
  v_cheque_date date;
  v_dest_version uuid;
  v_dv public.company_destination_versions%rowtype;
  v_dest public.company_destinations%rowtype;
  v_note text;
  v_version uuid;
  v_total bigint;
  v_id uuid := gen_random_uuid();
  v_constraint text;
begin
  perform authz.refuse_removed_deal(p_deal_id);
  if p_deal_id is null or not authz.finance_claim_sales_ok(p_deal_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_deal from public.deals d where d.id = p_deal_id;
  v_issue := authz.finance_gate_issue(v_deal.legal_entity_id, v_deal.is_synthetic);
  if v_issue is not null then
    raise exception '%', v_issue using errcode = '55000';
  end if;
  if not authz.service_items_enabled() then
    raise exception 'service_items_disabled' using errcode = '55000';
  end if;
  if authz.deal_not_active(v_deal.id) then
    raise exception 'deal_not_active' using errcode = '55000';
  end if;
  if p_request_id is null then
    perform authz.finance_invalid();
  end if;
  perform authz.finance_lock_deal(v_deal.id);
  v_result := authz.finance_replay(v_deal.legal_entity_id, p_request_id, 'payment_claim_report', v_payload);
  if v_result is not null then
    return v_result;
  end if;

  if p_fields is null or jsonb_typeof(p_fields) <> 'object'
     or (p_fields - array['mode', 'amountPaise', 'paidOn', 'payerName', 'reference', 'chequeNumber', 'chequeDate',
                          'destinationVersionId', 'note']) <> '{}'::jsonb then
    perform authz.finance_invalid();
  end if;
  v_mode := authz.finance_field(p_fields, 'mode');
  if v_mode is null or v_mode not in ('bank_transfer', 'upi', 'cash', 'cheque') then
    perform authz.finance_invalid();
  end if;
  v_policy := authz.finance_policy_at(v_deal.legal_entity_id, now());
  if v_policy.id is null then
    raise exception 'not_configured' using errcode = '55000';
  end if;
  v_amount_text := authz.finance_field(p_fields, 'amountPaise');
  if v_amount_text is null or v_amount_text !~ '^[1-9][0-9]{0,17}$' then
    perform authz.finance_invalid();
  end if;
  v_amount := v_amount_text::bigint;
  -- A claim no receipt could ever hold is refused.
  if v_amount > v_policy.receipt_max_paise then
    perform authz.finance_invalid();
  end if;
  v_paid := authz.finance_date(authz.finance_field(p_fields, 'paidOn'));
  if v_paid is null or v_paid not between v_today - 365 and v_today then
    perform authz.finance_invalid();
  end if;
  v_payer := authz.finance_text(authz.finance_field(p_fields, 'payerName'), 1, 200, false);
  if v_payer is null then
    perform authz.finance_invalid();
  end if;

  v_reference := authz.finance_text(authz.finance_field(p_fields, 'reference'), 1, 40, false);
  v_dest_version := authz.finance_uuid(authz.finance_field(p_fields, 'destinationVersionId'));
  if v_mode in ('bank_transfer', 'upi') then
    if v_reference is null or v_reference !~ '^[A-Za-z0-9/-]{6,40}$' or v_dest_version is null then
      perform authz.finance_invalid();
    end if;
    v_norm := authz.finance_claim_norm(v_reference);
  elsif v_reference is not null or v_dest_version is not null then
    perform authz.finance_invalid();
  end if;

  v_cheque_no := authz.finance_text(authz.finance_field(p_fields, 'chequeNumber'), 1, 6, false);
  v_cheque_date := authz.finance_date(authz.finance_field(p_fields, 'chequeDate'));
  if v_mode = 'cheque' then
    if v_cheque_no is null or v_cheque_no !~ '^[0-9]{6}$'
       or v_cheque_date is null or v_cheque_date not between v_today - 90 and v_today + 90 then
      perform authz.finance_invalid();
    end if;
  elsif v_cheque_no is not null or v_cheque_date is not null then
    perform authz.finance_invalid();
  end if;
  v_note := authz.finance_text(authz.finance_field(p_fields, 'note'), 1, 500, true);

  -- Company destination: the receipt rule (approved current, not retired, same
  -- entity, kind matching the mode, same synthetic flag), read under a share lock.
  if v_mode in ('bank_transfer', 'upi') then
    select * into v_dv from public.company_destination_versions dv
    where dv.id = v_dest_version and dv.legal_entity_id = v_deal.legal_entity_id;
    if v_dv.id is not null then
      select * into v_dest from public.company_destinations d where d.id = v_dv.destination_id for share;
    end if;
    if v_dv.id is null or v_dest.retired_at is not null or v_dest.current_version_id is distinct from v_dv.id
       or v_dv.status <> 'approved'
       or v_dest.kind <> (case v_mode when 'bank_transfer' then 'bank' else 'upi' end)
       or v_dest.is_synthetic is distinct from v_deal.is_synthetic then
      raise exception 'destination_changed' using errcode = '55000';
    end if;
  end if;

  v_version := authz.finance_claim_version(v_deal.id);
  if v_version is null then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  select c.selling_total_paise into v_total from public.booking_version_commercials c where c.version_id = v_version;
  if v_total is not null and v_amount > v_total then
    raise exception 'claim_over_total' using errcode = '55000';
  end if;

  if exists (
       select 1 from public.customer_payment_claims c
       where c.deal_id = v_deal.id and c.status in ('reported', 'linked')
         and ((v_norm is not null and c.reference_norm = v_norm)
              or (v_mode = 'cheque' and c.mode = 'cheque' and c.cheque_number = v_cheque_no))) then
    raise exception 'duplicate_claim' using errcode = '23505';
  end if;

  begin
    insert into public.customer_payment_claims (id, legal_entity_id, deal_id, booking_version_id, mode, amount_paise,
      paid_on, payer_name, reference, reference_norm, cheque_number, cheque_date, destination_version_id, note,
      reported_by, request_id)
    values (v_id, v_deal.legal_entity_id, v_deal.id, v_version, v_mode, v_amount,
      v_paid, v_payer, v_reference, v_norm, v_cheque_no, v_cheque_date, v_dv.id, v_note,
      (select auth.uid()), p_request_id);
  exception
    when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint = 'customer_payment_claims_request_unique' then
        raise exception 'request_conflict' using errcode = 'PT409';
      end if;
      raise exception 'duplicate_claim' using errcode = '23505';
    when check_violation or not_null_violation or foreign_key_violation then
      raise exception 'invalid_input' using errcode = '22023';
  end;

  v_result := jsonb_build_object('outcome', 'created', 'id', v_id, 'status', 'reported', 'rowVersion', 1);
  perform authz.finance_remember(v_deal.legal_entity_id, p_request_id, 'payment_claim_report', v_payload, v_result);
  perform authz.write_audit('finance.claim_reported', v_deal.legal_entity_id, v_deal.branch_id, 'payment_claim', v_id, null,
    jsonb_build_object('dealId', v_deal.id, 'bookingVersionId', v_version, 'mode', v_mode));
  return v_result;
end;
$$;

-- public.payment_claim_withdraw(uuid, integer, text, uuid): from 20261119000200_b11_payment_claims.sql
create or replace function public.payment_claim_withdraw(
  p_claim_id uuid, p_expected_row_version integer, p_reason text, p_request_id uuid
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  c public.customer_payment_claims%rowtype;
  v_deal public.deals%rowtype;
  v_payload jsonb := jsonb_build_object('claimId', p_claim_id, 'expectedRowVersion', p_expected_row_version, 'reason', p_reason);
  v_result jsonb;
  v_reason text;
begin
  select * into c from public.customer_payment_claims x where x.id = p_claim_id;
  if c.id is null then
    if coalesce(authz.session_ok(), false) then
      raise exception 'not_found' using errcode = 'P0002';
    end if;
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.refuse_removed_deal(c.deal_id);
  if not authz.finance_claim_sales_ok(c.deal_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_request_id is null or p_expected_row_version is null then
    perform authz.finance_invalid();
  end if;
  v_deal := authz.finance_lock_deal(c.deal_id);
  v_result := authz.finance_replay(c.legal_entity_id, p_request_id, 'payment_claim_withdraw', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  select * into c from public.customer_payment_claims x where x.id = p_claim_id for update;
  if c.row_version <> p_expected_row_version then
    raise exception 'version_changed' using errcode = 'PT409';
  end if;
  if c.status <> 'reported' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  v_reason := authz.finance_reason(p_reason);

  update public.customer_payment_claims x
  set status = 'withdrawn', closed_reason = v_reason, closed_by = (select auth.uid()), closed_at = now(),
      row_version = x.row_version + 1, updated_at = now()
  where x.id = c.id
  returning * into c;

  v_result := jsonb_build_object('outcome', 'updated', 'id', c.id, 'status', 'withdrawn', 'rowVersion', c.row_version);
  perform authz.finance_remember(c.legal_entity_id, p_request_id, 'payment_claim_withdraw', v_payload, v_result);
  perform authz.write_audit('finance.claim_withdrawn', c.legal_entity_id, v_deal.branch_id, 'payment_claim', c.id, v_reason,
    jsonb_build_object('dealId', c.deal_id));
  return v_result;
end;
$$;

-- public.purchase_booking_change_ack(uuid, uuid, uuid): from 20261203000430_purchase_booking_change.sql
create or replace function public.purchase_booking_change_ack(p_task_id uuid, p_expected_basis_version_id uuid, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_basis public.purchase_task_basis%rowtype;
  v_current uuid;
  v_payload jsonb;
  v_replay jsonb;
  v_result jsonb;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id for update;
  if v_task.id is null or not authz.can_work_purchase_task(v_task.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  v_payload := jsonb_build_object('taskId', p_task_id, 'expectedBasisVersionId', p_expected_basis_version_id);
  v_replay := authz.finance_replay(v_task.legal_entity_id, p_request_id, 'purchase_booking_change_ack', v_payload);
  if v_replay is not null then
    return v_replay;
  end if;
  v_current := authz.task_current_version(v_task.id);

  select * into v_basis from public.purchase_task_basis b where b.task_id = v_task.id for update;
  if v_basis.task_id is null then
    insert into public.purchase_task_basis (task_id, legal_entity_id, deal_id, basis_version_id)
    values (v_task.id, v_task.legal_entity_id, v_task.deal_id, v_current)
    returning * into v_basis;
    return jsonb_build_object('outcome', 'existing', 'taskId', v_task.id, 'basisVersionId', v_basis.basis_version_id,
                              'rowVersion', v_basis.row_version);
  end if;
  if p_expected_basis_version_id is distinct from v_basis.basis_version_id then
    raise exception 'version_changed' using errcode = 'PT409';
  end if;
  if v_current = v_basis.basis_version_id then
    return jsonb_build_object('outcome', 'existing', 'taskId', v_task.id, 'basisVersionId', v_basis.basis_version_id,
                              'rowVersion', v_basis.row_version);
  end if;

  update public.purchase_task_basis b
  set basis_version_id = v_current, seen_by = (select auth.uid()), seen_at = now(),
      row_version = b.row_version + 1, updated_at = now()
  where b.task_id = v_task.id
  returning * into v_basis;
  update public.staff_notices n set read_at = coalesce(n.read_at, now()), done_at = now()
  where n.recipient_user_id = (select auth.uid()) and n.task_id = v_task.id and n.kind = 'booking_changed'
    and n.done_at is null and n.resolved_at is null;
  perform authz.write_audit('purchase.booking_change_seen', v_task.legal_entity_id, v_task.branch_id,
    'fulfilment_task', v_task.id, null,
    jsonb_build_object('fromVersionId', p_expected_basis_version_id, 'toVersionId', v_current,
                       'rowVersion', v_basis.row_version));
  v_result := jsonb_build_object('outcome', 'updated', 'taskId', v_task.id, 'basisVersionId', v_basis.basis_version_id,
                                 'rowVersion', v_basis.row_version);
  return authz.finance_remember(v_task.legal_entity_id, p_request_id, 'purchase_booking_change_ack', v_payload, v_result);
end;
$$;

-- public.purchase_booking_request_send(uuid, integer, text, text[], text, text, uuid): from 20261130000110_purchase_workflow_commands.sql
create or replace function public.purchase_booking_request_send(
  p_task_id uuid, p_expected_cost_version_no integer, p_to text, p_cc text[], p_subject text, p_body text,
  p_request_id uuid
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_task public.fulfilment_tasks%rowtype;
  v_existing public.purchase_supplier_emails%rowtype;
  v_cost public.purchase_cost_versions;
  v_quote public.purchase_quotes%rowtype;
  v_budget bigint;
  v_mail jsonb;
  v_status text;
  v_email uuid;
  v_version uuid;
  v_req uuid;
  v_superseded uuid[];
begin
  v_task := authz.lock_workable_task(p_task_id);
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  select * into v_existing from public.purchase_supplier_emails e
  where e.legal_entity_id = v_task.legal_entity_id and e.request_id = p_request_id;
  if v_existing.id is not null then
    if v_existing.task_id = v_task.id and v_existing.kind = 'booking_request' and v_existing.sent_by = v_uid
       and v_existing.cost_version_no is not distinct from p_expected_cost_version_no then
      return jsonb_build_object('emailId', v_existing.id, 'status', v_existing.status, 'outcome', 'existing',
        'goAheadRequestId', (select r.id from public.purchase_go_ahead_requests r
                             where r.task_id = v_task.id and r.email_id = v_existing.id),
        'goAheadState', authz.purchase_go_ahead_state(v_task.id));
    end if;
    raise exception 'duplicate_request' using errcode = '23505';
  end if;
  if authz.deal_trip_cancelled(v_task.deal_id) then
    raise exception 'trip_cancelled' using errcode = '55000';
  end if;
  v_cost := authz.purchase_latest_cost(v_task.id);
  if v_cost.id is null then
    raise exception 'not_ready' using errcode = '55000';
  end if;
  if p_expected_cost_version_no is distinct from v_cost.version_no then
    raise exception 'version_changed' using errcode = 'PT409';
  end if;
  select * into v_quote from public.purchase_quotes q where q.id = v_cost.quote_id;
  if v_cost.stage <> 'proposed' or v_quote.status <> 'open' then
    raise exception 'not_ready' using errcode = '55000';
  end if;
  v_budget := authz.task_budget(v_task.id);
  if (v_budget is null or v_cost.amount_paise > v_budget)
     and not authz.cost_version_approved(v_task.id, v_cost.version_no) then
    raise exception 'over_budget' using errcode = '55000';
  end if;
  v_mail := authz.supplier_email_normalize(p_to, p_cc, p_subject, p_body);
  v_status := case when authz.supplier_email_sending_enabled() then 'queued' else 'marked_sent' end;

  insert into public.purchase_supplier_emails (legal_entity_id, task_id, deal_id, kind, supplier_id, to_email,
    cc_emails, subject, body, quote_id, cost_version_no, amount_paise, status, sent_by, request_id)
  values (v_task.legal_entity_id, v_task.id, v_task.deal_id, 'booking_request', v_quote.supplier_id, v_mail ->> 'to',
    array(select jsonb_array_elements_text(v_mail -> 'cc')), v_mail ->> 'subject', v_mail ->> 'body',
    v_cost.quote_id, v_cost.version_no, v_cost.amount_paise, v_status, v_uid, p_request_id)
  returning id into v_email;

  if authz.purchase_go_ahead_needed(v_task.id) then
    v_version := authz.task_current_version(v_task.id);
    -- An approved request whose booking review was since returned no longer
    -- counts (authz.purchase_go_ahead_valid): a new pending request is made.
    -- A pending request whose booking e-mail is still queued or failed is
    -- superseded below by a new pending request linked to this e-mail, so
    -- Accounts always decides on a booking request that went out.
    select r.id into v_req from public.purchase_go_ahead_requests r
    where r.task_id = v_task.id
      and ((r.status = 'pending' and exists (select 1 from public.purchase_supplier_emails e
                                             where e.id = r.email_id and e.status in ('sent', 'marked_sent')))
           or (r.status = 'approved' and exists (select 1 from public.accounts_booking_reviews b
                                                 where b.booking_version_id = r.booking_version_id and b.status = 'approved')))
      and r.booking_version_id = v_version and r.cost_version_no = v_cost.version_no and r.quote_id = v_cost.quote_id
    order by (r.status = 'pending') desc, r.requested_at desc, r.id desc limit 1;
    if v_req is null then
      with s as (
        update public.purchase_go_ahead_requests r set status = 'superseded', row_version = r.row_version + 1
        where r.task_id = v_task.id and r.status = 'pending'
        returning r.id)
      select coalesce(array_agg(s.id), '{}'::uuid[]) into v_superseded from s;
      insert into public.purchase_go_ahead_requests (legal_entity_id, branch_id, deal_id, task_id, booking_version_id,
        quote_id, cost_version_no, amount_paise, requested_by, email_id, request_id)
      values (v_task.legal_entity_id, v_task.branch_id, v_task.deal_id, v_task.id, v_version,
        v_cost.quote_id, v_cost.version_no, v_cost.amount_paise, v_uid, v_email, p_request_id)
      returning id into v_req;
      perform authz.write_audit('purchase.go_ahead_requested', v_task.legal_entity_id, v_task.branch_id,
        'fulfilment_task', v_task.id, null,
        jsonb_build_object('goAheadRequestId', v_req, 'costVersionNo', v_cost.version_no,
          'bookingVersionId', v_version, 'supersededRequestIds', to_jsonb(v_superseded)));
    end if;
  end if;

  perform authz.write_audit('purchase.booking_request_recorded', v_task.legal_entity_id, v_task.branch_id,
    'fulfilment_task', v_task.id, null,
    jsonb_build_object('emailId', v_email, 'supplierId', v_quote.supplier_id, 'costVersionNo', v_cost.version_no,
      'status', v_status, 'goAheadRequestId', v_req));
  return jsonb_build_object('emailId', v_email, 'status', v_status, 'outcome', 'created',
    'goAheadRequestId', v_req, 'goAheadState', authz.purchase_go_ahead_state(v_task.id));
end;
$$;

-- public.purchase_cancellation_charge_set(uuid, bigint, bigint, text, uuid, integer, uuid): from 20261205000780_manager_approves_final.sql
create or replace function public.purchase_cancellation_charge_set(
  p_task_id uuid, p_keeps_paise bigint, p_refund_paise bigint, p_note text, p_credit_note_evidence_id uuid,
  p_expected_revision integer, p_request_id uuid
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_task public.fulfilment_tasks%rowtype;
  v_c public.deal_cancellations%rowtype;
  v_existing public.purchase_cancellation_charges%rowtype;
  v_rev integer;
  v_cost public.purchase_cost_versions;
  v_supplier uuid;
  v_note text;
  v_cr public.booking_change_requests%rowtype;  -- Accounts phase 3 (20261205000730)
begin
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id for update;
  if v_task.id is null or v_task.department is distinct from 'purchase' or not coalesce(authz.session_ok(), false)
     or not authz.holds_active_role('purchase', v_task.legal_entity_id)
     or (v_task.assignee_user_id is not null and v_task.assignee_user_id <> v_uid) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if authz.deployment_environment() = 'unset' then
    raise exception 'environment_unset' using errcode = '55000';
  end if;
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  select * into v_c from public.deal_cancellations c where c.deal_id = v_task.deal_id for update;
  -- Accounts phase 3 (20261205000730): without a trip cancellation, the charge belongs to the
  -- live remove_service request (route cancellation) naming this service (11.3).
  -- Lock order 17.1: the task, then the request.
  if v_c.id is null then
    select r.* into v_cr from public.booking_change_requests r
    where r.deal_id = v_task.deal_id and r.kind = 'remove_service' and r.removal_route = 'cancellation'
      and v_task.service_item_id = any (r.item_ids) and r.status in ('draft', 'requested', 'returned', 'approved', 'submitted')
    for update;
  end if;
  if v_c.id is null and v_cr.id is null then
    raise exception 'not_ready' using errcode = '55000';
  end if;
  select * into v_existing from public.purchase_cancellation_charges x
  where x.legal_entity_id = v_task.legal_entity_id and x.request_id = p_request_id;
  if v_existing.id is not null then
    if v_existing.task_id = v_task.id and v_existing.entered_by = v_uid
       and (v_existing.cancellation_id = v_c.id or v_existing.change_request_id = v_cr.id) then  -- Accounts phase 3 (20261205000730)
      return jsonb_build_object('cancellationId', v_c.id, 'revisionNo', v_existing.revision_no,
        'status', coalesce(v_c.status, 'charges_entered'), 'outcome', 'existing', 'changeRequestId', v_cr.id);
    end if;
    raise exception 'duplicate_request' using errcode = '23505';
  end if;
  if v_c.status = 'approved' then
    raise exception 'already_decided' using errcode = '55000';
  end if;
  -- Accounts phase 3 (20261205000730): the charges stand once the Manager approved the removal.
  if v_cr.id is not null and v_cr.status not in ('draft', 'requested', 'returned') then
    raise exception 'already_decided' using errcode = '55000';
  end if;
  select coalesce(max(x.revision_no), 0) into v_rev from public.purchase_cancellation_charges x
  where (x.cancellation_id = v_c.id or x.change_request_id = v_cr.id) and x.task_id = v_task.id;  -- Accounts phase 3 (20261205000730)
  if p_expected_revision is distinct from v_rev then
    raise exception 'version_changed' using errcode = 'PT409';
  end if;
  v_cost := authz.purchase_latest_cost(v_task.id);
  if v_cost.id is null then
    raise exception 'not_ready' using errcode = '55000';
  end if;
  select q.supplier_id into v_supplier from public.purchase_quotes q where q.id = v_cost.quote_id;
  if p_keeps_paise is null or p_refund_paise is null or p_keeps_paise < 0 or p_refund_paise < 0
     or p_keeps_paise > 999999999999999999 or p_refund_paise > 999999999999999999 then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  v_note := authz.booking_fact_text(jsonb_build_object('note', p_note), 'note', 500, true);
  if p_credit_note_evidence_id is not null and not authz.cancellation_credit_note_ok(v_task.id, p_credit_note_evidence_id) then
    raise exception 'invalid_input' using errcode = '22023';
  end if;

  insert into public.purchase_cancellation_charges (cancellation_id, legal_entity_id, task_id, revision_no, supplier_id,
    committed_cost_paise, supplier_keeps_paise, supplier_refund_paise, note, credit_note_evidence_id, entered_by, request_id,
    change_request_id)  -- Accounts phase 3 (20261205000730)
  values (v_c.id, v_task.legal_entity_id, v_task.id, v_rev + 1, v_supplier, v_cost.amount_paise, p_keeps_paise,
    p_refund_paise, v_note, p_credit_note_evidence_id, v_uid, p_request_id, v_cr.id);

  update public.deal_cancellations c
  set status = 'charges_entered', row_version = c.row_version + 1, updated_at = now()
  where c.id = v_c.id;

  perform authz.write_audit('purchase.cancellation_charge_set', v_task.legal_entity_id, v_task.branch_id,
    'fulfilment_task', v_task.id, null,
    jsonb_build_object('cancellationId', v_c.id, 'revisionNo', v_rev + 1, 'previousStatus', v_c.status,
      'creditNote', p_credit_note_evidence_id is not null, 'changeRequestId', v_cr.id));  -- Accounts phase 3 (20261205000730)
  return jsonb_build_object('cancellationId', v_c.id, 'revisionNo', v_rev + 1, 'status', 'charges_entered',
    'outcome', 'created', 'changeRequestId', v_cr.id);
end;
$$;

-- public.purchase_cost_approve_over_budget(uuid, integer): from 20261205000600_cost_approval_booking_version.sql
create or replace function public.purchase_cost_approve_over_budget(p_task_id uuid, p_version_no integer) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_cost public.purchase_cost_versions%rowtype;
  v_latest public.purchase_cost_versions;
  v_gate text;
  v_budget bigint;
  v_uid uuid := (select auth.uid());
begin
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id for update;
  if v_task.id is null or not authz.can_manage_purchase_task(v_task.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_task.status = 'supplier_confirmed' then
    raise exception 'already_confirmed' using errcode = '55000';
  end if;
  select * into v_cost from public.purchase_cost_versions c where c.task_id = v_task.id and c.version_no = p_version_no;
  if v_cost.id is null or v_task.status <> 'in_progress' then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  -- Review L9: a repeat answers 'existing' even after the gate closed.
  -- Accounts phase 3 (20261205000600): only an approval for the current booking version counts.
  if authz.cost_version_approved(v_task.id, v_cost.version_no) then
    return jsonb_build_object('taskId', v_task.id, 'versionNo', v_cost.version_no, 'outcome', 'existing');
  end if;
  v_gate := authz.procurement_gate_issue(v_task.id);
  if v_gate is not null then
    raise exception '%', v_gate using errcode = '55000';
  end if;
  v_latest := authz.purchase_latest_cost(v_task.id);
  if v_latest.version_no <> v_cost.version_no then
    raise exception 'version_changed' using errcode = 'PT409';
  end if;
  v_budget := authz.task_budget(v_task.id);
  if v_cost.stage <> 'proposed' or (v_budget is not null and v_cost.amount_paise <= v_budget) then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  if v_cost.created_by = v_uid then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  -- Accounts phase 3 (20261205000600): bound to the task's current booking version.
  insert into public.purchase_cost_approvals (task_id, legal_entity_id, version_no, approved_by, booking_version_id)
  values (v_task.id, v_task.legal_entity_id, v_cost.version_no, v_uid, authz.task_current_version(v_task.id));
  -- Amounts stay out of the audit trail.
  perform authz.write_audit('purchase.cost_over_budget_approved', v_task.legal_entity_id, v_task.branch_id,
    'fulfilment_task', v_task.id, null, jsonb_build_object('versionNo', v_cost.version_no));
  return jsonb_build_object('taskId', v_task.id, 'versionNo', v_cost.version_no, 'outcome', 'created');
end;
$$;

-- public.purchase_cost_propose(uuid, uuid, integer, bigint, date, text, uuid): from 20261130000110_purchase_workflow_commands.sql
create or replace function public.purchase_cost_propose(
  p_task_id uuid, p_quote_id uuid, p_expected_version_no integer, p_amount_paise bigint, p_due_date date,
  p_note text, p_request_id uuid
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_existing public.purchase_cost_versions%rowtype;
  v_latest integer;
  v_note text;
begin
  v_task := authz.lock_workable_task(p_task_id);
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  select * into v_existing from public.purchase_cost_versions c
  where c.task_id = v_task.id and c.request_id = p_request_id;
  if v_existing.id is not null then
    return jsonb_build_object('versionNo', v_existing.version_no, 'created', false);
  end if;
  -- Purchase build: a cancelled trip takes no new rate; an open supplier
  -- payment request freezes the rate it was made for.
  if authz.deal_trip_cancelled(v_task.deal_id) then
    raise exception 'trip_cancelled' using errcode = '55000';
  end if;
  if authz.purchase_has_live_payment(v_task.id) then
    raise exception 'payment_in_progress' using errcode = '55000';
  end if;
  select coalesce(max(c.version_no), 0) into v_latest from public.purchase_cost_versions c where c.task_id = v_task.id;
  if p_expected_version_no is distinct from v_latest then
    raise exception 'version_changed' using errcode = 'PT409';
  end if;
  if not exists (select 1 from public.purchase_quotes q
                 where q.id = p_quote_id and q.task_id = v_task.id and q.status = 'open') then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  if p_amount_paise is null or p_amount_paise <= 0 or p_amount_paise > 999999999999999999
     or (p_due_date is not null and p_due_date not between date '2000-01-01' and date '2100-12-31') then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  v_note := authz.booking_fact_text(jsonb_build_object('note', p_note), 'note', 500, true);

  insert into public.purchase_cost_versions (task_id, legal_entity_id, version_no, quote_id, request_id, stage,
    amount_paise, due_date, note, created_by)
  values (v_task.id, v_task.legal_entity_id, v_latest + 1, p_quote_id, p_request_id, 'proposed',
    p_amount_paise, p_due_date, v_note, (select auth.uid()));

  -- Amounts stay out of the audit trail.
  perform authz.write_audit('purchase.cost_proposed', v_task.legal_entity_id, v_task.branch_id,
    'fulfilment_task', v_task.id, null, jsonb_build_object('versionNo', v_latest + 1, 'quoteId', p_quote_id));
  return jsonb_build_object('versionNo', v_latest + 1, 'created', true);
end;
$$;

-- public.purchase_go_ahead_decide(uuid, text, text, integer, uuid): from 20261130000110_purchase_workflow_commands.sql
create or replace function public.purchase_go_ahead_decide(
  p_request uuid, p_decision text, p_reason text, p_expected_row_version integer, p_request_id uuid
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_r public.purchase_go_ahead_requests%rowtype;
  v_task_id uuid;
  v_synthetic boolean;
  v_reason text;
  v_status text;
begin
  select * into v_r from public.purchase_go_ahead_requests r where r.id = p_request;
  if v_r.id is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select d.is_synthetic into v_synthetic from public.deals d where d.id = v_r.deal_id;
  perform authz.finance_require_accounts(v_r.legal_entity_id, v_synthetic);
  -- Review F2: the Deal's finance lock first (the lock accounts_review_approve
  -- and accounts_review_return take), so the booking review cannot change
  -- between the check below and this decision. Then the task, then the request.
  perform authz.finance_lock_deal(v_r.deal_id);
  v_task_id := v_r.task_id;
  perform 1 from public.fulfilment_tasks t where t.id = v_task_id for share;
  select * into v_r from public.purchase_go_ahead_requests r where r.id = p_request for update;
  if p_request_id is null or p_decision is null or p_decision not in ('approve', 'return') then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  v_status := case p_decision when 'approve' then 'approved' else 'returned' end;
  if v_r.status in ('approved', 'returned') then
    if v_r.decision_request_id = p_request_id and v_r.decided_by = v_uid and v_r.status = v_status then
      return jsonb_build_object('requestId', v_r.id, 'status', v_r.status, 'outcome', 'existing');
    end if;
    raise exception 'already_decided' using errcode = '55000';
  end if;
  if v_r.status = 'superseded' or p_expected_row_version is distinct from v_r.row_version then
    raise exception 'version_changed' using errcode = 'PT409';
  end if;
  if v_r.requested_by = v_uid or authz.finance_deal_conflict(v_r.deal_id) then
    raise exception 'not_self_approval' using errcode = '42501';
  end if;
  if not authz.purchase_go_ahead_request_current(v_r.id) then
    raise exception 'version_changed' using errcode = 'PT409';
  end if;

  if p_decision = 'approve' then
    if authz.deal_trip_cancelled(v_r.deal_id) then
      raise exception 'trip_cancelled' using errcode = '55000';
    end if;
    if not exists (select 1 from public.accounts_booking_reviews b
                   where b.booking_version_id = v_r.booking_version_id and b.status = 'approved') then
      raise exception 'booking_not_approved' using errcode = '55000';
    end if;
    -- Review F7: the linked booking request must have gone out (sent by the
    -- CRM or marked as sent); a queued or failed e-mail does not count.
    if not exists (select 1 from public.purchase_supplier_emails e
                   where e.id = v_r.email_id and e.status in ('sent', 'marked_sent')) then
      raise exception 'booking_request_not_sent' using errcode = '55000';
    end if;
    update public.purchase_go_ahead_requests r
    set status = 'approved', decided_by = v_uid, decided_at = now(), decision_request_id = p_request_id,
        row_version = r.row_version + 1
    where r.id = v_r.id;
  else
    v_reason := authz.purchase_reason(p_reason);
    update public.purchase_go_ahead_requests r
    set status = 'returned', decided_by = v_uid, decided_at = now(), decision_request_id = p_request_id,
        return_reason = v_reason, row_version = r.row_version + 1
    where r.id = v_r.id;
  end if;

  perform authz.write_audit(case when p_decision = 'approve' then 'purchase.go_ahead_approved' else 'purchase.go_ahead_returned' end,
    v_r.legal_entity_id, v_r.branch_id, 'fulfilment_task', v_r.task_id, v_reason,
    jsonb_build_object('goAheadRequestId', v_r.id, 'costVersionNo', v_r.cost_version_no,
      'bookingVersionId', v_r.booking_version_id));
  return jsonb_build_object('requestId', v_r.id, 'status', v_status, 'outcome', 'created');
end;
$$;

-- public.purchase_supplier_confirm(uuid, integer, text): from 20261205000780_manager_approves_final.sql
create or replace function public.purchase_supplier_confirm(p_task_id uuid, p_expected_version_no integer, p_reference text)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_cost public.purchase_cost_versions;
  v_proposal public.purchase_cost_versions;
  v_ref text := btrim(coalesce(p_reference, ''));
  v_issues text[];
begin
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id for update;
  if v_task.id is null or not authz.can_work_purchase_task(v_task.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  -- Stage 0: wait for an in-flight removal of the Deal (it holds FOR UPDATE)
  -- so the gate below reads its committed result.
  perform 1 from public.deals d where d.id = v_task.deal_id for key share;
  -- The first confirmation already stores its identity in immutable cost history.
  -- The committed version is NEW: retries must name the accepted PROPOSED
  -- version, not the current committed version. That proposal also fixes the offer.
  if v_task.status = 'supplier_confirmed' then
    v_cost := authz.purchase_latest_cost(v_task.id);
    select * into v_proposal from public.purchase_cost_versions c
      where c.task_id = v_task.id and c.version_no = p_expected_version_no;
    if v_task.supplier_reference = v_ref
       and v_cost.stage = 'committed'
       and p_expected_version_no = v_cost.version_no - 1
       and v_proposal.stage = 'proposed'
       and v_proposal.quote_id = v_cost.quote_id
       and v_proposal.quote_id = v_task.selected_quote_id then
      return jsonb_build_object('outcome', 'existing', 'taskId', v_task.id);
    end if;
    raise exception 'task_conflict' using errcode = 'PT409';
  end if;
  -- Accounts phase 3 (20261205000750): a service removed, or being removed, is not confirmed (11.1, 11.3).
  if exists (select 1 from public.fulfilment_tasks t2 where t2.id = v_task.id and (t2.closed_state is not null or exists (
         select 1 from public.booking_change_requests r
         where r.deal_id = t2.deal_id and r.kind = 'remove_service' and t2.service_item_id = any (r.item_ids)
           and r.status in ('draft', 'requested', 'returned', 'approved', 'submitted')))) then
    raise exception 'service_removed' using errcode = '55000';
  end if;
  if length(v_ref) not between 1 and 120 or v_ref ~ E'[\\x01-\\x1f\\x7f]' then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  v_cost := authz.purchase_latest_cost(v_task.id);
  if v_cost.id is not null and p_expected_version_no is distinct from v_cost.version_no then
    raise exception 'version_changed' using errcode = 'PT409';
  end if;

  v_issues := authz.procurement_issues(v_task.id);
  if 'environment_unset' = any (v_issues) then
    raise exception 'environment_unset' using errcode = '55000';
  end if;
  -- Stage 0: a Deal removed by the Bitrix sync takes no new commitment.
  if 'deal_removed' = any (v_issues) then
    raise exception 'deal_removed' using errcode = '55000';
  end if;
  if 'procurement_disabled' = any (v_issues) then
    raise exception 'procurement_disabled' using errcode = '55000';
  end if;
  -- Purchase build: a cancelled trip takes no new commitment.
  if 'trip_cancelled' = any (v_issues) then
    raise exception 'trip_cancelled' using errcode = '55000';
  end if;
  if v_issues = array['over_budget'] then
    raise exception 'over_budget' using errcode = '55000';
  end if;
  -- Purchase build: when only the booking request or the Accounts go-ahead is
  -- missing, name it (booking request first: it starts the go-ahead).
  if cardinality(v_issues) > 0 and v_issues <@ array['booking_request_not_sent', 'go_ahead_missing'] then
    if 'booking_request_not_sent' = any (v_issues) then
      raise exception 'booking_request_not_sent' using errcode = '55000';
    end if;
    raise exception 'go_ahead_missing' using errcode = '55000';
  end if;
  if cardinality(v_issues) > 0 then
    raise exception 'not_ready' using errcode = '55000';
  end if;

  insert into public.purchase_cost_versions (task_id, legal_entity_id, version_no, quote_id, request_id, stage,
    amount_paise, due_date, note, created_by)
  values (v_task.id, v_task.legal_entity_id, v_cost.version_no + 1, v_cost.quote_id, gen_random_uuid(), 'committed',
    v_cost.amount_paise, v_cost.due_date, v_cost.note, (select auth.uid()));
  update public.purchase_quotes q set status = 'selected', updated_at = now() where q.id = v_cost.quote_id;
  update public.fulfilment_tasks t
  set status = 'supplier_confirmed', selected_quote_id = v_cost.quote_id, supplier_reference = v_ref,
      supplier_confirmed_by = (select auth.uid()), supplier_confirmed_at = now(), updated_at = now()
  where t.id = v_task.id;
  -- Accounts phase 3 (20261205000630): confirmation 1 of the task's history.
  insert into public.task_confirmations (legal_entity_id, task_id, confirmation_no, quote_id, committed_version_no, amount_paise,
    supplier_reference, evidence_ids, booking_version_id, confirmed_by, confirmed_at)
  values (v_task.legal_entity_id, v_task.id, 1, v_cost.quote_id, v_cost.version_no + 1, v_cost.amount_paise, v_ref,
    coalesce((select array_agg(e.id order by e.created_at, e.id) from public.purchase_evidence e
              where e.task_id = v_task.id and e.kind = 'supplier_confirmation' and e.status = 'stored'), '{}'::uuid[]),
    authz.task_current_version(v_task.id), (select auth.uid()), now())
  on conflict (task_id, confirmation_no) do nothing;

  insert into public.outbox_events (legal_entity_id, aggregate_type, aggregate_id, event_type, payload)
  values (v_task.legal_entity_id, 'fulfilment_task', v_task.id, 'fulfilment.supplier_confirmed',
    jsonb_build_object('task_id', v_task.id, 'deal_id', v_task.deal_id, 'service_purpose', v_task.service_purpose))
  on conflict (event_type, aggregate_id) do nothing;

  perform authz.write_audit('purchase.supplier_confirmed', v_task.legal_entity_id, v_task.branch_id,
    'fulfilment_task', v_task.id, null,
    jsonb_build_object('quoteId', v_cost.quote_id, 'committedVersionNo', v_cost.version_no + 1));
  return jsonb_build_object('outcome', 'created', 'taskId', v_task.id);
end;
$$;

-- public.purchase_task_claim(uuid): from 20261205000780_manager_approves_final.sql
create or replace function public.purchase_task_claim(p_task_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_uid uuid := (select auth.uid());
begin
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id for update;
  if v_task.id is null or not authz.can_claim_purchase_task(v_task.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  -- Accounts phase 3 (20261205000750): a service removed, or being removed, is not taken (11.1, 11.3).
  if exists (select 1 from public.fulfilment_tasks t2 where t2.id = v_task.id and (t2.closed_state is not null or exists (
         select 1 from public.booking_change_requests r
         where r.deal_id = t2.deal_id and r.kind = 'remove_service' and t2.service_item_id = any (r.item_ids)
           and r.status in ('draft', 'requested', 'returned', 'approved', 'submitted')))) then
    raise exception 'service_removed' using errcode = '55000';
  end if;
  if v_task.assignee_user_id = v_uid then
    return jsonb_build_object('taskId', v_task.id, 'status', v_task.status, 'assignedToYou', true,
      'alreadyYours', true);
  end if;
  if v_task.assignee_user_id is not null then
    raise exception 'task_conflict' using errcode = 'PT409';
  end if;

  update public.fulfilment_tasks t
  set assignee_user_id = v_uid, status = 'in_progress', updated_at = now()
  where t.id = v_task.id;
  insert into public.deal_assignments (deal_id, legal_entity_id, user_id, assignment_kind, assigned_by)
  values (v_task.deal_id, v_task.legal_entity_id, v_uid, 'purchase', v_uid)
  on conflict (deal_id, user_id, assignment_kind) where ended_at is null do nothing;

  perform authz.write_audit('fulfilment.task_claimed', v_task.legal_entity_id, v_task.branch_id,
    'fulfilment_task', v_task.id, null,
    jsonb_build_object('dealId', v_task.deal_id, 'versionId', v_task.booking_version_id));
  return jsonb_build_object('taskId', v_task.id, 'status', 'in_progress', 'assignedToYou', true,
    'alreadyYours', false);
end;
$$;

-- public.purchase_task_reassign(uuid, uuid, uuid): from 20261201000110_flight_workspace_commands.sql
create or replace function public.purchase_task_reassign(p_task_id uuid, p_expected_assignee uuid, p_to_user_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_from uuid;
  v_uid uuid := (select auth.uid());
begin
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id for update;
  if v_task.id is null or not authz.can_manage_purchase_task(v_task.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  -- Flight build (20261201000110): flight groups move through flight_group_reassign.
  if v_task.department = 'flight' then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if authz.deployment_environment() = 'unset' then
    raise exception 'environment_unset' using errcode = '55000';
  end if;
  if v_task.status = 'supplier_confirmed' then
    raise exception 'already_confirmed' using errcode = '55000';
  end if;
  if p_to_user_id is null or p_expected_assignee is null then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  if v_task.status = 'in_progress' and v_task.assignee_user_id = p_to_user_id then
    return jsonb_build_object('taskId', v_task.id, 'outcome', 'existing');
  end if;
  if v_task.status <> 'in_progress' or v_task.assignee_user_id is distinct from p_expected_assignee then
    raise exception 'task_conflict' using errcode = 'PT409';
  end if;
  -- Batch 6: the new assignee holds the active role of the task's department
  -- (for a Purchase task the same rule as authz.is_active_purchase_person).
  if not authz.is_active_department_person(p_to_user_id, v_task.legal_entity_id, v_task.department) then
    raise exception 'invalid_input' using errcode = '22023';
  end if;

  v_from := v_task.assignee_user_id;
  perform set_config('authz.task_transition', 'reassign', true);
  update public.fulfilment_tasks t set assignee_user_id = p_to_user_id, updated_at = now() where t.id = v_task.id;
  perform set_config('authz.task_transition', '', true);
  -- Batch 6: the Deal assignment follows the task's department (kind
  -- 'purchase', 'flight' or 'visa', as purchase_task_claim, flight_task_claim
  -- and visa_task_claim record it). A Purchase task keeps the previous call.
  if v_task.department = 'purchase' then
    perform authz.end_purchase_assignment(v_task.deal_id, v_from);
  else
    -- The previous assignee's assignment of this department ends unless they
    -- still hold another in-progress task of the same department on the Deal.
    update public.deal_assignments a set ended_at = now()
    where a.deal_id = v_task.deal_id and a.user_id = v_from and a.assignment_kind = v_task.department
      and a.ended_at is null
      and not exists (
        select 1 from public.fulfilment_tasks t
        where t.deal_id = v_task.deal_id and t.assignee_user_id = v_from and t.status = 'in_progress'
          and t.department = v_task.department
      );
  end if;
  insert into public.deal_assignments (deal_id, legal_entity_id, user_id, assignment_kind, assigned_by)
  values (v_task.deal_id, v_task.legal_entity_id, p_to_user_id, v_task.department, v_uid)
  on conflict (deal_id, user_id, assignment_kind) where ended_at is null do nothing;

  perform authz.write_audit('fulfilment.task_reassigned', v_task.legal_entity_id, v_task.branch_id,
    'fulfilment_task', v_task.id, null,
    jsonb_build_object('dealId', v_task.deal_id, 'fromUserId', v_from, 'toUserId', p_to_user_id));
  return jsonb_build_object('taskId', v_task.id, 'outcome', 'created');
end;
$$;

-- public.purchase_task_release(uuid): from 20261005000200_procurement_owner_decisions.sql
create or replace function public.purchase_task_release(p_task_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_uid uuid := (select auth.uid());
begin
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id for update;
  if v_task.id is null or not authz.can_claim_purchase_task(v_task.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if authz.deployment_environment() = 'unset' then
    raise exception 'environment_unset' using errcode = '55000';
  end if;
  if v_task.status = 'supplier_confirmed' then
    raise exception 'already_confirmed' using errcode = '55000';
  end if;
  if v_task.assignee_user_id is null then
    return jsonb_build_object('taskId', v_task.id, 'status', 'not_started', 'outcome', 'existing');
  end if;
  if v_task.assignee_user_id <> v_uid then
    raise exception 'task_conflict' using errcode = 'PT409';
  end if;

  perform set_config('authz.task_transition', 'release', true);
  update public.fulfilment_tasks t set status = 'not_started', assignee_user_id = null, updated_at = now()
  where t.id = v_task.id;
  perform set_config('authz.task_transition', '', true);
  perform authz.end_purchase_assignment(v_task.deal_id, v_uid);

  perform authz.write_audit('fulfilment.task_released', v_task.legal_entity_id, v_task.branch_id,
    'fulfilment_task', v_task.id, null, jsonb_build_object('dealId', v_task.deal_id, 'fromUserId', v_uid));
  return jsonb_build_object('taskId', v_task.id, 'status', 'not_started', 'outcome', 'created');
end;
$$;

-- public.quotation_accept(uuid, text, uuid, text, uuid): from 20261120000200_b12_quotations.sql
create or replace function public.quotation_accept(p_version_id uuid, p_expected_content_hash text, p_evidence_id uuid,
  p_tier_key text, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.quotation_versions%rowtype;
  v_q public.quotations%rowtype;
  v_deal uuid;
  v_discarded uuid;
  v_superseded uuid;
  v_payload jsonb := jsonb_build_object('versionId', p_version_id, 'hash', p_expected_content_hash,
    'evidenceId', p_evidence_id, 'tierKey', p_tier_key);
  v_result jsonb;
begin
  v_ver := authz.lock_quotation_version(p_version_id);
  select * into v_q from public.quotations q where q.id = v_ver.quotation_id;
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  v_result := authz.finance_replay(v_ver.legal_entity_id, p_request_id, 'quotation_accept', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if v_ver.status = 'expired' then
    raise exception 'quotation_expired' using errcode = '55000';
  end if;
  if v_ver.status = 'superseded' then
    raise exception 'version_superseded' using errcode = '55000';
  end if;
  if v_ver.status <> 'sent' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  if p_expected_content_hash is distinct from v_ver.content_hash
     or v_ver.content_hash is distinct from authz.quotation_content_hash(v_ver.id) then
    raise exception 'version_changed' using errcode = 'PT409';
  end if;
  if p_tier_key is null or not exists (select 1 from public.quotation_version_tiers t
                                       where t.quotation_version_id = v_ver.id and t.tier_key = p_tier_key) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'tierKey';
  end if;
  if not exists (select 1 from public.quotation_evidence e
                 where e.id = p_evidence_id and e.quotation_version_id = v_ver.id
                   and e.kind = 'acceptance_message' and e.status = 'stored') then
    raise exception 'acceptance_proof_required' using errcode = '55000';
  end if;
  v_deal := coalesce(v_q.deal_id, v_q.linked_deal_id);
  if v_deal is not null then
    if authz.deal_not_active(v_deal) then
      raise exception 'deal_not_active' using errcode = '55000';
    end if;
    perform 1 from public.deals d where d.id = v_deal for no key update;
    if exists (select 1 from public.quotations o
               where o.id <> v_q.id and o.accepted_version_id is not null
                 and (o.deal_id = v_deal or o.linked_deal_id = v_deal)) then
      raise exception 'quotation_already_accepted' using errcode = '55000';
    end if;
  end if;
  -- An earlier accepted version of this quotation is superseded; the open draft is discarded.
  update public.quotation_versions v set status = 'superseded', superseded_at = now(), superseded_by_version_id = v_ver.id
  where v.quotation_id = v_q.id and v.status = 'accepted' returning v.id into v_superseded;
  update public.quotation_versions v set status = 'discarded', discarded_at = now(), discarded_by = (select auth.uid())
  where v.quotation_id = v_q.id and v.status in ('draft', 'ready') returning v.id into v_discarded;
  update public.quotation_versions v
  set status = 'accepted', accepted_at = now(), accepted_by = (select auth.uid()), accepted_tier = p_tier_key,
      acceptance_evidence_id = p_evidence_id, row_version = v.row_version + 1, updated_by = (select auth.uid())
  where v.id = v_ver.id returning * into v_ver;
  update public.quotations q set accepted_version_id = v_ver.id, row_version = q.row_version + 1, updated_at = now()
  where q.id = v_q.id;
  perform authz.write_audit('quotation.accepted', v_ver.legal_entity_id, v_q.branch_id, 'quotation_version', v_ver.id, null,
    jsonb_build_object('quotationId', v_q.id, 'versionNo', v_ver.version_no, 'tierKey', p_tier_key, 'evidenceId', p_evidence_id,
      'discardedVersionId', v_discarded, 'supersededVersionId', v_superseded));
  v_result := jsonb_build_object('status', 'accepted', 'acceptedTier', p_tier_key, 'quotationId', v_q.id,
    'discardedVersionId', v_discarded, 'supersededVersionId', v_superseded);
  perform authz.finance_remember(v_ver.legal_entity_id, p_request_id, 'quotation_accept', v_payload, v_result);
  return v_result;
end;
$$;

-- public.quotation_convert_to_booking(uuid, text, uuid): from 20261128000110_vn_booking_trip_rules.sql
create or replace function public.quotation_convert_to_booking(p_version_id uuid, p_expected_content_hash text, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.quotation_versions%rowtype;
  v_q public.quotations%rowtype;
  v_conv public.quotation_conversions%rowtype;
  v_deal uuid;
  v_opened jsonb;
  v_booking uuid;
  v_rv integer;
  v_added jsonb;
  v_item record;
  v_count integer := 0;
  v_contacts public.quotation_version_contacts%rowtype;
  v_auto text[];  -- Batch 2
  v_party integer;  -- booking form
begin
  v_ver := authz.lock_quotation_version(p_version_id);
  select * into v_q from public.quotations q where q.id = v_ver.quotation_id;
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  select * into v_conv from public.quotation_conversions c where c.quotation_version_id = v_ver.id;
  if v_conv.id is not null then
    return jsonb_build_object('outcome', 'existing', 'bookingVersionId', v_conv.booking_version_id, 'dealId', v_conv.deal_id,
      'itemsCreated', v_conv.items_created);
  end if;
  if v_ver.status <> 'accepted' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  if p_expected_content_hash is distinct from v_ver.content_hash
     or v_ver.content_hash is distinct from authz.quotation_content_hash(v_ver.id) then
    raise exception 'version_changed' using errcode = 'PT409';
  end if;
  v_deal := coalesce(v_q.deal_id, v_q.linked_deal_id);
  if v_deal is null then
    raise exception 'deal_link_required' using errcode = '55000';
  end if;
  perform authz.refuse_removed_deal(v_deal);
  if not authz.can_edit_booking_draft(v_deal) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if not authz.service_items_enabled() then
    raise exception 'service_items_disabled' using errcode = '55000';
  end if;
  if authz.deal_not_active(v_deal) then
    raise exception 'deal_not_active' using errcode = '55000';
  end if;
  -- Opens (or reuses) the package draft; refuses already_confirmed.
  -- Booking form: the draft follows form rules 2 (a reused empty draft moves 1 -> 2).
  perform set_config('tripnavigate.booking_form_rules', '2', true);
  v_opened := public.booking_open_draft(v_deal);
  v_booking := (v_opened ->> 'versionId')::uuid;
  v_rv := (v_opened ->> 'rowVersion')::integer;
  -- Batch 2 (BC-A3, F.1.3, Echo L8): values written only by the creation
  -- fill (mark from_bitrix, applied_via auto_fill, no staff history) are not
  -- staff content; neither are the fill's unmarked contact defaults. Any
  -- other content still refuses draft_not_empty.
  if exists (select 1 from public.booking_versions b
             where b.id = v_booking
               and (b.service_type <> 'package' or b.revises_version_id is not null
                    or b.trip_destination is not null or b.trip_scope is not null
                    -- Booking form: party counts are staff content.
                    or b.pax_total is not null or b.children_count is not null or b.infants_count is not null
                    or (b.trip_start is not null and not authz.prefill_auto_untouched('booking_version', b.id, 'trip.start'))
                    or (b.trip_end is not null and not authz.prefill_auto_untouched('booking_version', b.id, 'trip.end'))))
     or exists (select 1 from public.service_item_facts f where f.booking_version_id = v_booking)
     -- Echo L3 (F.1.3): on a draft that received the creation fill, any staff
     -- history (typed or cleared) is staff content. Drafts without a creation
     -- fill keep today's rule exactly (switch off = today).
     or (exists (select 1 from public.prefill_marks m
                 where m.target_kind = 'booking_version' and m.target_id = v_booking and m.applied_via = 'auto_fill')
         and exists (select 1 from public.prefill_field_history h
                     where h.target_kind = 'booking_version' and h.target_id = v_booking))
     or exists (select 1 from public.booking_version_contacts c
                where c.booking_version_id = v_booking
                  and not (authz.prefill_auto_untouched('booking_version', v_booking, 'contacts.contactName')
                           and (c.mobile is null or authz.prefill_auto_untouched('booking_version', v_booking, 'contacts.mobile'))
                           and (c.email is null or authz.prefill_auto_untouched('booking_version', v_booking, 'contacts.email'))
                           and (c.booking_for = 'individual'
                                or authz.prefill_auto_untouched('booking_version', v_booking, 'contacts.bookingFor'))
                           and not c.payer_different and c.payer_name is null and not c.contact_confirmed
                           and not exists (select 1 from public.prefill_field_history h
                                           where h.target_kind = 'booking_version' and h.target_id = v_booking
                                             and h.field_code like 'contacts.%')))
     or exists (select 1 from public.booking_version_commercials c where c.version_id = v_booking)
     or exists (select 1 from public.booking_version_instalments p where p.booking_version_id = v_booking)
     -- Booking form.
     or exists (select 1 from public.booking_version_price_lines l where l.booking_version_id = v_booking) then
    raise exception 'draft_not_empty' using errcode = '55000';
  end if;
  update public.booking_versions b set form_rules = 2 where b.id = v_booking and b.form_rules = 1;
  perform set_config('tripnavigate.booking_form_rules', '', true);
  -- The quotation's party (never more than the booking form's limit).
  v_party := v_ver.adults + v_ver.children_with_bed + v_ver.children_no_bed + v_ver.infants;
  if v_party not between 1 and 100 then
    v_party := null;
  end if;
  select coalesce(array_agg(m.field_code order by m.field_code), '{}'::text[]) into v_auto
  from public.prefill_marks m
  where m.target_kind = 'booking_version' and m.target_id = v_booking
    and authz.prefill_auto_untouched('booking_version', v_booking, m.field_code);

  insert into public.quotation_conversions (quotation_version_id, quotation_id, legal_entity_id, deal_id, booking_version_id,
    accepted_tier, request_id, created_by)
  values (v_ver.id, v_q.id, v_q.legal_entity_id, v_deal, v_booking, v_ver.accepted_tier, p_request_id, (select auth.uid()))
  returning * into v_conv;

  if coalesce(v_ver.trip_destination, v_ver.trip_scope) is not null or coalesce(v_ver.trip_start, v_ver.trip_end) is not null
     or v_party is not null then
    v_rv := (public.booking_trip_save(v_booking, v_rv, jsonb_build_object('destination', v_ver.trip_destination,
      'scope', v_ver.trip_scope, 'start', to_char(v_ver.trip_start, 'YYYY-MM-DD'), 'end', to_char(v_ver.trip_end, 'YYYY-MM-DD'))
      -- Booking form: the accepted party counts.
      || case when v_party is null then '{}'::jsonb
              else jsonb_build_object('paxTotal', v_party, 'children', v_ver.children_with_bed + v_ver.children_no_bed,
                                      'infants', v_ver.infants) end
      -- VN (lead ruling Q4): the quote's adults when its split is consistent
      -- and no named travellers of a type exceed it; else not recorded.
      || case when v_party is not null and v_ver.adults between 0 and 100
                   and not exists (
                     select 1 from public.deal_travellers t where t.deal_id = v_deal
                     group by t.traveller_type
                     having count(*) > case t.traveller_type when 'adult' then v_ver.adults
                                                             when 'child' then v_ver.children_with_bed + v_ver.children_no_bed
                                                             else v_ver.infants end)
              then jsonb_build_object('adults', v_ver.adults) else '{}'::jsonb end) ->> 'rowVersion')::integer;
  end if;
  select * into v_contacts from public.quotation_version_contacts c where c.quotation_version_id = v_ver.id;
  if v_contacts.quotation_version_id is not null then
    -- "Booking for" from the quotation (DEC-45 via prefill), else individual; staff confirm the contact.
    v_rv := (public.booking_contacts_save(v_booking, v_rv, jsonb_build_object('contactName', v_contacts.contact_name,
      'mobile', v_contacts.mobile, 'email', v_contacts.email, 'contactConfirmed', false,
      'bookingFor', coalesce(v_contacts.booking_for, 'individual'),
      'payerDifferent', false, 'payerName', null)) ->> 'rowVersion')::integer;
  end if;
  for v_item in
    select i.id, i.service_type, i.facts from public.quotation_version_items i
    where i.quotation_version_id = v_ver.id and (i.tier_key is null or i.tier_key = v_ver.accepted_tier)
    order by i.item_no
  loop
    v_added := public.service_item_add(v_booking, v_rv, v_item.service_type, v_item.facts, 0::bigint,
      md5(p_request_id::text || ':' || v_item.id::text)::uuid);
    v_rv := (v_added ->> 'rowVersion')::integer;
    insert into public.quotation_conversion_items (conversion_id, quotation_item_id, service_item_id)
    values (v_conv.id, v_item.id, (v_added ->> 'itemId')::uuid);
    v_count := v_count + 1;
  end loop;
  perform authz.quotation_money_to_booking(v_ver.id, v_booking, v_ver.accepted_tier);
  -- Booking form: per-person line quantities only (never amounts; the accepted total stays).
  if v_party is not null then
    insert into public.booking_version_price_lines (booking_version_id, legal_entity_id, deal_id, category, quantity, updated_by)
    select v_booking, v_q.legal_entity_id, v_deal, c.category, c.quantity, (select auth.uid())
    from (values ('adult', v_ver.adults), ('child_bed', v_ver.children_with_bed),
                 ('child_no_bed', v_ver.children_no_bed), ('infant', v_ver.infants)) as c(category, quantity);
  end if;
  -- Batch 2 (BC-A3): accepted quotation facts replaced the automatic values.
  update public.prefill_marks m set state = 'replaced_by_quotation', checked_by = null, checked_at = null
  where m.target_kind = 'booking_version' and m.target_id = v_booking and m.field_code = any (v_auto);
  update public.booking_versions b
  set source_quotation_version_id = v_ver.id, source_quotation_hash = v_ver.content_hash, source_accepted_tier = v_ver.accepted_tier
  where b.id = v_booking;
  update public.quotation_conversions c
  set items_created = v_count,
      money_signature = authz.booking_quote_money_signature(v_booking),
      facts_signature = authz.booking_quote_facts_signature(v_booking),
      minor_signature = authz.booking_quote_minor_signature(v_booking)
  where c.id = v_conv.id;
  update public.quotations q set converted_at = now(), row_version = q.row_version + 1, updated_at = now() where q.id = v_q.id;
  perform authz.write_audit('quotation.converted', v_q.legal_entity_id, v_q.branch_id, 'quotation_version', v_ver.id, null,
    jsonb_build_object('quotationId', v_q.id, 'dealId', v_deal, 'bookingVersionId', v_booking, 'itemsCreated', v_count,
      'tierKey', v_ver.accepted_tier)
    || case when cardinality(v_auto) > 0 then jsonb_build_object('replacedAutoFields', to_jsonb(v_auto)) else '{}'::jsonb end);
  return jsonb_build_object('outcome', 'created', 'bookingVersionId', v_booking, 'dealId', v_deal, 'itemsCreated', v_count);
end;
$$;

-- public.quotation_create(text, uuid, text, uuid): from 20261123000100_referral_drafts.sql
create or replace function public.quotation_create(p_subject_kind text, p_subject_id uuid, p_title text, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_entity uuid;
  v_branch uuid;
  v_owner uuid;
  v_title text := btrim(coalesce(p_title, ''), E' \t\r\n');
  v_existing public.quotations%rowtype;
  v_no integer;
  v_q public.quotations%rowtype;
  v_ver public.quotation_versions%rowtype;
  v_fill jsonb;  -- Batch 2
  v_draft public.referral_drafts%rowtype;  -- Batch 3
begin
  if p_subject_kind is null or p_subject_kind not in ('lead', 'deal', 'referral') or p_subject_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'subjectKind';
  end if;
  if p_subject_kind = 'deal' then
    perform authz.refuse_removed_deal(p_subject_id);
    if not authz.can_edit_booking_draft(p_subject_id) then
      raise exception 'not_authorized' using errcode = '42501';
    end if;
    if authz.deal_not_active(p_subject_id) then
      raise exception 'deal_not_active' using errcode = '55000';
    end if;
    select d.legal_entity_id, d.branch_id, d.owner_user_id into v_entity, v_branch, v_owner
    from public.deals d where d.id = p_subject_id;
  elsif p_subject_kind = 'referral' then
    -- Batch 3: authorization first, then the draft row (draft_closed). Works
    -- while the switch is off (DEC-54).
    if not authz.referral_draft_can_edit(p_subject_id) then
      raise exception 'not_authorized' using errcode = '42501';
    end if;
    v_draft := authz.referral_draft_lock_write(p_subject_id);
    v_entity := v_draft.legal_entity_id;
    v_branch := v_draft.branch_id;
    v_owner := v_draft.owner_user_id;
  else
    if not authz.quotation_lead_editor(p_subject_id) then
      raise exception 'not_authorized' using errcode = '42501';
    end if;
    select l.legal_entity_id, l.branch_id, l.owner_user_id into v_entity, v_branch, v_owner
    from public.crm_leads l where l.id = p_subject_id;
  end if;
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  if length(v_title) not between 1 and 200 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'title';
  end if;

  select * into v_existing from public.quotations q where q.created_by = (select auth.uid()) and q.request_id = p_request_id;
  if v_existing.id is not null then
    if v_existing.title is distinct from v_title
       or (p_subject_kind = 'deal' and v_existing.deal_id is distinct from p_subject_id)
       or (p_subject_kind = 'lead' and v_existing.lead_id is distinct from p_subject_id)
       or (p_subject_kind = 'referral' and v_existing.referral_draft_id is distinct from p_subject_id) then  -- Batch 3
      raise exception 'request_conflict' using errcode = 'PT409';
    end if;
    select * into v_ver from public.quotation_versions v where v.quotation_id = v_existing.id and v.version_no = 1;
    return jsonb_build_object('quotationId', v_existing.id, 'reference', v_existing.reference, 'versionId', v_ver.id,
      'versionNo', 1, 'rowVersion', v_ver.row_version, 'created', false,
      'autoFill', 'existing_draft', 'filled', '[]'::jsonb, 'skipped', '[]'::jsonb);  -- Batch 2: a replay fills nothing
  end if;

  insert into public.quotation_counters as c (legal_entity_id, last_no) values (v_entity, 1)
  on conflict (legal_entity_id) do update set last_no = c.last_no + 1
  returning c.last_no into v_no;
  insert into public.quotations (legal_entity_id, branch_id, quote_no, reference, lead_id, deal_id, referral_draft_id, title,
    owner_user_id, request_id, created_by)
  values (v_entity, v_branch, v_no, 'TQ-' || v_no::text,
    case when p_subject_kind = 'lead' then p_subject_id end, case when p_subject_kind = 'deal' then p_subject_id end,
    case when p_subject_kind = 'referral' then p_subject_id end,  -- Batch 3
    v_title, v_owner, p_request_id, (select auth.uid()))
  returning * into v_q;
  insert into public.quotation_versions (quotation_id, legal_entity_id, version_no, created_by, updated_by)
  values (v_q.id, v_entity, 1, (select auth.uid()), (select auth.uid()))
  returning * into v_ver;
  insert into public.quotation_version_tiers (quotation_version_id, legal_entity_id, tier_key) values (v_ver.id, v_entity, 'quoted');

  perform authz.write_audit('quotation.created', v_entity, v_branch, 'quotation', v_q.id, null,
    jsonb_build_object('subjectKind', p_subject_kind, 'subjectId', p_subject_id, 'reference', v_q.reference, 'versionId', v_ver.id));
  -- Batch 2 (C1): the creation fill of version 1 (switch on; never blocks the creation).
  -- Batch 3: a referral draft has no Bitrix record to fill from (after linking only
  -- the explicit Fill empty fields can fill, F.1.3).
  v_fill := case when p_subject_kind = 'referral'
                 then jsonb_build_object('autoFill', 'unavailable', 'filled', '[]'::jsonb, 'skipped', '[]'::jsonb)
                 else authz.prefill_fill_on_create('quotation_version', v_ver.id) end;
  return jsonb_build_object('quotationId', v_q.id, 'reference', v_q.reference, 'versionId', v_ver.id, 'versionNo', 1,
    'rowVersion', coalesce((v_fill ->> 'rowVersion')::integer, v_ver.row_version), 'created', true,
    'autoFill', v_fill ->> 'autoFill', 'filled', v_fill -> 'filled', 'skipped', v_fill -> 'skipped');
end;
$$;

-- public.quotation_create_standalone(uuid, jsonb, text, uuid): from 20261123000100_referral_drafts.sql
create or replace function public.quotation_create_standalone(p_branch_id uuid, p_customer jsonb, p_title text, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_start record;
  v_res jsonb;
  v_ver uuid;
  v_q public.quotations%rowtype;
begin
  select * into v_start from authz.referral_draft_start(p_branch_id, p_customer, p_title, p_request_id, 'quotation');
  if not v_start.o_created then
    select * into v_q from public.quotations q
    where q.referral_draft_id = (v_start.o_draft).id and q.created_by = (select auth.uid()) and q.request_id = p_request_id;
    if v_q.id is null or v_q.title is distinct from btrim(coalesce(p_title, ''), E' \t\r\n') then
      raise exception 'request_conflict' using errcode = 'PT409';
    end if;
    return jsonb_build_object('referralDraftId', (v_start.o_draft).id, 'referralReference', (v_start.o_draft).reference,
      'quotationId', v_q.id, 'reference', v_q.reference,
      'versionId', (select v.id from public.quotation_versions v where v.quotation_id = v_q.id and v.version_no = 1),
      'versionNo', 1,
      'rowVersion', (select v.row_version from public.quotation_versions v where v.quotation_id = v_q.id and v.version_no = 1),
      'created', false, 'possibleDuplicates', authz.referral_duplicates((v_start.o_draft).id));
  end if;
  v_res := public.quotation_create('referral', (v_start.o_draft).id, p_title, p_request_id);
  v_ver := (v_res ->> 'versionId')::uuid;
  -- Values staff typed at creation are staff writes (the contacts watcher
  -- records them in the value-free history, F.1.1).
  if (v_start.o_draft).mobile is not null or (v_start.o_draft).email is not null then
    insert into public.quotation_version_contacts (quotation_version_id, legal_entity_id, contact_name, mobile, email, company_name,
      updated_by)
    values (v_ver, (v_start.o_draft).legal_entity_id, (v_start.o_draft).customer_name, (v_start.o_draft).mobile,
      (v_start.o_draft).email, (v_start.o_draft).company_name, (select auth.uid()));
  end if;
  return jsonb_build_object('referralDraftId', (v_start.o_draft).id, 'referralReference', (v_start.o_draft).reference,
    'quotationId', v_res -> 'quotationId', 'reference', v_res -> 'reference', 'versionId', v_ver, 'versionNo', 1,
    'rowVersion', v_res -> 'rowVersion', 'created', true,
    'possibleDuplicates', authz.referral_duplicates((v_start.o_draft).id));
end;
$$;

-- public.quotation_mark_sent(uuid, text, text, uuid): from 20261120000200_b12_quotations.sql
create or replace function public.quotation_mark_sent(p_version_id uuid, p_expected_content_hash text, p_channel text, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.quotation_versions%rowtype;
  v_q public.quotations%rowtype;
  v_old uuid;
  v_payload jsonb := jsonb_build_object('versionId', p_version_id, 'hash', p_expected_content_hash, 'channel', p_channel);
  v_result jsonb;
begin
  v_ver := authz.lock_quotation_version(p_version_id);
  select * into v_q from public.quotations q where q.id = v_ver.quotation_id;
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  v_result := authz.finance_replay(v_ver.legal_entity_id, p_request_id, 'quotation_mark_sent', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if v_q.converted_at is not null then
    raise exception 'quotation_converted' using errcode = '55000';
  end if;
  if v_ver.status <> 'ready' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  if p_expected_content_hash is distinct from v_ver.content_hash
     or v_ver.content_hash is distinct from authz.quotation_content_hash(v_ver.id) then
    raise exception 'version_changed' using errcode = 'PT409';
  end if;
  if p_channel is null or p_channel not in ('whatsapp', 'email', 'in_person', 'phone', 'other') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'channel';
  end if;
  if v_ver.valid_until < authz.finance_today() then
    raise exception 'valid_until_past' using errcode = '22023';
  end if;
  -- Supersede the live sent version, or (review E2-3) the accepted but not yet
  -- converted version: the customer accepts the new version again.
  update public.quotation_versions v set status = 'superseded', superseded_at = now(), superseded_by_version_id = v_ver.id
  where v.quotation_id = v_ver.quotation_id and v.status in ('sent', 'accepted') returning v.id into v_old;
  if v_q.accepted_version_id is not null then
    update public.quotations q set accepted_version_id = null, row_version = q.row_version + 1, updated_at = now()
    where q.id = v_q.id;
  end if;
  update public.quotation_versions v
  set status = 'sent', sent_at = now(), sent_by = (select auth.uid()), sent_channel = p_channel,
      row_version = v.row_version + 1, updated_by = (select auth.uid())
  where v.id = v_ver.id returning * into v_ver;
  if v_old is not null then
    perform authz.write_audit('quotation.superseded', v_ver.legal_entity_id, v_q.branch_id, 'quotation_version', v_old, null,
      jsonb_build_object('quotationId', v_q.id, 'byVersionId', v_ver.id));
  end if;
  perform authz.write_audit('quotation.marked_sent', v_ver.legal_entity_id, v_q.branch_id, 'quotation_version', v_ver.id, null,
    jsonb_build_object('quotationId', v_q.id, 'versionNo', v_ver.version_no, 'channel', p_channel));
  v_result := jsonb_build_object('status', 'sent', 'validUntil', to_char(v_ver.valid_until, 'YYYY-MM-DD'),
    'supersededVersionId', v_old, 'rowVersion', v_ver.row_version);
  perform authz.finance_remember(v_ver.legal_entity_id, p_request_id, 'quotation_mark_sent', v_payload, v_result);
  return v_result;
end;
$$;

-- public.service_item_file_begin(uuid, uuid, text, jsonb, uuid): from 20261124000110_booking_form_commands.sql
create or replace function public.service_item_file_begin(p_item_id uuid, p_version_id uuid, p_kind text, p_file jsonb,
  p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_item public.service_items%rowtype;
  v_deal public.deals%rowtype;
  v_existing public.service_item_files%rowtype;
  v_name text;
  v_mime text;
  v_size integer;
  v_sha text;
  v_id uuid := gen_random_uuid();
  v_path text;
begin
  select * into v_item from public.service_items i where i.id = p_item_id;
  perform authz.refuse_removed_deal(v_item.deal_id);
  select * into v_deal from public.deals d where d.id = v_item.deal_id for no key update;
  if v_deal.id is null or not authz.can_edit_booking_draft(v_deal.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if not authz.service_items_enabled() then
    raise exception 'service_items_disabled' using errcode = '55000';
  end if;
  if authz.deal_not_active(v_deal.id) then
    raise exception 'deal_not_active' using errcode = '55000';
  end if;
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  if p_kind is distinct from 'flight_screenshot' or v_item.service_type <> 'flight' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'kind';
  end if;
  if not exists (select 1 from public.service_item_facts f join public.booking_versions v on v.id = f.booking_version_id
                 where f.service_item_id = v_item.id and f.booking_version_id = p_version_id and v.deal_id = v_deal.id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if p_file is null or jsonb_typeof(p_file) <> 'object'
     or cardinality(authz.b11_unknown_keys(p_file, array['fileName', 'mime', 'sizeBytes', 'sha256'])) > 0
     or jsonb_typeof(p_file -> 'fileName') is distinct from 'string'
     or jsonb_typeof(p_file -> 'mime') is distinct from 'string'
     or not authz.sf_int_ok(p_file -> 'sizeBytes', 1, 2147483647, true)
     or jsonb_typeof(p_file -> 'sha256') is distinct from 'string' then
    raise exception 'evidence_rejected' using errcode = '22023';
  end if;
  v_name := btrim(left(btrim(regexp_replace(p_file ->> 'fileName', '[^A-Za-z0-9._ -]', '_', 'g')), 120));
  v_mime := p_file ->> 'mime';
  v_size := (p_file #>> '{sizeBytes}')::integer;
  v_sha := lower(btrim(p_file ->> 'sha256'));

  select * into v_existing from public.service_item_files f where f.deal_id = v_deal.id and f.request_id = p_request_id;
  if v_existing.id is not null then
    if v_existing.uploaded_by is distinct from (select auth.uid()) or v_existing.service_item_id is distinct from v_item.id
       or v_existing.booking_version_id is distinct from p_version_id
       or v_existing.file_name is distinct from v_name or v_existing.mime is distinct from v_mime
       or v_existing.size_bytes is distinct from v_size or v_existing.sha256 is distinct from v_sha then
      raise exception 'request_conflict' using errcode = 'PT409';
    end if;
    return jsonb_build_object('fileId', v_existing.id, 'outcome', 'existing', 'status', v_existing.status,
      'rowVersion', v_existing.row_version,
      'objectPath', case when v_existing.status = 'pending_upload' then v_existing.object_path end);
  end if;

  if v_name = '' or v_name ~ '^[. ]+$'
     or v_mime not in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')
     or v_size > authz.id_proof_max_bytes() or v_sha !~ '^[0-9a-f]{64}$' then
    raise exception 'evidence_rejected' using errcode = '22023';
  end if;
  if (select count(*) from public.service_item_files f
      where f.service_item_id = v_item.id and f.status in ('pending_upload', 'stored')) >= 5 then
    raise exception 'item_file_limit' using errcode = '55000';
  end if;

  v_path := v_deal.legal_entity_id::text || '/' || v_deal.id::text || '/' || v_item.id::text || '/' || v_id::text;
  insert into public.service_item_files (id, deal_id, legal_entity_id, service_item_id, booking_version_id, kind,
    request_id, object_path, file_name, mime, size_bytes, sha256, uploaded_by)
  values (v_id, v_deal.id, v_deal.legal_entity_id, v_item.id, p_version_id, p_kind, p_request_id, v_path, v_name,
    v_mime, v_size, v_sha, (select auth.uid()));
  -- No file name in the audit record.
  perform authz.write_audit('booking.item_file_started', v_deal.legal_entity_id, v_deal.branch_id, 'service_item_file', v_id,
    null, jsonb_build_object('dealId', v_deal.id, 'itemNo', v_item.item_no, 'fileId', v_id, 'kind', p_kind,
      'mime', v_mime, 'sizeBytes', v_size));
  return jsonb_build_object('fileId', v_id, 'outcome', 'created', 'status', 'pending_upload', 'rowVersion', 1,
    'objectPath', v_path);
end;
$$;

-- public.supplier_approve_beneficiary(uuid, integer): from 20261005000200_procurement_owner_decisions.sql
create or replace function public.supplier_approve_beneficiary(p_supplier_id uuid, p_revision_no integer) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_s public.suppliers%rowtype;
  v_r public.supplier_beneficiary_revisions%rowtype;
  v_uid uuid := (select auth.uid());
  v_latest integer;
begin
  select * into v_s from public.suppliers s where s.id = p_supplier_id for update;
  if v_s.id is null or not authz.can_verify_suppliers(v_s.legal_entity_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if authz.deployment_environment() = 'unset' then
    raise exception 'environment_unset' using errcode = '55000';
  end if;
  select * into v_r from public.supplier_beneficiary_revisions r
  where r.supplier_id = v_s.id and r.revision_no = p_revision_no for update;
  if v_r.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v_r.status = 'approved' then
    return jsonb_build_object('revisionNo', v_r.revision_no, 'status', 'approved', 'outcome', 'existing');
  end if;
  if v_r.created_by = v_uid then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select max(r.revision_no) into v_latest from public.supplier_beneficiary_revisions r where r.supplier_id = v_s.id;
  if v_r.revision_no <> v_latest then
    raise exception 'version_changed' using errcode = 'PT409';
  end if;
  update public.supplier_beneficiary_revisions r
  set status = 'approved', approved_by = v_uid, approved_at = now()
  where r.id = v_r.id;
  -- No bank values in the audit trail.
  perform authz.write_audit('supplier.beneficiary_approved', v_s.legal_entity_id, null, 'supplier', v_s.id, null,
    jsonb_build_object('revisionNo', v_r.revision_no));
  return jsonb_build_object('revisionNo', v_r.revision_no, 'status', 'approved', 'outcome', 'created');
end;
$$;

-- public.supplier_contact_remove(uuid, integer, text, uuid): from 20261204000110_supplier_master_commands.sql
create or replace function public.supplier_contact_remove(p_contact_id uuid, p_expected_row_version integer, p_reason text,
  p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_supplier uuid;
  v_s public.suppliers%rowtype;
  v_old public.supplier_contacts%rowtype;
  v_c public.supplier_contacts%rowtype;
  v_next uuid;
  v_uid uuid := (select auth.uid());
  v_reason text := btrim(coalesce(p_reason, ''), E' \t\r\n');
  v_payload jsonb := jsonb_build_object('contactId', p_contact_id, 'expectedRowVersion', p_expected_row_version,
    'reason', p_reason);
  v_result jsonb;
  v_rv integer;
begin
  select c.supplier_id into v_supplier from public.supplier_contacts c where c.id = p_contact_id;
  -- 13.1: the supplier row first, then the contact.
  select * into v_s from public.suppliers s where s.id = v_supplier for update;
  if v_s.id is null or not authz.supplier_can_edit(v_s.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if authz.deployment_environment() = 'unset' then
    raise exception 'environment_unset' using errcode = '55000';
  end if;
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  v_result := authz.finance_replay(v_s.legal_entity_id, p_request_id, 'supplier_contact_remove', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  select * into v_old from public.supplier_contacts c where c.id = p_contact_id for update;
  if v_old.status <> 'active' then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if p_expected_row_version is distinct from v_old.row_version then
    raise exception 'version_changed' using errcode = 'PT409';
  end if;
  if char_length(v_reason) not between 10 and 300 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'reason';
  end if;
  update public.supplier_contacts c
  set status = 'removed', is_primary = false, removed_by = v_uid, removed_at = now(), remove_reason = v_reason,
      row_version = c.row_version + 1, updated_by = v_uid, updated_at = now()
  where c.id = v_old.id
  returning * into v_c;
  -- Removing the primary promotes the most recently changed other active contact (else the legacy columns clear).
  if v_old.is_primary then
    select c.id into v_next from public.supplier_contacts c
    where c.supplier_id = v_s.id and c.status = 'active'
    order by c.updated_at desc, c.id desc limit 1 for update;
    if v_next is not null then
      update public.supplier_contacts c set is_primary = true, row_version = c.row_version + 1, updated_by = v_uid,
        updated_at = now()
      where c.id = v_next;
    end if;
  end if;
  insert into public.supplier_changes (legal_entity_id, supplier_id, changed_by, source, field, old_value, new_value, request_id)
  values (v_s.legal_entity_id, v_s.id, v_uid, 'contact', 'contact:' || v_c.id, authz.supplier_contact_note(v_old),
    authz.supplier_contact_note(v_c), p_request_id);
  v_rv := authz.supplier_sync_legacy(v_s.id);
  perform authz.write_audit('supplier.contact_removed', v_s.legal_entity_id, null, 'supplier', v_s.id, v_reason,
    jsonb_build_object('supplierId', v_s.id, 'contactId', v_c.id, 'promotedContactId', v_next));
  v_result := jsonb_build_object('outcome', 'updated', 'contactId', v_c.id, 'supplierRowVersion', v_rv);
  return authz.finance_remember(v_s.legal_entity_id, p_request_id, 'supplier_contact_remove', v_payload, v_result);
end;
$$;

-- public.supplier_contact_save(uuid, uuid, integer, jsonb, uuid): from 20261204000110_supplier_master_commands.sql
create or replace function public.supplier_contact_save(p_supplier_id uuid, p_contact_id uuid, p_expected_row_version integer,
  p_fields jsonb, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_s public.suppliers%rowtype;
  v_old public.supplier_contacts%rowtype;
  v_c public.supplier_contacts%rowtype;
  v_uid uuid := (select auth.uid());
  v_payload jsonb := jsonb_build_object('supplierId', p_supplier_id, 'contactId', p_contact_id,
    'expectedRowVersion', p_expected_row_version, 'fields', p_fields);
  v_result jsonb;
  v_name text;
  v_role text;
  v_phone text;
  v_email text;
  v_primary boolean;
  v_has_primary boolean;
  v_rv integer;
begin
  select * into v_s from public.suppliers s where s.id = p_supplier_id for update;
  if v_s.id is null or not authz.supplier_can_edit(v_s.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if authz.deployment_environment() = 'unset' then
    raise exception 'environment_unset' using errcode = '55000';
  end if;
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  v_result := authz.finance_replay(v_s.legal_entity_id, p_request_id, 'supplier_contact_save', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if p_fields is null or jsonb_typeof(p_fields) <> 'object'
     or (p_fields - array['name', 'roleLabel', 'phone', 'email', 'isPrimary']) <> '{}'::jsonb then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fields';
  end if;
  if p_contact_id is not null then
    select * into v_old from public.supplier_contacts c where c.id = p_contact_id and c.supplier_id = v_s.id for update;
    if v_old.id is null or v_old.status <> 'active' then
      raise exception 'not_found' using errcode = 'P0002';
    end if;
    if p_expected_row_version is distinct from v_old.row_version then
      raise exception 'version_changed' using errcode = 'PT409';
    end if;
  elsif coalesce(p_expected_row_version, 0) <> 0 then
    raise exception 'version_changed' using errcode = 'PT409';
  end if;
  v_name := authz.supplier_text(p_fields, 'name', 120, false);
  if v_name is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'name';
  end if;
  v_role := authz.supplier_text(p_fields, 'roleLabel', 60, false);
  v_phone := authz.supplier_text(p_fields, 'phone', 40, false);
  if v_phone is not null and v_phone !~ '^[0-9+() -]{6,40}$' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'phone';
  end if;
  v_email := lower(authz.supplier_text(p_fields, 'email', 254, false));
  if v_email is not null and v_email !~ '^[^@[:space:]]{1,64}@[^@[:space:]]+\.[^@[:space:]]{2,}$' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'email';
  end if;
  if v_phone is null and v_email is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'phone';
  end if;
  if p_fields ? 'isPrimary' and jsonb_typeof(p_fields -> 'isPrimary') <> 'boolean' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'isPrimary';
  end if;
  v_has_primary := exists (select 1 from public.supplier_contacts c
                           where c.supplier_id = v_s.id and c.status = 'active' and c.is_primary
                             and c.id is distinct from p_contact_id);
  -- A first contact is primary unless the form says otherwise; an edit keeps its flag.
  v_primary := coalesce((p_fields ->> 'isPrimary')::boolean, case when v_old.id is null then not v_has_primary else v_old.is_primary end);
  if v_primary then
    update public.supplier_contacts c set is_primary = false, row_version = c.row_version + 1, updated_by = v_uid,
      updated_at = now()
    where c.supplier_id = v_s.id and c.status = 'active' and c.is_primary and c.id is distinct from p_contact_id;
  end if;

  begin
    if v_old.id is null then
      insert into public.supplier_contacts (legal_entity_id, supplier_id, name, role_label, phone, email, is_primary,
        created_by, updated_by)
      values (v_s.legal_entity_id, v_s.id, v_name, v_role, v_phone, v_email, v_primary, v_uid, v_uid)
      returning * into v_c;
    else
      update public.supplier_contacts c
      set name = v_name, role_label = v_role, phone = v_phone, email = v_email, is_primary = v_primary,
          row_version = c.row_version + 1, updated_by = v_uid, updated_at = now()
      where c.id = v_old.id
      returning * into v_c;
    end if;
  exception when check_violation then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fields';
  end;

  if authz.supplier_contact_note(v_old) is distinct from authz.supplier_contact_note(v_c) then
    insert into public.supplier_changes (legal_entity_id, supplier_id, changed_by, source, field, old_value, new_value, request_id)
    values (v_s.legal_entity_id, v_s.id, v_uid, 'contact', 'contact:' || v_c.id, authz.supplier_contact_note(v_old),
      authz.supplier_contact_note(v_c), p_request_id);
  end if;
  v_rv := authz.supplier_sync_legacy(v_s.id);
  perform authz.write_audit('supplier.contact_saved', v_s.legal_entity_id, null, 'supplier', v_s.id, null,
    jsonb_build_object('supplierId', v_s.id, 'contactId', v_c.id, 'primary', v_c.is_primary));
  v_result := jsonb_build_object('outcome', case when v_old.id is null then 'created' else 'updated' end,
    'contactId', v_c.id, 'rowVersion', v_c.row_version, 'supplierRowVersion', v_rv);
  return authz.finance_remember(v_s.legal_entity_id, p_request_id, 'supplier_contact_save', v_payload, v_result);
end;
$$;

-- public.supplier_document_review(uuid, text, text, integer, uuid): from 20261130000200_supplier_money.sql
create or replace function public.supplier_document_review(
  p_document_id uuid, p_decision text, p_reason text, p_expected_row_version integer, p_request_id uuid
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v public.supplier_documents%rowtype;
  v_synthetic boolean;
  v_reason text;
  v_payload jsonb := jsonb_build_object('documentId', p_document_id, 'decision', p_decision, 'reason', p_reason,
    'expectedRowVersion', p_expected_row_version);
  v_result jsonb;
begin
  select * into v from public.supplier_documents s where s.id = p_document_id;
  if v.id is null then
    if coalesce(authz.session_ok(), false) then
      raise exception 'not_found' using errcode = 'P0002';
    end if;
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select d.is_synthetic into v_synthetic from public.deals d where d.id = v.deal_id;
  perform authz.finance_require_accounts(v.legal_entity_id, v_synthetic);
  select * into v from public.supplier_documents s where s.id = p_document_id for update;
  v_result := authz.sm_replay(v.legal_entity_id, p_request_id, 'supplier_document_review', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if p_decision is null or p_decision not in ('accept', 'return') then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  if v.uploaded_by = v_uid then
    raise exception 'not_self_approval' using errcode = '42501';
  end if;
  if v.status <> 'uploaded' then
    raise exception 'already_decided' using errcode = '55000';
  end if;
  if p_expected_row_version is distinct from v.row_version then
    raise exception 'version_changed' using errcode = 'PT409';
  end if;
  if p_decision = 'accept' then
    update public.supplier_documents s
    set status = 'accepted', reviewed_by = v_uid, reviewed_at = now(), row_version = s.row_version + 1, updated_at = now()
    where s.id = v.id returning * into v;
  else
    v_reason := authz.finance_reason(p_reason);
    update public.supplier_documents s
    set status = 'returned', return_reason = v_reason, reviewed_by = v_uid, reviewed_at = now(),
        row_version = s.row_version + 1, updated_at = now()
    where s.id = v.id returning * into v;
  end if;
  perform authz.write_audit(case when p_decision = 'accept' then 'finance.supplier_document_accepted'
                                 else 'finance.supplier_document_returned' end,
    v.legal_entity_id, v.branch_id, 'fulfilment_task', v.task_id, null,
    jsonb_build_object('documentId', v.id, 'kind', v.kind));
  v_result := jsonb_build_object('outcome', 'created', 'id', v.id, 'status', v.status, 'rowVersion', v.row_version);
  return authz.sm_remember(v.legal_entity_id, p_request_id, 'supplier_document_review', v_payload, v_result);
end;
$$;

-- public.supplier_payment_decide(uuid, text, text, integer, uuid): from 20261201000210_flight_money_commands.sql
create or replace function public.supplier_payment_decide(
  p_payment_id uuid, p_decision text, p_reason text, p_expected_row_version integer, p_request_id uuid
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v public.supplier_payment_requests%rowtype;
  v_reason text;
  v_payload jsonb := jsonb_build_object('paymentId', p_payment_id, 'decision', p_decision, 'reason', p_reason,
    'expectedRowVersion', p_expected_row_version);
  v_result jsonb;
begin
  v := authz.sm_payment_for_command(p_payment_id, 'decider');
  v_result := authz.sm_replay(v.legal_entity_id, p_request_id, 'supplier_payment_decide', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if p_decision is null or p_decision not in ('approve', 'return') then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  -- Never the requester, the Deal's owner or its Sales assignee (review F6).
  if v.requested_by = v_uid or authz.finance_deal_conflict(v.deal_id) then
    raise exception 'not_self_approval' using errcode = '42501';
  end if;
  -- Flight build: never the Deal's Flight person for a flight payment.
  if v.flight_batch_id is not null and authz.flight_is_deal_assignee(v.deal_id) then
    raise exception 'not_self_approval' using errcode = '42501';
  end if;
  -- Decisions are final, except that an approved request still on hold
  -- (bank details or company funding) may be returned so it stops blocking.
  if not (v.status = 'pending'
          or (p_decision = 'return' and v.status = 'approved' and authz.sm_hold_reason(v.id) is not null)) then
    raise exception 'already_decided' using errcode = '55000';
  end if;
  if p_expected_row_version is distinct from v.row_version then
    raise exception 'version_changed' using errcode = 'PT409';
  end if;

  if p_decision = 'approve' then
    perform authz.sm_payment_still_valid(v.id);
    if v.customer_money_paise > authz.sm_customer_money_available(v.deal_id, v.id) then
      raise exception 'customer_money_short' using errcode = '55000';
    end if;
    update public.supplier_payment_requests p
    set status = 'approved', decided_by = v_uid, decided_at = now(), approved_by = v_uid, approved_at = now(),
        row_version = p.row_version + 1, updated_at = now()
    where p.id = v.id returning * into v;
  else
    v_reason := authz.finance_reason(p_reason);
    update public.supplier_payment_requests p
    set status = 'returned', return_reason = v_reason, decided_by = v_uid, decided_at = now(),
        approved_by = null, approved_at = null,
        row_version = p.row_version + 1, updated_at = now()
    where p.id = v.id returning * into v;
  end if;

  perform authz.write_audit(case when p_decision = 'approve' then 'finance.supplier_payment_approved'
                                 else 'finance.supplier_payment_returned' end,
    v.legal_entity_id, v.branch_id, 'fulfilment_task', v.task_id, null,
    jsonb_build_object('paymentRequestId', v.id, 'refNo', v.ref_no, 'route', v.route));
  v_result := jsonb_build_object('outcome', 'created', 'id', v.id, 'status', v.status, 'rowVersion', v.row_version);
  return authz.sm_remember(v.legal_entity_id, p_request_id, 'supplier_payment_decide', v_payload, v_result);
end;
$$;

-- public.supplier_payment_record(uuid, date, text, text, uuid, integer, uuid): from 20261130000200_supplier_money.sql
create or replace function public.supplier_payment_record(
  p_payment_id uuid, p_paid_on date, p_mode text, p_bank_reference text, p_proof_evidence_id uuid,
  p_expected_row_version integer, p_request_id uuid
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v public.supplier_payment_requests%rowtype;
  v_funding text;
  v_revision integer;
  v_ref text;
  v_payload jsonb := jsonb_build_object('paymentId', p_payment_id, 'paidOn', p_paid_on, 'mode', p_mode,
    'bankReference', p_bank_reference, 'proofEvidenceId', p_proof_evidence_id,
    'expectedRowVersion', p_expected_row_version);
  v_result jsonb;
begin
  v := authz.sm_payment_for_command(p_payment_id, 'accounts');
  v_result := authz.sm_replay(v.legal_entity_id, p_request_id, 'supplier_payment_record', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if v.status <> 'approved' then
    raise exception 'already_decided' using errcode = '55000';
  end if;
  if p_expected_row_version is distinct from v.row_version then
    raise exception 'version_changed' using errcode = 'PT409';
  end if;
  v_ref := authz.finance_text(p_bank_reference, 4, 40, false);
  if p_paid_on is null or p_paid_on not between date '2000-01-01' and authz.finance_today()
     or p_mode is null or p_mode not in ('bank_transfer', 'upi', 'cheque')
     or v_ref is null or v_ref !~ '^[A-Za-z0-9/. -]+$' or p_proof_evidence_id is null then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  perform authz.sm_payment_still_valid(v.id);
  select r.revision_no into v_revision from public.supplier_beneficiary_revisions r
  where r.supplier_id = v.supplier_id order by r.revision_no desc limit 1;
  if not authz.sm_bank_approved(v.supplier_id) then
    raise exception 'bank_details_on_hold' using errcode = '55000';
  end if;
  select f.status into v_funding from public.company_funding_requests f where f.payment_request_id = v.id for update;
  if v_funding is not null and v_funding not in ('approved', 'recovered') then
    raise exception 'funding_pending' using errcode = '55000';
  end if;
  if not exists (select 1 from public.supplier_money_evidence e
                 where e.id = p_proof_evidence_id and e.payment_request_id = v.id
                   and e.kind = 'payment_proof' and e.status = 'stored') then
    raise exception 'evidence_rejected' using errcode = '22023';
  end if;

  update public.supplier_payment_requests p
  set status = 'paid', paid_on = p_paid_on, payment_mode = p_mode, bank_reference = v_ref,
      payment_proof_evidence_id = p_proof_evidence_id, bank_revision_no = v_revision,
      recorded_by = v_uid, recorded_at = now(), row_version = p.row_version + 1, updated_at = now()
  where p.id = v.id returning * into v;
  -- No bank values or amounts in the audit trail.
  perform authz.write_audit('finance.supplier_payment_recorded', v.legal_entity_id, v.branch_id, 'fulfilment_task',
    v.task_id, null, jsonb_build_object('paymentRequestId', v.id, 'refNo', v.ref_no, 'mode', p_mode,
      'bankRevisionNo', v_revision));
  v_result := jsonb_build_object('outcome', 'created', 'id', v.id, 'status', v.status, 'rowVersion', v.row_version);
  return authz.sm_remember(v.legal_entity_id, p_request_id, 'supplier_payment_record', v_payload, v_result);
end;
$$;

-- public.supplier_payment_request_cancel(uuid, integer, uuid): from 20261203000120_phase0_flight_cancel.sql
create or replace function public.supplier_payment_request_cancel(p_payment_id uuid, p_expected_row_version integer, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v public.supplier_payment_requests%rowtype;
  v_payload jsonb := jsonb_build_object('paymentId', p_payment_id, 'expectedRowVersion', p_expected_row_version);
  v_result jsonb;
begin
  -- Accounts phase (20261203000120): the requester or (Flight) the current cost-task owner.
  v := authz.sm_payment_for_command(p_payment_id, 'canceller');
  v_result := authz.sm_replay(v.legal_entity_id, p_request_id, 'supplier_payment_request_cancel', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if v.status <> 'pending' then
    raise exception 'already_decided' using errcode = '55000';
  end if;
  if p_expected_row_version is distinct from v.row_version then
    raise exception 'version_changed' using errcode = 'PT409';
  end if;
  update public.supplier_payment_requests p
  set status = 'cancelled', cancelled_by = (select auth.uid()), cancelled_at = now(),
      row_version = p.row_version + 1, updated_at = now()
  where p.id = v.id returning * into v;
  if v.flight_batch_id is not null then
    perform authz.write_audit('flight.payment_cancelled', v.legal_entity_id, v.branch_id, 'fulfilment_task', v.task_id,
      null, jsonb_build_object('dealId', v.deal_id, 'paymentRequestId', v.id, 'refNo', v.ref_no, 'batchId', v.flight_batch_id,
        -- Accounts phase (20261203000120)
        'byTaskOwner', v.requested_by is distinct from (select auth.uid())));
  else
    perform authz.write_audit('purchase.payment_cancelled', v.legal_entity_id, v.branch_id, 'fulfilment_task', v.task_id,
      null, jsonb_build_object('paymentRequestId', v.id, 'refNo', v.ref_no));
  end if;
  v_result := jsonb_build_object('outcome', 'created', 'id', v.id, 'status', v.status, 'rowVersion', v.row_version);
  return authz.sm_remember(v.legal_entity_id, p_request_id, 'supplier_payment_request_cancel', v_payload, v_result);
end;
$$;

-- public.supplier_payment_verify(uuid, integer, uuid): from 20261130000200_supplier_money.sql
create or replace function public.supplier_payment_verify(p_payment_id uuid, p_expected_row_version integer, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v public.supplier_payment_requests%rowtype;
  v_payload jsonb := jsonb_build_object('paymentId', p_payment_id, 'expectedRowVersion', p_expected_row_version);
  v_result jsonb;
begin
  v := authz.sm_payment_for_command(p_payment_id, 'accounts');
  v_result := authz.sm_replay(v.legal_entity_id, p_request_id, 'supplier_payment_verify', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if v.status <> 'paid' then
    raise exception 'already_decided' using errcode = '55000';
  end if;
  if v.recorded_by = v_uid then
    raise exception 'not_self_verification' using errcode = '42501';
  end if;
  if p_expected_row_version is distinct from v.row_version then
    raise exception 'version_changed' using errcode = 'PT409';
  end if;
  update public.supplier_payment_requests p
  set status = 'verified', verified_by = v_uid, verified_at = now(), row_version = p.row_version + 1, updated_at = now()
  where p.id = v.id returning * into v;
  perform authz.write_audit('finance.supplier_payment_verified', v.legal_entity_id, v.branch_id, 'fulfilment_task',
    v.task_id, null, jsonb_build_object('paymentRequestId', v.id, 'refNo', v.ref_no));
  v_result := jsonb_build_object('outcome', 'created', 'id', v.id, 'status', v.status, 'rowVersion', v.row_version);
  return authz.sm_remember(v.legal_entity_id, p_request_id, 'supplier_payment_verify', v_payload, v_result);
end;
$$;

-- public.supplier_update(uuid, integer, jsonb): from 20261204000110_supplier_master_commands.sql
create or replace function public.supplier_update(p_supplier_id uuid, p_expected_row_version integer, p_fields jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_s public.suppliers%rowtype;
  v_name text;
  v_status text;
  v_types text[];
  v_city text;
  v_contact text;
  v_phone text;
  v_email text;
  v_terms text;
  v_m jsonb;
  v_details_changed boolean;
  v_contact_changed boolean;
  v_reset boolean;
  v_changed text[];
begin
  select * into v_s from public.suppliers s where s.id = p_supplier_id for update;
  if v_s.id is null or not authz.can_manage_suppliers(v_s.legal_entity_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  -- Flight build (20261201000230): Flight owns its airline/consolidator suppliers.
  if 'flight' = any (v_s.service_types) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if authz.deployment_environment() = 'unset' then
    raise exception 'environment_unset' using errcode = '55000';
  end if;
  if p_expected_row_version is distinct from v_s.row_version then
    raise exception 'version_changed' using errcode = 'PT409';
  end if;
  perform authz.supplier_fields_check(p_fields);
  v_name := authz.booking_fact_text(p_fields, 'name', 200, false);
  v_status := coalesce(authz.booking_fact_text(p_fields, 'status', 20, false), v_s.status);
  if v_name is null or v_status not in ('active', 'archived') then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  if exists (select 1 from public.suppliers s
             where s.legal_entity_id = v_s.legal_entity_id and lower(s.name) = lower(v_name) and s.id <> v_s.id) then
    raise exception 'supplier_exists' using errcode = '23505';
  end if;
  v_types := authz.supplier_service_types(p_fields);
  v_city := authz.booking_fact_text(p_fields, 'city', 120, false);
  v_contact := authz.booking_fact_text(p_fields, 'contactName', 120, false);
  v_phone := authz.booking_fact_text(p_fields, 'contactPhone', 40, false);
  v_email := authz.booking_fact_text(p_fields, 'contactEmail', 254, false);
  v_terms := authz.booking_fact_text(p_fields, 'paymentTerms', 1000, true);
  -- Accounts phase 2 (20261204000110).
  v_m := authz.supplier_master_values(p_fields, v_s);
  v_details_changed := (v_name, v_types, v_city, v_contact, v_phone, v_email, v_terms)
    is distinct from (v_s.name, v_s.service_types, v_s.city, v_s.contact_name, v_s.contact_phone, v_s.contact_email,
                      v_s.payment_terms)
    or (v_m ->> 'supplierKind', v_m ->> 'gstin', v_m ->> 'pan', v_m ->> 'stateCode', v_m ->> 'address')
       is distinct from (v_s.supplier_kind, v_s.gstin, v_s.pan, v_s.state_code, v_s.address);
  v_contact_changed := (v_contact, v_phone, v_email) is distinct from (v_s.contact_name, v_s.contact_phone, v_s.contact_email);
  v_reset := v_details_changed and v_s.verification_status = 'verified';

  begin
    update public.suppliers s set
      name = v_name,
      service_types = v_types,
      city = v_city,
      contact_name = v_contact,
      contact_phone = v_phone,
      contact_email = v_email,
      payment_terms = v_terms,
      supplier_kind = v_m ->> 'supplierKind',
      gstin = v_m ->> 'gstin',
      pan = v_m ->> 'pan',
      state_code = v_m ->> 'stateCode',
      address = v_m ->> 'address',
      status = v_status,
      verification_status = case when v_details_changed then 'unverified' else s.verification_status end,
      verified_by = case when v_details_changed then null else s.verified_by end,
      verified_at = case when v_details_changed then null else s.verified_at end,
      row_version = s.row_version + 1,
      updated_by = case when v_details_changed then (select auth.uid()) else s.updated_by end,
      updated_at = now()
    where s.id = v_s.id
    returning * into v_s;
  exception
    when unique_violation then
      raise exception 'supplier_exists' using errcode = '23505';
    when check_violation then
      raise exception 'invalid_input' using errcode = '22023';
  end;
  if v_contact_changed then
    perform authz.supplier_primary_from_legacy(v_s);
  end if;

  -- Field names only; contact values are not copied into the audit trail.
  select coalesce(array_agg(k order by k), '{}') into v_changed from jsonb_object_keys(p_fields) k;
  perform authz.write_audit('supplier.updated', v_s.legal_entity_id, null, 'supplier', v_s.id, null,
    jsonb_build_object('fields', to_jsonb(v_changed), 'rowVersion', v_s.row_version, 'status', v_s.status,
      'detailsChanged', v_details_changed, 'verificationReset', v_reset));
  return jsonb_build_object('supplierId', v_s.id, 'rowVersion', v_s.row_version,
    'warnings', authz.supplier_warnings(v_s.id));
end;
$$;

-- public.supplier_verify(uuid, integer): from 20261005000200_procurement_owner_decisions.sql
create or replace function public.supplier_verify(p_supplier_id uuid, p_expected_row_version integer) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_s public.suppliers%rowtype;
  v_uid uuid := (select auth.uid());
begin
  select * into v_s from public.suppliers s where s.id = p_supplier_id for update;
  if v_s.id is null or not authz.can_verify_suppliers(v_s.legal_entity_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if authz.deployment_environment() = 'unset' then
    raise exception 'environment_unset' using errcode = '55000';
  end if;
  if v_s.verification_status = 'verified' then
    return jsonb_build_object('supplierId', v_s.id, 'rowVersion', v_s.row_version, 'outcome', 'existing');
  end if;
  if p_expected_row_version is distinct from v_s.row_version then
    raise exception 'version_changed' using errcode = 'PT409';
  end if;
  -- Separation of duties: the person who created the supplier or last entered the
  -- details does not verify them (review L2).
  if v_s.updated_by = v_uid or v_s.created_by = v_uid then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_s.status <> 'active' then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  update public.suppliers s
  set verification_status = 'verified', verified_by = v_uid, verified_at = now(), row_version = s.row_version + 1
  where s.id = v_s.id
  returning * into v_s;
  perform authz.write_audit('supplier.verified', v_s.legal_entity_id, null, 'supplier', v_s.id, null,
    jsonb_build_object('rowVersion', v_s.row_version));
  return jsonb_build_object('supplierId', v_s.id, 'rowVersion', v_s.row_version, 'outcome', 'created');
end;
$$;

-- public.tally_mapping_set(uuid, integer, jsonb, text, uuid): from 20261204000400_tally_mapping.sql
create or replace function public.tally_mapping_set(p_mapping_id uuid, p_expected_row_version integer, p_fields jsonb, p_reason text,
  p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v public.tally_ledger_mappings%rowtype;
  v_payload jsonb := jsonb_build_object('mappingId', p_mapping_id, 'expectedRowVersion', p_expected_row_version,
    'fields', p_fields, 'reason', p_reason);
  v_result jsonb;
  v_reason text;
  v_debit text;
  v_credit text;
  v_voucher text;
  v_changed text[] := array[]::text[];
  v_uid uuid := (select auth.uid());
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_mapping_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'mappingId';
  end if;
  select * into v from public.tally_ledger_mappings m where m.id = p_mapping_id;
  if v.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform authz.finance_require_accounts(v.legal_entity_id, null);
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  v_result := authz.finance_replay(v.legal_entity_id, p_request_id, 'tally_mapping_set', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  select * into v from public.tally_ledger_mappings m where m.id = p_mapping_id for update;
  if p_expected_row_version is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'expectedRowVersion';
  end if;
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' or p_fields = '{}'::jsonb
     or (p_fields - array['debitLedger', 'creditLedger', 'voucherType']) <> '{}'::jsonb then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fields';
  end if;
  v_debit := case when p_fields ? 'debitLedger' then authz.tally_mapping_field(p_fields, 'debitLedger', 100) else v.debit_ledger end;
  v_credit := case when p_fields ? 'creditLedger' then authz.tally_mapping_field(p_fields, 'creditLedger', 100) else v.credit_ledger end;
  v_voucher := case when p_fields ? 'voucherType' then authz.tally_mapping_field(p_fields, 'voucherType', 60) else v.voucher_type end;
  begin
    v_reason := authz.finance_reason(p_reason);
  exception when sqlstate '22023' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'reason';
  end;
  if v.row_version <> p_expected_row_version then
    raise exception 'version_changed' using errcode = 'PT409';
  end if;

  if v_debit is distinct from v.debit_ledger then
    v_changed := v_changed || 'debitLedger'::text;
    insert into public.tally_ledger_mapping_changes (legal_entity_id, mapping_id, field, old_value, new_value, changed_by, reason)
    values (v.legal_entity_id, v.id, 'debit_ledger', v.debit_ledger, v_debit, v_uid, v_reason);
  end if;
  if v_credit is distinct from v.credit_ledger then
    v_changed := v_changed || 'creditLedger'::text;
    insert into public.tally_ledger_mapping_changes (legal_entity_id, mapping_id, field, old_value, new_value, changed_by, reason)
    values (v.legal_entity_id, v.id, 'credit_ledger', v.credit_ledger, v_credit, v_uid, v_reason);
  end if;
  if v_voucher is distinct from v.voucher_type then
    v_changed := v_changed || 'voucherType'::text;
    insert into public.tally_ledger_mapping_changes (legal_entity_id, mapping_id, field, old_value, new_value, changed_by, reason)
    values (v.legal_entity_id, v.id, 'voucher_type', v.voucher_type, v_voucher, v_uid, v_reason);
  end if;

  if cardinality(v_changed) = 0 then
    v_result := jsonb_build_object('outcome', 'existing', 'mappingId', v.id, 'rowVersion', v.row_version, 'fields', '[]'::jsonb);
  else
    update public.tally_ledger_mappings m
    set debit_ledger = v_debit, credit_ledger = v_credit, voucher_type = v_voucher,
        row_version = m.row_version + 1, updated_by = v_uid, updated_at = now()
    where m.id = v.id
    returning * into v;
    perform authz.write_audit('accounts.tally_mapping_changed', v.legal_entity_id, null, 'tally_mapping', v.id, v_reason,
      jsonb_build_object('mappingId', v.id, 'fields', to_jsonb(v_changed), 'rowVersion', v.row_version));
    v_result := jsonb_build_object('outcome', 'updated', 'mappingId', v.id, 'rowVersion', v.row_version,
      'fields', to_jsonb(v_changed));
  end if;
  return authz.finance_remember(v.legal_entity_id, p_request_id, 'tally_mapping_set', v_payload, v_result);
end;
$$;

-- public.traveller_id_proof_begin(uuid, integer, uuid, boolean, text, text, integer, text): from 20261120000100_b12_traveller_id_proof.sql
create or replace function public.traveller_id_proof_begin(
  p_deal_id uuid, p_seq integer, p_request_id uuid, p_consent boolean, p_file_name text, p_mime text,
  p_size_bytes integer, p_sha256 text
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_deal public.deals%rowtype;
  v_traveller public.deal_travellers%rowtype;
  v_existing public.traveller_id_proofs%rowtype;
  v_name text := btrim(left(btrim(regexp_replace(coalesce(p_file_name, ''), '[^A-Za-z0-9._ -]', '_', 'g')), 120));
  v_sha text := lower(btrim(coalesce(p_sha256, '')));
  v_id uuid := gen_random_uuid();
  v_path text;
begin
  perform authz.refuse_removed_deal(p_deal_id);
  select * into v_deal from public.deals d where d.id = p_deal_id for no key update;
  if v_deal.id is null or not authz.can_edit_booking_draft(p_deal_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if not authz.service_items_enabled() then
    raise exception 'service_items_disabled' using errcode = '55000';
  end if;
  if authz.deal_not_active(p_deal_id) then
    raise exception 'deal_not_active' using errcode = '55000';
  end if;
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  if p_seq is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'seq';
  end if;
  -- DEC-39: the customer's consent to share this ID for this booking.
  if p_consent is distinct from true then
    raise exception 'consent_required' using errcode = '22023';
  end if;
  -- Review D3-1: FOR SHARE conflicts with the row lock of a rename or delete
  -- (deal_travellers_save): a save waits for this upload's commit, so its
  -- detach sees the new proof; a begin that waited for a save reads the row
  -- as saved (a deleted row is not_found).
  select * into v_traveller from public.deal_travellers t where t.deal_id = p_deal_id and t.seq = p_seq for share;
  if v_traveller.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  select * into v_existing from public.traveller_id_proofs f
  where f.deal_id = p_deal_id and f.request_id = p_request_id;
  if v_existing.id is not null then
    if v_existing.uploaded_by is distinct from (select auth.uid()) or v_existing.traveller_id is distinct from v_traveller.id
       or v_existing.file_name is distinct from v_name or v_existing.mime is distinct from p_mime
       or v_existing.size_bytes is distinct from p_size_bytes or v_existing.sha256 is distinct from v_sha then
      raise exception 'request_conflict' using errcode = 'PT409';
    end if;
    -- Review D1-3: no upload path for a row that no longer waits for one.
    return jsonb_build_object('fileId', v_existing.id, 'outcome', 'existing', 'status', v_existing.status,
      'rowVersion', v_existing.row_version,
      'objectPath', case when v_existing.status = 'pending_upload' then v_existing.object_path end);
  end if;

  if v_name = '' or v_name ~ '^[. ]+$'
     or p_mime is null or p_mime not in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')
     or p_size_bytes is null or p_size_bytes < 1 or p_size_bytes > authz.id_proof_max_bytes()
     or v_sha !~ '^[0-9a-f]{64}$' then
    raise exception 'evidence_rejected' using errcode = '22023';
  end if;
  -- Review D1-5/D1-6: failed and removed rows do not count; own token.
  if (select count(*) from public.traveller_id_proofs f
      where f.traveller_id = v_traveller.id and f.status in ('pending_upload', 'stored')) >= 4 then
    raise exception 'id_proof_limit' using errcode = '55000';
  end if;

  v_path := v_deal.legal_entity_id::text || '/' || v_deal.id::text || '/' || v_traveller.id::text || '/' || v_id::text;
  insert into public.traveller_id_proofs
    (id, deal_id, legal_entity_id, traveller_id, traveller_seq, booking_version_id, request_id, consent_by, consent_at,
     object_path, file_name, mime, size_bytes, sha256, uploaded_by)
  values (v_id, v_deal.id, v_deal.legal_entity_id, v_traveller.id, v_traveller.seq,
    (authz.deal_current_version(p_deal_id)).id, p_request_id, (select auth.uid()), now(), v_path, v_name, p_mime,
    p_size_bytes, v_sha, (select auth.uid()));

  -- No file name in the audit record (it may carry a person's name).
  perform authz.write_audit('booking.id_proof_started', v_deal.legal_entity_id, v_deal.branch_id,
    'traveller_id_proof', v_id, null,
    jsonb_build_object('dealId', v_deal.id, 'fileId', v_id, 'travellerSeq', v_traveller.seq,
      'mime', p_mime, 'sizeBytes', p_size_bytes));
  return jsonb_build_object('fileId', v_id, 'outcome', 'created', 'status', 'pending_upload', 'rowVersion', 1,
    'objectPath', v_path);
end;
$$;

-- public.visa_cancellation_fee_set(uuid, bigint, text, integer, uuid): from 20261205000780_manager_approves_final.sql
create or replace function public.visa_cancellation_fee_set(p_entry_id uuid, p_refund_expected_paise bigint, p_note text,
  p_expected_revision integer, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_entry public.department_cost_entries%rowtype;
  v_c public.deal_cancellations%rowtype;
  v_existing public.visa_cancellation_fees%rowtype;
  v_rev integer;
  v_note text;
  v_cr public.booking_change_requests%rowtype;  -- Accounts phase 3 (20261205000730)
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_entry from public.department_cost_entries c where c.id = p_entry_id;
  if v_entry.id is null or v_entry.department <> 'visa' or not authz.visa_can_manage_fees(v_entry.task_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_request_id is null then
    perform authz.refund_invalid('requestId');
  end if;
  perform authz.refuse_removed_deal(v_entry.deal_id);
  perform authz.finance_lock_deal(v_entry.deal_id);
  perform 1 from public.fulfilment_tasks t where t.id = v_entry.task_id for update;
  select * into v_c from public.deal_cancellations c where c.deal_id = v_entry.deal_id;
  -- Accounts phase 3 (20261205000730): without a trip cancellation, the fee refund belongs to the
  -- remove_service request (route cancellation) naming this Visa service, live or applied (11.3).
  if v_c.id is null then
    select r.* into v_cr from public.booking_change_requests r
    join public.fulfilment_tasks t on t.id = v_entry.task_id
    where r.deal_id = v_entry.deal_id and r.kind = 'remove_service' and r.removal_route = 'cancellation'
      and t.service_item_id = any (r.item_ids) and r.status in ('draft', 'requested', 'returned', 'approved', 'submitted', 'applied')
    order by r.requested_at desc, r.id desc limit 1
    for share of r;
  end if;
  -- Accounts phase 3 (20261205000770): the fee refunds of a removal stand once the Manager approved it.
  if v_cr.id is not null and v_cr.status not in ('draft', 'requested', 'returned') then
    raise exception 'already_decided' using errcode = '55000';
  end if;
  if (v_c.id is null and v_cr.id is null) or v_entry.paid_by <> 'company' then
    raise exception 'not_ready' using errcode = '55000';
  end if;
  select * into v_existing from public.visa_cancellation_fees x
  where x.legal_entity_id = v_entry.legal_entity_id and x.request_id = p_request_id;
  if v_existing.id is not null then
    if v_existing.entry_id = v_entry.id and v_existing.entered_by = v_uid then
      return jsonb_build_object('outcome', 'existing', 'entryId', v_entry.id, 'revisionNo', v_existing.revision_no);
    end if;
    raise exception 'duplicate_request' using errcode = '23505';
  end if;
  select coalesce(max(x.revision_no), 0) into v_rev from public.visa_cancellation_fees x
  where (x.cancellation_id = v_c.id or x.change_request_id = v_cr.id) and x.entry_id = v_entry.id;  -- Accounts phase 3 (20261205000730)
  if p_expected_revision is distinct from v_rev then
    raise exception 'version_changed' using errcode = 'PT409';
  end if;
  if p_refund_expected_paise is null or p_refund_expected_paise < 0 or p_refund_expected_paise > v_entry.amount_paise then
    perform authz.refund_invalid('refundExpectedPaise');
  end if;
  begin
    v_note := authz.finance_text(p_note, 1, 500, true);
  exception when sqlstate '22023' then
    perform authz.refund_invalid('note');
  end;
  insert into public.visa_cancellation_fees (cancellation_id, legal_entity_id, deal_id, task_id, entry_id, revision_no,
    refund_expected_paise, note, entered_by, request_id, change_request_id)  -- Accounts phase 3 (20261205000730)
  values (v_c.id, v_entry.legal_entity_id, v_entry.deal_id, v_entry.task_id, v_entry.id, v_rev + 1, p_refund_expected_paise,
    v_note, v_uid, p_request_id, v_cr.id);
  perform authz.write_audit('visa.cancellation_fee_set', v_entry.legal_entity_id, v_entry.branch_id, 'department_cost_entry',
    v_entry.id, null, jsonb_build_object('cancellationId', v_c.id, 'entryId', v_entry.id, 'revisionNo', v_rev + 1,
      'changeRequestId', v_cr.id));  -- Accounts phase 3 (20261205000730)
  return jsonb_build_object('outcome', 'created', 'entryId', v_entry.id, 'cancellationId', v_c.id, 'revisionNo', v_rev + 1,
    'changeRequestId', v_cr.id);
end;
$$;

-- public.visa_task_claim(uuid): from 20261202000110_visa_desk_commands.sql
create or replace function public.visa_task_claim(p_task_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_uid uuid := (select auth.uid());
  v_count integer;
begin
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id for update;
  perform authz.refuse_removed_deal(v_task.deal_id);
  if v_task.id is null or not authz.can_claim_visa_task(v_task.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_task.assignee_user_id = v_uid then
    return jsonb_build_object('taskId', v_task.id, 'status', v_task.status, 'assignedToYou', true, 'alreadyYours', true,
      'applicationCount', (select count(*)::integer from public.visa_applications a
                           where a.task_id = v_task.id and a.superseded_at is null));
  end if;
  if v_task.assignee_user_id is not null then
    raise exception 'task_conflict' using errcode = 'PT409';
  end if;

  update public.fulfilment_tasks t
  set assignee_user_id = v_uid, status = 'in_progress', updated_at = now()
  where t.id = v_task.id;
  insert into public.deal_assignments (deal_id, legal_entity_id, user_id, assignment_kind, assigned_by)
  values (v_task.deal_id, v_task.legal_entity_id, v_uid, 'visa', v_uid)
  on conflict (deal_id, user_id, assignment_kind) where ended_at is null do nothing;
  perform authz.visa_sync_applications(v_task.id);
  select count(*)::integer into v_count from public.visa_applications a where a.task_id = v_task.id and a.superseded_at is null;

  perform authz.write_audit('fulfilment.task_claimed', v_task.legal_entity_id, v_task.branch_id,
    'fulfilment_task', v_task.id, null,
    jsonb_build_object('dealId', v_task.deal_id, 'versionId', v_task.booking_version_id,
      'serviceItemId', v_task.service_item_id, 'department', 'visa', 'applicationCount', v_count));
  return jsonb_build_object('taskId', v_task.id, 'status', 'in_progress', 'assignedToYou', true, 'alreadyYours', false,
    'applicationCount', v_count);
end;
$$;

-- public.write_off_decide(uuid, text, bigint, text, integer, uuid): from 20261205000220_write_off_commands.sql
create or replace function public.write_off_decide(p_id uuid, p_decision text, p_expected_amount_paise bigint, p_reason text,
  p_expected_row_version integer, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v public.deal_write_offs%rowtype;
  v_deal public.deals%rowtype;
  v_uid uuid := (select auth.uid());
  v_payload jsonb := jsonb_build_object('writeOffId', p_id, 'decision', p_decision, 'expectedAmountPaise', p_expected_amount_paise,
    'reason', p_reason, 'expectedRowVersion', p_expected_row_version);
  v_result jsonb;
  v_reason text;
begin
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  v := authz.wo_lock(p_id);
  if v.proposed_by = v_uid then
    raise exception 'not_self_approval' using errcode = '42501';
  end if;
  if not authz.wo_is_approver(v) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  v_result := authz.finance_replay(v.legal_entity_id, p_request_id, 'write_off_decide', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if p_decision is null or p_decision not in ('approve', 'return') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'decision';
  end if;
  if v.status <> 'proposed' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  if p_expected_row_version is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'expectedRowVersion';
  end if;
  if v.row_version <> p_expected_row_version then
    raise exception 'version_changed' using errcode = 'PT409';
  end if;
  if p_expected_amount_paise is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'expectedAmountPaise';
  end if;
  if v.amount_paise <> p_expected_amount_paise then
    raise exception 'version_changed' using errcode = 'PT409';
  end if;
  if p_decision = 'return' then
    v_reason := authz.wo_reason(p_reason);
    update public.deal_write_offs w
    set status = 'returned', decided_by = v_uid, decided_at = now(), decision_request_id = p_request_id, return_reason = v_reason,
        row_version = w.row_version + 1, updated_at = now()
    where w.id = v.id returning * into v;
    perform authz.write_audit('accounts.write_off.returned', v.legal_entity_id, v.branch_id, 'deal_write_off', v.id, v_reason,
      jsonb_build_object('writeOffId', v.id, 'dealId', v.deal_id, 'direction', v.direction));
  else
    v_reason := case when nullif(btrim(coalesce(p_reason, ''), E' \t\r\n'), '') is null then null else authz.wo_reason(p_reason) end;
    select * into v_deal from public.deals d where d.id = v.deal_id;
    -- Both limits and the whole balance again (6.6): the write-off is still 'proposed', so dues are unadjusted.
    perform authz.wo_require_allowed(v_deal, v.direction, v.amount_paise);
    update public.deal_write_offs w
    set status = 'approved', decided_by = v_uid, decided_at = now(), decision_request_id = p_request_id,
        row_version = w.row_version + 1, updated_at = now()
    where w.id = v.id returning * into v;
    perform authz.write_audit('accounts.write_off.approved', v.legal_entity_id, v.branch_id, 'deal_write_off', v.id, v_reason,
      jsonb_build_object('writeOffId', v.id, 'dealId', v.deal_id, 'direction', v.direction));
  end if;
  v_result := authz.wo_result('updated', v);
  return authz.finance_remember(v.legal_entity_id, p_request_id, 'write_off_decide', v_payload, v_result);
end;
$$;

-- public.write_off_undo(uuid, integer, text, uuid): from 20261205000220_write_off_commands.sql
create or replace function public.write_off_undo(p_id uuid, p_expected_row_version integer, p_reason text, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v public.deal_write_offs%rowtype;
  v_payload jsonb := jsonb_build_object('writeOffId', p_id, 'expectedRowVersion', p_expected_row_version, 'reason', p_reason);
  v_result jsonb;
  v_reason text;
begin
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  v := authz.wo_lock(p_id);
  if not (v.branch_id = any(authz.acct_m_branches())) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  v_result := authz.finance_replay(v.legal_entity_id, p_request_id, 'write_off_undo', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if v.status <> 'approved' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  if p_expected_row_version is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'expectedRowVersion';
  end if;
  if v.row_version <> p_expected_row_version then
    raise exception 'version_changed' using errcode = 'PT409';
  end if;
  v_reason := authz.wo_reason(p_reason);
  update public.deal_write_offs w
  set status = 'undone', undone_by = (select auth.uid()), undone_at = now(), undo_reason = v_reason,
      row_version = w.row_version + 1, updated_at = now()
  where w.id = v.id returning * into v;
  perform authz.write_audit('accounts.write_off.undone', v.legal_entity_id, v.branch_id, 'deal_write_off', v.id, v_reason,
    jsonb_build_object('writeOffId', v.id, 'dealId', v.deal_id, 'direction', v.direction));
  v_result := authz.wo_result('updated', v);
  return authz.finance_remember(v.legal_entity_id, p_request_id, 'write_off_undo', v_payload, v_result);
end;
$$;

-- public.write_off_withdraw(uuid, integer, text, uuid): from 20261205000220_write_off_commands.sql
create or replace function public.write_off_withdraw(p_id uuid, p_expected_row_version integer, p_reason text, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v public.deal_write_offs%rowtype;
  v_payload jsonb := jsonb_build_object('writeOffId', p_id, 'expectedRowVersion', p_expected_row_version, 'reason', p_reason);
  v_result jsonb;
  v_reason text;
begin
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  v := authz.wo_lock(p_id);
  if v.proposed_by is distinct from (select auth.uid()) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  v_result := authz.finance_replay(v.legal_entity_id, p_request_id, 'write_off_withdraw', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if v.status <> 'proposed' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  if p_expected_row_version is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'expectedRowVersion';
  end if;
  if v.row_version <> p_expected_row_version then
    raise exception 'version_changed' using errcode = 'PT409';
  end if;
  v_reason := authz.wo_reason(p_reason);
  update public.deal_write_offs w
  set status = 'withdrawn', row_version = w.row_version + 1, updated_at = now()
  where w.id = v.id returning * into v;
  perform authz.write_audit('accounts.write_off.withdrawn', v.legal_entity_id, v.branch_id, 'deal_write_off', v.id, v_reason,
    jsonb_build_object('writeOffId', v.id, 'dealId', v.deal_id, 'direction', v.direction));
  v_result := authz.wo_result('updated', v);
  return authz.finance_remember(v.legal_entity_id, p_request_id, 'write_off_withdraw', v_payload, v_result);
end;
$$;

commit;
