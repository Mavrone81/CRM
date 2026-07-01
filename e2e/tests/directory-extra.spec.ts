import { test, expect } from '@playwright/test';
import { login } from './helpers';

test.describe('directory — chat suggest + agent filter', () => {
  test('the chat dropdown offers an editable, regenerable suggested reply', async ({ page }) => {
    await login(page);
    // Directory is the default view. Ivy has an AI suggestion already.
    const row = page.locator('tr', { hasText: 'Ivy Suggested' });
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: /Chat/ }).click();

    // The editable suggested-reply box + Regenerate + Open WhatsApp appear in the dropdown.
    await expect(page.locator('textarea')).toBeVisible();
    await expect(page.getByRole('button', { name: /Regenerate/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Open WhatsApp/ })).toBeVisible();
  });

  test('agent filter shows only that agent\'s leads', async ({ page }) => {
    await login(page);
    await page.getByLabel('Filter by agent').selectOption({ label: 'Vivian' });
    // Kara (n2 = Vivian) shows; Ivy (n1 = Sam) is hidden.
    await expect(page.getByText('Kara Collapse')).toBeVisible();
    await expect(page.getByText('Ivy Suggested')).toHaveCount(0);
  });
});
