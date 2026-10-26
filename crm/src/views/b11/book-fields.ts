import {
  ACCOUNTS_REVIEW_STATUS_LABEL,
  BOOK_SECTION_LABEL,
  BOOK_SECTION_STEP,
  BOOK_SECTIONS,
  BOOK_STEP_LABEL,
  BOOK_STEPS as STEP_KEYS,
  BOOK_SUBMIT_DIALOG_TEXT,
  CHANGE_CLASS_LABEL,
  LEGACY_BOOK_STEPS,
  LEGACY_STEP_TARGET,
  REVISION_CONFIRM_DIALOG_TEXT,
  SERVICE_TYPE_LABEL,
  maskPassportNumber,
} from '@/modules/fulfilment/contracts';
import type { BookSection, LegacyBookStep, TravellerIdProofView } from '@/modules/fulfilment/contracts';
import { CLAIM_DISPLAY_STATUS_LABEL, CLAIM_TEXT, type ReceiptMode } from '@/modules/finance/contracts';
import type { StepItem, StepStatus } from '@/components/ui/stepper';
import type { BookChecklistItem, BookDepartment, BookItem, BookNowView, BookServiceType, BookStep, ClaimDisplayStatus } from './shapes';

/*
 * Pure helpers for the Book now screens (server-safe, unit-tested): the three
 * steps and their sections (B1.2 freeze note §2.1), legacy six-step
 * addresses, step and section markers, the first place that needs input,
 * hotel vs other services, the per-section row-version chain, rupee/paise
 * and date text, the GST state list and the frozen words shown to staff
 * (most come from the TS contracts; this module only arranges them).
 */

export { ACCOUNTS_REVIEW_STATUS_LABEL as REVIEW_STATUS_LABEL, BOOK_SECTION_LABEL, BOOK_STEP_LABEL, CHANGE_CLASS_LABEL };
export type { BookSection, LegacyBookStep };

export const BOOK_STEPS: ReadonlyArray<{ key: BookStep; label: string }> = STEP_KEYS.map((key) => ({ key, label: BOOK_STEP_LABEL[key] }));

export function isBookStep(value: string): value is BookStep {
  return (STEP_KEYS as readonly string[]).includes(value);
}

/** One of the six B1.1 step keys (customer, trip, services, price, payment, review): redirect only. */
export function isLegacyBookStep(value: string): value is LegacyBookStep {
  return (LEGACY_BOOK_STEPS as readonly string[]).includes(value);
}

export function isBookSection(value: string): value is BookSection {
  return (BOOK_SECTIONS as readonly string[]).includes(value);
}

/** Sections of one step, in page order. */
export function sectionsOf(step: BookStep): BookSection[] {
  return BOOK_SECTIONS.filter((s) => BOOK_SECTION_STEP[s] === step);
}

/**
 * `/app/deals/{id}/book`, `/book/{step}` or `/book/{step}#{section}`. The
 * fragment is left out when the section is the step's first (the page opens
 * there anyway).
 */
export function bookHref(dealId: string, step?: BookStep, section?: BookSection | null): string {
  if (!step) return `/app/deals/${dealId}/book`;
  const base = `/app/deals/${dealId}/book/${step}`;
  if (!section || sectionsOf(step)[0] === section) return base;
  return `${base}#${section}`;
}

/** The new address of a B1.1 step address (always with the section fragment). */
export function legacyStepHref(dealId: string, legacy: LegacyBookStep): string {
  const t = LEGACY_STEP_TARGET[legacy];
  return `/app/deals/${dealId}/book/${t.step}#${t.section}`;
}

/**
 * A link to a section from the current step: a plain `#section` on the same
 * page (the unsaved-changes guard ignores it), else the step address with the
 * fragment (guarded).
 */
export function sectionHref(dealId: string, current: BookStep | null, target: BookSection): string {
  const step = BOOK_SECTION_STEP[target];
  if (current === step) return `#${target}`;
  return `/app/deals/${dealId}/book/${step}#${target}`;
}

export function nextStep(step: BookStep): BookStep | null {
  const i = STEP_KEYS.indexOf(step);
  return STEP_KEYS[i + 1] ?? null;
}

export function previousStep(step: BookStep): BookStep | null {
  const i = STEP_KEYS.indexOf(step);
  return i > 0 ? STEP_KEYS[i - 1]! : null;
}

export function checklistForStep(items: BookChecklistItem[], step: BookStep): BookChecklistItem[] {
  return items.filter((i) => i.step === step);
}

export function checklistForSection(items: BookChecklistItem[], section: BookSection): BookChecklistItem[] {
  return items.filter((i) => i.section === section);
}

const STEPPER_STATUS: Record<BookNowView['stepStatus'][BookStep], StepStatus> = {
  complete: 'complete',
  needs_input: 'needs_input',
  warnings_only: 'warnings',
};

/** The marker of a step or section in the stepper's words. */
export function stepperStatus(status: BookNowView['stepStatus'][BookStep] | undefined): StepStatus {
  return (status && STEPPER_STATUS[status]) ?? 'complete';
}

export function stepItems(view: Pick<BookNowView, 'stepStatus'>, current: BookStep | null, hrefs: Record<BookStep, string>): StepItem[] {
  return BOOK_STEPS.map((s) => ({
    key: s.key,
    label: s.label,
    href: hrefs[s.key],
    status: stepperStatus(view.stepStatus[s.key]),
    current: s.key === current,
  }));
}

export function stepHrefs(dealId: string): Record<BookStep, string> {
  return Object.fromEntries(STEP_KEYS.map((k) => [k, bookHref(dealId, k)])) as Record<BookStep, string>;
}

export function blockingCount(items: BookChecklistItem[]): number {
  return items.filter((i) => i.blocking).length;
}

/**
 * The first place that still needs input (freeze note §2.1, Terra §4.4):
 * steps in order; inside a step, the first section that needs input (null
 * when it is the step's first section). Nothing outside review needs input →
 * the review section of step 3.
 */
export function firstOpenTarget(view: Pick<BookNowView, 'stepStatus' | 'sectionStatus'>): { step: BookStep; section: BookSection | null } {
  for (const step of STEP_KEYS) {
    const sections = sectionsOf(step).filter((s) => s !== 'review');
    const open = sections.find((s) => view.sectionStatus[s] === 'needs_input');
    if (open) return { step, section: open === sections[0] ? null : open };
  }
  return { step: 'finish', section: 'review' };
}

export function firstOpenHref(dealId: string, view: Pick<BookNowView, 'stepStatus' | 'sectionStatus'>): string {
  const t = firstOpenTarget(view);
  return bookHref(dealId, t.step, t.section);
}

/** The step of firstOpenTarget (kept so the B1.1 overview route compiles until it moves to firstOpenHref). */
export function firstOpenStep(view: Pick<BookNowView, 'stepStatus' | 'sectionStatus'>): BookStep {
  return firstOpenTarget(view).step;
}

/**
 * Per-section row version (freeze note §2.1, Terra §2.2). A section posts
 * its own base row version. After one of THIS browser's saves succeeded
 * (link from → to), a section whose base equals `from` advances to `to`; a
 * save by anybody else leaves a gap, so a dirty section keeps its base and
 * its save is refused with version_changed instead of silently overwriting.
 */
export function advanceBase(base: number, links: ReadonlyArray<{ from: number; to: number }>): number {
  let current = base;
  const seen = new Set<number>();
  for (;;) {
    if (seen.has(current)) return current;
    seen.add(current);
    const link = links.find((l) => l.from === current);
    if (!link || link.to <= current) return current;
    current = link.to;
  }
}

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

/** The value of the hidden travellerSeqMax input: the highest traveller seq this form was loaded with (0 when none). */
export function travellerSeqHighWater(view: Pick<BookNowView, 'travellers'>): number {
  return view.travellers.reduce((max, t) => Math.max(max, t.seq), 0);
}

/**
 * How many more identity-proof files this traveller may get: the cap counts
 * live files only (uploading or stored); failed files are listed but do not
 * count. null when the database sent no limits.
 */
export function idProofSlotsLeft(proofs: ReadonlyArray<Pick<TravellerIdProofView, 'status'>> | undefined, limits: BookNowView['idProofLimits']): number | null {
  if (!limits) return null;
  const live = (proofs ?? []).filter((p) => p.status === 'pending_upload' || p.status === 'stored').length;
  return Math.max(0, limits.maxFilesPerTraveller - live);
}

/** The database's name comparison for detaching proofs: trim, collapse spaces, lower case. */
function sameName(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
  return norm(a) === norm(b);
}

/**
 * D3-3: after a passengers save, the travellers (same seq, still present)
 * whose name changed and who had live identity proofs before: the database
 * detached those proofs. The screen says ID_PROOF_TEXT.detachedOnRename for
 * each. A removed traveller is not listed (removing the person was the
 * intent). Compare the view loaded before the save with the refreshed one.
 */
export function idProofsDetachedByRename(
  before: Pick<BookNowView, 'travellers'>,
  after: Pick<BookNowView, 'travellers'>,
): Array<{ seq: number; fullName: string }> {
  const out: Array<{ seq: number; fullName: string }> = [];
  for (const old of before.travellers) {
    const live = (old.idProofs ?? []).filter((p) => p.status === 'pending_upload' || p.status === 'stored').length;
    if (live === 0) continue;
    const now = after.travellers.find((t) => t.seq === old.seq);
    if (!now || sameName(old.fullName, now.fullName)) continue;
    out.push({ seq: now.seq, fullName: now.fullName });
  }
  return out;
}

/** Step 2 · hotels; step 3 · every other type (freeze note §2.1). */
export const HOTEL_SECTION_TYPES = ['hotel'] as const satisfies readonly BookServiceType[];
/** Step 3 button order: transport first (the owner's word order), then flight, activity, visa, passport. */
export const OTHER_SECTION_TYPES = ['transfer', 'flight', 'activity', 'visa', 'passport'] as const satisfies readonly BookServiceType[];

export function serviceSection(type: BookServiceType): 'hotels' | 'services' {
  return type === 'hotel' ? 'hotels' : 'services';
}

/** The items shown in one services section, by item number (global numbers are kept). */
export function itemsForSection<T extends Pick<BookItem, 'serviceType' | 'itemNo'>>(items: readonly T[], section: 'hotels' | 'services'): T[] {
  return items.filter((i) => serviceSection(i.serviceType) === section).sort((a, b) => a.itemNo - b.itemNo);
}

export const B11_SERVICE_TYPES: readonly BookServiceType[] = ['hotel', 'flight', 'transfer', 'activity', 'visa', 'passport'];

export const B11_SERVICE_LABEL: Record<BookServiceType, string> = SERVICE_TYPE_LABEL;

export const B11_DEPARTMENT: Record<BookServiceType, BookDepartment> = {
  hotel: 'purchase',
  transfer: 'purchase',
  activity: 'purchase',
  flight: 'flight',
  visa: 'visa',
  passport: 'visa',
};

export const B11_DEPARTMENT_LABEL: Record<BookDepartment, string> = {
  purchase: 'Purchase team',
  flight: 'Flight team',
  visa: 'Visa & Passport desk',
};

/** The contract derives identityRequired per traveller (visa, passport, or a flight on an international trip). */
export function travellerNeedsIdentity(view: Pick<BookNowView, 'travellers'>, seq: number): boolean {
  return view.travellers.some((t) => t.seq === seq && t.identityRequired);
}

export function taskCountByDepartment(items: Pick<BookItem, 'serviceType'>[], visaLaunched: boolean): Array<{ department: BookDepartment; count: number; waiting: boolean }> {
  const out: Array<{ department: BookDepartment; count: number; waiting: boolean }> = [];
  for (const dep of ['purchase', 'flight', 'visa'] as const) {
    const count = items.filter((i) => B11_DEPARTMENT[i.serviceType] === dep).length;
    if (count > 0) out.push({ department: dep, count, waiting: dep === 'visa' && !visaLaunched });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Money and dates
// ---------------------------------------------------------------------------

const INR = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "1250000" paise → "₹12,500.00". null/undefined → null (show "Not entered yet"). */
export function inr(paise: string | number | null | undefined): string | null {
  if (paise === null || paise === undefined || paise === '') return null;
  const n = typeof paise === 'number' ? paise : Number(paise);
  if (!Number.isFinite(n)) return null;
  return INR.format(n / 100);
}

/** Paise string → rupee text for an input ("1250050" → "12500.50"). */
export function paiseToRupeesText(paise: string | null | undefined): string {
  if (!paise || !/^\d+$/.test(paise)) return '';
  const whole = paise.length > 2 ? paise.slice(0, -2) : '0';
  const frac = paise.padStart(3, '0').slice(-2);
  return frac === '00' ? whole : `${whole}.${frac}`;
}

/** Client-side mirror for running totals only (the server decides): "12,500.5" → 1250050; "" → 0; bad → null. */
export function rupeesTextToPaise(text: string): number | null {
  const v = text.replace(/[,\s₹]/g, '');
  if (v === '') return 0;
  const m = /^(\d{1,13})(?:\.(\d{1,2}))?$/.exec(v);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}

const DATE = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });

/** "2026-11-02" → "2 Nov 2026" (date-only values are shown as written). */
export function dateText(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T00:00:00+05:30` : iso);
  return Number.isNaN(d.getTime()) ? iso : DATE.format(d);
}

export const maskPassport = maskPassportNumber;

// ---------------------------------------------------------------------------
// Fixed words
// ---------------------------------------------------------------------------

export const GST_STATES: ReadonlyArray<{ code: string; name: string }> = [
  { code: '01', name: 'Jammu and Kashmir' },
  { code: '02', name: 'Himachal Pradesh' },
  { code: '03', name: 'Punjab' },
  { code: '04', name: 'Chandigarh' },
  { code: '05', name: 'Uttarakhand' },
  { code: '06', name: 'Haryana' },
  { code: '07', name: 'Delhi' },
  { code: '08', name: 'Rajasthan' },
  { code: '09', name: 'Uttar Pradesh' },
  { code: '10', name: 'Bihar' },
  { code: '11', name: 'Sikkim' },
  { code: '12', name: 'Arunachal Pradesh' },
  { code: '13', name: 'Nagaland' },
  { code: '14', name: 'Manipur' },
  { code: '15', name: 'Mizoram' },
  { code: '16', name: 'Tripura' },
  { code: '17', name: 'Meghalaya' },
  { code: '18', name: 'Assam' },
  { code: '19', name: 'West Bengal' },
  { code: '20', name: 'Jharkhand' },
  { code: '21', name: 'Odisha' },
  { code: '22', name: 'Chhattisgarh' },
  { code: '23', name: 'Madhya Pradesh' },
  { code: '24', name: 'Gujarat' },
  { code: '25', name: 'Daman and Diu (old code)' },
  { code: '26', name: 'Dadra and Nagar Haveli and Daman and Diu' },
  { code: '27', name: 'Maharashtra' },
  { code: '28', name: 'Andhra Pradesh (old code)' },
  { code: '29', name: 'Karnataka' },
  { code: '30', name: 'Goa' },
  { code: '31', name: 'Lakshadweep' },
  { code: '32', name: 'Kerala' },
  { code: '33', name: 'Tamil Nadu' },
  { code: '34', name: 'Puducherry' },
  { code: '35', name: 'Andaman and Nicobar Islands' },
  { code: '36', name: 'Telangana' },
  { code: '37', name: 'Andhra Pradesh' },
  { code: '38', name: 'Ladakh' },
  { code: '97', name: 'Other territory' },
];

export const CLAIM_STATUS_SALES_LABEL = Object.fromEntries(Object.entries(CLAIM_DISPLAY_STATUS_LABEL).map(([k, v]) => [k, v.sales])) as Record<ClaimDisplayStatus, string>;
export const CLAIM_STATUS_ACCOUNTS_LABEL = Object.fromEntries(Object.entries(CLAIM_DISPLAY_STATUS_LABEL).map(([k, v]) => [k, v.accounts])) as Record<ClaimDisplayStatus, string>;
export const CLAIM_DISCLAIMER = CLAIM_TEXT.disclaimer;

export const RECEIPT_MODE_TEXT: Record<ReceiptMode, string> = {
  bank_transfer: 'Bank transfer',
  upi: 'UPI',
  cash: 'Cash',
  cheque: 'Cheque',
};

/** Lines of the submit dialog with the counts filled in (frozen text plus the desk-launch line). */
export function submitDialogLines(view: Pick<BookNowView, 'items' | 'visaPassportTasksEnabled' | 'version'>): string[] {
  const version = view.version;
  const revision = Boolean(version?.revisesVersionId);
  if (revision) {
    const base = String(version?.revisesVersionNo ?? '');
    return REVISION_CONFIRM_DIALOG_TEXT.body.map((l) => l.replaceAll('{baseVersionNo}', base));
  }
  const waiting = view.visaPassportTasksEnabled ? 0 : view.items.filter((i) => B11_DEPARTMENT[i.serviceType] === 'visa').length;
  const taskCount = view.items.length - waiting;
  const lines: string[] = BOOK_SUBMIT_DIALOG_TEXT.body.map((l) =>
    l
      .replaceAll('{versionNo}', String(version?.versionNo ?? ''))
      .replaceAll('{taskCount}', String(taskCount))
      .replaceAll('{taskNoun}', taskCount === 1 ? 'task' : 'tasks'),
  );
  lines.splice(2, 0, `Tasks: ${tasksSentence(view.items, view.visaPassportTasksEnabled)}.`);
  return lines;
}

export function submitDialogTitle(view: Pick<BookNowView, 'version'>): { title: string; confirmLabel: string; cancelLabel: string } {
  const T = view.version?.revisesVersionId ? REVISION_CONFIRM_DIALOG_TEXT : BOOK_SUBMIT_DIALOG_TEXT;
  return { title: T.title, confirmLabel: T.confirmLabel, cancelLabel: T.cancelLabel };
}

/** "1 task for the Purchase team, 1 for the Flight team (visa waits for the desk launch)". */
export function tasksSentence(items: Pick<BookItem, 'serviceType'>[], visaLaunched: boolean): string {
  const parts = taskCountByDepartment(items, visaLaunched);
  if (parts.length === 0) return 'no tasks';
  const created = parts.filter((p) => !p.waiting);
  const waiting = parts.filter((p) => p.waiting);
  const createdText = created.map((p) => `${p.count} ${p.count === 1 ? 'task' : 'tasks'} for the ${B11_DEPARTMENT_LABEL[p.department]}`).join(', ');
  const waitingText = waiting.map((p) => `${p.count} visa or passport ${p.count === 1 ? 'service waits' : 'services wait'} for the Visa & Passport desk launch (no task yet)`).join('');
  return [createdText || 'no tasks yet', waitingText].filter(Boolean).join('; ');
}
