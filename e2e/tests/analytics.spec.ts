import { test, expect } from '@playwright/test';
import { login } from './helpers';

test.describe('analytics — session calendar', () => {
  test('renders the session calendar with sessions and booked counts', async ({ page }) => {
    await login(page);
    await page.getByRole('banner').getByRole('button', { name: 'Analytics' }).click();

    const cal = page.locator('div.rounded-xl', { has: page.getByRole('heading', { name: /Session calendar/ }) });
    await expect(cal).toBeVisible();
    // The briefing grouping + at least one session row with a booked count render.
    await expect(cal.getByText('Briefing (1st, face-to-face)')).toBeVisible();
    await expect(cal.getByText(/booked/).first()).toBeVisible();
    await expect(cal.getByText(/Jul/).first()).toBeVisible();
  });
});
