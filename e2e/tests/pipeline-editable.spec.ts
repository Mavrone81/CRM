import { test, expect } from '@playwright/test';
import { login } from './helpers';

// The Pipeline suggested reply is editable — Send must send the AMENDED text.
test.describe('pipeline — editable suggested reply', () => {
  test('amending the suggestion sends the edited text', async ({ page }) => {
    await login(page);
    await page.getByRole('banner').getByRole('button', { name: /Pipeline/ }).click();
    await page.getByRole('button', { name: /^Interested/ }).click();

    const card = page.locator('div.rounded-xl', { hasText: 'Ivy Suggested' });
    await expect(card).toBeVisible();

    const custom = 'AMENDED-BY-REP-9988';
    await card.locator('textarea').fill(custom);
    // WhatsApp is Baileys-free: "Open WhatsApp" opens a click-to-chat deep link and
    // RECORDS the send (no socket). The edited text — not the AI draft — is recorded.
    await card.getByRole('button', { name: /Open WhatsApp/ }).click();
    await expect(page.getByText(/Opened WhatsApp — Ivy Suggested/)).toBeVisible();

    const leads: Array<{ name: string; sentReplies?: Array<{ text: string }> }> =
      await (await fetch('http://localhost:10001/api/leads')).json();
    const ivy = leads.find((l) => l.name === 'Ivy Suggested');
    expect(ivy?.sentReplies?.some((r) => r.text === custom)).toBeTruthy();
  });
});
