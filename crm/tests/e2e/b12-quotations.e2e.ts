import { expect, test } from '@playwright/test';
import { LOCAL_NETWORK_ACCESS_OFF } from '../helpers/production-style-policy';
import { accessibilitySuite, COMMERCIAL_WORDS, cspSuite, open, pillsHaveIconAndWord } from './b11-helpers';

/**
 * B1.2 quotations (Phase E) through the design preview states (synthetic
 * props; stand-in actions). Visual and interaction evidence only; the real
 * journey is b12-quote-to-booking.real.e2e.ts on a local real stack.
 */

test.use(LOCAL_NETWORK_ACCESS_OFF);

const STATES = [
  'b12-quote-lead-card',
  'b12-quote-lead-card-empty',
  'b12-quote-deal-card-lost',
  'b12-quote-draft',
  'b12-quote-ready',
  'b12-quote-ready-gstin-pending',
  'b12-quote-sent',
  'b12-quote-expired',
  'b12-quote-declined',
  'b12-quote-mismatch',
  'b12-quote-no-money',
  'b12-quote-accepted-waiting',
  'b12-quote-accepted-candidate',
  'b12-quote-accepted-ready',
  'b12-quote-converted',
  'b12-quote-preview',
  'b12-quote-preview-partial',
  'b12-quote-preview-no-money',
  'b12-quote-preview-blocked',
  'b12-quote-preview-gstin-pending',
  'b12-quote-not-available',
  'b2-quote-untouched',
  'b2-quote-inline',
  'b2-quote-prices-refused',
  'b2-quote-draft-saving',
];

accessibilitySuite('B1.2 quotations: accessibility', STATES);
cspSuite('B1.2 quotations: production style policy', STATES);

test.describe('B1.2 quotations: forms (stand-in actions)', () => {
  test('draft: nothing red until "Check and mark ready"; the server not-ready list then links into the closed part and focuses the field', async ({ page }) => {
    await open(page, 'b12-quote-draft');
    const main = page.locator('main');
    await expect(main).not.toContainText('To finish before sharing');
    await expect(main.locator('[data-slot="page-error-summary"]')).toHaveCount(0);
    // Warnings never block; the internal ones carry an "Internal" tag (price readers only).
    await expect(main.getByRole('link', { name: /Worth checking: The line prices do not add up to the quoted total/ })).toBeVisible();
    for (const id of ['details', 'contact', 'services', 'narrative', 'money', 'plan']) await expect(page.locator(`section#${id}`)).toHaveCount(1);
    // Enabled (keyboard and screen readers can always press it); the database still decides (stand-in answers not_ready).
    await main.getByRole('button', { name: 'Check and mark ready' }).click();
    const summary = page.locator('#quote-check-summary');
    await expect(summary).toBeFocused();
    await expect(summary).not.toHaveAttribute('role', 'alert');
    await expect(summary.getByRole('heading', { name: 'To finish before sharing (2)' })).toBeVisible();
    await expect(summary.getByRole('link', { name: /^Customer: Add the customer’s name/ })).toHaveAttribute('href', '#q-contact-contactName');
    await expect(main.getByRole('navigation', { name: 'Edit or customer copy' }).getByRole('link', { name: 'Customer copy' })).toHaveAttribute('href', /\/app\/quotations\/.+\/preview$/);
    const total = summary.getByRole('link', { name: 'Prices: Type the final quoted total.' });
    await expect(total).toHaveAttribute('href', '#q-total-quoted');
    await expect(page.locator('#money-body')).toBeHidden();
    await total.click();
    await expect(page.locator('#q-total-quoted')).toBeFocused();
    await expect(page.locator('section#money').getByRole('button', { name: /5\. Prices\s*Needs input/ })).toBeVisible();
  });

  test('a refused section keeps typed values and names the fields', async ({ page }) => {
    await open(page, 'b12-quote-draft');
    await page.locator('section#details').getByRole('button', { name: /1\. Trip/ }).click();
    const destination = page.locator('#q-details-destination');
    await destination.fill('Ubud only');
    await expect(page.locator('section#details')).toContainText('Not saved yet');
    await page.getByRole('button', { name: 'Save trip and travellers' }).click();
    const alert = page.locator('section#details').getByRole('alert');
    await expect(alert).toContainText('Some details are missing or not valid.');
    await expect(alert.getByRole('link', { name: 'End date: on or after the start' })).toHaveAttribute('href', '#q-details-tripEnd');
    await expect(page.locator('#q-details-tripEnd')).toHaveAttribute('aria-invalid', 'true');
    await expect(destination).toHaveValue('Ubud only');
  });

  test('customer text with internal words is refused before saving; the typed text stays and the field says why', async ({ page }) => {
    await open(page, 'b12-quote-draft');
    await page.locator('section#narrative').getByRole('button', { name: /4\. Day plan and terms/ }).click();
    const title = page.locator('#q-day-1-title');
    await title.fill('Arrival, net rate dinner');
    await page.locator('#q-narrative-include').fill('Daily breakfast');
    await page.getByRole('button', { name: 'Save day-by-day and terms' }).click();
    const alert = page.locator('section#narrative').getByRole('alert');
    await expect(alert).toContainText('Customer text contains internal words');
    await expect(alert.getByRole('link', { name: 'Day 1: contains internal words' })).toBeVisible();
    await expect(title).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('section#narrative')).toContainText('Not saved: remove internal words like net rate, margin, cost or supplier.');
    await expect(title).toHaveValue('Arrival, net rate dinner');
  });

  test('ready: one primary action, Mark as shared opens a dialog (the CRM sends nothing, channel kept); a conflict offers the latest version', async ({ page }) => {
    await open(page, 'b12-quote-ready');
    const main = page.locator('main');
    // One primary; the rest is behind "More".
    await expect(main.locator('[data-slot="page-header"]').getByRole('button')).toHaveText(['Mark as shared']);
    await expect(main.locator('[data-slot="page-header"] summary')).toHaveText('More');
    await main.getByRole('button', { name: 'Mark as shared' }).click();
    const dialog = page.getByRole('dialog', { name: /Mark version 3 as shared\?/ });
    await expect(dialog).toContainText('The CRM does not send anything.');
    await dialog.getByLabel('How did you share it?').selectOption('whatsapp');
    await dialog.getByRole('button', { name: 'Mark as shared' }).click();
    await expect(dialog.getByRole('alert').first()).toContainText('Someone changed this quotation after you opened it.');
    await expect(dialog.getByLabel('How did you share it?')).toHaveValue('whatsapp');
    await page.keyboard.press('Escape');
    await expect(main.getByRole('button', { name: 'Mark as shared' })).toBeFocused();
  });

  test('sent: accept needs the written acceptance; decline asks to confirm', async ({ page }) => {
    await open(page, 'b12-quote-sent');
    const main = page.locator('main');
    await expect(main).toContainText('Upload the customer’s written acceptance first; it is the proof for this version.');
    await expect(main.getByRole('button', { name: 'Mark accepted' })).toBeDisabled();
    await expect(main.getByRole('radio', { name: /Quoted option · Deluxe villas/ })).toBeVisible();
    await main.getByLabel('Why did the customer decline?').selectOption('price');
    await main.getByRole('button', { name: 'Mark declined' }).click();
    await expect(main.getByRole('button', { name: 'Yes, mark declined' })).toBeVisible();
    await main.locator('[data-slot="page-header"] summary').click();
    await expect(main.getByRole('button', { name: 'Make a new version from version 2' })).toBeVisible();
  });

  test('a written acceptance that is too large or not a PDF or picture is refused before upload, in words', async ({ page }) => {
    await open(page, 'b12-quote-sent');
    const file = page.locator('#quote-evidence-file');
    await file.setInputFiles({ name: 'big-scan.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(4 * 1024 * 1024 + 1) });
    await expect(page.locator('main')).toContainText('big-scan.pdf is larger than 4 MB.');
    await expect(page.getByRole('button', { name: 'Upload file' })).toBeDisabled();
    await file.setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('x') });
    await expect(page.locator('main')).toContainText('notes.txt is not a PDF, JPG, PNG or WebP file.');
    await file.setInputFiles({ name: 'yes.png', mimeType: 'image/png', buffer: Buffer.from('png') });
    await expect(page.getByRole('button', { name: 'Upload file' })).toBeEnabled();
  });

  test('accepted Lead quotation: the arrived Deal is preselected; starting the booking over a filled draft is refused with a way out', async ({ page }) => {
    await open(page, 'b12-quote-accepted-candidate');
    await expect(page.getByRole('radio', { name: /SYN-JOD-047/ })).toBeChecked();
    await expect(page.getByRole('button', { name: 'Link this Deal' })).toBeEnabled();
    await open(page, 'b12-quote-accepted-ready');
    await page.getByRole('button', { name: 'Start booking from this quotation' }).click();
    const alert = page.locator('main').getByRole('alert');
    await expect(alert).toContainText('This Deal already has a booking draft with details.');
    await expect(alert.getByRole('link', { name: 'Open the booking of this Deal' })).toHaveAttribute('href', '/app/deals/d0000000-0000-4000-8000-000000000047/book');
  });
});

test.describe('B1.2 quotations: read-only states', () => {
  test('status, owner and next step at the top; state pills carry an icon and a word', async ({ page }) => {
    await open(page, 'b12-quote-sent');
    const main = page.locator('main');
    await expect(main).toContainText('Quotation status: Shared with customer');
    await expect(main).toContainText('Owner: Synthetic Sales Jodhpur');
    await expect(main).toContainText('Next: wait for the customer’s written answer (valid until 19 Oct 2026)');
    await pillsHaveIconAndWord(page);
    await expect(main.getByRole('list', { name: 'Versions of this quotation' })).toContainText('Replaced by a newer version · cannot be accepted');
  });

  test('money: unit words, typed total, GST as applicable with no amount, mismatch only as a warning', async ({ page }) => {
    await open(page, 'b12-quote-sent');
    const main = page.locator('main');
    await expect(main).toContainText('1 room × 3 nights × ₹22,000 per room per night = ₹66,000');
    await expect(main).toContainText('1 vehicle × 5 trips × ₹5,700 per trip = ₹28,500');
    await expect(main).toContainText('₹13,500 total for the line');
    await expect(main).toContainText('GST as applicable (no amount)');
    await expect(main).toContainText('Printed as: ₹68,100 per person');
    await expect(main.getByRole('note').filter({ hasText: 'Upgrade option: Your components add up to ₹2,80,800; the quoted total is ₹2,99,000' })).toBeVisible();
    await open(page, 'b12-quote-mismatch');
    await expect(page.locator('main').getByRole('note').filter({ hasText: 'Quoted option: Your components add up to ₹2,04,300; the quoted total is ₹2,05,000 (₹700 higher)' })).toBeVisible();
  });

  test('cost and margin are internal; a reader without money sees no price at all', async ({ page }) => {
    await open(page, 'b12-quote-sent');
    // money-privacy C1 / DA-190: cost and margin sit in the labelled internal zone, apart from customer figures.
    const internal = page.getByRole('group', { name: 'Internal — never printed, not on the customer copy' }).first();
    await expect(internal).toContainText('Our cost (internal)');
    await expect(internal).toContainText('Estimated margin (internal)');
    await expect(page.locator('main')).toContainText('Estimated margin (internal)');
    await open(page, 'b12-quote-no-money');
    await expect(page.locator('main')).toContainText('Prices are shown only to Sales on this lead or deal.');
    await expect(page.locator('main')).not.toContainText('₹');
  });

  test('expired, declined and superseded versions say they cannot be accepted', async ({ page }) => {
    await open(page, 'b12-quote-expired');
    // Copy Q-08: the header Next line is the one next step; the state and reason stay in words.
    await expect(page.locator('main')).toContainText('Next: make a new version if the customer still wants an offer');
    await expect(page.locator('main')).toContainText('8 Oct 2026');
    // Echo-B L4: the state word itself says it cannot be accepted (icon + word, never colour alone).
    await expect(page.locator('main')).toContainText('Quotation status: Expired · cannot be accepted');
    await open(page, 'b12-quote-declined');
    await expect(page.locator('main')).toContainText('Quotation status: Declined');
    await expect(page.locator('main')).toContainText('Next: make a new version if the customer still wants an offer');
    await expect(page.locator('main')).toContainText(/Declined\s*\d{1,2} \w{3} \d{4} · Price/);
  });

  test('Lead quotation accepted: waits for the Bitrix Deal, then the arrived Deal, then Start booking', async ({ page }) => {
    await open(page, 'b12-quote-accepted-waiting');
    await expect(page.locator('main')).toContainText('Waiting for the deal. Convert the lead to a deal in Bitrix; it will appear here to link.');
    await expect(page.locator('main')).toContainText('The CRM does not change Bitrix.');
    await open(page, 'b12-quote-accepted-candidate');
    await expect(page.locator('main')).toContainText('Next: link the deal Bitrix made from this lead');
    await open(page, 'b12-quote-accepted-ready');
    await expect(page.locator('main').getByRole('button', { name: 'Start booking from this quotation' })).toBeEnabled();
    await open(page, 'b12-quote-converted');
    await expect(page.locator('main')).toContainText('Next: continue the booking');
  });

  test('customer preview with a title-only day: staff notes in the status, a placeholder on the page, the check still passes', async ({ page }) => {
    await open(page, 'b12-quote-preview-partial');
    const status = page.locator('main').getByRole('status');
    await expect(status).toContainText('Checked: no internal or pushy words.');
    await expect(status).toContainText('Day plan covers 1 of 7 days. Fine for a summary; the itinerary carries the full plan.');
    await expect(status).toContainText('You can still share it. Fill the missing details first if you can.');
    const doc = page.locator('#quote-document');
    await expect(doc.locator('.fill').filter({ hasText: 'Day plan' })).toHaveCount(1);
    await expect(doc).not.toContainText('Day plan covers');
  });

  test('customer preview without price access: a locked notice, no empty price section', async ({ page }) => {
    await open(page, 'b12-quote-preview-no-money');
    await expect(page.locator('main')).toContainText('The customer copy shows prices, so only Sales on this lead or deal can open it.');
    await expect(page.locator('#quote-document')).toHaveCount(0);
    await expect(page.locator('main')).not.toContainText('Your price');
  });

  test('customer preview with pushy words: the documents safety scan blocks it and names the phrase', async ({ page }) => {
    await open(page, 'b12-quote-preview-blocked');
    await expect(page.locator('main').getByRole('status')).toContainText('Blocked words found: best price');
    await expect(page.locator('#quote-document')).toHaveCount(0);
  });

  test('customer preview: branded, no internal words, GST as applicable, not a tax invoice', async ({ page }) => {
    await open(page, 'b12-quote-preview');
    const doc = page.locator('#quote-document');
    await expect(page.locator('main').getByRole('status')).toContainText('Checked: no internal or pushy words.');
    await expect(page.locator('main').getByRole('status')).toContainText('1 detail missing (shown in [brackets])');
    await expect(doc.locator('.fill')).toHaveCount(1);
    await expect(doc).toContainText('₹68,100 per person');
    await expect(doc).toContainText('total for 3 travellers');
    await expect(doc).toContainText('GST as applicable. Quotation — not a tax invoice.');
    await expect(doc).toContainText('₹2,04,300');
    for (const word of [/cost/i, /margin/i, /supplier/i, /budget/i]) await expect(doc).not.toContainText(word);
    // DEC-50: the customer document carries the company's own statutory line (its GSTIN is expected here);
    // every other commercial word still must not appear.
    await expect(doc).toContainText('PAN AAFCH9191M · GSTIN 08AAFCH9191M1ZV (Rajasthan)');
    for (const word of COMMERCIAL_WORDS.filter((w) => !/Payment plan|GSTIN/i.test(w.source))) await expect(doc).not.toContainText(word);
  });

  test('DEC-50: a Delhi quotation (company GSTIN not approved) warns before sending, never blocks; the preview says Accounts owns it', async ({ page }) => {
    const warning = "This quotation prints a '[GSTIN for Delhi]' mark instead of the company GSTIN, because Accounts has not approved it yet. Ask Accounts before sending it to the customer.";
    await open(page, 'b12-quote-ready-gstin-pending');
    await expect(page.locator('main')).toContainText('Company GSTIN missing on this quotation');
    await expect(page.locator('main')).toContainText(warning);
    await expect(page.locator('main').getByRole('button', { name: 'Mark as shared' })).toBeEnabled();
    await open(page, 'b12-quote-preview-gstin-pending');
    await expect(page.locator('main').getByRole('status')).toContainText(warning);
    // The GSTIN is not counted as a fact to fill in; the fixture's one other missing fact still is.
    await expect(page.locator('main').getByRole('status')).toContainText('1 detail missing (shown in [brackets]): Room type.');
    await expect(page.locator('#quote-document .fill')).toHaveText(['Room type', 'GSTIN for Delhi']);
  });

  test('Lead card: Create quotation; lost Deal says why there is none; unknown quotation is "not available"', async ({ page }) => {
    await open(page, 'b12-quote-lead-card-empty');
    await expect(page.locator('main').getByRole('button', { name: 'Create quotation' })).toBeVisible();
    await expect(page.getByLabel('Quotation title')).toHaveValue('Shah · Bali family trip');
    await open(page, 'b12-quote-deal-card-lost');
    await expect(page.locator('main')).toContainText('This Deal is lost or rejected in Bitrix: no new quotation.');
    await expect(page.locator('main').getByRole('button', { name: 'Create quotation' })).toHaveCount(0);
    await open(page, 'b12-quote-not-available');
    await expect(page.locator('main')).toContainText('This quotation is not available to you. It may not exist, or you may not have access.');
  });
});

const primaries = (page: import('@playwright/test').Page) => page.locator('main').locator('button.bg-brand-strong, a.bg-brand-strong');

test.describe('Batch 2 quotation: one primary per state, focus and guard', () => {
  test('shared: one primary, "Record the customer’s answer", which moves focus to the answer card', async ({ page }) => {
    await open(page, 'b12-quote-sent');
    await expect(primaries(page)).toHaveCount(1);
    await page.locator('main').getByRole('link', { name: 'Record the customer’s answer' }).click();
    await expect(page.locator('#quote-answer-heading')).toBeFocused();
  });

  test('accepted: one primary in each accepted state', async ({ page }) => {
    for (const state of ['b12-quote-accepted-ready', 'b12-quote-accepted-candidate', 'b12-quote-converted']) {
      await open(page, state);
      await expect(primaries(page), state).toHaveCount(1);
    }
  });

  test('Check and mark ready succeeds: the page says so', async ({ page }) => {
    await open(page, 'b2-quote-draft-saving');
    await page.locator('main').getByRole('button', { name: 'Check and mark ready' }).click();
    await expect(page.locator('main').getByRole('status').filter({ hasText: 'Marked ready to share.' })).toBeVisible();
  });

  test('leaving with unsaved changes in a part asks first, even after another part was opened', async ({ page }) => {
    await open(page, 'b2-quote-untouched');
    await page.locator('#q-details-destination').fill('Synthetic Bali');
    await page.locator('section#contact').getByRole('button', { name: /2\. Customer/ }).click();
    let message = '';
    page.once('dialog', async (d) => {
      message = d.message();
      await d.dismiss();
    });
    await page.locator('main').getByRole('link', { name: 'Back to the Lead' }).click();
    await expect.poll(() => message).toBe('You have unsaved changes. Leave this page without saving them?');
    await expect(page).toHaveURL(/b2-quote-untouched/);
    await expect(page.locator('#q-details-destination')).toHaveValue('Synthetic Bali');
  });
});

test.describe('Batch 2 quotation editor (QU-02..QU-05)', () => {
  test('untouched draft: "Not started" in the header and the readiness card, first part open, no red list', async ({ page }) => {
    await open(page, 'b2-quote-untouched');
    const main = page.locator('main');
    await expect(main.locator('[data-slot="page-header"]')).toContainText('Quotation status: Not started');
    await expect(main.locator('[data-slot="page-header"]')).toContainText('Valid for 7 days after the quotation was made');
    await expect(main.getByRole('heading', { name: 'Not started', level: 2, exact: true })).toBeVisible();
    await expect(page.locator('#details-body')).toBeVisible();
    await expect(page.locator('#contact-body')).toBeHidden();
    await expect(main.getByRole('alert')).toHaveCount(0);
    await expect(main).not.toContainText('Add the destination');
    // The validity date stays editable and empty by default (empty = 7 days after sharing).
    await expect(page.locator('#q-details-validUntil')).toHaveValue('');
    await expect(page.locator('#q-details-validUntil')).toHaveAccessibleDescription(/Set to 7 days after the quotation was made/);
    await expect(main.getByRole('navigation', { name: 'Edit or customer copy' }).getByRole('link', { name: 'Customer copy' })).toHaveAttribute('href', /\/app\/quotations\/.+\/preview$/);
  });

  test('unsaved parts are listed first and nothing is sent; a part with unsaved changes never closes', async ({ page }) => {
    await open(page, 'b2-quote-untouched');
    const main = page.locator('main');
    await page.locator('#q-details-destination').fill('Synthetic Bali');
    const toggle = page.locator('section#details').getByRole('button', { name: /1\. Trip/ });
    await toggle.click({ force: true });
    await expect(page.locator('#details-body')).toBeVisible();
    await main.getByRole('button', { name: 'Check and mark ready' }).click();
    const summary = page.locator('#quote-check-summary');
    await expect(summary).toBeFocused();
    await expect(summary.getByRole('listitem').first()).toHaveText('Trip: changes not saved yet');
    // Opening another part keeps the typed value (closed parts stay mounted).
    await page.locator('section#contact').getByRole('button', { name: /2\. Customer/ }).click();
    await expect(page.locator('#q-details-destination')).toHaveValue('Synthetic Bali');
  });

  test('Save prices runs the price forms in order and reports a part-way refusal honestly', async ({ page }) => {
    await open(page, 'b2-quote-prices-refused');
    const money = page.locator('section#money');
    await money.getByRole('button', { name: /5\. Prices/ }).click();
    await page.locator('#q-tier-quoted').fill('Synthetic villas');
    await page.locator('#q-line-1-lineDescription').fill('Synthetic line');
    await page.locator('#q-total-quoted').fill('204000');
    await money.getByRole('button', { name: 'Save prices' }).click();
    const summary = page.locator('#quote-prices-summary');
    await expect(summary).toBeFocused();
    await expect(page.locator('#quote-prices-report')).toHaveText('Saved: Options offered. Not saved: Price lines (reason shown there). Not saved because an earlier part failed: Quoted option total.');
    await expect(page.locator('#q-total-quoted')).toHaveValue('204000');
    await expect(page.locator('#q-line-1-lineDescription')).toHaveValue('Synthetic line');
  });

  test('price lines: the internal cost sits in its own labelled zone, never in the customer zone', async ({ page }) => {
    await open(page, 'b12-quote-draft');
    await page.locator('section#money').getByRole('button', { name: /5\. Prices/ }).click();
    const internal = page.getByRole('group', { name: 'Internal — never printed, not on the customer copy' }).first();
    await expect(internal.getByLabel(/Our cost ₹ \(internal\)/)).toBeVisible();
    await expect(internal.getByLabel(/Remark \(internal\)/)).toBeVisible();
  });

  test('From Bitrix inline (switch on): values filled from Bitrix alone still say "Not started"; marker beside the field', async ({ page }) => {
    await open(page, 'b2-quote-inline');
    const main = page.locator('main');
    await expect(main.locator('[data-slot="page-header"]')).toContainText('Quotation status: Not started');
    await expect(page.locator('#q-details-tripStart')).toHaveValue('2026-11-14');
    await expect(page.locator('#q-details-tripStart')).toHaveAccessibleDescription(/From Bitrix\. Check with the customer\./);
    await expect(main.getByText('Use Bitrix value')).toHaveCount(0);
  });

  test('customer copy page: the same Edit / Customer copy switch, Customer copy current', async ({ page }) => {
    await open(page, 'b12-quote-preview');
    const nav = page.locator('main').getByRole('navigation', { name: 'Edit or customer copy' });
    await expect(nav.getByRole('link', { name: 'Customer copy' })).toHaveAttribute('aria-current', 'page');
    await expect(nav.getByRole('link', { name: 'Edit' })).toHaveAttribute('href', /\/app\/quotations\/[^/]+$/);
  });
});
