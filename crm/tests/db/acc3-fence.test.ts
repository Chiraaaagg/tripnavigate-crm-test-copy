import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Actor, type TestDb, asOwner, createTestDb, resetActor } from '../helpers/db';
import { CONTACT, FLIGHT_ITEM, HOTEL_ITEM, PAST_HOTEL_ITEM, PAST_TRIP, SELLING, SALES_B, dayFrom } from './acc-support';
import {
  ACC, DEAL, MANAGER, MANAGER_F, OWNER, PURCHASE, REASON, SQL3, SUPER, U, VISA_J2, FLIGHT_J, WORKER, acc3Helpers, asItems, rid, text, today, trackLanded,
} from './acc3-support';
import { SQLB, relbHelpers } from './acc3-relb-support';

/**
 * Accounts phase 3, Track T — contract 16.1 "Fence leak" (section 14):
 * every new read as A, A+P, M, M+F, SO, other Sales, P, F, V and SA with
 * sentinel values (selling total, write-off amount, customer mobile and
 * e-mail, contract rate, refund amount, PNR); then a JSON scan of notices,
 * audit details, push payloads, Tally left-out lists and error messages.
 * "Never" = the read answers null (never a partial object).
 *
 * Actors: A = Accounts Jodhpur; A+P = Accounts Jodhpur 2 + Purchase; M =
 * Manager Delhi (the Deal's branch); M+F = Manager Flight Delhi (Manager +
 * Flight); SO = Sales Delhi A; other Sales = Sales Delhi B; P = Purchase
 * Jodhpur; F = Flight Jodhpur; V = Visa Jodhpur 2; SA = Admin Jodhpur.
 */

/** Period start inside the 366-day Tally file cap (Addendum L5): 300 days before today (India time). */
const FROM = dayFrom(-300);
let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = acc3Helpers(() => db);
const g = relbHelpers(() => db);
const { one, owner } = h;
const A_P: Actor = { userId: '' };
const SENT = {
  selling: SELLING,
  writeOff: '30001',
  refund: '43219',
  contractRate: '777123',
  pnr: 'SYNPNR',
  mobile: '6000077777',
  email: 'sentinel.customer@example.test',
} as const;
type Who = 'A' | 'A+P' | 'M' | 'M+F' | 'SO' | 'S2' | 'P' | 'F' | 'V' | 'SA';
const ACTORS = (): Record<Who, Actor> => ({ A: ACC, 'A+P': A_P, M: MANAGER, 'M+F': MANAGER_F, SO: OWNER, S2: SALES_B, P: PURCHASE, F: FLIGHT_J,
  V: VISA_J2, SA: SUPER });

/** Reads null for every role not listed in `readers` (roles in `skip` are not asserted: section 14 says "—"). */
async function fence(label: string, sql: string, params: unknown[], readers: Who[], skip: Who[] = []) {
  const actors = ACTORS();
  const out: Partial<Record<Who, unknown>> = {};
  for (const who of Object.keys(actors) as Who[]) {
    if (skip.includes(who)) continue;
    const r = await h.attempt(actors[who], sql, params);
    const value = r.ok ? r.value : null;
    if (readers.includes(who)) expect(value, `${label}: ${who} reads`).not.toBeNull();
    else {
      expect(value, `${label}: ${who} gets null`).toBeNull();
      // A refusal is acceptable instead of null for commands; its message never carries a sentinel.
      if (!r.ok) for (const s of Object.values(SENT)) expect(r.error, `${label}: ${who} error`).not.toContain(s);
    }
    out[who] = value;
  }
  return out;
}

/** The Release A world on DEAL: booking (selling SENT.selling), contact overridden to the sentinels, messages, docs, Tally, push. */
async function world() {
  await h.people();
  A_P.userId = U.accountsJodhpur;
  await h.addRole(U.purchaseJodhpur, 'accounts');
  A_P.userId = U.purchaseJodhpur;
  await h.noticesOn();
  await h.docsOn();
  await h.autoBills(true, true);
  await h.messagesOn();
  await h.writeOffOn(true);
  await h.tallyXmlOn(true);
  const b = await h.book([PAST_HOTEL_ITEM, FLIGHT_ITEM], { trip: { start: PAST_TRIP.start, end: PAST_TRIP.end } });
  await h.approveReal(b.versionId);
  await h.prefsSet({ whatsappMobile: SENT.mobile, whatsappSameAsMobile: false, emailOverride: SENT.email });
  const receipt = await h.receipt(DEAL, String(Number(SELLING) - Number(SENT.writeOff)));
  const wo = await one<{ writeOffId: string }>(ACC, SQL3.woPropose, [DEAL, JSON.stringify({ direction: 'due', amountPaise: SENT.writeOff, reason: REASON }), rid()]);
  // The Deal stays synthetic (finance reads refuse a non-synthetic Deal in the test environment): message rows are
  // skipped test_deal but still carry the sentinel amounts in params, which no read may return.
  await h.enqueue(DEAL, 'payment_received', 'receipt:fence', { customerName: 'S', dealReference: 'SYN-DEL-001', amountPaise: SENT.refund,
    balancePaise: SENT.writeOff });
  return { b, receipt, wo };
}

describe('Release A reads (section 14)', () => {
  it('messages card, task send state, admin view, bills, small balances, monthly totals, Tally file reads', async () => {
    await asOwner(db, async () => {
      const { b } = await world();
      const hotelTask = h.taskOf(b, 'hotel');
      const before = await h.lastAuditId();
      const card = await fence('R-A1 deal_customer_messages', SQL3.dealMessages, [DEAL], ['A', 'M', 'SO'], ['SA']);
      for (const who of ['A', 'M', 'SO'] as Who[]) {
        const t = text(card[who]);
        for (const s of [SENT.mobile, SENT.email, SENT.refund, CONTACT.mobile]) expect(t, `card ${who}`).not.toContain(s);
      }
      await fence('R-A2 admin_customer_messages', SQL3.adminMessages, [await h.entityId()], ['SA']);
      // R-A3: the task's own department only (Purchase for a hotel task).
      await fence('R-A3 task_customer_message_status', SQL3.taskMessageStatus, [hotelTask], ['P'], ['A+P']);
      const docs = await fence('deal_customer_documents', SQL3.dealDocs, [DEAL], ['A', 'M', 'SO'], ['SA']);
      for (const who of ['M', 'SO'] as Who[]) expect(text(docs[who])).not.toContain('"status":"draft"');
      await fence('R-B1 small_balances_list', SQL3.smallBalances, ['{}', null, 50], ['A', 'M'], ['SA']);
      const month = `${today().slice(0, 7)}-01`;
      await fence('R-B2 write_off_monthly', SQL3.woMonthly, [month], ['M', 'SA'], ['A']);
      const dues = await fence('deal_dues', SQL3.dealDues, [DEAL], ['A', 'M', 'SO'], ['SA']);
      expect(text(dues.SO)).toContain('writeOff');
      const entity = await h.entityId();
      await fence('R-C2 accounts_tally_file_preview', SQL3.filePreview, [entity, FROM, today(), null, null], ['A'], ['SA']);
      await fence('R-C1 accounts_tally_exports', SQL3.exports, [50], ['A'], ['SA']);
      // Reading is never audited (17.3).
      expect((await h.auditsSince(before)).filter((a) => !a.action.startsWith('settings.'))).toEqual([]);
    });
  });

  it.skipIf(!trackLanded('40'))('push devices: own only; keys and endpoints never returned', async () => {
    await asOwner(db, async () => {
      await h.people();
      await one(SUPER, SQL3.setPush, [true, REASON]);
      const endpoint = 'https://push.example.test/fence/1';
      await one(ACC, SQL3.pushRegister, [endpoint, `B${'A'.repeat(86)}`, 'Z'.repeat(22), 'Chrome on Windows', rid()]);
      const actors = ACTORS();
      for (const who of ['A', 'M', 'SO', 'P', 'F', 'V'] as Who[]) {
        const list = await one<{ devices: unknown[] }>(actors[who], SQL3.pushList, []);
        expect(list, who).not.toBeNull();
        expect(list.devices.length, `${who} sees own devices only`).toBe(who === 'A' ? 1 : 0);
        expect(text(list)).not.toContain(endpoint);
        expect(text(list)).not.toContain('Z'.repeat(22));
      }
    });
  });
});

describe.skipIf(!trackLanded('41'))('notice, audit, push payload and left-out scans (Release A)', () => {
  it('no sentinel in any notice param, audit detail, push payload or Tally left-out list', async () => {
    await asOwner(db, async () => {
      const auditStart = await h.lastAuditId();
      await one(SUPER, SQL3.setPush, [true, REASON]);
      await world();
      await one(PURCHASE, SQL3.pushRegister, ['https://push.example.test/fence/2', `B${'A'.repeat(86)}`, 'A'.repeat(22), 'Chrome on Windows', rid()]);
      await h.dueNow();
      await h.msgClaim();
      const payloads = asItems<{ payload?: unknown; notice?: unknown }>(await one(WORKER, SQL3.pushClaim, ['fence', 50, 60]));
      const entity = await h.entityId();
      const preview = await h.attempt(ACC, SQL3.filePreview, [entity, FROM, today(), null, null]);
      const notices = await owner<{ params: unknown; dedup_key: string }>('select params, dedup_key from public.staff_notices');
      const audits = await h.auditsSince(auditStart);
      const leftOut = await owner('select * from public.tally_export_left_out');
      for (const [label, value] of [['notices', notices], ['audits', audits.map((a) => a.details)], ['push payloads', payloads.map((p) => p.payload ?? p.notice)],
        ['left-out', leftOut], ['preview', preview.ok ? preview.value : preview.error]] as Array<[string, unknown]>) {
        const t = text(value);
        for (const [name, s] of Object.entries(SENT)) {
          if (label === 'preview' && name === 'selling') continue; // Accounts' own preview lists receipt amounts by design.
          expect(t, `${label}: ${name}`).not.toMatch(new RegExp(`(?<![0-9A-Za-z])${s.replace(/[.]/g, '\\.')}(?![0-9A-Za-z])`));
        }
      }
    });
  });
});

describe.skipIf(!trackLanded('6'))('Release B reads (section 14)', () => {
  it('rate contracts: P, M, A read; SO, F, V, M+F and A+P never', async () => {
    await asOwner(db, async () => {
      await h.people();
      A_P.userId = U.purchaseJodhpur;
      await h.addRole(U.purchaseJodhpur, 'accounts');
      await g.rateContractsOn();
      const hotel = await g.catalogueHotel();
      const supplier = await g.hotelSupplier(hotel);
      const room = await g.roomType(hotel);
      const c = await g.activeContract(supplier, hotel, [g.line(room, { ratePaise: SENT.contractRate })]);
      // A + Purchase holder: reads as Purchase (P reads contracts), so it is a reader here.
      await fence('R-E2 rate_contract_get', SQLB.contractGet, [c], ['A', 'M', 'P', 'A+P'], ['SA', 'S2']);
      await fence('R-E1 rate_contracts_list', SQLB.contractsList, ['{}', null, 50], ['A', 'M', 'P', 'A+P'], ['SA', 'S2']);
    });
  });

  it('change requests, reconfirmation and history: no selling data for Purchase; Flight and Visa never; no supplier cost for SO', async () => {
    await asOwner(db, async () => {
      await h.people();
      A_P.userId = U.purchaseJodhpur;
      await h.addRole(U.purchaseJodhpur, 'accounts');
      const b = await h.book([HOTEL_ITEM]);
      await h.approveReal(b.versionId);
      const task = h.taskOf(b, 'hotel');
      await h.supplierConfirmed(task);
      await g.changesOn();
      const cr = await g.requestChange({ itemIds: [b.itemIds[0]!] });
      await fence('R-G1 deal_change_requests', SQLB.dealChanges, [DEAL], ['A', 'M', 'SO'], ['SA', 'A+P']);
      const v = await g.openChange(cr.changeRequestId);
      const rv = await g.editHotel(b.itemIds[0]!, v.versionId, v.rowVersion);
      await g.newTotal(v.versionId, rv);
      await g.submitChange(cr.changeRequestId, [b.itemIds[0]!]);
      await g.decideChange(cr.changeRequestId, 'approve');  // Addendum O2: the Manager approves the version sent
      const rec = await fence('R-G3 task_reconfirmation_get', `select public.task_reconfirmation_get($1) as r`, [task], ['P', 'M'], ['SA', 'A', 'A+P']);
      for (const s of [SELLING, '8123457']) expect(text(rec.P), 'Purchase never sees a selling price').not.toContain(s);
      const hist = await fence('R-G4 deal_change_history', `select public.deal_change_history($1) as r`, [DEAL], ['A', 'M', 'SO', 'P'], ['SA', 'A+P']);
      expect(text(hist.SO)).not.toContain('"amountPaise"');
      expect(text(hist.P)).not.toContain(SELLING);
      await resetActor(db);
    });
  });
});
