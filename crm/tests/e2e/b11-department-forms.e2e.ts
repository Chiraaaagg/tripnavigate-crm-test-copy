import { expect, test } from '@playwright/test';
import { LOCAL_NETWORK_ACCESS_OFF } from '../helpers/production-style-policy';
import { accessibilitySuite, COMMERCIAL_WORDS, cspSuite, open, pillsHaveIconAndWord } from './b11-helpers';

/**
 * B1.1c department work forms (Purchase placeholder, Flight cost block) and
 * the Visa & Passport desk, on the preview gallery. Departments never see the
 * selling price, plan, reported payments, contacts or billing.
 */

test.use(LOCAL_NETWORK_ACCESS_OFF);

const STATES = [
  'b11-purchase-task-no-price',
  'b11-flight-task-cost-empty',
  'b11-flight-task-cost-filled',
  'b11-flight-task-cost-over-limit',
  'b11-flight-task-cost-sent',
  'b11-flight-task-identity',
  'b11-visa-queue',
  'b11-visa-queue-empty',
  'b11-visa-queue-not-launched',
  'b11-visa-queue-loading',
  'b11-visa-task-new',
  'b11-visa-task-claim-conflict',
  'b11-visa-task-docs-pending',
  'b11-visa-task-submit-refused',
  'b11-visa-task-submitted',
  'b11-visa-task-outcome-refused',
  'b11-visa-task-issued',
  'b11-visa-task-refused',
  'b11-visa-task-returned',
  'b11-visa-task-passport',
  'b11-visa-task-fee-expense',
  'b11-visa-task-manager',
  'b11-visa-task-not-visible',
];

accessibilitySuite('B1.1 department forms and desk: accessibility', STATES);
cspSuite('B1.1 department forms and desk: production style policy', STATES);

test.describe('B1.1 departments see no commercial data', () => {
  for (const state of STATES) {
    test(`no selling price, plan, reported payments or billing: ${state}`, async ({ page }) => {
      await open(page, state);
      const text = await page.locator('main').innerText();
      for (const word of COMMERCIAL_WORDS) expect(text, `${state}: ${word}`).not.toMatch(word);
    });
  }
});

test.describe('B1.1 department cost block', () => {
  test('Purchase: a read-only placeholder, no cost inputs', async ({ page }) => {
    await open(page, 'b11-purchase-task-no-price');
    const card = page.getByRole('region', { name: 'Cost' });
    await expect(card).toContainText('Costs are recorded in the supplier work.');
    await expect(card).not.toContainText('B2/B3');
    await expect(card.getByRole('button', { name: 'Record a cost' })).toHaveCount(0);
  });

  // Flight build (contract D3 / B13, 4 Nov 2026): the manual flight cost card ("Record a cost") is retired; the
  // per-passenger fares confirmed with the tickets are the only flight cost record. Track C points the old
  // b11-flight-task-* states at the new Flight workspace; the rules these four tests covered are checked there.
  test('Flight: travellers on this flight, the ₹50,000 direct-payment rule, proof upload', async ({ page }) => {
    await open(page, 'b11-flight-task-cost-empty');
    const main = page.locator('main');
    // Kept: the travellers on this flight are listed (D7: by name).
    await expect(main).toContainText('Example Traveller One');
    // The ₹50,000 rule is now cumulative per supplier and Deal (C1/L1), stated on the Cost and payment card.
    const card = page.getByRole('region', { name: 'Cost and payment' });
    await expect(card).toContainText('within ₹50,000 for this supplier on this Deal');
    // Retired: no manual cost form; the direct payment (with its proof upload) replaces it.
    await expect(main.getByRole('button', { name: 'Record a cost' })).toHaveCount(0);
    await expect(card.getByRole('button', { name: 'Record direct payment' })).toBeVisible();
  });

  test('Flight on an international trip: the assigned person sees identity in full; none when absent', async ({ page }) => {
    // Kept (freeze 3.4 answer 6, unchanged by D7): identity only for the Flight assignee on international trips.
    await open(page, 'b11-flight-task-identity');
    await expect(page.locator('main')).toContainText('Born 1985-02-11 · Indian · passport S0000001, expires 2031-05-01');
    await open(page, 'b4-flight-task-details');
    await expect(page.locator('main')).not.toContainText('passport');
  });

  test('over the limit: the refusal is in words and the field is marked', async ({ page }) => {
    // Flight build (C1, 11.1): above ₹50,000 for the supplier on the Deal, "Record direct payment" is unavailable
    // with aria-disabled and one short reason in words (no form to mark any more).
    await open(page, 'b11-flight-task-cost-over-limit');
    const card = page.getByRole('region', { name: 'Cost and payment' });
    const direct = card.getByRole('button', { name: 'Record direct payment' });
    await expect(direct).toHaveAttribute('aria-disabled', 'true');
    await expect(direct).toHaveAccessibleDescription('Above ₹50,000 for this supplier on this Deal: raise a payment request.');
    await expect(card.getByRole('button', { name: 'Raise payment request' })).toBeVisible();
  });

  test('a company-paid cost is sent to Accounts as an expense record, never an approval', async ({ page }) => {
    // Flight build (B9, L16): a direct payment goes to Accounts for review (accept/return), not as an approval.
    await open(page, 'b11-flight-task-cost-filled');
    const card = page.getByRole('region', { name: 'Cost and payment' });
    await expect(card).toContainText('returned by Accounts');
    await expect(card.getByRole('button', { name: 'Fix and send the payment again' })).toBeVisible();
    await open(page, 'b11-flight-task-cost-sent');
    // R3 (O9): a finished payment step folds to one line on the Work tab; open it to read the card.
    const paymentFold = page.locator('details#step-payment');
    if ((await paymentFold.count()) > 0 && (await paymentFold.getAttribute('open')) === null) await paymentFold.locator('summary').click();
    await expect(page.getByRole('region', { name: 'Cost and payment' })).toContainText('Paid directly · with Accounts');
    // "Approved budget" is the budget line; the payment itself is never described as waiting for an approval.
    await expect(page.getByRole('region', { name: 'Cost and payment' })).not.toContainText(/waiting for (an )?approval|payment approval/i);
    await pillsHaveIconAndWord(page);
  });
});

// Visa build (contract 8 Nov 2026, 11.1): the old B1.1 desk (views/b11/visa-desk.tsx) is retired; the b11-visa-* state
// names now open the new screens (src/app/preview/[state]/visa-states.tsx aliases). Each test below keeps the old test's
// intent and states what replaced the old wording. The new screens are covered in depth by tests/e2e/visa-screens.e2e.ts.
test.describe('B1.1 Visa & Passport desk (now the Visa build screens)', () => {
  test('queue: tasks with state and owner; switched off says what waits; an empty queue says so', async ({ page }) => {
    await open(page, 'b11-visa-queue');
    const main = page.locator('main');
    // Was: "Passport · Renewal" link and "Not taken". Now: task links to /app/visa/<id> and the frozen status words (section 8).
    await expect(main.locator('a[href*="/app/visa/"]').first()).toBeVisible();
    await expect(main).toContainText('Not taken');
    // Kept (lead, contract Addendum 1): the queue still says when task creation is switched off.
    await open(page, 'b11-visa-queue-not-launched');
    await expect(page.locator('main')).toContainText('The Visa desk is not started yet.');
    await expect(page.locator('main')).toContainText('Not started yet');
    await open(page, 'b11-visa-queue-empty');
    await expect(page.locator('main a[href*="/app/visa/"]')).toHaveCount(0);
  });

  test('take the task; a colleague taking it first is said in words', async ({ page }) => {
    await open(page, 'b11-visa-task-new');
    await expect(page.locator('main').getByRole('button', { name: 'Take this task' })).toHaveCount(1);
    await open(page, 'b11-visa-task-claim-conflict');
    // Was: "already taken this task". Now the frozen task_conflict message (6.1).
    await expect(page.locator('main')).toContainText('Someone at the desk took this task first.');
  });

  test('documents: received and not received per passenger, in words', async ({ page }) => {
    // Was: "Documents (1 of 3 checked)" with a per-document status select. Q4: "received" replaces "checked"; the
    // Passengers table has Received / Not received columns (11.1).
    await open(page, 'b11-visa-task-docs-pending');
    const table = page.getByRole('region', { name: /Passengers and documents/ }).first();
    await expect(table).toContainText('Received documents');
    await expect(table).toContainText('Not received documents');
    await expect(page.locator('main')).not.toContainText(/\bchecked\b/i);
  });

  test('Applied is refused until the passenger is ready; nothing saved', async ({ page }) => {
    // Was: "All required documents must be checked". Now the Confirm applied popup shows the refusal and keeps the typed values.
    await open(page, 'b11-visa-task-submit-refused');
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.locator('[role=alert], [role=status]').or(page.getByText('Nothing was saved')).first()).toBeVisible();
  });

  test('the decision needs the visa or refusal document (V5)', async ({ page }) => {
    // Was: "Upload the authority's document" + "A fee receipt or reference never proves issue." Now outcome_document_required (6.1).
    await open(page, 'b11-visa-task-outcome-refused');
    await expect(page.getByRole('dialog')).toContainText('Upload the visa or refusal document first.');
  });

  test('approved: handover pending; rejected: Apply again; completed: closed', async ({ page }) => {
    // Was: "Record documents returned" / "Record that the customer was informed" / "This applicant is closed." (old steps).
    await open(page, 'b11-visa-task-issued');
    await expect(page.locator('main')).toContainText('Handover pending');
    await open(page, 'b11-visa-task-refused');
    await expect(page.locator('main').getByRole('button', { name: /Apply again/ }).first()).toBeVisible();
    await open(page, 'b11-visa-task-returned');
    await expect(page.locator('main')).toContainText('Completed');
  });

  test('a company-paid fee is a cost for Accounts review, never a payment', async ({ page }) => {
    // Was: region "Fees and costs" with "It does not approve or make a payment." / "Sent to Accounts". Now "Visa costs per
    // traveller" (V9) and the returned-fee "Fix fee" (C12).
    await open(page, 'b11-visa-task-fee-expense');
    const main = page.locator('main');
    await expect(main).toContainText('Visa costs per traveller');
    await expect(main).toContainText(/These are costs, not the customer.s price\./);
    await expect(main.getByRole('button', { name: 'Fix fee' }).first()).toBeVisible();
  });

  test('a branch Manager reads the desk task without working it', async ({ page }) => {
    await open(page, 'b11-visa-task-manager');
    const main = page.locator('main');
    // Was: no "Record submission" button. Now no Applied or Edit controls (D2).
    await expect(main.getByRole('button', { name: /^(Confirm applied|Mark as applied|Edit)/ })).toHaveCount(0);
    await expect(main.getByRole('button', { name: 'Take this task' })).toHaveCount(0);
    await expect(main).toContainText('View only. The Visa desk does this work.');
    await expect(main).not.toContainText('Z1234567');
  });

  test('another role gets the same "not available" answer and no file names', async ({ page }) => {
    await open(page, 'b11-visa-task-not-visible');
    const main = page.locator('main');
    // Was: "This task is not available to you." Now the shared not-available answer (11.1 "Same answer for missing and not allowed").
    await expect(main).toContainText(/not available/i);
    await expect(main).not.toContainText('.pdf');
  });
});

/**
 * R3 approved-form exceptions on the Purchase Work tab (owner, 16 November 2026;
 * design plan 2.4): O5 "What Sales booked" as one line with a fold, O6 the
 * "Next:" target ids, O7 jump links, "Add a rate" folded after the final rate,
 * finished payment requests as one line each. No field, label or rule changed.
 */
test.describe('R3 Purchase Work tab (O5, O6, O7)', () => {
  test('O5: what Sales booked is one line; the special request stays in full; the facts fold', async ({ page }) => {
    await open(page, 'pb-task-work-final-rate');
    const main = page.locator('main');
    await expect(main.locator('[data-slot="booked-line"]')).toContainText(/Approved budget ₹/);
    await expect(main.getByText('Special request', { exact: true }).first()).toBeVisible();
    const fold = main.locator('details#work-booked');
    await expect(fold).not.toHaveAttribute('open', '');
    await expect(page.getByRole('region', { name: 'Travellers and budget' })).toBeHidden();
    await fold.locator('summary').click();
    await expect(page.getByRole('region', { name: 'Travellers and budget' })).toBeVisible();
    // The special request is shown once, above the fold, not repeated inside it.
    await expect(fold.getByText('Special request', { exact: true })).toHaveCount(0);
  });

  test('O7: jump links Rates · Payments · Files move to their cards', async ({ page }) => {
    await open(page, 'pb-task-work-go-ahead-given');
    const nav = page.getByRole('navigation', { name: 'On this page' });
    await expect(nav.getByRole('link')).toHaveText(['Rates', 'Payments', 'Files']);
    await expect(nav.getByRole('link', { name: 'Payments' })).toHaveAttribute('href', '#work-payments');
    await nav.getByRole('link', { name: 'Files' }).click();
    // R3 integration: the shared JumpLinks moves focus to the card too (the address keeps no hash; without script it is a plain #work-files link).
    await expect(page.locator('#work-files')).toBeFocused();
    await expect(page.locator('#work-files')).toBeInViewport();
  });

  test('O7: "Add a rate" is open before a final rate and folded after it, with the same form', async ({ page }) => {
    await open(page, 'pb-task-work-no-rates');
    await expect(page.locator('#purchase-next-add-rate').getByRole('form', { name: 'Add a rate' })).toBeVisible();
    await open(page, 'pb-task-work-final-rate');
    const form = page.getByRole('form', { name: 'Add a rate' });
    await expect(form).toBeHidden();
    await page.locator('main summary', { hasText: 'Add a rate' }).click();
    await expect(form).toBeVisible();
    await expect(form.getByRole('button', { name: 'Add rate' })).toBeVisible();
  });

  test('O7: a finished payment request is one line; the waiting ones stay open', async ({ page }) => {
    await open(page, 'pb-task-work-confirmed');
    const list = page.getByRole('list', { name: 'Payment requests on this service' });
    const verified = list.locator('details').filter({ hasText: 'SP-2026-00004' });
    await expect(verified.locator('summary')).toContainText('Paid and verified');
    await expect(verified).not.toHaveAttribute('open', '');
    await expect(verified.getByText('reference SYNUTR0001')).toBeHidden();
    await verified.locator('summary').click();
    await expect(verified.getByText(/reference SYNUTR0001/)).toBeVisible();
    // Returned (can be sent again) and on-hold requests are not folded.
    await expect(list.locator('details')).toHaveCount(1);
    await expect(list.getByRole('button', { name: 'Change and send again' })).toBeVisible();
  });

  test('O6: the Work tab carries the "Next:" target ids of the header (helper C1)', async ({ page }) => {
    for (const [state, id] of [
      ['pb-task-work-no-rates', 'purchase-next-add-rate'],
      ['pb-task-work-final-rate', 'purchase-next-booking-request'],
      ['pb-task-work-go-ahead-given', 'purchase-next-confirmation'],
      ['pb-task-work-cancelled', 'purchase-next-charges'],
    ] as const) {
      await open(page, state);
      await expect(page.locator(`#${id}`), `${state}: #${id}`).toHaveCount(1);
    }
  });
});
