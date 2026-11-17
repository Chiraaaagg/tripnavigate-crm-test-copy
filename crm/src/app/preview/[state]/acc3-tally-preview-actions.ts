'use server';

import { TALLY_PREVIEW, TALLY_PREVIEW_EMPTY, MATCH_BATCH } from './acc3-tally-fixtures';

/*
 * LOCAL DESIGN-REVIEW GALLERY ONLY. Stand-in server actions for the Tally
 * file states (acc3-tally-). They read nothing (the uploaded file is not even
 * opened) and write nothing; the gallery is a 404 outside local preview mode.
 * Refusal texts are the frozen messages of contract 13 (track C owns them).
 */

type Result = { ok: true; data?: unknown; message: string } | { ok: false; code: string; message: string; field?: string };

async function settle<T>(value: T): Promise<T> {
  await new Promise((resolve) => setTimeout(resolve, 60));
  return value;
}

export async function tfPreviewOk(): Promise<Result> {
  return settle({ ok: true, message: 'Checked.', data: TALLY_PREVIEW });
}
export async function tfPreviewNothing(): Promise<Result> {
  return settle({ ok: true, message: 'Checked.', data: TALLY_PREVIEW_EMPTY });
}
export async function tfCreateOk(): Promise<Result> {
  return settle({ ok: true, message: 'Tally file made.', data: { exportId: 'a0003401-0000-4000-8000-000000003401', exportNo: 'TE-2026-000031', lines: 3, leftOut: 3 } });
}
export async function tfCreateNothing(): Promise<Result> {
  return settle({ ok: false, code: 'nothing_to_export', message: 'Nothing can go into the file. See the left-out list for the reasons.' });
}
export async function tfCreateOff(): Promise<Result> {
  return settle({ ok: false, code: 'tally_xml_off', message: 'The Tally file is not switched on yet.' });
}
export async function tfCreateReason(): Promise<Result> {
  return settle({ ok: false, code: 'invalid_input', message: 'Say why the entries go in again (10 to 500 characters).', field: 'includeReason' });
}
export async function tfStageOk(): Promise<Result> {
  return settle({ ok: true, message: 'Checked.', data: MATCH_BATCH });
}
export async function tfStageDuplicate(): Promise<Result> {
  return settle({ ok: false, code: 'already_recorded', message: 'This file was already uploaded. Open the earlier upload from the Tally page.' });
}
export async function tfApplyOk(): Promise<Result> {
  return settle({ ok: true, message: 'Synthetic preview: 3 entries matched, 1 Tally exception opened.' });
}
export async function tfApplyChanged(): Promise<Result> {
  return settle({ ok: false, code: 'version_changed', message: 'Someone changed this meanwhile. Reload and try again.' });
}
export async function tfCancelOk(): Promise<Result> {
  return settle({ ok: true, message: 'Synthetic preview: upload cancelled. Nothing changed.' });
}
export async function tfPartyNameOk(): Promise<Result> {
  return settle({ ok: true, message: 'Tally party name saved.' });
}
