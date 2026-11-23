import { expect, type Locator, test } from '@playwright/test';

/*
 * AUDIT-017: React 19 resets an uncontrolled <form action> after every
 * action, including a refusal. The plain form shows that behaviour; the
 * second form uses useKeepValuesOnFailure (as the Purchase forms do) and
 * must keep what the person typed.
 */

async function fill(form: Locator) {
  await form.getByLabel('Hotel offered').fill('Synthetic Hilltop Resort');
  await form.getByLabel('Supplier price').fill('12.345');
  await form.getByLabel('Meal plan').selectOption('CP');
  await form.getByLabel('Cancellation terms').fill('Free until 7 days before arrival');
  await form.getByLabel('Hotel', { exact: true }).uncheck();
  await form.getByLabel('Transfer').check();
}

test('a refused submit keeps the typed values (and a plain form would lose them)', async ({ page }) => {
  // The dev server compiles the preview route on first request (slow on Windows).
  test.setTimeout(150_000);
  await page.goto('/preview/procurement-form-keeps-values', { timeout: 120_000 });

  const plain = page.getByTestId('plain');
  await fill(plain);
  await plain.getByRole('button', { name: 'Submit plain' }).click();
  await expect(plain.getByRole('alert')).toContainText('Synthetic refusal');
  // React's reset: back to the defaults.
  await expect(plain.getByLabel('Supplier price')).toHaveValue('');
  await expect(plain.getByLabel('Hotel offered')).toHaveValue('Synthetic Lakeside Hotel');

  const kept = page.getByTestId('kept');
  await fill(kept);
  await kept.getByRole('button', { name: 'Submit kept' }).click();
  await expect(kept.getByRole('alert')).toContainText('Synthetic refusal');
  await expect(kept.getByLabel('Hotel offered')).toHaveValue('Synthetic Hilltop Resort');
  await expect(kept.getByLabel('Supplier price')).toHaveValue('12.345');
  await expect(kept.getByLabel('Meal plan')).toHaveValue('CP');
  await expect(kept.getByLabel('Cancellation terms')).toHaveValue('Free until 7 days before arrival');
  await expect(kept.getByLabel('Hotel', { exact: true })).not.toBeChecked();
  await expect(kept.getByLabel('Transfer')).toBeChecked();

  // A second refusal still keeps them.
  await kept.getByRole('button', { name: 'Submit kept' }).click();
  await expect(kept.getByLabel('Supplier price')).toHaveValue('12.345');
});
