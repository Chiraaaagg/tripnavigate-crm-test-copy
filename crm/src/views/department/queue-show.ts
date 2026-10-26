/*
 * Department task lists (Batch 4, screen plan PU-01 / FL-01 / VI-01): the
 * tabs "Not taken · Mine · All" over the full list the database already
 * returned. Pure helpers: the route parses `?show=`, the view filters the
 * rows it was given. No extra read, nothing hidden is sent.
 */

export type QueueShow = 'not_taken' | 'mine' | 'all';

export const QUEUE_SHOW_LABEL: Record<QueueShow, string> = { not_taken: 'Not taken', mine: 'Mine', all: 'All' };

/** Takers (the department role) get Mine; a branch Manager only follows progress. */
export function queueShowsFor(canTakeTasks: boolean): QueueShow[] {
  return canTakeTasks ? ['not_taken', 'mine', 'all'] : ['not_taken', 'all'];
}

/** Screen plan: default Not taken for the department, All for the branch Manager. */
export function defaultQueueShow(canTakeTasks: boolean): QueueShow {
  return canTakeTasks ? 'not_taken' : 'all';
}

/** Server allowlist: anything else is the default. */
export function parseQueueShow(raw: string | string[] | undefined, canTakeTasks: boolean): QueueShow {
  const v = Array.isArray(raw) ? raw[0] : raw;
  const shows = queueShowsFor(canTakeTasks);
  return shows.some((s) => s === v) ? (v as QueueShow) : defaultQueueShow(canTakeTasks);
}

/** The default tab keeps the bare address. */
export function queueShowHref(basePath: string, show: QueueShow, canTakeTasks: boolean): string {
  return show === defaultQueueShow(canTakeTasks) ? basePath : `${basePath}?show=${show}`;
}

interface Takeable {
  status: string;
  assigneeName: string | null;
  assignedToYou: boolean;
}

/** Not taken = nobody holds it and it is not finished. */
export function isNotTaken(t: Takeable): boolean {
  return !t.assignedToYou && !t.assigneeName && t.status === 'not_started';
}

export function filterQueue<T extends Takeable>(tasks: T[], show: QueueShow): T[] {
  if (show === 'mine') return tasks.filter((t) => t.assignedToYou);
  if (show === 'not_taken') return tasks.filter(isNotTaken);
  return tasks;
}
