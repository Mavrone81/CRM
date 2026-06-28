import { test, expect } from '@playwright/test';
import { login } from './helpers';

test.describe('inbox — agent + last follow-up + agent filter', () => {
  test('cards show the assigned agent and last follow-up', async ({ page }) => {
    await login(page);
    await page.getByRole('banner').getByRole('button', { name: /Inbox/ }).click();
    await expect(page.getByRole('heading', { name: 'Action Inbox' })).toBeVisible();

    const card = page.locator('div.rounded-xl', { hasText: 'Eve Question' }); // assigned to n1 = Sam
    await expect(card).toBeVisible();
    await expect(card.getByText('Sam')).toBeVisible();
    await expect(card.getByText(/Last follow-up/)).toBeVisible();
  });

  test('agent filter narrows the queue to one agent', async ({ page }) => {
    await login(page);
    await page.getByRole('banner').getByRole('button', { name: /Inbox/ }).click();
    await page.getByLabel('Filter by agent').selectOption({ label: 'Vivian' });
    // Kara (n2 = Vivian) stays; Eve (n1 = Sam) is filtered out.
    await expect(page.locator('div.rounded-xl', { hasText: 'Kara Collapse' })).toBeVisible();
    await expect(page.locator('div.rounded-xl', { hasText: 'Eve Question' })).toHaveCount(0);
  });
});
