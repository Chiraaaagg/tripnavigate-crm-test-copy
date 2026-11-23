-- TripNavigate CRM - Accounts phase, track C (3 of 5): Tally exception notice.
-- Contract: accounts-phase-2026-11-10/contract.md section 9.1 kind 25 (frozen
-- 10 November 2026). Reads track B's public.tally_records (20261203000200)
-- and authz.acct_exception_owner (track B, 6.2.6).
--
-- tally_records status -> exception: the entity's exception owner, else every
-- Accounts person of the entity (never the actor); shared per record and
-- resolved 'acted' when the status leaves exception. params.status carries
-- the record kind (journal_entry, supplier_payment, supplier_document,
-- expense, tally_gst_invoice) for the template "Tally exception on
-- {reference kind} for {BX}".
--
-- Rollback (forward-only): a new migration dropping the two triggers.

begin;
set local lock_timeout = '15s';

create function authz.notices_on_tally_record() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid;
begin
  if not authz.notices_enabled() then
    return null;
  end if;
  if new.status = 'exception' then
    v_owner := authz.acct_exception_owner(new.legal_entity_id);
    perform authz.notice_write('tally_exception',
      case when v_owner is not null then array[v_owner]
           else array(select authz.notice_accounts_recipients(new.legal_entity_id)) end,
      new.legal_entity_id, new.branch_id, new.deal_id, null, 'tally_record', new.id,
      jsonb_build_object('status', new.record_kind),
      'tally_exc:' || new.id || ':' || new.row_version, 'tally_exc:' || new.id);
  else
    perform authz.notice_resolve('tally_exc:' || new.id, 'acted');
  end if;
  return null;
end;
$$;
create trigger tally_records_notices_insert
  after insert on public.tally_records
  for each row when (new.status = 'exception')
  execute function authz.notices_on_tally_record();
create trigger tally_records_notices_status
  after update of status on public.tally_records
  for each row when (new.status is distinct from old.status and (new.status = 'exception' or old.status = 'exception'))
  execute function authz.notices_on_tally_record();

revoke all on function authz.notices_on_tally_record() from public, anon, authenticated, service_role;

commit;
