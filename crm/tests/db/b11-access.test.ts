import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, asOwner, createTestDb, resetActor, setActor } from '../helpers/db';
import {
  ACCOUNTS, ANON, DEAL, FLIGHT, FLIGHT_FACTS, FLIGHT_GET_SQL, FLIGHT_LIST_SQL, HOTEL, MANAGER, OWNER, PURCHASE, PURCHASE_GET_SQL,
  PURCHASE_LIST_SQL, SALES_B, SERVICES_SQL, SUPER, allKeys,
} from './b1-support';
import { FORM_SQL, b11Helpers } from './b11-support';

/**
 * B1.1a access (migration 20261119000100): who reads booking_form_get,
 * contacts, billing, prices, the plan and identity data. Purchase, Flight,
 * the Visa desk, Accounts-only and Super Admin never receive selling price,
 * list price, discount, plan, contacts, billing or identity data (contract
 * section 5); department details list only their item's participants.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = b11Helpers(() => db);
const { one, owner, readyDraft, confirm, addFlight } = h;

const SECRET = /sellingTotal|listPrice|discount|^plan$|instalment|contact|mobile|email|billing|gstin|dateOfBirth|nationality|passport|payer/i;
const VALUES = /9876543|9876500011|contact@example\.test|1 Synthetic Road|Z100000|1990-05-17/;

describe('booking_form_get', () => {
  it('editors and acceptors read the whole form; commercial keys only with deal.read_commercial; everyone else gets null', async () => {
    await asOwner(db, async () => {
      const ready = await readyDraft(OWNER, DEAL, [['hotel', HOTEL]], { identities: true });
      const full = await one<Record<string, unknown>>(OWNER, FORM_SQL, [DEAL]);
      expect(full).toMatchObject({
        dealId: DEAL, canEdit: true, canConfirm: true, serviceItemsEnabled: true, visaPassportTasksEnabled: false,
        version: { versionId: ready.versionId, status: 'draft', updatedByName: 'Synthetic Sales Delhi A' },
        trip: { destination: 'Synthetic City, Rajasthan', scope: 'domestic', start: '2026-12-10', end: '2026-12-13' },
        contacts: { contactName: 'Synthetic Contact', mobile: '9876500011', contactConfirmed: true, confirmedByName: 'Synthetic Sales Delhi A' },
        billing: { status: 'draft', prefillSource: 'sales', rowVersion: 1, postalCode: '342001' },
        commercials: { sellingTotalPaise: '9876543', listPricePaise: null, discountPaise: null },
        plan: [{ seq: 1, label: 'Full payment', amountPaise: '9876543', dueDate: '2026-11-01' }],
      });
      const travellers = full.travellers as Array<Record<string, unknown>>;
      expect(travellers).toHaveLength(4);
      expect(travellers[0]).toMatchObject({ seq: 1, identity: { dateOfBirth: '1990-05-17', passportNumber: 'Z1000001', rowVersion: 1 } });
      expect(typeof travellers[0]!.travellerId).toBe('string');
      expect((full.items as Array<Record<string, unknown>>)[0]).toMatchObject({ serviceType: 'hotel', participants: [1, 2, 3, 4] });
      expect(full.canEditCommercials).toBe(true);
      // The branch Manager edits but has no commercial scope on this Deal (fixtures): no price or plan keys.
      const manager = await one<Record<string, unknown>>(MANAGER, FORM_SQL, [DEAL]);
      expect(manager).toMatchObject({ canEdit: true, canEditCommercials: false, contacts: { contactName: 'Synthetic Contact' } });
      // Review A3: the checklist reads "ask the owner" for price and plan without commercial scope.
      await owner('delete from public.booking_version_instalments where booking_version_id = $1', [ready.versionId]);
      const codes = async (actor: typeof OWNER) =>
        (await one<{ items: Array<{ code: string }> }>(actor, 'select public.intake_checklist($1) as r', [DEAL])).items.map((i) => i.code);
      expect(await codes(OWNER)).toContain('plan_missing');
      expect(await codes(MANAGER)).toContain('plan_ask_owner');
      expect(await codes(MANAGER)).not.toContain('plan_missing');
      expect(manager).not.toHaveProperty('commercials');
      expect(manager).not.toHaveProperty('plan');
      await addFlight();
      for (const actor of [SALES_B, PURCHASE, ACCOUNTS, FLIGHT, SUPER]) {
        expect(await one(actor, FORM_SQL, [DEAL])).toBeNull();
      }
      await h.refused(ANON, FORM_SQL, [DEAL], '42501');
    });
  });
});

describe('department and Accounts reads', () => {
  it('deal_services, task lists and details carry no price, plan, contacts, billing or identity for Purchase and Flight', async () => {
    await asOwner(db, async () => {
      await addFlight();
      const ready = await readyDraft(OWNER, DEAL, [['hotel', HOTEL], ['flight', FLIGHT_FACTS]], { identities: true, scope: 'international' });
      expect(ready.issues).toEqual([]);
      const { taskIds } = await confirm(OWNER, ready.versionId, ready.hash);
      const payloads: unknown[] = [
        await one(PURCHASE, SERVICES_SQL, [DEAL]),
        await one(PURCHASE, PURCHASE_LIST_SQL),
        await one(PURCHASE, PURCHASE_GET_SQL, [taskIds![0]]),
        await one(FLIGHT, SERVICES_SQL, [DEAL]),
        await one(FLIGHT, FLIGHT_LIST_SQL),
        await one(FLIGHT, FLIGHT_GET_SQL, [taskIds![1]]),
      ];
      for (const p of payloads) {
        expect([...allKeys(p)].filter((k) => SECRET.test(k))).toEqual([]);
        expect(JSON.stringify(p)).not.toMatch(VALUES);
      }
      // Department details list the item's participants (names, type, age, needs).
      const detail = await one<{ participants: Array<Record<string, unknown>> }>(PURCHASE, PURCHASE_GET_SQL, [taskIds![0]]);
      expect(detail.participants.map((p) => p.seq)).toEqual([1, 2, 3, 4]);
      // The Flight assignee on an international trip sees identity of the flight's participants; nobody else does.
      await one(FLIGHT, 'select public.flight_task_claim($1) as r', [taskIds![1]]);
      const assigned = await one<{ participants: Array<Record<string, unknown>>; tripScope: string }>(FLIGHT, FLIGHT_GET_SQL, [taskIds![1]]);
      expect(assigned.tripScope).toBe('international');
      expect(assigned.participants[0]).toMatchObject({ seq: 1, dateOfBirth: '1990-05-17', passportNumber: 'Z1000001' });
      // Assigned Flight person: deal_services stays department-scoped (no travellers, no contacts).
      const services = await one<Record<string, unknown>>(FLIGHT, SERVICES_SQL, [DEAL]);
      expect(services).not.toHaveProperty('travellers');
    });
  });

  it('contacts, participation and instalments through the Data API: booking readers only; never Purchase, Flight, Visa or anon', async () => {
    await asOwner(db, async () => {
      await addFlight();
      const ready = await readyDraft(OWNER, DEAL, [['hotel', HOTEL]]);
      await confirm(OWNER, ready.versionId, ready.hash);
      await one(FLIGHT, 'select 1 as r'); // FLIGHT also holds the visa role (fixture)
      const count = async (actor: typeof OWNER, table: string) => {
        await setActor(db, actor);
        try {
          return (await db.query(`select 1 from public.${table}`)).length;
        } finally {
          await resetActor(db);
        }
      };
      for (const table of ['booking_version_contacts', 'service_item_travellers', 'booking_version_instalments']) {
        expect(await count(OWNER, table), table).toBeGreaterThan(0);
        expect(await count(PURCHASE, table), table).toBe(0);
        expect(await count(SALES_B, table), table).toBe(0);
        expect(await count(SUPER, table), table).toBe(0);
      }
      // A Visa role holder assigned to the Deal reads no service rows (department roles are excluded).
      await owner(`delete from public.memberships where user_id = $1 and role_code = 'flight'`, [FLIGHT.userId]);
      await owner(`insert into public.deal_assignments (deal_id, legal_entity_id, user_id, assignment_kind, assigned_by)
        select id, legal_entity_id, $2, 'visa', $3 from public.deals where id = $1`, [DEAL, FLIGHT.userId, SUPER.userId]);
      expect(await count(FLIGHT, 'booking_version_contacts')).toBe(0);
      expect(await count(FLIGHT, 'deal_travellers')).toBe(0);
      expect(await owner('select 1 from public.booking_version_contacts')).toHaveLength(1);
    });
  });
});
