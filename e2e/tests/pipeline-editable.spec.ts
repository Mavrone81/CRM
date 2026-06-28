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
    await card.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('Sent to Ivy Suggested')).toBeVisible();

    // The edited text — not the original AI draft — is what actually went out.
    const sent: Array<{ content: { text?: string } }> =
      await (await fetch('http://localhost:10001/__test/sent')).json();
    expect(sent.some((s) => s.content?.text === custom)).toBeTruthy();
  });
});
