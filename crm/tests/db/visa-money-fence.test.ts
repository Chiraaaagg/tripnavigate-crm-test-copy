import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Actor, type TestDb, asOwner, createTestDb } from '../helpers/db';
import { allKeys } from './b1-support';
import {
  ACC, DEAL, EVISA, FLIGHT, MANAGER, OWNER, PURCHASE, SALES_B, SQL, STICKER, VISA_A, VISA_B, line, passportOf, rid, visaHelpers,
} from './visa-e-support';

/**
 * Visa build, test plan 12.2 (money-fence and identity leak test) and
 * contract section 9: every visa read called as VA (the assignee, pure Visa),
 * V (another Visa person), M, SO, S (another Sales reader of the Deal), A, P
 * and F, on a Deal carrying distinctive synthetic values:
 *   - no visa read contains a commercial or contact value (selling total,
 *     plan, fixture commercials, contact phone and e-mail, billing);
 *   - the passport number only in the assignee's workspace (others get
 *     passport null, never a masked number; the Manager no identity);
 *   - the e-visa recipient e-mail typed by the desk only in the V/M workspace
 *     (VL24): never in Deal reads, History or audit;
 *   - Deal reads carry no paise, references, e-mails or passport numbers;
 *   - task History and visa audit details carry no paise, references,
 *     passport numbers, e-mails, traveller names or staff-typed labels;
 *   - Purchase and Flight get null for every visa read;
 *   - Accounts reads no desk and sees only applicantName extra on its
 *     expense records (section 9.4).
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = visaHelpers(() => db);
const { one, owner } = h;

// Distinctive synthetic values (b1-support / b11-support defaults that book() uses).
const SELLING = '9876543'; // booking selling total and the one-instalment plan amount
const FIXTURE_COMMERCIALS = ['12345600', '1111100']; // deal_commercials selling / margin
const CONTACT_PHONE = '9876500011';
const CONTACT_EMAIL = 'contact@example.test';
const BILLING = ['Synthetic Billing Name', '1 Synthetic Road', '342001'];
// Desk-typed values.
const GOV_FEE = '654321';
const SERVICE_FEE = '43219';
const EVISA_FEE = '765437';
const REF_STICKER = 'SYN-FNC-STK-001';
const REF_STICKER_2 = 'SYN-FNC-STK-002';
const REF_EVISA = 'SYN-FNC-EVI-001';
const EVISA_EMAIL = 'evisa.sentinel@example.test';
const COURIER = 'SYN-CRR-445566';
const DESK_PASSPORT = 'P7654321';
const OTHER_LABEL = 'Synthetic sponsor letter for fence';
const TRAVELLER_NAMES = ['Synthetic Traveller One', 'Synthetic Traveller Two', 'Synthetic Traveller Three', 'Synthetic Traveller Four'];
const PASSPORTS = [1, 2, 3, 4].map(passportOf);

const COMMERCIAL = [SELLING, ...FIXTURE_COMMERCIALS, CONTACT_PHONE, CONTACT_EMAIL, ...BILLING];
const FORBIDDEN_KEY = /sell|margin|discount|listPrice|instal|^plan$|billing|contact|phone|mobile|address|gstin|payer|customerReceipt|receipts$|funding|bank|ifsc|accountNumber/i;

/** True when `text` contains `value` as a standalone token (not part of a longer value). */
const containsToken = (text: string, value: string) =>
  new RegExp(`(?<![0-9A-Za-z])${value.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}(?![0-9A-Za-z])`).test(text);

type Scenario = { stickerTask: string; evisaTask: string; entryIds: string[]; tasks: string[] };

/**
 * SYN-DEL-001 (owner Sales Delhi A): a sticker visa for the four travellers
 * and an e-visa for travellers 1-2, both taken by VISA_A. Sticker: traveller 1
 * applied with a company receipt (submitted) and approved with a courier
 * handover; traveller 2 applied and rejected; traveller 3 gets an "Other"
 * document typed by the desk; traveller 4's passport number is typed in the
 * desk row. E-visa: traveller 1 applied and approved with the recipient
 * e-mail typed by the desk. SALES_B is another Sales reader of the Deal.
 */
async function scenario(): Promise<Scenario> {
  await h.addVisaB();
  await h.addFlightPerson();
  await h.addOtherSales(DEAL);
  const b = await h.book({ items: [{ type: 'visa', facts: STICKER }, { type: 'visa', facts: EVISA, participants: [1, 2] }] });
  const [stickerTask, evisaTask] = b.tasks as [string, string];
  await one(VISA_A, SQL.claim, [stickerTask]);
  await one(VISA_A, SQL.claim, [evisaTask]);

  // Sticker traveller 1: company receipt, submitted fees; approved, courier.
  const s1 = await h.makeReady(stickerTask, 1);
  const receipt = await h.evidence(VISA_A, stickerTask, 'fee_receipt');
  const applied1 = await h.apply(stickerTask, [line(s1, { reference: REF_STICKER, governmentFeePaise: GOV_FEE, serviceFeePaise: SERVICE_FEE })],
    { receiptEvidenceId: receipt, remark: 'Synthetic applied remark' });
  await h.decide(stickerTask, await h.app(stickerTask, 1), 'approved', { handover: { method: 'courier', courierNumber: COURIER } });
  // Sticker traveller 2: applied without receipt (draft), rejected.
  const s2 = await h.makeReady(stickerTask, 2);
  const applied2 = await h.apply(stickerTask, [line(s2, { reference: REF_STICKER_2, governmentFeePaise: GOV_FEE })]);
  await h.decide(stickerTask, await h.app(stickerTask, 2), 'rejected');
  // Sticker traveller 3: an "Other" document typed by the desk.
  const s3 = await h.app(stickerTask, 3);
  await one(VISA_A, SQL.docAdd, [s3.applicationId, s3.rowVersion, JSON.stringify({ label: OTHER_LABEL, received: false, remark: null }), rid()]);
  // Sticker traveller 4: the desk types a new passport number (writes the identity record, V2/VL9).
  const s4 = await h.app(stickerTask, 4);
  await one(VISA_A, SQL.setRow, [s4.applicationId, s4.rowVersion, JSON.stringify({ passportNumber: DESK_PASSPORT }), rid()]);

  // E-visa traveller 1: no appointment needed (Q5), approved with the typed e-mail (QB2).
  const e1 = await h.makeReady(evisaTask, 1, { appointmentDate: null });
  const applied3 = await h.apply(evisaTask, [line(e1, { reference: REF_EVISA, governmentFeePaise: EVISA_FEE })], { paidBy: 'customer_direct' });
  await h.decide(evisaTask, await h.app(evisaTask, 1), 'approved', { recipientEmail: EVISA_EMAIL });
  return { stickerTask, evisaTask, tasks: b.tasks, entryIds: [...applied1.entryIds, ...applied2.entryIds, ...applied3.entryIds] };
}

const value = async (actor: Actor, sql: string, params: unknown[] = []) => {
  const r = await h.attempt(actor, sql, params);
  return r.ok ? r.value : null;
};
/** Every visa read of section 9 for one actor (null when refused or not available). */
async function reads(actor: Actor, s: Scenario): Promise<Record<string, unknown>> {
  return {
    queue: await value(actor, SQL.queue),
    workspaceSticker: await value(actor, SQL.workspace, [s.stickerTask]),
    workspaceEvisa: await value(actor, SQL.workspace, [s.evisaTask]),
    dealSummary: await value(actor, SQL.dealSummary, [DEAL]),
    dealHistory: await value(actor, SQL.dealHistory, [DEAL]),
    homeCounts: await value(actor, SQL.homeCounts),
    taskHistorySticker: await value(actor, SQL.taskHistory, [s.stickerTask]),
    taskHistoryEvisa: await value(actor, SQL.taskHistory, [s.evisaTask]),
  };
}
const ACTORS: Array<[string, Actor]> = [
  ['VA', VISA_A], ['V', VISA_B], ['M', MANAGER], ['SO', OWNER], ['S', SALES_B], ['A', ACC], ['P', PURCHASE], ['F', FLIGHT],
];
/** Every passport object of a workspace's applicants. */
const passports = (w: unknown) => ((w as { applicants?: Array<{ passport: unknown }> } | null)?.applicants ?? []).map((a) => a.passport);

describe('visa money fence and identity (12.2)', () => {
  it('no visa read carries a commercial or contact value, nor a commercial or contact key, for any reader', async () => {
    await asOwner(db, async () => {
      const s = await scenario();
      for (const [name, actor] of ACTORS) {
        const r = await reads(actor, s);
        const text = JSON.stringify(r);
        for (const v of COMMERCIAL) expect(containsToken(text, v), `${name} sees ${v}`).toBe(false);
        const bad = [...allKeys(r)].filter((k) => FORBIDDEN_KEY.test(k));
        expect(bad, `${name} forbidden keys`).toEqual([]);
      }
    });
  });

  it('Purchase and Flight get null for every visa read; Accounts reads no desk', async () => {
    await asOwner(db, async () => {
      const s = await scenario();
      for (const [name, actor] of [['P', PURCHASE], ['F', FLIGHT]] as Array<[string, Actor]>) {
        const r = await reads(actor, s);
        for (const key of ['queue', 'workspaceSticker', 'workspaceEvisa', 'dealSummary', 'dealHistory', 'taskHistorySticker', 'taskHistoryEvisa']) {
          expect(r[key], `${name} ${key}`).toBeNull();
        }
        // Home: null, or an object whose visa keys are all null (section 8: keys null when not applicable).
        const home = r.homeCounts as Record<string, unknown> | null;
        // The Flight actor (Sales Ahmedabad) also holds Sales elsewhere, so the Sales row may read 0 (applicable, nothing to see).
        if (home) for (const [k, v] of Object.entries(home)) {
          if (name === 'F' && k === 'salesVisaResultsToSee') expect(v ?? 0, `${name} home ${k}`).toBe(0);
          else expect(v, `${name} home ${k}`).toBeNull();
        }
        const text = JSON.stringify(r);
        for (const v of [...PASSPORTS, DESK_PASSPORT, EVISA_EMAIL, REF_STICKER, GOV_FEE, ...TRAVELLER_NAMES]) {
          expect(containsToken(text, v), `${name} sees ${v}`).toBe(false);
        }
      }
      // Accounts: no queue, no workspace, no task History, no Deal visa reads (section 9.3: A -> null).
      const a = await reads(ACC, s);
      for (const key of ['queue', 'workspaceSticker', 'workspaceEvisa', 'dealSummary', 'dealHistory', 'taskHistorySticker', 'taskHistoryEvisa']) {
        expect(a[key], `A ${key}`).toBeNull();
      }
    });
  });

  it('passport number only for the assignee; other Visa people and the Manager get no identity object (V2, 10.4)', async () => {
    await asOwner(db, async () => {
      const s = await scenario();
      const va = await one<{ applicants: Array<{ seq: number; passport: { number: string | null } | null }> }>(VISA_A, SQL.workspace, [s.stickerTask]);
      expect(va.applicants.find((a) => a.seq === 1)!.passport?.number).toBe(passportOf(1));
      expect(va.applicants.find((a) => a.seq === 4)!.passport?.number).toBe(DESK_PASSPORT);
      for (const [name, actor] of [['V', VISA_B], ['M', MANAGER]] as Array<[string, Actor]>) {
        const r = await reads(actor, s);
        expect(r.workspaceSticker, `${name} reads the workspace`).not.toBeNull();
        for (const p of [...passports(r.workspaceSticker), ...passports(r.workspaceEvisa)]) expect(p, `${name} passport`).toBeNull();
        const text = JSON.stringify(r);
        for (const v of [...PASSPORTS, DESK_PASSPORT]) expect(containsToken(text, v), `${name} sees ${v}`).toBe(false);
        // No masked number either (section 10.4): no "••••", "XXXX" or last-digits fragment.
        expect(text, `${name} masked number`).not.toMatch(/[•*X]{3,}\d{2,4}/);
        expect([...allKeys(r)].filter((k) => /identity|dateOfBirth|passportExpiry|nationality|passportNumber/i.test(k)), `${name} identity keys`).toEqual([]);
      }
      // The assignee's identity never leaks into the other reads either.
      for (const [name, actor] of ACTORS.filter(([n]) => n !== 'VA')) {
        const text = JSON.stringify(await reads(actor, s));
        for (const v of [...PASSPORTS, DESK_PASSPORT]) expect(containsToken(text, v), `${name} sees ${v}`).toBe(false);
      }
      // The desk's passport number lives only in traveller_identities (V2): no copy on the application row.
      const row = await h.appRow((va.applicants.find((a) => a.seq === 4) as unknown as { applicationId: string }).applicationId);
      expect(JSON.stringify(row)).not.toContain(DESK_PASSPORT);
    });
  });

  it('the typed e-visa e-mail only in the Visa and Manager workspace; never Deal reads, History or audit (VL24)', async () => {
    await asOwner(db, async () => {
      const s = await scenario();
      for (const [name, actor] of ACTORS) {
        const r = await reads(actor, s);
        const ws = JSON.stringify(r.workspaceEvisa);
        if (name === 'VA' || name === 'V' || name === 'M') expect(ws, `${name} workspace e-mail`).toContain(EVISA_EMAIL);
        else expect(r.workspaceEvisa, `${name} workspace`).toBeNull();
        const rest = JSON.stringify({ ...r, workspaceEvisa: null, workspaceSticker: null });
        expect(rest, `${name} e-mail outside the workspace`).not.toContain(EVISA_EMAIL);
      }
      const audit = JSON.stringify(await owner(`select details, reason from public.audit_events where action like 'visa.%' or target_id = any($1::uuid[])`, [s.tasks]));
      expect(audit).not.toContain(EVISA_EMAIL);
    });
  });

  it('Deal reads carry no paise, references, e-mails or passport numbers; SO, S and M read the summary, SO and M the history (9.3, VL5)', async () => {
    await asOwner(db, async () => {
      const s = await scenario();
      for (const [name, actor] of ACTORS) {
        const r = await reads(actor, s);
        if (['SO', 'S', 'M'].includes(name)) expect(r.dealSummary, `${name} deal summary`).not.toBeNull();
        else expect(r.dealSummary, `${name} deal summary`).toBeNull();
        if (['SO', 'M'].includes(name)) expect(r.dealHistory, `${name} deal history`).not.toBeNull();
        else expect(r.dealHistory, `${name} deal history`).toBeNull();
        const deal = { summary: r.dealSummary, history: r.dealHistory };
        const text = JSON.stringify(deal);
        for (const v of [GOV_FEE, SERVICE_FEE, EVISA_FEE, REF_STICKER, REF_STICKER_2, REF_EVISA, EVISA_EMAIL, COURIER, ...PASSPORTS, DESK_PASSPORT, ...COMMERCIAL]) {
          expect(containsToken(text, v), `${name} deal read ${v}`).toBe(false);
        }
        expect([...allKeys(deal)].filter((k) => /paise|amount|fee|reference|email|passport|courier/i.test(k)), `${name} deal keys`).toEqual([]);
      }
    });
  });

  it('task History and visa audit details carry no paise, references, passport numbers, e-mails, traveller names or typed labels', async () => {
    await asOwner(db, async () => {
      const s = await scenario();
      const secret = [GOV_FEE, SERVICE_FEE, EVISA_FEE, REF_STICKER, REF_STICKER_2, REF_EVISA, ...PASSPORTS, DESK_PASSPORT, EVISA_EMAIL, OTHER_LABEL, COURIER,
        ...TRAVELLER_NAMES];
      for (const [name, actor] of [['VA', VISA_A], ['V', VISA_B], ['M', MANAGER]] as Array<[string, Actor]>) {
        const r = await reads(actor, s);
        expect(r.taskHistorySticker, `${name} reads task History`).not.toBeNull();
        const text = JSON.stringify([r.taskHistorySticker, r.taskHistoryEvisa]);
        for (const v of secret) expect(containsToken(text, v), `${name} history ${v}`).toBe(false);
      }
      // Section 0: audit details carry ids, seqs, counts, codes and row versions only. (The courier number counts as a
      // reference here; the refusal reason goes in the reason column, which is not scanned.)
      const rows = await owner<{ action: string; details: unknown }>(
        `select action, details from public.audit_events
         where action like 'visa.%' or action = 'booking.traveller_identity_saved'
            or (action like 'department.%' and (target_id = any($1::uuid[]) or target_id = any($2::uuid[])))
            or target_id = any($1::uuid[])`, [s.tasks, s.entryIds]);
      expect(rows.filter((x) => x.action.startsWith('visa.')).length, 'visa audit rows written').toBeGreaterThan(0);
      for (const row of rows) {
        const text = JSON.stringify(row.details);
        for (const v of secret) expect(containsToken(text, v), `${row.action} details ${v}`).toBe(false);
      }
    });
  });

  it('Accounts sees the visa fee with only applicantName extra; no applicant documents, identity or desk-typed e-mail (9.4, VL16)', async () => {
    await asOwner(db, async () => {
      const s = await scenario();
      // SYNTHETIC FIXTURE: a legacy task-level visa entry (application_id null, section 5.8 #7), submitted, written by the table owner,
      // gives the key set of a visa expense record before the build.
      const [legacyReceipt] = await owner<{ id: string }>(
        `select id from public.department_evidence where task_id = $1 and kind = 'fee_receipt' and status = 'stored' limit 1`, [s.stickerTask]);
      await owner(
        `insert into public.department_cost_entries (legal_entity_id, branch_id, deal_id, task_id, department, cost_kind, amount_paise, paid_by,
           payment_mode, paid_on, expense_status, receipt_evidence_id, submitted_by, submitted_at, created_by, request_id)
         select t.legal_entity_id, d.branch_id, t.deal_id, t.id, 'visa', 'service_fee', 111111, 'company', 'upi', current_date, 'submitted', $2,
           t.assignee_user_id, now(), t.assignee_user_id, gen_random_uuid()
         from public.fulfilment_tasks t join public.deals d on d.id = t.deal_id where t.id = $1`, [s.stickerTask, legacyReceipt!.id]);
      const page = await one<{ items: Array<Record<string, unknown>> }>(ACC, SQL.expenseList, ['all', null, 100]);
      const linked = page.items.find((i) => i.amountPaise === GOV_FEE && i.department === 'visa' && i.kind === 'government_fee');
      const legacy = page.items.find((i) => i.amountPaise === '111111');
      expect(linked, 'the submitted per-passenger fee').toBeDefined();
      expect(legacy, 'the legacy task-level fee').toBeDefined();
      expect(linked!.applicantName).toBe(TRAVELLER_NAMES[0]);
      expect(legacy!.applicantName ?? null).toBeNull();
      const extra = Object.keys(linked!).filter((k) => !(k in legacy!));
      expect(extra, 'only applicantName is new on a visa expense record').toEqual([]);
      expect(Object.keys(legacy!)).toContain('applicantName');
      const text = JSON.stringify(page);
      for (const v of [...PASSPORTS, DESK_PASSPORT, EVISA_EMAIL, OTHER_LABEL, COURIER, ...COMMERCIAL]) expect(containsToken(text, v), `Accounts sees ${v}`).toBe(false);
      expect(text).not.toMatch(/applicant_document|authority_outcome/);
      // Other travellers' names are not on Accounts' page (only the applicant of each linked entry).
      expect(text).not.toContain(TRAVELLER_NAMES[2]);
    });
  });

  it('the desk sees fees as costs only: no customer price, receipts, contacts or billing in its reads (Q10, V9)', async () => {
    await asOwner(db, async () => {
      const s = await scenario();
      const w = await one<Record<string, unknown>>(VISA_A, SQL.workspace, [s.stickerTask]);
      const summary = w.costSummary as { companyTotalPaise: string; customerDirectTotalPaise: string; travellers: Array<Record<string, unknown>> };
      // Company: traveller 1 (gov + service, submitted) and traveller 2 (gov, draft) as recorded, never split.
      expect(summary.companyTotalPaise).toBe(String(Number(GOV_FEE) * 2 + Number(SERVICE_FEE)));
      expect(summary.customerDirectTotalPaise).toBe('0');
      expect(summary.travellers.find((t) => t.seq === 1)).toMatchObject({ governmentFeePaise: GOV_FEE, serviceFeePaise: SERVICE_FEE, paidBy: 'company' });
      const keys = [...allKeys(w)];
      expect(keys.filter((k) => FORBIDDEN_KEY.test(k) || /customerPrice|sellingPrice|price/i.test(k))).toEqual([]);
      for (const v of COMMERCIAL) expect(containsToken(JSON.stringify(w), v), `desk sees ${v}`).toBe(false);
    });
  });
});
