import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, asOwner, createTestDb } from '../helpers/db';
import { HOTEL_ITEM, PAST_HOTEL_ITEM, PAST_TRIP, SELLING, dayFrom } from './acc-support';
import { ACC, ACC_J2, DEAL, MANAGER, MANAGER_J2, OWNER, PURCHASE, REASON, SQL3, SUPER, U, acc3Helpers, rid, text } from './acc3-support';

/**
 * Accounts phase 3, Track T — Track B write-off (contract 6.6, 13, 14,
 * 16.1 B). Written from the contract, not from Track B's code.
 *
 * Scenario: SYN-DEL-001 (Delhi) books a hotel whose trip ended five days
 * ago, selling SELLING (9123457 paise); the customer paid all but `gap`.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = acc3Helpers(() => db);
const { one, owner, refused, refusedHint } = h;
type WO = { outcome: string; writeOffId: string; refNo: string; status: string; rowVersion: number };
type Dues = Record<string, unknown> & { balancePaise: string; creditPaise: string; writeOff: null | Record<string, unknown>; writeOffNeedsReview: boolean };

/** Past trip, approved by Accounts, paid SELLING - gap (gap > 0: due; gap < 0: excess). Write-off On (limit 500000). */
async function ended(gap: number, opts: { past?: boolean; enable?: boolean } = {}) {
  await h.people();
  const past = opts.past ?? true;
  const b = await h.book([past ? PAST_HOTEL_ITEM : HOTEL_ITEM], past ? { trip: { start: PAST_TRIP.start, end: PAST_TRIP.end } } : {});
  await h.approveReal(b.versionId);
  const receipt = await h.receipt(DEAL, String(Number(SELLING) - gap));
  if (opts.enable ?? true) await h.writeOffOn(true);
  return { b, receipt };
}
const dues = () => one<Dues>(ACC, SQL3.dealDues, [DEAL]);
const propose = (direction: 'due' | 'excess', amount: string, actor = ACC, requestId = rid()) =>
  one<WO>(actor, SQL3.woPropose, [DEAL, JSON.stringify({ direction, amountPaise: amount, reason: REASON }), requestId]);
const row = async (id: string) => (await owner<Record<string, unknown> & { row_version: number; amount_paise: string; status: string }>(
  'select *, amount_paise::text as amount_paise from public.deal_write_offs where id = $1', [id]))[0]!;
const decide = async (id: string, decision: 'approve' | 'return', actor = MANAGER, amount?: string, reason: string | null = null) => {
  const r = await row(id);
  return one<WO>(actor, SQL3.woDecide, [id, decision, amount ?? r.amount_paise, reason, r.row_version, rid()]);
};

describe('6.6 write-off: switch, readiness and amount rules', () => {
  it('write_off_off while Off; trip_not_ended before the trip ends', async () => {
    await asOwner(db, async () => {
      await ended(30000, { enable: false });
      await refused(ACC, SQL3.woPropose, [DEAL, JSON.stringify({ direction: 'due', amountPaise: '30000', reason: REASON }), rid()],
        'write_off_off', '55000');
    });
    await asOwner(db, async () => {
      await ended(30000, { past: false });
      await refusedHint(ACC, SQL3.woPropose, [DEAL, JSON.stringify({ direction: 'due', amountPaise: '30000', reason: REASON }), rid()],
        'not_ready', /trip_not_ended/);
    });
  });

  it('whole balance only; limit from the setting (hint limitPaise); direction must match the balance; only Accounts proposes', async () => {
    await asOwner(db, async () => {
      await ended(30000);
      expect((await dues()).balancePaise).toBe('30000');
      await refused(ACC, SQL3.woPropose, [DEAL, JSON.stringify({ direction: 'due', amountPaise: '29999', reason: REASON }), rid()],
        'write_off_not_balance', '22023');
      await refused(ACC, SQL3.woPropose, [DEAL, JSON.stringify({ direction: 'excess', amountPaise: '30000', reason: REASON }), rid()],
        'write_off_not_balance', '22023');
      await refusedHint(ACC, SQL3.woPropose, [DEAL, JSON.stringify({ direction: 'due', amountPaise: '30000', reason: 'short' }), rid()],
        'invalid_input', /reason/);
      for (const actor of [OWNER, MANAGER, PURCHASE]) {
        await refused(actor, SQL3.woPropose, [DEAL, JSON.stringify({ direction: 'due', amountPaise: '30000', reason: REASON }), rid()],
          'not_authorized', '42501');
      }
      await h.writeOffOn(true, '20000');
      await refusedHint(ACC, SQL3.woPropose, [DEAL, JSON.stringify({ direction: 'due', amountPaise: '30000', reason: REASON }), rid()],
        'write_off_over_limit', /limitPaise/, '22023');
    });
  });

  it('above ₹5,000: a balance of 500001 paise can never be written off', async () => {
    await asOwner(db, async () => {
      await ended(500001);
      await refused(ACC, SQL3.woPropose, [DEAL, JSON.stringify({ direction: 'due', amountPaise: '500001', reason: REASON }), rid()],
        'write_off_over_limit', '22023');
    });
  });

  it('blocked by a live refund request, an open cancellation or an unverified receipt', async () => {
    await asOwner(db, async () => {
      await ended(-30000); // excess 30000
      await h.refundsOn();
      const { receipt } = { receipt: (await owner<{ id: string }>('select id from public.customer_receipts where deal_id = $1', [DEAL]))[0]! };
      await h.request({ kind: 'overpayment', amountPaise: '10000', outcome: 'payout', payeeKind: 'original_payer', payeeReceiptId: receipt.id });
      await refusedHint(ACC, SQL3.woPropose, [DEAL, JSON.stringify({ direction: 'excess', amountPaise: '30000', reason: REASON }), rid()],
        'not_ready', /refund_open/);
    });
    await asOwner(db, async () => {
      await ended(30000);
      await h.fin.record(ACC, DEAL, await h.fin.bankFields({ amountPaise: '1000' })); // recorded, not verified
      await refusedHint(ACC, SQL3.woPropose, [DEAL, JSON.stringify({ direction: 'due', amountPaise: '30000', reason: REASON }), rid()],
        'not_ready', /receipt_unverified/);
    });
    await asOwner(db, async () => {
      await ended(30000);
      await one(MANAGER, 'select public.deal_cancellation_open($1, $2, $3) as r', [DEAL, REASON, rid()]);
      await refusedHint(ACC, SQL3.woPropose, [DEAL, JSON.stringify({ direction: 'due', amountPaise: '30000', reason: REASON }), rid()],
        'not_ready', /cancellation_open/);
    });
  });
});

describe('6.6 write-off lifecycle', () => {
  it('due: propose -> one active per Deal -> approve binds the amount -> dues zero -> undo -> balance back', async () => {
    await asOwner(db, async () => {
      await ended(30000);
      const before = await h.lastAuditId();
      const p = await propose('due', '30000');
      expect(p).toMatchObject({ status: 'proposed' });
      expect(p.refNo).toMatch(/^WO-[0-9]{4}-[0-9]{6}$/);
      // One active per Deal (also the race guard): a second proposal is refused.
      await refused(ACC_J2, SQL3.woPropose, [DEAL, JSON.stringify({ direction: 'due', amountPaise: '30000', reason: REASON }), rid()],
        'write_off_open_exists', '23505');
      // Replay of the same request is not a second proposal.
      const reqId = (await owner<{ request_id: string }>('select request_id from public.deal_write_offs where id = $1', [p.writeOffId]))[0]!.request_id;
      expect((await propose('due', '30000', ACC, reqId)).writeOffId).toBe(p.writeOffId);
      // Approval: Approver only, amount bound, not by the proposer.
      await refused(OWNER, SQL3.woDecide, [p.writeOffId, 'approve', '30000', null, (await row(p.writeOffId)).row_version, rid()], 'not_authorized', '42501');
      await refused(MANAGER, SQL3.woDecide, [p.writeOffId, 'approve', '29999', null, (await row(p.writeOffId)).row_version, rid()],
        'version_changed', '40001');
      await refused(MANAGER, SQL3.woDecide, [p.writeOffId, 'approve', '30000', null, 999, rid()], 'version_changed', '40001');
      const ok = await decide(p.writeOffId, 'approve');
      expect(ok.status).toBe('approved');
      const d = await dues();
      expect(d.balancePaise).toBe('0');
      expect(d.writeOff).toMatchObject({ refNo: p.refNo, direction: 'due', amountPaise: '30000', status: 'approved', reason: REASON });
      expect(d.writeOffNeedsReview).toBe(false);
      // No journal entry, no change to money held.
      expect((await owner<{ n: number }>(`select count(*)::int as n from public.finance_journal_entries where deal_id = $1 and kind not like 'receipt%'`,
        [DEAL]))[0]!.n).toBe(0);
      // Undo: branch Manager with a reason.
      await refused(ACC, SQL3.woUndo, [p.writeOffId, (await row(p.writeOffId)).row_version, REASON, rid()], 'not_authorized', '42501');
      await one(MANAGER, SQL3.woUndo, [p.writeOffId, (await row(p.writeOffId)).row_version, REASON, rid()]);
      expect((await row(p.writeOffId)).status).toBe('undone');
      expect((await dues()).balancePaise).toBe('30000');
      await refused(MANAGER, SQL3.woUndo, [p.writeOffId, (await row(p.writeOffId)).row_version, REASON, rid()], 'wrong_state');
      // Audit: ids and direction only, never the amount.
      const rows = await h.auditsSince(before);
      const actions = rows.map((r) => r.action);
      expect(actions).toEqual(expect.arrayContaining(['accounts.write_off.proposed', 'accounts.write_off.approved', 'accounts.write_off.undone']));
      const proposed = rows.find((r) => r.action === 'accounts.write_off.proposed')!;
      expect(proposed.details).toMatchObject({ writeOffId: p.writeOffId, dealId: DEAL, direction: 'due' });
      for (const r of rows.filter((x) => x.action.startsWith('accounts.write_off'))) expect(text(r.details)).not.toMatch(/(?<![0-9])30000(?![0-9])/);
    });
  });

  it('excess: kept money -> credit zero after approval; the kept excess can never be refunded (adjusted total)', async () => {
    await asOwner(db, async () => {
      const { receipt } = await ended(-30000);
      expect((await dues()).creditPaise).toBe('30000');
      const p = await propose('excess', '30000');
      await decide(p.writeOffId, 'approve');
      expect((await dues()).creditPaise).toBe('0');
      await h.refundsOn();
      await refusedHint(OWNER, 'select public.customer_refund_request_create($1, $2::jsonb, $3) as r', [DEAL, JSON.stringify({ reason: REASON,
        kind: 'overpayment', outcome: 'payout', amountPaise: '30000', payeeKind: 'original_payer', payeeReceiptId: receipt.id }), rid()],
      'refund_exceeds_money', /amountPaise/);
    });
  });

  it('proposer cannot approve (not_self_approval); return with reason; withdraw by the proposer only while proposed', async () => {
    await asOwner(db, async () => {
      await ended(30000);
      await h.addRole(U.managerDelhi, 'accounts', 'DEL');
      const own = await propose('due', '30000', MANAGER);
      await refused(MANAGER, SQL3.woDecide, [own.writeOffId, 'approve', '30000', null, (await row(own.writeOffId)).row_version, rid()],
        'not_self_approval', '42501');
      // Another Manager of the entity approves when the only branch Manager proposed (LD37).
      await refusedHint(MANAGER_J2, SQL3.woDecide, [own.writeOffId, 'return', '30000', null, (await row(own.writeOffId)).row_version, rid()],
        'invalid_input', /reason/);
      await decide(own.writeOffId, 'return', MANAGER_J2, undefined, REASON);
      expect((await row(own.writeOffId)).status).toBe('returned');
      await refused(MANAGER, SQL3.woWithdraw, [own.writeOffId, (await row(own.writeOffId)).row_version, REASON, rid()], 'wrong_state');
      const next = await propose('due', '30000');
      await refused(ACC_J2, SQL3.woWithdraw, [next.writeOffId, (await row(next.writeOffId)).row_version, REASON, rid()], 'not_authorized', '42501');
      await one(ACC, SQL3.woWithdraw, [next.writeOffId, (await row(next.writeOffId)).row_version, REASON, rid()]);
      expect((await row(next.writeOffId)).status).toBe('withdrawn');
      await expectGuard(next.writeOffId);
    });
  });

  it('needs review after a later receipt; nothing is undone automatically', async () => {
    await asOwner(db, async () => {
      await ended(30000);
      const p = await propose('due', '30000');
      await decide(p.writeOffId, 'approve');
      await h.receipt(DEAL, '100');
      const d = await dues();
      expect(d.writeOffNeedsReview).toBe(true);
      expect((await row(p.writeOffId)).status).toBe('approved');
    });
  });
});

async function expectGuard(id: string) {
  // Facts are immutable (6.6 guard): the Tally touch trigger relies on it (acc-b-smoke IMMUTABLE set).
  for (const set of ["amount_paise = amount_paise + 1", "direction = 'excess'", "ref_no = 'WO-2026-999999'"]) {
    await db.exec('savepoint f');
    let refusedFact = false;
    try {
      await owner(`update public.deal_write_offs set ${set} where id = $1`, [id]);
    } catch {
      refusedFact = true;
    }
    await db.exec('rollback to savepoint f');
    expect(refusedFact, `immutable: ${set}`).toBe(true);
  }
  await db.exec('savepoint g');
  let failed = false;
  try {
    await owner('delete from public.deal_write_offs where id = $1', [id]);
  } catch {
    failed = true;
  }
  await db.exec('rollback to savepoint g');
  expect(failed, 'no DELETE on deal_write_offs').toBe(true);
}

describe('6.6 reads and fences', () => {
  it('R-B1 small balances: A and branch M; Sales, Purchase null; row and presets', async () => {
    await asOwner(db, async () => {
      await ended(30000);
      const page = await one<{ items: Array<Record<string, unknown> & { dealId: string; direction: string; balancePaise: string; can: Record<string, boolean> }> }>(
        ACC, SQL3.smallBalances, ['{}', null, 50]);
      const r = page.items.find((i) => i.dealId === DEAL)!;
      expect(r).toMatchObject({ direction: 'due', balancePaise: '30000' });
      expect(r.can.propose).toBe(true);
      expect(Object.keys(r)).toEqual(expect.arrayContaining(['dealId', 'dealReference', 'branchName', 'tripEnd', 'direction', 'balancePaise', 'limitPaise',
        'writeOff', 'blockedBy', 'can']));
      expect(await one(MANAGER, SQL3.smallBalances, ['{}', null, 50])).not.toBeNull();
      for (const actor of [OWNER, PURCHASE]) expect(await one(actor, SQL3.smallBalances, ['{}', null, 50]), 'fenced').toBeNull();
      const p = await propose('due', '30000');
      // ASSUMPTION: presets are passed as {preset: 'to_approve'} (6.6 names the presets, not the filter key).
      const toApprove = await one<{ items: Array<{ dealId: string; can: Record<string, boolean> }> }>(MANAGER, SQL3.smallBalances,
        [JSON.stringify({ preset: 'to_approve' }), null, 50]);
      expect(toApprove.items.map((i) => i.dealId)).toContain(DEAL);
      expect(toApprove.items.find((i) => i.dealId === DEAL)!.can.approve).toBe(true);
      await decide(p.writeOffId, 'approve');
      // Sales owner sees the dues line only (through deal_dues), never the list.
      expect(await one(OWNER, SQL3.smallBalances, [JSON.stringify({ preset: 'to_approve' }), null, 50])).toBeNull();
    });
  });

  it('R-B2 monthly totals: branch M and Super Admin; Purchase and Sales null', async () => {
    await asOwner(db, async () => {
      await ended(30000);
      const p = await propose('due', '30000');
      await decide(p.writeOffId, 'approve');
      const month = `${dayFrom(0).slice(0, 7)}-01`;
      for (const actor of [MANAGER, SUPER]) {
        const m = await one<{ month: string; branches: Array<{ branchName: string; count: number; duePaise: string; excessPaise: string }> }>(actor,
          SQL3.woMonthly, [month]);
        expect(m).not.toBeNull();
        const del = m.branches.find((b) => b.branchName === 'Delhi')!;
        expect(del).toMatchObject({ count: 1, duePaise: '30000', excessPaise: '0' });
      }
      for (const actor of [OWNER, PURCHASE]) expect(await one(actor, SQL3.woMonthly, [month])).toBeNull();
    });
  });
});
