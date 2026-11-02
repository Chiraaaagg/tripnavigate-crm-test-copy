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

  test('Flight: travellers on this flight, the ₹50,000 direct-payment rule, proof upload', async ({ page }) => {
    await open(page, 'b11-flight-task-cost-empty');
    const main = page.locator('main');
    await expect(main.getByRole('list', { name: 'Travellers on this flight' })).toContainText('Sample Traveller B');
    await expect(main).toContainText('Company can pay directly up to ₹50,000 per purchase.');
    await main.getByRole('button', { name: 'Record a cost' }).click();
    const form = page.getByRole('form', { name: 'Record a cost' });
    await form.getByLabel('Paid by').selectOption('company');
    await form.getByLabel('Amount ₹').fill('60000');
    await expect(form.getByLabel('Amount ₹')).toHaveAttribute('aria-invalid', 'true');
    await expect(form.getByRole('button', { name: 'Save cost' })).toBeDisabled();
  });

  test('Flight on an international trip: the assigned person sees identity in full; none when absent', async ({ page }) => {
    await open(page, 'b11-flight-task-identity');
    const list = page.locator('main').getByRole('list', { name: 'Travellers on this flight' });
    await expect(list.getByRole('listitem').first()).toContainText('Born 1988-04-12 · Indian · passport Z1234567, expires 2031-02-01');
    await expect(list.getByRole('listitem').nth(1)).not.toContainText('passport');
    await open(page, 'b11-flight-task-cost-empty');
    await expect(page.locator('main').getByRole('list', { name: 'Travellers on this flight' })).not.toContainText('passport');
  });

  test('over the limit: the refusal is in words and the field is marked', async ({ page }) => {
    await open(page, 'b11-flight-task-cost-over-limit');
    const form = page.getByRole('form', { name: 'Record a cost' });
    await expect(form.locator('[data-slot="error-summary"]')).toContainText('Above ₹50,000');
    await expect(form.getByLabel('Amount ₹')).toHaveAttribute('aria-invalid', 'true');
  });

  test('a company-paid cost is sent to Accounts as an expense record, never an approval', async ({ page }) => {
    await open(page, 'b11-flight-task-cost-filled');
    const card = page.getByRole('region', { name: 'Cost' });
    await expect(card.getByRole('button', { name: 'Send to Accounts' })).toBeVisible();
    await expect(card).toContainText('synthetic-card-slip.pdf');
    await open(page, 'b11-flight-task-cost-sent');
    await expect(page.getByRole('region', { name: 'Cost' })).toContainText('Sent to Accounts. A different Accounts person reviews it. This is not a payment approval.');
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
