import {
  VISA_APPLICANT_WORD,
  VISA_APPLICATION_STATE_WORD,
  VISA_CLOSED_REASON_LABEL,
  VISA_DEAL_HISTORY_TITLE,
  VISA_HANDOVER_LABEL,
  VISA_HANDOVER_TEXT,
  VISA_KIND_LABEL,
  VISA_KIND_NOT_DECIDED,
  VISA_LINE_TEXT,
  VISA_NOT_READY_REASON,
  VISA_NOTICE_TEXT,
  VISA_STEP_LABEL,
  VISA_STEP_WORD,
  VISA_TASK_STATUS_WORD,
  VISA_TEXT,
} from './contracts';
import type {
  DealVisaHistoryEventDTO,
  DealVisaNoticeDTO,
  VisaApplicantDTO,
  VisaQueueTaskDTO,
  VisaServiceType,
  VisaStepDTO,
  VisaTaskStatusDTO,
} from './dto';

/**
 * Display words of the Visa desk (contract section 8) from the database's
 * codes. The database is the authority for every state, step count and
 * permission; these functions only turn codes into the frozen words.
 */

/** Task status words: the database's text when present, else the frozen word of its code and step. */
export function visaTaskStatusText(status: VisaTaskStatusDTO): string {
  if (status.text.trim() !== '') return status.text;
  if (status.code === 'not_taken') return VISA_TASK_STATUS_WORD.not_taken;
  if (status.code === 'completed') return VISA_TASK_STATUS_WORD.completed;
  return status.step ? VISA_TASK_STATUS_WORD[status.step] : VISA_TASK_STATUS_WORD.ready;
}

export interface VisaStepView {
  key: VisaStepDTO['key'];
  label: string;
  state: 'done' | 'current' | 'pending';
  /** "Completed", "Pending", "Now" or "x of y". */
  word: string;
}

/**
 * Step bar (section 8): a step is done when the database says so and every
 * earlier step is done; the first step that is not done is current and shows
 * "x of y" (y > 1) or "Now"; later steps are "Pending".
 */
export function visaStepViews(steps: readonly VisaStepDTO[]): VisaStepView[] {
  let chainDone = true;
  let currentSeen = false;
  return steps.map((s) => {
    const label = s.label || VISA_STEP_LABEL[s.key];
    const done = chainDone && s.done;
    if (done) return { key: s.key, label, state: 'done', word: VISA_STEP_WORD.done };
    chainDone = false;
    if (!currentSeen) {
      currentSeen = true;
      const word = s.of > 1 ? VISA_STEP_WORD.progress.replace('{x}', String(s.met)).replace('{y}', String(s.of)) : VISA_STEP_WORD.now;
      return { key: s.key, label, state: 'current', word };
    }
    return { key: s.key, label, state: 'pending', word: VISA_STEP_WORD.pending };
  });
}

/** Applicant chips in display order: state word, plus Removed / Traveller changed / Second application / Closed. */
export function visaApplicantChips(a: VisaApplicantDTO): string[] {
  const chips: string[] = [];
  if (a.state === 'docs_pending') chips.push(a.ready ? VISA_APPLICANT_WORD.ready : VISA_APPLICANT_WORD.notApplied);
  else chips.push(VISA_APPLICATION_STATE_WORD[a.state]);
  if (a.removed) chips.push(VISA_APPLICANT_WORD.removed);
  if (a.travellerChanged) chips.push(VISA_APPLICANT_WORD.travellerChanged);
  if (a.secondApplication) chips.push(VISA_APPLICANT_WORD.secondApplication);
  if (a.closed) chips.push(VISA_APPLICANT_WORD.closed);
  return chips;
}

/** Plain words of the reasons a passenger is not ready (section 4 tokens), first first. */
export function visaNotReadyReasons(a: Pick<VisaApplicantDTO, 'notReady'>): string[] {
  return a.notReady.map((t) => VISA_NOT_READY_REASON[t]);
}

/** "E-visa", "Sticker visa" or "Not decided yet". */
export function visaKindText(kind: VisaApplicantDTO['visaKind']['value']): string {
  return kind ? VISA_KIND_LABEL[kind] : VISA_KIND_NOT_DECIDED;
}

/**
 * The visa line under a passenger's name (H:15270): "E-visa · Passport photo
 * only" / "Sticker visa · Passport with us | not with us | returned ·
 * Jurisdiction {place} | No jurisdiction". Passport tasks have none (null).
 */
export function visaLineText(a: VisaApplicantDTO, serviceType: VisaServiceType): string | null {
  if (serviceType === 'passport') return null;
  if (a.visaKind.value === 'e_visa') return VISA_LINE_TEXT.evisa;
  if (a.visaKind.value !== 'sticker') return null;
  const returned = a.closed && a.closed.reason !== 'reapplied' && a.handover?.method !== 'not_with_us';
  const custody = returned ? VISA_LINE_TEXT.passportReturned : a.applied?.passportTaken ? VISA_LINE_TEXT.passportWithUs : VISA_LINE_TEXT.passportNotWithUs;
  const jurisdiction = a.jurisdiction.required
    ? VISA_LINE_TEXT.jurisdiction.replace('{place}', a.jurisdiction.place ?? '')
    : a.jurisdiction.required === false
      ? VISA_LINE_TEXT.noJurisdiction
      : null;
  return [VISA_LINE_TEXT.sticker, custody, jurisdiction].filter(Boolean).join(' · ');
}

export type VisaHandoverCell =
  | { kind: 'evisa'; text: string }
  | { kind: 'method'; text: string }
  | { kind: 'customer_told'; text: string }
  | { kind: 'legacy_returned'; text: string }
  | { kind: 'not_decided'; text: string; action: string }
  | { kind: 'not_recorded'; text: string; action: string }
  | { kind: 'none'; text: null };

function dateText(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number) as [number, number, number];
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1] ?? '';
  return `${d} ${month} ${String(y).slice(-2)}`;
}

/**
 * The Handover cell of the Appointment table (H:15240-15262; "sent to"
 * replaces "e-mailed" because the CRM sends nothing). `none` before a
 * decision; "Not decided yet" + "Set handover" for a decided sticker visa or
 * passport without one; "Not recorded" + "Record handover" for legacy rows.
 */
export function visaHandoverCell(a: VisaApplicantDTO, serviceType: VisaServiceType): VisaHandoverCell {
  const h = a.handover;
  if (h?.kind === 'evisa') return { kind: 'evisa', text: VISA_HANDOVER_TEXT.evisaSent.replace('{email}', h.recipientEmail ?? '') };
  if (h?.kind === 'customer_told') return { kind: 'customer_told', text: VISA_HANDOVER_TEXT.customerTold };
  if (h?.kind === 'legacy_returned') return { kind: 'legacy_returned', text: VISA_HANDOVER_TEXT.legacyReturned.replace('{date}', h.sentAt ? dateText(h.sentAt) : '') };
  if (h?.kind === 'method' && h.method) {
    const lead = serviceType === 'passport' ? VISA_HANDOVER_TEXT.passportReturn : VISA_HANDOVER_TEXT.stickerReturn;
    const parts = [lead, VISA_HANDOVER_LABEL[h.method]];
    if (h.method === 'courier' && h.courierNumber) parts.push(VISA_HANDOVER_TEXT.courierNumber.replace('{number}', h.courierNumber));
    if (h.deliveredOn) parts.push(VISA_HANDOVER_TEXT.delivered.replace('{date}', dateText(h.deliveredOn)));
    return { kind: 'method', text: parts.join(' · ') };
  }
  if (a.state !== 'issued' && a.state !== 'refused') return { kind: 'none', text: null };
  if (a.closed) return { kind: 'none', text: null };
  // Decided without a handover: legacy rows (no kind recorded) say "Not recorded".
  if (a.visaKind.value === null && serviceType === 'visa') {
    return { kind: 'not_recorded', text: VISA_HANDOVER_TEXT.notRecorded, action: VISA_HANDOVER_TEXT.recordHandover };
  }
  return { kind: 'not_decided', text: VISA_HANDOVER_TEXT.notDecided, action: VISA_HANDOVER_TEXT.setHandover };
}

export function visaClosedText(a: VisaApplicantDTO): string | null {
  return a.closed ? VISA_CLOSED_REASON_LABEL[a.closed.reason] : null;
}

// ---------------------------------------------------------------------------
// Queue tabs (H:14558): Visa people Not taken / Mine / All; the Manager Not taken / All
// ---------------------------------------------------------------------------

export type VisaQueueShow = 'not_taken' | 'mine' | 'all';

export function visaQueueShows(isManagerView: boolean): VisaQueueShow[] {
  return isManagerView ? ['not_taken', 'all'] : ['not_taken', 'mine', 'all'];
}

/** `?show=` allowlist; anything else is the first tab. */
export function parseVisaQueueShow(raw: string | string[] | undefined, isManagerView: boolean): VisaQueueShow {
  const v = Array.isArray(raw) ? raw[0] : raw;
  const shows = visaQueueShows(isManagerView);
  return shows.some((s) => s === v) ? (v as VisaQueueShow) : shows[0]!;
}

export function visaQueueFilter(tasks: readonly VisaQueueTaskDTO[], show: VisaQueueShow): VisaQueueTaskDTO[] {
  if (show === 'not_taken') return tasks.filter((t) => t.status.code === 'not_taken');
  if (show === 'mine') return tasks.filter((t) => t.assignedToYou);
  return [...tasks];
}

export function visaQueueCounts(tasks: readonly VisaQueueTaskDTO[]): Record<VisaQueueShow, number> {
  return {
    not_taken: tasks.filter((t) => t.status.code === 'not_taken').length,
    mine: tasks.filter((t) => t.assignedToYou).length,
    all: tasks.length,
  };
}

// ---------------------------------------------------------------------------
// Deal page and Deal History
// ---------------------------------------------------------------------------

/** "Visa approved for Synthetic Traveller" / "Visa rejected for the traveller". */
export function visaNoticeText(n: Pick<DealVisaNoticeDTO, 'outcome' | 'travellerName'>): string {
  return VISA_NOTICE_TEXT[n.outcome].replace('{name}', n.travellerName ?? VISA_NOTICE_TEXT.unnamed);
}

/** Deal History title; a collapsed club reads "Applied together: {n} travellers". */
export function visaDealHistoryTitle(e: Pick<DealVisaHistoryEventDTO, 'kind' | 'clubSize'>): string {
  if (e.kind === 'applied' && e.clubSize && e.clubSize > 1) return VISA_TEXT.appliedTogether.replace('{n}', String(e.clubSize));
  return VISA_DEAL_HISTORY_TITLE[e.kind];
}

/** "{n} travellers added after completion have no visa application" (VL12); null for 0. */
export function visaAddedAfterCompletionText(n: number): string | null {
  return n > 0 ? VISA_TEXT.addedAfterCompletion.replace('{n}', String(n)) : null;
}
