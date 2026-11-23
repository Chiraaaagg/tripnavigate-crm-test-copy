'use server';

/*
 * LOCAL DESIGN-REVIEW GALLERY ONLY. Stand-in server actions for the customer
 * messages states (acc3-messages-), so a press shows the real success or
 * refusal path without a database. They read nothing and write nothing; the
 * gallery is a 404 outside the local preview mode. Refusal texts are the
 * frozen messages of contract §13.
 */

type Result = { ok: true; data?: unknown; message: string } | { ok: false; code: string; message: string; field?: string };

async function settle<T>(value: T): Promise<T> {
  await new Promise((resolve) => setTimeout(resolve, 60));
  return value;
}

export async function cmsgPrefsOk(): Promise<Result> {
  return settle({ ok: true, message: 'Synthetic preview: language and channels saved.' });
}
export async function cmsgPrefsNumber(): Promise<Result> {
  return settle({ ok: false, code: 'invalid_input', message: 'Check the highlighted field.', field: 'whatsappMobile' });
}
export async function cmsgPrefsStale(): Promise<Result> {
  return settle({ ok: false, code: 'version_changed', message: 'Someone changed this just now. Reload the page and try again.' });
}
export async function cmsgResendOk(): Promise<Result> {
  return settle({ ok: true, message: 'Synthetic preview: queued again. It goes in a few seconds.' });
}
export async function cmsgResendWrong(): Promise<Result> {
  return settle({ ok: false, code: 'wrong_state', message: 'This message cannot be sent again in its current state.' });
}
export async function cmsgRestartOk(): Promise<Result> {
  return settle({ ok: true, message: 'Synthetic preview: WhatsApp messages restarted for this number.' });
}
export async function cmsgReasonShort(): Promise<Result> {
  return settle({ ok: false, code: 'invalid_input', message: 'Check the highlighted field.', field: 'reason' });
}
export async function cmsgUploadOk(): Promise<Result> {
  return settle({ ok: true, message: 'Synthetic preview: file stored.' });
}
export async function cmsgReadyOk(): Promise<Result> {
  return settle({ ok: true, message: 'Synthetic preview: queued for the customer by e-mail and WhatsApp.' });
}
export async function cmsgReadyNotConfirmed(): Promise<Result> {
  return settle({ ok: false, code: 'not_ready', message: 'The supplier has not confirmed this booking yet.' });
}
export async function cmsgSettingOk(): Promise<Result> {
  return settle({ ok: true, message: 'Synthetic preview: saved with your reason.' });
}
export async function cmsgTemplateNotApproved(): Promise<Result> {
  return settle({ ok: false, code: 'template_not_approved', message: 'WhatsApp has not approved this message text yet.' });
}
export async function cmsgPilotNotFound(): Promise<Result> {
  return settle({ ok: false, code: 'not_found', message: 'No Deal of this company has that reference. Check it on the Deal page.', field: 'dealReference' });
}

/** Addendum L11: stored and sent, but the passenger link was refused (A's frozen text). */
export async function cmsgUploadNotLinked(): Promise<Result> {
  return settle({ ok: true, message: 'Saved and sent; not linked to this passenger.' });
}
