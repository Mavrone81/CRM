import { test, expect } from '@playwright/test';
import { login } from './helpers';

test.describe('recruitment pipeline', () => {
  test('an attended lead can be advanced to the Agreement column', async ({ page }) => {
    await login(page);

    // Open the Pipeline view (nav tab lives in the header/banner; the Directory
    // toolbar also has a "Pipeline" group filter, so scope to the banner).
    await page.getByRole('banner').getByRole('button', { name: /Pipeline/ }).click();
    await expect(page.getByRole('heading', { name: 'Recruitment Pipeline' })).toBeVisible();

    // Go to the "Attended" stage tab and find the seeded attended lead.
    await page.getByRole('button', { name: /^Attended/ }).click();
    const attendedCard = page.locator('div.rounded-xl', { hasText: 'Bob Attended' });
    await expect(attendedCard).toBeVisible();

    // Advance it via the agreement action.
    await attendedCard.getByRole('button', { name: 'Mark agreement sent' }).click();

    // It leaves the Attended stage...
    await expect(page.locator('div.rounded-xl', { hasText: 'Bob Attended' })).toHaveCount(0);

    // ...and now lives in the "Agreement sent" stage (status === 'agreement').
    await page.getByRole('button', { name: /^Agreement sent/ }).click();
    await expect(page.locator('div.rounded-xl', { hasText: 'Bob Attended' })).toBeVisible();
  });
});
