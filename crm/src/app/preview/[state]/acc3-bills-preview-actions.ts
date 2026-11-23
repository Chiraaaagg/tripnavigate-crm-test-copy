'use server';

/*
 * LOCAL DESIGN-REVIEW GALLERY ONLY. Stand-in server actions for the
 * Accounts phase 3 automatic bills and Settings › Accounts states (acc3-bills-),
 * so a press shows the real success or refusal path without a database.
 * They read nothing and write nothing; the gallery is a 404 outside the
 * local preview mode. Refusal words follow contract section 13.
 */

type Result = { ok: true; data?: unknown; message: string } | { ok: false; code: string; message: string; field?: string };

async function settle<T>(value: T): Promise<T> {
  await new Promise((resolve) => setTimeout(resolve, 60));
  return value;
}

export async function autoBillsOk(): Promise<Result> {
  return settle({ ok: true, message: 'Synthetic preview: automatic bills saved with your reason.' });
}
export async function writeOffOk(): Promise<Result> {
  return settle({ ok: true, message: 'Synthetic preview: write-off settings saved with your reason.' });
}
export async function writeOffLimitRefused(): Promise<Result> {
  return settle({ ok: false, code: 'invalid_input', message: 'The limit must be between ₹1 and ₹5,000.', field: 'limitRupees' });
}
export async function tallyXmlOk(): Promise<Result> {
  return settle({ ok: true, message: 'Synthetic preview: Tally file settings saved with your reason.' });
}
export async function tallyXmlNoName(): Promise<Result> {
  return settle({ ok: false, code: 'invalid_input', message: 'Type the company name exactly as Tally shows it before switching the Tally file on.', field: 'companyName' });
}
export async function reasonShort(): Promise<Result> {
  return settle({ ok: false, code: 'invalid_input', message: 'Write a reason of 10 to 500 characters.', field: 'reason' });
}
export async function docReleaseOk(): Promise<Result> {
  return settle({ ok: true, message: 'Synthetic preview: released as 10101-INV-3.' });
}
export async function docOk(): Promise<Result> {
  return settle({ ok: true, message: 'Synthetic preview: done.' });
}
