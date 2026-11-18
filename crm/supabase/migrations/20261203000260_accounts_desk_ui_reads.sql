-- Accounts phase, Track B (7): reads and refusal details the Accounts desk
-- screens need (Track D request of 10 Nov 2026, accepted by the lead;
-- recorded in contract.md addendum B2).
--
-- Adds (security definer, search_path '', execute to authenticated):
--   public.supplier_document_link_targets(p_document_id uuid)
--       tasks a supplier bill may be linked to (same entity and supplier,
--       eligible per 6.2.3, not its own task), plus its active links.
--       Accounts of the entity: every eligible task; the assignee path of S1
--       (bill still uploaded): only the caller's own tasks. Else null.
--   public.accounts_filter_options()
--       branches, suppliers and Sales owners the caller may filter the
--       workspace and dues by (ids and names only). A: the entity; M: own
--       branches (suppliers of that entity). Else null.
-- Replaced (same signatures):
--   authz.sm_document_refuse_duplicate (20261203000210): the refusal's DETAIL
--       carries "existingDocumentId=<uuid>" when the caller may read that
--       bill (Accounts of the entity, a reader of the bill's Purchase task, or
--       the Flight person of its Deal); otherwise no detail.
--   public.deal_dues (20261203000240): + viewer ('accounts'|'manager'|'sales').
--
-- Rollback (forward-only): a NEW migration restoring the two replaced bodies
-- and revoking the two new reads.

begin;
set local lock_timeout = '15s';

-- Replaces 20261203000210: + DETAIL with the existing bill id for callers
-- who may read it (Accounts phase 20261203000260).
create or replace function authz.sm_document_refuse_duplicate(p_entity uuid, p_supplier uuid, p_kind text, p_number text, p_date date)
returns void
language plpgsql stable security definer set search_path = '' as $$
declare
  v_doc public.supplier_documents%rowtype;
  v_synthetic boolean;
begin
  if authz.sm_number_norm(p_number) = '' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'number';
  end if;
  select * into v_doc from public.supplier_documents s
  where s.legal_entity_id = p_entity and s.supplier_id = p_supplier and s.kind = p_kind
    and s.number_norm = authz.sm_number_norm(p_number)
    and s.fiscal_year = authz.finance_fiscal_year(p_date) and s.status <> 'returned'
  limit 1;
  if v_doc.id is not null then
    select d.is_synthetic into v_synthetic from public.deals d where d.id = v_doc.deal_id;
    if authz.sm_accounts_sees(p_entity, v_synthetic)
       or exists (select 1 from public.fulfilment_tasks t where t.id = v_doc.task_id
                  and ((t.department = 'purchase' and authz.can_read_purchase_workspace(t.id))
                       or (t.department = 'flight' and authz.holds_active_role('flight', t.legal_entity_id)
                           and authz.flight_is_deal_assignee(t.deal_id)))) then
      raise exception 'duplicate_supplier_document' using errcode = '23505', hint = 'number',
        detail = 'existingDocumentId=' || v_doc.id::text;
    end if;
    raise exception 'duplicate_supplier_document' using errcode = '23505', hint = 'number';
  end if;
end;
$$;

create function public.supplier_document_link_targets(p_document_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_doc public.supplier_documents%rowtype;
  v_synthetic boolean;
  v_is_a boolean;
  v_uid uuid := (select auth.uid());
begin
  if p_document_id is null or not coalesce(authz.session_ok(), false) then
    return null;
  end if;
  select * into v_doc from public.supplier_documents s where s.id = p_document_id;
  if v_doc.id is null or v_doc.status = 'returned' then
    return null;
  end if;
  select d.is_synthetic into v_synthetic from public.deals d where d.id = v_doc.deal_id;
  v_is_a := authz.sm_accounts_sees(v_doc.legal_entity_id, v_synthetic);
  if not v_is_a and (v_doc.status <> 'uploaded'
     or not (authz.holds_active_role('purchase', v_doc.legal_entity_id) or authz.holds_active_role('flight', v_doc.legal_entity_id))) then
    return null;
  end if;
  return jsonb_build_object(
    'documentId', v_doc.id,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
          'taskId', c.id, 'dealId', c.deal_id, 'dealReference', d.reference, 'department', c.department,
          'serviceLabel', (select replace(initcap(i.service_type), '_', ' ') || ' ' || i.item_no::text
                           from public.service_items i where i.id = c.service_item_id),
          'alreadyLinked', exists (select 1 from public.supplier_document_tasks l
                                   where l.document_id = v_doc.id and l.task_id = c.id and l.unlinked_at is null))
        order by d.reference, c.id)
      from (
        select distinct t.* from public.fulfilment_tasks t
        where t.legal_entity_id = v_doc.legal_entity_id and t.id <> v_doc.task_id
          and t.id in (select q.task_id from public.purchase_quotes q
                       where q.legal_entity_id = v_doc.legal_entity_id and q.supplier_id = v_doc.supplier_id
                       union
                       select b.cost_task_id from public.flight_ticket_batches b
                       where b.legal_entity_id = v_doc.legal_entity_id and b.supplier_id = v_doc.supplier_id)
          and (v_is_a or (t.assignee_user_id = v_uid
                          and ((t.department = 'purchase' and t.status in ('in_progress', 'supplier_confirmed', 'completed')
                                and authz.holds_active_role('purchase', t.legal_entity_id))
                               or (t.department = 'flight' and authz.flight_owns_task(t.id)))))
        limit 200
      ) c
      join public.deals d on d.id = c.deal_id
      where d.is_synthetic = v_synthetic and authz.sm_link_eligible(c.id, v_doc.supplier_id)), '[]'::jsonb),
    'links', case when v_is_a then coalesce((
      select jsonb_agg(jsonb_build_object('linkId', l.id, 'taskId', l.task_id, 'dealId', l.deal_id, 'dealReference', d.reference,
          'linkedAt', l.linked_at, 'linkedByName', p.display_name) order by l.linked_at, l.id)
      from public.supplier_document_tasks l
      join public.deals d on d.id = l.deal_id
      left join public.staff_profiles p on p.user_id = l.linked_by
      where l.document_id = v_doc.id and l.unlinked_at is null), '[]'::jsonb) else '[]'::jsonb end);
end;
$$;

create function public.accounts_filter_options() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_a uuid[];
  v_m uuid[];
  v_entities uuid[];
begin
  if not coalesce(authz.session_ok(), false) then
    return null;
  end if;
  v_a := authz.acct_a_entities();
  v_m := authz.acct_m_branches();
  if cardinality(v_a) = 0 and cardinality(v_m) = 0 then
    return null;
  end if;
  select coalesce(array_agg(distinct x), array[]::uuid[]) into v_entities
  from (select unnest(v_a) as x union select b.legal_entity_id from public.branches b where b.id = any(v_m)) s;
  return jsonb_build_object(
    'branches', coalesce((select jsonb_agg(jsonb_build_object('branchId', b.id, 'name', b.name) order by b.name, b.id)
      from public.branches b
      where b.status = 'enabled' and (b.legal_entity_id = any(v_a) or b.id = any(v_m))), '[]'::jsonb),
    'suppliers', coalesce((select jsonb_agg(jsonb_build_object('supplierId', x.id, 'name', x.name) order by x.name, x.id)
      from (select s.id, s.name from public.suppliers s where s.legal_entity_id = any(v_entities)
            order by s.name, s.id limit 1000) x), '[]'::jsonb),
    'owners', coalesce((select jsonb_agg(jsonb_build_object('userId', y.user_id, 'name', y.display_name) order by y.display_name, y.user_id)
      from (select distinct p.user_id, p.display_name
            from public.memberships m join public.staff_profiles p on p.user_id = m.user_id
            where m.role_code = 'sales' and m.status = 'active' and p.status = 'active'
              and (m.legal_entity_id = any(v_a) or m.branch_id = any(v_m))) y), '[]'::jsonb));
end;
$$;

-- Replaces 20261203000240: + viewer (Accounts phase 20261203000260).
create or replace function public.deal_dues(p_deal_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_deal public.deals%rowtype;
  v_a uuid[]; v_m uuid[]; v_syn boolean;
  v_sales boolean := false;
  r record;
  v_row jsonb;
begin
  if p_deal_id is null or not coalesce(authz.session_ok(), false) then
    return null;
  end if;
  select * into v_deal from public.deals d where d.id = p_deal_id;
  if v_deal.id is null then
    return null;
  end if;
  v_a := authz.acct_a_entities();
  v_m := authz.acct_m_branches();
  v_syn := authz.acct_synthetic();
  if v_syn is null or v_deal.is_synthetic is distinct from v_syn then
    return null;
  end if;
  if not (v_deal.legal_entity_id = any(v_a)) and not (v_deal.branch_id = any(v_m)) then
    -- AL5: the existing Sales money-card readers; never Purchase, Flight or Visa.
    v_sales := coalesce(authz.finance_claim_sales_ok(v_deal.id), false)
      and authz.finance_gate_issue(v_deal.legal_entity_id, v_deal.is_synthetic) is null
      and not exists (select 1 from public.memberships m
                      where m.user_id = (select auth.uid()) and m.legal_entity_id = v_deal.legal_entity_id
                        and m.role_code in ('purchase', 'flight', 'visa') and m.status = 'active');
    if not v_sales then
      return null;
    end if;
  end if;

  select * into r from authz.dues_compute(v_a, v_m, array[]::uuid[], v_syn, v_deal.id, true) c limit 1;
  if r.deal_id is null then
    -- No confirmed version: the Deal is not in dues.
    return null;
  end if;
  v_row := authz.dues_row_json(r.deal_id, r.reference, r.branch_id, r.owner_user_id, r.version_no, r.basis, r.last_approved_at,
    r.newer_pending, r.total, r.money, r.balance, r.overdue, r.due_now, r.next_due_date, r.next_due_open, r.reported,
    r.awaiting, r.credit, r.status, r.cancellation);
  return v_row || jsonb_build_object(
    'instalments', coalesce((
      select jsonb_agg(jsonb_build_object(
          'seq', x.seq, 'label', x.label, 'dueDate', to_char(x.due_date, 'YYYY-MM-DD'),
          'amountPaise', x.amount_paise::text, 'coveredPaise', x.covered::text, 'openPaise', (x.amount_paise - x.covered)::text,
          'status', case when x.amount_paise = x.covered then 'paid' when x.due_date < authz.finance_today() then 'overdue'
                         when x.due_date = authz.finance_today() then 'due_now' else 'upcoming' end,
          'partlyPaid', x.covered > 0 and x.covered < x.amount_paise) order by x.due_date, x.seq)
      from (select i.seq, i.label, i.due_date, i.amount_paise,
              least(i.amount_paise, greatest(greatest(r.money, 0) - coalesce(sum(i.amount_paise) over (
                order by i.due_date, i.seq rows between unbounded preceding and 1 preceding), 0), 0))::bigint as covered
            from public.booking_version_instalments i where i.booking_version_id = r.version_id) x), '[]'::jsonb),
    'tallyInvoices', coalesce((
      select jsonb_agg(jsonb_build_object('id', g.id, 'invoiceRef', g.invoice_ref, 'invoiceDate', to_char(g.invoice_date, 'YYYY-MM-DD'),
          'status', g.status, 'rowVersion', g.row_version,
          'tallyStatus', case when g.status = 'withdrawn' then 'not_applicable' else coalesce(tr.status, 'matched') end)
        order by g.invoice_date, g.created_at)
      from public.deal_tally_invoices g
      left join public.tally_records tr on tr.record_kind = 'tally_gst_invoice' and tr.record_id = g.id
      where g.deal_id = v_deal.id), '[]'::jsonb),
    'supplierPayables', case when r.is_a or r.is_m then authz.dues_supplier_payables(v_deal.id) end,
    -- Accounts phase (20261203000260): explicit viewer mode for the Deal money card.
    'viewer', case when r.is_a then 'accounts' when r.is_m then 'manager' else 'sales' end,
    -- Addition to 8.3 (lead OK needed): the caller is Accounts of the Deal's entity (T4 allowed).
    'canAddTallyInvoice', r.is_a);
end;
$$;


revoke all on function public.supplier_document_link_targets(uuid), public.accounts_filter_options()
  from public, anon, authenticated, service_role;
grant execute on function public.supplier_document_link_targets(uuid), public.accounts_filter_options() to authenticated;

commit;
