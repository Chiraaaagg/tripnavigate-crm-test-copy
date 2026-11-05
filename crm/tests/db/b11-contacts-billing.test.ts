import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, asOwner, createTestDb } from '../helpers/db';
import { ACCOUNTS, DEAL, DEAL2, FLIGHT, MANAGER, OWNER, PURCHASE, SALES_B } from './b1-support';
import { BILLING, CONTACT, CONTACTS_SQL, CUSTOMER_SQL, PROPOSE_SQL, b11Helpers, rid } from './b11-support';

/**
 * B1.1a customer step (migration 20261119000100): booking contacts on the
 * package version, the Sales billing proposal on the Accounts record, and the
 * one-transaction customer save (freeze note 3.1).
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = b11Helpers(() => db);
const { one, refused, refusedWithHint, owner, setSwitch, openDraft, saveContacts, propose, draftWithTravellers } = h;

describe('booking_contacts_save', () => {
  it('stores the contact, records who confirmed the channel and resets confirmation when the channel changes', async () => {
    await asOwner(db, async () => {
      const d = await draftWithTravellers();
      const saved = await saveContacts(OWNER, d.versionId, d.rowVersion);
      expect(saved.rowVersion).toBe(d.rowVersion + 1);
      const [row] = await owner<{ mobile: string; email: string; contact_confirmed: boolean; confirmed_by: string; confirmed_at: string }>(
        'select mobile, email, contact_confirmed, confirmed_by, confirmed_at::text from public.booking_version_contacts where booking_version_id = $1', [d.versionId]);
      expect(row).toMatchObject({ mobile: '9876500011', email: 'contact@example.test', contact_confirmed: true, confirmed_by: OWNER.userId });
      // Same channel, saved again by the Manager: the original confirmation stays.
      const again = await saveContacts(MANAGER, d.versionId, saved.rowVersion, { ...CONTACT, contactName: 'Synthetic Contact Two' });
      const [kept] = await owner<{ confirmed_by: string; confirmed_at: string }>(
        'select confirmed_by, confirmed_at::text from public.booking_version_contacts where booking_version_id = $1', [d.versionId]);
      expect(kept).toEqual({ confirmed_by: OWNER.userId, confirmed_at: row!.confirmed_at });
      // A new mobile number is confirmed afresh by whoever saves it.
      const changed = await saveContacts(MANAGER, d.versionId, again.rowVersion, { ...CONTACT, mobile: '9876500099' });
      const [fresh] = await owner<{ confirmed_by: string }>('select confirmed_by from public.booking_version_contacts where booking_version_id = $1', [d.versionId]);
      expect(fresh!.confirmed_by).toBe(MANAGER.userId);
      // Unticked: no confirmation.
      await saveContacts(OWNER, d.versionId, changed.rowVersion, { ...CONTACT, contactConfirmed: false });
      expect(await owner('select contact_confirmed, confirmed_by from public.booking_version_contacts where booking_version_id = $1', [d.versionId]))
        .toEqual([{ contact_confirmed: false, confirmed_by: null }]);
      // Audit: field names only, never the values.
      const audit = await owner<{ details: Record<string, unknown> }>(
        `select details from public.audit_events where action = 'booking.contacts_saved' and target_id = $1 order by id`, [d.versionId]);
      expect(audit).toHaveLength(4);
      expect(JSON.stringify(audit)).not.toMatch(/9876500|example\.test|Synthetic Contact/);
    });
  });

  it('validates every field and names the bad ones', async () => {
    await asOwner(db, async () => {
      const d = await draftWithTravellers();
      const cases: Array<[unknown, RegExp]> = [
        [{ ...CONTACT, mobile: '12345', email: null }, /mobile/],
        [{ ...CONTACT, mobile: null, email: null }, /^mobile,email$/],
        [{ ...CONTACT, email: 'not-an-email' }, /^email$/],
        [{ ...CONTACT, contactName: '' }, /^contactName$/],
        [{ ...CONTACT, bookingFor: 'family' }, /^bookingFor$/],
        [{ ...CONTACT, payerDifferent: true, payerName: null }, /^payerName$/],
        [{ ...CONTACT, contactConfirmed: 'yes' }, /^contactConfirmed$/],
        [{ ...CONTACT, sellingTotal: 5 }, /^sellingTotal$/],
      ];
      for (const [fields, hint] of cases) {
        await refusedWithHint(OWNER, CONTACTS_SQL, [d.versionId, d.rowVersion, JSON.stringify(fields)], hint);
      }
      // Mobile only (spaces stripped) and a different payer are fine.
      await saveContacts(OWNER, d.versionId, d.rowVersion, { ...CONTACT, mobile: '98765 00011', email: null, payerDifferent: true, payerName: 'Synthetic Payer' });
      expect(await owner('select mobile, email, payer_name from public.booking_version_contacts where booking_version_id = $1', [d.versionId]))
        .toEqual([{ mobile: '9876500011', email: null, payer_name: 'Synthetic Payer' }]);
    });
  });

  it('refuses other people, stale row versions, the switch off and hotel versions', async () => {
    await asOwner(db, async () => {
      const d = await draftWithTravellers();
      await refused(OWNER, CONTACTS_SQL, [d.versionId, d.rowVersion + 5, JSON.stringify(CONTACT)], '40001', 'version_changed');
      for (const actor of [SALES_B, PURCHASE, ACCOUNTS, FLIGHT]) {
        await refused(actor, CONTACTS_SQL, [d.versionId, d.rowVersion, JSON.stringify(CONTACT)], '42501', 'not_authorized');
      }
      await setSwitch('service_items_enabled', false);
      await refused(OWNER, CONTACTS_SQL, [d.versionId, d.rowVersion, JSON.stringify(CONTACT)], '55000', 'service_items_disabled');
      const hotel = await openDraft(SALES_B, DEAL2); // switch off: a hotel draft
      await setSwitch('service_items_enabled', true);
      await refusedWithHint(SALES_B, CONTACTS_SQL, [hotel.versionId, hotel.rowVersion, JSON.stringify(CONTACT)], /^version$/);
    });
  });
});

describe('booking_billing_propose', () => {
  it('creates and updates the draft billing record as a Sales proposal; exact retry replays; Accounts verifies; verified is refused', async () => {
    await asOwner(db, async () => {
      await setSwitch('service_items_enabled', true);
      const req = rid();
      const created = await propose(OWNER, DEAL, 0, BILLING, req);
      expect(created).toEqual({ outcome: 'created', status: 'draft', rowVersion: 1 });
      expect(await propose(OWNER, DEAL, 0, BILLING, req)).toEqual({ outcome: 'existing', status: 'draft', rowVersion: 1 });
      await refused(OWNER, PROPOSE_SQL, [DEAL, 0, JSON.stringify({ ...BILLING, city: 'Delhi' }), req], '40001', 'request_conflict');
      expect(await owner('select prefill_source, status, updated_by from public.customer_billing_profiles where deal_id = $1', [DEAL]))
        .toEqual([{ prefill_source: 'sales', status: 'draft', updated_by: OWNER.userId }]);
      await refused(OWNER, PROPOSE_SQL, [DEAL, 0, JSON.stringify(BILLING), rid()], '40001', 'version_changed');
      const updated = await propose(MANAGER, DEAL, 1, { ...BILLING, gstin: '08ABCDE1234F1Z5' });
      expect(updated).toEqual({ outcome: 'updated', status: 'draft', rowVersion: 2 });
      await refusedWithHint(OWNER, PROPOSE_SQL, [DEAL, 2, JSON.stringify({ ...BILLING, gstin: '07ABCDE1234F1Z5' }), rid()], /^gstin$/);
      await refusedWithHint(OWNER, PROPOSE_SQL, [DEAL, 2, JSON.stringify({ ...BILLING, postalCode: '012345' }), rid()], /^postalCode$/);
      // Accounts verifies the proposal unchanged (existing command); Sales can no longer overwrite it.
      await owner(`update public.customer_billing_profiles set status = 'verified', verified_by = $2, verified_at = now(), row_version = row_version + 1 where deal_id = $1`,
        [DEAL, ACCOUNTS.userId]);
      await refused(OWNER, PROPOSE_SQL, [DEAL, 3, JSON.stringify(BILLING), rid()], '55000', 'billing_verified');
      const audit = await owner<{ details: Record<string, unknown> }>(
        `select details from public.audit_events where action = 'booking.billing_proposed' and target_id = $1 order by id`, [DEAL]);
      expect(audit).toHaveLength(2);
      expect(JSON.stringify(audit)).not.toMatch(/Synthetic Road|342001/);
    });
  });

  it('only booking editors propose; Purchase, Accounts and other owners are refused', async () => {
    await asOwner(db, async () => {
      await setSwitch('service_items_enabled', true);
      for (const actor of [SALES_B, PURCHASE, ACCOUNTS, FLIGHT]) {
        await refused(actor, PROPOSE_SQL, [DEAL, 0, JSON.stringify(BILLING), rid()], '42501', 'not_authorized');
      }
      await setSwitch('service_items_enabled', false);
      await refused(OWNER, PROPOSE_SQL, [DEAL, 0, JSON.stringify(BILLING), rid()], '55000', 'service_items_disabled');
    });
  });
});

describe('booking_customer_save', () => {
  it('an exact retry after a committed step returns the stored result (review A2); another payload is request_conflict', async () => {
    await asOwner(db, async () => {
      const d = await draftWithTravellers();
      const req = rid();
      const args = [d.versionId, d.rowVersion, JSON.stringify(CONTACT), JSON.stringify(BILLING), 0, req];
      const first = await one<Record<string, unknown>>(OWNER, CUSTOMER_SQL, args);
      const retry = await one<Record<string, unknown>>(OWNER, CUSTOMER_SQL, args);
      expect(retry).toEqual({ ...first, outcome: 'existing' });
      await refused(OWNER, CUSTOMER_SQL, [d.versionId, d.rowVersion, JSON.stringify({ ...CONTACT, contactName: 'Synthetic Else' }), JSON.stringify(BILLING), 0, req],
        '40001', 'request_conflict');
      await refused(MANAGER, CUSTOMER_SQL, args, '40001', 'request_conflict');
      // Billing without a request id is refused.
      await refusedWithHint(OWNER, CUSTOMER_SQL, [d.versionId, first.rowVersion, JSON.stringify(CONTACT), JSON.stringify(BILLING), 1, null], /^requestId$/);
      expect(await owner('select count(*)::int as n from public.audit_events where action = $1', ['booking.contacts_saved'])).toEqual([{ n: 1 }]);
    });
  });

  it('saves contacts and the billing proposal together; any refusal refuses both', async () => {
    await asOwner(db, async () => {
      const d = await draftWithTravellers();
      // A bad billing field refuses the whole step: no contact row either.
      await refusedWithHint(OWNER, CUSTOMER_SQL, [d.versionId, d.rowVersion, JSON.stringify(CONTACT), JSON.stringify({ ...BILLING, stateCode: '99' }), 0, rid()], /^stateCode$/);
      expect(await owner('select 1 from public.booking_version_contacts where booking_version_id = $1', [d.versionId])).toEqual([]);
      const saved = await one<{ rowVersion: number; contentHash: string; billing: Record<string, unknown> }>(OWNER, CUSTOMER_SQL,
        [d.versionId, d.rowVersion, JSON.stringify(CONTACT), JSON.stringify(BILLING), 0, rid()]);
      expect(saved).toMatchObject({ rowVersion: d.rowVersion + 1, billing: { outcome: 'created', status: 'draft', rowVersion: 1 } });
      // Contacts only (billing null).
      const contactOnly = await one<{ rowVersion: number; billing: unknown }>(OWNER, CUSTOMER_SQL,
        [d.versionId, saved.rowVersion, JSON.stringify(CONTACT), null, null, null]);
      expect(contactOnly).toMatchObject({ rowVersion: saved.rowVersion + 1, billing: null });
      // A stale billing row version refuses both; the contact name did not change.
      await refused(OWNER, CUSTOMER_SQL, [d.versionId, contactOnly.rowVersion, JSON.stringify({ ...CONTACT, contactName: 'Synthetic Other' }),
        JSON.stringify(BILLING), 0, rid()], '40001', 'version_changed');
      expect(await owner('select contact_name from public.booking_version_contacts where booking_version_id = $1', [d.versionId]))
        .toEqual([{ contact_name: 'Synthetic Contact' }]);
    });
  });
});
