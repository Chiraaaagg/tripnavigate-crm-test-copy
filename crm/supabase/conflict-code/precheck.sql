-- READ-ONLY live pre-check for the B1-1 conflict-code migrations
-- (20261206000100, 000110, 000200, 000210). Run before each go-live step
-- that applies them (build contract B1-1, "Before each release").
--
-- Expected result: NO ROWS. Any row means the live function differs from the
-- definition the migrations were generated from (or is missing, or has an
-- overload): stop the release and report it. The expected md5 values are
-- md5(pg_proc.prosrc) of the newest definition in the migration history;
-- tests/db/br-conflict-code.test.ts proves on CI that a database built from
-- the migrations has exactly these values.
--
-- Before stage 1 every listed function is expected as below. Between stage 1
-- and stage 2, rerun with only the rows of stage '2' (the stage-1 functions
-- have changed by then, as intended).
--
-- How the list was made (on a database built from the migrations up to
-- 20261205000800; it returns the same 108 functions):
--   select n.nspname, p.proname
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname in ('public', 'authz') and p.prosrc ~ '''40001'''
--   order by 1, 2;
-- (A plain "like '%40001%'" also matches migration numbers such as
-- 20261204000110 in comments: that is why 123 was counted on live, not 108.)

with expected(nspname, proname, body_md5) as (
  values
    ('authz', 'cdoc_auto_run_inner', 'f857e34c01b86820c3024ee24dbac992'),
    ('authz', 'flight_remember', 'b0314556ae115a7b0a44b2369bc1c3a3'),
    ('authz', 'flight_replay', 'ae1c4f215048b5d07230ca970b075c70'),
    ('authz', 'sm_remember', 'b0314556ae115a7b0a44b2369bc1c3a3'),
    ('authz', 'sm_replay', '3fb286701f3091007023ecd59faa821b'),
    ('authz', 'visa_remember', 'b0314556ae115a7b0a44b2369bc1c3a3'),
    ('authz', 'visa_replay', 'ae1c4f215048b5d07230ca970b075c70'),
    ('authz', 'require_row_version', 'd1e100dcd8ed2488e0e1315853c634c8'),
    ('authz', 'b11_billing_propose', '671689ad24144f52e111f4d44026baf8'),
    ('authz', 'booking_change_apply', '0e987373fbeb9319fdc9ef272c38132e'),
    ('authz', 'booking_create_item_tasks', '614d54571069f1b7767e0d9235b21dba'),
    ('authz', 'cdoc_check_version', 'ce133229ecfa0bfa9c8dc160312a83fe'),
    ('authz', 'cdoc_release_core', 'a8afed5385c3dd28a3a5978c52f5a3ec'),
    ('authz', 'finance_expense_review', 'a2f5ff815fde6fbbf68f4edb7888e9b8'),
    ('authz', 'finance_remember', '49270a41259a1d1c6f4d53009cabe44d'),
    ('authz', 'finance_replay', '081147a5183622c895b19ff46f1a9227'),
    ('authz', 'flight_change_apply_approval', 'f9ac8830fbe2359200d2902d28c55f77'),
    ('authz', 'referral_draft_start', '145e90d301a99b4a8aebbc105ed6e21e'),
    ('authz', 'sm_payment_create', '18006328d30e51a3793d3aa20c18aca2'),
    ('authz', 'sm_payment_still_valid', '25651af4f9f22ec3a82cd02547bd4507'),
    ('public', 'accounts_billing_save', '3fac973f6226a7dafbe5dfb1778fc2eb'),
    ('public', 'accounts_billing_verify', '94b58f7fec6421df9749cc756a4ea7f3'),
    ('public', 'accounts_review_approve', '1381c4387cb8b6b475f3368e49619dc1'),
    ('public', 'accounts_tally_exception', '663aa5ae4905b05456ec69bf1dd233fc'),
    ('public', 'accounts_tally_invoice_withdraw', 'dae1570c2a5c57964ebea10f7d53baf8'),
    ('public', 'accounts_tally_match', '92cdb11db1d09085ced28df4f8fcd2bd'),
    ('public', 'accounts_tally_match_apply', '78bf0e07502627b0e9309aa97a384226'),
    ('public', 'accounts_tally_reopen', 'b128f422d3b6732a1f5beff4f0acf988'),
    ('public', 'admin_set_customer_message_switch', 'c51562b84114724c0ab0bcf8f3788781'),
    ('public', 'bitrix_destination_scope_set', '02c18bbd2f751f0df26fdfdcb391e4f1'),
    ('public', 'bitrix_id_proof_copy_complete', '48f9706fd9b71b7f108c94d51d3da39d'),
    ('public', 'bitrix_id_proof_copy_mark_sending', 'dadbf9c1e060e2a5df233c033280df47'),
    ('public', 'bitrix_id_proof_copy_stop', 'd41a08c94167fff3628deb94c2c6238d'),
    ('public', 'booking_change_request_decide', '427e21c24341e7bee5f32d0aea9881c8'),
    ('public', 'booking_change_submit', '53af254a2d823a5dc016ad819788b1c6'),
    ('public', 'booking_confirm', 'dd00512a6e4d15aaaba3bd01473f3bfe'),
    ('public', 'booking_save_draft', 'bc6a969c49dfb5bcc19e52986ceb4006'),
    ('public', 'company_destination_approve', '11c891d378d1cfb30a36629332cb6a0d'),
    ('public', 'company_destination_retire', '499831fcb4a616c09c0fc25dac76173d'),
    ('public', 'company_destination_return', '2ce93a0bb7d3a8690737c1ba37fc2620'),
    ('public', 'company_destination_submit', '4fda7025ce878f368b3be63a9ae279d8'),
    ('public', 'company_funding_decide', '0f9fb0286c1dbb1f82b534ac58b90dec'),
    ('public', 'company_funding_mark_recovered', '8fc7ef2068c72f9a34b7e8c5e39cc40a'),
    ('public', 'customer_document_release', '74d5dd0377456233ee5b30cab7a5d9a1'),
    ('public', 'customer_document_render_complete', '51daa63648f57bfd91d4fddb97eb548b'),
    ('public', 'customer_document_render_input', '63a402a30da59961fb1a377701006daf'),
    ('public', 'customer_party_document_begin', 'ad91e14b56ecd60ac102c2f70617d3a1'),
    ('public', 'customer_party_tally_name_set', '144c06c847ca9b0f982058844949e1eb'),
    ('public', 'customer_refund_decide', 'a97ab069b92feba038ea66bd38fea889'),
    ('public', 'deal_cancellation_decide', '192cb7dab3531d957f2d18db8e45926c'),
    ('public', 'deal_cancellation_send', '9acda53772f73d13acd39d164dd54e80'),
    ('public', 'deal_message_prefs_set', '2c90139e002cbdaa5e608a427911d757'),
    ('public', 'deal_traveller_name_fill', '528174352bffda751b3130605fcad558'),
    ('public', 'flight_booking_change_apply', '7d7daf2015408483733019faa52678bb'),
    ('public', 'flight_cancellation_charge_set', 'cdd19441aeb1a047b3b519973048715a'),
    ('public', 'flight_change_decide', '038a074626235141c36a8ca64fddc9a0'),
    ('public', 'flight_direct_payment_save', 'a2c51d43cc86c2a9a2b40ff61fa200b4'),
    ('public', 'flight_fare_approval_decide', '8cdfa63c1365af45cb77a62a08dc8819'),
    ('public', 'flight_fare_approval_withdraw', 'b6c533a2e41a31e08b477fcb55458571'),
    ('public', 'flight_group_claim', 'b7c1395c6124200dfbc41035fba6da4d'),
    ('public', 'flight_group_complete', '3bfa87e635d21b5a32ec919e00d32938'),
    ('public', 'flight_group_reassign', '53218da18f0fa65a310f6081e5e485b1'),
    ('public', 'flight_supplier_update', '6a5a4b25e7a16dbf59e8bc3c2bc3f35b'),
    ('public', 'flight_ticket_correct', '89f3d3c886b278779c6b31d6fb41a691'),
    ('public', 'hotel_catalogue_save', '17ddd714b53671df2a6616a7d5d6bf79'),
    ('public', 'import_batch_apply', 'f22a58c6e25d28156f729b91cb87ec6e'),
    ('public', 'import_batch_stage', '3bc2759bde7415b82758870f8975ad0d'),
    ('public', 'integration_apply_sync_settings', '2147b778bcbec2715c4330ebeda81255'),
    ('public', 'itinerary_create_standalone', '2c79eaaacf5f7568e21de499f5038511'),
    ('public', 'itinerary_differences_save', '2bb86078b1deb49f280f6e388704151c'),
    ('public', 'itinerary_document_create', '8d954d6b883bcac2a38cfbc17c993681'),
    ('public', 'itinerary_render_complete', '60290b14441e10123a63f723d9374b95'),
    ('public', 'itinerary_render_input', 'a4442264459c3c47f06645d787e59e02'),
    ('public', 'payment_claim_report', 'd82289d30a93b9196260ba70c0756b5b'),
    ('public', 'payment_claim_withdraw', '8c6017c2416c09c396252ed8bb086f31'),
    ('public', 'purchase_booking_change_ack', 'cb6ba3debc1cec82c422b8044dc3f55f'),
    ('public', 'purchase_booking_request_send', '5474a0a07fea01e45f0e0a5ac3f7c865'),
    ('public', 'purchase_cancellation_charge_set', 'bbbc1b5b559390cbbbf72c4be9f9762f'),
    ('public', 'purchase_cost_approve_over_budget', 'c3ea5941484b4f069c1fb159cc441586'),
    ('public', 'purchase_cost_propose', '1f1a628377dc7546191f22f441e62f38'),
    ('public', 'purchase_go_ahead_decide', '9bb13f7438aa145a433485a8f2b6a7cb'),
    ('public', 'purchase_supplier_confirm', '92f3088fdc957464b88389b15a830366'),
    ('public', 'purchase_task_claim', '62c83ddfd459a7bad5a71fdfee9a5875'),
    ('public', 'purchase_task_reassign', '468ced6e7fb1944025abf78c893c9601'),
    ('public', 'purchase_task_release', 'a39cce0382de106594261007ad08951e'),
    ('public', 'quotation_accept', '4dd0ebef50ec14d94da133c4e9c4cf49'),
    ('public', 'quotation_convert_to_booking', 'aa3d61cfab26e025cc191a7c04dbea01'),
    ('public', 'quotation_create', '5420c0f86a6f79387d5353174bc572a4'),
    ('public', 'quotation_create_standalone', '8775b4cc4c7b04ae00436be144e96b34'),
    ('public', 'quotation_mark_sent', 'e66a4860241bb3cf1166ecf559bcda9c'),
    ('public', 'service_item_file_begin', 'f2394b63fd87ef81daa50289a195bac7'),
    ('public', 'supplier_approve_beneficiary', 'e6f535d277de7d7c87761762a5cd7650'),
    ('public', 'supplier_contact_remove', 'd302af5bb51e62abfbee9161df9118d5'),
    ('public', 'supplier_contact_save', '76f5abac5b3125841a6b3e30ab64a2a8'),
    ('public', 'supplier_document_review', 'efc99ae960236c3cca535cb54574834b'),
    ('public', 'supplier_payment_decide', '148459640ffa3d08a7179590a1af5dda'),
    ('public', 'supplier_payment_record', '968fd2f0369b0c3beb5c0472ae31e8e4'),
    ('public', 'supplier_payment_request_cancel', 'b433ce00e62be47a859e308acfd00b21'),
    ('public', 'supplier_payment_verify', '48027268cbaedf0062c773dcb17f7307'),
    ('public', 'supplier_update', '9fdeaba5a20bd24a426150eb40d9b5f6'),
    ('public', 'supplier_verify', '753b87fe673ba65cc676c83c90b69267'),
    ('public', 'tally_mapping_set', 'f18f80d9f842b55090e4569e5e77f92c'),
    ('public', 'traveller_id_proof_begin', '90fd95ecdf40b1ac80ba2669ae7ce379'),
    ('public', 'visa_cancellation_fee_set', 'f2e017d70aedde63e04bfa51b15f5bab'),
    ('public', 'visa_task_claim', '401a5133bf15020765f8ea43557ae985'),
    ('public', 'write_off_decide', '8644440ff516284fc460e95b3d26e851'),
    ('public', 'write_off_undo', '44d2447c21ab169e5be60363f29507be'),
    ('public', 'write_off_withdraw', '85570246a335f085a32ff655c72e6de5')
),
live as (
  select n.nspname, p.proname, md5(p.prosrc) as body_md5, count(*) over (partition by n.nspname, p.proname) as overloads
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'authz')
)
select e.nspname, e.proname, e.body_md5 as expected_md5, l.body_md5 as live_md5, l.overloads,
       case when l.proname is null then 'missing' when l.overloads > 1 then 'overloaded' else 'different' end as problem
from expected e
left join live l on l.nspname = e.nspname and l.proname = e.proname
where l.proname is null or l.overloads > 1 or l.body_md5 <> e.body_md5
union all
-- A function that contains 40001 on live but is not in the list.
select n.nspname, p.proname, null, md5(p.prosrc), 1, 'not in list'
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname in ('public', 'authz') and p.prosrc ~ '''40001'''
  and not exists (select 1 from expected e where e.nspname = n.nspname and e.proname = p.proname)
order by 1, 2;
