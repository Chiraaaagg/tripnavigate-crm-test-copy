import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { PROCUREMENT_ERROR_TEXT, PROCUREMENT_UNKNOWN_OUTCOME_TEXT } from '@/modules/procurement/contracts';

vi.mock('@/modules/procurement/server/actions', () => ({
  addBeneficiaryAction: vi.fn(),
  addQuoteAction: vi.fn(),
  approveBeneficiaryAction: vi.fn(),
  approveOverBudgetAction: vi.fn(),
  reassignTaskAction: vi.fn(),
  releaseTaskAction: vi.fn(),
  verifySupplierAction: vi.fn(),
  confirmSupplierAction: vi.fn(),
  createSupplierAction: vi.fn(),
  proposeCostAction: vi.fn(),
  removePurchaseEvidenceAction: vi.fn(),
  updateSupplierAction: vi.fn(),
  uploadPurchaseEvidenceAction: vi.fn(),
  withdrawQuoteAction: vi.fn(),
}));

const { ConfirmSupplierForm, UNEXPECTED_TEXT, keepSubmittedReference } = await import('@/views/procurement-forms');

const TASK = 'f0000000-0000-4000-8000-000000000001';
const props = { taskId: TASK, latestVersionNo: 2, issues: [] };
const referenceInput = (html: string) => /<input[^>]*id="supplier-ref"[^>]*>/.exec(html)?.[0] ?? '';

describe('supplier confirmation form after a save (review fix 2)', () => {
  it('a failed save shows the typed supplier reference in the field again', () => {
    const html = renderToStaticMarkup(
      createElement(ConfirmSupplierForm, {
        ...props,
        initialState: { ok: false, code: 'version_changed', message: PROCUREMENT_ERROR_TEXT.version_changed, values: { reference: 'SYN-CONF-0042' } },
      }),
    );
    expect(referenceInput(html)).toContain('value="SYN-CONF-0042"');
  });

  it('escapes the echoed reference', () => {
    const html = renderToStaticMarkup(
      createElement(ConfirmSupplierForm, {
        ...props,
        initialState: { ok: false, code: 'invalid_input', message: PROCUREMENT_ERROR_TEXT.invalid_input, values: { reference: '"><script>x</script>' } },
      }),
    );
    // React adds its own form-replay <script>; the echoed payload must never appear raw.
    expect(html).not.toContain('<script>x</script>');
    expect(referenceInput(html)).toContain('value="&quot;&gt;&lt;script&gt;x&lt;/script&gt;"');
  });

  it('a successful save clears the field', () => {
    const html = renderToStaticMarkup(
      createElement(ConfirmSupplierForm, { ...props, initialState: { ok: true, data: { outcome: 'created' }, message: 'Done' } }),
    );
    expect(referenceInput(html)).not.toMatch(/value="[^"]/);
  });

  it('an unexpected failure (thrown, no server reply) keeps the reference typed in the form, so the message is true', () => {
    const fd = new FormData();
    fd.set('reference', 'SYN-CONF-0007');
    const result = keepSubmittedReference({ ok: false, code: 'unexpected', message: UNEXPECTED_TEXT }, fd);
    expect(result).toMatchObject({ ok: false, values: { reference: 'SYN-CONF-0007' } });
    expect(UNEXPECTED_TEXT).toBe(`${PROCUREMENT_UNKNOWN_OUTCOME_TEXT} Your typed details are still here.`);
  });
});
