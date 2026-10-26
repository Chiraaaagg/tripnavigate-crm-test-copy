import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type ViewerAccess,
  canClaimPurchaseTask,
  canConfirmBooking,
  canReadBooking,
  canEditBookingDraft,
  canReadBookingEvidence,
  canReadPurchaseTask,
} from '@/modules/access/policy';
import { FIXTURE_DEALS, FIXTURE_USERS, type TestDb, asOwner, createTestDb, resetActor, setActor } from '../helpers/db';

/**
 * The Phase 3 application mirror (src/modules/access/policy.ts) must agree with
 * authz.can_edit_booking_draft / can_confirm_booking / can_read_booking_evidence /
 * can_read_purchase_task / can_claim_purchase_task for every fixture user, deal
 * and task. One rolled-back transaction adds a non-owner Sales assignee and
 * one Purchase task per fixture deal so every branch of the rules is exercised.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

async function viewerFacts(userId: string): Promise<ViewerAccess> {
  const memberships = await db.query<{ legal_entity_id: string; branch_id: string; role_code: string }>(
    `select m.legal_entity_id, m.branch_id, m.role_code
     from public.memberships m
     join public.staff_profiles p on p.user_id = m.user_id
     join public.legal_entities e on e.id = m.legal_entity_id
     join public.branches b on b.id = m.branch_id
     where m.user_id = $1 and m.status = 'active' and p.status = 'active'
       and e.status = 'enabled' and b.status = 'enabled'`,
    [userId],
  );
  const rolePermissions = await db.query<{ role_code: string; permission_code: string; scope: 'own' | 'entity' }>(
    'select role_code, permission_code, scope from public.role_permissions',
  );
  const grants = await db.query<{ permission_code: string; legal_entity_id: string; branch_id: string | null }>(
    `select permission_code, legal_entity_id, branch_id from public.access_grants
     where user_id = $1 and revoked_at is null and starts_at <= now() and (expires_at is null or expires_at > now())`,
    [userId],
  );
  return {
    userId,
    memberships: memberships.map((m) => ({ legalEntityId: m.legal_entity_id, branchId: m.branch_id, roleCode: m.role_code })),
    rolePermissions: rolePermissions.map((r) => ({ roleCode: r.role_code, permissionCode: r.permission_code, scope: r.scope })),
    grants: grants.map((g) => ({ permissionCode: g.permission_code, legalEntityId: g.legal_entity_id, branchId: g.branch_id })),
  };
}

describe('booking access mirror matches database policy', () => {
  it('agrees for every fixture user, deal and task', async () => {
    await asOwner(db, async () => {
      // Non-owner Sales assignee on SYN-DEL-001.
      await db.query(
        `insert into public.deal_assignments (deal_id, legal_entity_id, user_id, assignment_kind, assigned_by)
         select id, legal_entity_id, $2, 'sales', $3 from public.deals where id = $1`,
        [FIXTURE_DEALS.del001, FIXTURE_USERS.salesDelhiB, FIXTURE_USERS.adminJodhpur],
      );
      // One synthetic version + task per fixture deal (owner inserts; no confirmation needed for the rules).
      await db.query(
        `insert into public.booking_versions (deal_id, legal_entity_id, branch_id, version_no, created_by)
         select id, legal_entity_id, branch_id, 1, owner_user_id from public.deals`,
      );
      await db.query(
        `insert into public.fulfilment_tasks (deal_id, legal_entity_id, branch_id, booking_version_id, task_key, created_by)
         select deal_id, legal_entity_id, branch_id, id, 'booking:' || id || ':hotel', created_by from public.booking_versions`,
      );
      const deals = await db.query<{
        id: string;
        task_id: string;
        legal_entity_id: string;
        branch_id: string;
        owner_user_id: string;
        assignees: string[];
        sales_assignees: string[];
      }>(
        `select d.id, t.id as task_id, d.legal_entity_id, d.branch_id, d.owner_user_id,
           coalesce(array_agg(a.user_id) filter (where a.user_id is not null and a.ended_at is null), '{}') as assignees,
           coalesce(array_agg(a.user_id) filter (where a.assignment_kind = 'sales' and a.ended_at is null), '{}') as sales_assignees
         from public.deals d
         join public.fulfilment_tasks t on t.deal_id = d.id
         left join public.deal_assignments a on a.deal_id = d.id
         group by d.id, t.id`,
      );
      expect(deals).toHaveLength(Object.keys(FIXTURE_DEALS).length);

      const mismatches: string[] = [];
      const allowed = { edit: 0, confirm: 0, booking: 0, evidence: 0, task: 0, claim: 0 };
      for (const [name, userId] of Object.entries(FIXTURE_USERS)) {
        const viewer = await viewerFacts(userId);
        await setActor(db, { userId });
        const rows = await db.query<{ id: string; edit: boolean; confirm: boolean; booking: boolean; evidence: boolean; task: boolean; claim: boolean }>(
          `select d.id, authz.can_edit_booking_draft(d.id) as edit, authz.can_confirm_booking(d.id) as confirm,
                  authz.can_read_booking(d.id) as booking, authz.can_read_booking_evidence(d.id) as evidence,
                  authz.can_read_purchase_task(d.task_id) as task, authz.can_claim_purchase_task(d.task_id) as claim
           from unnest($1::uuid[], $2::uuid[]) as d(id, task_id)`,
          [deals.map((d) => d.id), deals.map((d) => d.task_id)],
        );
        await resetActor(db);
        for (const d of deals) {
          const facts = {
            legalEntityId: d.legal_entity_id,
            branchId: d.branch_id,
            ownerUserId: d.owner_user_id,
            activeAssigneeIds: d.assignees,
            activeSalesAssigneeIds: d.sales_assignees,
          };
          const sql = rows.find((r) => r.id === d.id)!;
          const ts = {
            edit: canEditBookingDraft(viewer, facts),
            confirm: canConfirmBooking(viewer, facts),
            booking: canReadBooking(viewer, facts),
            evidence: canReadBookingEvidence(viewer, facts),
            task: canReadPurchaseTask(viewer, { legalEntityId: d.legal_entity_id, deal: facts }),
            claim: canClaimPurchaseTask(viewer, { legalEntityId: d.legal_entity_id }),
          };
          for (const k of Object.keys(ts) as (keyof typeof ts)[]) {
            if (sql[k]) allowed[k] += 1;
            if (ts[k] !== sql[k]) mismatches.push(`${name} ${k} ${d.id}: ts=${ts[k]} sql=${sql[k]}`);
          }
        }
      }
      expect(mismatches).toEqual([]);
      // Guard against a vacuous pass. edit: owners A, B, AMD (3) + assignee B on DEL-001 (1)
      // + Manager Delhi on 4 Delhi deals = 8. confirm: 3 owners + 4 manager = 7.
      // booking: 14 deal reads (13 fixture + the assignee) minus Purchase's 1 = 13.
      // evidence (A4 M2) = edit OR confirm = 8. task: 13 + Purchase's 5 entity tasks = 18.
      // claim: Purchase on the 5 Holiday Chacha tasks = 5.
      expect(allowed).toEqual({ edit: 8, confirm: 7, booking: 13, evidence: 8, task: 18, claim: 5 });
    });
  });
});
