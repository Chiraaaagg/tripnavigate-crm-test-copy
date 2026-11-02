import { FIXTURE_USERS as U, SYNTHETIC_INTAKE_CONFIG as CONFIG, type Actor, type TestDb } from '../helpers/db';
import { DEAL, REASON, rid } from './b1-support';
import { formHelpers } from './booking-form-support';

/**
 * Shared helpers for the voice-note batch PGlite suites (tests/db/vn-*.test.ts),
 * migrations 20261128000100 (Bitrix trip details), 0110 (booking trip rules),
 * 0120 (hotel catalogue), 0130 (customer parties) and 0140 (imports).
 * Synthetic data only (invented names, example.test e-mails, made-up GSTINs);
 * every scenario runs in a rolled-back owner transaction.
 */

export { CONFIG, REASON, rid };
export const PORTAL = 'SYNTHETIC_MEMBER_0001';
export const OTHER_BRANCH_SALES: Actor = { userId: U.salesAhmedabad };
export const OTHER_BRANCH_MANAGER: Actor = { userId: U.managerAhmedabad };

/** A GSTIN of Rajasthan (08) with a valid format (format only; invented). */
export const GSTIN_08 = '08ABCDE1234F1Z5';

export const PERSONAL = {
  partyType: 'personal', name: 'Synthetic Person One', phone: '9876500021', email: 'person.one@example.test',
  addressLine1: '1 Synthetic Lane', addressLine2: null, city: 'Jodhpur', stateCode: '08', postalCode: '342001',
};
export const BUSINESS = {
  partyType: 'business', name: 'Synthetic Tours Pvt Ltd', contactPerson: 'Synthetic Contact', phone: '+971501234567',
  email: 'accounts@example.test', addressLine1: '2 Synthetic Road', addressLine2: null, city: 'Jodhpur', stateCode: '08',
  postalCode: '342001', gstStatus: 'registered', gstin: GSTIN_08, gstReason: null,
};

export const SQL = {
  partyCreate: 'select public.customer_party_create($1, $2::jsonb, $3) as r',
  partySave: 'select public.customer_party_save($1, $2, $3::jsonb) as r',
  partyAccountsSave: 'select public.customer_party_accounts_save($1, $2, $3::jsonb, $4) as r',
  partyCheck: 'select public.customer_party_check($1, $2, $3, $4) as r',
  partyGet: 'select public.customer_party_get($1) as r',
  partySearch: 'select public.customer_party_search($1, $2, $3, $4) as r',
  partyQueue: 'select public.customer_party_accounts_list($1, $2, $3) as r',
  selectParty: 'select public.booking_bill_to_select_party($1, $2, $3, $4, $5) as r',
  docBegin: 'select public.customer_party_document_begin($1, $2, $3, $4, $5, $6, $7, $8) as r',
  docFinish: 'select public.customer_party_document_finish($1, $2) as r',
  docRemove: 'select public.customer_party_document_remove($1, $2) as r',
  docDownload: 'select public.customer_party_document_authorize_download($1) as r',
  hotelSearch: 'select public.hotel_catalogue_search($1, $2, $3, $4) as r',
  hotelSave: 'select public.hotel_catalogue_save($1, $2, $3, $4::jsonb, $5) as r',
  importStage: 'select public.import_batch_stage($1, $2, $3, $4, $5, $6::jsonb, $7) as r',
  importValidate: 'select public.import_batch_validate($1) as r',
  importApply: 'select public.import_batch_apply($1, $2, $3) as r',
  importGet: 'select public.import_batch_get($1, $2, $3) as r',
  importList: 'select public.import_batch_list($1, $2) as r',
  importCancel: 'select public.import_batch_cancel($1, $2) as r',
  tripFacts: 'select public.booking_trip_facts($1) as r',
  trip: 'select public.booking_trip_save($1, $2, $3::jsonb) as r',
  destinations: 'select public.bitrix_destination_options() as r',
  scopeSet: 'select public.bitrix_destination_scope_set($1, $2, $3, $4, $5) as r',
  switchSet: 'select public.integration_set_bitrix_trip_details_read($1, $2) as r',
  switchState: 'select public.bitrix_trip_details_read_state() as r',
};

export function vnHelpers(getDb: () => TestDb) {
  const h = formHelpers(getDb);
  const { owner } = h;

  const entity = async (): Promise<string> =>
    (await owner<{ id: string }>(`select id from public.legal_entities where code = 'HOLIDAY_CHACHA'`))[0]!.id;
  const branch = async (code: string): Promise<string> =>
    (await owner<{ id: string }>(`select b.id from public.branches b join public.legal_entities e on e.id = b.legal_entity_id
       where e.code = 'HOLIDAY_CHACHA' and b.code = $1`, [code]))[0]!.id;

  /** Owner SQL: both Bitrix read switches (direct SQL; audited by the settings trigger). */
  async function switches(facts: boolean, details: boolean): Promise<void> {
    await owner('update public.integration_intake_config set bitrix_trip_facts_read = $2, bitrix_trip_details_read = $3 where id = $1',
      [CONFIG, facts, details]);
  }
  /** Owner SQL: a stored Bitrix facts row for a Deal (what the sync writes). */
  async function storeFacts(deal: string, f: {
    start?: string | null; end?: string | null; total?: number | null; adults?: number | null; children?: number | null;
    infants?: number | null; option?: string | null; field?: 'single' | 'multi';
  }): Promise<void> {
    await owner(
      `insert into public.deal_source_trip_facts (deal_id, legal_entity_id, traveller_total, tour_start, tour_end,
         destination_field, destination_option_id, adults, children, infants, source_modified_at, details_read_at)
       select d.id, d.legal_entity_id, $2, $3::date, $4::date, $5, $6, $7, $8, $9, now(), now() from public.deals d where d.id = $1`,
      [deal, f.total ?? null, f.start ?? null, f.end ?? null, f.option ? (f.field ?? 'single') : null, f.option ?? null,
        f.adults ?? null, f.children ?? null, f.infants ?? null],
    );
  }
  /** Owner SQL: a destination option name (what the name refresh writes). */
  async function storeOption(code: string, name: string, list = 'DEAL_DESTINATION'): Promise<void> {
    await owner(`insert into public.bitrix_name_lists (source_portal, entity_id, code, name) values ($1, $2, $3, $4)`,
      [PORTAL, list, code, name]);
  }
  /** Starts a new-form draft on DEAL (switch on) and returns version id and row version. */
  async function draft(actor: Actor, deal: string = DEAL) {
    await h.setSwitch('service_items_enabled', true);
    const s = await h.start(actor, deal);
    return { versionId: s.versionId, rowVersion: s.rowVersion };
  }
  const auditRows = (action: string) =>
    owner<{ target_id: string; reason: string | null; details: Record<string, unknown>; actor_user_id: string | null }>(
      'select target_id, reason, details, actor_user_id from public.audit_events where action = $1 order by occurred_at, id', [action]);

  return { ...h, entity, branch, switches, storeFacts, storeOption, draft, auditRows };
}
