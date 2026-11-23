import { VISA_DOCUMENT_CATALOGUE } from '@/modules/visa/contracts';
import type { DealVisaSummary, VisaApplicant, VisaDocument, VisaQueueView, VisaStep, VisaWorkspace } from '@/views/visa/types';

/*
 * LOCAL DESIGN-REVIEW GALLERY ONLY. Synthetic visa and passport data for the
 * Visa build preview states (visa-*). Every name, reference, e-mail and
 * passport number is invented (SYN-, @example.test); no real record.
 */

export const T_VISA = 'a1000000-0000-4000-8000-000000000001';
export const T_PASSPORT = 'a1000000-0000-4000-8000-000000000002';
export const DEAL = 'd1000000-0000-4000-8000-000000000001';
const app = (n: number) => `b1000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const doc = (n: number, m: number) => `c1000000-0000-4000-8000-${String(n * 100 + m).padStart(12, '0')}`;
const ev = (n: number) => `e1000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const fee = (n: number, k: number) => `f1000000-0000-4000-8000-${String(n * 10 + k).padStart(12, '0')}`;

export const NAMES = ['Synthetic Asha Rao', 'Synthetic Vikram Rao', 'Synthetic Meera Rao', 'Synthetic Kabir Rao'];

const SALES_DOCS = ['Passport copy (front and back)', 'Photo, white background', 'Bank statement (6 months)'];

export function docs(n: number, receivedCount: number, labels = SALES_DOCS): VisaDocument[] {
  return labels.map((label, i) => ({
    documentId: doc(n, i + 1),
    catalogueCode: VISA_DOCUMENT_CATALOGUE.find((c) => c.label === label)?.code ?? null,
    label,
    status: i < receivedCount ? 'received' : 'not_received',
    source: 'sales',
    remark: null,
    receivedAt: i < receivedCount ? '2026-11-04T06:00:00Z' : null,
    files: i === 0 && i < receivedCount ? [{ evidenceId: ev(n * 10 + 1), fileName: `synthetic-passport-copy-${n}.pdf` }] : [],
  }));
}

const CAN_NONE = { edit: false, select: false, decide: false, handover: false, deliver: false, withdraw: false, reapply: false, confirmTraveller: false };

/** One applicant; `mine` = the viewer is the assignee (passport object, can.* by state). */
export function applicant(n: number, over: Partial<VisaApplicant> = {}, mine = true): VisaApplicant {
  const base: VisaApplicant = {
    applicationId: app(n),
    seq: n,
    fullName: NAMES[n - 1] ?? `Synthetic Traveller ${n}`,
    type: n === 3 ? 'child' : 'adult',
    ageYears: n === 3 ? 9 : null,
    rowVersion: 3,
    state: 'docs_pending',
    stateText: 'Not applied',
    ready: false,
    notReady: ['documents_missing'],
    removed: false,
    superseded: false,
    secondApplication: false,
    previousApplicationId: null,
    travellerChanged: null,
    passport: mine ? { number: `SYN${1000 + n}${n}2`, identityRowVersion: 1 } : null,
    visaKind: { value: 'sticker', source: 'sales' },
    jurisdiction: { required: true, place: 'Synthetic Mumbai', source: 'sales' },
    appointment: { date: null, time: null },
    remark: null,
    documents: docs(n, 1),
    documentsReceived: 1,
    documentsTotal: 3,
    applied: null,
    decision: null,
    handover: null,
    closed: null,
    fees: [],
    can: CAN_NONE,
  };
  const a = { ...base, ...over };
  if (!over.can) {
    a.can = !mine
      ? CAN_NONE
      : {
          edit: a.state === 'docs_pending' && !a.removed,
          select: a.state === 'docs_pending' && a.ready && !a.removed,
          decide: a.state === 'decision_pending' || a.state === 'submitted',
          handover: (a.state === 'issued' || a.state === 'refused') && !a.closed && !a.handover?.method && a.handover?.kind !== 'evisa',
          deliver: (a.handover?.method === 'office' || a.handover?.method === 'executive') && !a.closed,
          withdraw: (a.state === 'docs_pending' || a.state === 'decision_pending' || a.state === 'submitted') && !a.closed,
          reapply: a.state === 'refused' && !a.removed,
          confirmTraveller: !!a.travellerChanged,
        };
  }
  a.documentsReceived = a.documents.filter((d) => d.status === 'received').length;
  a.documentsTotal = a.documents.length;
  return a;
}

/** A ready passenger: every document received and an appointment date. */
export function ready(n: number, over: Partial<VisaApplicant> = {}, mine = true): VisaApplicant {
  return applicant(n, { documents: docs(n, 3), ready: true, notReady: [], stateText: 'Ready', appointment: { date: '2026-11-06', time: '10:30' }, ...over }, mine);
}

/** An applied passenger (decision pending), with fees. */
export function applied(n: number, over: Partial<VisaApplicant> = {}, mine = true, club: string[] = []): VisaApplicant {
  return applicant(
    n,
    {
      state: 'decision_pending',
      stateText: 'Applied · waiting for decision',
      documents: docs(n, 3),
      ready: true,
      notReady: ['wrong_state'],
      appointment: { date: '2026-11-04', time: '10:30' },
      visaKind: { value: 'sticker', source: 'applied' },
      jurisdiction: { required: true, place: 'Synthetic Mumbai', source: 'applied' },
      applied: { reference: `SYN-VFS-26-${1100 + n}`, appliedOn: '2026-11-04', clubId: club.length ? 'c9000000-0000-4000-8000-000000000001' : null, clubWith: club, remark: null, passportTaken: true },
      fees: [
        { entryId: fee(n, 1), costKind: 'government_fee', amountPaise: '650000', paidBy: 'company', paymentMode: 'bank_transfer', expenseStatus: 'submitted', returnReason: null, rowVersion: 1, receipt: { evidenceId: ev(900), fileName: 'synthetic-vfs-receipt.pdf' } },
        { entryId: fee(n, 2), costKind: 'service_fee', amountPaise: '80000', paidBy: 'company', paymentMode: 'bank_transfer', expenseStatus: 'submitted', returnReason: null, rowVersion: 1, receipt: { evidenceId: ev(900), fileName: 'synthetic-vfs-receipt.pdf' } },
      ],
      ...over,
    },
    mine,
  );
}

export function steps(met: { ready: number; applied: number; decision: number; handover: number }, of: number, taken = true): VisaStep[] {
  const raw = [
    { key: 'take' as const, label: 'Task taken', met: taken ? 1 : 0, of: 1 },
    { key: 'ready' as const, label: 'Documents and date', met: met.ready, of },
    { key: 'applied' as const, label: 'Applied', met: met.applied, of },
    { key: 'decision' as const, label: 'Decision', met: met.decision, of },
    { key: 'handover' as const, label: 'Handover', met: met.handover, of },
  ];
  let chain = true;
  return raw.map((s) => {
    chain = chain && s.of > 0 && s.met === s.of;
    return { ...s, done: chain };
  });
}

const CATALOGUE = VISA_DOCUMENT_CATALOGUE.map((d) => ({ code: d.code, label: d.label }));

function sumOther(fees: VisaApplicant['fees']): string | null {
  const other = fees.filter((f) => f.costKind === 'other');
  return other.length ? String(other.reduce((n, f) => n + Number(f.amountPaise), 0)) : null;
}

export function workspace(over: Partial<VisaWorkspace> = {}): VisaWorkspace {
  const applicants = over.applicants ?? [ready(1), ready(2), applicant(3), applicant(4, { documents: docs(4, 0), appointment: { date: '2026-11-08', time: null } })];
  const isMine = over.assignee?.isYou ?? true;
  return {
    taskId: T_VISA,
    serviceType: 'visa',
    dealId: DEAL,
    dealReference: 'SYN-JOD-701',
    branchName: 'Jodhpur',
    title: 'France · Tourism',
    status: { code: 'in_progress', step: 'ready', text: 'Documents and date pending' },
    assignee: { name: 'Synthetic Visa Jodhpur', isYou: true, takenAt: '2026-11-03T05:30:00Z' },
    canClaim: false,
    canWork: isMine,
    isManagerView: false,
    versionNo: 2,
    confirmedAt: '2026-11-02T09:00:00Z',
    facts: {
      visa: {
        country: 'France',
        purpose: 'Tourism',
        travelDate: '2027-02-06',
        applyBy: '2027-01-16',
        feePaidBy: 'company',
        notes: 'Synthetic note: the family prefers a morning appointment.',
        visaKind: 'sticker',
        jurisdiction: 'yes',
        jurisdictionPlace: 'Synthetic Mumbai',
        documentsNeeded: SALES_DOCS,
      },
    },
    steps: steps({ ready: 2, applied: 0, decision: 0, handover: 0 }, applicants.length),
    bookingChange: null,
    addedAfterCompletion: 0,
    applicants,
    previousApplications: [],
    returnedFees: [],
    catalogue: isMine ? CATALOGUE : [],
    files: applicants.flatMap((a) => a.documents.flatMap((d) => d.files.map((f) => ({ evidenceId: f.evidenceId, kind: 'applicant_document' as const, applicationId: a.applicationId, fileName: f.fileName, mime: 'application/pdf' as const, sizeBytes: 182000, status: 'stored' as const, uploadedByYou: isMine, createdAt: '2026-11-04T06:00:00Z', visaDocumentId: d.documentId, applicantSeq: a.seq })))),
    canUpload: isMine,
    canManageFees: isMine,
    ...over,
    // Always from the final passengers (a spread of another fixture must not carry its old totals).
    readyCount: applicants.filter((a) => a.ready).length,
    appliedCount: applicants.filter((a) => a.state !== 'docs_pending').length,
    costSummary: {
      travellers: applicants
        .filter((a) => a.fees.length)
        .map((a) => ({
          seq: a.seq,
          name: a.fullName,
          governmentFeePaise: a.fees.find((f) => f.costKind === 'government_fee')?.amountPaise ?? null,
          serviceFeePaise: a.fees.find((f) => f.costKind === 'service_fee')?.amountPaise ?? null,
          otherPaise: sumOther(a.fees),
          paidBy: a.fees[0]?.paidBy ?? null,
          expenseStatus: a.fees[0]?.expenseStatus ?? null,
          state: a.state,
        })),
      taskLevel: [],
      companyTotalPaise: String(applicants.flatMap((a) => a.fees).filter((f) => f.paidBy === 'company').reduce((n, f) => n + Number(f.amountPaise), 0)),
      customerDirectTotalPaise: '0',
    },
  };
}

/** Recompute cost summary and counts after overriding applicants. */
export function withApplicants(ws: VisaWorkspace, applicants: VisaApplicant[], step: VisaWorkspace['status']['step'], met: Parameters<typeof steps>[0]): VisaWorkspace {
  const base = workspace({ ...ws, applicants });
  return { ...base, steps: steps(met, applicants.filter((a) => !(a.removed && a.state === 'docs_pending')).length), status: step ? { code: 'in_progress', step, text: { ready: 'Documents and date pending', applied: 'Not applied yet', decision: 'Waiting for decision', handover: 'Handover pending' }[step] } : ws.status };
}

export const QUEUE: VisaQueueView = {
  isManagerView: false,
  canTake: true,
  launch: 'on',
  waitingCount: null,
  tasks: [
    { taskId: T_VISA, serviceType: 'visa', dealReference: 'SYN-JOD-701', branchName: 'Jodhpur', title: 'France · Tourism', factsLine: 'France · Tourism · Sticker visa · travel 6 Feb 27', travelDate: '2027-02-06', status: { code: 'in_progress', step: 'ready', text: 'Documents and date pending' }, applicantCount: 4, readyCount: 2, appliedCount: 0, decidedCount: 0, closedCount: 0, assigneeName: 'Synthetic Visa Jodhpur', assignedToYou: true, createdAt: '2026-11-02T09:00:00Z', canTake: false, isManagerView: false },
    { taskId: 'a1000000-0000-4000-8000-000000000003', serviceType: 'visa', dealReference: 'SYN-JOD-702', branchName: 'Jodhpur', title: 'United Arab Emirates · Tourism', factsLine: 'United Arab Emirates · Tourism · E-visa · travel 20 Nov 26', travelDate: '2026-11-20', status: { code: 'not_taken', step: null, text: 'Not taken' }, applicantCount: 3, readyCount: 0, appliedCount: 0, decidedCount: 0, closedCount: 0, assigneeName: null, assignedToYou: false, createdAt: '2026-11-03T09:00:00Z', canTake: true, isManagerView: false },
    { taskId: T_PASSPORT, serviceType: 'passport', dealReference: 'SYN-JOD-703', branchName: 'Jodhpur', title: 'Fresh passport · Jodhpur', factsLine: 'Fresh passport · Jodhpur', travelDate: null, status: { code: 'in_progress', step: 'decision', text: 'Waiting for decision' }, applicantCount: 1, readyCount: 1, appliedCount: 1, decidedCount: 0, closedCount: 0, assigneeName: 'Synthetic Visa Two', assignedToYou: false, createdAt: '2026-11-01T09:00:00Z', canTake: false, isManagerView: false },
    { taskId: 'a1000000-0000-4000-8000-000000000004', serviceType: 'visa', dealReference: 'SYN-JOD-699', branchName: 'Jodhpur', title: 'Singapore · Tourism with a very long synthetic title that has to wrap on a narrow phone screen', factsLine: 'Singapore · Tourism · E-visa · travel 1 Nov 26', travelDate: '2026-11-01', status: { code: 'completed', step: null, text: 'Completed' }, applicantCount: 2, readyCount: 2, appliedCount: 2, decidedCount: 2, closedCount: 2, assigneeName: 'Synthetic Visa Jodhpur', assignedToYou: true, createdAt: '2026-10-20T09:00:00Z', canTake: false, isManagerView: false },
  ],
};

export const DEAL_SUMMARY: DealVisaSummary = {
  tasks: [
    { taskId: T_VISA, serviceType: 'visa', title: 'France · Tourism', status: { code: 'in_progress', step: 'decision', text: 'Waiting for decision' }, applicantCount: 4, approved: 2, rejected: 1, withdrawn: 0, waiting: 1, addedAfterCompletion: 0 },
    { taskId: T_PASSPORT, serviceType: 'passport', title: 'Fresh passport · Jodhpur', status: { code: 'completed', step: null, text: 'Completed' }, applicantCount: 1, approved: 1, rejected: 0, withdrawn: 0, waiting: 0, addedAfterCompletion: 1 },
  ],
  notices: [
    { noticeId: 'a1000000-0000-4000-8000-000000000091', taskId: T_VISA, title: 'France · Tourism', travellerName: NAMES[0]!, outcome: 'approved', at: '2026-11-07T08:00:00Z', reason: null, seen: false, canAck: true },
    { noticeId: 'a1000000-0000-4000-8000-000000000092', taskId: T_VISA, title: 'France · Tourism', travellerName: NAMES[2]!, outcome: 'rejected', at: '2026-11-07T09:00:00Z', reason: 'Synthetic reason: the bank statement was older than six months.', seen: false, canAck: true },
    { noticeId: 'a1000000-0000-4000-8000-000000000093', taskId: T_VISA, title: 'France · Tourism', travellerName: NAMES[1]!, outcome: 'approved', at: '2026-11-06T08:00:00Z', reason: null, seen: true, canAck: false },
  ],
};
