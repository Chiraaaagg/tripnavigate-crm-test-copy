import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccountsDealDetailSchema } from '@/modules/finance/dto';
import { type TestDb, asOwner, createTestDb } from '../helpers/db';
import { b11Helpers } from './b11-support';
import { ACCOUNTS_DETAIL, CLAIMS_SUITE_LOCK, claimHelpers } from './b11-claims-support';
import { ACC, DEAL, SALES } from './finance-support';

/**
 * B1.1 Accounts deal detail (appendix B section 3.3, DEC-29): Accounts
 * reviews the payment plan, list price, discount, services and booking
 * contact together with the booking; Sales-proposed billing shows its
 * source; Sales-reported claims appear with the viewer's actions. Every
 * key that existed before 20261119000200 keeps its value, and identity data
 * is never part of the Accounts read.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
  if (db.mode === 'postgres') await db.query('select pg_advisory_lock($1::bigint)', [CLAIMS_SUITE_LOCK]);
});
afterAll(async () => {
  await db?.close();
});

const h = claimHelpers(() => db);
const b = b11Helpers(() => db);

type Detail = Record<string, unknown> & {
  booking: Record<string, unknown> | null;
  billing: Record<string, unknown> | null;
  claims: Array<Record<string, unknown>>;
};
const detail = () => h.one<Detail>(ACC, ACCOUNTS_DETAIL, [DEAL]);

const PRE_B11_BOOKING_KEYS = [
  'adults', 'approveBlock', 'bookingVersionId', 'canApprove', 'checkIn', 'checkOut', 'children', 'city', 'confirmedAt',
  'confirmedByName', 'hotelName', 'returnReason', 'reviewRowVersion', 'reviewStatus', 'reviewedAt', 'reviewedByName',
  'rooms', 'sellingTotalPaise', 'versionNo',
];
const B11_BOOKING_KEYS = ['contact', 'discountPaise', 'listPricePaise', 'paymentPlan', 'serviceType', 'services'];

/** A confirmed package (hotel + flight) with list price, discount and a two-part plan. */
async function confirmedPackage(): Promise<string> {
  const ready = await b.readyPackage(SALES, DEAL, ['hotel', 'flight']);
  const rv = (await b.saveCommercials(SALES, ready.versionId, ready.rowVersion, '10000000', '123457', '9876543')).rowVersion;
  await b.savePlan(SALES, ready.versionId, rv, [
    { seq: 2, label: 'Balance', amountPaise: '6876543', dueDate: '2026-12-01' },
    { seq: 1, label: 'Advance', amountPaise: '3000000', dueDate: '2026-11-01' },
  ]);
  const r = await b.readiness(SALES, ready.versionId);
  expect(r.issues).toEqual([]);
  await b.confirm(SALES, ready.versionId, r.contentHash);
  return ready.versionId;
}

describe('plan review keys', () => {
  it('a package booking shows plan, list price, discount, services, contact and billing source', async () => {
    await asOwner(db, async () => {
      const versionId = await confirmedPackage();
      const d = await detail();
      expect(d.booking).toMatchObject({
        bookingVersionId: versionId, serviceType: 'package', sellingTotalPaise: '9876543',
        listPricePaise: '10000000', discountPaise: '123457', hotelName: null,
        paymentPlan: {
          instalments: [
            { seq: 1, label: 'Advance', amountPaise: '3000000', dueDate: '2026-11-01' },
            { seq: 2, label: 'Balance', amountPaise: '6876543', dueDate: '2026-12-01' },
          ],
          totalPaise: '9876543',
          matchesSellingTotal: true,
        },
        services: [{ itemNo: 1, serviceType: 'hotel' }, { itemNo: 2, serviceType: 'flight' }],
        contact: { name: 'Synthetic Contact', mobile: '9876500011', email: 'contact@example.test', bookingFor: 'individual', payerName: null },
        reviewStatus: 'pending',
      });
      expect(d.billing).toMatchObject({ prefillSource: 'sales', status: 'draft' });
      // Identity data is never part of the Accounts read.
      const text = JSON.stringify(d);
      for (const key of ['passport', 'dateOfBirth', 'nationality', 'identity']) expect(text).not.toContain(key);
      // The current DTO still parses the replacement (additive keys only).
      expect(AccountsDealDetailSchema.safeParse(d).success).toBe(true);
    });
  });

  it('a legacy hotel booking keeps every earlier key and value; the new keys are empty', async () => {
    await asOwner(db, async () => {
      const versionId = await h.bookedDeal();
      const d = await detail();
      // 20261119000300 (Atlas) adds booking.revision and booking.earlierVersions.
      // 20261124000120 (booking form) adds booking.prices.
      expect(Object.keys(d.booking!).sort()).toEqual([...PRE_B11_BOOKING_KEYS, ...B11_BOOKING_KEYS, 'earlierVersions', 'prices', 'revision'].sort());
      expect(d.booking).toMatchObject({
        bookingVersionId: versionId, versionNo: 1, hotelName: 'Synthetic Hotel (fixture)', city: 'Synthetic City',
        checkIn: '2026-12-10', checkOut: '2026-12-13', rooms: 2, adults: 3, children: 1, sellingTotalPaise: '9876543',
        reviewStatus: 'pending', reviewRowVersion: 0, returnReason: null, canApprove: false, approveBlock: 'billing_not_verified',
        serviceType: 'hotel', listPricePaise: null, discountPaise: null, paymentPlan: null, services: [], contact: null,
        revision: null, earlierVersions: [],
      });
      expect(Object.keys(d).sort()).toEqual([
        'billing', 'booking', 'branchId', 'branchName', 'branches', 'claims', 'claimsReportedPaise', 'collectors', 'dealId',
        'dealReference', 'dealTitle', 'isSynthetic', 'legalEntityId', 'liveModes', 'modesAllowed', 'money', 'policy', 'receipts',
      ]);
      expect(d).toMatchObject({ claims: [], claimsReportedPaise: '0', billing: null });
      expect(AccountsDealDetailSchema.safeParse(d).success).toBe(true);
    });
  });

  it('a plan that does not add up is shown as such (unreachable through readiness; test-only edit)', async () => {
    await asOwner(db, async () => {
      const versionId = await confirmedPackage();
      await h.owner('alter table public.booking_version_instalments disable trigger user');
      await h.owner('update public.booking_version_instalments set amount_paise = 1000 where booking_version_id = $1 and seq = 2', [versionId]);
      await h.owner('alter table public.booking_version_instalments enable trigger user');
      expect((await detail()).booking!.paymentPlan).toMatchObject({ totalPaise: '3001000', matchesSellingTotal: false });
    });
  });
});

describe('claims in the Accounts detail', () => {
  it('lists claims with masked destination, possible receipts and the viewer actions', async () => {
    await asOwner(db, async () => {
      await h.bookedDeal();
      const fields = await h.bankClaim();
      const claim = await h.report(SALES, fields);
      const cash = await h.report(SALES, h.cashClaim({ amountPaise: '777700' }));
      const receipt = await h.record(ACC, DEAL, await h.receiptFieldsFor(fields));
      let d = await detail();
      expect(d.claimsReportedPaise).toBe('3277700');
      const bank = d.claims.find((c) => c.claimId === claim.id)!;
      expect(bank).toMatchObject({
        status: 'reported', displayStatus: 'reported', amountPaise: '2500000', bookingVersionNo: 1,
        destination: { label: 'Synthetic fixture destination', kind: 'bank', versionNo: 1, accountMasked: 'XXXX6789', isCurrent: true },
        possibleReceiptIds: [receipt.id],
        actions: { recordReceipt: null, linkReceipt: null, markNotReceived: null },
      });
      expect(JSON.stringify(d.claims)).not.toContain('000123456789');
      expect(d.claims.find((c) => c.claimId === cash.id)!.possibleReceiptIds).toEqual([]);
      // Money in the detail is unchanged by claims.
      expect(d.money).toEqual({ availablePaise: '0', awaitingVerificationPaise: '2500000', chequesAwaitingClearancePaise: '0' });

      await h.link(ACC, claim.id, receipt.id);
      d = await detail();
      expect(d.claims.find((c) => c.claimId === claim.id)).toMatchObject({
        status: 'linked', displayStatus: 'recorded', linkedReceiptId: receipt.id, linkedReceiptNo: receipt.receiptNo,
        linkKind: 'linked_existing', possibleReceiptIds: [],
        actions: { recordReceipt: 'wrong_state', linkReceipt: 'wrong_state', markNotReceived: 'wrong_state' },
      });
      expect(d.claims.find((c) => c.claimId === cash.id)!.possibleReceiptIds).toEqual([]);
    });
  });

  it('blocks: Deal conflict, removed Deal and a mode that is not live', async () => {
    await asOwner(db, async () => {
      await h.bookedDeal();
      const claim = await h.report(SALES, h.cashClaim());
      const actions = async () => (await detail()).claims.find((c) => c.claimId === claim.id)!.actions;
      await h.markImported();
      await h.owner('alter table public.deals drop constraint deals_removed_imported_only'); // test-only
      await h.owner(`update public.deals set removed_at = now(), removed_reason = 'stage_not_eligible' where id = $1`, [DEAL]);
      expect(await actions()).toEqual({ recordReceipt: 'deal_removed', linkReceipt: null, markNotReceived: null });
      await h.owner(`update public.deals set removed_at = null, removed_reason = null where id = $1`, [DEAL]);
      await h.owner('alter table public.deal_commercials drop constraint deal_commercials_synthetic_parent');
      await h.owner('update public.deals set is_synthetic = false where id = $1', [DEAL]);
      await h.setEnvironment('operational');
      expect(await actions()).toEqual({ recordReceipt: 'mode_not_live', linkReceipt: null, markNotReceived: null });
      await h.setEnvironment('test');
      await h.owner('update public.deals set is_synthetic = true where id = $1', [DEAL]);
      await h.addSalesAssignment(DEAL, ACC.userId!);
      expect(await actions()).toEqual({ recordReceipt: 'deal_conflict', linkReceipt: 'deal_conflict', markNotReceived: 'deal_conflict' });
    });
  });
});
