import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Actor, FIXTURE_USERS as U, type TestDb, asOwner, claimsFor, createTestDb, resetActor } from '../helpers/db';
import {
  ACCOUNTS, ANON, DEAL, DEAL_AMD, FLIGHT_CLAIM_SQL, FLIGHT_FACTS, HOTEL, MANAGER, MANAGER_AMD, OWNER, PURCHASE,
  PURCHASE_CLAIM_SQL, SALES_AMD, SALES_B, SUPER, SVC, rid,
} from './b1-support';
import { DESK, SETTING_SQL_B11, SWITCH_REASON, TRAVELLERS, VISA, VISA_CLAIM_SQL, b11Helpers } from './b11-support';

/**
 * Direction A Batch 1 B1-2 (migration 20261121000110_deal_documents_read):
 * public.deal_documents_list(deal) lists exactly the stored files of the Deal
 * that the caller can download through each kind's existing authorizer
 * ("list equals download"), for every role fixture, assigned and not assigned.
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
const { one, refused, owner } = h;

const LIST_SQL = 'select public.deal_documents_list($1) as r';
const AUTHORIZER: Record<string, string> = {
  id_proof: 'traveller_id_proof_authorize_download',
  booking_file: 'booking_authorize_evidence_download',
  quotation_acceptance: 'quotation_evidence_authorize_download',
  itinerary_source: 'itinerary_source_authorize_download',
  itinerary_pdf: 'itinerary_rendered_authorize_download',
  purchase_file: 'purchase_evidence_authorize_download',
  department_file: 'department_evidence_authorize_download',
};
const CONTEXT_KEYS: Record<string, string[]> = {
  id_proof: ['travellerSeq'],
  booking_file: ['evidenceKind', 'versionNo'],
  quotation_acceptance: ['evidenceKind', 'quotationReference', 'versionNo'],
  itinerary_source: ['documentId'],
  itinerary_pdf: ['documentId', 'pdfKind'],
  purchase_file: ['department', 'fileKind'],
  department_file: ['department', 'fileKind'],
};

type FileRow = { kind: string; id: string; fileName: string; mime: string; uploadedAt: string; context: Record<string, unknown> };
type Listed = { files: FileRow[] };

/** Second Flight person: the moved-staff fixture (active profile) gets a Flight membership. */
const FLIGHT_USER: Actor = { userId: U.movedStaff };

const list = (actor: Actor, deal: string = DEAL) => one<Listed>(actor, LIST_SQL, [deal]);

/** Whether the existing authorizer lets the actor open the file (42501/P0002 = no). */
async function canDownload(actor: Actor, kind: string, id: string): Promise<boolean> {
  await db.exec('savepoint dl');
  try {
    await h.run(actor, `select public.${AUTHORIZER[kind]}($1) as r`, [id]);
    await db.exec('release savepoint dl');
    return true;
  } catch (e) {
    await db.exec('rollback to savepoint dl');
    const code = (e as { code?: string }).code;
    if (code === '42501' || code === 'P0002' || code === '55000') return false;
    throw e;
  }
}

/** Every stored file of the Deal, of every kind, as the database owner sees it. */
async function allFiles(deal: string): Promise<Array<{ kind: string; id: string }>> {
  return owner<{ kind: string; id: string }>(
    `with q as (select id from public.quotations where deal_id = $1 or linked_deal_id = $1),
          doc as (select id from public.itinerary_documents where deal_id = $1 or quotation_id in (select id from q)),
          t as (select id from public.fulfilment_tasks where deal_id = $1)
     select 'id_proof' as kind, id from public.traveller_id_proofs where deal_id = $1 and status = 'stored'
     union all select 'booking_file', id from public.booking_evidence where deal_id = $1 and status = 'stored'
     union all select 'quotation_acceptance', id from public.quotation_evidence where quotation_id in (select id from q) and status = 'stored'
     union all select 'itinerary_source', id from public.itinerary_source_files where document_id in (select id from doc) and status = 'stored'
     union all select 'itinerary_pdf', id from public.itinerary_rendered_documents where document_id in (select id from doc)
     union all select 'purchase_file', id from public.purchase_evidence where task_id in (select id from t) and status = 'stored'
     union all select 'department_file', id from public.department_evidence where task_id in (select id from t) and status = 'stored'
     order by 1, 2`,
    [deal],
  );
}

/**
 * The Deal with one stored file of every kind: ID proofs per traveller, a
 * booking acceptance proof and a booking payment proof, a quotation
 * acceptance file, a Deal itinerary source file and rendered PDF, a quotation
 * itinerary source file, Purchase files and Flight / Visa desk files; tasks
 * not yet taken by anyone.
 */
async function dealWithEveryFile() {
  await h.addFlight(U.movedStaff);
  // The moved-staff fixture also holds Deal read grants; as a Flight-only person here it holds none.
  await owner(`update public.access_grants set revoked_at = now(), revoked_by = $2, revocation_reason = 'Synthetic revocation for the test'
               where user_id = $1 and revoked_at is null`, [U.movedStaff, U.adminJodhpur]);
  const [entity] = await owner<{ id: string }>('select legal_entity_id as id from public.deals where id = $1', [DEAL]);
  const le = entity!.id;

  // Quotation of the Deal with an acceptance file (stored).
  const quote = await one<{ quotationId: string; versionId: string }>(OWNER, 'select public.quotation_create($1, $2, $3, $4) as r',
    ['deal', DEAL, 'Synthetic quote', rid()]);
  const qev = rid();
  await owner(
    `insert into public.quotation_evidence (id, quotation_version_id, quotation_id, legal_entity_id, kind, object_path, file_name, mime,
       size_bytes, sha256, status, uploaded_by, stored_at)
     values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'acceptance_message', $4::text || '/' || $3::text || '/' || $2::text || '/' || $1::text, 'customer-yes.pdf', 'application/pdf',
       2048, repeat('e', 64), 'stored', $5, now())`,
    [qev, quote.versionId, quote.quotationId, le, U.salesDelhiA]);

  // Deal itinerary: a source file and a rendered preview; a quotation itinerary: a source file.
  const doc = await one<{ documentId: string; draftId: string; rowVersion: number }>(OWNER,
    'select public.itinerary_document_create($1, $2, $3, $4) as r', ['deal', DEAL, 'Synthetic itinerary', rid()]);
  const qdoc = await one<{ documentId: string }>(OWNER,
    'select public.itinerary_document_create($1, $2, $3, $4) as r', ['quotation', quote.quotationId, 'Synthetic quote itinerary', rid()]);
  for (const [d, name] of [[doc.documentId, 'hotel-voucher.pdf'], [qdoc.documentId, 'quote-notes.pdf']] as const) {
    const sid = rid();
    await owner(
      `insert into public.itinerary_source_files (id, document_id, legal_entity_id, object_path, file_name, mime, size_bytes, sha256,
         status, uploaded_by, stored_at)
       values ($1::uuid, $2::uuid, $3::uuid, $3::text || '/' || $2::text || '/' || $1::text, $4, 'application/pdf', 2048, repeat('f', 64), 'stored', $5, now())`,
      [sid, d, le, name, U.salesDelhiA]);
  }
  await one(OWNER, 'select public.itinerary_facts_save($1, $2, $3::jsonb, $4) as r',
    [doc.draftId, doc.rowVersion, JSON.stringify({ destination: 'Synthetic City', startDate: '2026-12-10', endDate: '2026-12-13' }), null]);
  const job = await one<{ jobId: string }>(OWNER, 'select public.itinerary_render_request($1, $2, $3, $4) as r',
    [doc.documentId, 'preview', 'a'.repeat(64), 'v1']);
  await one(SVC, 'select public.itinerary_render_claim($1, $2) as r', ['w-docs', 60]);
  const path = `${le}/${doc.documentId}/${job.jobId}.pdf`;
  await owner(`insert into storage.objects (bucket_id, name, metadata) values ('rendered-documents', $1, jsonb_build_object('size', 5000::bigint))`, [path]);
  await one(SVC, 'select public.itinerary_render_complete($1, $2, $3, $4, $5::jsonb) as r', [job.jobId, 'w-docs', true, null,
    JSON.stringify({ objectPath: path, sha256: 'd'.repeat(64), sizeBytes: 5000, pageCount: 3, qa: { placeholders: 1, layoutIssues: [], safetyHits: [] } })]);

  // Package with hotel, flight and visa; ID proofs and identities; acceptance plus a payment proof; confirm.
  const n = TRAVELLERS.length;
  const ready = await h.readyDraft(OWNER, DEAL, [['hotel', { ...HOTEL, adults: n, children: 0 }], ['flight', FLIGHT_FACTS], ['visa', VISA]],
    { identities: true });
  expect(ready.issues).toEqual([]);
  await h.storeEvidence(OWNER, ready.versionId, 'payment_proof', 'c'.repeat(64));
  const hash = (await h.readiness(OWNER, ready.versionId)).contentHash;
  await h.confirm(OWNER, ready.versionId, hash);
  await one(SUPER, SETTING_SQL_B11, ['visa_passport_tasks_enabled', true, SWITCH_REASON]);
  const tasks = await owner<{ id: string; department: string }>('select id, department from public.fulfilment_tasks where deal_id = $1 order by department', [DEAL]);
  const task = (dep: string) => tasks.find((t) => t.department === dep)!.id;
  expect(new Set(tasks.map((t) => t.department))).toEqual(new Set(['purchase', 'flight', 'visa']));

  const pev = rid();
  await owner(
    `insert into public.purchase_evidence (id, task_id, legal_entity_id, kind, object_path, file_name, mime, size_bytes, sha256, status, uploaded_by, stored_at)
     values ($1::uuid, $2::uuid, $3::uuid, 'supplier_confirmation', $3::text || '/' || $2::text || '/' || $1::text, 'supplier-ok.pdf', 'application/pdf', 2048, repeat('a', 64), 'stored', $4, now())`,
    [pev, task('purchase'), le, U.purchaseJodhpur]);
  for (const [dep, kind, name] of [['flight', 'other', 'e-ticket.pdf'], ['visa', 'fee_receipt', 'visa-fee.pdf']] as const) {
    await owner(
      `insert into public.department_evidence (id, task_id, legal_entity_id, kind, object_path, file_name, mime, size_bytes, sha256, status, uploaded_by, stored_at)
       values ($1::uuid, $2::uuid, $3::uuid, $4, $3::text || '/' || $2::text || '/' || $1::text, $5, 'application/pdf', 2048, repeat('b', 64), 'stored', $6, now())`,
      [rid(), task(dep), le, kind, name, U.salesDelhiA]);
  }
  return { tasks: { purchase: task('purchase'), flight: task('flight'), visa: task('visa') } };
}

/** Role fixtures (names for failure messages). */
async function roleFixtures(): Promise<Array<[string, Actor]>> {
  await h.addSalesAssignee(DEAL, U.salesDelhiB);
  // A live cross-branch grant: the Ahmedabad Manager may read Delhi Deals.
  await owner(`insert into public.access_grants (user_id, legal_entity_id, branch_id, permission_code, granted_by, reason)
               select $1, d.legal_entity_id, d.branch_id, 'deal.read', $2, 'Synthetic cross-branch grant for the test'
               from public.deals d where d.id = $3`, [MANAGER_AMD.userId, SUPER.userId, DEAL]);
  return [
    ['sales owner', OWNER], ['assigned sales holder (price access)', SALES_B], ['branch manager not on the deal (no price access)', MANAGER],
    ['manager with cross-branch grant', MANAGER_AMD], ['purchase', PURCHASE], ['flight', FLIGHT_USER], ['visa desk', DESK],
    ['accounts', ACCOUNTS], ['super admin', SUPER], ['other branch sales', SALES_AMD],
  ];
}

/** Whether the deals read policy shows the Deal to the actor (Data API path). */
async function readsDeal(actor: Actor, deal: string = DEAL): Promise<boolean> {
  return (await h.run<{ id: string }>(actor, 'select id from public.deals where id = $1', [deal])).length === 1;
}

/**
 * List equals download on a Deal the actor can read (Echo M1: on a Deal
 * outside the actor's Deal read the list is empty, whatever the downloads
 * would allow, so the read is not an existence oracle).
 */
async function expectListEqualsDownload(roles: Array<[string, Actor]>, stage: string) {
  const files = await allFiles(DEAL);
  const results: Record<string, string[]> = {};
  for (const [name, actor] of roles) {
    const listed = (await list(actor)).files;
    const listedKeys = listed.map((f) => `${f.kind}:${f.id}`).sort();
    const downloadable: string[] = [];
    if (await readsDeal(actor)) {
      for (const f of files) if (await canDownload(actor, f.kind, f.id)) downloadable.push(`${f.kind}:${f.id}`);
    }
    expect({ role: `${name} (${stage})`, files: listedKeys }).toEqual({ role: `${name} (${stage})`, files: downloadable.sort() });
    results[name] = [...new Set(listed.map((f) => f.kind))].sort();
  }
  return results;
}

describe('list equals download', () => {
  it('for every role, before and after the department tasks are taken', async () => {
    await asOwner(db, async () => {
      const { tasks } = await dealWithEveryFile();
      const roles = await roleFixtures();
      const files = await allFiles(DEAL);
      expect(new Set(files.map((f) => f.kind)).size).toBe(7);

      // Not assigned: Purchase, Flight and Visa hold the role but have not taken a task.
      const before = await expectListEqualsDownload(roles, 'not assigned');
      expect(before['sales owner']).toEqual(['booking_file', 'id_proof', 'itinerary_pdf', 'itinerary_source', 'quotation_acceptance']);
      expect(before['branch manager not on the deal (no price access)']).toEqual(
        ['booking_file', 'department_file', 'id_proof', 'itinerary_pdf', 'itinerary_source', 'purchase_file', 'quotation_acceptance']);
      expect(before.purchase).toEqual(['purchase_file']);
      // Flight and Visa holders not on the Deal cannot open it, so they list nothing (Echo M1), although a
      // department download would pass for them (shown in the M1 test below).
      expect(before.flight).toEqual([]);
      expect(before['visa desk']).toEqual([]);
      expect(before['super admin']).toEqual([]);
      expect(before['other branch sales']).toEqual([]);

      // Assigned: each department takes its task (ID proofs open to assignees, DEC-41).
      await one(PURCHASE, PURCHASE_CLAIM_SQL, [tasks.purchase]);
      await one(FLIGHT_USER, FLIGHT_CLAIM_SQL, [tasks.flight]);
      await one(DESK, VISA_CLAIM_SQL, [tasks.visa]);
      const after = await expectListEqualsDownload(roles, 'assigned');
      expect(after.purchase).toEqual(['id_proof', 'purchase_file']);
      expect(after.flight).toEqual(['department_file', 'id_proof']);
      expect(after['visa desk']).toEqual(['department_file', 'id_proof']);
      expect(after['super admin']).toEqual([]);
    });
  });

  it('Purchase never receives booking files, quotation files or their names, even when assigned', async () => {
    await asOwner(db, async () => {
      const { tasks } = await dealWithEveryFile();
      await one(PURCHASE, PURCHASE_CLAIM_SQL, [tasks.purchase]);
      const raw = JSON.stringify(await list(PURCHASE));
      expect(raw).not.toMatch(/booking_file|quotation_acceptance|acceptance\.pdf|customer-yes|payment_proof|hotel-voucher|quote-notes|itinerary/);
      // Sales never receives Purchase files.
      expect(JSON.stringify(await list(OWNER))).not.toMatch(/purchase_file|supplier-ok/);
    });
  });

  /** authz.can_read_deal_commercial for the actor (evaluated as the owner with the actor's claims). */
  async function hasPriceAccess(actor: Actor): Promise<boolean> {
    await resetActor(db);
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claimsFor(actor))]);
    const [row] = await owner<{ ok: boolean }>('select coalesce(authz.can_read_deal_commercial($1), false) as ok', [DEAL]);
    await resetActor(db);
    return row!.ok;
  }

  it('Mercury P11: an assigned Sales holder (price access) and a branch Manager not on the Deal (no price access) both list the booking payment proof exactly as the handler allows', async () => {
    await asOwner(db, async () => {
      await dealWithEveryFile();
      await h.addSalesAssignee(DEAL, U.salesDelhiB);
      const [proof] = await owner<{ id: string }>(`select id from public.booking_evidence where deal_id = $1 and kind = 'payment_proof'`, [DEAL]);
      // Who is who: the assigned Sales holder has price access; the branch Manager is neither owner nor assignee and has none.
      expect(await hasPriceAccess(SALES_B)).toBe(true);
      expect(await hasPriceAccess(MANAGER)).toBe(false);
      expect(await owner('select 1 from public.deal_assignments where deal_id = $1 and user_id = $2 and ended_at is null', [DEAL, U.managerDelhi])).toEqual([]);
      for (const actor of [SALES_B, MANAGER]) {
        const listed = (await list(actor)).files.find((f) => f.id === proof!.id);
        expect(await canDownload(actor, 'booking_file', proof!.id)).toBe(true);
        expect(listed?.context).toEqual({ versionNo: 1, evidenceKind: 'payment_proof' });
      }
    });
  });
});

describe('shape, refusals and no oracle', () => {
  it('rows carry only the allowlisted keys; links are built from kind and id', async () => {
    await asOwner(db, async () => {
      await dealWithEveryFile();
      const { files } = await list(MANAGER);
      expect(files.length).toBeGreaterThan(0);
      for (const f of files) {
        expect(Object.keys(f).sort()).toEqual(['context', 'fileName', 'id', 'kind', 'mime', 'uploadedAt']);
        expect(Object.keys(f.context).sort()).toEqual(CONTEXT_KEYS[f.kind]);
      }
      const raw = JSON.stringify(files);
      expect(raw).not.toMatch(/objectPath|object_path|sha256|uploadedBy|consent|sizeBytes|a0000000-0000-4000-8000/);
      const pdf = files.find((f) => f.kind === 'itinerary_pdf')!;
      expect(pdf.fileName).toMatch(/^itinerary-preview-\d{8}\.pdf$/);
      expect(pdf.context.pdfKind).toBe('preview');
      // Newest first.
      const times = files.map((f) => Date.parse(f.uploadedAt));
      expect([...times].sort((a, b) => b - a)).toEqual(times);
    });
  });

  it('Echo M1: Purchase, Flight, Visa and Accounts on a Deal outside their Deal read get the same empty list, even where a download would pass', async () => {
    await asOwner(db, async () => {
      await dealWithEveryFile();
      // Purchase loses its fixture assignment; Accounts loses its entity-wide read grant.
      await owner(`update public.deal_assignments set ended_at = now() where deal_id = $1 and user_id = $2 and ended_at is null`, [DEAL, U.purchaseJodhpur]);
      await owner(`update public.access_grants set revoked_at = now(), revoked_by = $2, revocation_reason = 'Synthetic revocation for the test'
                   where user_id = $1 and permission_code = 'deal.read' and revoked_at is null`, [U.accountsJodhpur, U.adminJodhpur]);
      const outsiders: Array<[string, Actor, string]> = [
        ['purchase', PURCHASE, 'purchase_file'], ['flight', FLIGHT_USER, 'department_file'], ['visa desk', DESK, 'department_file'],
        ['accounts', ACCOUNTS, 'id_proof'],
      ];
      const fileOf = async (label: string, kind: string): Promise<string> => {
        if (kind === 'purchase_file') return (await allFiles(DEAL)).find((x) => x.kind === kind)!.id;
        const department = label === 'flight' ? 'flight' : 'visa';
        const [row] = await owner<{ id: string }>(
          `select e.id from public.department_evidence e join public.fulfilment_tasks t on t.id = e.task_id
           where t.deal_id = $1 and t.department = $2`, [DEAL, department]);
        return row!.id;
      };
      for (const [label, actor, kind] of outsiders) {
        expect({ label, reads: await readsDeal(actor) }).toEqual({ label, reads: false });
        // Purchase, Flight and Visa would still pass a download handler for their kind (no download rule changes here).
        if (label !== 'accounts') {
          expect({ label, download: await canDownload(actor, kind, await fileOf(label, kind)) }).toEqual({ label, download: true });
        }
        expect({ label, list: await list(actor) }).toEqual({ label, list: { files: [] } });
      }
    });
  });

  it('a removed Deal, an unreadable Deal and an unknown id answer the same empty list', async () => {
    await asOwner(db, async () => {
      await dealWithEveryFile();
      expect(await list(SALES_AMD)).toEqual({ files: [] });
      expect(await list(OWNER, rid())).toEqual({ files: [] });
      expect(await list(OWNER, DEAL_AMD)).toEqual({ files: [] });
      expect(await list(OWNER, null as unknown as string)).toEqual({ files: [] });
      // The fixture Deal is synthetic; drop the imported-only check inside the rolled-back transaction (as b1-confirm-tasks does).
      await owner('alter table public.deals drop constraint deals_removed_imported_only');
      await owner(`update public.deals set removed_at = now(), removed_reason = 'stage_not_eligible' where id = $1`, [DEAL]);
      for (const actor of [OWNER, MANAGER, PURCHASE, ACCOUNTS]) expect(await list(actor)).toEqual({ files: [] });
    });
  });

  it('reads write nothing; anon and aal1 are refused', async () => {
    await asOwner(db, async () => {
      await dealWithEveryFile();
      const audit = await h.count('select 1 from public.audit_events');
      const versions = await owner('select id, row_version, updated_at from public.booking_versions where deal_id = $1 order by id', [DEAL]);
      for (const actor of [OWNER, MANAGER, PURCHASE, DESK, ACCOUNTS, SUPER]) await list(actor);
      expect(await h.count('select 1 from public.audit_events')).toBe(audit);
      expect(await owner('select id, row_version, updated_at from public.booking_versions where deal_id = $1 order by id', [DEAL])).toEqual(versions);
      await refused(ANON, LIST_SQL, [DEAL], '42501');
      await refused({ userId: U.salesDelhiA, aal: 'aal1' }, LIST_SQL, [DEAL], '42501', 'not_authorized');
    });
  });

  it('is a definer function with an empty search path, executable by authenticated only', async () => {
    await asOwner(db, async () => {
      const [fn] = await owner<{ definer: boolean; config: string[]; volatile: string; auth: boolean; svc: boolean; anon: boolean }>(
        `select p.prosecdef as definer, p.proconfig as config, p.provolatile as volatile,
                has_function_privilege('authenticated', p.oid, 'execute') as auth,
                has_function_privilege('service_role', p.oid, 'execute') as svc,
                has_function_privilege('anon', p.oid, 'execute') as anon
         from pg_proc p where p.oid = 'public.deal_documents_list(uuid)'::regprocedure`);
      expect(fn).toEqual({ definer: true, config: ['search_path=""'], volatile: 's', auth: true, svc: false, anon: false });
    });
  });
});
