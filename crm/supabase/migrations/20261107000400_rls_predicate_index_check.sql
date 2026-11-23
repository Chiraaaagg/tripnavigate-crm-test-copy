-- TripNavigate CRM - Stage 0: one definition of the AUDIT-030 RLS predicate indexes.
--
-- Product 20261102000100_rls_predicate_indexes creates deals_owner_user_idx,
-- fulfilment_tasks_assignee_idx and booking_evidence_deal_idx. Main's copy
-- (20261009001100, moved byte for byte to 20261107000200) runs after it and,
-- through IF NOT EXISTS, creates nothing. IF NOT EXISTS checks only the name,
-- so this migration checks the definitions: each index must exist exactly
-- once, with exactly the product definition. Any difference stops the
-- migration (nothing applied) instead of silently keeping a different index
-- under the same name. No schema or data change.

begin;

do $$
declare
  v_expected constant text[][] := array[
    array['deals_owner_user_idx',
          'CREATE INDEX deals_owner_user_idx ON public.deals USING btree (owner_user_id)'],
    array['fulfilment_tasks_assignee_idx',
          'CREATE INDEX fulfilment_tasks_assignee_idx ON public.fulfilment_tasks USING btree (assignee_user_id) WHERE (assignee_user_id IS NOT NULL)'],
    array['booking_evidence_deal_idx',
          'CREATE INDEX booking_evidence_deal_idx ON public.booking_evidence USING btree (deal_id)']
  ];
  v_defs text[];
  i integer;
begin
  for i in 1 .. array_length(v_expected, 1) loop
    select array_agg(x.indexdef) into v_defs
    from pg_catalog.pg_indexes x
    where x.schemaname = 'public' and x.indexname = v_expected[i][1];
    if v_defs is distinct from array[v_expected[i][2]] then
      raise exception 'index % differs from its single expected definition: %',
        v_expected[i][1], coalesce(v_defs::text, 'missing')
        using errcode = '55000';
    end if;
  end loop;
end;
$$;

commit;
