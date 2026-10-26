import { expect, test } from '@playwright/test';
import { LOCAL_NETWORK_ACCESS_OFF } from '../helpers/production-style-policy';
import { accessibilitySuite, cspSuite, open } from './b11-helpers';

/**
 * B1.2 Phase F itinerary screens and the Bitrix prefill panel, through the
 * design preview states (synthetic props; stand-in actions with fixed
 * answers). Visual and interaction evidence only; not a real journey.
 */

test.use(LOCAL_NETWORK_ACCESS_OFF);

const STATES = [
  'b12-itin-card',
  'b12-itin-not-checked',
  'b12-itin-open',
  'b12-itin-ready',
  'b12-itin-preview',
  'b12-itin-not-available',
  'b12-book-prefill-travellers',
  'b12-book-prefill-stay',
  'b12-book-prefill-off',
  'b12-quote-draft-prefill',
];

accessibilitySuite('B1.2 itineraries and prefill: accessibility', STATES);
cspSuite('B1.2 itineraries and prefill: production style policy', STATES);

test.describe('B1.2 itineraries', () => {
  test('quotation card: the list and "Make branded itinerary"', async ({ page }) => {
    await open(page, 'b12-itin-card');
    const card = page.getByRole('region', { name: 'Branded itineraries' });
    await expect(card.getByRole('link', { name: 'Bali for the Shah family' })).toHaveAttribute('href', /\/app\/itineraries\//);
    await expect(card).toContainText('Draft');
    await expect(card.getByRole('button', { name: 'Make branded itinerary' })).toBeVisible();
  });

  test('not checked yet: one primary action; copied facts are marked until changed; unsaved facts hold the check', async ({ page }) => {
    await open(page, 'b12-itin-not-checked');
    const main = page.locator('main');
    await expect(main).toContainText('Itinerary status: Draft');
    await expect(main.getByText('Differences not checked yet')).toBeVisible();
    const check = main.getByRole('button', { name: 'Check differences' });
    await expect(check).toBeEnabled();
    await expect(main.getByRole('button', { name: /Check differences/ })).toHaveCount(1);
    const destination = page.locator('#itin-destination');
    const hint = page.locator('section#facts').getByText('From the quotation — check it.').first();
    await expect(hint).toBeVisible();
    await expect(page.locator('#itin-destination-hint')).toContainText('From the quotation — check it.');
    await destination.fill('Ubud, Bali');
    await expect(page.locator('#itin-destination-hint')).toHaveCount(0);
    await expect(check).toBeDisabled();
    await expect(main).toContainText('Save the facts first.');
  });

  test('document wording: cover word, introduction and points are customer text with their limits', async ({ page }) => {
    await open(page, 'b12-itin-not-checked');
    const wording = page.getByRole('group', { name: 'Document wording' });
    await expect(wording.getByLabel('Cover word')).toHaveValue('Bali');
    await expect(wording.getByLabel('Introduction')).toHaveValue('A calm family week between the rice fields and the sea.');
    await expect(wording.getByLabel('Why this trip')).toHaveValue('Short drives between stays\nOne free day in each place');
    await expect(page.locator('section#facts input[type="hidden"][name="reason"]')).toHaveCount(2);
  });

  test('facts refused for internal words keep the typed text and name the field', async ({ page }) => {
    await open(page, 'b12-itin-not-checked');
    const title = page.locator('#itin-dayTitle-1');
    await title.fill('Arrival, net rate dinner');
    await page.getByRole('button', { name: 'Save facts' }).click();
    const alert = page.locator('section#facts').getByRole('alert');
    await expect(alert).toContainText('Customer text contains internal words');
    await expect(alert.getByRole('link', { name: 'Day 1: contains internal words' })).toBeVisible();
    await expect(title).toHaveAttribute('aria-invalid', 'true');
    await expect(title).toHaveValue('Arrival, net rate dinner');
  });

  test('a source file that is too large or not a document is refused before upload, in words', async ({ page }) => {
    await open(page, 'b12-itin-not-checked');
    const file = page.locator('#itin-source-file');
    await file.setInputFiles({ name: 'huge.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(4 * 1024 * 1024 + 1) });
    await expect(page.locator('section#sources')).toContainText('huge.pdf is larger than 4 MB.');
    await expect(page.getByRole('button', { name: 'Attach file' })).toBeDisabled();
    await file.setInputFiles({ name: 'old.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from('docx') });
    await expect(page.getByRole('button', { name: 'Attach file' })).toBeEnabled();
  });

  test('open differences: each says where and how; use the quotation value, keep it, or keep it with a note', async ({ page }) => {
    await open(page, 'b12-itin-open');
    const list = page.getByRole('list', { name: 'Open differences' });
    await expect(list.getByRole('listitem')).toHaveCount(2);
    await expect(list).toContainText('Stay 2 · hotel');
    await expect(list).toContainText('Different from the quotation or booking');
    await expect(list).toContainText('In the quotation or booking, not in the itinerary');
    const first = list.getByRole('listitem').first();
    await expect(first.locator('input[name="differenceKind"]')).toHaveValue('different');
    await expect(first.locator('input[name="path"]')).toHaveValue('stays[1].hotelName');
    await first.getByRole('button', { name: 'Use the quotation value' }).click();
    await expect(first.getByRole('alert')).toContainText('can’t be copied automatically');
    await expect(first.getByRole('link', { name: 'Change it by hand in the facts' })).toHaveAttribute('href', '#facts');
    await first.getByRole('button', { name: 'Keep it and add a note' }).click();
    await expect(first.getByRole('button', { name: 'Keep it with this note' })).toBeDisabled();
    await first.getByLabel(/Why the itinerary differs/).fill('Customer chose this hotel.');
    await expect(first.getByRole('button', { name: 'Keep it with this note' })).toBeEnabled();
    await page.getByText('Settled differences (1)').click();
    await expect(page.locator('section#differences')).toContainText('Customer asked for a van.');
  });

  test('ready: the final document is the primary action; job wording follows the job state, never a claim about the switch', async ({ page }) => {
    await open(page, 'b12-itin-ready');
    const main = page.locator('main');
    await expect(main.getByText('Matches the quotation')).toBeVisible();
    await expect(page.getByRole('list', { name: 'Document requests' })).toContainText('Waiting for the PDF maker. Nothing is sent to the customer.');
    await expect(main).not.toContainText('not switched on');
    await expect(page.locator('section#documents')).toContainText('Shows customer prices. Never our cost.');
    await main.getByRole('button', { name: 'Make final PDF' }).click();
    await expect(main.getByRole('status').filter({ hasText: 'Requested. You can download it here when it is ready.' }).first()).toBeVisible();
  });

  test('customer preview: branded itinerary from the customer view, safety-checked, selling prices only (DEC-48)', async ({ page }) => {
    await open(page, 'b12-itin-preview');
    const doc = page.locator('#itinerary-document');
    await expect(page.locator('main').getByRole('status')).toContainText('Checked: no internal or pushy words.');
    await expect(doc).toContainText('Ubud and Seminyak, Bali');
    await expect(doc).toContainText('Day 7');
    await expect(doc).toContainText('Snorkelling trip with lunch on the boat.');
    const price = doc.getByRole('region', { name: 'Your price' });
    await expect(price).toContainText('₹2,04,300');
    await expect(price).toContainText('₹68,100 per person');
    await expect(price).toContainText('GST as applicable.');
    for (const word of [/cost/i, /margin/i, /supplier/i, /bitrix/i, /budget/i]) await expect(doc).not.toContainText(word);
  });

  test('print page layout: the document only, no environment banner, skip link or staff shell', async ({ page }) => {
    await open(page, 'b12-itin-print');
    await expect(page.locator('#print-document')).toBeVisible();
    await expect(page.locator('body > .env-banner')).toBeHidden();
    await expect(page.locator('body > .skip-link')).toBeHidden();
    await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
  });

  test('not available: the same words for missing and not yours', async ({ page }) => {
    await open(page, 'b12-itin-not-available');
    await expect(page.locator('main')).toContainText('This itinerary is not available to you.');
  });
});

test.describe('B1.2 Bitrix prefill', () => {
  test('Book now step 1: what Bitrix holds, one click to use it, and the field says "From Bitrix — check it"', async ({ page }) => {
    await open(page, 'b12-book-prefill-travellers');
    const panel = page.getByRole('region', { name: 'From Bitrix' });
    await expect(panel).toContainText('Quiet villa in Ubud, beach in Seminyak.');
    await expect(panel).toContainText('Booking Notes from Bitrix, for reference. They are not copied into the booking.');
    // DEC-45: Customer Type means a business booking; still one click, then checked.
    await expect(panel).toContainText('Bitrix has a Customer Type for this customer, so "Booking for" can be filled as a business.');
    await expect(panel).toContainText('A business (GST), from Customer Type B2D');
    await expect(panel.getByRole('button', { name: 'Use Bitrix value for Booking for' })).toBeVisible();
    await expect(panel).toContainText('A contact filled from Bitrix stays unconfirmed');
    await expect(panel.getByText('From Bitrix — check')).toBeVisible();
    await expect(page.locator('#customer-contact-name-hint')).toContainText('From Bitrix. Check with the customer.');
    await expect(panel.getByRole('button', { name: 'Mark checked for Contact name' })).toBeVisible();
    await panel.getByRole('button', { name: 'Use Bitrix value for Contact mobile' }).click();
    await expect(panel.getByRole('status').filter({ hasText: 'Filled from Bitrix: Contact mobile' })).toBeVisible();
  });

  test('Book now step 2: hidden Booking Notes say so; checked and changed states are words', async ({ page }) => {
    await open(page, 'b12-book-prefill-stay');
    const panel = page.getByRole('region', { name: 'From Bitrix' });
    await expect(panel).toContainText('Trip start date');
    await expect(panel).toContainText('From Bitrix, checked');
    await expect(panel).toContainText('Changed by staff after filling from Bitrix');
    await expect(panel.getByRole('button', { name: /Use Bitrix value/ })).toHaveCount(0);
  });

  test('switched off or not read yet: an honest notice, nothing to click', async ({ page }) => {
    await open(page, 'b12-book-prefill-off');
    const panel = page.getByRole('region', { name: 'From Bitrix' });
    await expect(panel).toContainText('Bitrix values are not available for this Deal yet. Type the details instead.');
    await expect(panel.getByRole('button')).toHaveCount(0);
  });

  test('quotation editor: notes hidden without price access, unchecked values are a warning that never blocks', async ({ page }) => {
    await open(page, 'b12-quote-draft-prefill');
    const panel = page.getByRole('region', { name: 'From Bitrix' });
    await expect(panel).toContainText('Booking Notes from Bitrix are shown only to staff who can see the price.');
    await expect(panel).not.toContainText('No Booking Notes in Bitrix.');
    await expect(page.locator('main')).toContainText('2 details came from Bitrix. Check them with the customer.');
    await expect(page.locator('#q-contact-contactName-hint')).toContainText('From Bitrix. Check with the customer.');
    await expect(panel.getByRole('button', { name: 'Mark all checked' })).toBeVisible();
    // DEC-45: the quotation contact has its own "Booking for", carried into the booking.
    const bookingFor = page.locator('#q-contact-bookingFor');
    await expect(bookingFor).toHaveValue('individual');
    await expect(page.locator('#q-contact-bookingFor-hint')).toContainText('Carried into the booking when it starts from this quotation.');
  });
});
