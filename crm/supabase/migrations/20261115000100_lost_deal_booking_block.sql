-- TripNavigate CRM - Stage 7: bookings start only on active Deals.
--
-- Owner decision (9 October 2026): a new booking draft may not be opened while
-- the Deal's current Bitrix stage is a lost or rejected stage. Existing drafts,
-- confirmed bookings, Purchase work, money and history are untouched; only
-- opening a NEW draft is refused. When the Bitrix sync moves the Deal back to
-- an active stage, opening works again. Synthetic and CRM-native Deals (no
-- Bitrix stage) are not affected.
--
-- Where the stage list lives: the CRM does not store Bitrix stage semantics
-- (Bitrix's STAGE_SEMANTIC_ID / crm.status SEMANTICS is not synced; deals keep
-- only source_stage_id), so the lost/rejected stages are listed once, in the
-- private table authz.lost_deal_stages. Changing the list is a data change
-- (insert or delete a row; owner-approved hosted write), not a code change or
-- deploy. The table is in the private authz schema: not exposed through the
-- Data API and not part of the generated public types.
--
-- Seeded from the hosted intake configuration (eligible stages, read
-- 9 October 2026):
--   pipeline 0: LOSE, UC_U11OBT (both "Booking Rejected")
--   pipeline 1: C1:LOSE, C1:APOLOGY ("Analyze failure")
-- Bitrix stage IDs are unique across pipelines (pipeline N > 0 uses the
-- "CN:" prefix), so the stage ID alone identifies the stage.
--
-- Refused with 'deal_not_active' (SQLSTATE 55000):
--   booking_open_draft, only when it would create a new draft version. The
--   check runs after the removed-Deal check, the role check, the environment
--   check, the Deal lock, the already-confirmed check and the existing-draft
--   return, so non-members still get not_authorized and an existing draft is
--   still returned (created = false).
-- The Deal row is read under the FOR NO KEY UPDATE lock booking_open_draft
-- already takes; the sync's stage update takes the same lock, so the check
-- sees the committed stage.
--
-- booking_panel adds 'dealNotActive' (boolean) so the Deal page can say why a
-- booking cannot be started instead of offering the control.
--
-- Rollout order: deploy the app that knows 'deal_not_active' BEFORE (or
-- together with) this migration. An older app maps the new 55000 token to a
-- generic failure and still offers the start control on lost Deals; the new
-- app reads dealNotActive as optional, so it is safe before the migration.
--
-- Replaced bodies: public.booking_open_draft (latest 20261107000300) and
-- public.booking_panel (latest 20261004000100), copied unchanged except the
-- lines marked "Stage 7". Signatures, grants and existing return keys are
-- unchanged. Rollback: forward-only (restore the previous bodies; the table
-- and helper may stay).

begin;
set local lock_timeout = '15s';

-- ---------------------------------------------------------------------------
-- The lost/rejected Bitrix stages (one place)
-- ---------------------------------------------------------------------------

create table authz.lost_deal_stages (
  stage_id text primary key check (length(stage_id) between 1 and 50),
  label text not null check (length(label) between 1 and 120),
  created_at timestamptz not null default now()
);
comment on table authz.lost_deal_stages is
  'Bitrix Deal stages (deals.source_stage_id) that count as lost or rejected. A new booking draft cannot be opened on a Deal in one of these stages (Stage 7, owner decision 9 October 2026). Edit rows to change the list; no code change needed.';

alter table authz.lost_deal_stages enable row level security;
revoke all on authz.lost_deal_stages from public, anon, authenticated, service_role;

insert into authz.lost_deal_stages (stage_id, label) values
  ('LOSE', 'Booking Rejected (pipeline 0)'),
  ('UC_U11OBT', 'Booking Rejected (pipeline 0)'),
  ('C1:LOSE', 'Lost (pipeline 1)'),
  ('C1:APOLOGY', 'Analyze failure (pipeline 1)');

-- True when p_deal is a Bitrix Deal whose current stage is lost or rejected.
-- Synthetic and CRM-native Deals have no Bitrix stage and are never "not active".
create function authz.deal_not_active(p_deal uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.deals d
    join authz.lost_deal_stages s on s.stage_id = d.source_stage_id
    where d.id = p_deal and d.source_system = 'bitrix'
  )
$$;

revoke all on function authz.deal_not_active(uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Booking (replaces 20261107000300)
-- ---------------------------------------------------------------------------

create or replace function public.booking_open_draft(p_deal_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_deal public.deals%rowtype;
  v_ver public.booking_versions%rowtype;
begin
  -- Stage 0: a Deal removed by the Bitrix sync takes no new booking work.
  perform authz.refuse_removed_deal(p_deal_id);
  if p_deal_id is null or not authz.can_edit_booking_draft(p_deal_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if authz.deployment_environment() = 'unset' then
    raise exception 'environment_unset' using errcode = '55000';
  end if;
  -- Serializes concurrent opens for one deal.
  select * into v_deal from public.deals d where d.id = p_deal_id for no key update;
  if exists (select 1 from public.booking_versions v where v.deal_id = p_deal_id and v.status = 'confirmed') then
    raise exception 'already_confirmed' using errcode = '55000';
  end if;
  select * into v_ver from public.booking_versions v where v.deal_id = p_deal_id and v.status = 'draft';
  if v_ver.id is not null then
    return jsonb_build_object('versionId', v_ver.id, 'versionNo', v_ver.version_no,
      'rowVersion', v_ver.row_version, 'created', false);
  end if;
  -- Stage 7: a new draft only on an active Deal. Runs after the lock above, so
  -- it reads the stage the sync last committed.
  if authz.deal_not_active(v_deal.id) then
    raise exception 'deal_not_active' using errcode = '55000';
  end if;

  insert into public.booking_versions (deal_id, legal_entity_id, branch_id, version_no, created_by)
  values (v_deal.id, v_deal.legal_entity_id, v_deal.branch_id,
    coalesce((select max(v.version_no) from public.booking_versions v where v.deal_id = v_deal.id), 0) + 1,
    (select auth.uid()))
  returning * into v_ver;

  perform authz.write_audit('booking.draft_opened', v_deal.legal_entity_id, v_deal.branch_id,
    'booking_version', v_ver.id, null,
    jsonb_build_object('dealId', v_deal.id, 'versionNo', v_ver.version_no));
  return jsonb_build_object('versionId', v_ver.id, 'versionNo', v_ver.version_no,
    'rowVersion', v_ver.row_version, 'created', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- Booking panel (replaces 20261004000100)
-- ---------------------------------------------------------------------------

create or replace function public.booking_panel(p_deal_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_ver public.booking_versions%rowtype;
  v_version jsonb;
  v_readiness jsonb;
  v_issues text[];
  v_evidence jsonb;
  v_task jsonb;
  v_can_edit boolean;
  v_can_confirm boolean;
begin
  if not authz.session_ok() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  -- Purchase role holders and non-readers get null (Purchase uses purchase_task_*).
  if p_deal_id is null or not authz.can_read_booking(p_deal_id) then
    return null;
  end if;

  select * into v_ver from public.booking_versions v
  where v.deal_id = p_deal_id
  order by (v.status = 'confirmed') desc, v.version_no desc
  limit 1;

  if v_ver.id is not null then
    v_version := jsonb_build_object(
      'versionId', v_ver.id,
      'versionNo', v_ver.version_no,
      'status', v_ver.status,
      'rowVersion', v_ver.row_version,
      'contentHash', v_ver.content_hash,
      'facts', authz.booking_facts_json(v_ver.id),
      'confirmedAt', v_ver.confirmed_at,
      'confirmedByName', (select p.display_name from public.staff_profiles p where p.user_id = v_ver.confirmed_by));
    if authz.can_read_deal_commercial(p_deal_id) then
      v_version := v_version || jsonb_build_object('sellingTotalPaise',
        (select c.selling_total_paise::text from public.booking_version_commercials c where c.version_id = v_ver.id));
    end if;
    if v_ver.status = 'draft' then
      v_issues := authz.booking_issues_for_viewer(v_ver.id);
      v_readiness := jsonb_build_object('ready', cardinality(v_issues) = 0, 'issues', to_jsonb(v_issues),
        'contentHash', v_ver.content_hash);
    end if;
    select coalesce(jsonb_agg(jsonb_build_object(
        'id', e.id,
        'kind', e.kind,
        'fileName', e.file_name,
        'mime', e.mime,
        'sizeBytes', e.size_bytes,
        'status', e.status,
        'uploadedByYou', e.uploaded_by = (select auth.uid()),
        'createdAt', e.created_at,
        'storedAt', e.stored_at) order by e.created_at, e.id), '[]'::jsonb)
    into v_evidence
    from public.booking_evidence e
    where e.version_id = v_ver.id and e.status <> 'removed'
      and authz.can_read_booking_evidence(p_deal_id);  -- A4 M2
    select jsonb_build_object('taskId', t.id, 'status', t.status, 'assigneeName', p.display_name)
    into v_task
    from public.fulfilment_tasks t
    left join public.staff_profiles p on p.user_id = t.assignee_user_id
    where t.booking_version_id = v_ver.id;
  end if;

  v_can_edit := coalesce(v_ver.status, 'draft') = 'draft' and authz.can_edit_booking_draft(p_deal_id);
  v_can_confirm := v_ver.status = 'draft' and authz.can_confirm_booking(p_deal_id);

  return jsonb_build_object(
    'dealId', p_deal_id,
    'canEdit', coalesce(v_can_edit, false),
    'canConfirm', coalesce(v_can_confirm, false),
    'gate', jsonb_build_object(
      'realBookingEnabled', coalesce((select s.real_booking_enabled from public.booking_settings s where s.id), false),
      'environment', authz.deployment_environment()),
    'version', v_version,
    'readiness', v_readiness,
    'evidence', coalesce(v_evidence, '[]'::jsonb),
    -- Re-review M-NEW-1: tells the UI the list was withheld, not empty.
    'evidenceVisible', authz.can_read_booking_evidence(p_deal_id),
    'task', v_task,
    -- Stage 7: the Deal is lost or rejected in Bitrix, so a new booking cannot be started.
    'dealNotActive', authz.deal_not_active(p_deal_id));
end;
$$;

commit;
