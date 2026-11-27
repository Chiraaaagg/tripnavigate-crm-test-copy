-- TripNavigate CRM - Booking reliability fix batch 2, item B2-2 (BR-23):
-- a passport service for several applicants from one selection.
--
-- Build contract: booking-reliability-2026-11-19/build-contract.md section 6
-- (B2-2) and section 3.3 (C0-batch2). Owner decision: one passport service
-- per applicant (repair plan D1, option 1); the rule "exactly one applicant
-- per passport service" stays in the screen, the contract and the database.
--
-- New command (security definer, execute to authenticated, as
-- public.booking_service_save):
--   public.booking_passport_items_add(p_version_id uuid, p_expected_row_version
--     integer, p_facts jsonb, p_participants integer[], p_request_id uuid)
--     returns {rowVersion, contentHash, items: [{itemId, itemNo, travellerSeq}]}
--   - the checks of booking_service_save: draft editor, service items on,
--     Deal active, draft status (authz.lock_package_draft), request id
--     required, row version;
--   - p_participants: 1 to 20 distinct traveller numbers of this Deal, else
--     invalid_input (22023, hint travellers);
--   - the Deal's services plus the number chosen must not exceed 20, else
--     too_many_items (22023) and nothing is created;
--   - one passport item per applicant, in traveller-number order, each made
--     by public.booking_service_save (same facts, that one applicant, request
--     id md5(p_request_id || ':passport:' || seq)), so validation, titles,
--     audit rows and the version bump are the existing ones;
--   - replay-safe as a whole (authz.finance_replay / finance_remember under
--     'booking_passport_items_add'): the same request id returns the first
--     answer and creates nothing; the same id with another payload is
--     request_conflict;
--   - one extra audit row booking.passport_items_added {dealId, versionId,
--     versionNo, itemNos, count, rowVersion}; no personal data.
-- Not changed: public.booking_service_save and
-- public.service_item_travellers_save (editing a passport service still allows
-- one applicant only).
-- Refusal tokens: none new (not_authorized, service_items_disabled,
-- deal_not_active, already_confirmed, version_changed, request_conflict,
-- invalid_input, too_many_items, and those of booking_service_save).
-- No new table, column, read or switch. No money: no price or cost is created.
-- Rollback (forward-only): a NEW migration dropping the function; passport
-- services already created stay as ordinary passport services. The app keeps
-- the several-applicant choice visible; without the function a save for two
-- or more applicants answers the existing "needs the database update" text
-- and nothing is saved (one applicant still saves as before).

begin;
set local lock_timeout = '15s';

create function public.booking_passport_items_add(p_version_id uuid, p_expected_row_version integer, p_facts jsonb,
  p_participants integer[], p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.booking_versions%rowtype;
  v_payload jsonb := jsonb_build_object('versionId', p_version_id, 'expectedRowVersion', p_expected_row_version,
    'facts', p_facts, 'participants', to_jsonb(p_participants));
  v_result jsonb;
  v_res jsonb;
  v_rv integer;
  v_seq integer;
  v_items jsonb := '[]'::jsonb;
  v_nos integer[] := '{}'::integer[];
begin
  v_ver := authz.lock_package_draft(p_version_id);
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  v_result := authz.finance_replay(v_ver.legal_entity_id, p_request_id, 'booking_passport_items_add', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  perform authz.require_row_version(p_expected_row_version, v_ver.row_version);
  if p_participants is null or cardinality(p_participants) < 1 or cardinality(p_participants) > 20
     or (select count(distinct s) from unnest(p_participants) s) <> cardinality(p_participants)
     or exists (select 1 from unnest(p_participants) s
                where s is null or not exists (select 1 from public.deal_travellers t where t.deal_id = v_ver.deal_id and t.seq = s)) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'travellers';
  end if;
  if (select count(*) from public.service_items i where i.deal_id = v_ver.deal_id) + cardinality(p_participants) > 20 then
    raise exception 'too_many_items' using errcode = '22023';
  end if;

  v_rv := v_ver.row_version;
  foreach v_seq in array (select array_agg(s order by s) from unnest(p_participants) s) loop
    v_res := public.booking_service_save(v_ver.id, v_rv, null, 'passport', p_facts, null, null, array[v_seq],
      md5(p_request_id::text || ':passport:' || v_seq)::uuid);
    v_rv := (v_res ->> 'rowVersion')::integer;
    v_items := v_items || jsonb_build_array(jsonb_build_object('itemId', v_res -> 'itemId', 'itemNo', v_res -> 'itemNo',
      'travellerSeq', v_seq));
    v_nos := v_nos || (v_res ->> 'itemNo')::integer;
  end loop;

  select * into v_ver from public.booking_versions v where v.id = v_ver.id;
  -- Ids and numbers only: never a name or an identity value.
  perform authz.write_audit('booking.passport_items_added', v_ver.legal_entity_id, v_ver.branch_id, 'booking_version', v_ver.id,
    null, jsonb_build_object('dealId', v_ver.deal_id, 'versionId', v_ver.id, 'versionNo', v_ver.version_no,
      'itemNos', to_jsonb(v_nos), 'count', cardinality(v_nos), 'rowVersion', v_ver.row_version));
  v_result := jsonb_build_object('rowVersion', v_ver.row_version, 'contentHash', v_ver.content_hash, 'items', v_items);
  perform authz.finance_remember(v_ver.legal_entity_id, p_request_id, 'booking_passport_items_add', v_payload, v_result);
  return v_result;
end;
$$;

revoke all on function public.booking_passport_items_add(uuid, integer, jsonb, integer[], uuid)
from public, anon, authenticated, service_role;
grant execute on function public.booking_passport_items_add(uuid, integer, jsonb, integer[], uuid) to authenticated;

commit;
