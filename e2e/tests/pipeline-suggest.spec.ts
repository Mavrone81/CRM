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

    // Suggested-reply block shows ✨ Regenerate, Open WhatsApp and Copy.
    const regen = card.getByRole('button', { name: /Regenerate/ });
    const send = card.getByRole('button', { name: /Open WhatsApp/ });
    await expect(regen).toBeVisible();
    await expect(send).toBeVisible();

    // Regenerate -> keyword fallback (last reply contains "interested") yields a
    // non-empty suggestion, so the toast confirms.
    await regen.click();
    await expect(page.getByText('Regenerated')).toBeVisible();

    // Open WhatsApp -> Baileys-free deep link; the send is recorded and the toast names the lead.
    await card.getByRole('button', { name: /Open WhatsApp/ }).click();
    await expect(page.getByText(/Opened WhatsApp — Ivy Suggested/)).toBeVisible();

    // Re-classify -> bot re-reads the chat (no AI in test = no move) and toasts the result.
    await card.getByRole('button', { name: /Re-classify/ }).click();
    await expect(page.getByText(/Ivy Suggested: (no change|interested|confirmed|attended)/)).toBeVisible();
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

    // Clicking it produces a spintax opening (lead has no replies) -> Open WhatsApp appears.
    await suggestBtn.click();
    await expect(page.getByText('Regenerated')).toBeVisible();
    await expect(card.getByRole('button', { name: /Open WhatsApp/ })).toBeVisible();
  });
});
