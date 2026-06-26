import { test, expect } from '@playwright/test';
import { login } from './helpers';

test.describe('action inbox', () => {
  test('a review/question lead shows in the inbox and an action moves it out', async ({ page }) => {
    await login(page);

    // Open the Inbox view (nav tab in the header/banner).
    await page.getByRole('banner').getByRole('button', { name: /Inbox/ }).click();
    await expect(page.getByRole('heading', { name: 'Action Inbox' })).toBeVisible();

    // The seeded "review" lead is in the triage queue.
    const card = page.locator('div.rounded-xl', { hasText: 'Alice Reviewer' });
    await expect(card).toBeVisible();
    // Its inbound reply is shown in the thread.
    await expect(card.getByText('what exactly is this opportunity about?', { exact: false })).toBeVisible();

    // Act on it: mark interested -> it leaves the inbox (status becomes 'interested').
    await card.getByRole('button', { name: '→ Interested' }).click();

    await expect(page.locator('div.rounded-xl', { hasText: 'Alice Reviewer' })).toHaveCount(0);

    // The seeded "question" lead is still in the queue (untouched).
    await expect(page.locator('div.rounded-xl', { hasText: 'Eve Question' })).toBeVisible();
  });
});
