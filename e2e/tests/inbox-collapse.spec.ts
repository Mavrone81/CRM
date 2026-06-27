import { test, expect } from '@playwright/test';
import { login } from './helpers';

test.describe('action inbox — collapse / expand', () => {
  test('cards are collapsed by default; Expand all reveals actions; Collapse all hides them', async ({ page }) => {
    await login(page);
    await page.getByRole('banner').getByRole('button', { name: /Inbox/ }).click();
    await expect(page.getByRole('heading', { name: 'Action Inbox' })).toBeVisible();

    // The seeded "question" lead is in the triage queue.
    const card = page.locator('div.rounded-xl', { hasText: 'Kara Collapse' });
    await expect(card).toBeVisible();
    const interested = card.getByRole('button', { name: '→ Interested' });

    // Collapsed by default: actions hidden, only a one-line preview shows.
    await expect(interested).toBeHidden();
    await expect(card.getByText('Quick question about timing?')).toBeVisible();

    // Expand all -> the action buttons appear.
    await page.getByRole('button', { name: 'Expand all' }).click();
    await expect(interested).toBeVisible();

    // Collapse all -> hidden again.
    await page.getByRole('button', { name: 'Collapse all' }).click();
    await expect(interested).toBeHidden();
  });

  test('a single card expands/collapses independently', async ({ page }) => {
    await login(page);
    await page.getByRole('banner').getByRole('button', { name: /Inbox/ }).click();
    await expect(page.getByRole('heading', { name: 'Action Inbox' })).toBeVisible();

    const card = page.locator('div.rounded-xl', { hasText: 'Kara Collapse' });
    const interested = card.getByRole('button', { name: '→ Interested' });

    // Collapsed by default.
    await expect(interested).toBeHidden();

    // Expand this one card (header chevron).
    await card.getByRole('button', { name: /expand/ }).click();
    await expect(interested).toBeVisible();

    // Collapse it again.
    await card.getByRole('button', { name: /collapse/ }).click();
    await expect(interested).toBeHidden();
  });
});
