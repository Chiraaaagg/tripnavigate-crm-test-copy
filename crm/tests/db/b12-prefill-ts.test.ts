import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bookingFormGet } from '@/modules/fulfilment/b11-commands';
import { PREFILL_FIELD } from '@/modules/fulfilment/b11-forms';
import { mergeBookChecklist, toPrefillView } from '@/modules/fulfilment/b11-dto';
import { intakeChecklist } from '@/modules/fulfilment/commands';
import { FIELD } from '@/modules/fulfilment/forms';
import { quotationGet } from '@/modules/quotations/commands';
import { toQuotationVersionView } from '@/modules/quotations/dto';
import { factsPayload } from '@/modules/itineraries/commands';
import { EMPTY_ITINERARY_FACTS } from '@/modules/itineraries/contracts';
import { SYNTHETIC_INTAKE_CONFIG, type TestDb, asOwner, createTestDb } from '../helpers/db';
import { DEAL, OWNER, SVC, rid } from './b1-support';
import { b11Helpers } from './b11-support';
import { rpcAs, staffAs } from './b12-ts-support';

/**
 * The 0600 prefill TS layer and the render worker read against the real SQL
 * (PGlite, synthetic): booking_form_get / quotation_get `prefill` blocks
 * through the schemas and the view; "Use Bitrix values" and "Mark checked"
 * actions on a booking draft and a quotation; the prefill_unchecked warning
 * routed to its sections; itinerary_render_input through the worker wrapper
 * as service_role. Everything rolled back.
 */

const requireStaff = vi.fn();
vi.mock('@/modules/identity/server/session', () => ({ requireStaff: () => requireStaff() }));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('@/lib/supabase/admin', () => ({
  createSupabaseAdminClient: () => {
    throw new Error('Tests pass their own client.');
  },
}));

const { usePrefillAction, markPrefillCheckedAction } = await import('@/modules/fulfilment/server/book-now-prefill-actions');
const { itineraryRenderClaimForWorker, itineraryRenderCompleteForWorker, itineraryRenderInputForWorker, renderedObjectPath } = await import('@/modules/itineraries/server/render-worker');

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = b11Helpers(() => db);
const { one, owner } = h;
const staff = () => staffAs(() => db, OWNER);

const switchOn = (on = true) => owner('update public.integration_intake_config set bitrix_trip_facts_read = $2 where id = $1', [SYNTHETIC_INTAKE_CONFIG, on]);

/** An imported Deal with stored Bitrix trip facts, a linked contact and company, and an open package draft (as Atlas's 0600 test). */
async function dealWithFacts() {
  await h.setSwitch('service_items_enabled', true);
  await switchOn();
  const deal = await h.insertRealDeal('UC_AD0SLH');
  await owner(
    `insert into public.deal_source_trip_facts (deal_id, legal_entity_id, booking_notes, traveller_total, tour_start, tour_end,
       customer_type_enum_id, source_contact_id, source_company_id, source_modified_at)
     select d.id, d.legal_entity_id, 'Synthetic notes: sea view please', 4, '2026-12-10'::date, '2026-12-14'::date, '3045', 501, 601, now()
     from public.deals d where d.id = $1`,
    [deal],
  );
  await owner(
    `insert into public.bitrix_party_snapshots (legal_entity_id, source_portal, party_kind, source_party_id, display_name, phones, emails)
     select d.legal_entity_id, 'SYNTHETIC_MEMBER_0001', k.kind, k.id, k.name, k.phones, k.emails
     from public.deals d,
          (values ('contact', 501::bigint, 'Synthetic Bitrix Contact', array['+91 98765 00033']::text[], array['bitrix.contact@example.test']::text[]),
                  ('company', 601::bigint, 'Synthetic Bitrix Company', array[]::text[], array[]::text[])) as k(kind, id, name, phones, emails)
     where d.id = $1
     on conflict (source_portal, party_kind, source_party_id) do update set phones = excluded.phones`,
    [deal],
  );
  const opened = await h.openDraft(OWNER, deal);
  return { deal, versionId: opened.versionId, rowVersion: opened.rowVersion };
}

function prefillForm(target: 'booking_version' | 'quotation_version', versionId: string, rowVersion: number, fields: string[], dealId?: string): FormData {
  const f = new FormData();
  f.set(PREFILL_FIELD.target, target);
  f.set(FIELD.versionId, versionId);
  f.set(FIELD.rowVersion, String(rowVersion));
  if (dealId) f.set(FIELD.dealId, dealId);
  for (const code of fields) f.append(PREFILL_FIELD.field, code);
  return f;
}

const BOOKING_FIELDS = ['trip.start', 'trip.end', 'contacts.contactName', 'contacts.mobile', 'contacts.email', 'contacts.bookingFor'];

describe('booking prefill through the TS layer', () => {
  it('view → use → warning routed by section → mark checked; unavailable while the read switch is off', async () => {
    await asOwner(db, async () => {
      requireStaff.mockResolvedValue(staff());
      const d = await dealWithFacts();
      const form = await bookingFormGet(staff().supabase, d.deal);
      const view = toPrefillView(form!.prefill!, { target: 'booking', canEdit: true });
      expect(view).toMatchObject({ available: true, notesHidden: false, bookingNotes: 'Synthetic notes: sea view please', travellerTotal: 4, customerType: 'b2d', customerTypeLabel: 'B2D', unchecked: [] });
      expect(view.fields.map((f) => [f.field, f.bitrixValue, f.canUse, f.state])).toEqual([
        ['trip.start', '2026-12-10', true, null],
        ['trip.end', '2026-12-14', true, null],
        ['contacts.contactName', 'Synthetic Bitrix Contact', true, null],
        ['contacts.mobile', '+91 98765 00033', true, null],
        ['contacts.email', 'bitrix.contact@example.test', true, null],
        ['contacts.bookingFor', 'business', true, null], // DEC-45: a known Customer Type (b2d) means business
      ]);

      const used = await usePrefillAction(null, prefillForm('booking_version', d.versionId, d.rowVersion, BOOKING_FIELDS, d.deal));
      expect(used).toMatchObject({ ok: true, message: expect.stringContaining('Filled from Bitrix: Trip start date') });
      if (!used.ok) throw new Error('not applied');
      expect([...used.data.applied].sort()).toEqual([...BOOKING_FIELDS].sort());
      // The command bumps the row version more than once (trip save, then its own bump): the returned one is current.
      expect(used.data.rowVersion).toBeGreaterThan(d.rowVersion);

      const after = await bookingFormGet(staff().supabase, d.deal);
      expect(after!.version!.rowVersion).toBe(used.data.rowVersion);
      expect(after!.contacts).toMatchObject({ bookingFor: 'business', contactConfirmed: false });
      expect(toPrefillView(after!.prefill!, { target: 'booking', canEdit: true }).unchecked.sort()).toEqual([...BOOKING_FIELDS].sort());

      const checklist = await intakeChecklist(staff().supabase, d.deal);
      const rows = mergeBookChecklist(checklist, []).filter((i) => i.code === 'prefill_unchecked');
      expect(rows.map((r) => [r.step, r.section, r.blocking, r.prefillFields])).toEqual([
        ['travellers', 'customer', false, ['contacts.bookingFor', 'contacts.contactName', 'contacts.email', 'contacts.mobile']],
        ['stay', 'trip', false, ['trip.end', 'trip.start']],
      ]);

      const checked = await markPrefillCheckedAction(null, prefillForm('booking_version', d.versionId, used.data.rowVersion, BOOKING_FIELDS, d.deal));
      expect(checked).toMatchObject({ ok: true, message: expect.stringContaining('Marked as checked') });
      expect(mergeBookChecklist(await intakeChecklist(staff().supabase, d.deal), []).map((i) => i.code)).not.toContain('prefill_unchecked');

      await switchOn(false);
      const off = await usePrefillAction(null, prefillForm('booking_version', d.versionId, used.data.rowVersion, ['trip.start'], d.deal));
      expect(off).toMatchObject({ ok: false, code: 'prefill_unavailable' });
      const offView = toPrefillView((await bookingFormGet(staff().supabase, d.deal))!.prefill!, { target: 'booking', canEdit: true });
      expect(offView.available).toBe(false);
      expect(offView.fields.every((f) => !f.canUse && f.bitrixValue === null)).toBe(true);
    });
  });

  it('a stale row version is refused; fields of another target are refused before any call', async () => {
    await asOwner(db, async () => {
      requireStaff.mockResolvedValue(staff());
      const d = await dealWithFacts();
      expect(await usePrefillAction(null, prefillForm('booking_version', d.versionId, d.rowVersion + 5, ['trip.start'], d.deal))).toMatchObject({ ok: false, code: 'version_changed' });
      expect(await usePrefillAction(null, prefillForm('booking_version', d.versionId, d.rowVersion, ['requirementsNote'], d.deal))).toMatchObject({ ok: false, code: 'invalid_input', fields: [PREFILL_FIELD.field] });
    });
  });
});

describe('quotation prefill through the TS layer', () => {
  it('quotation_get prefill in the view; use copies the notes on request; mark checked shrinks the unchecked list', async () => {
    await asOwner(db, async () => {
      requireStaff.mockResolvedValue(staff());
      const d = await dealWithFacts();
      const q = await one<{ versionId: string; rowVersion: number }>(OWNER, 'select public.quotation_create($1, $2, $3, $4) as r', ['deal', d.deal, 'Synthetic quote', rid()]);
      const before = toQuotationVersionView((await quotationGet(staff().supabase, q.versionId))!);
      expect(before.prefill).toMatchObject({ available: true, unchecked: [] });
      expect(before.prefill!.fields.map((f) => f.field)).toEqual(['trip.start', 'trip.end', 'requirementsNote', 'contacts.contactName', 'contacts.mobile', 'contacts.email', 'contacts.companyName', 'contacts.bookingFor']);

      // A contact needs a mobile or an email: name alone is skipped with that reason.
      const nameOnly = await usePrefillAction(null, prefillForm('quotation_version', q.versionId, q.rowVersion, ['contacts.contactName']));
      expect(nameOnly).toMatchObject({ ok: true, data: { applied: [], skipped: [{ field: 'contacts.contactName', reason: 'contact_needs_mobile_or_email' }] }, message: expect.stringContaining('A contact needs a mobile number or an email.') });
      if (!nameOnly.ok) throw new Error('refused');
      const used = await usePrefillAction(null, prefillForm('quotation_version', q.versionId, nameOnly.data.rowVersion, ['requirementsNote', 'trip.start', 'contacts.contactName', 'contacts.mobile', 'contacts.companyName', 'contacts.bookingFor']));
      expect(used).toMatchObject({ ok: true });
      if (!used.ok) throw new Error('not applied');
      const got = (await quotationGet(staff().supabase, q.versionId))!;
      expect(got.requirementsNote).toBe('Synthetic notes: sea view please');
      expect(got.contacts).toMatchObject({ bookingFor: 'business' }); // DEC-45, carried into the booking on conversion
      const view = toQuotationVersionView(got);
      expect(view.prefill!.unchecked.sort()).toEqual(['contacts.bookingFor', 'contacts.companyName', 'contacts.contactName', 'contacts.mobile', 'requirementsNote', 'trip.start']);
      expect(view.prefill!.fields.find((f) => f.field === 'requirementsNote')).toMatchObject({ state: 'from_bitrix', canMarkChecked: true });

      const checked = await markPrefillCheckedAction(null, prefillForm('quotation_version', q.versionId, used.data.rowVersion, ['requirementsNote']));
      expect(checked).toMatchObject({ ok: true, data: { checked: ['requirementsNote'] } });
      expect(toQuotationVersionView((await quotationGet(staff().supabase, q.versionId))!).prefill!.unchecked).toHaveLength(5);
    });
  });
});

describe('render worker input', () => {
  it('reads the job it holds as service_role; another worker gets conflict', async () => {
    await asOwner(db, async () => {
      const doc = await one<{ documentId: string; draftId: string; rowVersion: number }>(OWNER, 'select public.itinerary_document_create($1, $2, $3, $4) as r', ['deal', DEAL, 'Synthetic itinerary', rid()]);
      const facts = { ...EMPTY_ITINERARY_FACTS, destination: 'Synthetic City', startDate: '2026-12-10', endDate: '2026-12-13' };
      await one(OWNER, 'select public.itinerary_facts_save($1, $2, $3::jsonb, $4) as r', [doc.draftId, doc.rowVersion, JSON.stringify(factsPayload(facts)), null]);
      const job = await one<{ jobId: string }>(OWNER, 'select public.itinerary_render_request($1, $2, $3, $4) as r', [doc.documentId, 'preview', 'a'.repeat(64), 'itinerary-2']);
      const worker = rpcAs(() => db, SVC);
      expect(await itineraryRenderInputForWorker({ jobId: job.jobId, worker: 'w1' }, worker)).toEqual({ status: 'conflict' }); // not claimed yet
      await one(SVC, 'select public.itinerary_render_claim($1, $2) as r', ['w1', 60]);
      const input = await itineraryRenderInputForWorker({ jobId: job.jobId, worker: 'w1' }, worker);
      // DEAL has no booking draft here, so the basis has no prices (DEC-48 money null).
      expect(input).toMatchObject({ status: 'running', jobId: job.jobId, documentId: doc.documentId, kind: 'preview', templateVersion: 'itinerary-2', factsChanged: false, basisChanged: false, title: 'Synthetic itinerary', money: null });
      if (input.status !== 'running') throw new Error('not running');
      expect(input.facts.destination).toBe('Synthetic City');
      expect(await itineraryRenderInputForWorker({ jobId: job.jobId, worker: 'other' }, worker)).toEqual({ status: 'conflict' });
      // A staff session cannot run it at all (service_role only).
      await expect(itineraryRenderInputForWorker({ jobId: job.jobId, worker: 'w1' }, rpcAs(() => db, OWNER))).rejects.toThrow('itinerary_render_input failed');
    });
  });
});

describe('render worker claim and complete', () => {
  it('claim → input → upload → complete succeeded; a failure is queued for retry; nothing to claim → null', async () => {
    await asOwner(db, async () => {
      const worker = rpcAs(() => db, SVC);
      await owner(`update public.itinerary_render_jobs set status = 'failed', lease_owner = null, lease_until = null, finished_at = now() where status in ('queued', 'running')`);
      expect(await itineraryRenderClaimForWorker({ worker: 'w1', leaseSeconds: 60 }, worker)).toBeNull();

      const doc = await one<{ documentId: string; draftId: string; rowVersion: number }>(OWNER, 'select public.itinerary_document_create($1, $2, $3, $4) as r', ['deal', DEAL, 'Synthetic itinerary', rid()]);
      const facts = { ...EMPTY_ITINERARY_FACTS, destination: 'Synthetic City' };
      await one(OWNER, 'select public.itinerary_facts_save($1, $2, $3::jsonb, $4) as r', [doc.draftId, doc.rowVersion, JSON.stringify(factsPayload(facts)), null]);
      const job = await one<{ jobId: string }>(OWNER, 'select public.itinerary_render_request($1, $2, $3, $4) as r', [doc.documentId, 'preview', 'b'.repeat(64), 'itinerary-2']);

      const claim = await itineraryRenderClaimForWorker({ worker: 'w1', leaseSeconds: 60 }, worker);
      expect(claim).toMatchObject({ jobId: job.jobId, documentId: doc.documentId, kind: 'preview', templateVersion: 'itinerary-2', attempts: 1 });
      // The claim names the upload path (Atlas 90bab31); it is the one complete accepts.
      const [row] = await owner<{ entity: string }>('select legal_entity_id::text as entity from public.itinerary_render_jobs where id = $1', [job.jobId]);
      expect(claim!.objectPath).toBe(renderedObjectPath(row!.entity, doc.documentId, job.jobId));
      const objectPath = claim!.objectPath!;
      expect(await itineraryRenderInputForWorker({ jobId: job.jobId, worker: 'w1' }, worker)).toMatchObject({ status: 'running', jobId: job.jobId });

      // A failure first: queued again for a retry.
      expect(await itineraryRenderCompleteForWorker({ jobId: job.jobId, worker: 'w1', outcome: { ok: false, errorCode: 'browser_failed' } }, worker)).toEqual({ status: 'queued', jobId: job.jobId, errorCode: 'browser_failed' });
      await owner(`update public.itinerary_render_jobs set available_at = now() - interval '1 second' where id = $1`, [job.jobId]);
      expect(await itineraryRenderClaimForWorker({ worker: 'w2', leaseSeconds: 60 }, worker)).toMatchObject({ jobId: job.jobId, attempts: 2 });
      expect(await itineraryRenderCompleteForWorker({ jobId: job.jobId, worker: 'w1', outcome: { ok: false, errorCode: 'internal' } }, worker)).toEqual({ status: 'conflict' });

      await owner(`insert into storage.objects (bucket_id, name, metadata) values ('rendered-documents', $1, jsonb_build_object('size', 52000::bigint))`, [objectPath]);
      const done = await itineraryRenderCompleteForWorker(
        { jobId: job.jobId, worker: 'w2', outcome: { ok: true, file: { objectPath, sha256: 'c'.repeat(64), sizeBytes: 52000, pageCount: 4, qa: { placeholders: 1, layoutIssues: [], safetyHits: [] } } } },
        worker,
      );
      expect(done).toMatchObject({ status: 'succeeded', jobId: job.jobId, renderedId: expect.any(String) });

      // A deterministic failure ends the job at once (no retry), Atlas 5d321b3.
      const job2 = await one<{ jobId: string }>(OWNER, 'select public.itinerary_render_request($1, $2, $3, $4) as r', [doc.documentId, 'preview', 'd'.repeat(64), 'itinerary-2']);
      expect(await itineraryRenderClaimForWorker({ worker: 'w3', leaseSeconds: 60 }, worker)).toMatchObject({ jobId: job2.jobId, attempts: 1 });
      expect(await itineraryRenderCompleteForWorker({ jobId: job2.jobId, worker: 'w3', outcome: { ok: false, errorCode: 'text_clipped' } }, worker)).toEqual({ status: 'failed', jobId: job2.jobId, errorCode: 'text_clipped' });

      // Bad reports are refused before any call.
      await expect(itineraryRenderCompleteForWorker({ jobId: job.jobId, worker: 'w2', outcome: { ok: false, errorCode: 'lease_expired' as never } }, worker)).rejects.toThrow('itinerary_render_complete failed: errorCode');
      await expect(itineraryRenderClaimForWorker({ worker: 'w2', leaseSeconds: 5 }, worker)).rejects.toThrow('itinerary_render_claim failed: leaseSeconds');
      // Staff sessions cannot run the worker commands.
      await expect(itineraryRenderClaimForWorker({ worker: 'w3', leaseSeconds: 60 }, rpcAs(() => db, OWNER))).rejects.toThrow('itinerary_render_claim failed (42501)');
    });
  });
});

describe('render worker input with prices (DEC-48)', () => {
  it('a requester who may read prices: the worker gets the booking selling total and plan through the wrapper', async () => {
    await asOwner(db, async () => {
      const ready = await h.readyPackage(OWNER, DEAL, ['hotel']);
      const doc = await one<{ documentId: string; draftId: string; rowVersion: number }>(OWNER, 'select public.itinerary_document_create($1, $2, $3, $4) as r', ['deal', DEAL, 'Synthetic priced', rid()]);
      await one(OWNER, 'select public.itinerary_facts_save($1, $2, $3::jsonb, $4) as r', [doc.draftId, doc.rowVersion, JSON.stringify(factsPayload({ ...EMPTY_ITINERARY_FACTS, destination: 'Synthetic City' })), null]);
      const job = await one<{ jobId: string }>(OWNER, 'select public.itinerary_render_request($1, $2, $3, $4) as r', [doc.documentId, 'preview', 'e'.repeat(64), 'itinerary-2']);
      await owner(`update public.itinerary_render_jobs set status = 'cancelled', lease_owner = null, lease_until = null, finished_at = now() where status in ('queued', 'running') and id <> $1`, [job.jobId]);
      const worker = rpcAs(() => db, SVC);
      expect(await itineraryRenderClaimForWorker({ worker: 'wp', leaseSeconds: 60 }, worker)).toMatchObject({ jobId: job.jobId });
      const input = await itineraryRenderInputForWorker({ jobId: job.jobId, worker: 'wp' }, worker);
      expect(input).toMatchObject({ status: 'running', money: { source: 'booking_version', versionId: ready.versionId, sellingTotalPaise: '9876543' } });
      expect(JSON.stringify(input)).not.toMatch(/cost|margin|budget/i);
    });
  });
});
