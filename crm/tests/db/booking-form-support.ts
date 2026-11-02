import { expect } from 'vitest';
import type { Actor, TestDb } from '../helpers/db';
import { BILLING, CONTACT, DEAL, HOTEL, OWNER, TRAVELLERS, TRIP, rid } from './b1-support';
import { b11Helpers } from './b11-support';

/**
 * Shared helpers for the booking form PGlite suites (tests/db/booking-form-*.test.ts),
 * migrations 20261124000100 (schema), 0110 (commands) and 0120 (readiness and reads).
 */

/** Keys booking_form_get gained in 20261124000120, removed so older-body comparisons still hold. */
export function stripBookingFormKeys(form: Record<string, unknown>): Record<string, unknown> {
  // tripFacts: voice-note batch (20261128000110), stripped the same way.
  // flightFareTotals, bitrixDealHref, idProofCopyApplies: Book now v2 (20261129000120/0130), stripped the same way.
  const { party, coverage, itemFilesCanEdit, prices, tripFacts, flightFareTotals, bitrixDealHref, idProofCopyApplies, ...rest } = form;
  void party;
  void coverage;
  void itemFilesCanEdit;
  void prices;
  void tripFacts;
  void [flightFareTotals, bitrixDealHref, idProofCopyApplies];
  const out: Record<string, unknown> = { ...rest };
  if (out.version && typeof out.version === 'object') {
    const { formRules, ...v } = out.version as Record<string, unknown>;
    void formRules;
    out.version = v;
  }
  if (out.contacts && typeof out.contacts === 'object') {
    const { customerType, market, ...c } = out.contacts as Record<string, unknown>;
    void customerType;
    void market;
    out.contacts = c;
  }
  if (out.billing && typeof out.billing === 'object') {
    // partyId, partyCheckStatus: voice-note batch (20261128000130).
    const { billToType, contactPerson, phone, email, gstStatus, gstReason, verifiedByName, verifiedAt, partyId, partyCheckStatus, ...b } =
      out.billing as Record<string, unknown>;
    void [billToType, contactPerson, phone, email, gstStatus, gstReason, verifiedByName, verifiedAt, partyId, partyCheckStatus];
    out.billing = b;
  }
  if (Array.isArray(out.items)) {
    out.items = (out.items as Array<Record<string, unknown>>).map(({ estimate, files, ...i }) => {
      void estimate;
      void files;
      return i;
    });
  }
  if (Array.isArray(out.travellers)) {
    out.travellers = (out.travellers as Array<Record<string, unknown>>).map((row) => {
      // specialRequests and identity.extraPhones: voice-note batch (20261128000110).
      const { specialRequests, ...t } = row;
      void specialRequests;
      if (!t.identity || typeof t.identity !== 'object') return t;
      const { dateOfMarriage, phone, email, extraPhones, ...identity } = t.identity as Record<string, unknown>;
      void [dateOfMarriage, phone, email, extraPhones];
      return { ...t, identity };
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Commands and a ready new-form draft
// ---------------------------------------------------------------------------


export const START_SQL = 'select public.booking_form_start($1) as r';
export const PRICES_SQL = 'select public.booking_prices_save($1, $2, $3::jsonb, $4) as r';
export const SERVICE_SQL = 'select public.booking_service_save($1, $2, $3, $4, $5::jsonb, $6::bigint, $7::jsonb, $8::integer[], $9) as r';
export const FILE_BEGIN_SQL = 'select public.service_item_file_begin($1, $2, $3, $4::jsonb, $5) as r';
export const FILE_FINISH_SQL = 'select public.service_item_file_finish($1, $2) as r';
export const FILE_REMOVE_SQL = 'select public.service_item_file_remove($1, $2) as r';
export const FILE_DOWNLOAD_SQL = 'select public.service_item_file_authorize_download($1) as r';
export const ACCOUNTS_BILLING_SQL = 'select public.accounts_billing_save($1, $2, $3::jsonb, $4) as r';

/** Party of TRAVELLERS: 3 adults and 1 child. */
export const PARTY = { paxTotal: 4, children: 1, infants: 0 };
/** Bill To of a person (booking form keys). */
export const BILL_TO = { ...BILLING, billToType: 'personal', phone: '9876500011', email: null };

type Line = { category: string; quantity: number; purchasePaise: string | null; markupPaise: string | null; salePaise: string | null };
export const line = (category: string, quantity: number, purchase: string | null = null, markup: string | null = null,
  sale: string | null = null): Line => ({ category, quantity, purchasePaise: purchase, markupPaise: markup, salePaise: sale });
/** Synthetic odd amounts (Mercury part B): adult sale ₹12,345.67 = ₹10,000 + ₹2,345.67. */
export const ADULT_SALE = '1234567';
export const LINES: Line[] = [
  line('adult', 3, '1000000', '234567', ADULT_SALE),
  line('child_bed', 1, '500000', '100000', '600000'),
  line('child_no_bed', 0),
  line('infant', 0),
];
/** 3 × 1,234,567 + 600,000 paise. */
export const LINES_TOTAL = '4303701';

type RV = { rowVersion: number; contentHash: string };

export function formHelpers(getDb: () => TestDb) {
  const h = b11Helpers(getDb);
  const { one, owner } = h;

  const start = (actor: Actor = OWNER, deal: string = DEAL) =>
    one<{ versionId: string; rowVersion: number; created: boolean; formRules: number }>(actor, START_SQL, [deal]);
  const savePrices = (actor: Actor, versionId: string, rowVersion: number, lines: unknown = LINES, requestId: string = rid()) =>
    one<RV & { sellingTotalPaise: string | null; outcome?: string }>(actor, PRICES_SQL, [versionId, rowVersion, JSON.stringify(lines), requestId]);
  const saveService = (actor: Actor, versionId: string, rowVersion: number, args: {
    itemId?: string | null; type?: string | null; facts: unknown; budget?: string | null; estimate?: unknown; participants?: number[] | null;
    requestId?: string;
  }) => one<RV & { itemId: string; itemNo: number; outcome?: string }>(actor, SERVICE_SQL, [versionId, rowVersion, args.itemId ?? null,
    args.type ?? null, JSON.stringify(args.facts), args.budget ?? null, args.estimate === undefined ? null : JSON.stringify(args.estimate),
    args.participants ?? null, args.requestId ?? rid()]);
  const issues = async (actor: Actor, versionId: string) => (await h.readiness(actor, versionId)).issues;

  /**
   * A complete new-form (form rules 2) draft: 4 travellers (3 adults, 1 child),
   * party counts, one hotel covering the trip with an estimate, contact, Bill
   * To, participation, per-person prices, a plan equal to the derived total,
   * identity proofs and the acceptance message.
   */
  async function readyForm(actor: Actor = OWNER, deal: string = DEAL, opts: { items?: Array<[string, unknown]> } = {}) {
    await h.setSwitch('service_items_enabled', true);
    const s = await start(actor, deal);
    expect(s.formRules).toBe(2);
    let rv = (await h.saveTravellers(actor, deal, s.rowVersion, TRAVELLERS)).rowVersion;
    const itemIds: string[] = [];
    for (const [type, facts] of opts.items ?? [['hotel', HOTEL]]) {
      const saved = await saveService(actor, s.versionId, rv, { type, facts,
        estimate: type === 'hotel' ? { kind: 'hotel', roomRatePaise: '450000', extraBedRatePaise: null, noBedRatePaise: null } : null,
        participants: [1, 2, 3, 4] });
      rv = saved.rowVersion;
      itemIds.push(saved.itemId);
    }
    rv = (await one<RV>(actor, 'select public.booking_trip_save($1, $2, $3::jsonb) as r',
      [s.versionId, rv, JSON.stringify({ ...TRIP, ...PARTY })])).rowVersion;
    const billingRow = await owner<{ row_version: number }>('select row_version from public.customer_billing_profiles where deal_id = $1', [deal]);
    rv = (await one<RV>(actor, 'select public.booking_customer_save($1, $2, $3::jsonb, $4::jsonb, $5, $6) as r',
      [s.versionId, rv, JSON.stringify({ ...CONTACT, customerType: 'individual', market: 'india' }), JSON.stringify(BILL_TO),
        billingRow[0]?.row_version ?? 0, rid()])).rowVersion;
    rv = (await savePrices(actor, s.versionId, rv)).rowVersion;
    rv = (await h.savePlan(actor, s.versionId, rv, [{ seq: 1, label: 'Full payment', amountPaise: LINES_TOTAL, dueDate: '2026-11-01' }])).rowVersion;
    for (const seq of [1, 2, 3, 4]) await h.storeIdProof(actor, deal, seq);
    await h.storeEvidence(actor, s.versionId);
    const r = await h.readiness(actor, s.versionId);
    return { versionId: s.versionId, rowVersion: rv, hash: r.contentHash, issues: r.issues, itemIds };
  }

  return { ...h, start, savePrices, saveService, issues, readyForm };
}
