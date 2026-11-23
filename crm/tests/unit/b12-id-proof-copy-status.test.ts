import { describe, expect, it } from 'vitest';
import { IdProofCopyAlertsSchema, IdProofCopyStatusSchema } from '@/modules/fulfilment/b11-commands';
import { toIdProofCopyAlertViews, toIdProofCopyView, withIdProofCopies } from '@/modules/fulfilment/b11-dto';
import { ID_PROOF_FIELD, parseIdProofCopyRetryForm } from '@/modules/fulfilment/b11-forms';
import { type BookNowView, ID_PROOF_COPY_STATUS_TEXT, ID_PROOF_COPY_STATUSES, idProofCopyReasonText } from '@/modules/fulfilment/contracts';
import { FIELD } from '@/modules/fulfilment/forms';

/** DEC-43 copy status wording, view rules, Super Admin alerts and the retry form (Terra's TS layer). Synthetic ids; codes only. */

const JOB = 'b1000000-0000-4000-8000-000000000001';
const JOB2 = 'b1000000-0000-4000-8000-000000000002';
const TRAVELLER = 'b2000000-0000-4000-8000-000000000001';
const PROOF = 'b3000000-0000-4000-8000-000000000001';
const DEAL = 'd1000000-0000-4000-8000-000000000001';

const row = (over: Record<string, unknown> = {}) =>
  IdProofCopyStatusSchema.parse([{ jobId: JOB, travellerId: TRAVELLER, idProofId: PROOF, status: 'failed', attempts: 5, maxAttempts: 5, lastErrorCode: 'bitrix_refused', updatedAt: '2026-10-13T10:00:00Z', sentAt: null, ...over }])[0]!;

describe('wording', () => {
  it('every status has words; codes map exactly, by prefix, then to a general line; never echo the code', () => {
    for (const s of ID_PROOF_COPY_STATUSES) expect(ID_PROOF_COPY_STATUS_TEXT[s]).toEqual(expect.any(String));
    expect(idProofCopyReasonText(null)).toBeNull();
    expect(idProofCopyReasonText('rate_limited')).toContain('slow down');
    expect(idProofCopyReasonText('read_provider_timeout')).toContain('could not be read');
    expect(idProofCopyReasonText('answer_http_5xx')).toContain('did not answer clearly');
    const odd = idProofCopyReasonText('some_new_code')!;
    expect(odd).not.toContain('some_new_code');
  });
});

describe('view', () => {
  it('failed: Try again for editors; lost files or refused sign-in: Super Admin only; sent: no reason', () => {
    expect(toIdProofCopyView(row())).toMatchObject({ canRetry: true, retryNeedsSuperAdmin: false, reasonText: 'Bitrix refused the file.' });
    expect(toIdProofCopyView(row({ lastErrorCode: 'prior_files_lost' }))).toMatchObject({ canRetry: false, retryNeedsSuperAdmin: true });
    expect(toIdProofCopyView(row({ status: 'sent', lastErrorCode: null, sentAt: '2026-10-13T10:05:00Z' }))).toMatchObject({ canRetry: false, reasonText: null, statusText: 'Copied to the Bitrix deal.' });
    expect(toIdProofCopyView(row({ status: 'pending', lastErrorCode: 'rate_limited' }))).toMatchObject({ canRetry: false, reasonText: expect.stringContaining('slow down') });
  });

  it('an unknown future status reads as "being checked"; needs_manual_check is the Super Admin\'s to retry', () => {
    expect(row({ status: 'something_new' }).status).toBe('unknown');
    expect(toIdProofCopyView(row({ status: 'needs_manual_check', lastErrorCode: 'read_back_failed' }))).toMatchObject({
      statusText: expect.stringContaining('stopped trying'),
      reasonText: expect.stringContaining('could not be read'),
      canRetry: false,
      retryNeedsSuperAdmin: true,
    });
  });

  it('Book now: the newest job per proof is attached to that proof only', () => {
    const view = {
      travellers: [
        { seq: 1, idProofs: [{ fileId: PROOF }, { fileId: 'b3000000-0000-4000-8000-000000000009' }] },
        { seq: 2 },
      ],
    } as unknown as BookNowView;
    const rows = IdProofCopyStatusSchema.parse([
      { jobId: JOB, travellerId: TRAVELLER, idProofId: PROOF, status: 'cancelled', attempts: 0, maxAttempts: 5, updatedAt: '2026-10-13T09:00:00Z' },
      { jobId: JOB2, travellerId: TRAVELLER, idProofId: PROOF, status: 'sent', attempts: 1, maxAttempts: 5, updatedAt: '2026-10-13T10:00:00Z', sentAt: '2026-10-13T10:00:00Z' },
    ]);
    const out = withIdProofCopies(view, rows);
    expect(out.travellers[0]!.idProofs![0]!.bitrixCopy).toMatchObject({ jobId: JOB2, status: 'sent' });
    expect(out.travellers[0]!.idProofs![1]!.bitrixCopy).toBeUndefined();
    expect(out.travellers[1]).toEqual({ seq: 2 });
    expect(withIdProofCopies(view, null)).toBe(view);
  });

  it('alerts: stops (open first as given) and copies to check by hand; plain reasons; Bitrix Deal number kept as text', () => {
    const alerts = toIdProofCopyAlertViews(
      IdProofCopyAlertsSchema.parse({
        stops: [{ stopId: JOB, jobId: JOB2, bitrixDealId: '991234', reasonCode: 'prior_files_lost', openedAt: '2026-10-13T10:00:00Z', acknowledgedAt: null }],
        manualChecks: [{ jobId: JOB, bitrixDealId: '991235', lastErrorCode: 'answer_timeout', readBackAttempts: 5, updatedAt: '2026-10-13T11:00:00Z' }],
      }),
    );
    expect(alerts.stops).toEqual([{ stopId: JOB, jobId: JOB2, bitrixDealId: '991234', reasonText: expect.stringContaining('stopped for safety'), openedAt: '2026-10-13T10:00:00Z', acknowledgedAt: null, open: true }]);
    expect(alerts.manualChecks).toEqual([{ jobId: JOB, bitrixDealId: '991235', reasonText: expect.stringContaining('did not answer clearly'), readBackAttempts: 5, updatedAt: '2026-10-13T11:00:00Z', statusText: expect.stringContaining('stopped trying') }]);
    expect(IdProofCopyAlertsSchema.parse({ stops: [] }).manualChecks).toEqual([]);
  });
});

describe('retry form', () => {
  it('needs the job id; the Deal is optional (the Super Admin\'s list has none) but must be valid when given', () => {
    const f = new FormData();
    f.set(FIELD.dealId, DEAL);
    f.set(ID_PROOF_FIELD.copyJobId, JOB);
    expect(parseIdProofCopyRetryForm(f)).toEqual({ ok: true, value: { dealId: DEAL, jobId: JOB } });
    expect(parseIdProofCopyRetryForm(new FormData())).toEqual({ ok: false, fields: [ID_PROOF_FIELD.copyJobId] });
    const noDeal = new FormData();
    noDeal.set(ID_PROOF_FIELD.copyJobId, JOB);
    expect(parseIdProofCopyRetryForm(noDeal)).toEqual({ ok: true, value: { dealId: null, jobId: JOB } });
    const badDeal = new FormData();
    badDeal.set(FIELD.dealId, 'nope');
    badDeal.set(ID_PROOF_FIELD.copyJobId, JOB);
    expect(parseIdProofCopyRetryForm(badDeal)).toEqual({ ok: false, fields: [FIELD.dealId] });
  });
});
