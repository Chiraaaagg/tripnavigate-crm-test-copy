import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type Actor,
  FIXTURE_DEALS as D,
  FIXTURE_EMAILS as EMAIL,
  FIXTURE_USERS as U,
  type TestDb,
  amrAt,
  as,
  asOwner,
  createTestDb,
  expectDbError,
  insertFactor,
  insertSession,
  nowSeconds,
  resetActor,
  setActor,
} from '../helpers/db';

/**
 * Phase 1.5 session barrier, MFA recovery, staff email deliveries and bootstrap
 * (contract docs/implementation/phase-1-5-contract.md, test matrix T02-T09,
 * T11, T12 and the SQL half of T13).
 *
 * Every scenario runs in ONE rolled-back transaction, so now() (and therefore
 * every barrier set during the scenario) is the transaction start time. A token
 * that "authenticated before the barrier" uses the default amr (60 s ago); a
 * "new sign-in after the barrier" uses amrAt(-2), i.e. a whole second later than
 * the barrier second (same-second sign-in is denied by design, tested below).
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const ORIGINAL_TABLES = [
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
const NEW_TABLES = [
  'security_policy',
  'staff_security_state',
  'recovery_verification_methods',
  'staff_email_deliveries',
];
const EVERY_TABLE = [...ORIGINAL_TABLES, ...NEW_TABLES];
const SYNTHETIC_METHOD = 'SYNTHETIC_TEST_CALLBACK';

type CaseJson = {
  caseId: string;
  userId: string;
  status: string;
  providerAttempts: number;
  lastProviderError: string | null;
  openedBy: string;
  completedAt: string | null;
};
type DeliveryJson = {
  deliveryId: string;
  userId: string;
  kind: string;
  status: string;
  attemptNo: number;
  errorCode: string | null;
  completedAt: string | null;
};

const fresh = (userId: string, extra: Partial<Actor> = {}): Actor => ({ userId, amr: amrAt(-2), ...extra });
const service: Actor = { userId: null, role: 'service_role' };

async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  const rows = await db.query<{ r: T }>(sql, params);
  return rows[0]!.r;
}

async function sessionState(): Promise<Record<string, unknown>> {
  return one('select public.my_session_status() as r');
}

async function visibleDealRefs(): Promise<string[]> {
  const rows = await db.query<{ reference: string }>('select reference from public.deals order by reference');
  return rows.map((r) => r.reference);
}

/** Row counts the current actor can read on every table (permission errors count as 0 via savepoint). */
async function readableRowCounts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of EVERY_TABLE) {
    const [r] = await db.query<{ n: number }>(`select count(*)::int as n from public.${t}`);
    out[t] = r!.n;
  }
  const [c] = await db.query<{ n: number }>('select count(id)::int as n from public.mfa_recovery_cases');
  out.mfa_recovery_cases = c!.n;
  return out;
}

function allZero(counts: Record<string, number>): boolean {
  return Object.values(counts).every((n) => n === 0);
}

async function beginRecovery(target: string, admin: string = U.adminJodhpur): Promise<CaseJson> {
  await setActor(db, { userId: admin });
  return one<CaseJson>(`select public.begin_mfa_recovery($1, 'Lost phone, verified by callback') as r`, [target]);
}

async function recordProvider(caseId: string, ok: boolean, code: string | null = null): Promise<CaseJson> {
  await setActor(db, service);
  return one<CaseJson>('select public.record_mfa_recovery_provider_result($1, $2, $3) as r', [caseId, ok, code]);
}

/** Every write/administrative command must refuse the current actor with 42501. */
async function expectEveryCommandRefused(caseId: string): Promise<void> {
  const calls: Array<[string, unknown[]]> = [
    [
      `select public.create_staff_invitation('x.person@example.test', 'X Person',
         (select id from public.branches where code = 'DEL'), 'sales')`,
      [],
    ],
    [
      `select public.grant_access_scope($1, 'deal.read', (select id from public.legal_entities where code = 'HOLIDAY_CHACHA'),
         null, 'test: should be refused')`,
      [U.salesAhmedabad],
    ],
    [`select public.revoke_access_grant(gen_random_uuid(), 'test: should be refused')`, []],
    [`select public.deactivate_staff_member($1, 'test: should be refused')`, [U.salesAhmedabad]],
    [`select public.begin_mfa_recovery($1, 'test: should be refused')`, [U.salesAhmedabad]],
    [`select public.confirm_mfa_recovery($1, $2, 'ABCDEF', null)`, [caseId, SYNTHETIC_METHOD]],
    [`select public.request_staff_email($1, 'password_reset')`, [U.salesAhmedabad]],
    [`select public.accept_my_invitation()`, []],
    [`select public.register_my_recovery_factor()`, []],
    [`select public.record_mfa_recovery_provider_result($1, true, null)`, [caseId]],
    [`select public.record_staff_email_result(gen_random_uuid(), true, null)`, []],
    [`select public.bootstrap_first_admin(gen_random_uuid(), 'x@example.test', 'X', 'JDH', 'op')`, []],
    [`select public.link_invitation_user(gen_random_uuid(), gen_random_uuid())`, []],
  ];
  for (const [sql, params] of calls) {
    await expectDbError(db, () => db.query(sql, params), { code: '42501' });
  }
}

/** Makes salesDelhiB a second super_admin so a recovered user can also be an administrator. */
async function promoteSalesDelhiBToAdmin(): Promise<void> {
  await resetActor(db);
  await db.query(
    `insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status)
     select $1, b.legal_entity_id, b.id, 'super_admin', 'active'
     from public.branches b join public.legal_entities e on e.id = b.legal_entity_id
     where e.code = 'HOLIDAY_CHACHA' and b.code = 'JDH'`,
    [U.salesDelhiB],
  );
}

describe('T02 old aal2 token is denied everywhere once recovery begins', () => {
  it('a pre-barrier aal2 token reads zero rows on every table and every command is refused', async () => {
    await asOwner(db, async () => {
      await promoteSalesDelhiBToAdmin();
      // Control: before the barrier the same token reads data and administers.
      await setActor(db, { userId: U.salesDelhiB });
      const before = await readableRowCounts();
      expect(before.deals).toBe(1);
      expect(before.staff_profiles).toBeGreaterThan(5);
      expect((await sessionState()).state).toBe('ok');

      const c = await beginRecovery(U.salesDelhiB);
      expect(c.status).toBe('provider_pending');

      await setActor(db, { userId: U.salesDelhiB });
      expect(allZero(await readableRowCounts())).toBe(true);
      expect((await sessionState()).state).toBe('session_revoked');
      await expectEveryCommandRefused(c.caseId);
    });
  });
});

describe('T03 provider failure keeps the user blocked; retry returns the same case', () => {
  it('records provider_failed, stays denied, and a retry reuses the case', async () => {
    await asOwner(db, async () => {
      const c = await beginRecovery(U.salesDelhiA);
      const failed = await recordProvider(c.caseId, false, 'AuthApiError: timeout <x@y.test>');
      expect(failed).toMatchObject({ caseId: c.caseId, status: 'provider_failed', providerAttempts: 1 });
      expect(failed.lastProviderError).toMatch(/^[A-Za-z0-9_.:-]+$/);

      // Old token and even a fresh sign-in stay denied while the case is open.
      for (const actor of [{ userId: U.salesDelhiA }, fresh(U.salesDelhiA)]) {
        await setActor(db, actor);
        expect(allZero(await readableRowCounts())).toBe(true);
      }

      const retry = await beginRecovery(U.salesDelhiA);
      expect(retry.caseId).toBe(c.caseId);
      expect(retry.status).toBe('provider_failed');

      const ok = await recordProvider(c.caseId, true);
      expect(ok).toMatchObject({ caseId: c.caseId, status: 'awaiting_reenrollment', providerAttempts: 2 });
      expect(ok.lastProviderError).toBeNull();
      // A late duplicate "ok" is idempotent; a late "failed" is refused.
      expect((await recordProvider(c.caseId, true)).providerAttempts).toBe(2);
      await expectDbError(db, () => recordProvider(c.caseId, false, 'late'), { code: '22023' });

      await setActor(db, fresh(U.salesDelhiA));
      expect(await visibleDealRefs()).toEqual([]);
    });
  });
});

describe('T04 repeated begin: one case, one barrier move', () => {
  it('returns the same open case and audits one barrier move', async () => {
    await asOwner(db, async () => {
      const first = await beginRecovery(U.salesDelhiA);
      await resetActor(db);
      const [{ after: barrier1 }] = (await db.query<{ after: string }>(
        'select sessions_valid_after::text as after from public.staff_security_state where user_id = $1',
        [U.salesDelhiA],
      )) as [{ after: string }];
      const second = await beginRecovery(U.salesDelhiA);
      const third = await beginRecovery(U.salesDelhiA);
      expect(second.caseId).toBe(first.caseId);
      expect(third.caseId).toBe(first.caseId);
      await resetActor(db);
      const [{ after: barrier2 }] = (await db.query<{ after: string }>(
        'select sessions_valid_after::text as after from public.staff_security_state where user_id = $1',
        [U.salesDelhiA],
      )) as [{ after: string }];
      expect(barrier2).toBe(barrier1);
      const cases = await db.query('select id from public.mfa_recovery_cases where user_id = $1', [U.salesDelhiA]);
      expect(cases).toHaveLength(1);
      const started = await db.query(
        `select id from public.audit_events where action = 'staff.mfa_recovery_started' and target_id = $1`,
        [first.caseId],
      );
      expect(started).toHaveLength(1);
    });
  });

  // True concurrency cannot be exercised on single-connection PGlite. The
  // database guarantees it with a row lock on staff_security_state (serializes
  // concurrent begins) plus this unique partial index as the last line.
  it('the unique partial index refuses a second open case even behind the command layer', async () => {
    await asOwner(db, async () => {
      await beginRecovery(U.salesDelhiA);
      await resetActor(db);
      await expectDbError(
        db,
        () =>
          db.query(
            `insert into public.mfa_recovery_cases (user_id, reason, opened_by) values ($1, 'second open case attempt', $2)`,
            [U.salesDelhiA, U.adminJodhpur],
          ),
        { code: '23505' },
      );
    });
  });

  it('only an administrator of every entity of the target may begin, never on themselves', async () => {
    await as(db, { userId: U.managerDelhi }, async () => {
      await expectDbError(db, () => db.query(`select public.begin_mfa_recovery($1, 'manager attempt here')`, [U.salesDelhiA]), {
        code: '42501',
      });
    });
    await as(db, { userId: U.adminJodhpur }, async () => {
      await expectDbError(db, () => db.query(`select public.begin_mfa_recovery($1, 'entity B staff here')`, [U.salesEntityB]), {
        code: '42501',
      });
      await expectDbError(db, () => db.query(`select public.begin_mfa_recovery($1, 'short')`, [U.salesDelhiA]), {
        code: '22023',
      });
      // Inactive staff cannot be put through recovery (deactivation already blocks them).
      await expectDbError(db, () => db.query(`select public.begin_mfa_recovery($1, 'already left company')`, [U.formerStaff]), {
        code: '22023',
      });
    });
  });
});

describe('T05 a new sign-in during an open case is denied (S6)', () => {
  it('denies a fresh aal2 session, even with the old factor, and reports recovery_pending', async () => {
    await asOwner(db, async () => {
      const c = await beginRecovery(U.salesDelhiA);
      await setActor(db, fresh(U.salesDelhiA));
      expect(allZero(await readableRowCounts())).toBe(true);
      const status = await sessionState();
      expect(status).toMatchObject({ state: 'recovery_pending', recovery: { caseId: c.caseId, status: 'provider_pending' } });
      expect(status.recovery).not.toHaveProperty('confirmationCode');
      await setActor(db, fresh(U.salesDelhiA, { aal: 'aal1' }));
      expect((await sessionState()).state).toBe('mfa_required');
    });
  });
});

/** Moves a recovery case and the user's barrier `seconds` into the past (simulates elapsed time). */
async function shiftRecoveryBack(caseId: string, userId: string, seconds: number): Promise<void> {
  await resetActor(db);
  await db.query(
    `update public.mfa_recovery_cases
     set opened_at = opened_at - make_interval(secs => $2::double precision),
         provider_completed_at = provider_completed_at - make_interval(secs => $2::double precision)
     where id = $1`,
    [caseId, seconds],
  );
  await db.query(
    `update public.staff_security_state
     set sessions_valid_after = sessions_valid_after - make_interval(secs => $2::double precision)
     where user_id = $1`,
    [userId, seconds],
  );
}
const ago = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString();

/** Case at awaiting_reenrollment whose provider step finished an hour ago. */
async function readyCase(userId: string): Promise<CaseJson> {
  const c = await beginRecovery(userId);
  await recordProvider(c.caseId, true);
  await shiftRecoveryBack(c.caseId, userId, 3600);
  return c;
}

/** A new verified factor (50 min ago) and an Auth session that verified with it (45 min ago). */
async function enrolNewFactor(userId: string): Promise<{ factorId: string; sessionId: string; actor: Actor }> {
  await resetActor(db);
  const factorId = await insertFactor(db, { userId, createdAt: ago(3000) });
  const sessionId = await insertSession(db, { userId, factorId });
  return { factorId, sessionId, actor: { userId, amr: amrAt(2700), sessionId } };
}

async function register(): Promise<{ status: string; confirmation_code: string | null; refused?: string }> {
  return one('select public.register_my_recovery_factor() as r');
}

describe('T06 register and confirm the new factor', () => {
  it('enforces every rule and restores access only for sessions after the completion barrier', async () => {
    await asOwner(db, async () => {
      const oldFactor = await insertFactor(db, { userId: U.salesDelhiA, createdAt: ago(86_400) });
      const c = await beginRecovery(U.salesDelhiA);

      // Old session, aal1, or a session without session_id cannot register;
      // a fresh bound session cannot either while the provider step is pending.
      await setActor(db, { userId: U.salesDelhiA });
      await expectDbError(db, () => register(), { code: '42501' });
      await setActor(db, fresh(U.salesDelhiA, { aal: 'aal1' }));
      await expectDbError(db, () => register(), { code: '42501' });
      await setActor(db, fresh(U.salesDelhiA));
      await expectDbError(db, () => register(), { code: '42501' });
      await setActor(db, fresh(U.salesDelhiA, { sessionId: crypto.randomUUID() }));
      await expectDbError(db, () => register(), { code: '22023', message: /not ready/ });

      await resetActor(db);
      await db.query('delete from auth.mfa_factors where id = $1', [oldFactor]);
      await recordProvider(c.caseId, true);
      await shiftRecoveryBack(c.caseId, U.salesDelhiA, 3600);

      // No new factor; only an unverified one; or one dated before the provider step: refused.
      const plain = await insertSession(db, { userId: U.salesDelhiA, factorId: null });
      await setActor(db, { userId: U.salesDelhiA, amr: amrAt(2700), sessionId: plain });
      await expectDbError(db, () => register(), { code: '22023', message: /no new verified authenticator/ });
      await resetActor(db);
      await insertFactor(db, { userId: U.salesDelhiA, status: 'unverified', createdAt: ago(3000) });
      await insertFactor(db, { userId: U.salesDelhiA, createdAt: ago(3 * 3600) });
      await setActor(db, { userId: U.salesDelhiA, amr: amrAt(2700), sessionId: plain });
      await expectDbError(db, () => register(), { code: '22023' });

      const { factorId: newFactor, actor: bound } = await enrolNewFactor(U.salesDelhiA);
      // A session that did not verify with the new factor cannot register it.
      await setActor(db, { userId: U.salesDelhiA, amr: amrAt(2700), sessionId: plain });
      await expectDbError(db, () => register(), { code: '42501', message: /not verified with the new authenticator/ });

      await setActor(db, bound);
      const reg = await register();
      expect(reg.status).toBe('awaiting_admin_confirmation');
      expect(reg.confirmation_code).toMatch(/^[0-9A-Z]{6}$/);
      const code = reg.confirmation_code!;
      expect((await register()).confirmation_code).toBe(code); // idempotent for the bound session
      expect(await sessionState()).toMatchObject({
        state: 'recovery_pending',
        recovery: { caseId: c.caseId, status: 'awaiting_admin_confirmation', confirmationCode: code },
      });
      expect(allZero(await readableRowCounts())).toBe(true);

      // Another session (even one verified with the same new factor) never sees the code.
      await resetActor(db);
      const other = await insertSession(db, { userId: U.salesDelhiA, factorId: newFactor });
      await setActor(db, { userId: U.salesDelhiA, amr: amrAt(2700), sessionId: other });
      const otherStatus = await sessionState();
      expect(otherStatus).toMatchObject({ state: 'recovery_pending', recovery: { status: 'awaiting_admin_confirmation' } });
      expect(otherStatus.recovery).not.toHaveProperty('confirmationCode');
      await setActor(db, { userId: U.salesDelhiA, amr: amrAt(2700) });
      expect((await sessionState()).recovery).not.toHaveProperty('confirmationCode');

      await resetActor(db);
      const [stored] = await db.query<{ new_factor_id: string }>('select new_factor_id from public.mfa_recovery_cases where id = $1', [
        c.caseId,
      ]);
      expect(stored!.new_factor_id).toBe(newFactor);

      // The administrator can see the case status but never the code.
      await setActor(db, { userId: U.adminJodhpur });
      expect(await db.query('select status from public.mfa_recovery_cases where id = $1', [c.caseId])).toEqual([
        { status: 'awaiting_admin_confirmation' },
      ]);
      await expectDbError(db, () => db.query('select confirmation_code from public.mfa_recovery_cases'), { code: '42501' });
      await expectDbError(db, () => db.query('select recovery_session_id from public.mfa_recovery_cases'), { code: '42501' });

      await expectDbError(
        db,
        () => db.query(`select public.confirm_mfa_recovery($1, 'PHONE_CALL', $2, null)`, [c.caseId, code]),
        { code: '22023', message: /not approved/ },
      );
      await setActor(db, bound);
      await expectDbError(
        db,
        () => db.query(`select public.confirm_mfa_recovery($1, $2, $3, null)`, [c.caseId, SYNTHETIC_METHOD, code]),
        { code: '42501' },
      );
      await setActor(db, { userId: U.managerDelhi });
      await expectDbError(
        db,
        () => db.query(`select public.confirm_mfa_recovery($1, $2, $3, null)`, [c.caseId, SYNTHETIC_METHOD, code]),
        { code: '42501' },
      );

      // Wrong code: no state change, counted and audited.
      await setActor(db, { userId: U.adminJodhpur });
      const wrong = await one<CaseJson>(`select public.confirm_mfa_recovery($1, $2, 'ZZZZZZ', 'wrong code test') as r`, [
        c.caseId,
        SYNTHETIC_METHOD,
      ]);
      expect(wrong.status).toBe('awaiting_admin_confirmation');
      await resetActor(db);
      expect(
        await db.query<{ confirm_failures: number }>('select confirm_failures from public.mfa_recovery_cases where id = $1', [
          c.caseId,
        ]),
      ).toEqual([{ confirm_failures: 1 }]);
      expect(
        await db.query(`select id from public.audit_events where action = 'staff.mfa_recovery_confirm_failed' and target_id = $1`, [
          c.caseId,
        ]),
      ).toHaveLength(1);

      // Correct code (case/whitespace-insensitive) completes the case.
      await setActor(db, { userId: U.adminJodhpur });
      const done = await one<CaseJson>(`select public.confirm_mfa_recovery($1, $2, $3, 'callback on file number') as r`, [
        c.caseId,
        SYNTHETIC_METHOD,
        ` ${code.toLowerCase()} `,
      ]);
      expect(done.status).toBe('completed');
      expect(done.completedAt).not.toBeNull();
      await resetActor(db);
      const [row] = await db.query<{ completed_by: string; verification_method: string; confirmation_code: string | null }>(
        'select completed_by, verification_method, confirmation_code from public.mfa_recovery_cases where id = $1',
        [c.caseId],
      );
      expect(row).toEqual({ completed_by: U.adminJodhpur, verification_method: SYNTHETIC_METHOD, confirmation_code: null });

      // Completion moves the barrier: the bound recovery session and every
      // older one end. A new sign-in still waits for provider cleanup.
      for (const actor of [bound, { userId: U.salesDelhiA }]) {
        await setActor(db, actor);
        expect(allZero(await readableRowCounts())).toBe(true);
        expect((await sessionState()).state).toBe('session_revoked');
      }
      await setActor(db, fresh(U.salesDelhiA));
      expect(await visibleDealRefs()).toEqual([]);
      expect((await sessionState()).state).not.toBe('ok');

      // Cleanup data for the server (service role only), then its outcome.
      await setActor(db, { userId: U.adminJodhpur });
      await expectDbError(db, () => db.query('select public.get_mfa_recovery_cleanup($1)', [c.caseId]), { code: '42501' });
      await setActor(db, service);
      expect(await one('select public.get_mfa_recovery_cleanup($1) as r', [c.caseId])).toEqual({
        caseId: c.caseId,
        userId: U.salesDelhiA,
        keepFactorId: newFactor,
      });
      await db.query('select public.record_mfa_recovery_cleanup_result($1, false, $2)', [c.caseId, 'delete failed']);
      await setActor(db, fresh(U.salesDelhiA, { sessionId: bound.sessionId }));
      expect(await visibleDealRefs()).toEqual([]);
      await setActor(db, service);
      await db.query('select public.record_mfa_recovery_cleanup_result($1, true, null)', [c.caseId]);
      await resetActor(db);
      expect(
        await db.query(
          `select action from public.audit_events where target_id = $1 and action like 'staff.mfa_recovery_cleanup%' order by id`,
          [c.caseId],
        ),
      ).toEqual([{ action: 'staff.mfa_recovery_cleanup_failed' }, { action: 'staff.mfa_recovery_cleanup_ok' }]);

      await setActor(db, fresh(U.salesDelhiA, { sessionId: bound.sessionId }));
      expect(await visibleDealRefs()).toEqual(['SYN-DEL-001']);
      expect((await sessionState()).state).toBe('ok');
      // A leftover/stolen Auth token enrolling another factor cannot revive
      // CRM access after cleanup. The approved recovery factor is authoritative.
      await resetActor(db);
      const extraFactor = await insertFactor(db, { userId: U.salesDelhiA });
      const extraSession = await insertSession(db, { userId: U.salesDelhiA, factorId: extraFactor });
      await setActor(db, fresh(U.salesDelhiA, { sessionId: extraSession }));
      expect(allZero(await readableRowCounts())).toBe(true);
      expect((await sessionState()).state).not.toBe('ok');

      // A new case can be opened afterwards (index is partial).
      expect((await beginRecovery(U.salesDelhiA)).caseId).not.toBe(c.caseId);
    });
  });

  it('refuses (and audits) when more than one new authenticator exists', async () => {
    await asOwner(db, async () => {
      const c = await readyCase(U.salesDelhiA);
      const { actor } = await enrolNewFactor(U.salesDelhiA);
      await insertFactor(db, { userId: U.salesDelhiA, createdAt: ago(2900) }); // e.g. enrolled by someone else
      await setActor(db, actor);
      const res = await register();
      expect(res).toEqual({ status: 'awaiting_reenrollment', confirmation_code: null, refused: 'extra_factor' });
      expect((await sessionState()).recovery).not.toHaveProperty('confirmationCode');
      await resetActor(db);
      expect(
        await db.query(`select id from public.audit_events where action = 'staff.mfa_recovery_extra_factor' and target_id = $1`, [
          c.caseId,
        ]),
      ).toHaveLength(1);
      expect(await db.query('select status, confirmation_code from public.mfa_recovery_cases where id = $1', [c.caseId])).toEqual([
        { status: 'awaiting_reenrollment', confirmation_code: null },
      ]);
    });
  });

  it('confirmation fails if the registered authenticator was removed', async () => {
    await asOwner(db, async () => {
      const c = await readyCase(U.salesDelhiA);
      const { factorId, actor } = await enrolNewFactor(U.salesDelhiA);
      await setActor(db, actor);
      const { confirmation_code: code } = await register();
      await resetActor(db);
      await db.query('delete from auth.mfa_factors where id = $1', [factorId]);
      await setActor(db, { userId: U.adminJodhpur });
      await expectDbError(
        db,
        () => db.query(`select public.confirm_mfa_recovery($1, $2, $3, null)`, [c.caseId, SYNTHETIC_METHOD, code]),
        { code: '22023', message: /no longer present/ },
      );
    });
  });

  it('locks after five wrong codes; new codes are capped at three re-issues (PROPOSED)', async () => {
    await asOwner(db, async () => {
      const c = await readyCase(U.salesDelhiA);
      const { factorId, actor } = await enrolNewFactor(U.salesDelhiA);
      await setActor(db, actor);
      const first = (await register()).confirmation_code!;
      await setActor(db, { userId: U.adminJodhpur });
      for (let i = 0; i < 5; i += 1) {
        await db.query(`select public.confirm_mfa_recovery($1, $2, '000000', null)`, [c.caseId, SYNTHETIC_METHOD]);
      }
      await expectDbError(
        db,
        () => db.query(`select public.confirm_mfa_recovery($1, $2, $3, null)`, [c.caseId, SYNTHETIC_METHOD, first]),
        { code: '54000' },
      );
      // Re-issue #1 after the lockout (same bound session).
      await setActor(db, actor);
      const second = (await register()).confirmation_code!;
      expect(second).toMatch(/^[0-9A-Z]{6}$/);
      // Re-issues #2 and #3 from new sessions verified with the same factor (each rebinds).
      for (let i = 0; i < 2; i += 1) {
        await resetActor(db);
        const s = await insertSession(db, { userId: U.salesDelhiA, factorId });
        await setActor(db, { ...actor, sessionId: s });
        expect((await register()).confirmation_code).toMatch(/^[0-9A-Z]{6}$/);
      }
      // A fourth re-issue is refused.
      await resetActor(db);
      const s4 = await insertSession(db, { userId: U.salesDelhiA, factorId });
      await setActor(db, { ...actor, sessionId: s4 });
      await expectDbError(db, () => register(), { code: '54000', message: /too many new codes/ });
      // The original session lost its binding and no longer sees a code.
      await setActor(db, actor);
      expect((await sessionState()).recovery).not.toHaveProperty('confirmationCode');

      // Inactive method rows are not approved either.
      await resetActor(db);
      await db.query(`update public.recovery_verification_methods set active = false where code = $1`, [SYNTHETIC_METHOD]);
      await setActor(db, { userId: U.adminJodhpur });
      await expectDbError(
        db,
        () => db.query(`select public.confirm_mfa_recovery($1, $2, $3, null)`, [c.caseId, SYNTHETIC_METHOD, second]),
        { code: '22023', message: /not approved/ },
      );
    });
  });

  it('migrations ship no approved verification method; only the synthetic fixture adds one', async () => {
    await asOwner(db, async () => {
      const rows = await db.query<{ code: string; label: string }>('select code, label from public.recovery_verification_methods');
      expect(rows).toEqual([{ code: SYNTHETIC_METHOD, label: expect.stringMatching(/SYNTHETIC FIXTURE/) }]);
    });
  });
});

describe('Finding 4: sessions opened while the provider step ran are denied', () => {
  it('provider success moves the barrier to its completion time', async () => {
    await asOwner(db, async () => {
      const c = await beginRecovery(U.salesDelhiA);
      // Simulate: recovery began an hour ago; someone signed in (aal2, old factor) 30 min ago.
      await shiftRecoveryBack(c.caseId, U.salesDelhiA, 3600);
      const window: Actor = { userId: U.salesDelhiA, amr: amrAt(1800) };
      await setActor(db, window);
      expect((await sessionState()).state).toBe('recovery_pending'); // inside the window, still blocked by S6

      await recordProvider(c.caseId, true);
      await resetActor(db);
      const [b] = await db.query<{ same: boolean }>(
        `select s.sessions_valid_after = c.provider_completed_at as same
         from public.staff_security_state s join public.mfa_recovery_cases c on c.user_id = s.user_id
         where c.id = $1`,
        [c.caseId],
      );
      expect(b!.same).toBe(true);
      await setActor(db, window);
      expect((await sessionState()).state).toBe('session_revoked');
      await expectDbError(db, () => register(), { code: '42501' });
    });
  });
});

describe('T07 absolute session age', () => {
  it('denies the Data API once the session is older than security_policy allows, even with a valid exp', async () => {
    await asOwner(db, async () => {
      const [policy] = await db.query<{ s: number; p: string }>(
        'select session_max_age_seconds as s, policy_status as p from public.security_policy',
      );
      expect(policy).toEqual({ s: 43200, p: 'proposed' });

      await setActor(db, { userId: U.salesDelhiA, amr: amrAt(43200 - 120) });
      expect(await visibleDealRefs()).toEqual(['SYN-DEL-001']);
      expect(await sessionState()).toEqual({ state: 'ok', sessionMaxAgeSeconds: 43200, policyStatus: 'proposed' });

      await setActor(db, { userId: U.salesDelhiA, amr: amrAt(43200 + 120), iat: nowSeconds() });
      expect(allZero(await readableRowCounts())).toBe(true);
      expect((await sessionState()).state).toBe('session_expired');
      await expectDbError(db, () => db.query('select public.accept_my_invitation()'), { code: '42501' });

      // The policy row is the single source: shortening it applies at once.
      await resetActor(db);
      await db.query('update public.security_policy set session_max_age_seconds = 3600');
      await setActor(db, { userId: U.salesDelhiA, amr: amrAt(3700) });
      expect(await visibleDealRefs()).toEqual([]);
    });
  });

  it('uses the minimum amr timestamp (first factor), not a later MFA step-up', async () => {
    await as(
      db,
      {
        userId: U.salesDelhiA,
        amr: [
          { method: 'password', timestamp: nowSeconds() - 43200 - 120 },
          { method: 'totp', timestamp: nowSeconds() - 10 },
        ],
      },
      async () => {
        expect(await visibleDealRefs()).toEqual([]);
      },
    );
  });
});

describe('T08 missing or malformed amr is denied', () => {
  const t = () => nowSeconds() - 60;
  const variants: Array<[string, () => unknown]> = [
    ['missing', () => null],
    ['empty array', () => []],
    ['string', () => 'password'],
    ['object', () => ({ method: 'password', timestamp: t() })],
    ['entry without timestamp', () => [{ method: 'password' }]],
    ['string timestamp', () => [{ method: 'password', timestamp: String(t()) }]],
    ['one malformed entry among valid ones', () => [{ method: 'password', timestamp: t() }, { method: 'totp' }]],
    ['non-object entry', () => [t()]],
    ['negative timestamp', () => [{ method: 'password', timestamp: -5 }]],
    ['absurd future timestamp', () => [{ method: 'password', timestamp: 1e15 }]],
  ];
  it.each(variants)('%s', async (_name, amr) => {
    await as(db, { userId: U.salesDelhiA, amr: amr() }, async () => {
      expect(allZero(await readableRowCounts())).toBe(true);
      expect((await sessionState()).state).toBe('session_expired');
    });
  });
});

describe('S4 barrier precision: same-second sign-in is denied (fail closed)', () => {
  it('denies auth time in the barrier second and allows the next second', async () => {
    await asOwner(db, async () => {
      const t = nowSeconds() - 30;
      await db.query(`update public.staff_security_state set sessions_valid_after = to_timestamp($2::double precision + 0.4)
                      where user_id = $1`, [U.salesDelhiA, t]);
      await setActor(db, { userId: U.salesDelhiA, amr: [{ method: 'password', timestamp: t }] });
      expect(await visibleDealRefs()).toEqual([]);
      await setActor(db, { userId: U.salesDelhiA, amr: [{ method: 'password', timestamp: t + 1 }] });
      expect(await visibleDealRefs()).toEqual(['SYN-DEL-001']);
    });
  });
});

describe('T09 revoke_my_sessions', () => {
  it('moves the barrier for the caller only; old tokens denied, new sign-ins allowed', async () => {
    await asOwner(db, async () => {
      await setActor(db, { userId: U.salesDelhiA });
      await db.query('select public.revoke_my_sessions()');
      expect(allZero(await readableRowCounts())).toBe(true);
      expect((await sessionState()).state).toBe('session_revoked');
      await setActor(db, fresh(U.salesDelhiA));
      expect(await visibleDealRefs()).toEqual(['SYN-DEL-001']);
      // Other staff unaffected.
      await setActor(db, { userId: U.salesAhmedabad });
      expect(await visibleDealRefs()).toEqual(['SYN-AMD-001']);
      await resetActor(db);
      const audit = await db.query<{ actor_user_id: string }>(
        `select actor_user_id from public.audit_events where action = 'staff.sessions_revoked' and target_id = $1`,
        [U.salesDelhiA],
      );
      expect(audit).toEqual([{ actor_user_id: U.salesDelhiA }]);
    });
  });

  it('requires a fresh aal2 session (finding 12); never anon', async () => {
    for (const actor of [
      { userId: U.salesDelhiA, aal: 'aal1' as const },
      { userId: U.salesDelhiA, amr: amrAt(50_000) },
      { userId: U.salesDelhiA, amr: null },
    ]) {
      await as(db, actor, async () => {
        await expectDbError(db, () => db.query('select public.revoke_my_sessions()'), { code: '42501' });
      });
    }
    // Allowed during an open recovery case for a post-barrier aal2 session.
    await asOwner(db, async () => {
      await beginRecovery(U.salesDelhiA);
      await setActor(db, fresh(U.salesDelhiA));
      await db.query('select public.revoke_my_sessions()');
    });
    await as(db, { userId: null }, async () => {
      await expectDbError(db, () => db.query('select public.revoke_my_sessions()'), { code: '42501' });
      await expectDbError(db, () => db.query('select public.my_session_status()'), { code: '42501' });
    });
  });

  it('deactivation also moves the barrier', async () => {
    await asOwner(db, async () => {
      await setActor(db, { userId: U.adminJodhpur });
      await db.query(`select public.deactivate_staff_member($1, 'test: left the company')`, [U.salesDelhiA]);
      await resetActor(db);
      const [row] = await db.query<{ moved: boolean }>(
        `select sessions_valid_after > '-infinity' as moved from public.staff_security_state where user_id = $1`,
        [U.salesDelhiA],
      );
      expect(row!.moved).toBe(true);
      await setActor(db, fresh(U.salesDelhiA));
      expect((await sessionState()).state).toBe('inactive');
    });
  });
});

describe('my_session_status states', () => {
  it.each([
    ['active staff', { userId: U.salesDelhiA }, 'ok'],
    ['aal1', { userId: U.salesDelhiA, aal: 'aal1' as const }, 'mfa_required'],
    ['invited', { userId: U.invitedStaff }, 'onboarding_incomplete'],
    ['inactive', { userId: U.formerStaff }, 'inactive'],
    ['no active membership', { userId: U.movedStaff }, 'no_membership'],
    ['member of a disabled entity only', { userId: U.salesEntityB }, 'no_membership'],
  ])('%s -> %s', async (_name, actor, state) => {
    await as(db, actor, async () => {
      expect((await sessionState()).state).toBe(state);
    });
  });

  it('a token without a subject is no_session', async () => {
    await asOwner(db, async () => {
      await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role: 'authenticated', aal: 'aal2' })]);
      await db.exec('set local role authenticated');
      expect((await sessionState()).state).toBe('no_session');
    });
  });

  it('every new staff profile gets a security state row (trigger)', async () => {
    await asOwner(db, async () => {
      const missing = await db.query(
        `select p.user_id from public.staff_profiles p
         left join public.staff_security_state s on s.user_id = p.user_id where s.user_id is null`,
      );
      expect(missing).toEqual([]);
    });
  });
});

describe('T11 direct API adversarial cases', () => {
  it("other user's deal by id, Purchase on deal_commercials, aal1 and anon all get nothing", async () => {
    await as(db, { userId: U.salesDelhiA }, async () => {
      expect(await db.query('select id from public.deals where id = $1', [D.del002])).toEqual([]);
      expect(await db.query('select deal_id from public.deal_commercials where deal_id = $1', [D.del002])).toEqual([]);
    });
    await as(db, { userId: U.purchaseJodhpur }, async () => {
      expect(await visibleDealRefs()).toEqual(['SYN-DEL-001']);
      expect(await db.query('select deal_id from public.deal_commercials where deal_id = $1', [D.del001])).toEqual([]);
    });
    await as(db, { userId: U.adminJodhpur, aal: 'aal1' }, async () => {
      expect(allZero(await readableRowCounts())).toBe(true);
    });
    await as(db, { userId: null }, async () => {
      for (const t of [...EVERY_TABLE, 'mfa_recovery_cases']) {
        await expectDbError(db, () => db.query(`select 1 from public.${t} limit 1`), { code: '42501' });
      }
    });
  });

  it('service-only commands are not executable by authenticated staff or anon', async () => {
    for (const actor of [{ userId: U.adminJodhpur }, { userId: null }] as Actor[]) {
      await as(db, actor, async () => {
        for (const sql of [
          `select public.record_mfa_recovery_provider_result(gen_random_uuid(), true, null)`,
          `select public.record_staff_email_result(gen_random_uuid(), true, null)`,
          `select public.bootstrap_first_admin(gen_random_uuid(), 'x@example.test', 'X', 'JDH', 'op')`,
          `select public.link_invitation_user(gen_random_uuid(), gen_random_uuid())`,
          `select public.get_mfa_recovery_cleanup(gen_random_uuid())`,
          `select public.record_mfa_recovery_cleanup_result(gen_random_uuid(), true, null)`,
          `select authz.move_session_barrier(gen_random_uuid())`,
          `select authz.verified_factors_after(gen_random_uuid(), now())`,
        ]) {
          await expectDbError(db, () => db.query(sql), { code: '42501' });
        }
      });
    }
  });

  it('staff cannot write the new tables or move barriers directly', async () => {
    await as(db, { userId: U.adminJodhpur }, async () => {
      for (const sql of [
        `update public.staff_security_state set sessions_valid_after = '-infinity'`,
        `update public.security_policy set session_max_age_seconds = 604800`,
        `insert into public.recovery_verification_methods (code, label) values ('SELF_APPROVED', 'x')`,
        `update public.mfa_recovery_cases set status = 'completed'`,
        `delete from public.staff_email_deliveries`,
      ]) {
        await expectDbError(db, () => db.query(sql), { code: '42501' });
      }
    });
  });

  it('non-administrators see no recovery, delivery or other staff security rows', async () => {
    await asOwner(db, async () => {
      await beginRecovery(U.salesDelhiB);
      await setActor(db, { userId: U.managerDelhi });
      expect(await db.query('select id from public.mfa_recovery_cases')).toEqual([]);
      expect(await db.query('select id from public.staff_email_deliveries')).toEqual([]);
      expect(await db.query<{ user_id: string }>('select user_id from public.staff_security_state')).toEqual([
        { user_id: U.managerDelhi },
      ]);
    });
  });
});

describe('T12 staff email deliveries', () => {
  async function request(target: string, kind: string): Promise<DeliveryJson> {
    return one<DeliveryJson>('select public.request_staff_email($1, $2) as r', [target, kind]);
  }

  it('pending -> handed_to_provider / failed, recorded by the service role only', async () => {
    await asOwner(db, async () => {
      await setActor(db, { userId: U.adminJodhpur });
      const d = await request(U.salesDelhiB, 'password_reset');
      expect(d).toMatchObject({ userId: U.salesDelhiB, kind: 'password_reset', status: 'pending', attemptNo: 1, completedAt: null });

      await setActor(db, service);
      const handed = await one<DeliveryJson>('select public.record_staff_email_result($1, true, null) as r', [d.deliveryId]);
      expect(handed).toMatchObject({ status: 'handed_to_provider', errorCode: null });
      expect(handed.completedAt).not.toBeNull();
      // Idempotent repeat; contradicting outcome refused.
      expect((await one<DeliveryJson>('select public.record_staff_email_result($1, true, null) as r', [d.deliveryId])).status).toBe(
        'handed_to_provider',
      );
      await expectDbError(db, () => db.query('select public.record_staff_email_result($1, false, $2)', [d.deliveryId, 'x']), {
        code: '22023',
      });

      await resetActor(db);
      await db.query(`update public.staff_email_deliveries set created_at = now() - interval '61 seconds' where id = $1`, [
        d.deliveryId,
      ]);
      await setActor(db, { userId: U.adminJodhpur });
      const d2 = await request(U.salesDelhiB, 'password_reset');
      expect(d2.attemptNo).toBe(2);
      await setActor(db, service);
      const failed = await one<DeliveryJson>('select public.record_staff_email_result($1, false, $2) as r', [
        d2.deliveryId,
        'over_email_send_rate_limit for sales.delhi.b@example.test',
      ]);
      expect(failed.status).toBe('failed');
      expect(failed.errorCode).toMatch(/^[A-Za-z0-9_.:-]+$/);
      expect(JSON.stringify(failed)).not.toMatch(/delivered/i);

      // Admin reads the rows; the audit never carries the address.
      await setActor(db, { userId: U.adminJodhpur });
      expect(await db.query('select status from public.staff_email_deliveries order by attempt_no')).toEqual([
        { status: 'handed_to_provider' },
        { status: 'failed' },
      ]);
      const audit = await db.query<{ action: string; details: unknown }>(
        `select action, details from public.audit_events where target_type = 'staff_email_delivery' order by id`,
      );
      expect(audit.map((a) => a.action)).toEqual([
        'staff.email_requested',
        'staff.email_handed_to_provider',
        'staff.email_requested',
        'staff.email_failed',
      ]);
      expect(JSON.stringify(audit)).not.toContain(EMAIL.salesDelhiB);
    });
  });

  it('rate limits: one per 60 s and five per 24 h per person and kind (PROPOSED values)', async () => {
    await asOwner(db, async () => {
      await setActor(db, { userId: U.adminJodhpur });
      await request(U.salesDelhiB, 'password_reset');
      await expectDbError(db, () => request(U.salesDelhiB, 'password_reset'), { code: '54000', message: /retry after \d+ seconds/ });
      // A different person or kind has its own budget.
      await request(U.salesAhmedabad, 'password_reset');

      await resetActor(db);
      await db.query(
        `insert into public.staff_email_deliveries (user_id, kind, status, attempt_no, created_by, created_at, completed_at)
         select $1, 'password_reset', 'handed_to_provider', n + 1, $2, now() - (n || ' hours')::interval, now()
         from generate_series(1, 4) n`,
        [U.salesDelhiB, U.adminJodhpur],
      );
      await db.query(`update public.staff_email_deliveries set created_at = now() - interval '2 minutes'
                      where user_id = $1 and attempt_no = 1`, [U.salesDelhiB]);
      await setActor(db, { userId: U.adminJodhpur });
      await expectDbError(db, () => request(U.salesDelhiB, 'password_reset'), { code: '54000', message: /daily limit/ });
      await resetActor(db);
      await db.query(`update public.staff_email_deliveries set created_at = now() - interval '25 hours' where user_id = $1`, [
        U.salesDelhiB,
      ]);
      await setActor(db, { userId: U.adminJodhpur });
      expect((await request(U.salesDelhiB, 'password_reset')).attemptNo).toBe(6);
    });
  });

  it('checks kind, target state and authority', async () => {
    await asOwner(db, async () => {
      await setActor(db, { userId: U.adminJodhpur });
      await expectDbError(db, () => request(U.salesDelhiB, 'marketing'), { code: '22023' });
      await expectDbError(db, () => request(U.salesDelhiB, 'invitation_resend'), { code: '22023' }); // active, not invited
      await expectDbError(db, () => request(U.invitedStaff, 'password_reset'), { code: '22023' }); // invited, not active
      await expectDbError(db, () => request(U.invitedStaff, 'invitation_resend'), { code: '22023' }); // no sent invitation
      await expectDbError(db, () => request(U.adminJodhpur, 'password_reset'), { code: '42501' }); // self
      await expectDbError(db, () => request(U.salesEntityB, 'password_reset'), { code: '42501' }); // other entity

      await resetActor(db);
      await db.query(
        `insert into public.staff_invitations (legal_entity_id, branch_id, role_code, email, display_name, invited_by, status, user_id, sent_at)
         select m.legal_entity_id, m.branch_id, m.role_code, $2, 'Synthetic Invited Staff', $3, 'sent', $1, now()
         from public.memberships m where m.user_id = $1`,
        [U.invitedStaff, EMAIL.invitedStaff, U.adminJodhpur],
      );
      await setActor(db, { userId: U.adminJodhpur });
      expect((await request(U.invitedStaff, 'invitation_resend')).status).toBe('pending');
      // First invitations go through request_invitation_email instead.
      await expectDbError(db, () => request(U.invitedStaff, 'invitation'), { code: '22023' });

      await setActor(db, { userId: U.managerDelhi });
      await expectDbError(db, () => request(U.salesDelhiB, 'password_reset'), { code: '42501' });
    });
  });
});

describe('T12 first invitation email recorded before the provider call (finding 6)', () => {
  it('creates a pending row keyed by the invitation, links the user later, and rate limits per invitation', async () => {
    await asOwner(db, async () => {
      await setActor(db, { userId: U.adminJodhpur });
      const [{ id: invitationId }] = (await db.query<{ id: string }>(
        `select public.create_staff_invitation('new.hire@example.test', 'New Hire',
           (select id from public.branches where code = 'DEL'), 'sales') as id`,
      )) as [{ id: string }];
      const d = await one<DeliveryJson & { invitationId: string }>('select public.request_invitation_email($1) as r', [
        invitationId,
      ]);
      expect(d).toMatchObject({ userId: null, invitationId, kind: 'invitation', status: 'pending', attemptNo: 1 });
      // Visible to the inviting administrator before any user exists.
      expect(await db.query('select id from public.staff_email_deliveries where id = $1', [d.deliveryId])).toHaveLength(1);
      await expectDbError(db, () => db.query('select public.request_invitation_email($1)', [invitationId]), {
        code: '54000',
        message: /retry after/,
      });

      await setActor(db, service);
      expect(
        (await one<DeliveryJson>('select public.record_staff_email_result($1, true, null) as r', [d.deliveryId])).status,
      ).toBe('handed_to_provider');

      await resetActor(db);
      const newUser = 'a0000000-0000-4000-8000-0000000000f2';
      await db.query('insert into auth.users (id, email) values ($1, $2)', [newUser, 'new.hire@example.test']);
      await setActor(db, service);
      await db.query('select public.link_invitation_user($1, $2)', [invitationId, newUser]);
      await resetActor(db);
      expect(await db.query('select user_id from public.staff_email_deliveries where id = $1', [d.deliveryId])).toEqual([
        { user_id: newUser },
      ]);
      expect(
        await db.query<{ action: string }>(
          `select action from public.audit_events where target_id = $1 order by id`,
          [d.deliveryId],
        ),
      ).toEqual([{ action: 'staff.email_requested' }, { action: 'staff.email_handed_to_provider' }]);

      // Non-administrators cannot request; closed invitations cannot be emailed.
      await setActor(db, { userId: U.managerDelhi });
      await expectDbError(db, () => db.query('select public.request_invitation_email($1)', [invitationId]), {
        code: '42501',
      });
      await resetActor(db);
      await db.query(`update public.staff_invitations set status = 'cancelled' where id = $1`, [invitationId]);
      await setActor(db, { userId: U.adminJodhpur });
      await expectDbError(db, () => db.query('select public.request_invitation_email($1)', [invitationId]), {
        code: '22023',
      });
    });
  });
});

describe('T13 bootstrap_first_admin (SQL part)', () => {
  const NEW_ADMIN = 'a0000000-0000-4000-8000-0000000000f1';
  const NEW_EMAIL = 'first.admin@example.test';
  const call = (userId: string, email: string, branch = 'JDH', operator: string | null = 'ci-operator') =>
    one<{ outcome: string }>('select public.bootstrap_first_admin($1, $2, $3, $4, $5) as r', [
      userId,
      email,
      'First Admin',
      branch,
      operator,
    ]);

  it('refuses while another administrator exists and is repeat-safe for the same one', async () => {
    await asOwner(db, async () => {
      await setActor(db, service);
      expect(await call(U.adminJodhpur, EMAIL.adminJodhpur)).toEqual({ outcome: 'already_admin' });
      await expectDbError(db, () => call(U.salesDelhiA, EMAIL.salesDelhiA), { code: '42501' });
    });
  });

  it('creates an invited super_admin once, audits the operator, then becomes a no-op', async () => {
    await asOwner(db, async () => {
      await db.query(`update public.memberships set status = 'inactive', deactivated_at = now() where role_code = 'super_admin'`);
      await db.query('insert into auth.users (id, email) values ($1, $2)', [NEW_ADMIN, NEW_EMAIL]);

      await setActor(db, service);
      await expectDbError(db, () => call(NEW_ADMIN, NEW_EMAIL, 'SB1'), { code: '22023' }); // synthetic/disabled entity
      await expectDbError(db, () => call(NEW_ADMIN, 'someone.else@example.test'), { code: '22023' });
      await expectDbError(db, () => call(NEW_ADMIN, NEW_EMAIL, 'JDH', '  '), { code: '22023' });
      expect(await call(NEW_ADMIN, NEW_EMAIL.toUpperCase())).toEqual({ outcome: 'created' });
      expect(await call(NEW_ADMIN, NEW_EMAIL)).toEqual({ outcome: 'already_admin' });
      await expectDbError(db, () => call(U.salesDelhiA, EMAIL.salesDelhiA), { code: '42501' });

      await resetActor(db);
      expect(
        await db.query(
          `select p.status as profile, m.status as membership, m.role_code, b.code as branch
           from public.staff_profiles p join public.memberships m on m.user_id = p.user_id
           join public.branches b on b.id = m.branch_id where p.user_id = $1`,
          [NEW_ADMIN],
        ),
      ).toEqual([{ profile: 'invited', membership: 'invited', role_code: 'super_admin', branch: 'JDH' }]);
      const audit = await db.query<{ actor_user_id: string | null; details: { operator: string } }>(
        `select actor_user_id, details from public.audit_events where action = 'staff.bootstrap_admin'`,
      );
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actor_user_id: null, details: { operator: 'ci-operator' } });

      // Normal onboarding activates them (password + MFA happen at the provider).
      await setActor(db, fresh(NEW_ADMIN));
      expect((await sessionState()).state).toBe('onboarding_incomplete');
      await db.query('select public.accept_my_invitation()');
      expect((await sessionState()).state).toBe('ok');
    });
  });
});

// Forward repair: operation snapshots cannot grow after another attempt advances.
describe('bounded recovery deletion plans and audited cleanup retry', () => {
  type Plan = { caseId: string; userId: string; keepFactorId: string | null; factorIds: string[] };
  async function plan(caseId: string, phase: string) {
    await setActor(db, service);
    return one<Plan>('select public.get_mfa_recovery_deletion_plan($1, $2) as r', [caseId, phase]);
  }
  async function completedFixture() {
    const c = await beginRecovery(U.salesDelhiA);
    await resetActor(db);
    const keep = await insertFactor(db, { userId: U.salesDelhiA });
    await db.query(`update public.mfa_recovery_cases set status = 'completed', completed_at = now(),
      completed_by = $2, verification_method = $3, new_factor_id = $4 where id = $1`,
    [c.caseId, U.adminJodhpur, SYNTHETIC_METHOD, keep]);
    return { c, keep };
  }

  it('captures only existing IDs and refuses a new provider plan after advancement', async () => {
    await asOwner(db, async () => {
      const old = await insertFactor(db, { userId: U.salesDelhiA });
      const c = await beginRecovery(U.salesDelhiA);
      const first = await plan(c.caseId, 'provider');
      const concurrent = await plan(c.caseId, 'provider');
      expect(first.factorIds).toContain(old);
      expect(concurrent.factorIds).toEqual(first.factorIds);
      await recordProvider(c.caseId, true);
      await resetActor(db);
      const later = await insertFactor(db, { userId: U.salesDelhiA });
      expect(first.factorIds).not.toContain(later);
      expect(concurrent.factorIds).not.toContain(later);
      await setActor(db, service);
      await expectDbError(db, () => plan(c.caseId, 'provider'), { code: '22023' });
    });
  });

  it('authorizes cleanup retry without a consumed code, excludes the kept factor and audits the actor', async () => {
    await asOwner(db, async () => {
      const { c, keep } = await completedFixture();
      const extra = await insertFactor(db, { userId: U.salesDelhiA });
      await setActor(db, { userId: U.adminJodhpur });
      const result = await one<CaseJson>('select public.retry_mfa_recovery_cleanup($1) as r', [c.caseId]);
      expect(result.status).toBe('completed');
      const deletion = await plan(c.caseId, 'cleanup');
      expect(deletion.factorIds).toContain(extra);
      expect(deletion.factorIds).not.toContain(keep);
      await resetActor(db);
      const events = await db.query('select actor_user_id from public.audit_events where action = $1 and target_id = $2',
        ['staff.mfa_recovery_cleanup_retry_requested', c.caseId]);
      expect(events).toEqual([{ actor_user_id: U.adminJodhpur }]);
    });
  });

  it('refuses unauthorized plans, unauthorized retry and retry before completion', async () => {
    await asOwner(db, async () => {
      const c = await beginRecovery(U.salesDelhiA);
      await setActor(db, { userId: U.adminJodhpur });
      await expectDbError(db, () => db.query('select public.get_mfa_recovery_deletion_plan($1, $2)', [c.caseId, 'provider']), { code: '42501' });
      await expectDbError(db, () => db.query('select public.retry_mfa_recovery_cleanup($1)', [c.caseId]), { code: '22023' });
      await setActor(db, { userId: U.managerDelhi });
      await expectDbError(db, () => db.query('select public.retry_mfa_recovery_cleanup($1)', [c.caseId]), { code: '42501' });
    });
  });

  it('refuses a superseded completed case and never adds a new factor to its old plan', async () => {
    await asOwner(db, async () => {
      const { c } = await completedFixture();
      const oldPlan = await plan(c.caseId, 'cleanup');
      await beginRecovery(U.salesDelhiA);
      await resetActor(db);
      const newest = await insertFactor(db, { userId: U.salesDelhiA });
      expect(oldPlan.factorIds).not.toContain(newest);
      await setActor(db, { userId: U.adminJodhpur });
      await expectDbError(db, () => db.query('select public.retry_mfa_recovery_cleanup($1)', [c.caseId]), { code: '22023' });
      await setActor(db, service);
      await expectDbError(db, () => plan(c.caseId, 'cleanup'), { code: '22023' });
      await expectDbError(db, () => db.query('select public.record_mfa_recovery_cleanup_result($1, true, null)', [c.caseId]), { code: '22023' });
    });
  });

  it('keeps successful cleanup monotonic despite a delayed failure and refuses missing kept factors', async () => {
    await asOwner(db, async () => {
      const { c, keep } = await completedFixture();
      await setActor(db, service);
      await db.query('select public.record_mfa_recovery_cleanup_result($1, true, null)', [c.caseId]);
      await db.query('select public.record_mfa_recovery_cleanup_result($1, false, $2)', [c.caseId, 'late_failure']);
      await resetActor(db);
      expect(await db.query('select cleanup_error from public.mfa_recovery_cases where id = $1', [c.caseId])).toEqual([{ cleanup_error: null }]);
      await db.query('delete from auth.mfa_factors where id = $1', [keep]);
      await setActor(db, service);
      await expectDbError(db, () => plan(c.caseId, 'cleanup'), { code: '22023' });
    });
  });
});

describe('case-bound provider resume (stale Staff page)', () => {
  async function resume(caseId: string) {
    return one<CaseJson>('select public.resume_mfa_recovery_provider($1) as r', [caseId]);
  }
  async function caseCount(userId: string) {
    await resetActor(db);
    return (await one<number>('select count(*)::int as r from public.mfa_recovery_cases where user_id = $1', [userId]));
  }

  it('resumes the same pending or failed case and never opens another one', async () => {
    await asOwner(db, async () => {
      const c = await beginRecovery(U.salesDelhiA);
      await setActor(db, { userId: U.adminJodhpur });
      expect((await resume(c.caseId)).caseId).toBe(c.caseId);
      await recordProvider(c.caseId, false, 'provider_unavailable');
      await setActor(db, { userId: U.adminJodhpur });
      const again = await resume(c.caseId);
      expect(again.caseId).toBe(c.caseId);
      expect(again.status).toBe('provider_failed');
      expect(await caseCount(U.salesDelhiA)).toBe(1);
      const resumed = await db.query('select count(*)::int as n from public.audit_events where action = $1 and target_id = $2',
        ['staff.mfa_recovery_resumed', c.caseId]);
      expect(resumed).toEqual([{ n: 2 }]);
    });
  });

  it('refuses a case that moved on, so a stale retry cannot start a new recovery', async () => {
    await asOwner(db, async () => {
      const c = await beginRecovery(U.salesDelhiA);
      await recordProvider(c.caseId, true);
      await setActor(db, { userId: U.adminJodhpur });
      await expectDbError(db, () => resume(c.caseId), { code: '22023' });
      await resetActor(db);
      await db.query(`update public.mfa_recovery_cases set status = 'completed', completed_at = now(), completed_by = $2,
        verification_method = $3 where id = $1`, [c.caseId, U.adminJodhpur, SYNTHETIC_METHOD]);
      await setActor(db, { userId: U.adminJodhpur });
      await expectDbError(db, () => resume(c.caseId), { code: '22023' });
      expect(await caseCount(U.salesDelhiA)).toBe(1);
    });
  });

  it('refuses other administrators, self-recovery and unknown cases alike', async () => {
    await asOwner(db, async () => {
      const c = await beginRecovery(U.salesDelhiA);
      await setActor(db, { userId: U.managerDelhi });
      await expectDbError(db, () => resume(c.caseId), { code: '42501' });
      await setActor(db, { userId: U.salesDelhiA });
      await expectDbError(db, () => resume(c.caseId), { code: '42501' });
      await setActor(db, { userId: U.adminJodhpur });
      await expectDbError(db, () => resume('c0000000-0000-4000-8000-0000000000ff'), { code: '42501' });
      await setActor(db, { userId: null });
      await expectDbError(db, () => resume(c.caseId), { code: '42501' });
    });
  });
});
