'use server';

/*
 * LOCAL DESIGN-REVIEW GALLERY ONLY. Stand-in server actions for the Accounts
 * phase 2 settings states (acc2-settings-): fixed synthetic answers, nothing
 * read or written; the gallery is a 404 outside the local preview mode.
 */

type Result = { ok: true; data?: unknown; message: string } | { ok: false; code: string; message: string; field?: string };

async function settle<T>(value: T): Promise<T> {
  await new Promise((resolve) => setTimeout(resolve, 60));
  return value;
}

export async function acc2MappingSaveOk(): Promise<Result> {
  return settle({ ok: true, message: 'Synthetic preview: mapping saved. The next export uses the new names.' });
}
export async function acc2MappingSaveRefused(): Promise<Result> {
  return settle({ ok: false, code: 'invalid_input', message: 'Check the highlighted field.', field: 'creditLedger' });
}
export async function acc2SwitchOk(): Promise<Result> {
  return settle({ ok: true, message: 'Synthetic preview: saved. The change is recorded with your reason.' });
}
export async function acc2SwitchRefused(): Promise<Result> {
  return settle({ ok: false, code: 'invalid_input', message: 'Check the highlighted field.', field: 'reason' });
}
export async function acc2NoticeNoop(): Promise<{ ok: false; code: 'not_authorized'; message: string }> {
  return settle({ ok: false, code: 'not_authorized', message: 'Preview only.' });
}
