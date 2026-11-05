import {
  FLIGHT_CHIP_TEXT,
  FLIGHT_DONE_CHECKLIST,
  FLIGHT_PROGRESS_LABEL,
  FLIGHT_STATUS_WORD,
  type FlightDoneIssue,
  type FlightStatusCode,
} from './contracts';

/**
 * Display helpers for flight status (Flight build contract, section 7). The
 * database is the authority (flight_queue / flight_workspace already return
 * the words); these rebuild the same frozen words from the codes so previews,
 * chips and the progress bar agree with it. Status is never shown by colour
 * alone: every chip has its words.
 */

export interface FlightStatusInput {
  code: FlightStatusCode;
  confirmed: number;
  required: number;
}

/** "Waiting" / "In progress · x of y tickets" (or "· flight details not typed yet" when y = 0) / "All tickets confirmed" / "Done · ticket issued". */
export function flightStatusText(status: FlightStatusInput): string {
  if (status.code === 'in_progress') {
    if (!status.required) return FLIGHT_STATUS_WORD.in_progress_untyped;
    return FLIGHT_STATUS_WORD.in_progress.replace('{x}', String(status.confirmed)).replace('{y}', String(status.required));
  }
  return FLIGHT_STATUS_WORD[status.code];
}

/** The status code the database derives from a task's stored status and ticket pairs. */
export function flightStatusCode(taskStatus: 'not_started' | 'in_progress' | 'completed', confirmed: number, required: number): FlightStatusCode {
  if (taskStatus === 'not_started') return 'waiting';
  if (taskStatus === 'completed') return 'done';
  return required > 0 && confirmed === required ? 'all_confirmed' : 'in_progress';
}

export interface FlightChipsInput {
  bookingChanged: boolean;
  unnamed: number;
  changesWaiting: number;
  /** True when a waiting change falls back to the branch Manager (no active Sales owner). */
  changeWaitsForManager?: boolean;
  faresWaiting: boolean;
  paymentNeeded: boolean;
}

/** Secondary chips, in display order (text always present). */
export function flightChips(chips: FlightChipsInput): Array<{ key: string; text: string }> {
  const out: Array<{ key: string; text: string }> = [];
  if (chips.bookingChanged) out.push({ key: 'bookingChanged', text: FLIGHT_CHIP_TEXT.bookingChanged });
  if (chips.unnamed > 0) out.push({ key: 'unnamed', text: FLIGHT_CHIP_TEXT.unnamed.replace('{n}', String(chips.unnamed)) });
  if (chips.changesWaiting > 0) {
    out.push({ key: 'changesWaiting', text: chips.changeWaitsForManager ? FLIGHT_CHIP_TEXT.changeWaitingManager : FLIGHT_CHIP_TEXT.changeWaitingSales });
  }
  if (chips.faresWaiting) out.push({ key: 'faresWaiting', text: FLIGHT_CHIP_TEXT.faresWaiting });
  if (chips.paymentNeeded) out.push({ key: 'paymentNeeded', text: FLIGHT_CHIP_TEXT.paymentNeeded });
  return out;
}

export type FlightProgressKey = keyof typeof FLIGHT_PROGRESS_LABEL;

/** Progress bar step label and the state word for screen readers. */
export function flightProgressText(step: { key: FlightProgressKey; state: 'done' | 'current' | 'todo'; sub: string | null }): string {
  const state = step.state === 'done' ? 'done' : step.state === 'current' ? 'current step' : 'not started';
  return `${FLIGHT_PROGRESS_LABEL[step.key]}${step.sub ? ` (${step.sub})` : ''}: ${state}`;
}

/** Checklist rows for "Mark flight done": every item, ticked unless the server lists its issue. */
export function flightChecklist(issues: readonly FlightDoneIssue[]): Array<{ token: FlightDoneIssue; label: string; done: boolean }> {
  return (Object.keys(FLIGHT_DONE_CHECKLIST) as FlightDoneIssue[]).map((token) => ({
    token,
    label: FLIGHT_DONE_CHECKLIST[token].label,
    done: !issues.includes(token),
  }));
}
