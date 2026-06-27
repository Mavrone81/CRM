import { test, expect } from '@playwright/test';
import { login } from './helpers';

// New-reply cards must float to the top of a pipeline tab even under the default
// "coldest contact first" sort. Nora was contacted most recently (so coldest-first
// would rank her LAST) but has needsReply -> she must render FIRST.
test.describe('pipeline — new replies sort first', () => {
  test('a needsReply lead appears first in Interested despite recent contact', async ({ page }) => {
    await login(page);
    await page.getByRole('banner').getByRole('button', { name: /Pipeline/ }).click();
    await expect(page.getByRole('heading', { name: 'Recruitment Pipeline' })).toBeVisible();

    await page.getByRole('button', { name: /^Interested/ }).click();

    const card = page.locator('div.rounded-xl', { hasText: 'Nora NewReply' });
    await expect(card).toBeVisible();
    await expect(card.getByText('new reply')).toBeVisible();

    // Under the default "coldest contact first" sort, Nora (most recently contacted)
    // would be LAST — but needsReply floats her to the FIRST card.
    await expect(page.locator('div.rounded-xl').first()).toContainText('Nora NewReply');
  });
});
