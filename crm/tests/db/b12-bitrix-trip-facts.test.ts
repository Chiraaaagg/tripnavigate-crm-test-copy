import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type Actor,
  FIXTURE_USERS as U,
  SYNTHETIC_INTAKE_CONFIG as CONFIG,
  type TestDb,
  asOwner,
  createTestDb,
  expectDbError,
  resetActor,
  setActor,
} from '../helpers/db';

/**
 * B1.2 (DEC-36), migration 20261120000400_b12_bitrix_trip_facts: read-only
 * Bitrix values (Booking Notes, Total Number of Travelers, Tour Start/End Date,
 * Customer Type, Contact/Company links) and linked Contact/Company basics.
 *
 * integration_apply_bitrix_trip_facts / integration_apply_bitrix_party run after
 * the Deal/Lead apply finished the same inbox row (service role only), write
 * nothing while bitrix_trip_facts_read is off, check every key, accept only the
 * applied version and a linked party, and audit field NAMES only.
 * authz.bitrix_prefill_json is the frozen read helper for the prefill landing.
 *
 * Synthetic values only (invented names, .test e-mails, 555 numbers). Every
 * case runs in a rolled-back transaction.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const SVC: Actor = { userId: null, role: 'service_role' };
const MEMBER = 'SYNTHETIC_MEMBER_0001';
const FACTS_SQL = 'select public.integration_apply_bitrix_trip_facts($1, $2::jsonb) as r';
const PARTY_SQL = 'select public.integration_apply_bitrix_party($1, $2::jsonb) as r';

interface Item {
  inboxId: string;
  lockToken: string;
}

async function run<T = Record<string, unknown>>(actor: Actor, sql: string, params: unknown[] = []): Promise<T[]> {
  await setActor(db, actor);
  const rows = await db.query<T>(sql, params);
  await resetActor(db);
  return rows;
}
async function one<T>(actor: Actor, sql: string, params: unknown[] = []): Promise<T> {
  return (await run<{ r: T }>(actor, sql, params))[0]!.r;
}
async function refused(actor: Actor, sql: string, params: unknown[], code: string, message?: RegExp): Promise<void> {
  await expectDbError(db, () => run(actor, sql, params), { code, message });
  await resetActor(db);
}

let ts = 1_831_000_000;
async function claimOne(inboxId: string): Promise<Item> {
  const rows = await run<{ r: Item }>(SVC, 'select r from public.integration_claim_inbox(100, 60) as r');
  const item = rows.map((x) => x.r).find((x) => x.inboxId === inboxId);
  if (!item) throw new Error('row was not claimed');
  return item;
}
async function importDeal(deal: Record<string, unknown>): Promise<{ inboxId: string; outcome: string; dealId: string | null }> {
  const rec = await one<{ inboxId: string }>(SVC, 'select public.integration_record_bitrix_event($1, $2, $3, $4) as r', [
    MEMBER, 'ONCRMDEALUPDATE', Number(deal.id), (ts += 1),
  ]);
  const item = await claimOne(rec.inboxId);
  const r = await one<{ outcome: string; dealId: string | null }>(SVC, 'select public.integration_apply_bitrix_deal($1, $2, $3::jsonb) as r', [
    item.inboxId, item.lockToken, JSON.stringify(deal),
  ]);
  return { ...r, inboxId: rec.inboxId };
}
async function importLead(lead: Record<string, unknown>): Promise<{ inboxId: string; outcome: string; leadId: string | null }> {
  const rec = await one<{ inboxId: string }>(SVC, 'select public.integration_record_bitrix_event($1, $2, $3, $4) as r', [
    MEMBER, 'ONCRMLEADUPDATE', Number(lead.id), (ts += 1),
  ]);
  const item = await claimOne(rec.inboxId);
  const r = await one<{ outcome: string; leadId: string | null }>(SVC, 'select public.integration_apply_bitrix_lead($1, $2, $3::jsonb) as r', [
    item.inboxId, item.lockToken, JSON.stringify(lead),
  ]);
  return { ...r, inboxId: rec.inboxId };
}

const MODIFIED = '2026-10-03T10:00:00+05:30';
const deal = (id: number, o: Record<string, unknown> = {}) => ({
  id: String(id),
  title: `Synthetic facts deal ${id}`,
  stageId: 'C7:NEW',
  categoryId: '7',
  assignedById: '101',
  dateCreate: '2026-10-02T09:00:00+05:30',
  dateModify: MODIFIED,
  leadId: '',
  ...o,
});
const lead = (id: number, o: Record<string, unknown> = {}) => ({
  id: String(id),
  title: `Synthetic facts lead ${id}`,
  statusId: 'NEW',
  sourceId: 'WEBFORM',
  assignedById: '101',
  dateCreate: '2026-10-02T09:00:00+05:30',
  dateModify: MODIFIED,
  ...o,
});
const dealFacts = (o: Record<string, unknown> = {}) => ({
  dateModify: MODIFIED,
  bookingNotes: 'Synthetic requirement: sea view, vegetarian meals',
  travellerTotal: 4,
  tourStart: '2026-11-20',
  tourEnd: '2026-11-25',
  customerTypeId: '5049',
  contactId: '9001',
  contactIds: ['9001', '9002'],
  companyId: '7001',
  issues: [],
  ...o,
});
const contact = (o: Record<string, unknown> = {}) => ({
  kind: 'contact',
  id: '9001',
  dateModify: '2026-10-01T08:00:00+05:30',
  name: 'Synthetic Traveller',
  phones: ['+91 55555 01234'],
  emails: ['synthetic.traveller@example.test'],
  ...o,
});
const company = (o: Record<string, unknown> = {}) => ({
  kind: 'company', id: '7001', dateModify: null, name: 'Synthetic Travel Co', phones: [], emails: ['desk@example.test'], ...o,
});

async function setup(): Promise<void> {
  await db.query(
    `update public.integration_intake_config
     set deal_intake_mode = 'scope', lead_intake_mode = 'scope', cutoff_at = '2026-10-01T00:00:00+05:30' where id = $1`,
    [CONFIG],
  );
}
const factsOn = () => db.query('update public.integration_intake_config set bitrix_trip_facts_read = true where id = $1', [CONFIG]);
const audits = (action: string) =>
  db.query<{ target_type: string; target_id: string; details: Record<string, unknown> }>(
    'select target_type, target_id, details from public.audit_events where action = $1 order by occurred_at, id',
    [action],
  );
const prefill = (kind: string, id: string) =>
  db.query<{ r: Record<string, unknown> }>('select authz.bitrix_prefill_json($1, $2) as r', [kind, id]).then((r) => r[0]!.r);

describe('switch off (default)', () => {
  it('stores nothing and the helper answers available = false', async () => {
    await asOwner(db, async () => {
      await setup();
      const d = await importDeal(deal(81001));
      expect(d.outcome).toBe('created');
      expect(await one(SVC, FACTS_SQL, [d.inboxId, JSON.stringify(dealFacts())])).toEqual({ outcome: 'switched_off', parties: [] });
      expect(await one(SVC, PARTY_SQL, [d.inboxId, JSON.stringify(contact())])).toEqual({ outcome: 'switched_off' });
      expect(await db.query('select * from public.deal_source_trip_facts')).toEqual([]);
      expect(await db.query('select * from public.bitrix_party_snapshots')).toEqual([]);
      const p = await prefill('deal', d.dealId!);
      expect(p).toMatchObject({ available: false, sourceModifiedAt: null });
      expect(p.fields).toMatchObject({ bookingNotes: null, contact: null, company: null });
    });
  });
});

describe('Deal facts with the switch on', () => {
  it('stores the facts, asks for the linked contact and company, and audits names only', async () => {
    await asOwner(db, async () => {
      await setup();
      await factsOn();
      const d = await importDeal(deal(81101));
      const r = await one(SVC, FACTS_SQL, [d.inboxId, JSON.stringify(dealFacts())]);
      expect(r).toEqual({ outcome: 'stored', parties: [{ kind: 'contact', id: '9001' }, { kind: 'company', id: '7001' }] });
      const [row] = await db.query<Record<string, unknown>>(
        `select booking_notes, traveller_total, tour_start::text, tour_end::text, customer_type_enum_id,
                source_contact_id::text, source_contact_ids::text, source_company_id::text, read_issues
         from public.deal_source_trip_facts where deal_id = $1`,
        [d.dealId],
      );
      expect(row).toEqual({
        booking_notes: 'Synthetic requirement: sea view, vegetarian meals', traveller_total: 4,
        tour_start: '2026-11-20', tour_end: '2026-11-25', customer_type_enum_id: '5049',
        source_contact_id: '9001', source_contact_ids: '{9001,9002}', source_company_id: '7001', read_issues: [],
      });
      expect(await one(SVC, PARTY_SQL, [d.inboxId, JSON.stringify(contact())])).toEqual({ outcome: 'stored' });
      expect(await one(SVC, PARTY_SQL, [d.inboxId, JSON.stringify(company())])).toEqual({ outcome: 'stored' });

      const [fa] = await audits('integration.trip_facts_stored');
      expect(fa).toMatchObject({ target_type: 'deal', target_id: d.dealId });
      expect(fa!.details).toEqual({
        inboxId: d.inboxId,
        fields: ['bookingNotes', 'travellerTotal', 'tourStart', 'tourEnd', 'customerType', 'contact', 'company', 'issues'],
        issues: [],
      });
      const pa = await audits('integration.party_snapshot_stored');
      expect(pa.map((a) => a.details)).toEqual([
        { inboxId: d.inboxId, partyKind: 'contact', fields: ['name', 'phones', 'emails'] },
        { inboxId: d.inboxId, partyKind: 'company', fields: ['name', 'phones', 'emails'] },
      ]);
      // No value appears in any audit row or in the inbox row.
      const everything = JSON.stringify(await db.query('select details from public.audit_events'))
        + JSON.stringify(await db.query('select * from public.integration_inbox'));
      for (const value of ['sea view', 'Synthetic Traveller', '55555', 'synthetic.traveller@example.test', 'desk@example.test', 'Synthetic Travel Co', '2026-11-20']) {
        expect(everything).not.toContain(value);
      }
    });
  });

  it('the prefill helper returns the frozen shape with the Customer Type label', async () => {
    await asOwner(db, async () => {
      await setup();
      await factsOn();
      const d = await importDeal(deal(81111));
      await one(SVC, FACTS_SQL, [d.inboxId, JSON.stringify(dealFacts())]);
      await one(SVC, PARTY_SQL, [d.inboxId, JSON.stringify(contact())]);
      await one(SVC, PARTY_SQL, [d.inboxId, JSON.stringify(company())]);
      const p = await prefill('deal', d.dealId!);
      expect(p).toMatchObject({ available: true, subjectKind: 'deal', issues: [] });
      expect(Date.parse(p.sourceModifiedAt as string)).toBe(Date.parse(MODIFIED));
      expect(p.fields).toEqual({
        bookingNotes: 'Synthetic requirement: sea view, vegetarian meals',
        travellerTotal: 4,
        tourStart: '2026-11-20',
        tourEnd: '2026-11-25',
        customerType: { enumId: '5049', code: 'corporate' },
        contact: { name: 'Synthetic Traveller', mobile: '+91 55555 01234', email: 'synthetic.traveller@example.test' },
        company: { name: 'Synthetic Travel Co', phone: null, email: 'desk@example.test' },
      });
      // Switch off again: the stored values are no longer offered.
      await db.query('update public.integration_intake_config set bitrix_trip_facts_read = false where id = $1', [CONFIG]);
      expect(await prefill('deal', d.dealId!)).toMatchObject({ available: false });
    });
  });

  it('an unknown Customer Type option reads as label null; empty values are stored as empty', async () => {
    await asOwner(db, async () => {
      await setup();
      await factsOn();
      const d = await importDeal(deal(81121));
      const empty = dealFacts({
        bookingNotes: null, travellerTotal: null, tourStart: null, tourEnd: null, customerTypeId: '4242',
        contactId: null, contactIds: [], companyId: null, issues: ['travellers_not_whole'],
      });
      expect(await one(SVC, FACTS_SQL, [d.inboxId, JSON.stringify(empty)])).toEqual({ outcome: 'stored', parties: [] });
      const p = await prefill('deal', d.dealId!);
      expect(p).toMatchObject({ available: true, issues: ['travellers_not_whole'] });
      expect(p.fields).toMatchObject({ customerType: { enumId: '4242', code: null }, contact: null, company: null, bookingNotes: null });
    });
  });

  it('a replay is unchanged and asks for no party that already has a snapshot', async () => {
    await asOwner(db, async () => {
      await setup();
      await factsOn();
      const d = await importDeal(deal(81131));
      await one(SVC, FACTS_SQL, [d.inboxId, JSON.stringify(dealFacts())]);
      await one(SVC, PARTY_SQL, [d.inboxId, JSON.stringify(contact())]);
      expect(await one(SVC, FACTS_SQL, [d.inboxId, JSON.stringify(dealFacts())])).toEqual({
        outcome: 'unchanged', parties: [{ kind: 'company', id: '7001' }],
      });
      expect(await one(SVC, PARTY_SQL, [d.inboxId, JSON.stringify(contact())])).toEqual({ outcome: 'unchanged' });
      expect(await audits('integration.trip_facts_stored')).toHaveLength(1);
      // An older contact answer never overwrites a newer snapshot.
      expect(await one(SVC, PARTY_SQL, [d.inboxId, JSON.stringify(contact({ dateModify: '2026-09-01T08:00:00+05:30', name: 'Older' }))])).toEqual({
        outcome: 'stale',
      });
    });
  });

  it('an unreadable Bitrix DATE_MODIFY keeps the values for the applied version with an issue code (E1-6)', async () => {
    await asOwner(db, async () => {
      await setup();
      await factsOn();
      const d = await importDeal(deal(81135));
      expect(await one(SVC, FACTS_SQL, [d.inboxId, JSON.stringify(dealFacts({ dateModify: null }))])).toMatchObject({ outcome: 'stored' });
      const [row] = await db.query<{ read_issues: string[]; m: string }>(
        'select read_issues, source_modified_at::text m from public.deal_source_trip_facts where deal_id = $1',
        [d.dealId],
      );
      expect(row!.read_issues).toEqual(['date_modify_unreadable']);
      expect((await prefill('deal', d.dealId!)).issues).toEqual(['date_modify_unreadable']);
    });
  });

  it('only the applied version is accepted; a newer Bitrix version replaces the facts', async () => {
    await asOwner(db, async () => {
      await setup();
      await factsOn();
      const d = await importDeal(deal(81141));
      expect(await one(SVC, FACTS_SQL, [d.inboxId, JSON.stringify(dealFacts({ dateModify: '2026-10-03T11:00:00+05:30' }))])).toEqual({
        outcome: 'stale', parties: [],
      });
      await one(SVC, FACTS_SQL, [d.inboxId, JSON.stringify(dealFacts())]);
      const newer = '2026-10-04T10:00:00+05:30';
      const d2 = await importDeal(deal(81141, { dateModify: newer }));
      expect(d2.outcome).toBe('updated');
      expect(await one(SVC, FACTS_SQL, [d2.inboxId, JSON.stringify(dealFacts({ dateModify: newer, travellerTotal: 5, contactId: '9003', contactIds: ['9003'] }))])).toEqual({
        outcome: 'stored', parties: [{ kind: 'contact', id: '9003' }, { kind: 'company', id: '7001' }],
      });
      // The first row's facts are now older than the stored ones.
      expect(await one(SVC, FACTS_SQL, [d.inboxId, JSON.stringify(dealFacts())])).toEqual({ outcome: 'stale', parties: [] });
      // A party no longer linked is refused.
      await refused(SVC, PARTY_SQL, [d2.inboxId, JSON.stringify(contact())], '22023', /^not_linked$/);
    });
  });

  it('an inbox row that stored nothing is not applicable', async () => {
    await asOwner(db, async () => {
      await setup();
      await factsOn();
      const ignored = await importDeal(deal(81151, { stageId: 'C7:WON' }));
      expect(ignored.outcome).toBe('ignored');
      expect(await one(SVC, FACTS_SQL, [ignored.inboxId, JSON.stringify(dealFacts())])).toEqual({ outcome: 'not_applicable', parties: [] });
    });
  });

  it('refuses unknown keys and out-of-shape values with codes only', async () => {
    await asOwner(db, async () => {
      await setup();
      await factsOn();
      const d = await importDeal(deal(81161));
      const bad: Array<[Record<string, unknown>, string]> = [
        [{ ...dealFacts(), passport: 'X' }, 'facts'],
        [{ ...dealFacts(), companyTitle: 'Leads only' }, 'facts'],
        [dealFacts({ travellerTotal: 101 }), 'travellerTotal'],
        [dealFacts({ travellerTotal: 2.5 }), 'travellerTotal'],
        [dealFacts({ tourStart: '2026-02-30' }), 'facts'],
        [dealFacts({ tourEnd: '20-11-2026' }), 'tourEnd'],
        [dealFacts({ bookingNotes: 'x'.repeat(4001) }), 'bookingNotes'],
        [dealFacts({ bookingNotes: 'bell\u0007' }), 'bookingNotes'],
        [dealFacts({ customerTypeId: 'B2D' }), 'customerTypeId'],
        [dealFacts({ contactIds: ['0'] }), 'contactIds'],
        [dealFacts({ issues: ['passport_seen'] }), 'issues'],
        [dealFacts({ dateModify: 'yesterday' }), 'dateModify'],
      ];
      for (const [facts] of bad) {
        await refused(SVC, FACTS_SQL, [d.inboxId, JSON.stringify(facts)], '22023', /^invalid_input$/);
      }
      await one(SVC, FACTS_SQL, [d.inboxId, JSON.stringify(dealFacts())]);
      for (const party of [
        { ...contact(), address: 'X' },
        contact({ kind: 'person' }),
        contact({ phones: ['call me'] }),
        contact({ emails: ['not-an-email'] }),
        contact({ phones: ['1111', '2222', '3333', '4444', '5555', '6666'] }),
        contact({ name: 'x'.repeat(201) }),
      ]) {
        await refused(SVC, PARTY_SQL, [d.inboxId, JSON.stringify(party)], '22023', /^invalid_input$/);
      }
      expect(await db.query('select * from public.bitrix_party_snapshots')).toEqual([]);
    });
  });
});

describe('Lead facts', () => {
  it('stores the Lead keys only; Leads have no Booking Notes, travellers or tour dates', async () => {
    await asOwner(db, async () => {
      await setup();
      await factsOn();
      const l = await importLead(lead(82001));
      expect(l.outcome).toBe('created');
      const leadFacts = {
        dateModify: MODIFIED, customerTypeId: '1353', contactId: null, contactIds: [], companyId: null,
        companyTitle: 'Synthetic Agency', issues: [],
      };
      await refused(SVC, FACTS_SQL, [l.inboxId, JSON.stringify({ ...leadFacts, bookingNotes: 'x' })], '22023', /^invalid_input$/);
      expect(await one(SVC, FACTS_SQL, [l.inboxId, JSON.stringify(leadFacts)])).toEqual({ outcome: 'stored', parties: [] });
      const [fa] = await audits('integration.trip_facts_stored');
      expect(fa).toMatchObject({ target_type: 'crm_lead', target_id: l.leadId });
      const p = await prefill('lead', l.leadId!);
      expect(p).toMatchObject({ available: true, subjectKind: 'lead' });
      expect(p.fields).toEqual({
        bookingNotes: null, travellerTotal: null, tourStart: null, tourEnd: null,
        customerType: { enumId: '1353', code: 'b2d' },
        contact: null,
        company: { name: 'Synthetic Agency', phone: null, email: null },
      });
    });
  });
});

describe('access', () => {
  it('no API role reads the tables; only the service role runs the commands; nobody calls the helper directly', async () => {
    await asOwner(db, async () => {
      await setup();
      await factsOn();
      const d = await importDeal(deal(81201));
      await one(SVC, FACTS_SQL, [d.inboxId, JSON.stringify(dealFacts())]);
      for (const actor of [{ userId: U.salesDelhiA }, { userId: U.managerDelhi }, { userId: U.adminJodhpur }, { userId: U.purchaseJodhpur }]) {
        for (const table of ['deal_source_trip_facts', 'lead_source_facts', 'bitrix_party_snapshots', 'bitrix_customer_type_options']) {
          await refused(actor, `select * from public.${table}`, [], '42501');
        }
        await refused(actor, FACTS_SQL, [d.inboxId, JSON.stringify(dealFacts())], '42501');
        await refused(actor, PARTY_SQL, [d.inboxId, JSON.stringify(contact())], '42501');
        await refused(actor, `select authz.bitrix_prefill_json('deal', $1)`, [d.dealId], '42501');
      }
      await refused(SVC, `select authz.bitrix_prefill_json('deal', $1)`, [d.dealId], '42501');
      await refused(SVC, 'select * from public.deal_source_trip_facts', [], '42501');
      const [rls] = await db.query<{ n: number }>(
        `select count(*)::int n from pg_class where relname in ('deal_source_trip_facts', 'lead_source_facts', 'bitrix_party_snapshots',
           'bitrix_customer_type_options') and relrowsecurity`,
      );
      expect(rls!.n).toBe(4);
    });
  });
});
