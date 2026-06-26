import { test, expect } from '@playwright/test';
import { login } from './helpers';

// Locate the table row that contains a given lead name.
const row = (page: import('@playwright/test').Page, name: string) =>
  page.locator('table tr', { hasText: name });

test.describe('directory — remove lead', () => {
  test('Remove deletes the row after confirming the dialog', async ({ page }) => {
    await login(page);

    // Create a throwaway lead so the run is idempotent (never deletes a fixture
    // lead another spec relies on, and re-runs always have a fresh one to remove).
    const unique = Date.now().toString().slice(-7);
    const name = `Remove Me ${unique}`;
    const phone = `8${unique}`; // 8-digit SG local number

    await page.getByRole('button', { name: '+ Add Lead' }).click();
    await expect(page.getByRole('heading', { name: 'Add Lead' })).toBeVisible();
    const field = (labelText: string) =>
      page.getByText(labelText, { exact: true }).locator('..').getByRole('textbox');
    await field('Name *').fill(name);
    await field('Phone *').fill(phone);
    await page.getByRole('button', { name: 'Add', exact: true }).click();

    // It lands in the table.
    await expect(row(page, name)).toBeVisible();

    // Accept the confirm() dialog, then click Remove on that row.
    page.once('dialog', (d) => d.accept());
    await row(page, name).getByRole('button', { name: 'Remove' }).click();

    // Toast confirms, and the row is gone after the next poll.
    await expect(page.getByText('Lead removed')).toBeVisible();
    await expect(row(page, name)).toHaveCount(0);
  });

  test('dismissing the confirm dialog keeps the lead', async ({ page }) => {
    await login(page);

    // "Hank Keeper" is a stable seeded lead; cancelling never mutates it, so this
    // case stays idempotent across re-runs.
    await expect(row(page, 'Hank Keeper')).toBeVisible();

    page.once('dialog', (d) => d.dismiss());
    await row(page, 'Hank Keeper').getByRole('button', { name: 'Remove' }).click();

    // Still present — nothing was deleted.
    await expect(row(page, 'Hank Keeper')).toBeVisible();
  });
});
