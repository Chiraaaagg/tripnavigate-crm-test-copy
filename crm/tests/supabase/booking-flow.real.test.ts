import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { isRealStackRequired } from '@/lib/config';
import type { ViewerAccess } from '@/modules/access/policy';
import { EVIDENCE_BUCKET } from '@/modules/fulfilment/contracts';
import { FIXTURE_EMAILS, FIXTURE_USERS } from '../helpers/db';
import { createRealStack, resolveRealStackEnv, type SignedIn } from '../helpers/real-stack';

/**
 * Phase 3 booking flow against the REAL local Supabase stack (PostgREST +
 * Postgres + Storage), driving agent A's actual server actions, queries and
 * evidence download handler. Only the Next.js request plumbing is replaced:
 *   - requireStaff() returns the signed-in aal2 client of the current actor;
 *   - the privileged client factory returns the stack's service-role client;
 *   - revalidatePath is a no-op.
 * The database (agent B's commands, RLS, storage bucket) is the real thing.
 *
 * Flow: open draft → save facts (a save without the selling field keeps the
 * amount, A4 M3) → confirm refused (no proof) → bad file refused
 * before storage → proof uploaded → stale hash refused → confirm creates one task
 * → repeat is 'existing' → owner downloads via signed URL → Purchase is refused
 * the download and sees no commercial/evidence rows → Purchase claims the task
 * (idempotent) → another Sales user cannot claim.
 *
 * A fresh synthetic deal (owned by Synthetic Sales Delhi A) is inserted per run
 * and removed afterwards. FAILS (never skips) when REQUIRE_REAL_STACK=1 and
 * anything is missing.
 */

const env = resolveRealStackEnv();
const dbUrl = process.env.TEST_DATABASE_URL?.trim() ?? '';
if (env && !dbUrl && isRealStackRequired(process.env)) {
  throw new Error('REQUIRE_REAL_STACK=1 but TEST_DATABASE_URL is missing for the booking flow test');
}
const enabled = env !== null && dbUrl !== '';
if (enabled && !['127.0.0.1', 'localhost'].includes(new URL(dbUrl).hostname)) {
  throw new Error('booking flow setup/cleanup runs only against a local database');
}
const stack = env ? createRealStack(env) : null;

// --- Next.js plumbing replaced (see header) ---------------------------------
interface Actor {
  userId: string;
  signedIn: SignedIn;
  access: ViewerAccess;
}
let actor: Actor | null = null;
vi.mock('@/modules/identity/server/session', () => ({
  requireStaff: async () => {
    if (!actor) throw new Error('no actor');
    return { userId: actor.userId, supabase: actor.signedIn.client, access: actor.access };
  },
}));
vi.mock('@/lib/supabase/admin', () => ({ createSupabaseAdminClient: () => stack!.admin() }));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('@/lib/config', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/config')>();
  return { ...original, getAppConfig: () => ({ supabaseUrl: env?.url ?? 'http://127.0.0.1:54321' }) };
});

const actions = await import('@/modules/fulfilment/server/actions');
const queries = await import('@/modules/fulfilment/server/queries');
const { evidenceDownloadResponse } = await import('@/modules/fulfilment/server/evidence-download');

const DEAL = randomUUID();
const REFERENCE = `SYN-BOOK-${DEAL.slice(0, 8)}`;
const SELLING_RUPEES = '87654.32'; // 8765432 paise: must never reach Purchase
const SELLING_PAISE = '8765432';

const PDF = (() => {
  const head = new TextEncoder().encode('%PDF-1.7\n% synthetic proof for tests\n');
  const b = new Uint8Array(512);
  b.set(head);
  return b;
})();

function form(fields: Record<string, string | Blob>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

async function accessFor(userId: string): Promise<ViewerAccess> {
  const admin = stack!.admin();
  const [m, rp] = await Promise.all([
    admin.from('memberships').select('legal_entity_id, branch_id, role_code').eq('user_id', userId).eq('status', 'active'),
    admin.from('role_permissions').select('role_code, permission_code, scope'),
  ]);
  if (m.error || rp.error) throw m.error ?? rp.error;
  return {
    userId,
    memberships: (m.data ?? []).map((r) => ({ legalEntityId: r.legal_entity_id, branchId: r.branch_id, roleCode: r.role_code })),
    rolePermissions: (rp.data ?? []).map((r) => ({ roleCode: r.role_code, permissionCode: r.permission_code, scope: r.scope })),
    grants: [],
  };
}

async function signInActor(key: keyof typeof FIXTURE_USERS): Promise<Actor> {
  const userId = FIXTURE_USERS[key];
  return { userId, signedIn: await stack!.signInAal2(FIXTURE_EMAILS[key], userId), access: await accessFor(userId) };
}

/** The StaffContext subset the queries use, as requireStaff() would supply it. */
const staffOf = (a: Actor) => ({ supabase: a.signedIn.client, access: a.access }) as unknown as Parameters<typeof queries.loadPurchaseQueue>[0];

let owner: Actor;
let purchase: Actor;
let otherSales: Actor;
let versionId = '';
let evidenceId = '';
let objectPath = '';
let taskId = '';

beforeAll(async () => {
  if (!enabled) return;
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  try {
    await client.query(
      `insert into public.deals (id, legal_entity_id, branch_id, reference, title, owner_user_id, is_synthetic)
       select $1::uuid, b.legal_entity_id, b.id, $2, 'Synthetic booking flow deal', $3::uuid, true
       from public.branches b join public.legal_entities e on e.id = b.legal_entity_id
       where e.code = 'HOLIDAY_CHACHA' and b.code = 'DEL'`,
      [DEAL, REFERENCE, FIXTURE_USERS.salesDelhiA],
    );
  } finally {
    await client.end();
  }
  owner = await signInActor('salesDelhiA');
  purchase = await signInActor('purchaseJodhpur');
  otherSales = await signInActor('salesDelhiB');
});

afterAll(async () => {
  if (enabled) {
    if (objectPath) await stack!.admin().storage.from(EVIDENCE_BUCKET).remove([objectPath]).catch(() => undefined);
    const client = new pg.Client({ connectionString: dbUrl });
    await client.connect();
    try {
      await client.query('begin');
      // Confirmed versions are immutable by trigger: bypass triggers for test cleanup only.
      await client.query(`set local session_replication_role = replica`);
      await client.query(`delete from public.outbox_events where aggregate_id in (
          select id from public.booking_versions where deal_id = $1
          union select id from public.fulfilment_tasks where deal_id = $1)`, [DEAL]);
      await client.query(`delete from public.fulfilment_tasks where deal_id = $1`, [DEAL]);
      // B1 (20261118000100): the hotel confirmation also created the Deal's service item, its facts and the traveller snapshot.
      await client.query(`delete from public.service_item_facts where service_item_id in (select id from public.service_items where deal_id = $1)`, [DEAL]);
      await client.query(`delete from public.service_items where deal_id = $1`, [DEAL]);
      await client.query(`delete from public.booking_version_travellers where booking_version_id in (select id from public.booking_versions where deal_id = $1)`, [DEAL]);
      await client.query(`delete from public.deal_travellers where deal_id = $1`, [DEAL]);
      await client.query(`delete from public.booking_evidence where deal_id = $1`, [DEAL]);
      await client.query(
        `delete from public.booking_version_commercials where version_id in (select id from public.booking_versions where deal_id = $1)`,
        [DEAL],
      );
      await client.query(`delete from public.booking_versions where deal_id = $1`, [DEAL]);
      await client.query(`delete from public.deal_assignments where deal_id = $1`, [DEAL]);
      await client.query(`delete from public.deals where id = $1`, [DEAL]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  }
  await stack?.cleanup();
});

describe.skipIf(!enabled)('Phase 3 booking → Purchase task through Supabase (agent A actions)', () => {
  it('owner opens and saves a draft (idempotent open)', async () => {
    actor = owner;
    const opened = await actions.openBookingDraftAction(null, form({ dealId: DEAL }));
    expect(opened).toMatchObject({ ok: true, data: { versionNo: 1, created: true } });
    if (!opened.ok) return;
    versionId = opened.data.versionId;
    const again = await actions.openBookingDraftAction(null, form({ dealId: DEAL }));
    expect(again).toMatchObject({ ok: true, data: { versionId, created: false } });

    const saved = await actions.saveBookingDraftAction(
      null,
      form({
        dealId: DEAL,
        versionId,
        rowVersion: String(opened.data.rowVersion),
        hotelName: 'Synthetic Palace',
        city: 'Jaipur',
        checkIn: '2026-12-01',
        checkOut: '2026-12-04',
        rooms: '1',
        roomType: 'Deluxe',
        mealPlan: 'CP',
        adults: '2',
        children: '0',
        purchaseBudgetRupees: '15000',
        sellingTotalRupees: SELLING_RUPEES,
      }),
    );
    expect(saved).toMatchObject({ ok: true });
    // Stale row version → version_changed.
    const stale = await actions.saveBookingDraftAction(
      null,
      form({ dealId: DEAL, versionId, rowVersion: String(opened.data.rowVersion), hotelName: 'Other', sellingTotalRupees: SELLING_RUPEES }),
    );
    expect(stale).toMatchObject({ ok: false, code: 'version_changed' });

    // A4 M3: a save without the selling field (p_selling_total_provided=false) keeps the amount.
    if (!saved.ok) return;
    const factsOnly = await actions.saveBookingDraftAction(
      null,
      form({
        dealId: DEAL,
        versionId,
        rowVersion: String(saved.data.rowVersion),
        hotelName: 'Synthetic Palace',
        city: 'Jaipur',
        checkIn: '2026-12-01',
        checkOut: '2026-12-04',
        rooms: '1',
        roomType: 'Deluxe',
        mealPlan: 'CP',
        adults: '2',
        children: '0',
        purchaseBudgetRupees: '15000',
      }),
    );
    expect(factsOnly).toMatchObject({ ok: true });
    const kept = await queries.loadBookingForDeal(staffOf(owner), DEAL);
    expect(kept?.sellingTotalPaise).toBe(SELLING_PAISE);
  });

  it('P3-01: confirm without proof → not_ready with missing_acceptance_proof; no task', async () => {
    actor = owner;
    const panel = await queries.loadBookingForDeal(staffOf(owner), DEAL);
    expect(panel?.state).toBe('draft_needs_repair');
    expect(panel?.issues).toContain('missing_acceptance_proof');
    expect(panel?.sellingTotalPaise).toBe(SELLING_PAISE);
    const result = await actions.confirmBookingAction(null, form({ dealId: DEAL, versionId, contentHash: panel!.contentHash! }));
    expect(result).toMatchObject({ ok: false, code: 'not_ready', issues: expect.arrayContaining(['missing_acceptance_proof']) });
    const tasks = await stack!.admin().from('fulfilment_tasks').select('id').eq('deal_id', DEAL);
    expect(tasks.data).toEqual([]);
  });

  it('P3-14: a file with wrong magic bytes is rejected before storage; a real PDF is stored', async () => {
    actor = owner;
    const fake = new File([new TextEncoder().encode('<html>not a pdf</html>')], 'x.pdf', { type: 'application/pdf' });
    const rejected = await actions.uploadBookingEvidenceAction(null, form({ dealId: DEAL, versionId, kind: 'ticket', file: fake }));
    expect(rejected).toMatchObject({ ok: false, code: 'evidence_rejected' });
    const none = await stack!.admin().from('booking_evidence').select('id').eq('deal_id', DEAL);
    expect(none.data).toEqual([]);

    const file = new File([PDF], 'Customer acceptance (synthetic).pdf', { type: 'application/pdf' });
    const stored = await actions.uploadBookingEvidenceAction(
      null,
      form({ dealId: DEAL, versionId, kind: 'acceptance_message', file }),
    );
    // H2: 'stored' only because the object really exists in Storage with the declared size.
    expect(stored).toMatchObject({ ok: true });
    if (!stored.ok) return;
    evidenceId = stored.data.evidenceId;
    const row = await stack!.admin().from('booking_evidence').select('status, object_path, file_name').eq('id', evidenceId).single();
    expect(row.data).toMatchObject({ status: 'stored', file_name: 'Customer acceptance synthetic.pdf' });
    objectPath = row.data!.object_path as string;
  });

  it('P3-02 / P3-03: stale hash → version_changed; confirm creates one task; repeat → existing', async () => {
    actor = owner;
    const panel = await queries.loadBookingForDeal(staffOf(owner), DEAL);
    expect(panel?.state).toBe('draft_ready');
    expect(panel?.canConfirm).toBe(true);

    const stale = await actions.confirmBookingAction(null, form({ dealId: DEAL, versionId, contentHash: 'f'.repeat(64) }));
    expect(stale).toMatchObject({ ok: false, code: 'version_changed' });

    const first = await actions.confirmBookingAction(null, form({ dealId: DEAL, versionId, contentHash: panel!.contentHash! }));
    expect(first).toMatchObject({ ok: true, data: { outcome: 'created', versionId } });
    if (!first.ok) return;
    // A hotel confirmation always creates the Purchase task (B1.1 widened taskId to nullable).
    taskId = first.data.taskId!;

    const repeat = await actions.confirmBookingAction(null, form({ dealId: DEAL, versionId, contentHash: panel!.contentHash! }));
    expect(repeat).toMatchObject({ ok: true, data: { outcome: 'existing', taskId } });

    const confirmed = await queries.loadBookingForDeal(staffOf(owner), DEAL);
    expect(confirmed).toMatchObject({ state: 'confirmed', canEdit: false, confirmed: { taskId, taskStatus: 'not_started' } });

    const reopen = await actions.openBookingDraftAction(null, form({ dealId: DEAL }));
    expect(reopen).toMatchObject({ ok: false, code: 'already_confirmed' });
  });

  it('owner downloads the proof through a short-lived signed URL', async () => {
    actor = owner;
    const res = await evidenceDownloadResponse(evidenceId);
    expect(res.status).toBe(302);
    expect(res.headers.get('cache-control')).toContain('no-store');
    const file = await fetch(res.headers.get('location')!);
    expect(file.status).toBe(200);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(PDF);
  });

  it('P3-07: Purchase is refused the download and reads no commercial or evidence rows', async () => {
    actor = purchase;
    const res = await evidenceDownloadResponse(evidenceId);
    expect(res.status).toBe(404);
    expect(res.headers.get('location')).toBeNull();

    const direct = await purchase.signedIn.client.storage.from(EVIDENCE_BUCKET).createSignedUrl(objectPath, 60);
    expect(direct.data?.signedUrl ?? null).toBeNull();
    const download = await purchase.signedIn.client.storage.from(EVIDENCE_BUCKET).download(objectPath);
    expect(download.data).toBeNull();

    for (const table of ['booking_evidence', 'booking_version_commercials', 'deal_commercials']) {
      const { data } = await purchase.signedIn.client.from(table).select('*').limit(50);
      expect(data ?? []).toEqual([]);
    }
  });

  it('P3-13: Purchase sees the task without selling price, claims it (idempotent); other Sales cannot', async () => {
    actor = purchase;
    const queue = await queries.loadPurchaseQueue(staffOf(purchase));
    const summary = queue.tasks.find((t) => t.taskId === taskId);
    expect(summary).toMatchObject({ dealReference: REFERENCE, nights: 3, purchaseBudgetPaise: '1500000', status: 'not_started' });
    const detail = await queries.loadPurchaseTask(staffOf(purchase), taskId);
    expect(detail).toMatchObject({ canClaim: true, versionNo: 1 });
    for (const dto of [queue, detail]) {
      const json = JSON.stringify(dto);
      expect(json).not.toContain(SELLING_PAISE);
      expect(json).not.toMatch(/selling|margin|evidence|objectPath/i);
    }

    const claimed = await actions.claimPurchaseTaskAction(null, form({ taskId }));
    expect(claimed).toMatchObject({ ok: true, data: { taskId, status: 'in_progress', alreadyYours: false } });
    const again = await actions.claimPurchaseTaskAction(null, form({ taskId }));
    expect(again).toMatchObject({ ok: true, data: { alreadyYours: true } });

    actor = otherSales;
    const refused = await actions.claimPurchaseTaskAction(null, form({ taskId }));
    expect(refused).toMatchObject({ ok: false });
    expect(refused.ok ? null : refused.code).toMatch(/not_authorized|not_found/);
  });
});
