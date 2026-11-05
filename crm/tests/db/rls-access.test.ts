import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FIXTURE_DEALS as D,
  FIXTURE_USERS as U,
  type TestDb,
  as,
  asOwner,
  createTestDb,
  expectDbError,
  setActor,
} from '../helpers/db';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

async function visibleDealRefs(): Promise<string[]> {
  const rows = await db.query<{ reference: string }>('select reference from public.deals order by reference');
  return rows.map((r) => r.reference);
}

async function visibleCommercialDealIds(): Promise<string[]> {
  const rows = await db.query<{ deal_id: string }>('select deal_id from public.deal_commercials order by deal_id');
  return rows.map((r) => r.deal_id);
}

describe('A01 owned/assigned deals and explicit wider scope', () => {
  it('ordinary Sales sees only the deal they own', async () => {
    await as(db, { userId: U.salesDelhiA }, async () => {
      expect(await visibleDealRefs()).toEqual(['SYN-DEL-001']);
    });
  });

  it("ordinary Sales cannot fetch a colleague's deal by changing the ID", async () => {
    await as(db, { userId: U.salesDelhiA }, async () => {
      const rows = await db.query('select id from public.deals where id = $1', [D.del002]);
      expect(rows).toEqual([]);
      const assignments = await db.query('select id from public.deal_assignments where deal_id = $1', [D.del002]);
      expect(assignments).toEqual([]);
      const commercials = await db.query('select deal_id from public.deal_commercials where deal_id = $1', [D.del002]);
      expect(commercials).toEqual([]);
    });
  });

  it('assignment grants access to a deal in another branch of the same entity', async () => {
    await as(db, { userId: U.purchaseJodhpur }, async () => {
      expect(await visibleDealRefs()).toEqual(['SYN-DEL-001']);
    });
  });

  it('an ended assignment no longer grants access', async () => {
    await as(db, { userId: U.visaJodhpur }, async () => {
      expect(await visibleDealRefs()).toEqual([]);
    });
  });

  it('a Manager role alone does not widen access', async () => {
    await as(db, { userId: U.managerAhmedabad }, async () => {
      // Holds only an expired Delhi grant and a revoked Ahmedabad grant.
      expect(await visibleDealRefs()).toEqual([]);
    });
  });

  it('an explicit branch grant widens to that branch only', async () => {
    await as(db, { userId: U.managerDelhi }, async () => {
      expect(await visibleDealRefs()).toEqual(['SYN-DEL-001', 'SYN-DEL-002', 'SYN-DEL-003', 'SYN-DEL-004']);
    });
  });

  it('an explicit entity grant covers every branch of that entity, never another entity', async () => {
    await as(db, { userId: U.accountsJodhpur }, async () => {
      expect(await visibleDealRefs()).toEqual([
        'SYN-AMD-001',
        'SYN-DEL-001',
        'SYN-DEL-002',
        'SYN-DEL-003',
        'SYN-DEL-004',
      ]);
    });
  });

  it('Super Admin administers staff but receives no deal data by default', async () => {
    await as(db, { userId: U.adminJodhpur }, async () => {
      expect(await visibleDealRefs()).toEqual([]);
      expect(await visibleCommercialDealIds()).toEqual([]);
    });
  });

  it('a newly created grant takes effect, and revoking it removes access', async () => {
    await asOwner(db, async () => {
      const { id } = (await db.query<{ id: string }>(
        `insert into public.access_grants (user_id, permission_code, legal_entity_id, branch_id, reason, granted_by)
         select $1, 'deal.read', e.id, b.id, 'test: temporary Ahmedabad scope', $2
         from public.legal_entities e join public.branches b on b.legal_entity_id = e.id and b.code = 'AMD'
         where e.code = 'HOLIDAY_CHACHA' returning id`,
        [U.salesDelhiA, U.adminJodhpur],
      ))[0]!;
      await setActor(db, { userId: U.salesDelhiA });
      expect(await visibleDealRefs()).toEqual(['SYN-AMD-001', 'SYN-DEL-001']);
      await db.exec('reset role');
      await db.query(
        `update public.access_grants set revoked_at = now(), revoked_by = $2, revocation_reason = 'test' where id = $1`,
        [id, U.adminJodhpur],
      );
      await db.exec('set local role authenticated');
      expect(await visibleDealRefs()).toEqual(['SYN-DEL-001']);
    });
  });
});

describe('A02 Purchase cannot read selling price or margin', () => {
  it('Purchase sees the assigned deal header but no commercial row', async () => {
    await as(db, { userId: U.purchaseJodhpur }, async () => {
      expect(await visibleDealRefs()).toEqual(['SYN-DEL-001']);
      expect(await visibleCommercialDealIds()).toEqual([]);
    });
  });

  it('the deal header itself carries no selling-side columns', async () => {
    const cols = await asOwner(db, () =>
      db.query<{ column_name: string }>(
        `select column_name from information_schema.columns
         where table_schema = 'public' and table_name = 'deals' order by column_name`,
      ),
    );
    const names = cols.map((c) => c.column_name);
    expect(names.some((n) => /sell|margin|price|amount|paise/.test(n))).toBe(false);
  });

  it('Purchase stays denied even if a commercial grant is inserted behind the command layer', async () => {
    await asOwner(db, async () => {
      await db.query(
        `insert into public.access_grants (user_id, permission_code, legal_entity_id, reason, granted_by)
         select $1, 'deal.read_commercial', id, 'test: misconfigured grant', $2
         from public.legal_entities where code = 'HOLIDAY_CHACHA'`,
        [U.purchaseJodhpur, U.adminJodhpur],
      );
      await setActor(db, { userId: U.purchaseJodhpur });
      expect(await visibleCommercialDealIds()).toEqual([]);
    });
  });

  it('the grant command refuses to give Purchase commercial access', async () => {
    await as(db, { userId: U.adminJodhpur }, async () => {
      await expectDbError(
        db,
        () =>
          db.query(
            `select public.grant_access_scope($1, 'deal.read_commercial',
               (select legal_entity_id from public.memberships where user_id = $1 limit 1), null,
               'test: should be refused')`,
            [U.purchaseJodhpur],
          ),
        { code: '42501', message: /purchase staff cannot receive/ },
      );
    });
  });

  it('commercial audit events are not readable through the API, even by audit readers', async () => {
    await as(db, { userId: U.adminJodhpur }, async () => {
      const rows = await db.query<{ action: string; sensitivity: string; details: unknown }>(
        'select action, sensitivity, details from public.audit_events order by id',
      );
      expect(rows.map((r) => r.action)).toContain('deal.synthetic_viewed');
      expect(rows.every((r) => r.sensitivity === 'standard')).toBe(true);
      expect(JSON.stringify(rows)).not.toMatch(/selling_total/);
    });
    await as(db, { userId: U.purchaseJodhpur }, async () => {
      expect(await db.query('select id from public.audit_events')).toEqual([]);
    });
  });

  it('Sales sees commercial values for their own deal only', async () => {
    await as(db, { userId: U.salesDelhiA }, async () => {
      expect(await visibleCommercialDealIds()).toEqual([D.del001]);
    });
  });
});

describe('A03 cross-branch and cross-entity isolation', () => {
  it('Ahmedabad Sales cannot see Delhi deals', async () => {
    await as(db, { userId: U.salesAhmedabad }, async () => {
      expect(await visibleDealRefs()).toEqual(['SYN-AMD-001']);
    });
  });

  it('a member of a disabled entity sees nothing, including their own deal', async () => {
    await as(db, { userId: U.salesEntityB }, async () => {
      expect(await visibleDealRefs()).toEqual([]);
      expect(await db.query('select id from public.legal_entities')).toEqual([]);
    });
  });

  it('enabling another entity does not leak it to holders of launch-entity grants', async () => {
    await asOwner(db, async () => {
      await db.exec(`update public.legal_entities set status = 'enabled' where code = 'SYNTHETIC_B'`);
      await setActor(db, { userId: U.accountsJodhpur });
      expect(await visibleDealRefs()).not.toContain('SYN-B-001');
      await setActor(db, { userId: U.salesEntityB });
      expect(await visibleDealRefs()).toEqual(['SYN-B-001']);
    });
  });

  it('a membership cannot pair a branch with a different entity', async () => {
    await asOwner(db, async () => {
      await expectDbError(
        db,
        () =>
          db.query(
            `insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status)
             select $1, e.id, 'b0000000-0000-4000-8000-0000000000b1', 'sales', 'active'
             from public.legal_entities e where e.code = 'HOLIDAY_CHACHA'`,
            [U.salesDelhiA],
          ),
        { code: '23503' },
      );
    });
  });

  it('an assignment cannot point at a deal in another entity', async () => {
    await asOwner(db, async () => {
      await expectDbError(
        db,
        () =>
          db.query(
            `insert into public.deal_assignments (deal_id, legal_entity_id, user_id, assignment_kind)
             select $1, e.id, $2, 'purchase' from public.legal_entities e where e.code = 'HOLIDAY_CHACHA'`,
            [D.b001, U.purchaseJodhpur],
          ),
        { code: '23503' },
      );
    });
  });

  it('a user with no membership in the entity cannot be assigned or own a deal there', async () => {
    await asOwner(db, async () => {
      await expectDbError(
        db,
        () =>
          db.query(
            `insert into public.deal_assignments (deal_id, legal_entity_id, user_id, assignment_kind)
             select id, legal_entity_id, $2, 'sales' from public.deals where id = $1`,
            [D.b001, U.salesDelhiA],
          ),
        { code: '23514' },
      );
    });
  });

  it('a grant cannot name a branch from another entity', async () => {
    await as(db, { userId: U.adminJodhpur }, async () => {
      await expectDbError(
        db,
        () =>
          db.query(
            `select public.grant_access_scope($1, 'deal.read',
               (select id from public.legal_entities where code = 'HOLIDAY_CHACHA'),
               'b0000000-0000-4000-8000-0000000000b1', 'test: mixed entity and branch')`,
            [U.salesDelhiB],
          ),
        { code: '23503' },
      );
    });
  });

  it('an administrator of one entity cannot grant access in another', async () => {
    await as(db, { userId: U.adminJodhpur }, async () => {
      await expectDbError(
        db,
        () =>
          db.query(
            `select public.grant_access_scope($1, 'deal.read', 'e0000000-0000-4000-8000-0000000000b0', null,
               'test: foreign entity grant')`,
            [U.salesEntityB],
          ),
        { code: '42501' },
      );
    });
  });
});

describe('MFA acceptance gate: aal2 (require_valid_session) is enforced by the database', () => {
  const everyTable = [
    'legal_entities',
    'branches',
    'staff_profiles',
    'roles',
    'permissions',
    'role_permissions',
    'memberships',
    'access_grants',
    'staff_invitations',
    'deals',
    'deal_assignments',
    'deal_commercials',
    'audit_events',
  ];

  it('a password-only (aal1) session reads zero rows from every table', async () => {
    for (const user of [U.salesDelhiA, U.accountsJodhpur, U.adminJodhpur, U.managerDelhi]) {
      await as(db, { userId: user, aal: 'aal1' }, async () => {
        for (const table of everyTable) {
          const rows = await db.query(`select * from public.${table}`);
          expect(rows, `${table} for ${user}`).toEqual([]);
        }
      });
    }
  });

  it('every command refuses an aal1 session', async () => {
    await as(db, { userId: U.adminJodhpur, aal: 'aal1' }, async () => {
      await expectDbError(
        db,
        () =>
          db.query(
            `select public.grant_access_scope($1, 'deal.read',
               (select id from public.legal_entities where code = 'HOLIDAY_CHACHA'), null, 'test: aal1 attempt')`,
            [U.salesDelhiB],
          ),
        { code: '42501' },
      );
      await expectDbError(
        db,
        () => db.query(`select public.deactivate_staff_member($1, 'test: aal1 attempt')`, [U.salesDelhiB]),
        { code: '42501' },
      );
      await expectDbError(
        db,
        () => db.query(`select public.begin_mfa_recovery($1, 'test: aal1 attempt')`, [U.salesDelhiB]),
        { code: '42501' },
      );
      await expectDbError(
        db,
        () =>
          db.query(
            `select public.create_staff_invitation('new.person@example.test', 'New Person',
               (select id from public.branches where code = 'DEL'), 'sales')`,
          ),
        { code: '42501' },
      );
    });
    await as(db, { userId: U.invitedStaff, aal: 'aal1' }, async () => {
      await expectDbError(db, () => db.query('select public.accept_my_invitation()'), { code: '42501' });
    });
  });

  it('missing or malformed aal claims are treated as aal1', async () => {
    await asOwner(db, async () => {
      // Control: the same user with a well-formed aal2 token sees their deal.
      await setActor(db, { userId: U.salesDelhiA });
      expect(await visibleDealRefs()).toEqual(['SYN-DEL-001']);
      await db.exec('reset role');
      const noAal = { sub: U.salesDelhiA, role: 'authenticated', amr: [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) - 60 }] };
      await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(noAal)]);
      await db.exec('set local role authenticated');
      expect(await visibleDealRefs()).toEqual([]);
      await setActor(db, { userId: U.salesDelhiA, aal: 'AAL2' as never });
      expect(await visibleDealRefs()).toEqual([]);
    });
  });

  it('anonymous requests have no table or command privileges', async () => {
    await as(db, { userId: null }, async () => {
      await expectDbError(db, () => db.query('select id from public.deals'), { code: '42501' });
      await expectDbError(db, () => db.query('select public.accept_my_invitation()'), { code: '42501' });
    });
  });

  it('an invited user completes onboarding only after MFA', async () => {
    await as(db, { userId: U.invitedStaff, aal: 'aal2' }, async () => {
      // Before acceptance: invited profile sees itself, but no business data.
      expect(await db.query('select status from public.staff_profiles')).toEqual([{ status: 'invited' }]);
      expect(await visibleDealRefs()).toEqual([]);
      await db.query('select public.accept_my_invitation()');
      expect(await db.query('select status from public.staff_profiles')).toEqual([{ status: 'active' }]);
      expect(await db.query(`select status from public.memberships`)).toEqual([{ status: 'active' }]);
    });
  });
});

describe('inactive staff and inactive memberships', () => {
  it('a deactivated staff member sees nothing, even for their own deal', async () => {
    await as(db, { userId: U.formerStaff }, async () => {
      expect(await visibleDealRefs()).toEqual([]);
      expect(await visibleCommercialDealIds()).toEqual([]);
    });
  });

  it('an inactive membership disables role access and leaves old grants inert', async () => {
    await as(db, { userId: U.movedStaff }, async () => {
      // Owns SYN-DEL-004 and still holds an unrevoked entity grant, but has no
      // active membership.
      expect(await visibleDealRefs()).toEqual([]);
    });
  });

  it('deactivation through the command takes effect on the next request and is audited', async () => {
    await as(db, { userId: U.adminJodhpur }, async () => {
      await db.query(`select public.deactivate_staff_member($1, 'test: left the company')`, [U.salesDelhiA]);
      const audit = await db.query<{ action: string; actor_user_id: string }>(
        `select action, actor_user_id from public.audit_events where target_id = $1`,
        [U.salesDelhiA],
      );
      expect(audit).toEqual([{ action: 'staff.deactivated', actor_user_id: U.adminJodhpur }]);
      await setActor(db, { userId: U.salesDelhiA });
      expect(await visibleDealRefs()).toEqual([]);
    });
  });
});

describe('commands derive the actor from the session and enforce separation of duties', () => {
  it('authenticated staff have no direct write privileges on any table', async () => {
    await as(db, { userId: U.salesDelhiA }, async () => {
      await expectDbError(
        db,
        () => db.query(`update public.deals set owner_user_id = $1 where id = $2`, [U.salesDelhiA, D.del002]),
        { code: '42501' },
      );
      await expectDbError(
        db,
        () =>
          db.query(
            `insert into public.access_grants (user_id, permission_code, legal_entity_id, reason, granted_by)
             values ($1, 'deal.read', gen_random_uuid(), 'self-service attempt', $2)`,
            [U.salesDelhiA, U.adminJodhpur],
          ),
        { code: '42501' },
      );
      await expectDbError(db, () => db.query(`delete from public.audit_events`), { code: '42501' });
      await expectDbError(
        db,
        () => db.query(`update public.memberships set status = 'active' where user_id = $1`, [U.movedStaff]),
        { code: '42501' },
      );
    });
  });

  it('authz helpers and the service-only link command are not callable by staff', async () => {
    await as(db, { userId: U.adminJodhpur }, async () => {
      await expectDbError(
        db,
        () => db.query(`select public.link_invitation_user(gen_random_uuid(), $1)`, [U.salesDelhiA]),
        { code: '42501' },
      );
      await expectDbError(
        db,
        () =>
          db.query(
            `select authz.write_audit('x.y', null, null, 'x', null, null, '{}'::jsonb)`,
          ),
        { code: '42501' },
      );
    });
  });

  it('a non-administrator cannot grant, deactivate or reset MFA', async () => {
    await as(db, { userId: U.managerDelhi }, async () => {
      await expectDbError(
        db,
        () =>
          db.query(
            `select public.grant_access_scope($1, 'deal.read',
               (select legal_entity_id from public.memberships where user_id = $1 limit 1), null, 'test: manager grant')`,
            [U.salesDelhiB],
          ),
        { code: '42501' },
      );
      await expectDbError(
        db,
        () => db.query(`select public.deactivate_staff_member($1, 'test: manager attempt')`, [U.salesDelhiB]),
        { code: '42501' },
      );
    });
  });

  it('administrators cannot widen their own access, deactivate or reset themselves', async () => {
    await as(db, { userId: U.adminJodhpur }, async () => {
      await expectDbError(
        db,
        () =>
          db.query(
            `select public.grant_access_scope($1, 'deal.read',
               (select id from public.legal_entities where code = 'HOLIDAY_CHACHA'), null, 'test: self grant')`,
            [U.adminJodhpur],
          ),
        { code: '42501', message: /own access/ },
      );
      await expectDbError(
        db,
        () => db.query(`select public.deactivate_staff_member($1, 'test: self deactivation')`, [U.adminJodhpur]),
        { code: '42501' },
      );
      await expectDbError(
        db,
        () => db.query(`select public.begin_mfa_recovery($1, 'test: self reset')`, [U.adminJodhpur]),
        { code: '42501' },
      );
    });
  });

  it('a grant records the session user as grantor and writes an audit event atomically', async () => {
    await as(db, { userId: U.adminJodhpur }, async () => {
      const { id } = (await db.query<{ id: string }>(
        `select public.grant_access_scope($1, 'deal.read',
           (select id from public.legal_entities where code = 'HOLIDAY_CHACHA'),
           (select id from public.branches where code = 'AMD'), 'test: covering Ahmedabad leave') as id`,
        [U.salesDelhiB],
      ))[0]!;
      const [grant] = await db.query<{ granted_by: string }>(
        'select granted_by from public.access_grants where id = $1',
        [id],
      );
      expect(grant!.granted_by).toBe(U.adminJodhpur);
      const audit = await db.query<{ action: string; actor_user_id: string }>(
        'select action, actor_user_id from public.audit_events where target_id = $1',
        [id],
      );
      expect(audit).toEqual([{ action: 'access.grant_created', actor_user_id: U.adminJodhpur }]);
    });
  });

  it('a failing command leaves neither the change nor an audit event behind', async () => {
    const before = await asOwner(db, () => db.query<{ n: string }>('select count(*)::text as n from public.audit_events'));
    await as(db, { userId: U.adminJodhpur }, async () => {
      await expectDbError(
        db,
        () =>
          db.query(
            `select public.grant_access_scope($1, 'deal.read',
               (select id from public.legal_entities where code = 'HOLIDAY_CHACHA'), null, 'short')`,
            [U.salesDelhiB],
          ),
        { code: '23514' },
      );
    });
    const after = await asOwner(db, () => db.query<{ n: string }>('select count(*)::text as n from public.audit_events'));
    expect(after).toEqual(before);
  });

  it('a repeated invitation submit is idempotent; changed access for the same email is rejected', async () => {
    await as(db, { userId: U.adminJodhpur }, async () => {
      const sql = `select public.create_staff_invitation($1, 'New Synthetic Person',
                     (select id from public.branches where code = $2), $3) as id`;
      const [first] = await db.query<{ id: string }>(sql, ['New.Person@Example.test', 'DEL', 'sales']);
      const [second] = await db.query<{ id: string }>(sql, ['new.person@example.test', 'DEL', 'sales']);
      expect(second!.id).toBe(first!.id);
      await expectDbError(db, () => db.query(sql, ['new.person@example.test', 'AMD', 'manager']), {
        code: '23505',
      });
      await expectDbError(db, () => db.query(sql, ['sales.delhi.b@example.test', 'DEL', 'sales']), {
        code: '23505',
        message: /already exists/,
      });
    });
  });

  it('audit events cannot be altered even by the table owner', async () => {
    await asOwner(db, async () => {
      await expectDbError(db, () => db.query(`update public.audit_events set action = 'x.y'`), {
        message: /append-only/,
      });
      await expectDbError(db, () => db.query(`delete from public.audit_events`), { message: /append-only/ });
    });
  });

  it('Batch 1 refuses non-synthetic deals', async () => {
    await asOwner(db, async () => {
      await expectDbError(
        db,
        () => db.query(`update public.deals set is_synthetic = false where id = $1`, [D.del001]),
        { code: '23514' },
      );
    });
  });
});
