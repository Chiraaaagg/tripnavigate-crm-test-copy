import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Actor, type TestDb, asOwner, createTestDb } from '../helpers/db';
import { ACCOUNTS, ANON, MANAGER, OWNER, PURCHASE, SUPER, SVC } from './b1-support';
import { CONFIG, PORTAL, REASON, SQL, vnHelpers } from './vn-support';

/**
 * Voice-note batch, migration 20261128000100: the switch
 * bitrix_trip_details_read (off by default, Super Admin with a reason,
 * audited), the trip facts apply for destination and counts, the destination
 * option names in the daily name refresh, and the Super Admin classification
 * of each destination option (domestic / international).
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = vnHelpers(() => db);
const { one, owner, refused } = h;

const FACTS_SQL = 'select public.integration_apply_bitrix_trip_facts($1, $2::jsonb) as r';
const DUE_SQL = 'select public.integration_bitrix_names_due($1) as r';
const APPLY_NAMES_SQL = 'select public.integration_apply_bitrix_names($1, $2::jsonb, $3) as r';
const MAP_SQL = 'select public.bitrix_name_map() as r';

let ts = 1_841_000_000;
const MODIFIED = '2026-10-03T10:00:00+05:30';
async function importDeal(id: number): Promise<{ inboxId: string; dealId: string }> {
  await owner(`update public.integration_intake_config
     set deal_intake_mode = 'scope', lead_intake_mode = 'scope', cutoff_at = '2026-10-01T00:00:00+05:30' where id = $1`, [CONFIG]);
  const rec = await one<{ inboxId: string }>(SVC, 'select public.integration_record_bitrix_event($1, $2, $3, $4) as r',
    [PORTAL, 'ONCRMDEALUPDATE', id, (ts += 1)]);
  const claimed = (await h.run<{ r: { inboxId: string; lockToken: string } }>(SVC, 'select r from public.integration_claim_inbox(100, 60) as r'))
    .map((x) => x.r).find((x) => x.inboxId === rec.inboxId)!;
  const r = await one<{ dealId: string }>(SVC, 'select public.integration_apply_bitrix_deal($1, $2, $3::jsonb) as r', [
    claimed.inboxId, claimed.lockToken, JSON.stringify({ id: String(id), title: `Synthetic details deal ${id}`, stageId: 'C7:NEW',
      categoryId: '7', assignedById: '101', dateCreate: '2026-10-02T09:00:00+05:30', dateModify: MODIFIED, leadId: '' })]);
  return { inboxId: rec.inboxId, dealId: r.dealId };
}
const details = (o: Record<string, unknown> = {}) => ({
  dateModify: MODIFIED, destinationField: 'single', destinationOptionId: '101', adults: 2, children: 1, infants: 0,
  detailsIssues: [], ...o,
});
const stored = (deal: string) => owner<Record<string, unknown>>(
  `select destination_field, destination_option_id, adults, children, infants, details_issues, booking_notes, traveller_total
   from public.deal_source_trip_facts where deal_id = $1`, [deal]).then((r) => r[0]);

describe('switch bitrix_trip_details_read', () => {
  it('is off by default; only the Super Admin changes it, with a reason; audited with before and after', async () => {
    await asOwner(db, async () => {
      expect(await one(SUPER, SQL.switchState, [])).toMatchObject({ enabled: false, effective: false, canSwitch: true, lastChange: null });
      for (const actor of [OWNER, MANAGER, ACCOUNTS, PURCHASE] as Actor[]) {
        await refused(actor, SQL.switchSet, [true, REASON], '42501', 'not_authorized');
      }
      await refused(ANON, SQL.switchSet, [true, REASON], '42501');
      await refused(SUPER, SQL.switchSet, [true, 'short'], '22023');
      expect(await one(SUPER, SQL.switchSet, [true, REASON])).toEqual({ changed: true, enabled: true });
      expect(await one(SUPER, SQL.switchSet, [true, REASON])).toEqual({ changed: false, enabled: true });
      const [a] = await h.auditRows('integration.bitrix_trip_details_read_set');
      expect(a).toMatchObject({ reason: REASON, details: { before: false, after: true } });
      const state = await one<{ lastChange: Record<string, unknown> }>(SUPER, SQL.switchState, []);
      expect(state).toMatchObject({ enabled: true, effective: true });
      expect(state.lastChange).toMatchObject({ via: 'command', to: true, reason: REASON });
      const settings = await one<{ bitrix: { switches: Array<Record<string, unknown>> } }>(SUPER, 'select public.settings_switch_states() as r', []);
      expect(settings.bitrix.switches.at(-1)).toMatchObject({ key: 'bitrix_trip_details_read', state: 'on' });
    });
  });
});

describe('trip facts apply: destination and counts', () => {
  it('stores nothing while both switches are off; with only the details switch on stores just the new fields', async () => {
    await asOwner(db, async () => {
      const d = await importDeal(91001);
      expect(await one(SVC, FACTS_SQL, [d.inboxId, JSON.stringify(details())])).toEqual({ outcome: 'switched_off', parties: [] });
      expect(await stored(d.dealId)).toBeUndefined();
      await h.switches(false, true);
      const r = await one(SVC, FACTS_SQL, [d.inboxId, JSON.stringify({ ...details(), bookingNotes: 'Synthetic note', travellerTotal: 3 })]);
      expect(r).toEqual({ outcome: 'stored', parties: [] });
      expect(await stored(d.dealId)).toEqual({ destination_field: 'single', destination_option_id: '101', adults: 2, children: 1,
        infants: 0, details_issues: [], booking_notes: null, traveller_total: null });
      const audit = await h.auditRows('integration.trip_facts_stored');
      expect(audit.at(-1)!.details).toEqual({ inboxId: d.inboxId, fields: ['destination', 'adults', 'children', 'infants', 'detailsIssues'],
        issues: [], detailsIssues: [] });
      expect(await one(SVC, FACTS_SQL, [d.inboxId, JSON.stringify(details())])).toEqual({ outcome: 'unchanged', parties: [] });
    });
  });

  it('with only the older switch on, the new keys are ignored and the stored new fields are kept', async () => {
    await asOwner(db, async () => {
      const d = await importDeal(91002);
      await h.switches(true, true);
      await one(SVC, FACTS_SQL, [d.inboxId, JSON.stringify({ ...details(), travellerTotal: 3 })]);
      await h.switches(true, false);
      await one(SVC, FACTS_SQL, [d.inboxId, JSON.stringify({ ...details({ adults: 9, destinationOptionId: '202' }), travellerTotal: 4 })]);
      expect(await stored(d.dealId)).toMatchObject({ destination_option_id: '101', adults: 2, traveller_total: 4 });
    });
  });

  it('checks every new key (shape, ranges, issue codes)', async () => {
    await asOwner(db, async () => {
      const d = await importDeal(91003);
      await h.switches(false, true);
      for (const bad of [details({ adults: 101 }), details({ adults: 1.5 }), details({ destinationField: 'both' }),
        details({ destinationOptionId: null }), details({ detailsIssues: ['made_up'] }), details({ children: '1' })]) {
        await refused(SVC, FACTS_SQL, [d.inboxId, JSON.stringify(bad)], '22023', 'invalid_input');
      }
      expect(await one(SVC, FACTS_SQL, [d.inboxId, JSON.stringify(details({ adults: null, detailsIssues: ['adults_unreadable'] }))]))
        .toMatchObject({ outcome: 'stored' });
      expect(await stored(d.dealId)).toMatchObject({ adults: null, details_issues: ['adults_unreadable'] });
      await refused(OWNER, FACTS_SQL, [d.inboxId, JSON.stringify(details())], '42501');
    });
  });
});

describe('destination option names in the daily name refresh', () => {
  const DEST = [{ entityId: 'DEAL_DESTINATION', items: [{ code: '101', name: 'Synthetic Dubai', sort: 1 }, { code: '102', name: 'Synthetic Goa', sort: 2 }] }];

  it('due and apply follow each switch; the name map never shows destinations', async () => {
    await asOwner(db, async () => {
      expect(await one(SVC, DUE_SQL, [PORTAL])).toEqual({ due: false, reason: 'switched_off' });
      await h.switches(false, true);
      expect(await one(SVC, DUE_SQL, [PORTAL])).toEqual({ due: true, pipelineIds: [], statusLists: false, destinations: true });
      // Stage lists need the name switch.
      await refused(SVC, APPLY_NAMES_SQL, [PORTAL, JSON.stringify([{ entityId: 'STATUS', items: [{ code: 'NEW', name: 'New' }] }]), true],
        '22023', 'invalid_input');
      expect(await one(SVC, APPLY_NAMES_SQL, [PORTAL, JSON.stringify(DEST), true])).toMatchObject({ applied: true, added: 2 });
      await owner('update public.integration_intake_config set bitrix_name_read = true where id = $1', [CONFIG]);
      const map = await one<{ names: Array<{ entityId: string }> }>(OWNER, MAP_SQL, []);
      expect(map.names.some((n) => n.entityId.startsWith('DEAL_DESTINATION'))).toBe(false);
      // Details switch off: destination lists are refused.
      await h.switches(false, false);
      await refused(SVC, APPLY_NAMES_SQL, [PORTAL, JSON.stringify(DEST), true], '22023', 'invalid_input');
    });
  });

  it('classification: Super Admin sets and clears with a reason (row version, audited); booking editors read; others refused', async () => {
    await asOwner(db, async () => {
      await h.switches(false, true);
      await one(SVC, APPLY_NAMES_SQL, [PORTAL, JSON.stringify(DEST), true]);
      const read = await one<{ options: Array<Record<string, unknown>> }>(SUPER, SQL.destinations, []);
      expect(read).toMatchObject({ enabled: true, canSet: true });
      expect(read.options.map((o: Record<string, unknown>) => [o.optionId, o.label, o.scope, o.rowVersion]))
        .toEqual([['101', 'Synthetic Dubai', null, 0], ['102', 'Synthetic Goa', null, 0]]);
      expect(await one(OWNER, SQL.destinations, [])).toMatchObject({ enabled: true, canSet: false });
      expect(await one(MANAGER, SQL.destinations, [])).toMatchObject({ enabled: true });
      for (const actor of [PURCHASE, ACCOUNTS, ANON] as Actor[]) await refused(actor, SQL.destinations, [], '42501');

      for (const actor of [OWNER, MANAGER, ACCOUNTS, PURCHASE] as Actor[]) {
        await refused(actor, SQL.scopeSet, ['DEAL_DESTINATION', '101', 'international', 0, REASON], '42501', 'not_authorized');
      }
      await refused(SUPER, SQL.scopeSet, ['DEAL_DESTINATION', '101', 'international', 0, 'short'], '22023');
      await refused(SUPER, SQL.scopeSet, ['DEAL_DESTINATION', '999', 'international', 0, REASON], 'P0002', 'not_found');
      await refused(SUPER, SQL.scopeSet, ['DEAL_DESTINATION', '101', 'abroad', 0, REASON], '22023', 'invalid_input');
      expect(await one(SUPER, SQL.scopeSet, ['DEAL_DESTINATION', '101', 'international', 0, REASON]))
        .toEqual({ changed: true, scope: 'international', rowVersion: 1 });
      await refused(SUPER, SQL.scopeSet, ['DEAL_DESTINATION', '101', 'domestic', 0, REASON], '40001', 'version_changed');
      expect(await one(SUPER, SQL.scopeSet, ['DEAL_DESTINATION', '101', null, 1, REASON]))
        .toEqual({ changed: true, scope: null, rowVersion: 2 });
      const audit = await h.auditRows('integration.destination_scope_set');
      expect(audit.map((a) => [a.details.before, a.details.after, a.reason])).toEqual([[null, 'international', REASON], ['international', null, REASON]]);
      await refused(SUPER, 'delete from public.bitrix_destination_scopes', [], '42501');
      // Switch off: reads answer nothing (rows kept).
      await h.switches(false, false);
      expect(await one(SUPER, SQL.destinations, [])).toEqual({ enabled: false, readAt: null, canSet: false, options: [] });
    });
  });
});
