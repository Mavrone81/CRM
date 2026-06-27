import { test, expect } from '@playwright/test';
import { login } from './helpers';

test.describe('pipeline — suggested reply (Send / Regenerate / Suggest)', () => {
  test('a card WITH a suggestion can Regenerate and Send', async ({ page }) => {
    await login(page);
    await page.getByRole('banner').getByRole('button', { name: /Pipeline/ }).click();
    await expect(page.getByRole('heading', { name: 'Recruitment Pipeline' })).toBeVisible();

    // "Interested" is the default tab and holds the seeded suggestion lead.
    await page.getByRole('button', { name: /^Interested/ }).click();
    const card = page.locator('div.rounded-xl', { hasText: 'Ivy Suggested' });
    await expect(card).toBeVisible();

    // Suggested-reply block shows ✨ Regenerate, Send and Copy.
    const regen = card.getByRole('button', { name: /Regenerate/ });
    const send = card.getByRole('button', { name: 'Send', exact: true });
    await expect(regen).toBeVisible();
    await expect(send).toBeVisible();

    // Regenerate -> keyword fallback (last reply contains "interested") yields a
    // non-empty suggestion, so the toast confirms.
    await regen.click();
    await expect(page.getByText('Regenerated')).toBeVisible();

    // Send -> the fake socket swallows it and the toast names the lead.
    await card.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('Sent to Ivy Suggested')).toBeVisible();
  });

  test('a card WITHOUT a suggestion can generate one', async ({ page }) => {
    await login(page);
    await page.getByRole('banner').getByRole('button', { name: /Pipeline/ }).click();
    await expect(page.getByRole('heading', { name: 'Recruitment Pipeline' })).toBeVisible();
    await page.getByRole('button', { name: /^Interested/ }).click();

    const card = page.locator('div.rounded-xl', { hasText: 'Jack Nosuggest' });
    await expect(card).toBeVisible();

    // No suggestion yet -> the "✨ Suggest a reply" prompt is shown.
    const suggestBtn = card.getByRole('button', { name: /Suggest a reply/ });
    await expect(suggestBtn).toBeVisible();

    // Clicking it produces a spintax opening (lead has no replies) -> Send appears.
    await suggestBtn.click();
    await expect(page.getByText('Regenerated')).toBeVisible();
    await expect(card.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
  });
});
