import { test, expect } from '@playwright/test';
import { login } from './helpers';

test.describe('action inbox — collapse / expand', () => {
  test('Collapse all hides card actions; Expand all brings them back', async ({ page }) => {
    await login(page);
    await page.getByRole('banner').getByRole('button', { name: /Inbox/ }).click();
    await expect(page.getByRole('heading', { name: 'Action Inbox' })).toBeVisible();

    // The seeded "question" lead is in the triage queue.
    const card = page.locator('div.rounded-xl', { hasText: 'Kara Collapse' });
    await expect(card).toBeVisible();

    // Expanded by default: the action buttons are present.
    const interested = card.getByRole('button', { name: '→ Interested' });
    await expect(interested).toBeVisible();

    // Collapse all -> the action buttons hide, only a one-line preview remains.
    await page.getByRole('button', { name: 'Collapse all' }).click();
    await expect(interested).toBeHidden();
    await expect(card.getByText('Quick question about timing?')).toBeVisible();

    // Expand all -> the action buttons return.
    await page.getByRole('button', { name: 'Expand all' }).click();
    await expect(interested).toBeVisible();
  });

  test('a single card toggles independently', async ({ page }) => {
    await login(page);
    await page.getByRole('banner').getByRole('button', { name: /Inbox/ }).click();
    await expect(page.getByRole('heading', { name: 'Action Inbox' })).toBeVisible();

    const card = page.locator('div.rounded-xl', { hasText: 'Kara Collapse' });
    const interested = card.getByRole('button', { name: '→ Interested' });
    await expect(interested).toBeVisible();

    // Per-card collapse toggle (header chevron button).
    await card.getByRole('button', { name: /collapse/ }).click();
    await expect(interested).toBeHidden();

    // Toggle back open.
    await card.getByRole('button', { name: /expand/ }).click();
    await expect(interested).toBeVisible();
  });
});
