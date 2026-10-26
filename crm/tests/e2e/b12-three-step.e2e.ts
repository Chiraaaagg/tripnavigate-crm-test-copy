import { expect, test } from '@playwright/test';
import { LOCAL_NETWORK_ACCESS_OFF } from '../helpers/production-style-policy';
import { accessibilitySuite, COMMERCIAL_WORDS, cspSuite, open } from './b11-helpers';

/**
 * B1.2 three-step Book now (freeze note §2.1–2.2) through the design preview
 * states (synthetic props; stand-in actions that read and write nothing) plus
 * the legacy six-step redirects on the real route. Visual and interaction
 * evidence only; the real journey is b11-journey.real.e2e.ts on a local real
 * stack (it also checks the in-app legacy link with its #section).
 */

test.use(LOCAL_NETWORK_ACCESS_OFF);

const STATES = [
  'b12-book-id-proof',
  'b12-book-id-proof-failed',
  'b12-book-id-proof-limit',
  'b12-book-id-proof-rejected',
  'b12-book-id-proof-paused',
  'b12-book-id-proof-locked',
  'b12-book-id-proof-hidden',
  'b12-task-id-proofs',
  'b12-task-id-proofs-refused',
];

accessibilitySuite('B1.2 three steps: accessibility', STATES);
cspSuite('B1.2 three steps: production style policy', STATES);

// The legacy six-step redirects (/book/customer → /book/travellers#customer, …) run before the
// session check but behind the sign-in proxy, so they are checked on the real stack:
// b11-journey.real.e2e.ts (full load and an in-app link, with the #section kept).

// Retired 22 October 2026 (Echo review B-L8): the "steps and sections" and "section saves" cases tested
// the B1.2 step screens, which no route renders any more. The booking form's own steps, saves,
// refusals and links are covered by bookform.e2e.ts (gallery) and bookform-journey.real.e2e.ts.
// The identity-proof slot below is still the same component (now inside the passenger Details drawer).

test.describe('B1.2 traveller identity proof', () => {
  test('each traveller row has its own slot: required for adults (blocks), optional for children, no ID number field', async ({ page }) => {
    await open(page, 'b12-book-id-proof');
    const main = page.locator('main');
    await expect(main.getByRole('group', { name: /ID proof \(Aadhaar card or another ID\) · Sample Traveller A/ })).toBeVisible();
    await expect(main).toContainText('ID proof needed for Sample Traveller B');
    await expect(main).toContainText('No ID proof attached for Sample Child C (optional for a child).');
    await expect(main.getByLabel(/Aadhaar number|ID number/i)).toHaveCount(0);
    await expect(main.getByRole('link', { name: /Open sample-id-front-1\.jpg/ })).toHaveAttribute('href', '/preview/b12-book-id-proof');
    await expect(main.getByLabel('Full name').first()).toHaveAccessibleDescription(/Changing the name removes this traveller’s attached ID proof/);
  });

  test('attaching without the consent tick is refused in words, nothing is sent, and the tick gets focus', async ({ page }) => {
    await open(page, 'b12-book-id-proof');
    const slot = page.getByRole('form', { name: 'Attach ID proof for Sample Traveller B' });
    await slot.getByLabel('ID proof file').setInputFiles({ name: 'synthetic-id.jpg', mimeType: 'image/jpeg', buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0]) });
    await expect(page.locator('main')).toContainText('ID proof of Sample Traveller B (chosen, not attached)');
    await slot.getByRole('button', { name: 'Attach ID proof for Sample Traveller B' }).click();
    await expect(slot.locator('[data-slot="error-summary"]')).toContainText('Tick the customer’s agreement first. Nothing was uploaded.');
    await expect(slot.getByLabel('Customer agreed to share this ID for this booking')).toBeFocused();
    await slot.getByLabel('Customer agreed to share this ID for this booking').check();
    await slot.getByRole('button', { name: 'Attach ID proof for Sample Traveller B' }).click();
    await expect(slot.getByRole('status')).toContainText('Identity proof attached.');
  });

  test('a refused file says why; failed files are listed; the limit hides Attach', async ({ page }) => {
    await open(page, 'b12-book-id-proof-rejected');
    const slot = page.getByRole('form', { name: 'Attach ID proof for Sample Traveller B' });
    await slot.getByLabel('ID proof file').setInputFiles({ name: 'synthetic-id.jpg', mimeType: 'image/jpeg', buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0]) });
    await slot.getByLabel('Customer agreed to share this ID for this booking').check();
    await slot.getByRole('button', { name: /Attach ID proof/ }).click();
    await expect(slot.locator('[data-slot="error-summary"]')).toContainText('File not accepted: PDF, JPG, PNG or WebP up to 4 MB.', { timeout: 20_000 });
    // A file refusal never marks the consent tick as wrong.
    await expect(slot.getByLabel('Customer agreed to share this ID for this booking')).not.toHaveAttribute('aria-invalid', 'true');
    await open(page, 'b12-book-id-proof-failed');
    await expect(page.locator('main')).toContainText('Upload failed: remove it and upload again');
    await open(page, 'b12-book-id-proof-limit');
    await expect(page.locator('main')).toContainText('This traveller already has 4 identity-proof files. Remove one first.');
    await expect(page.getByRole('form', { name: 'Attach ID proof for Sample Traveller A' })).toHaveCount(0);
  });

  test('paused, locked and not-for-you states: no Attach, honest words, no slot at all when proofs are not sent', async ({ page }) => {
    await open(page, 'b12-book-id-proof-paused');
    await expect(page.locator('main')).toContainText('Attaching is paused for this booking. A wrong file can still be removed.');
    await expect(page.locator('main').getByRole('button', { name: /Remove sample-id-front-1\.jpg/ })).toBeVisible();
    await open(page, 'b12-book-id-proof-locked');
    await expect(page.locator('main').getByRole('button', { name: /^Remove sample-id/ })).toHaveCount(0);
    await open(page, 'b12-book-id-proof-hidden');
    await expect(page.locator('main').getByRole('group', { name: /ID proof \(Aadhaar/ })).toHaveCount(0);
  });

  test('submitted booking: ID proofs stay attachable and never say "before you can submit"', async ({ page }) => {
    await open(page, 'b11-submitted-sales');
    const card = page.getByRole('region', { name: 'Traveller ID proofs' });
    await expect(card).toContainText('ID proof needed for Sample Traveller B');
    await expect(card).not.toContainText('before you can submit');
    await expect(card.getByRole('form', { name: 'Attach ID proof for Sample Traveller B' })).toBeVisible();
  });

  test('task screen list: Traveller ID proofs with Open links, never money; a refused session is said, not "none"', async ({ page }) => {
    await open(page, 'b12-task-id-proofs');
    const card = page.getByRole('region', { name: 'Traveller ID proofs' });
    await expect(card.getByRole('link', { name: /Open/ })).toHaveCount(2);
    await expect(card).toContainText('No ID proof attached yet. Ask the salesperson.');
    for (const word of COMMERCIAL_WORDS) await expect(card).not.toContainText(word);
    await open(page, 'b12-task-id-proofs-refused');
    await expect(page.getByRole('region', { name: 'Traveller ID proofs' })).toContainText('Sign in again or reload the page');
  });
});
