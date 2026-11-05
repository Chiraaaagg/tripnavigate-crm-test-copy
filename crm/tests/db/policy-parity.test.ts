import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ViewerAccess, canReadDeal, canReadDealCommercial } from '@/modules/access/policy';
import { FIXTURE_DEALS, FIXTURE_USERS, type TestDb, as, asOwner, createTestDb } from '../helpers/db';

/**
 * The application mirror (src/modules/access/policy.ts) must agree with the
 * database (authz.can_read_deal / can_read_deal_commercial) for every fixture
 * user and deal. A drift here would make DTO filtering disagree with RLS.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

async function viewerFacts(userId: string): Promise<ViewerAccess> {
  return asOwner(db, async () => {
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
  });
}

describe('TypeScript access mirror matches database policy', () => {
  it('agrees for every fixture user and deal', async () => {
    const deals = await asOwner(db, () =>
      db.query<{ id: string; legal_entity_id: string; branch_id: string; owner_user_id: string; assignees: string[] }>(
        `select d.id, d.legal_entity_id, d.branch_id, d.owner_user_id,
                coalesce(array_agg(a.user_id) filter (where a.user_id is not null and a.ended_at is null), '{}') as assignees
         from public.deals d left join public.deal_assignments a on a.deal_id = d.id
         group by d.id`,
      ),
    );
    expect(deals).toHaveLength(Object.keys(FIXTURE_DEALS).length);
    const mismatches: string[] = [];
    let allowedReads = 0;
    let allowedCommercial = 0;
    for (const [name, userId] of Object.entries(FIXTURE_USERS)) {
      const viewer = await viewerFacts(userId);
      const dbResult = await as(db, { userId }, () =>
        db.query<{ id: string; can_read: boolean; can_commercial: boolean }>(
          `select d.id, authz.can_read_deal(d.id) as can_read, authz.can_read_deal_commercial(d.id) as can_commercial
           from (select unnest($1::uuid[]) as id) d`,
          [deals.map((d) => d.id)],
        ),
      );
      for (const d of deals) {
        const facts = {
          legalEntityId: d.legal_entity_id,
          branchId: d.branch_id,
          ownerUserId: d.owner_user_id,
          activeAssigneeIds: d.assignees,
        };
        const expected = dbResult.find((r) => r.id === d.id)!;
        if (expected.can_read) allowedReads += 1;
        if (expected.can_commercial) allowedCommercial += 1;
        if (canReadDeal(viewer, facts) !== expected.can_read) mismatches.push(`${name} read ${d.id}`);
        if (canReadDealCommercial(viewer, facts) !== expected.can_commercial) mismatches.push(`${name} commercial ${d.id}`);
      }
    }
    expect(mismatches).toEqual([]);
    // Guard against a vacuous pass: 13 reads (1+1+1+1 owners/assignee, 4 Delhi grant, 5 entity grant)
    // and 8 commercial (3 Sales owners + 5 Accounts entity grant; Purchase and Manager none).
    expect(allowedReads).toBe(13);
    expect(allowedCommercial).toBe(8);
  });
});
