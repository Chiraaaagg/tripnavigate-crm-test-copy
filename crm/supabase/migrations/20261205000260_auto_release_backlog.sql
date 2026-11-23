-- TripNavigate CRM - Accounts phase 3, track B (6): backlog control for
-- automatic release and the PDF queue (lead request after the speed check,
-- 14 Nov 2026; contract 6.2, 6.4, 16.5).
--
-- Found: with automatic release on, one sweep released about 1,000 bills and
-- the customer PDF queue (one job per worker call, oldest first) held 1,213
-- jobs, so a new bill waited about 12 minutes for its PDF.
--
-- 1. The sweep (authz.cdoc_auto_sweep, replaces 20261205000210) releases at
--    most 25 bills per tick; the rest stay 'ready' and are picked again on the
--    next tick (ready drafts no longer wait 5 minutes between sweeps). Budget
--    via the transaction setting tripnavigate.auto_release_budget, read by
--    authz.cdoc_auto_run_inner (replaces 20261205000210); event runs (receipt
--    verified, review approved, refund paid, G / H calls) are not capped.
--    authz.cdoc_auto_run keeps its frozen signature and body.
-- 2. customer_document_render_jobs.priority: 0 = released by an event or a
--    person, 1 = released by the timer sweep (set by a BEFORE INSERT trigger
--    from the transaction's system rule 'auto_sweep'). The claim
--    (public.customer_document_render_claim, replaces 20261204000220:79, same
--    signature and reply) orders by priority, then oldest first. No job is
--    skipped or dropped: a sweep job is only claimed after the event jobs
--    queued before it is claimed.
--    Deviation noted: customer_document_render_claim is a Phase 2 track B
--    function not listed in contract 19; replaced on the lead's request.
--
-- Refusal tokens: none new.
-- Rollback (forward-only): a NEW migration restoring the three cited bodies;
-- the priority column stays (default 0 = Phase 2 order).

begin;
set local lock_timeout = '15s';

alter table public.customer_document_render_jobs
  add column priority smallint not null default 0 constraint customer_document_render_jobs_priority_check check (priority in (0, 1));
create index customer_document_render_jobs_priority_queue_idx on public.customer_document_render_jobs (priority, available_at, created_at, id)
  where status in ('queued', 'running');

-- A job queued inside the timer sweep's run renders after event jobs.
create function authz.customer_document_render_jobs_priority() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.priority := case when coalesce(current_setting('tripnavigate.system_rule', true), '') = 'auto_sweep' then 1 else 0 end;
  return new;
end;
$$;
create trigger customer_document_render_jobs_b_priority before insert on public.customer_document_render_jobs
  for each row execute function authz.customer_document_render_jobs_priority();

create or replace function authz.cdoc_auto_run_inner(p_deal uuid, p_rule text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_deal public.deals%rowtype;
  v_id uuid;
  v_doc public.customer_documents%rowtype;
  v_inv public.customer_documents%rowtype;
  v_exp record;
  v_build jsonb;
  v_codes text[];
  v_state text;
  v_release boolean;
  v_core jsonb;
  v_code text;
  v_budget integer;
  n_drafted integer := 0;
  n_refreshed integer := 0;
  n_held integer := 0;
  n_ready integer := 0;
  n_released integer := 0;
begin
  -- Lock order 17.1: the finance head of the Deal first.
  v_deal := authz.finance_lock_deal(p_deal);
  if v_deal.id is null then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- 1a. adv_on_receipt: verified money without any Advance Invoice (a cancelled or discarded one counts: never made again).
  for v_id in
    select r.id from public.customer_receipts r
    where r.deal_id = p_deal and r.status in ('verified', 'cleared')
      and not exists (select 1 from public.customer_documents c where c.receipt_id = r.id and c.kind = 'advance_invoice')
    order by r.received_on, r.receipt_no
  loop
    if authz.cdoc_auto_try_draft(v_deal, 'advance_invoice', v_id, null, null, null, 'adv_on_receipt') then
      n_drafted := n_drafted + 1;
    end if;
  end loop;

  -- 1b. inv_on_approval / inv_replace_on_change (LD13).
  select * into v_exp from authz.cdoc_invoice_expected(p_deal) x limit 1;
  if v_exp.total is not null then
    select * into v_inv from public.customer_documents c
    where c.deal_id = p_deal and c.kind = 'invoice' and c.status in ('draft', 'released')
    order by (c.status = 'draft') desc, c.released_at desc nulls last, c.id desc limit 1;
    if v_inv.id is null then
      if not exists (select 1 from public.customer_documents c
                     where c.deal_id = p_deal and c.kind = 'invoice' and c.status in ('discarded', 'cancelled')
                       and c.basis_version_id is not distinct from v_exp.version_id and c.total_paise = v_exp.total) then
        if authz.cdoc_auto_try_draft(v_deal, 'invoice', null, null, null, null, 'inv_on_approval') then
          n_drafted := n_drafted + 1;
        end if;
      end if;
    elsif v_inv.status = 'released'
          and authz.cdoc_settlement_charge(p_deal) is null
          and (v_inv.basis_version_id is distinct from v_exp.version_id or v_inv.total_paise is distinct from v_exp.total)
          and not exists (select 1 from public.customer_documents c
                          where c.replaces_document_id = v_inv.id
                            and (c.status in ('draft', 'released')
                                 or (c.basis_version_id is not distinct from v_exp.version_id and c.total_paise = v_exp.total))) then
      if authz.cdoc_auto_try_draft(v_deal, 'invoice', null, null, v_inv.id, 'Booking changed', 'inv_replace_on_change') then
        n_drafted := n_drafted + 1;
      end if;
    end if;
  end if;

  -- 1c. cn_on_refund (LD12): payout paid, or keep-as-credit / charge-only approved.
  for v_id in
    select q.id from public.customer_refund_requests q
    where q.deal_id = p_deal
      and ((q.status = 'paid' and q.outcome = 'payout') or (q.status = 'approved' and q.outcome in ('keep_credit', 'charge_only')))
      and not exists (select 1 from public.customer_documents c where c.refund_request_id = q.id and c.kind = 'credit_note')
    order by q.requested_at, q.id
  loop
    if authz.cdoc_credit_note_source(v_id) is not null
       and authz.cdoc_auto_try_draft(v_deal, 'credit_note', null, v_id, null, null, 'cn_on_refund') then
      n_drafted := n_drafted + 1;
    end if;
  end loop;

  -- 2-4. Refresh, check and release every automatic draft of the Deal.
  v_release := authz.cdoc_auto_release_on(v_deal.legal_entity_id);
  for v_id in
    select c.id from public.customer_documents c
    where c.deal_id = p_deal and c.status = 'draft' and c.auto_rule is not null
    order by c.created_at, c.id
  loop
    select * into v_doc from public.customer_documents c where c.id = v_id for update;
    if v_doc.status <> 'draft' then
      continue;
    end if;
    v_build := authz.cdoc_build(v_doc.deal_id, v_doc.kind, v_doc.receipt_id, v_doc.refund_request_id, v_doc.replaces_document_id,
      v_doc.tally_invoice_id);
    -- 2. Refresh a stale draft when its source still builds and credits the same document.
    if v_build ->> 'issue' is null
       and nullif(v_build ->> 'creditsDocumentId', '')::uuid is not distinct from v_doc.credits_document_id
       and authz.cdoc_build_hash(v_build) is distinct from v_doc.source_hash then
      update public.customer_documents c
      set content = v_build -> 'content', content_sha256 = authz.finance_payload_hash(v_build -> 'content'),
          source_hash = authz.cdoc_build_hash(v_build), total_paise = (v_build ->> 'totalPaise')::bigint,
          warnings = array(select jsonb_array_elements_text(v_build -> 'warnings')),
          basis_version_id = nullif(v_build ->> 'basisVersionId', '')::uuid,
          refreshed_at = now(), row_version = c.row_version + 1, updated_at = now()
      where c.id = v_doc.id returning * into v_doc;
      n_refreshed := n_refreshed + 1;
      perform authz.write_system_audit('accounts.customer_document.refreshed', v_doc.legal_entity_id, v_doc.branch_id,
        'customer_document', v_doc.id, p_rule,
        jsonb_build_object('documentId', v_doc.id, 'kind', v_doc.kind, 'rowVersion', v_doc.row_version));
    end if;
    -- 3. The checks.
    v_codes := authz.cdoc_auto_codes(v_doc, v_build);
    v_state := case when cardinality(v_codes) = 0 then 'ready' else 'held' end;
    if v_doc.auto_state is distinct from v_state or v_doc.hold_reasons is distinct from v_codes
       or v_doc.evaluated_at is null or v_doc.evaluated_at < now() - interval '5 minutes' then
      update public.customer_documents c
      set auto_state = v_state, hold_reasons = v_codes, evaluated_at = now(), row_version = c.row_version + 1, updated_at = now()
      where c.id = v_doc.id;
      if v_state = 'held' and (v_doc.auto_state is distinct from 'held' or v_doc.hold_reasons is distinct from v_codes) then
        perform authz.write_system_audit('accounts.customer_document.held', v_doc.legal_entity_id, v_doc.branch_id,
          'customer_document', v_doc.id, p_rule, jsonb_build_object('documentId', v_doc.id, 'codes', to_jsonb(v_codes)));
      end if;
    end if;
    if v_state = 'held' then
      n_held := n_held + 1;
      continue;
    end if;
    if not v_release then
      n_ready := n_ready + 1;
      continue;
    end if;
    -- Accounts phase 3 (20261205000260): the sweep's per-tick release budget
    -- (unset for event runs). Over budget, the draft stays ready for the next tick.
    v_budget := nullif(current_setting('tripnavigate.auto_release_budget', true), '')::integer;
    if v_budget is not null and v_budget <= 0 then
      n_ready := n_ready + 1;
      continue;
    end if;
    -- 4. Automatic release: exactly the manual path (cdoc_release_core).
    begin
      v_core := authz.cdoc_release_core(v_doc.id, null, 'auto_release', gen_random_uuid());
      perform authz.write_system_audit('accounts.customer_document.auto_released', v_doc.legal_entity_id, v_doc.branch_id,
        'customer_document', v_doc.id, 'auto_release',
        jsonb_build_object('documentId', v_doc.id, 'kind', v_doc.kind, 'seq', (v_core ->> 'seq')::integer,
          'replacesDocumentId', v_doc.replaces_document_id, 'renderJobId', v_core ->> 'renderJobId'));
      n_released := n_released + 1;
      if v_budget is not null then
        perform set_config('tripnavigate.auto_release_budget', (v_budget - 1)::text, true);
      end if;
    exception when sqlstate '55000' or sqlstate '40001' or sqlstate '23505' then
      -- A release refusal the checks did not foresee: held with the nearest code.
      v_code := case sqlerrm
        when 'billing_not_verified' then 'billing_not_verified'
        when 'receipt_not_verified' then 'receipt_not_money'
        when 'company_identity_missing' then 'company_identity_missing'
        when 'number_conflict' then 'number_conflict'
        else 'amount_mismatch' end;
      update public.customer_documents c
      set auto_state = 'held', hold_reasons = array[v_code], evaluated_at = now(), row_version = c.row_version + 1, updated_at = now()
      where c.id = v_doc.id;
      perform authz.write_system_audit('accounts.customer_document.held', v_doc.legal_entity_id, v_doc.branch_id,
        'customer_document', v_doc.id, p_rule, jsonb_build_object('documentId', v_doc.id, 'codes', jsonb_build_array(v_code)));
      n_held := n_held + 1;
    end;
  end loop;

  delete from public.cdoc_auto_pending p where p.deal_id = p_deal;
  return jsonb_build_object('status', 'ok', 'drafted', n_drafted, 'refreshed', n_refreshed, 'held', n_held, 'ready', n_ready,
    'released', n_released);
end;
$$;

create or replace function authz.cdoc_auto_sweep() returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  c_budget constant integer := 25;  -- at most 25 automatic releases per tick
  v_row record;
  v_res jsonb;
  n_deals integer := 0;
  n_drafted integer := 0;
  n_released integer := 0;
  n_held integer := 0;
  n_ready integer := 0;
  n_pending integer := 0;
  n_off integer := 0;
  n_deferred integer := 0;
begin
  perform set_config('tripnavigate.auto_release_budget', c_budget::text, true);
  for v_row in
    select x.deal_id, min(x.pri) as pri from (
      select p.deal_id, 0 as pri, p.created_at as at from public.cdoc_auto_pending p
      union all
      -- Held or unchecked drafts: re-checked at most every 5 minutes.
      select c.deal_id, 1, min(coalesce(c.evaluated_at, c.created_at))
      from public.customer_documents c
      where c.status = 'draft' and c.auto_rule is not null and (c.auto_state is null or c.auto_state = 'held')
        and (c.evaluated_at is null or c.evaluated_at < now() - interval '5 minutes')
      group by c.deal_id
      union all
      -- Ready drafts while automatic release is on: every tick until released (budget-limited).
      select c.deal_id, 2, min(c.created_at)
      from public.customer_documents c
      join public.accounts_settings s on s.legal_entity_id = c.legal_entity_id
      where c.status = 'draft' and c.auto_rule is not null and c.auto_state = 'ready'
        and s.customer_documents_enabled and s.auto_bills_enabled and s.auto_bill_release_enabled
      group by c.deal_id
    ) x
    group by x.deal_id
    order by min(x.pri), min(x.at), x.deal_id
    limit 50
  loop
    -- Budget spent: Deals waiting only to be released wait for the next tick.
    if v_row.pri = 2 and coalesce(nullif(current_setting('tripnavigate.auto_release_budget', true), '')::integer, 0) <= 0 then
      n_deferred := n_deferred + 1;
      continue;
    end if;
    v_res := authz.cdoc_auto_run(v_row.deal_id, 'auto_sweep');
    n_deals := n_deals + 1;
    n_drafted := n_drafted + coalesce((v_res ->> 'drafted')::integer, 0);
    n_released := n_released + coalesce((v_res ->> 'released')::integer, 0);
    n_held := n_held + coalesce((v_res ->> 'held')::integer, 0);
    n_ready := n_ready + coalesce((v_res ->> 'ready')::integer, 0);
    if v_res ->> 'status' = 'pending' then
      n_pending := n_pending + 1;
    elsif v_res ->> 'status' = 'off' then
      n_off := n_off + 1;
    end if;
  end loop;
  perform set_config('tripnavigate.auto_release_budget', '', true);
  return jsonb_build_object('deals', n_deals, 'drafted', n_drafted, 'released', n_released, 'held', n_held,
    'ready', n_ready, 'deferred', n_deferred, 'pending', n_pending, 'off', n_off);
end;
$$;

create or replace function public.customer_document_render_claim(p_worker text, p_lease_seconds integer) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_job public.customer_document_render_jobs%rowtype;
begin
  if p_worker is null or length(p_worker) not between 1 and 60 or p_lease_seconds is null or p_lease_seconds not between 10 and 600 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'worker';
  end if;
  -- A running job whose lease expired on its last attempt fails (lease_expired).
  update public.customer_document_render_jobs j
  set status = 'failed', last_error_code = 'lease_expired', lease_owner = null, lease_until = null, finished_at = now()
  where j.status = 'running' and j.lease_until < now() and j.attempts >= j.max_attempts;
  select * into v_job from public.customer_document_render_jobs j
  where ((j.status = 'queued' and j.available_at <= now()) or (j.status = 'running' and j.lease_until < now()))
    and j.attempts < j.max_attempts
  -- Accounts phase 3 (20261205000260): priority first (0 = released by an event or a
  -- person, 1 = released by the timer sweep), oldest first within each; nothing is skipped.
  order by j.priority, j.available_at, j.created_at, j.id
  for update skip locked
  limit 1;
  if v_job.id is null then
    return null;
  end if;
  update public.customer_document_render_jobs j
  set status = 'running', attempts = j.attempts + 1, lease_owner = p_worker,
      lease_until = now() + make_interval(secs => p_lease_seconds), started_at = coalesce(j.started_at, now())
  where j.id = v_job.id returning * into v_job;
  return jsonb_build_object('jobId', v_job.id, 'documentId', v_job.document_id, 'contentSha256', v_job.content_sha256,
    'templateVersion', v_job.template_version, 'attempts', v_job.attempts, 'legalEntityId', v_job.legal_entity_id,
    'objectPath', authz.cdoc_object_path(v_job.legal_entity_id, v_job.document_id, v_job.id));
end;
$$;

revoke all on function authz.customer_document_render_jobs_priority() from public, anon, authenticated, service_role;

commit;
