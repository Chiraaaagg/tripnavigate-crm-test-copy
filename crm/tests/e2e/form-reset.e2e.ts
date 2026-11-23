import { expect, type Locator, type Page, test } from '@playwright/test';
import { LOCAL_NETWORK_ACCESS_OFF } from '../helpers/production-style-policy';
import { open } from './b11-helpers';

/**
 * React 19 resets a `<form action={fn}>` after every reply. A controlled
 * <select>, checkbox or radio then shows the value it had when the form first
 * appeared while component state keeps the chosen one, and the next press
 * posts the old value. Each test changes a choice away from its first value,
 * presses the form's own button, waits for the reply, and checks that the
 * control still shows the chosen value; where practical it presses again and
 * checks the posted request carries that value.
 *
 * Preview gallery with stand-in actions only (synthetic data, nothing real
 * is saved): proves the screens keep what is shown, not a real journey.
 */

test.use(LOCAL_NETWORK_ACCESS_OFF);

const SMALL_PDF = { name: 'synthetic-proof.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n% synthetic\n') };

function isServerAction(request: { method(): string; headers(): Record<string, string> }) {
  return request.method() === 'POST' && 'next-action' in request.headers();
}

/** Press a submit button and wait until the reply is on screen (the button no longer shows its "…ing…" label). */
async function pressAndWait(page: Page, button: Locator) {
  const reply = page.waitForResponse((r) => isServerAction(r.request()));
  await button.click();
  await reply;
  await expect(button).not.toContainText('…');
}

/*
 * The fields a press sends, read from the submit event exactly as both the
 * hand submit and React's own form action read them (the form on screen plus
 * the pressed button). The stand-in preview actions take no arguments, so
 * Next leaves the fields out of the request body; the submit event is the
 * faithful place to see them.
 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __sent: Array<Array<[string, string]>> };
    w.__sent = [];
    document.addEventListener(
      'submit',
      (event) => {
        const form = event.target as HTMLFormElement;
        const submitter = (event as SubmitEvent).submitter;
        let fd: FormData;
        try {
          fd = submitter ? new FormData(form, submitter) : new FormData(form);
        } catch {
          fd = new FormData(form);
        }
        w.__sent.push([...fd.entries()].filter((e): e is [string, string] => typeof e[1] === 'string'));
      },
      true,
    );
  });
});

/** Press again unchanged and return the fields that press submitted (read from the form at submit time). */
async function pressAndCapture(page: Page, button: Locator): Promise<Array<[string, string]>> {
  const before = await page.evaluate(() => (window as unknown as { __sent: unknown[] }).__sent.length);
  await pressAndWait(page, button);
  const sent = await page.evaluate(() => (window as unknown as { __sent: Array<Array<[string, string]>> }).__sent);
  expect(sent.length, 'one submit for the press').toBe(before + 1);
  return sent[sent.length - 1]!;
}

function expectPosted(fields: Array<[string, string]>, field: string, value: string) {
  expect(fields.filter(([k]) => k === field).map(([, v]) => v), `${field} sent`).toContain(value);
}

/** Choose the first option that differs from the current value; returns it. */
async function chooseOther(select: Locator): Promise<string> {
  const value = await select.evaluate((el) => {
    const s = el as HTMLSelectElement;
    return Array.from(s.options).find((o) => !o.disabled && o.value !== '' && o.value !== s.value)?.value ?? null;
  });
  expect(value, 'another option to choose').not.toBeNull();
  await select.selectOption(value!);
  return value!;
}

test.describe('choices stay as shown after a reply', () => {
  // Visa build (contract 11.1): the old desk's forms (document status select, upload kind select, outcome select) are
  // retired. The new desk sends each command from its own code (no <form action>), so the React reset cannot hit it, but
  // the intent stays: what the user chose or typed is still on screen after the reply, and a refusal keeps it.
  test('Visa desk: a document tick stays as chosen after a refused row save; an accepted save posts only the changed tick', async ({ page }) => {
    // Was: the "Passport copy" status select stayed "received" after a save.
    await open(page, 'visa-work-edit-row-refused');
    const row = page.locator('main').getByRole('row').filter({ has: page.getByRole('button', { name: /^Save/ }) }).first();
    const box = row.getByRole('checkbox').first();
    const was = await box.isChecked();
    await box.setChecked(!was);
    await row.getByRole('button', { name: /^Save/ }).click();
    await expect(page.locator('main').getByRole('alert').first()).toBeVisible();
    await expect(box).toBeChecked({ checked: !was });
    await open(page, 'visa-work-edit-row-echo');
    const echoRow = page.locator('main').getByRole('row').filter({ has: page.getByRole('button', { name: /^Save/ }) }).first();
    const echoBox = echoRow.getByRole('checkbox').first();
    await echoBox.setChecked(!(await echoBox.isChecked()));
    await echoRow.getByRole('button', { name: /^Save/ }).click();
    await expect(page.locator('main')).toContainText(/row saved with 1 document change/);
  });

  test('Visa desk: the chosen document stays chosen in the upload popup after the reply (the file input empties)', async ({ page }) => {
    // Was: the "What is this file?" kind select stayed "authority_outcome" after a stored file.
    await open(page, 'visa-popup-upload-doc');
    const dialog = page.getByRole('dialog');
    const which = dialog.getByLabel('Which document');
    const chosen = await chooseOther(which);
    const file = dialog.locator('input[type="file"]');
    await file.setInputFiles(SMALL_PDF);
    await dialog.getByRole('button', { name: 'Upload and save' }).click();
    // The stand-in accepts: either the popup closes with the result shown, or it stays with the choice kept and the file emptied.
    if (await dialog.isVisible().catch(() => false)) {
      await expect(which).toHaveValue(chosen);
    } else {
      await expect(page.locator('main [role=status]').first()).toBeVisible();
    }
  });

  test('Visa desk: a refused decision keeps the chosen handover; a refused Applied keeps the typed details', async ({ page }) => {
    // Was: the outcome select stayed "Refused" after a refusal (old "Record refused").
    await open(page, 'visa-popup-approve-refused');
    const dialog = page.getByRole('dialog');
    const method = dialog.getByLabel(/How the passport goes back/);
    const chosen = await chooseOther(method);
    await dialog.getByRole('button', { name: 'Save approval' }).click();
    await expect(dialog.getByRole('alert').first()).toBeVisible();
    await expect(method).toHaveValue(chosen);
    await open(page, 'visa-popup-apply-refused');
    const apply = page.getByRole('dialog');
    const ref = apply.getByLabel(/Reference number/).first();
    await ref.fill('SYN-KEEP-001');
    await apply.getByRole('button', { name: /^(Confirm applied|Save as applied)$/ }).click();
    await expect(apply.getByRole('alert').first()).toBeVisible();
    await expect(ref).toHaveValue('SYN-KEEP-001');
  });

  test('Flight cost: the old "Record a cost" form is retired for flights', async ({ page }) => {
    // Flight build (contract decision 3 / B13): the per-passenger fare breakup is the only flight cost record,
    // so the manual cost form whose choices this test used to check no longer exists on flight tasks.
    // Typed input kept after a refusal in the new Confirm tickets popup is covered by flight-screens.e2e.ts.
    await open(page, 'b11-flight-task-cost-over-limit');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('form', { name: 'Record a cost' })).toHaveCount(0);
  });

  test('Quotation Details: "Domestic or international" stays chosen after a refusal', async ({ page }) => {
    await open(page, 'b12-quote-draft');
    const section = page.locator('section#details');
    await section.getByRole('button', { name: /1\. Trip/ }).click();
    const scope = page.locator('#q-details-tripScope');
    const chosen = await chooseOther(scope);
    const save = section.getByRole('button', { name: 'Save trip and travellers' });
    await pressAndWait(page, save);
    await expect(section.getByRole('alert')).toContainText('Some details are missing or not valid.');
    await expect(scope).toHaveValue(chosen);
    expectPosted(await pressAndCapture(page, save), (await scope.getAttribute('name'))!, chosen);
  });

  test('Quotation prices: a price-line choice and the per-person tick stay after "Save prices"', async ({ page }) => {
    // "Save prices" builds each form's fields by hand (never React's reset); this guards that path.
    await open(page, 'b2-quote-draft-saving');
    const money = page.locator('section#money');
    await money.getByRole('button', { name: /5\. Prices/ }).click();
    const category = page.locator('#q-line-1-lineCategoryKey');
    const chosen = await chooseOther(category);
    const perPerson = page.locator('#q-total-quoted-pp');
    const ticked = !(await perPerson.isChecked());
    await perPerson.setChecked(ticked);
    const savePrices = money.getByRole('button', { name: 'Save prices' });
    await savePrices.click();
    await expect(money.getByRole('status').filter({ hasText: /^Saved:/ })).toBeVisible();
    await expect(savePrices).toBeEnabled();
    await expect(category).toHaveValue(chosen);
    if (ticked) await expect(perPerson).toBeChecked();
    else await expect(perPerson).not.toBeChecked();
  });

  test('Quotation decline: the reason stays chosen after the decline is saved', async ({ page }) => {
    await open(page, 'b12-quote-sent');
    const form = page.getByRole('form', { name: 'Record the decline' });
    const reason = form.getByLabel('Why did the customer decline?');
    await reason.selectOption('price');
    await form.getByRole('button', { name: 'Mark declined' }).click();
    const yes = form.getByRole('button', { name: 'Yes, mark declined' });
    await pressAndWait(page, yes);
    await expect(form.getByRole('status').first()).not.toBeEmpty();
    await expect(reason).toHaveValue('price');
    expectPosted(await pressAndCapture(page, yes), (await reason.getAttribute('name'))!, 'price');
  });

  test('Itinerary facts: "Typed from" and "In the price?" stay chosen after a refusal', async ({ page }) => {
    await open(page, 'b12-itin-open');
    const form = page.getByRole('form', { name: 'Itinerary facts' });
    const source = form.getByLabel('Typed from');
    const included = form.getByLabel('In the price?').first();
    const sourceBefore = await source.inputValue();
    const chosenSource = await source.evaluate((el) => Array.from((el as HTMLSelectElement).options).find((o) => o.value !== (el as HTMLSelectElement).value)!.value);
    await source.selectOption(chosenSource);
    expect(chosenSource).not.toBe(sourceBefore);
    const chosenIncluded = await chooseOther(included);
    const save = form.getByRole('button', { name: 'Save facts' });
    await pressAndWait(page, save);
    await expect(form.getByRole('alert').first()).toBeVisible();
    await expect(source).toHaveValue(chosenSource);
    await expect(included).toHaveValue(chosenIncluded);
    const body = await pressAndCapture(page, save);
    expectPosted(body, (await included.getAttribute('name'))!, chosenIncluded);
    expectPosted(body, (await source.getAttribute('name'))!, chosenSource);
  });

  test('Booking revision: the change type radio stays ticked after a save', async ({ page }) => {
    await open(page, 'bookform-revision--finish');
    const radio = page.locator('#bk-class-customer_material');
    await expect(radio).not.toBeChecked();
    await radio.check();
    const save = page.getByRole('button', { name: 'Save the change type' });
    await pressAndWait(page, save);
    await expect(page.getByText('Change type saved.')).toBeVisible();
    await expect(radio).toBeChecked();
    expectPosted(await pressAndCapture(page, save), 'changeClass', 'customer_material');
  });

  test('Report a payment: "How they paid" stays chosen after a refusal', async ({ page }) => {
    await open(page, 'b11-submitted-claim-refused');
    const form = page.getByRole('form', { name: 'Tell Accounts about a payment' });
    const mode = form.getByLabel('How they paid');
    await expect(mode).toHaveValue('bank_transfer');
    await mode.selectOption('cash');
    await form.getByLabel('Amount ₹').fill('5000');
    const report = form.getByRole('button', { name: 'Send to Accounts' });
    await pressAndWait(page, report);
    await expect(form.getByRole('alert').first()).toBeVisible();
    await expect(mode).toHaveValue('cash');
    expectPosted(await pressAndCapture(page, report), 'claimMode', 'cash');
  });

  test('Accounts: the chosen receipt stays after linking it to a claim', async ({ page }) => {
    await open(page, 'b11-accounts-claim-reported');
    const section = page.getByRole('region', { name: 'Reported payments' });
    await section.getByRole('button', { name: 'Link an existing receipt' }).click();
    const form = page.getByRole('form', { name: 'Link an existing receipt to this claim' });
    const receipt = form.getByLabel('Receipt on this deal');
    const chosen = await chooseOther(receipt);
    await form.getByLabel(/Reason for the difference/).fill('Synthetic reason: bank charges on top.');
    const link = form.getByRole('button', { name: 'Link this receipt' });
    await pressAndWait(page, link);
    await expect(form.getByRole('status')).toContainText('Linked to the existing receipt.');
    await expect(receipt).toHaveValue(chosen);
    expectPosted(await pressAndCapture(page, link), 'receiptId', chosen);
  });
});
