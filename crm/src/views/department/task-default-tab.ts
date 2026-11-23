import { parseTab } from '@/lib/parse-tab';
import type { TaskTab } from '@/modules/settings/contracts';

/*
 * D6 (owner, 16 November 2026; design plan 1.3): a Purchase, Flight or Visa
 * task page opens on the viewer's work. Without a `?tab=`, the person who
 * holds the task lands on Work; a task nobody holds, and every read-only
 * viewer (Manager, Sales, Accounts, a colleague), lands on Details as before.
 * An explicit `?tab=` the viewer has always wins, so every old address keeps
 * opening the same tab. An unknown value, or a tab this viewer does not have,
 * falls back to that same default.
 */

/** The tab a task page opens on when the address names none (or one this viewer does not have). */
export function defaultTaskTab(tabs: readonly TaskTab[], holdsTask: boolean): TaskTab {
  return holdsTask && tabs.includes('work') ? 'work' : 'details';
}

/** The open tab of a task page: the `?tab=` value when the viewer has it, else the D6 default. */
export function taskTabFor(raw: string | string[] | undefined, tabs: readonly TaskTab[], holdsTask: boolean): TaskTab {
  return parseTab(raw, tabs, defaultTaskTab(tabs, holdsTask));
}
