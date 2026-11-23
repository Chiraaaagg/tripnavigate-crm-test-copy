import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE_USERS as U, type TestDb, asOwner, createTestDb, istBusinessDate } from '../helpers/db';
import {
  ACC, DEAL, DUES_ROW_KEYS, type DealDues, type DuesRow, HOTEL_ITEM, MANAGER, OWNER, type Plan, SELLING, SQL, accHelpers, dayFrom, rid, today,
} from './acc-support';

/**
 * Accounts phase contract sections 4.4 (dues), 6.2.4 (approval memory),
 * 8.3 (accounts_dues, deal_dues, supplier payables), test plan 12.2 "Dues",
 * Track E. Money = customer_advances journal balance only (R16.1); reported
 * claims are never money; supplier payments and company funding never
 * reduce dues; allocation oldest due first; statuses at the IST date
 * (authz.finance_today), whatever the session time zone; basis = the last
 * Accounts-approved version (provisional 'awaiting_review' when none, AL3).
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = accHelpers(() => db);
const { one, owner } = h;

/** 3,000,000 overdue (3 days ago) + 3,000,000 due today + the rest in ten days; sums to SELLING. */
const PLAN: Plan = [
  { seq: 1, label: 'Advance', amountPaise: '3000000', dueDate: dayFrom(-3) },
  { seq: 2, label: 'Second part', amountPaise: '3000000', dueDate: dayFrom(0) },
  { seq: 3, label: 'Balance', amountPaise: String(Number(SELLING) - 6_000_000), dueDate: dayFrom(10) },
];
const dues = () => one<DealDues>(ACC, SQL.dealDues, [DEAL]);
async function booked(plan: Plan = PLAN, approve = true) {
  await h.addAcc2();
  const b = await h.book([HOTEL_ITEM], { plan });
  if (approve) await h.approve(b.versionId);
  return b;
}

describe('4.4 allocation and statuses', () => {
  it('no money: overdue first, due today, upcoming; balance is the total; row keys frozen', async () => {
    await asOwner(db, async () => {
      await booked();
      const d = await dues();
      // Accounts phase 2 (contract 7.2): deal_dues adds the refunds block.
      // Accounts phase 3 (contract 6.6, 16.6 setup update, lead OK 13 Nov): + writeOff, writeOffNeedsReview.
      expect(Object.keys(d).filter((k) => !['instalments', 'tallyInvoices', 'supplierPayables', 'canAddTallyInvoice', 'scope', 'viewer', 'refunds',
        'writeOff', 'writeOffNeedsReview'].includes(k)).sort())
        .toEqual(DUES_ROW_KEYS);
      expect(d).toMatchObject({ status: 'overdue', totalPaise: SELLING, verifiedPaise: '0', balancePaise: SELLING, overduePaise: '3000000',
        dueNowPaise: '3000000', nextDue: { date: dayFrom(-3), openPaise: '3000000' }, reportedPaise: '0', creditPaise: '0', cancellation: null,
        basis: { kind: 'approved', newerVersionPending: false } });
      expect(d.instalments.map((i) => [i.seq, i.status, i.coveredPaise, i.openPaise, i.partlyPaid])).toEqual([
        [1, 'overdue', '0', '3000000', false], [2, 'due_now', '0', '3000000', false], [3, 'upcoming', '0', String(Number(SELLING) - 6_000_000), false]]);
    });
  });

  it('verified money covers the oldest first; partly paid; reported claims and unverified receipts never count', async () => {
    await asOwner(db, async () => {
      await booked();
      await h.receipt(DEAL, '4000000');
      let d = await dues();
      expect(d).toMatchObject({ status: 'due_now', verifiedPaise: '4000000', balancePaise: String(Number(SELLING) - 4_000_000), overduePaise: '0',
        dueNowPaise: '2000000', nextDue: { date: today(), openPaise: '2000000' } });
      expect(d.instalments.map((i) => [i.status, i.coveredPaise, i.openPaise, i.partlyPaid])).toEqual([
        ['paid', '3000000', '0', false], ['due_now', '1000000', '2000000', true], ['upcoming', '0', String(Number(SELLING) - 6_000_000), false]]);
      // Reported claim: shown, never money.
      const claim = await h.cl.report(OWNER, await h.cl.bankClaim({ amountPaise: '2000000' }));
      d = await dues();
      expect(d).toMatchObject({ reportedPaise: '2000000', verifiedPaise: '4000000', dueNowPaise: '2000000' });
      // A recorded, unverified receipt: awaiting verification, not money.
      const pending = await h.fin.record(ACC, DEAL, await h.fin.bankFields({ amountPaise: '2000000' }));
      d = await dues();
      expect(d).toMatchObject({ awaitingVerificationPaise: '2000000', verifiedPaise: '4000000' });
      // Linking the claim to the verified receipt: no longer "reported", counted once.
      await h.fin.proof(ACC, 'receipt', pending.id, 'bank_proof');
      await h.fin.verify({ userId: U.visaJodhpur }, pending.id);
      await h.cl.link(ACC, claim.id as string, pending.id, 'Synthetic: same amount and date, different reference');
      d = await dues();
      expect(d).toMatchObject({ reportedPaise: '0', verifiedPaise: '6000000', awaitingVerificationPaise: '0', status: 'upcoming', dueNowPaise: '0' });
    });
  });

  it('reversal and a bounced (reversed) cheque raise dues again; a cheque counts only once cleared', async () => {
    await asOwner(db, async () => {
      await booked();
      const r = await h.receipt(DEAL, '3000000');
      expect((await dues()).instalments[0]!.status).toBe('paid');
      await h.fin.reverse(ACC, r.id, 'data_error');
      expect(await dues()).toMatchObject({ verifiedPaise: '0', status: 'overdue', overduePaise: '3000000' });
      const chq = await h.fin.record(ACC, DEAL, await h.fin.chequeFields({ amountPaise: '3000000' }));
      await h.fin.proof(ACC, 'receipt', chq.id, 'cheque_image');
      await h.fin.verify({ userId: U.visaJodhpur }, chq.id);
      expect((await dues()).verifiedPaise, 'pending clearance is not money').toBe('0');
      await h.fin.proof(ACC, 'receipt', chq.id, 'bank_proof');
      await h.fin.clear({ userId: U.visaJodhpur }, chq.id);
      expect((await dues()).verifiedPaise).toBe('3000000');
      await h.fin.reverse(ACC, chq.id, 'bank_return');
      expect(await dues()).toMatchObject({ verifiedPaise: '0', status: 'overdue' });
    });
  });

  it('paid, customer credit, upcoming; no plan -> no_plan / unallocated', async () => {
    await asOwner(db, async () => {
      await booked();
      await h.receipt(DEAL, SELLING);
      expect(await dues()).toMatchObject({ status: 'paid', balancePaise: '0', creditPaise: '0', nextDue: null });
      await h.receipt(DEAL, '100000');
      expect(await dues()).toMatchObject({ status: 'credit', creditPaise: '100000', balancePaise: '0' });
    });
    await asOwner(db, async () => {
      await booked([{ seq: 1, label: 'Full payment', amountPaise: SELLING, dueDate: dayFrom(5) }]);
      expect(await dues()).toMatchObject({ status: 'upcoming', overduePaise: '0', dueNowPaise: '0', nextDue: { date: dayFrom(5), openPaise: SELLING } });
    });
    await asOwner(db, async () => {
      await h.addAcc2();
      // Legacy hotel version (switch off): charges = total, no instalments.
      const version = await h.fin.confirmedBooking(DEAL, OWNER);
      await h.approve(version);
      expect(await dues()).toMatchObject({ status: 'no_plan', totalPaise: '9876543', instalments: [] });
      await h.receipt(DEAL, '1000000');
      expect(await dues()).toMatchObject({ status: 'unallocated', verifiedPaise: '1000000', balancePaise: '8876543' });
    });
  });

  it('supplier payments and company funding never reduce dues', async () => {
    await asOwner(db, async () => {
      const b = await booked();
      await h.receipt(DEAL, '1000000');
      const before = await dues();
      const task = h.taskOf(b, 'hotel');
      await h.purchaseCost(task, await h.purchaseSupplier());
      await h.goAhead(task);
      const p = await h.purchaseRequest(task, 900_000);
      await h.payThrough(p.id, 'verified');
      await h.purchaseRequest(task, 2_000_000, { fundingReason: 'Synthetic funding reason: customer transfer delayed' });
      const after = await dues();
      expect(after).toMatchObject({ verifiedPaise: before.verifiedPaise, balancePaise: before.balancePaise, status: before.status });
      expect(after.instalments).toEqual(before.instalments);
    });
  });

  it('due today vs overdue follows the IST date, whatever the session time zone', async () => {
    await asOwner(db, async () => {
      await booked();
      expect((await owner<{ d: string }>('select authz.finance_today()::text as d'))[0]!.d).toBe(istBusinessDate());
      const base = (await dues()).instalments.map((i) => i.status);
      for (const tz of ['Pacific/Kiritimati', 'America/Los_Angeles', 'UTC']) {
        await owner(`set local timezone = '${tz}'`);
        expect((await dues()).instalments.map((i) => i.status), tz).toEqual(base);
      }
      expect(base).toEqual(['overdue', 'due_now', 'upcoming']);
    });
  });

  it('cancellation flag: open while a cancellation is not approved', async () => {
    await asOwner(db, async () => {
      await booked();
      await one(MANAGER, SQL.cancelOpen, [DEAL, 'Synthetic: the customer cancelled the trip', rid()]);
      expect((await dues()).cancellation).toBe('open');
    });
  });
});

describe('8.3 deal_dues shape', () => {
  it('deal_dues carries only the contract keys (row + instalments, tallyInvoices, supplierPayables)', async () => {
    await asOwner(db, async () => {
      await booked();
      // Lead-approved additions (10 Nov, Track B addendum): canAddTallyInvoice, scope and viewer.
      // Accounts phase 2 (contract 7.2): + refunds {live, paidPaise, keptAsCreditPaise}.
      const extra = Object.keys(await dues()).filter((k) => ![...DUES_ROW_KEYS, 'instalments', 'tallyInvoices', 'supplierPayables',
        'canAddTallyInvoice', 'scope', 'viewer', 'refunds',
        // Accounts phase 3 (contract 6.6, 16.6 setup update, lead OK 13 Nov).
        'writeOff', 'writeOffNeedsReview'].includes(k));
      expect(extra, 'keys not in contract 8.3 need the lead\'s OK').toEqual([]);
    });
  });
});

describe('4.4 basis version and 6.2.4 approval memory', () => {
  it('never approved: provisional basis (awaiting_review); approved with the real command: basis approved and last_approved_* set', async () => {
    await asOwner(db, async () => {
      const b = await booked(PLAN, false);
      expect((await dues()).basis).toMatchObject({ kind: 'awaiting_review', newerVersionPending: false, versionNo: 1 });
      await h.approveReal(b.versionId);
      const [row] = await owner<{ last_approved_at: string | null; last_approved_by: string | null }>(
        'select last_approved_at, last_approved_by from public.accounts_booking_reviews where booking_version_id = $1', [b.versionId]);
      expect(row).toMatchObject({ last_approved_by: U.accountsJodhpur });
      expect(row!.last_approved_at).not.toBeNull();
      expect((await dues()).basis).toMatchObject({ kind: 'approved', versionNo: 1 });
    });
  });

  it('a returned and revised booking keeps the last approved version as basis (newerVersionPending) until Accounts approves the new total', async () => {
    await asOwner(db, async () => {
      const b = await booked(PLAN, false);
      await h.approveReal(b.versionId);
      const NEW_TOTAL = String(Number(SELLING) + 1_000_000);
      const v2 = await h.revise(b.versionId, async (versionId, rv) => {
        let next = (await h.saveSelling(OWNER, versionId, rv, NEW_TOTAL)).rowVersion;
        next = (await h.savePlan(OWNER, versionId, next, [...PLAN.slice(0, 2), { ...PLAN[2]!, amountPaise: String(Number(PLAN[2]!.amountPaise) + 1_000_000) }]))
          .rowVersion;
        return next;
      });
      const [kept] = await owner<{ last_approved_at: string | null }>('select last_approved_at from public.accounts_booking_reviews where booking_version_id = $1', [b.versionId]);
      expect(kept!.last_approved_at, 'never cleared by the return').not.toBeNull();
      let d = await dues();
      expect(d).toMatchObject({ totalPaise: SELLING, basis: { kind: 'approved', versionNo: 1, newerVersionPending: true } });
      await h.approve(v2);
      d = await dues();
      expect(d).toMatchObject({ totalPaise: NEW_TOTAL, basis: { kind: 'approved', versionNo: 2, newerVersionPending: false } });
    });
  });
});

describe('8.3 lists, payables and sources', () => {
  it('accounts_dues: filters, status order, cursor; the Sales owner sees own Deals only', async () => {
    await asOwner(db, async () => {
      await booked();
      const list = await one<{ items: DuesRow[]; nextAfter: string | null }>(ACC, SQL.dues, [JSON.stringify({}), null, 50]);
      const row = list.items.find((x) => x.dealId === DEAL)!;
      expect(Object.keys(row).sort()).toEqual(DUES_ROW_KEYS);
      expect(row.status).toBe('overdue');
      const filtered = await one<{ items: DuesRow[] }>(ACC, SQL.dues, [JSON.stringify({ status: ['paid'] }), null, 50]);
      expect(filtered.items.map((x) => x.dealId)).not.toContain(DEAL);
      const byRef = await one<{ items: DuesRow[] }>(ACC, SQL.dues, [JSON.stringify({ dealReference: 'SYN-DEL-001' }), null, 50]);
      expect(byRef.items.map((x) => x.dealId)).toEqual([DEAL]);
      const branch = await one<{ items: DuesRow[] }>(ACC, SQL.dues, [JSON.stringify({ branchId: await h.branchId('AMD') }), null, 50]);
      expect(branch.items.map((x) => x.dealId)).not.toContain(DEAL);
      const reported = await one<{ items: DuesRow[] }>(ACC, SQL.dues, [JSON.stringify({ reported: true }), null, 50]);
      expect(reported.items.map((x) => x.dealId)).not.toContain(DEAL);
      const page = await one<{ items: DuesRow[]; nextAfter: string | null }>(ACC, SQL.dues, [JSON.stringify({}), null, 1]);
      if (page.nextAfter) expect(page.nextAfter).toMatch(/^\d+\|(\d{4}-\d{2}-\d{2}|-)\|[^|]*\|[0-9a-f-]{36}$/);
      const rank = ['overdue', 'due_now', 'upcoming', 'unallocated', 'no_plan', 'credit', 'paid'];
      const ranks = list.items.map((x) => rank.indexOf(x.status));
      expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
      const so = await one<{ items: DuesRow[] }>(OWNER, SQL.dues, [JSON.stringify({}), null, 50]);
      expect(so.items.every((x) => x.dealId === DEAL || x.ownerName !== null)).toBe(true);
      await h.refusedHint(ACC, SQL.dues, [JSON.stringify({ colour: 'red' }), null, 50], 'invalid_input', undefined, '22023');
    });
  });

  it('supplier payables: paid and billed side by side, no difference field (H10)', async () => {
    await asOwner(db, async () => {
      const b = await booked();
      await h.receipt(DEAL, '3000000');
      const task = h.taskOf(b, 'hotel');
      const supplierId = await h.purchaseSupplier();
      await h.purchaseCost(task, supplierId);
      await h.goAhead(task);
      const p = await h.purchaseRequest(task, 1_500_000);
      await h.payThrough(p.id, 'verified');
      await h.uploadDoc(task, { number: 'SYN-PAY-1', totalPaise: '10000000' });
      const pay = await one<Array<Record<string, unknown>> | { suppliers: Array<Record<string, unknown>> }>(ACC, SQL.payables, [DEAL]);
      const rows = Array.isArray(pay) ? pay : pay.suppliers;
      expect(rows).toEqual([expect.objectContaining({ supplierId, paidPaise: '1500000', verifiedPaise: '1500000', invoicesUploadedPaise: '10000000',
        invoicedAcceptedPaise: '0', creditNotesAcceptedPaise: '0', requestedLivePaise: '0' })]);
      expect(Object.keys(rows[0]!).filter((k) => /diff|outstanding|balance|due|short/i.test(k))).toEqual([]);
      expect((await dues()).supplierPayables).toBeDefined();
    });
  });

  it('dues reads never use sm_customer_money_available (R16.1)', async () => {
    await asOwner(db, async () => {
      const bodies = await owner<{ name: string; src: string }>(
        `select n.nspname || '.' || p.proname as name, p.prosrc as src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where (n.nspname = 'public' and p.proname in ('accounts_dues', 'deal_dues')) or (n.nspname = 'authz' and p.proname like 'dues%')`);
      expect(bodies.map((b) => b.name)).toEqual(expect.arrayContaining(['public.accounts_dues', 'public.deal_dues', 'authz.dues_basis']));
      for (const b of bodies) expect(b.src, b.name).not.toMatch(/sm_customer_money_available/);
    });
  });
});
