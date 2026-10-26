import { expect, test, type Page } from '@playwright/test';
import { LOCAL_NETWORK_ACCESS_OFF } from '../helpers/production-style-policy';
import { accessibilitySuite, cspSuite, noHorizontalScroll, open, pillsHaveIconAndWord } from './b11-helpers';

/**
 * Voice-note batch (24 October 2026) through the design-preview states:
 * synthetic view models and stand-in actions that read and write nothing.
 * Visual and interaction evidence only; saving, reloading and permissions on
 * a disposable stack are the real journeys (*.real.e2e.ts).
 */

test.use(LOCAL_NETWORK_ACCESS_OFF);

const FORM_STATES = ['vn-deal', 'vn-gaps', 'vn-nodeal', 'vn-billto', 'vn-billto-picked', 'vn-billto-pickfail', 'vn-billto-searchfail'].flatMap((s) => ['travellers', 'stay', 'finish'].map((step) => `bookform-${s}--${step}`));
const OTHER_STATES = [
  'vn-customers',
  'vn-customers-returned',
  'vn-customers-checked',
  'vn-customers-error',
  'vn-customer-check',
  'vn-customer-check-returned',
  'vn-customer-check-blocked',
  'vn-import-hotel',
  'vn-import-hotel-summary',
  'vn-import-customer',
  'vn-import-customer-choose',
  'vn-destinations',
  'vn-destinations-view',
  'vn-destinations-error',
  'vn-trip-details-off',
  'vn-trip-details-on',
  'vn-trip-details-unknown',
  'vn-trip-details-review',
  'vn-trip-details-viewer',
];

accessibilitySuite('Voice-note batch: accessibility', [
  'bookform-vn-deal--travellers',
  'bookform-vn-gaps--travellers',
  'bookform-vn-nodeal--travellers',
  'bookform-vn-deal--stay',
  'bookform-vn-billto--finish',
  'bookform-vn-billto-picked--finish',
  ...OTHER_STATES,
]);
cspSuite('Voice-note batch: production style policy', [...FORM_STATES, ...OTHER_STATES]);

const main = (page: Page) => page.locator('main');

async function settled(page: Page) {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity));
}

test.describe('Customer & trip from the Bitrix Deal (items 1 and 2)', () => {
  test('Deal facts are one read-only line; no trip inputs; Correct explains Bitrix', async ({ page }) => {
    await open(page, 'bookform-vn-deal--travellers');
    const card = main(page).locator('section#customer');
    const line = card.locator('[data-slot="deal-facts"]');
    await expect(line).toContainText('Himachal');
    await expect(line).toContainText('4 travellers (2 adults, 1 child, 1 infant)');
    await expect(line).toContainText('Domestic');
    await expect(line).toContainText('From the Bitrix Deal');
    for (const label of ['Destination', 'Travel date', 'Return date', 'Trip', 'Adults', 'Children', 'Infants']) await expect(card.getByLabel(label, { exact: true })).toHaveCount(0);
    await card.getByRole('button', { name: 'Correct' }).click();
    const dialog = page.getByRole('dialog', { name: 'Correct trip details in Bitrix' });
    await expect(dialog).toContainText('These come from the Bitrix Deal');
    await dialog.getByRole('button', { name: 'OK' }).click();
    await expect(dialog).toBeHidden();
    await expect(card.getByRole('button', { name: 'Correct' })).toBeFocused();
  });

  test('only missing values are asked; an unclassified destination asks Domestic or International', async ({ page }) => {
    await open(page, 'bookform-vn-gaps--travellers');
    const card = main(page).locator('section#customer');
    await expect(card.getByLabel('Destination', { exact: true })).toHaveCount(0);
    await expect(card.getByLabel('Travel date', { exact: true })).toHaveCount(0);
    await expect(card.getByLabel('Trip', { exact: true })).toBeVisible();
    await expect(card).toContainText('This Bitrix destination is not classified yet.');
    await expect(card.locator('#bf-pax-total')).toContainText('Total: 4 (from the Deal)');
  });

  test('a split that does not add up is refused in words and the typed counts stay', async ({ page }) => {
    await open(page, 'bookform-vn-gaps--travellers');
    const card = main(page).locator('section#customer');
    await card.getByRole('button', { name: 'One adult more' }).click();
    const alert = card.locator('#bf-counts-error');
    await expect(alert).toContainText('add up to 5, but the trip has 4 passengers');
    await expect(card.getByLabel('Adults', { exact: true })).toHaveAttribute('aria-invalid', 'true');
    await card.getByRole('button', { name: 'Save customer details' }).click();
    await expect(card.getByLabel('Adults', { exact: true })).toHaveValue('4');
    await expect(alert).toBeVisible();
    // The step's save reports the part as not sent; nothing moves on.
    await page.getByRole('button', { name: 'Save and go to step 2' }).click();
    await expect(page).toHaveURL(/vn-gaps--travellers$/);
    await expect(page.locator('#bf-report')).toBeVisible();
    await card.getByRole('button', { name: 'One adult fewer' }).click();
    await expect(alert).toHaveCount(0);
  });

  test('gate finding: a contact-only save goes through when no count or total is entered and the Deal has no total', async ({ page }) => {
    await open(page, 'bookform-vn-nodeal--travellers');
    const card = main(page).locator('section#customer');
    await card.getByLabel('Name', { exact: true }).fill('Sample Contact Only');
    await card.getByLabel('Phone', { exact: true }).fill('9876500031');
    await card.getByRole('button', { name: 'Save customer details' }).click();
    await expect(card.getByRole('button', { name: 'Save customer details' })).toHaveCount(0);
    await expect(card.locator('#bf-counts-error')).toHaveCount(0);
    await expect(card).not.toContainText('Enter the total number of passengers first.');
    await expect(card.getByLabel('Adults', { exact: true })).not.toHaveAttribute('aria-invalid', 'true');
  });

  test('without Deal facts every trip value is asked once (switch off)', async ({ page }) => {
    await open(page, 'bookform-vn-nodeal--travellers');
    const card = main(page).locator('section#customer');
    for (const label of ['Destination', 'Travel date', 'Return date', 'Trip', 'Adults', 'Children', 'Infants']) await expect(card.getByLabel(label, { exact: true })).toBeVisible();
    await expect(card.locator('[data-slot="deal-facts"]')).toHaveCount(0);
  });
});

test.describe('Passenger slots and details (items 2 and 3)', () => {
  test('rows appear per type from the counts; no "Add passenger"; lowering a count keeps named passengers', async ({ page }) => {
    await open(page, 'bookform-vn-gaps--travellers');
    const pax = main(page).locator('section#passengers');
    await expect(pax.getByRole('button', { name: 'Add passenger' })).toHaveCount(0);
    // 3 adults (2 named + 1 empty slot), 1 child; the named infant is over the count of 0.
    await expect(pax.getByRole('textbox', { name: /name \(adult\)/ })).toHaveCount(3);
    await expect(pax).toContainText('1 infant named, but the booking has 0.');
    await expect(pax).toContainText('Nobody is removed unless you choose.');
    const counts = main(page).locator('section#customer');
    // One step at a time, each awaited: a click sent before the page has hydrated is
    // replayed with older values, which once hid that the infant already lowers the adults.
    await counts.getByRole('button', { name: 'One infant more' }).click();
    await expect(pax).not.toContainText('infant named');
    // Total 4 from the Deal, 1 child, 1 infant: adults work out to 2. The empty slot goes, both named adults stay.
    await expect(counts.locator('#bf-adults')).toHaveAttribute('placeholder', '2');
    await expect(pax.getByRole('textbox', { name: /name \(adult\)/ })).toHaveCount(2);
    await counts.getByRole('button', { name: 'One adult fewer' }).click();
    await expect(counts.locator('#bf-adults')).toHaveValue('1');
    await expect(pax.getByRole('textbox', { name: /name \(adult\)/ })).toHaveCount(2);
    await expect(pax).toContainText('2 adults named, but the booking has 1.');
    await expect(pax.getByLabel('Passenger 1 name (adult)')).toHaveValue('Sample Traveller A');
    await expect(pax.getByLabel('Passenger 2 name (adult)')).toHaveValue('Sample Traveller B');
  });

  test('typing into an empty slot keeps focus and the text; the row joins the unsaved passengers', async ({ page }) => {
    await open(page, 'bookform-vn-gaps--travellers');
    const slot = main(page).getByLabel('Passenger 3 name (adult)');
    await slot.fill('');
    await slot.pressSequentially('Sample New Adult');
    await expect(slot).toBeFocused();
    await expect(slot).toHaveValue('Sample New Adult');
    await expect(main(page)).toContainText('Unsaved changes in: Passengers');
  });

  test('"Attach ID proof" is on every row and opens the private upload with the consent tick', async ({ page }) => {
    await open(page, 'bookform-vn-deal--travellers');
    await main(page).getByRole('button', { name: 'Attach ID proof for Sample Traveller A' }).click();
    const dialog = page.getByRole('dialog', { name: /ID proof · Sample Traveller A/ });
    await expect(dialog.getByLabel('ID proof file')).toBeVisible();
    await expect(dialog.getByRole('checkbox', { name: /Customer agreed/ })).not.toBeChecked();
    await dialog.getByRole('button', { name: 'Attach ID proof for Sample Traveller A' }).click();
    await expect(dialog.getByRole('alert')).toBeVisible();
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(main(page).getByRole('button', { name: 'Attach ID proof for Sample Traveller A' })).toBeFocused();
  });

  test('an empty slot asks for the name before attaching', async ({ page }) => {
    await open(page, 'bookform-vn-gaps--travellers');
    await main(page).getByRole('button', { name: 'Attach ID proof for passenger 3' }).click();
    await expect(main(page).locator('#passengers-3-name-error')).toContainText('Enter the name first');
    await expect(main(page).getByLabel('Passenger 3 name (adult)')).toBeFocused();
  });

  test('details: standard requests list plus free text, optional dates, other phones', async ({ page }) => {
    await open(page, 'bookform-vn-deal--travellers');
    await main(page).getByRole('button', { name: 'Details for passenger 1' }).click();
    const drawer = page.getByRole('dialog', { name: 'Passenger details' });
    await settled(page);
    await drawer.getByRole('button', { name: /Choose requests/ }).click();
    await drawer.getByRole('checkbox', { name: 'Jain meals' }).check();
    await drawer.getByRole('checkbox', { name: 'Wheelchair help' }).check();
    await page.keyboard.press('Escape');
    // Escape closed only the list, not the drawer.
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole('button', { name: 'Remove Jain meals' })).toBeVisible();
    await expect(drawer.getByLabel('Other requirements')).toBeVisible();
    await expect(drawer.getByText('Date of birth')).toBeVisible();
    await expect(drawer.getByText('(optional)').first()).toBeVisible();
    await drawer.getByRole('button', { name: 'Add another phone' }).click();
    await expect(drawer.getByLabel(/Other phone/)).toBeVisible();
  });
});

test.describe('Hotel, car and flight editors (items 4, 6, 7, 8)', () => {
  test('hotel: no "More details", adults read-only, child ages only with children, stored hotel search', async ({ page }) => {
    await open(page, 'bookform-vn-deal--stay');
    await main(page).getByRole('button', { name: 'Add stay' }).click();
    const drawer = page.getByRole('dialog', { name: 'Add hotel stay' });
    await settled(page);
    await expect(drawer.getByText('More details')).toHaveCount(0);
    await expect(drawer.getByRole('spinbutton', { name: 'Adults' })).toHaveCount(0);
    await expect(drawer.locator('#svc-adults')).toContainText('2');
    await expect(drawer.locator('#svc-adults')).toContainText('(from the booking)');
    await expect(drawer.getByLabel('Child ages')).toHaveCount(0);
    await drawer.getByLabel('Children in this stay').fill('1');
    await expect(drawer.getByLabel('Child ages')).toBeVisible();
    for (const label of ['Room category', 'Meal plan', 'Inclusions', 'Exclusions', 'Special request', 'Customer asked for']) await expect(drawer.getByLabel(label, { exact: false }).first()).toBeVisible();
    const hotel = drawer.getByRole('combobox', { name: 'Hotel' });
    await hotel.fill('Sample P');
    const list = drawer.getByRole('listbox', { name: 'Matches' });
    await expect(list.getByRole('option')).toHaveCount(3);
    await hotel.press('ArrowDown');
    await hotel.press('ArrowDown');
    await expect(hotel).toHaveAttribute('aria-activedescendant', /o1$/);
    await hotel.press('Enter');
    await expect(hotel).toHaveValue('Sample Palm Residency');
    await expect(drawer.getByLabel('City')).toHaveValue('Jodhpur');
  });

  test('car: vehicle list with an arrow and "Other"; quantity with visible − and +', async ({ page }) => {
    await open(page, 'bookform-vn-deal--stay');
    await main(page).getByRole('button', { name: 'Add car' }).click();
    const drawer = page.getByRole('dialog', { name: 'Add car' });
    await settled(page);
    const vehicle = drawer.getByLabel('Vehicle', { exact: true });
    await expect(vehicle.locator('xpath=following-sibling::*[local-name()="svg"]')).toHaveCount(1);
    await vehicle.selectOption('other');
    const other = drawer.getByLabel('Other vehicle');
    await expect(other).toBeFocused();
    await expect(other).toHaveAttribute('maxlength', '60');
    const qty = drawer.getByLabel('Number of vehicles');
    await expect(qty).toHaveValue('1');
    await expect(drawer.getByRole('button', { name: 'One vehicle fewer' })).toBeDisabled();
    await drawer.getByRole('button', { name: 'One vehicle more' }).click();
    await drawer.getByRole('button', { name: 'One vehicle more' }).click();
    await expect(qty).toHaveValue('3');
    await qty.press('ArrowDown');
    await expect(qty).toHaveValue('2');
    // Save without typing the other vehicle: refused here, typed values kept.
    await drawer.getByRole('button', { name: 'Save car' }).click();
    await expect(drawer.getByRole('alert')).toContainText('Type the vehicle');
    await expect(qty).toHaveValue('2');
  });

  test('flight: passengers chosen in a searchable list in the main area; count follows; attach beside it', async ({ page }) => {
    await open(page, 'bookform-vn-deal--stay');
    await main(page).getByRole('button', { name: /Edit flight/ }).click();
    const drawer = page.getByRole('dialog', { name: 'Edit flight' });
    await settled(page);
    await expect(drawer.getByText('4 of 4 passengers fly.')).toBeVisible();
    await drawer.getByRole('button', { name: 'Remove Sample Infant D' }).click();
    await expect(drawer.getByText('3 of 4 passengers fly.')).toBeVisible();
    await expect(drawer.locator('input[name="participantSeq"]')).toHaveCount(3);
    await expect(drawer.locator('input[name="passengers"]')).toHaveValue('3');
    await expect(drawer.getByRole('button', { name: 'Attach ticket screenshot' })).toBeVisible();
    await expect(drawer).toContainText('A screenshot is not an issued ticket.');
  });

  test('new flight: "Save and attach screenshot"; nobody chosen is refused in words', async ({ page }) => {
    await open(page, 'bookform-vn-deal--stay');
    await main(page).getByRole('button', { name: 'Add flight' }).click();
    const drawer = page.getByRole('dialog', { name: 'Add flight' });
    await settled(page);
    await drawer.getByLabel('From', { exact: true }).fill('Delhi');
    await drawer.getByLabel('To', { exact: true }).fill('Jodhpur');
    await drawer.getByRole('button', { name: 'Save and attach screenshot' }).click();
    await expect(drawer.getByRole('alert')).toContainText('Choose the passengers who fly.');
    await expect(drawer.getByLabel('From', { exact: true })).toHaveValue('Delhi');
  });
});

test.describe('Bill To: search first, Add customer (item 9)', () => {
  test('search the stored customers with the keyboard; picking fills a summary with "Edit details"', async ({ page }) => {
    await open(page, 'bookform-vn-billto--finish');
    const bill = main(page).locator('section#billTo');
    await expect(bill.getByLabel('Full name')).toBeHidden();
    const search = bill.getByRole('combobox', { name: 'Find customer' });
    await search.fill('Sample Tr');
    await expect(bill.getByRole('listbox', { name: 'Matches' }).getByRole('option')).toHaveCount(1);
    await search.press('ArrowDown');
    await search.press('Enter');
    const summary = bill.locator('[data-slot="bill-to-summary"]');
    await expect(summary).toContainText('Sample Travels Pvt Ltd');
    await expect(summary).toContainText('Not checked');
    await expect(bill.locator('input[name="partyId"]')).toHaveValue('p0000000-0000-4000-8000-000000000002');
    await bill.getByRole('button', { name: 'Edit details' }).click();
    await expect(bill.getByLabel('Company name')).toHaveValue('Sample Travels Pvt Ltd');
    await expect(bill.getByLabel('GSTIN')).toHaveValue('08ABCDE1234F1Z5');
  });

  test('when the stored details cannot be read, Bill To stays as it was and says so', async ({ page }) => {
    await open(page, 'bookform-vn-billto-pickfail--finish');
    const bill = main(page).locator('section#billTo');
    const search = bill.getByRole('combobox', { name: 'Change customer' });
    await search.fill('Sample Cu');
    await expect(bill.getByRole('listbox', { name: 'Matches' }).getByRole('option')).toHaveCount(1);
    await search.press('ArrowDown');
    await search.press('Enter');
    await expect(bill.getByRole('alert')).toContainText('The Bill To details were not changed.');
    await expect(bill.locator('[data-slot="bill-to-summary"]')).toContainText('Sample Travels Pvt Ltd');
    await expect(bill.locator('[data-slot="bill-to-summary"]')).not.toContainText('Sample Customer Mehra');
    await expect(bill.locator('input[name="partyId"]')).toHaveValue('');
  });

  test('Add customer: Personal and Business; business needs GST status; saved customer fills Bill To', async ({ page }) => {
    await open(page, 'bookform-vn-billto--finish');
    const bill = main(page).locator('section#billTo');
    await bill.getByRole('button', { name: 'Add customer' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add customer' });
    await settled(page);
    await expect(dialog.getByLabel('ID proof')).toBeVisible();
    await dialog.getByRole('button', { name: 'Business' }).click();
    await expect(dialog.getByLabel('ID proof')).toHaveCount(0);
    await expect(dialog.getByLabel('Documents')).toBeVisible();
    await dialog.getByLabel('Company name').fill('Sample New Co');
    await dialog.getByLabel('Contact name').fill('Sample Person');
    await dialog.getByLabel('Phone').fill('9876500055');
    await dialog.getByLabel('Address', { exact: true }).fill('5 Sample Street');
    await dialog.getByLabel('City').fill('Delhi');
    await dialog.getByLabel('State').selectOption('07');
    await dialog.getByLabel('PIN code').fill('110001');
    await dialog.getByRole('button', { name: 'Save customer' }).click();
    await expect(dialog.getByLabel('GST registration')).toBeFocused();
    await expect(dialog.getByLabel('Company name')).toHaveValue('Sample New Co');
    await dialog.getByLabel('GST registration').selectOption('unregistered');
    await dialog.getByLabel('Reason for no GSTIN').fill('Below the threshold for now');
    await dialog.getByRole('button', { name: 'Save customer' }).click();
    await expect(dialog).toBeHidden();
    await expect(bill.locator('[data-slot="bill-to-summary"]')).toContainText('Sample New Co');
    await expect(bill).toContainText('added to the customer list (Not checked)');
  });

  test('a personal ID file without the consent tick is refused before anything is sent', async ({ page }) => {
    await open(page, 'bookform-vn-billto--finish');
    await main(page).locator('section#billTo').getByRole('button', { name: 'Add customer' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add customer' });
    await settled(page);
    await dialog.getByLabel('Full name').fill('Sample Person');
    await dialog.getByLabel('Phone').fill('9876500055');
    await dialog.getByLabel('Address', { exact: true }).fill('5 Sample Street');
    await dialog.getByLabel('City').fill('Delhi');
    await dialog.getByLabel('State').selectOption('07');
    await dialog.getByLabel('PIN code').fill('110001');
    await dialog.getByLabel('ID proof').setInputFiles({ name: 'id.png', mimeType: 'image/png', buffer: Buffer.from([137, 80, 78, 71]) });
    await dialog.getByRole('button', { name: 'Save customer' }).click();
    await expect(dialog.getByRole('checkbox', { name: 'Customer agreed to share this ID' })).toBeFocused();
    await expect(dialog).toContainText('Tick that the customer agreed');
  });
});

test.describe('Accounts customer check (item 10)', () => {
  test('list with status in words; open a customer; mark as checked', async ({ page }) => {
    await open(page, 'vn-customers');
    await pillsHaveIconAndWord(page);
    await expect(main(page).getByRole('navigation', { name: 'Customer check status' })).toBeVisible();
    await main(page).getByRole('link', { name: /Sample Travels Pvt Ltd/ }).click();
    await expect(page).toHaveURL(/vn-customer-check$/);
    await page.getByRole('button', { name: 'Mark as checked' }).click();
    await expect(main(page)).toContainText('Customer checked.');
  });

  test('return needs a reason of 10 to 500 characters; the typed reason stays after a refusal', async ({ page }) => {
    await open(page, 'vn-customer-check-refused');
    await page.getByRole('button', { name: 'Return with reason' }).click();
    const dialog = page.getByRole('dialog', { name: /Return Sample Travels Pvt Ltd/ });
    await dialog.getByRole('button', { name: 'Return to Sales' }).click();
    await expect(dialog.getByLabel('Reason')).toBeFocused();
    await dialog.getByLabel('Reason').fill('GSTIN state does not match the address.');
    await dialog.getByRole('button', { name: 'Return to Sales' }).click();
    await expect(dialog).toContainText('Write the reason in 10 to 500 characters.');
    await expect(dialog.getByLabel('Reason')).toHaveValue('GSTIN state does not match the address.');
  });

  test('edit warns that saving sets the customer back to Not checked', async ({ page }) => {
    await open(page, 'vn-customer-check');
    await page.getByRole('button', { name: 'Edit details' }).click();
    await expect(main(page)).toContainText('Saving changes sets this customer back to Not checked.');
    await expect(main(page).getByLabel('Company name')).toHaveValue('Sample Travels Pvt Ltd');
  });

  test('no check rights: the reason in words, no check button', async ({ page }) => {
    await open(page, 'vn-customer-check-blocked');
    await expect(page.getByRole('button', { name: 'Mark as checked' })).toHaveCount(0);
    await expect(main(page)).toContainText('Only Accounts staff of this company can check customers.');
  });

  test('a list that could not be read is never shown as empty', async ({ page }) => {
    await open(page, 'vn-customers-error');
    await expect(main(page)).toContainText('The customer list could not be read');
    await expect(main(page)).not.toContainText('No customers to check');
  });
});

test.describe('Imports and destination classes (item 5)', () => {
  test('check a CSV: read-only summary; apply asks for a reason and says what changes', async ({ page }) => {
    await open(page, 'vn-import-hotel');
    await page.getByRole('button', { name: 'Check file' }).click();
    await expect(main(page)).toContainText('Choose the CSV file first.');
    await page.getByLabel('CSV file').setInputFiles({ name: 'sample-hotels.csv', mimeType: 'text/csv', buffer: Buffer.from('Hotel ID,Hotel Name,City\nH1,Sample Lake View,Udaipur\n') });
    await page.getByRole('button', { name: 'Check file' }).click();
    const summary = main(page).getByRole('region', { name: '2. Check result' }).or(main(page).locator('section[aria-labelledby="import-summary-heading"]'));
    await expect(summary).toContainText('Possible duplicates');
    await expect(summary).toContainText('never merged');
    await expect(summary).toContainText('Row 14');
    await page.getByRole('button', { name: '3. Apply import' }).click();
    const dialog = page.getByRole('dialog', { name: 'Apply this import?' });
    await dialog.getByRole('button', { name: 'Apply import' }).click();
    await expect(dialog.getByLabel('Reason')).toBeFocused();
    await dialog.getByLabel('Reason').fill('Owner hotel list, approved 24 Oct.');
    await dialog.getByRole('button', { name: 'Apply import' }).click();
    await expect(dialog).toBeHidden();
    await expect(main(page)).toContainText('Applied: 98 new hotels, 12 updated.');
  });

  test('rows with assumed values are counted and listed, not hidden', async ({ page }) => {
    await open(page, 'vn-import-hotel-summary');
    const assumed = main(page).getByText(/2 rows with assumed values/);
    await assumed.click();
    await expect(main(page)).toContainText('GST status assumed as registered');
  });

  test('without the apply role: the summary is shown, no Apply button', async ({ page }) => {
    await open(page, 'vn-import-customer');
    await expect(page.getByRole('button', { name: '3. Apply import' })).toHaveCount(0);
    await expect(main(page)).toContainText('Only Accounts can apply a customer file.');
  });

  test('destination change: choose, reason, review, confirm; Not set first', async ({ page }) => {
    await open(page, 'vn-destinations');
    await pillsHaveIconAndWord(page);
    const firstRow = main(page).getByRole('row').nth(1);
    await expect(firstRow).toContainText('Not set');
    await page.getByRole('button', { name: 'Change Kerala' }).click();
    const dialog = page.getByRole('dialog', { name: 'Change Kerala' });
    await dialog.getByLabel('Domestic').check();
    await dialog.getByRole('button', { name: 'Review change' }).click();
    await expect(dialog.getByLabel('Reason')).toBeFocused();
    await dialog.getByLabel('Reason').fill('Indian state; owner list of 24 Oct.');
    await dialog.getByRole('button', { name: 'Review change' }).click();
    const review = page.getByRole('dialog', { name: 'Review change' });
    await expect(review).toContainText('Not set to Domestic');
    await review.getByRole('button', { name: 'Confirm change' }).click();
    await expect(review).toBeHidden();
    await expect(main(page)).toContainText('Kerala is now Domestic.');
  });
});

test.describe('Fix round (Echo-B M2, L1, L2, L5; Echo-A M1, L6)', () => {
  test('M2: a failed customer search says so; never "Searching…" forever', async ({ page }) => {
    await open(page, 'bookform-vn-billto-searchfail--finish');
    const bill = main(page).locator('section#billTo');
    await bill.getByRole('combobox', { name: 'Find customer' }).fill('Sample');
    await expect(bill).toContainText('Search did not work. Try again, or type the details.');
    await expect(bill.getByText('Searching…')).toHaveCount(0);
    await expect(bill.getByRole('status').filter({ hasText: 'Search did not work' })).toHaveCount(1);
  });

  test('L2: "Add customer" is offered as soon as the search box has focus', async ({ page }) => {
    await open(page, 'bookform-vn-billto--finish');
    const bill = main(page).locator('section#billTo');
    await bill.getByRole('combobox', { name: 'Find customer' }).focus();
    await expect(bill.getByRole('combobox', { name: 'Find customer' })).toHaveAttribute('aria-expanded', 'true');
    await expect(bill).toContainText('Type 2 letters to search.');
    await expect(bill.getByRole('button', { name: /^Add customer/ })).toHaveCount(2);
  });

  test('L1: − and + say the new value politely', async ({ page }) => {
    await open(page, 'bookform-vn-deal--stay');
    await main(page).getByRole('button', { name: 'Add car' }).click();
    const drawer = page.getByRole('dialog', { name: 'Add car' });
    await settled(page);
    await drawer.getByRole('button', { name: 'One vehicle more' }).click();
    await expect(drawer.getByRole('status').filter({ hasText: 'Number of vehicles: 2' })).toHaveCount(1);
  });

  test('L5: a sum error marks only the count that was changed', async ({ page }) => {
    await open(page, 'bookform-vn-gaps--travellers');
    const card = main(page).locator('section#customer');
    await card.getByRole('button', { name: 'One adult more' }).click();
    await expect(card.locator('#bf-counts-error')).toBeVisible();
    await expect(card.getByLabel('Adults', { exact: true })).toHaveAttribute('aria-invalid', 'true');
    await expect(card.getByLabel('Children', { exact: true })).not.toHaveAttribute('aria-invalid', 'true');
    await expect(card.getByLabel('Infants', { exact: true })).not.toHaveAttribute('aria-invalid', 'true');
    await card.getByRole('button', { name: 'One child more' }).click();
    await expect(card.getByLabel('Children', { exact: true })).toHaveAttribute('aria-invalid', 'true');
    await expect(card.getByLabel('Infants', { exact: true })).not.toHaveAttribute('aria-invalid', 'true');
  });

  test('Echo-A M1: customer import asks for the branch; Whole company only when chosen', async ({ page }) => {
    await open(page, 'vn-import-customer-choose');
    await page.getByLabel('CSV file').setInputFiles({ name: 'sample-customers.csv', mimeType: 'text/csv', buffer: Buffer.from('ID,Name\nC1,Sample Person\n') });
    await page.getByRole('button', { name: 'Check file' }).click();
    await expect(main(page)).toContainText('Choose the branch the customers belong to, or Whole company.');
    await expect(page.getByLabel('Customers belong to')).toBeFocused();
    await page.getByLabel('Customers belong to').selectOption('company');
    await page.getByRole('button', { name: 'Check file' }).click();
    await expect(main(page)).toContainText('For the whole company (every branch)');
    await open(page, 'vn-import-customer');
    await expect(page.getByLabel('Customers belong to')).toHaveValue('b-jdh');
  });

  test('Echo-A L6: the check says which rows will clear stored values', async ({ page }) => {
    await open(page, 'vn-import-hotel-summary');
    await main(page).getByText(/1 row will clear stored values/).click();
    await expect(main(page)).toContainText('Will clear the stored area');
  });
});

test.describe('Bitrix trip details switch (owner answer 3)', () => {
  test('Off in words with an icon; change needs a reason, then a review, then confirm', async ({ page }) => {
    await open(page, 'vn-trip-details-off');
    await pillsHaveIconAndWord(page);
    const card = main(page).locator('section').filter({ hasText: 'Bitrix trip details' });
    await expect(card).toContainText('Read trip details from Bitrix (destination, adults, children, infants).');
    await expect(card.locator('[data-slot="status-badge"]')).toContainText('Off');
    await card.getByRole('button', { name: 'Change Bitrix trip details setting' }).click();
    await card.getByRole('button', { name: 'Review change' }).click();
    await expect(card).toContainText('Type a reason of');
    await card.getByLabel('Why are you changing it?').fill('Owner approved trip details on 24 Oct.');
    await card.getByRole('button', { name: 'Review change' }).click();
    await expect(card.getByRole('heading', { name: 'Step 2 of 2: check and confirm' })).toBeFocused();
    await expect(card).toContainText('Turn Bitrix trip details on?');
    await card.getByRole('button', { name: 'Turn Bitrix trip details on' }).click();
    await expect(card.locator('[data-slot="trip-details-result"]')).toContainText('The reason is recorded');
  });

  test('a state that could not be read is Unknown, never Off; no change control without the right', async ({ page }) => {
    await open(page, 'vn-trip-details-unknown');
    const badge = main(page).locator('[data-slot="status-badge"]');
    await expect(badge).toContainText('Unknown');
    await expect(badge).not.toContainText('Off');
    await expect(main(page)).toContainText('shown as Unknown, not as Off');
    await open(page, 'vn-trip-details-viewer');
    await expect(main(page).getByRole('button', { name: /Change Bitrix trip details/ })).toHaveCount(0);
    await expect(main(page)).toContainText('Only a Super Admin can change this setting.');
  });
});

test.describe('Voice-note batch at phone widths', () => {
  for (const width of [320, 375]) {
    test(`no sideways scroll at ${width} px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 812 });
      for (const state of ['bookform-vn-deal--travellers', 'bookform-vn-gaps--travellers', 'bookform-vn-deal--stay', 'bookform-vn-billto-picked--finish', 'vn-customers', 'vn-customer-check', 'vn-import-hotel-summary', 'vn-destinations']) {
        await open(page, state);
        await noHorizontalScroll(page, `${state} at ${width}`);
      }
    });
  }
});
