import { test, expect } from '@playwright/test';
import { login } from './helpers';

test.describe('directory', () => {
  test('seeded leads are listed', async ({ page }) => {
    await login(page);
    // Directory is the default view. Seeded leads should appear in the table.
    await expect(page.getByText('Alice Reviewer')).toBeVisible();
    await expect(page.getByText('Bob Attended')).toBeVisible();
    await expect(page.getByText('Carol Newlead')).toBeVisible();
    await expect(page.getByText('Dave Contacted')).toBeVisible();
  });

  test('the create-lead form adds a new row', async ({ page }) => {
    await login(page);

    // Unique name + phone so the run is idempotent against the shared backend
    // (re-runs/retries never trip the server's duplicate detection).
    const unique = Date.now().toString().slice(-7);
    const name = `Zara E2E ${unique}`;
    const phone = `9${unique}`; // 8-digit SG local number

    await page.getByRole('button', { name: '+ Add Lead' }).click();
    await expect(page.getByRole('heading', { name: 'Add Lead' })).toBeVisible();

    // The modal inputs have no linked <label>, so target each field via its
    // label text's parent container.
    const field = (labelText: string) =>
      page.getByText(labelText, { exact: true }).locator('..').getByRole('textbox');

    await field('Name *').fill(name);
    await field('Phone *').fill(phone);

    await page.getByRole('button', { name: 'Add', exact: true }).click();

    // New lead is prepended to the table and visible after the next poll.
    // Scope to the table so we don't match the transient "Added …" toast.
    await expect(page.locator('table').getByText(name, { exact: true })).toBeVisible();
  });
});
