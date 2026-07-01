import { test, expect } from '@playwright/test';
import { login } from './helpers';

// Cold outreach leads (contacted, no reply) surface in the Inbox so reps can
// follow up, with an AI-suggested follow-up nudge.
test.describe('inbox — cold lead follow-up', () => {
  test('a contacted lead shows as "Cold — follow up" and can generate a nudge', async ({ page }) => {
    await login(page);
    await page.getByRole('banner').getByRole('button', { name: /Inbox/ }).click();
    await expect(page.getByRole('heading', { name: 'Action Inbox' })).toBeVisible();

    const card = page.locator('div.rounded-xl', { hasText: 'Dave Contacted' });
    await expect(card).toBeVisible();
    await expect(card.getByText(/Cold.*follow up/)).toBeVisible();

    // Expand (cards collapse by default) and generate a follow-up suggestion.
    await card.getByRole('button', { name: /expand/ }).click();
    await card.getByRole('button', { name: /Suggest a reply/ }).click();

    // A suggestion is produced -> the editable box + the WhatsApp deep-link button appear.
    await expect(card.getByRole('button', { name: /Open WhatsApp/ })).toBeVisible();
  });
});
