import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Actor, type TestDb, asOwner, createTestDb, resetActor, setActor } from '../helpers/db';
import { ACC, EVISA, FLIGHT, MANAGER, OWNER, PURCHASE, VISA_A, dayFrom, passportOf, rid, visaHelpers } from './visa-e-support';
import type { RpcClient, RpcError } from '@/modules/fulfilment/commands';

/**
 * Visa build, track B: the server wrappers, zod result schemas, form parsers
 * and actions of src/modules/visa against the real Track A commands
 * (migrations 20261202000100..0199) on PGlite. The RPC client below runs each
 * call as `select public.<fn>(p_x => $1, ...)` under the impersonated actor,
 * inside one rolled-back owner transaction per test, exactly as PostgREST
 * would call it with the staff member's own session. Synthetic data only.
 */

const requireStaff = vi.fn();
vi.mock('@/modules/identity/server/session', () => ({ requireStaff: () => requireStaff() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
const storageUpload = vi.fn();
vi.mock('@/lib/supabase/admin', () => ({
  createSupabaseAdminClient: () => ({ storage: { from: () => ({ upload: (...args: unknown[]) => storageUpload(...args) }) } }),
}));

const cmd = await import('@/modules/visa/commands');
const actions = await import('@/modules/visa/server/actions');
const uploads = await import('@/modules/visa/server/evidence');
const { visaApplicantField, VISA_FIELD } = await import('@/modules/visa/contracts');
const queries = await import('@/modules/visa/server/queries');
const { departmentTaskHistory } = await import('@/modules/fulfilment/task-history');
const { accountsExpenseRecords } = await import('@/modules/finance/commands');
const { buildDealHistory, dealHistoryGroups } = await import('@/modules/deals/workspace');

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
}, 240_000);
afterAll(async () => {
  await db?.close();
});

const v = visaHelpers(() => db);

/** RpcClient over the test database as `actor` (savepoint per call: a refusal leaves the transaction usable). */
function rpcAs(actor: Actor): RpcClient {
  return {
    async rpc(fn: string, args: Record<string, unknown> = {}) {
      const keys = Object.keys(args);
      const sql = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`;
      const params = keys.map((k) => {
        const value = args[k];
        return value !== null && typeof value === 'object' ? JSON.stringify(value) : value;
      });
      await db.exec('savepoint visa_b_rpc');
      try {
        await setActor(db, actor);
        const rows = await db.query<{ r: unknown }>(sql, params);
        await resetActor(db);
        await db.exec('release savepoint visa_b_rpc');
        return { data: rows[0]?.r ?? null, error: null };
      } catch (e) {
        await db.exec('rollback to savepoint visa_b_rpc');
        await resetActor(db);
        const err = e as { code?: string; message?: string; hint?: string };
        return { data: null, error: { code: err.code, message: err.message, hint: err.hint ?? null } satisfies RpcError };
      }
    },
  };
}

function form(fields: Record<string, string | string[] | Blob>): FormData {
  const fd = new FormData();
  for (const [k, value] of Object.entries(fields)) {
    if (Array.isArray(value)) value.forEach((x) => fd.append(k, x));
    else fd.set(k, value);
  }
  return fd;
}

type AppRow = { id: string; traveller_seq: number; row_version: number; state: string };
const appsOf = (taskId: string) =>
  v.owner<AppRow>('select id, traveller_seq, row_version, state from public.visa_applications where task_id = $1 and superseded_at is null order by traveller_seq', [taskId]);
const docsOf = (applicationId: string) =>
  v.owner<{ id: string; label: string; status: string }>(
    'select id, label, status from public.visa_application_documents where application_id = $1 and removed_at is null order by created_at, label', [applicationId]);
const rowVersion = async (applicationId: string) =>
  (await v.owner<{ row_version: number }>('select row_version from public.visa_applications where id = $1', [applicationId]))[0]!.row_version;

beforeEach(() => {
  vi.clearAllMocks();
  requireStaff.mockImplementation(async () => ({ userId: VISA_A.userId, supabase: rpcAs(VISA_A) }));
  storageUpload.mockResolvedValue({ data: { path: 'x' }, error: null });
});

describe('visa wrappers against the Track A commands', () => {
  it('claim, row save, documents, clubbed Applied with replay, refusal mapping', { timeout: 180_000 }, async () => {
    await asOwner(db, async () => {
      const { taskId } = await v.stickerTask({ take: false });
      const rpc = rpcAs(VISA_A);

      // C1 through the action (requireStaff -> own session).
      const claimed = await actions.claimVisaTaskAction(null, form({ taskId }));
      expect(claimed).toMatchObject({ ok: true, data: { taskId, status: 'in_progress', alreadyYours: false } });
      expect(claimed.ok && claimed.data.applicationCount).toBe(4);
      const again = await cmd.visaTaskClaim(rpc, taskId);
      expect(again.alreadyYours).toBe(true);

      const [a1, a2, a3] = await appsOf(taskId);
      const docs1 = await docsOf(a1!.id);
      expect(docs1.map((d) => d.label)).toEqual(['Bank statement (6 months)', 'Passport copy (front and back)', 'Photo, white background']);

      // C2 through the action: presence-based fields, documents ticked, passport number normalised.
      const saved = await actions.saveVisaRowAction(null, form({
        taskId, applicationId: a1!.id, expectedRowVersion: String(a1!.row_version), requestId: rid(),
        appointmentDate: dayFrom(-1), appointmentTime: '9:30', passportNumber: 'z 99-88 776',
        documentIds: docs1.map((d) => d.id), receivedDocumentIds: docs1.map((d) => d.id), remark: 'Synthetic remark',
      }));
      expect(saved).toMatchObject({ ok: true, data: { ready: true, notReady: [] } });
      const ident = await v.owner<{ passport_number: string }>(
        `select i.passport_number from public.traveller_identities i join public.deal_travellers t on t.id = i.traveller_id
         join public.visa_applications a on a.deal_id = t.deal_id and a.traveller_seq = t.seq where a.id = $1`, [a1!.id]);
      expect(ident[0]?.passport_number).toBe('Z9988776');

      // Not-ready reason per row from the database.
      const partial = await cmd.visaApplicationSetRow(rpc, {
        applicationId: a2!.id, expectedRowVersion: a2!.row_version, fields: { appointmentDate: dayFrom(-1) }, requestId: rid(),
      });
      expect(partial).toMatchObject({ ready: false, notReady: ['documents_missing'] });

      // Stale row version -> version_changed with the frozen wording.
      const stale = await actions.saveVisaRowAction(null, form({
        taskId, applicationId: a2!.id, expectedRowVersion: String(a2!.row_version), requestId: rid(), remark: 'x',
      }));
      expect(stale).toMatchObject({ ok: false, code: 'version_changed', message: 'Someone changed this passenger meanwhile. Reload and try again.' });

      // C3 / C4: Other document (typed catalogue label takes its code), duplicate, remove.
      const added = await actions.addVisaDocumentAction(null, form({
        taskId, applicationId: a3!.id, expectedRowVersion: String(a3!.row_version), requestId: rid(), catalogueCode: 'other', label: '  synthetic   cover NOTE ',
      }));
      expect(added).toMatchObject({ ok: true, data: { outcome: 'created' } });
      const dup = await actions.addVisaDocumentAction(null, form({
        taskId, applicationId: a3!.id, expectedRowVersion: String(await rowVersion(a3!.id)), requestId: rid(), label: 'Synthetic cover note',
      }));
      expect(dup).toMatchObject({ ok: false, code: 'duplicate_document' });
      const byLabel = await actions.addVisaDocumentAction(null, form({
        taskId, applicationId: a3!.id, expectedRowVersion: String(await rowVersion(a3!.id)), requestId: rid(), label: 'pan card',
      }));
      expect(byLabel.ok).toBe(true);
      const pan = (await v.owner<{ catalogue_code: string | null }>(
        `select catalogue_code from public.visa_application_documents where application_id = $1 and label_key = 'pan card'`, [a3!.id]))[0];
      expect(pan?.catalogue_code).toBe('pan_card');
      const removed = await actions.removeVisaDocumentAction(null, form({
        taskId, documentId: added.ok ? added.data.documentId! : '', expectedRowVersion: String(await rowVersion(a3!.id)), requestId: rid(),
      }));
      expect(removed).toMatchObject({ ok: true });

      // Make a2 ready, then a clubbed Applied for a1 + a2 with one receipt and rupee input.
      const docs2 = await docsOf(a2!.id);
      await cmd.visaApplicationSetRow(rpc, {
        applicationId: a2!.id, expectedRowVersion: await rowVersion(a2!.id), fields: { documents: docs2.map((d) => ({ documentId: d.id, received: true })) },
        requestId: rid(),
      });
      // Receipt through the upload action (Storage mocked; finish recorded by the database).
      storageUpload.mockImplementation(async (path: string) => {
        await v.owner(`insert into storage.objects (bucket_id, name, metadata) values ('department-evidence', $1, jsonb_build_object('size', 9::bigint))`, [path]);
        return { data: { path }, error: null };
      });
      const pdf = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a])], 'synthetic receipt.pdf', { type: 'application/pdf' });
      const receipt = await uploads.uploadVisaEvidenceAction(null, form({ taskId, kind: 'fee_receipt', file: pdf }));
      expect(receipt).toMatchObject({ ok: true });
      const receiptId = receipt.ok ? receipt.data.evidenceId : '';

      const requestId = rid();
      const base: Record<string, string> = {
        taskId, requestId, applicantCount: '2', paidBy: 'company', paymentMode: 'upi', receiptEvidenceId: receiptId, passportTaken: 'on', remark: '',
      };
      // One money rule (D4): comma grouping is accepted, a rupee sign is not.
      const lines = [[a1!.id, 'SYN-REF-A1', '6,500', ''], [a2!.id, 'syn-ref-a2', '6500.50', '1,000']] as const;
      for (const [i, [id, ref, gov, svc]] of lines.entries()) {
        base[visaApplicantField(i, 'applicationId')] = id;
        base[visaApplicantField(i, 'expectedRowVersion')] = String(await rowVersion(id));
        base[visaApplicantField(i, 'reference')] = ref;
        base[visaApplicantField(i, 'appliedOn')] = dayFrom(0);
        base[visaApplicantField(i, 'governmentFee')] = gov;
        base[visaApplicantField(i, 'serviceFee')] = svc;
      }
      // The same fee typed with the rupee sign is refused before anything is written
      // (the cost-entry count below proves nothing was saved).
      const withSign = await actions.applyVisaApplicationsAction(null, form({
        ...base, requestId: rid(), [visaApplicantField(0, 'governmentFee')]: '₹6,500',
      }));
      expect(withSign).toMatchObject({ ok: false, message: 'Check the highlighted field.' });
      const applied = await actions.applyVisaApplicationsAction(null, form(base));
      expect(applied).toMatchObject({ ok: true, message: 'Saved as applied for 2 passengers. Waiting for the decision.' });
      expect(applied.ok && applied.data.clubId).toBeTruthy();
      expect(applied.ok && applied.data.entryIds.length).toBe(3);
      const fees = await v.owner<{ amount_paise: string; expense_status: string }>(
        `select amount_paise::text, expense_status from public.department_cost_entries where task_id = $1 order by amount_paise`, [taskId]);
      expect(fees).toEqual([
        { amount_paise: '100000', expense_status: 'submitted' },
        { amount_paise: '650000', expense_status: 'submitted' },
        { amount_paise: '650050', expense_status: 'submitted' },
      ]);
      // Same request id, same payload -> stored result (existing); other payload -> duplicate_request.
      const replay = await actions.applyVisaApplicationsAction(null, form(base));
      expect(replay).toMatchObject({ ok: true, data: { outcome: 'existing' } });
      const conflict = await actions.applyVisaApplicationsAction(null, form({ ...base, remark: 'changed' }));
      expect(conflict).toMatchObject({ ok: false, code: 'duplicate_request' });

      // not_ready with the applicant index and reason; a duplicate reference names the line.
      const a4 = (await appsOf(taskId))[3]!;
      const notReady = await actions.applyVisaApplicationsAction(null, form({
        taskId, requestId: rid(), applicantCount: '1', paidBy: 'customer_direct',
        [visaApplicantField(0, 'applicationId')]: a4.id, [visaApplicantField(0, 'expectedRowVersion')]: String(a4.row_version),
        [visaApplicantField(0, 'reference')]: 'SYN-REF-A4', [visaApplicantField(0, 'appliedOn')]: dayFrom(0),
        [visaApplicantField(0, 'governmentFee')]: '100',
      }));
      expect(notReady).toEqual({ ok: false, code: 'not_ready', message: 'Not ready to apply yet: documents not received.', fields: ['applicants[0]'] });
      const docs4 = await docsOf(a4.id);
      await cmd.visaApplicationSetRow(rpc, {
        applicationId: a4.id, expectedRowVersion: a4.row_version,
        fields: { appointmentDate: dayFrom(-1), documents: docs4.map((d) => ({ documentId: d.id, received: true })) }, requestId: rid(),
      });
      const dupRef = await actions.applyVisaApplicationsAction(null, form({
        taskId, requestId: rid(), applicantCount: '1', paidBy: 'customer_direct',
        [visaApplicantField(0, 'applicationId')]: a4.id, [visaApplicantField(0, 'expectedRowVersion')]: String(await rowVersion(a4.id)),
        [visaApplicantField(0, 'reference')]: 'syn-ref-A1', [visaApplicantField(0, 'appliedOn')]: dayFrom(0),
        [visaApplicantField(0, 'governmentFee')]: '100',
      }));
      expect(dupRef).toMatchObject({ ok: false, code: 'duplicate_reference', fields: ['applicants[0].reference'] });
      const future = await actions.applyVisaApplicationsAction(null, form({
        taskId, requestId: rid(), applicantCount: '1', paidBy: 'customer_direct',
        [visaApplicantField(0, 'applicationId')]: a4.id, [visaApplicantField(0, 'expectedRowVersion')]: String(await rowVersion(a4.id)),
        [visaApplicantField(0, 'reference')]: 'SYN-REF-A4', [visaApplicantField(0, 'appliedOn')]: dayFrom(1),
        [visaApplicantField(0, 'governmentFee')]: '100',
      }));
      expect(future).toMatchObject({ ok: false, code: 'applied_date_in_future', message: 'The applied date cannot be after today.' });
    });
  });

  it('decision, handover, delivery, withdraw, apply again, fee send, other cost, notice ack', { timeout: 180_000 }, async () => {
    await asOwner(db, async () => {
      const { taskId } = await v.stickerTask();
      const rpc = rpcAs(VISA_A);
      const a1 = await v.appliedAlone(taskId, 1);
      const a2 = await v.appliedAlone(taskId, 2, { reference: 'SYN-REF-2' });

      // Proof required: the action answers outcome_document_required before the database.
      const noProof = await actions.decideVisaApplicationAction(null, form({
        taskId, applicationId: a1.applicationId, expectedRowVersion: String(a1.rowVersion), requestId: rid(), decision: 'approved',
      }));
      expect(noProof).toMatchObject({ ok: false, code: 'outcome_document_required' });

      const proof1 = await v.evidence(VISA_A, taskId, 'authority_outcome', a1.applicationId);
      const approved = await actions.decideVisaApplicationAction(null, form({
        taskId, applicationId: a1.applicationId, expectedRowVersion: String(a1.rowVersion), requestId: rid(), decision: 'approved',
        outcomeEvidenceId: proof1, handoverMethod: 'courier', courierNumber: 'SYN-AWB-1',
      }));
      expect(approved).toMatchObject({ ok: true, data: { state: 'issued', closed: true }, message: 'Approval saved. This passenger is closed.' });

      const proof2 = await v.evidence(VISA_A, taskId, 'authority_outcome', a2.applicationId, 'c'.repeat(64));
      const rejected = await actions.decideVisaApplicationAction(null, form({
        taskId, applicationId: a2.applicationId, expectedRowVersion: String(a2.rowVersion), requestId: rid(), decision: 'rejected',
        outcomeEvidenceId: proof2, reason: 'Synthetic refusal reason',
      }));
      expect(rejected).toMatchObject({ ok: true, data: { state: 'refused', closed: false } });
      const rv2 = await rowVersion(a2.applicationId);
      const handover = await actions.setVisaHandoverAction(null, form({
        taskId, applicationId: a2.applicationId, expectedRowVersion: String(rv2), requestId: rid(), handoverMethod: 'office',
      }));
      expect(handover).toMatchObject({ ok: true, data: { closed: false } });
      const twice = await actions.setVisaHandoverAction(null, form({
        taskId, applicationId: a2.applicationId, expectedRowVersion: String(await rowVersion(a2.applicationId)), requestId: rid(), handoverMethod: 'office',
      }));
      expect(twice).toMatchObject({ ok: false, code: 'already_recorded' });
      const future = await actions.markVisaDeliveredAction(null, form({
        taskId, applicationId: a2.applicationId, expectedRowVersion: String(await rowVersion(a2.applicationId)), requestId: rid(), deliveredOn: dayFrom(1),
      }));
      expect(future).toMatchObject({ ok: false, code: 'delivered_date_in_future' });
      const delivered = await actions.markVisaDeliveredAction(null, form({
        taskId, applicationId: a2.applicationId, expectedRowVersion: String(await rowVersion(a2.applicationId)), requestId: rid(), deliveredOn: dayFrom(0),
      }));
      expect(delivered).toMatchObject({ ok: true, data: { closed: true } });

      // Apply again after the rejection (old one superseded).
      const re = await actions.reapplyVisaApplicationAction(null, form({
        taskId, applicationId: a2.applicationId, expectedRowVersion: String(await rowVersion(a2.applicationId)), requestId: rid(),
      }));
      expect(re).toMatchObject({ ok: true, data: { previousApplicationId: a2.applicationId, outcome: 'created' } });

      // Withdraw a not-applied passenger (reason + customer told).
      const a3 = (await appsOf(taskId)).find((a) => a.traveller_seq === 3)!;
      const noTick = await actions.withdrawVisaApplicationAction(null, form({
        taskId, applicationId: a3.id, expectedRowVersion: String(a3.row_version), requestId: rid(), reason: 'Synthetic: trip cancelled',
      }));
      expect(noTick).toMatchObject({ ok: false, code: 'invalid_input', fields: ['customerInformed'] });
      const withdrawn = await actions.withdrawVisaApplicationAction(null, form({
        taskId, applicationId: a3.id, expectedRowVersion: String(a3.row_version), requestId: rid(), reason: 'Synthetic: trip cancelled', customerInformed: 'on',
      }));
      expect(withdrawn).toMatchObject({ ok: true, data: { state: 'withdrawn', closed: true } });

      // Fee of a1 (draft, no receipt) -> Send to Accounts needs the receipt.
      const fee = (await v.owner<{ id: string; row_version: number }>(
        `select id, row_version from public.department_cost_entries where application_id = $1 and cost_kind = 'government_fee'`, [a1.applicationId]))[0]!;
      const noReceipt = await actions.sendVisaFeeAction(null, form({ taskId, entryId: fee.id, expectedRowVersion: String(fee.row_version), requestId: rid(), amount: '6,500' }));
      expect(noReceipt).toMatchObject({ ok: false, code: 'receipt_required' });
      const receiptId = await v.evidence(VISA_A, taskId, 'fee_receipt', null, 'd'.repeat(64));
      const sent = await actions.sendVisaFeeAction(null, form({
        taskId, entryId: fee.id, expectedRowVersion: String(fee.row_version), requestId: rid(), amount: '6,500', receiptEvidenceId: receiptId,
      }));
      expect(sent).toMatchObject({ ok: true, data: { expenseStatus: 'submitted' } });

      // Other visa cost of a passenger (section 16) via department_cost_save.
      const other = await actions.saveVisaOtherCostAction(null, form({
        taskId, applicationId: a1.applicationId, requestId: rid(), amount: '450', paidBy: 'company', paymentMode: 'cash', paidOn: dayFrom(0),
        reference: 'SYN-COURIER',
      }));
      expect(other).toMatchObject({ ok: true, data: { expenseStatus: 'draft' } });
      const otherCost = await cmd.visaOtherCostSave(rpc, {
        taskId, entryId: null, expectedRowVersion: 0, requestId: rid(),
        fields: { applicationId: a1.applicationId, amountPaise: '100', paidBy: 'customer_direct', paymentMode: null, paidOn: dayFrom(0), reference: null, receiptEvidenceId: null },
      });
      expect(otherCost.expenseStatus).toBeNull();

      // Confirm traveller with no change -> existing; notice ack by the Sales owner.
      const a4 = (await appsOf(taskId)).find((a) => a.traveller_seq === 4)!;
      const confirmed = await cmd.visaApplicationConfirmTraveller(rpc, { applicationId: a4.id, expectedRowVersion: a4.row_version, requestId: rid() });
      expect(confirmed.outcome).toBe('existing');
      const notice = (await v.owner<{ id: string }>(`select n.id from public.visa_result_notices n join public.visa_applications a on a.id = n.application_id where a.task_id = $1 order by n.outcome limit 1`, [taskId]))[0]!;
      const ack = await cmd.visaResultNoticeAck(rpcAs(OWNER), notice.id);
      expect(ack.outcome).toBe('updated');
      await expect(cmd.visaResultNoticeAck(rpc, notice.id)).rejects.toMatchObject({ code: 'not_authorized' });
    });
  });

  it('document upload marks the document received; e-visa approve needs the e-mail', { timeout: 180_000 }, async () => {
    await asOwner(db, async () => {
      const b = await v.book({ items: [{ type: 'visa', facts: EVISA }] });
      const taskId = b.tasks[0]!;
      await cmd.visaTaskClaim(rpcAs(VISA_A), taskId);
      const a1 = (await appsOf(taskId))[0]!;
      const doc = (await docsOf(a1.id))[0]!;
      storageUpload.mockImplementation(async (path: string) => {
        await v.owner(`insert into storage.objects (bucket_id, name, metadata) values ('department-evidence', $1, jsonb_build_object('size', 9::bigint))`, [path]);
        return { data: { path }, error: null };
      });
      const pdf = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a])], 'passport.pdf', { type: 'application/pdf' });
      const up = await uploads.uploadVisaDocumentFileAction(null, form({
        taskId, applicationId: a1.id, documentId: doc.id, expectedRowVersion: String(a1.row_version), documentStatus: 'not_received', file: pdf,
      }));
      expect(up).toMatchObject({ ok: true, data: { markedReceived: true } });
      expect((await docsOf(a1.id)).find((d) => d.id === doc.id)?.status).toBe('received');
      const linked = await v.owner<{ visa_document_id: string }>('select visa_document_id from public.department_evidence where id = $1', [up.ok ? up.data.evidenceId : null]);
      expect(linked[0]?.visa_document_id).toBe(doc.id);

      // E-visa: ready without appointment once every document is received.
      const rest = (await docsOf(a1.id)).filter((d) => d.status !== 'received');
      const saved = await cmd.visaApplicationSetRow(rpcAs(VISA_A), {
        applicationId: a1.id, expectedRowVersion: await rowVersion(a1.id), fields: { documents: rest.map((d) => ({ documentId: d.id, received: true })) }, requestId: rid(),
      });
      expect(saved.ready).toBe(true);
      const f: Record<string, string> = { taskId, requestId: rid(), applicantCount: '1', paidBy: 'customer_direct' };
      f[visaApplicantField(0, 'applicationId')] = a1.id;
      f[visaApplicantField(0, 'expectedRowVersion')] = String(await rowVersion(a1.id));
      f[visaApplicantField(0, 'reference')] = 'SYN-EV-1';
      f[visaApplicantField(0, 'appliedOn')] = dayFrom(0);
      f[visaApplicantField(0, 'governmentFee')] = '1200';
      expect(await actions.applyVisaApplicationsAction(null, form(f))).toMatchObject({ ok: true, message: 'Saved as applied. Waiting for the decision.' });
      const proof = await v.evidence(VISA_A, taskId, 'authority_outcome', a1.id);
      const noEmail = await actions.decideVisaApplicationAction(null, form({
        taskId, applicationId: a1.id, expectedRowVersion: String(await rowVersion(a1.id)), requestId: rid(), decision: 'approved', outcomeEvidenceId: proof,
      }));
      expect(noEmail).toMatchObject({ ok: false, code: 'invalid_input', fields: [VISA_FIELD.recipientEmail] });
      const ok = await actions.decideVisaApplicationAction(null, form({
        taskId, applicationId: a1.id, expectedRowVersion: String(await rowVersion(a1.id)), requestId: rid(), decision: 'approved', outcomeEvidenceId: proof,
        recipientEmail: 'traveller@example.test',
      }));
      expect(ok).toMatchObject({ ok: true, data: { closed: true } });
    });
  });

  it('reads parse through the DTO allowlists; identity and money fences hold', { timeout: 180_000 }, async () => {
    await asOwner(db, async () => {
      const { taskId, dealId } = await (async () => {
        const t = await v.stickerTask();
        const row = (await v.owner<{ deal_id: string }>('select deal_id from public.fulfilment_tasks where id = $1', [t.taskId]))[0]!;
        return { taskId: t.taskId, dealId: row.deal_id };
      })();
      const a1 = await v.appliedAlone(taskId, 1);
      await v.decide(taskId, a1, 'rejected');
      const staffOf = (actor: Actor) => ({ supabase: rpcAs(actor) }) as never;

      const queue = await queries.loadVisaQueue(staffOf(VISA_A));
      expect(queue?.canTake).toBe(true);
      expect(queue?.tasks.find((t) => t.taskId === taskId)).toMatchObject({ status: { code: 'in_progress' }, canTake: false, isManagerView: false });
      const mq = await queries.loadVisaQueue(staffOf(MANAGER));
      expect(mq?.isManagerView).toBe(true);
      expect(mq?.tasks.find((t) => t.taskId === taskId)).toMatchObject({ canTake: false, isManagerView: true });

      const w = await queries.loadVisaWorkspace(staffOf(VISA_A), taskId);
      expect(w).not.toBeNull();
      expect(w!.applicants).toHaveLength(4);
      const first = w!.applicants.find((a) => a.seq === 1)!;
      expect(first).toMatchObject({ state: 'refused', decision: { outcome: 'rejected' }, can: { reapply: true } });
      expect(first.fees.length).toBeGreaterThan(0);
      expect(w!.applicants.find((a) => a.seq === 2)!.passport?.number).toBe(passportOf(2));
      expect(w!.catalogue).toHaveLength(25);
      expect(w!.canManageFees).toBe(true);
      expect(w!.costSummary?.travellers.find((t) => t.seq === 1)).toMatchObject({ governmentFeePaise: '650000', otherPaise: null });
      expect(w!.steps.map((s) => s.key)).toEqual(['take', 'ready', 'applied', 'decision', 'handover']);

      // Manager: read only, no identity object; Purchase / Flight / Accounts: null.
      const mw = await queries.loadVisaWorkspace(staffOf(MANAGER), taskId);
      expect(mw?.isManagerView).toBe(true);
      expect(mw!.applicants.every((a) => a.passport === null && !a.can.edit)).toBe(true);
      expect(mw!.catalogue).toEqual([]);
      expect(mw!.canManageFees).toBe(false);
      for (const actor of [PURCHASE, FLIGHT, ACC]) expect(await queries.loadVisaWorkspace(staffOf(actor), taskId)).toBeNull();
      expect(await queries.loadVisaWorkspace(staffOf(VISA_A), 'not-a-uuid')).toBeNull();

      const summary = await queries.loadDealVisaSummary(staffOf(OWNER), dealId);
      expect(summary).not.toBe('error');
      expect(summary && summary !== 'error' && summary.notices.map((n) => n.outcome)).toEqual(['rejected']);
      expect(await queries.loadDealVisaSummary(staffOf(PURCHASE), dealId)).toBeNull();
      const history = await queries.loadDealVisaHistory(staffOf(OWNER), dealId);
      expect(history && history !== 'error' && history.events.map((e) => e.kind)).toEqual(expect.arrayContaining(['taken', 'applied', 'rejected']));
      const vm = buildDealHistory({ book: { state: 'failed' } as never, quotations: null, money: undefined, visaHistory: history });
      expect(vm.state).toBe('error');
      const ok = buildDealHistory({ book: { state: 'ok', view: { history: [] } } as never, quotations: null, money: undefined, visaHistory: history });
      expect(ok.state === 'ok' && dealHistoryGroups(ok.events).map((g) => g.key)).toEqual(['visa']);

      const home = await queries.loadVisaHomeCounts(staffOf(VISA_A));
      expect(home?.visaHandoverPending).toBe(1);
      const ownerHome = await queries.loadVisaHomeCounts(staffOf(OWNER));
      expect(ownerHome?.salesVisaResultsToSee).toBe(1);

      const th = await departmentTaskHistory(rpcAs(VISA_A), taskId);
      expect(th?.events.map((e) => e.kind)).toEqual(expect.arrayContaining(['taken', 'applicant_row_saved', 'applied', 'rejected']));
      expect(th?.events.find((e) => e.kind === 'rejected')?.note).toMatch(/Synthetic refusal/);

      // Accounts: applicantName on the visa fee rows (draft fees are not listed; send one first).
      const fee = (await v.owner<{ id: string; row_version: number }>(
        `select id, row_version from public.department_cost_entries where application_id = $1 and cost_kind = 'government_fee'`, [a1.applicationId]))[0]!;
      const receiptId = await v.evidence(VISA_A, taskId, 'fee_receipt', null, 'e'.repeat(64));
      await cmd.visaFeeSend(rpcAs(VISA_A), { entryId: fee.id, expectedRowVersion: fee.row_version, fields: { amountPaise: '650000', receiptEvidenceId: receiptId }, requestId: rid() });
      const page = await accountsExpenseRecords(rpcAs(ACC) as never, 'submitted');
      expect(page.items.find((i) => i.entryId === fee.id)?.applicantName).toBe(first.fullName);

      // Fence: no commercial or contact key anywhere in the parsed visa reads.
      const keys = JSON.stringify([queue, w, summary, history, home]);
      expect(keys).not.toMatch(/selling|listPrice|discount|margin|instalment|payerName|"phone|"mobile|billing|customerEmail/i);
    });
  });
});
