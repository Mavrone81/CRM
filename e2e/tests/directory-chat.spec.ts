import { test, expect } from '@playwright/test';
import { login } from './helpers';

// Directory rows can drop down to show the full conversation (lead <-> agent).
test.describe('directory — conversation dropdown', () => {
  test('the Chat toggle reveals the message thread for a lead', async ({ page }) => {
    await login(page);

    // Directory is the default view. Bob has a seeded reply.
    const row = page.locator('tr', { hasText: 'Bob Attended' });
    await expect(row).toBeVisible();

    // Chat bubbles only exist once the row is expanded.
    const bubble = page.locator('.rounded-2xl', { hasText: 'Yes I attended' });
    await expect(bubble).toHaveCount(0);

    await row.getByRole('button', { name: /Chat/ }).click();
    await expect(bubble).toBeVisible();

    // Toggling again collapses it.
    await row.getByRole('button', { name: /Chat/ }).click();
    await expect(bubble).toHaveCount(0);
  });
});
