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
    await expect(page.getByRole('region', { name: 'Cost and payment' })).toContainText('Paid directly · with Accounts');
    // "Approved budget" is the budget line; the payment itself is never described as waiting for an approval.
    await expect(page.getByRole('region', { name: 'Cost and payment' })).not.toContainText(/waiting for (an )?approval|payment approval/i);
    await pillsHaveIconAndWord(page);
  });
});

test.describe('B1.1 Visa & Passport desk', () => {
  test('queue: tasks with state and owner; switched off says what waits', async ({ page }) => {
    await open(page, 'b11-visa-queue');
    const main = page.locator('main');
    // Batch 4: the desk opens on "Not taken" (the task already taken is under Mine and All).
    await expect(main.getByRole('link', { name: /Passport · Renewal/ })).toHaveAttribute('href', /\/app\/visa\//);
    await expect(main.getByRole('link', { name: /Visa · United Arab Emirates/ })).toHaveCount(0);
    await expect(main).toContainText('Not taken');
    await open(page, 'b11-visa-queue-not-launched');
    await expect(page.locator('main')).toContainText('The Visa desk is not started yet.');
    await expect(page.locator('main')).toContainText('Not started yet');
    await open(page, 'b11-visa-queue-empty');
    await expect(page.locator('main')).toContainText('No tasks here yet');
  });

  test('take the task; a colleague taking it first is said in words', async ({ page }) => {
    await open(page, 'b11-visa-task-new');
    await expect(page.locator('main').getByRole('button', { name: 'Take this task' })).toHaveCount(1);
    await open(page, 'b11-visa-task-claim-conflict');
    await expect(page.locator('main [data-slot="error-summary"]')).toContainText('already taken this task');
  });

  test('documents: one status per document, private notice, progress in words', async ({ page }) => {
    await open(page, 'b11-visa-task-docs-pending');
    const main = page.locator('main');
    await expect(main).toContainText('Private applicant documents: Visa & Passport desk and branch Manager only.');
    await expect(main.getByRole('heading', { name: /Documents \(1 of 3 checked\)/ })).toBeVisible();
    await expect(main.getByLabel('Passport copy').first()).toHaveValue('checked');
    await expect(main.getByRole('list', { name: 'Progress for Sample Traveller A' })).toContainText('Now: Documents checked');
  });

  test('submission is refused until every document is checked', async ({ page }) => {
    await open(page, 'b11-visa-task-submit-refused');
    await expect(page.locator('main [data-slot="error-summary"]').first()).toContainText('All required documents must be checked');
  });

  test('the outcome needs the authority document; a fee receipt never proves issue', async ({ page }) => {
    await open(page, 'b11-visa-task-outcome-refused');
    const main = page.locator('main');
    await expect(main.locator('[data-slot="error-summary"]').first()).toContainText('Upload the authority’s document');
    await expect(main).toContainText('A fee receipt or reference never proves issue.');
    await expect(main.getByLabel('Authority’s document')).toHaveAccessibleDescription(/Upload the approval or refusal letter/);
  });

  test('issued: return the documents; refused: inform the customer; returned: closed', async ({ page }) => {
    await open(page, 'b11-visa-task-issued');
    await expect(page.locator('main').getByRole('button', { name: 'Record documents returned to the customer' })).toBeVisible();
    await open(page, 'b11-visa-task-refused');
    await expect(page.locator('main').getByRole('button', { name: 'Record that the customer was informed' })).toBeVisible();
    await open(page, 'b11-visa-task-returned');
    await expect(page.locator('main')).toContainText('This applicant is closed.');
    await expect(page.locator('main')).toContainText('Completed');
  });

  test('a company-paid fee is an expense record for Accounts review', async ({ page }) => {
    await open(page, 'b11-visa-task-fee-expense');
    const costs = page.getByRole('region', { name: 'Fees and costs' });
    await expect(costs).toContainText('It does not approve or make a payment.');
    await expect(costs).toContainText('Sent to Accounts');
  });

  test('a branch Manager reads the desk task without working it', async ({ page }) => {
    await open(page, 'b11-visa-task-manager');
    const main = page.locator('main');
    await expect(main.getByRole('button', { name: 'Record submission' })).toHaveCount(0);
    await expect(main.getByRole('button', { name: 'Take this task' })).toHaveCount(0);
    await expect(main).not.toContainText('Z1234567');
  });

  test('another role gets the same "not available" answer and no file names', async ({ page }) => {
    await open(page, 'b11-visa-task-not-visible');
    const main = page.locator('main');
    await expect(main).toContainText('This task is not available to you.');
    await expect(main).not.toContainText('.pdf');
  });
});
