import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, asOwner, createTestDb } from '../helpers/db';
import { ACCOUNTS, BILLING, CONTACT, DEAL, FLIGHT, OWNER, PURCHASE, TRIP, rid } from './b1-support';
import { PROPOSE_SQL } from './b11-support';
import { ACCOUNTS_BILLING_SQL, BILL_TO, PARTY, formHelpers } from './booking-form-support';

/**
 * Booking form Bill To (migrations 20261124000100/0110/0120): personal and
 * business Bill To, GST registered or not with a recorded reason, the Accounts
 * verification boundary and older profiles. Mercury cases B7-B15, B18.
 * Synthetic data only; every scenario rolls back.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = formHelpers(() => db);
const { one, owner, refused, refusedWithHint } = h;

const BUSINESS = {
  ...BILLING, billingName: 'Synthetic Travels Pvt Ltd', billToType: 'business', contactPerson: 'Riya Mehta',
  phone: '+971501234567', email: 'accounts@example.test', gstStatus: 'registered', gstReason: null, gstin: '08ABCDE1234F1Z5',
};
const UNREGISTERED = { ...BUSINESS, gstStatus: 'unregistered', gstin: null, gstReason: 'Synthetic small firm below limit' };

const profile = () => owner<Record<string, unknown>>(
  `select bill_to_type, contact_person, phone, email, gst_status, gst_reason, gstin, status
   from public.customer_billing_profiles where deal_id = $1`, [DEAL]);
const rowVersion = async () => ((await owner<{ row_version: number }>(
  'select row_version from public.customer_billing_profiles where deal_id = $1', [DEAL]))[0]?.row_version ?? 0);
const billingCodes = (codes: string[]) =>
  codes.filter((c) => /^(billing_|gst)/.test(c));

describe('Bill To through the Sales proposal', () => {
  it('registered business: GSTIN of the right state; a GSTIN of another state is refused (B7)', async () => {
    await asOwner(db, async () => {
      await h.setSwitch('service_items_enabled', true);
      await h.propose(OWNER, DEAL, 0, BUSINESS);
      expect(await profile()).toEqual([{ bill_to_type: 'business', contact_person: 'Riya Mehta', phone: '+971501234567',
        email: 'accounts@example.test', gst_status: 'registered', gst_reason: null, gstin: '08ABCDE1234F1Z5', status: 'draft' }]);
      await refusedWithHint(OWNER, PROPOSE_SQL, [DEAL, 1, JSON.stringify({ ...BUSINESS, stateCode: '27' }), rid()], /^gstin$/);
    });
  });

  it('unregistered business: a 10-character reason and no GSTIN; shorter reasons and a GSTIN are refused (B8)', async () => {
    await asOwner(db, async () => {
      await h.setSwitch('service_items_enabled', true);
      await h.propose(OWNER, DEAL, 0, { ...UNREGISTERED, gstReason: '0123456789' });
      expect(await profile()).toMatchObject([{ gst_status: 'unregistered', gst_reason: '0123456789', gstin: null }]);
      await refusedWithHint(OWNER, PROPOSE_SQL, [DEAL, 1, JSON.stringify({ ...UNREGISTERED, gstReason: '012345678' }), rid()], /^gstReason$/);
      await refusedWithHint(OWNER, PROPOSE_SQL, [DEAL, 1, JSON.stringify({ ...UNREGISTERED, gstin: '08ABCDE1234F1Z5' }), rid()], /^gstin$/);
    });
  });

  it('a personal Bill To carries no contact person, GST status or reason; every bad key is named (B13)', async () => {
    await asOwner(db, async () => {
      await h.setSwitch('service_items_enabled', true);
      await h.propose(OWNER, DEAL, 0, { ...UNREGISTERED, billToType: 'personal' });
      expect(await profile()).toMatchObject([{ bill_to_type: 'personal', contact_person: null, gst_status: null, gst_reason: null }]);
      await refusedWithHint(OWNER, PROPOSE_SQL, [DEAL, 1, JSON.stringify({ ...BUSINESS, billToType: 'company', phone: '12345',
        email: 'nope', gstStatus: 'maybe', postalCode: '012345' }), rid()], /^billToType,email,gstStatus,phone,postalCode$/);
      await refusedWithHint(OWNER, PROPOSE_SQL, [DEAL, 1, JSON.stringify({ ...BUSINESS, status: 'verified' }), rid()], /^billing$/);
    });
  });

  it('readiness on a new-form draft: GST choice, reason, contact name and reach (B9, B10); a reason clears gstin_missing', async () => {
    await asOwner(db, async () => {
      await h.setSwitch('service_items_enabled', true);
      const r = await h.readyForm();
      const contact = { ...CONTACT, bookingFor: 'business' };
      const save = async (billing: unknown) => {
        const rv = (await one<{ rowVersion: number }>(OWNER, 'select public.booking_customer_save($1, $2, $3::jsonb, $4::jsonb, $5, $6) as r',
          [r.versionId, (await owner<{ row_version: number }>('select row_version from public.booking_versions where id = $1', [r.versionId]))[0]!.row_version,
            JSON.stringify(contact), JSON.stringify(billing), await rowVersion(), rid()])).rowVersion;
        return { rv, codes: billingCodes(await h.issues(OWNER, r.versionId)) };
      };
      expect((await save({ ...BUSINESS, gstStatus: null, gstin: null, contactPerson: null, phone: null, email: null })).codes)
        .toEqual(['gst_status_missing', 'billing_contact_missing', 'billing_reach_missing']);
      expect((await save({ ...BUSINESS, gstin: null })).codes).toEqual(['gstin_missing']);
      expect((await save(UNREGISTERED)).codes).toEqual([]);
      expect((await save(BUSINESS)).codes).toEqual([]);
      expect((await save(BILL_TO)).codes).toEqual([]);
    });
  });

  it('a profile saved before the booking form stays valid and reads its type from the booking contact (B18)', async () => {
    await asOwner(db, async () => {
      await h.setSwitch('service_items_enabled', true);
      // Older draft (form rules 1), older payload (no Bill To keys), business contact without GSTIN.
      const d = await h.draftWithTravellers();
      await one(OWNER, 'select public.booking_customer_save($1, $2, $3::jsonb, $4::jsonb, $5, $6) as r',
        [d.versionId, d.rowVersion, JSON.stringify({ ...CONTACT, bookingFor: 'business' }), JSON.stringify(BILLING), 0, rid()]);
      expect(await profile()).toMatchObject([{ bill_to_type: null, gst_status: null }]);
      expect(billingCodes(await h.issues(OWNER, d.versionId))).toEqual(['gstin_missing']);
      const form = (await h.form(OWNER))!;
      expect(form.billing).toMatchObject({ billToType: null, gstStatus: null, contactPerson: null, verifiedByName: null });
    });
  });
});

describe('Accounts verification boundary', () => {
  it('Sales never verifies; a verified profile refuses Sales edits; an Accounts edit resets verification (B11, B12, B14)', async () => {
    await asOwner(db, async () => {
      await h.setSwitch('service_items_enabled', true);
      await h.propose(OWNER, DEAL, 0, BUSINESS);
      expect(await profile()).toMatchObject([{ status: 'draft' }]);
      await one(ACCOUNTS, 'select public.accounts_billing_verify($1, $2, $3) as r', [DEAL, 1, rid()]);
      expect(await profile()).toMatchObject([{ status: 'verified' }]);
      await refused(OWNER, PROPOSE_SQL, [DEAL, 2, JSON.stringify({ ...BUSINESS, contactPerson: 'Someone Else' }), rid()], '55000', 'billing_verified');
      // Accounts may accept or edit; an edit (new keys included) returns the profile to draft.
      const edited = await one<{ status: string; rowVersion: number }>(ACCOUNTS, ACCOUNTS_BILLING_SQL,
        [DEAL, 2, JSON.stringify({ ...UNREGISTERED }), rid()]);
      expect(edited.status).toBe('draft');
      expect(await profile()).toMatchObject([{ status: 'draft', gst_status: 'unregistered', gstin: null }]);
      await refusedWithHint(ACCOUNTS, ACCOUNTS_BILLING_SQL, [DEAL, edited.rowVersion, JSON.stringify({ ...UNREGISTERED, gstReason: 'short' }), rid()],
        /^gstReason$/);
      // Audit: field names only.
      const audit = await owner<{ details: unknown }>(
        `select details from public.audit_events where action in ('booking.billing_proposed', 'finance.billing_saved') and target_id = $1`, [DEAL]);
      expect(JSON.stringify(audit)).not.toMatch(/Riya|example\.test|971501234567|08ABCDE|Synthetic small firm/);
    });
  });

  it('Bill To columns reach Accounts and booking editors only (B15)', async () => {
    await asOwner(db, async () => {
      await h.setSwitch('service_items_enabled', true);
      await h.readyForm();
      await h.propose(OWNER, DEAL, await rowVersion(), BUSINESS);
      const detail = await one<{ billing: Record<string, unknown> }>(ACCOUNTS, 'select public.accounts_deal_detail($1) as r', [DEAL]);
      expect(detail.billing).toMatchObject({ billToType: 'business', contactPerson: 'Riya Mehta', gstStatus: 'registered' });
      for (const actor of [PURCHASE, FLIGHT]) {
        await refused(actor, 'select bill_to_type from public.customer_billing_profiles', [], '42501');
        expect(await one(actor, 'select public.booking_form_get($1) as r', [DEAL])).toBeNull();
      }
      void TRIP;
      void PARTY;
    });
  });
});
