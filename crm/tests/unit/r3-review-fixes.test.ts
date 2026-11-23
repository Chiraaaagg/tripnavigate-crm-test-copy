import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { task as hotelTask } from '@/app/preview/[state]/procurement-states';
import { ApprovalRowActions } from '@/components/ui/approval-row-actions';
import { PurchaseTaskPage } from '@/views/purchase-views';
import { keepFirstOk } from '@/views/department/row-decision';

/*
 * R3 independent review fixes (build-notes/review-R3.md). P2-1: Approve is
 * disabled while its post is pending, and a queued second press keeps the
 * first "Done" instead of posting again. P3-6: a blocked Approve stays
 * focusable (aria-disabled, described by the reason) and sits in no form.
 * P3-7: "Enter the charges" gets no header button when the charges form is
 * not on the Work tab. Synthetic values only.
 */

const formStatus = vi.hoisted(() => ({ pending: false }));
vi.mock('react-dom', async (importOriginal) => {
  const real = await importOriginal<typeof import('react-dom')>();
  return { ...real, useFormStatus: () => ({ pending: formStatus.pending, data: null, method: null, action: null }) };
});

afterEach(() => {
  formStatus.pending = false;
});

const approve = { formAction: async () => {}, hiddenFields: { request_id: 'syn-1', decision: 'approve' } };
const render = (props: Parameters<typeof ApprovalRowActions>[0]) => renderToStaticMarkup(createElement(ApprovalRowActions, props));
const approveButton = (html: string) => /<button[^>]*>(?:(?!<\/button>).)*Approve(?:(?!<\/button>).)*<\/button>/s.exec(html)?.[0] ?? '';

describe('P2-1: one decision per Approve press', () => {
  it('Approve is a normal submit while nothing is pending', () => {
    const button = approveButton(render({ recordName: 'SYN-P-1', approve }));
    expect(button).toContain('type="submit"');
    expect(button).not.toMatch(/\sdisabled=""/);
    expect(button).not.toContain('aria-busy');
  });

  it('Approve is disabled and busy while its post is pending', () => {
    formStatus.pending = true;
    const button = approveButton(render({ recordName: 'SYN-P-1', approve }));
    expect(button).toMatch(/\sdisabled=""/);
    expect(button).toContain('aria-busy="true"');
    // The name keeps the record.
    expect(button).toContain('SYN-P-1');
  });

  it('keepFirstOk: after an ok reply a queued second press posts nothing and keeps "Done"', async () => {
    const run = vi.fn(async () => ({ ok: false, message: 'Already decided.' }));
    const once = keepFirstOk(run);
    const done = { ok: true, message: 'Approved.' };
    await expect(once(done, new FormData())).resolves.toBe(done);
    expect(run).not.toHaveBeenCalled();
  });

  it('keepFirstOk: the first press and a retry after a refusal still post', async () => {
    const run = vi.fn(async () => ({ ok: true, message: 'Approved.' }));
    const once = keepFirstOk(run);
    await once(null, new FormData());
    await once({ ok: false, message: 'Not saved.' }, new FormData());
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe('P3-6: a blocked Approve stays focusable and cannot post', () => {
  it('aria-disabled, described by the visible reason, no disabled attribute and no form', () => {
    const html = render({ recordName: 'SYN-P-2', approve, disabledReason: 'You raised this, so a different person approves it.' });
    const button = approveButton(html);
    expect(button).toContain('aria-disabled="true"');
    expect(button).not.toMatch(/\sdisabled=""/);
    expect(button).toContain('type="button"');
    const describedBy = /aria-describedby="([^"]+)"/.exec(button)?.[1];
    expect(describedBy).toBeTruthy();
    expect(html).toMatch(new RegExp(`id="${describedBy}"[^>]*>(?:(?!</p>).)*You raised this`, 's'));
    expect(html).not.toContain('<form');
  });
});

describe('P3-7: the charges step only jumps to a form that is there', () => {
  const page = (chargesEntryShown?: boolean) =>
    renderToStaticMarkup(
      createElement(PurchaseTaskPage, {
        task: { ...hotelTask, assignedToYou: true },
        tabs: { tabs: ['details', 'work'], current: 'work' },
        nextText: 'enter what the supplier keeps and refunds',
        work: createElement('div'),
        chargesEntryShown,
      }),
    );

  it('shows "Enter the charges" when the form is on the Work tab (and when not told)', () => {
    expect(page(true)).toContain('Enter the charges');
    expect(page(undefined)).toContain('Enter the charges');
  });

  it('shows no button when the viewer has no charges form; the Next words stay', () => {
    const html = page(false);
    expect(html).not.toContain('Enter the charges');
    expect(html).not.toContain('href="#purchase-next-charges"');
    expect(html).toContain('enter what the supplier keeps and refunds');
  });
});
