import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bookingStartDraft,
  isSettingsBusy,
  parsePrefillAutoKeys,
  prefillFillEmpty,
  prefillNoticeDismiss,
  QuotationCreateAutoFillSchema,
  setPrefillAutoFill,
} from '@/modules/fulfilment/prefill-auto';
import { BookingCommandError } from '@/modules/fulfilment/commands';
import { SYNTHETIC_INTAKE_CONFIG, type TestDb, asOwner, createTestDb } from '../helpers/db';
import { OWNER, PURCHASE, REASON, SUPER, rid } from './b1-support';
import { b11Helpers } from './b11-support';
import { rpcAs } from './b12-ts-support';

/**
 * Batch 2 TS wrappers (src/modules/fulfilment/prefill-auto.ts) against the
 * real SQL of 20261122000100 on PGlite: Start booking with the creation
 * fill, the read keys through the tolerant schemas, "Fill empty fields from
 * Bitrix", "Keep mine", the quotation_create keys and the switch wrapper.
 * Synthetic fixtures; every case rolled back.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = b11Helpers(() => db);
const { one, owner } = h;

async function dealWithFacts(sourceDealId: number) {
  await h.setSwitch('service_items_enabled', true);
  await owner('update public.integration_intake_config set bitrix_trip_facts_read = true where id = $1', [SYNTHETIC_INTAKE_CONFIG]);
  const deal = await h.insertRealDeal('UC_AD0SLH', 0, sourceDealId);
  await owner(
    `insert into public.deal_source_trip_facts (deal_id, legal_entity_id, tour_start, tour_end, customer_type_enum_id, source_contact_id,
       source_modified_at)
     select d.id, d.legal_entity_id, '2026-12-10'::date, '2026-12-14'::date, '3045', 501, now() - interval '2 days'
     from public.deals d where d.id = $1`, [deal]);
  await owner(
    `insert into public.bitrix_party_snapshots (legal_entity_id, source_portal, party_kind, source_party_id, display_name, phones, emails)
     select d.legal_entity_id, 'SYNTHETIC_MEMBER_0001', 'contact', 501, 'Synthetic Bitrix Contact', array['+91 98765 00033'],
            array['bitrix.contact@example.test']
     from public.deals d where d.id = $1
     on conflict (source_portal, party_kind, source_party_id) do nothing`, [deal]);
  return deal;
}

describe('Batch 2 wrappers', () => {
  it('Start booking (off, then on), read keys, Fill empty, Keep mine and refusals through the TS layer', async () => {
    await asOwner(db, async () => {
      const rpc = rpcAs(() => db, OWNER);
      const deal = await dealWithFacts(960001);
      const off = await bookingStartDraft(rpc, deal);
      expect(off).toMatchObject({ created: true, autoFill: 'off', filled: [], skipped: [] });

      const form = await one<{ prefill: unknown }>(OWNER, 'select public.booking_form_get($1) as r', [deal]);
      const keys = parsePrefillAutoKeys(form.prefill)!;
      expect(keys.autoFill).toMatchObject({ enabled: false, run: null, canFillEmpty: false });
      expect(keys.fieldStates).toHaveLength(6);
      await expect(prefillFillEmpty(rpc, { targetKind: 'booking_version', targetId: off.versionId, expectedRowVersion: off.rowVersion }))
        .rejects.toMatchObject({ sqlState: '55000' });
      await owner('update public.workflow_settings set prefill_auto_fill = true where id');
      const on = parsePrefillAutoKeys((await one<{ prefill: unknown }>(OWNER, 'select public.booking_form_get($1) as r', [deal])).prefill)!;
      expect(on.autoFill).toMatchObject({ enabled: true, run: null, canFillEmpty: true });

      const filled = await prefillFillEmpty(rpc, { targetKind: 'booking_version', targetId: off.versionId, expectedRowVersion: off.rowVersion });
      expect(filled.filled).toEqual(['contacts.bookingFor', 'contacts.contactName', 'contacts.email', 'contacts.mobile', 'trip.end', 'trip.start']);

      await owner(`update public.deal_source_trip_facts set tour_start = '2026-12-11', source_modified_at = now() where deal_id = $1`, [deal]);
      const after = parsePrefillAutoKeys((await one<{ prefill: unknown }>(OWNER, 'select public.booking_form_get($1) as r', [deal])).prefill)!;
      const notice = after.fieldStates!.find((f) => f.field === 'trip.start')!.notice!;
      expect(notice).toMatchObject({ bitrixValue: '2026-12-11', inline: true });
      const kept = await prefillNoticeDismiss(rpc, { targetKind: 'booking_version', targetId: off.versionId, expectedRowVersion: filled.rowVersion,
        field: 'trip.start', sourceModifiedAt: notice.sourceModifiedAt });
      expect(kept).toMatchObject({ field: 'trip.start', dismissed: true });

      await expect(prefillFillEmpty(rpcAs(() => db, PURCHASE), { targetKind: 'booking_version', targetId: off.versionId, expectedRowVersion: filled.rowVersion }))
        .rejects.toMatchObject({ code: 'not_authorized' });
      await expect(prefillFillEmpty(rpc, { targetKind: 'booking_version', targetId: off.versionId, expectedRowVersion: 1 }))
        .rejects.toMatchObject({ code: 'version_changed' });
    });
  });

  it('switch on: Start booking fills; quotation_create keys parse; the switch wrapper is Super Admin only', async () => {
    await asOwner(db, async () => {
      const deal = await dealWithFacts(960002);
      await expect(setPrefillAutoFill(rpcAs(() => db, OWNER), { value: true, reason: REASON })).rejects.toBeInstanceOf(BookingCommandError);
      expect(await setPrefillAutoFill(rpcAs(() => db, SUPER), { value: true, reason: REASON })).toMatchObject({ changed: true, before: false, after: true });
      const started = await bookingStartDraft(rpcAs(() => db, OWNER), deal);
      expect(started).toMatchObject({ created: true, autoFill: 'filled' });
      expect(started.filled).toHaveLength(6);
      const q = await one(OWNER, 'select public.quotation_create($1, $2, $3, $4) as r', ['deal', deal, 'Synthetic quote', rid()]);
      const parsed = QuotationCreateAutoFillSchema.parse(q);
      expect(parsed.autoFill).toBe('filled');
      expect(parsed.skipped).toEqual(expect.arrayContaining([{ field: 'requirementsNote', reason: 'no_value' }]));
      expect(isSettingsBusy(new BookingCommandError('admin_set_workflow_setting', null, '55P03'))).toBe(true);
    });
  });

  it('tolerant parse: unknown codes are dropped, an unknown outcome reads as failed', () => {
    const keys = parsePrefillAutoKeys({
      autoFill: { enabled: true, run: null, canFillEmpty: false },
      fieldStates: [
        { field: 'trip.start', state: 'future_state', filledBy: 'robot', staffTouched: false, clearedByStaff: false, notice: null },
        { field: 'unknown.field', state: 'kept', filledBy: 'apply', staffTouched: true, clearedByStaff: false, notice: null },
      ],
    })!;
    expect(keys.fieldStates).toEqual([{ field: 'trip.start', state: null, filledBy: null, staffTouched: false, clearedByStaff: false, notice: null }]);
    expect(QuotationCreateAutoFillSchema.parse({ autoFill: 'something_new', filled: ['x'], skipped: [{ field: 'trip.end', reason: 'new_reason' }] }))
      .toEqual({ autoFill: 'failed', filled: [], skipped: [] });
    expect(parsePrefillAutoKeys({})).toEqual({});
  });
});
