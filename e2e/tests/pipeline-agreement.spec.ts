import { test, expect } from '@playwright/test';
import { login } from './helpers';

// Agreement is Baileys-free: "Prepare agreement" advances the lead to Agreement and
// reveals the send tools (download the PDF to attach + open a WhatsApp deep link).
// NO document is transmitted via a socket — the rep sends it from their own app.
test.describe('pipeline — prepare agreement (Baileys-free)', () => {
  test('Prepare agreement advances to Agreement and shows the send tools, no socket send', async ({ page }) => {
    await login(page);
    await page.getByRole('banner').getByRole('button', { name: /Pipeline/ }).click();
    await expect(page.getByRole('heading', { name: 'Recruitment Pipeline' })).toBeVisible();

    await page.getByRole('button', { name: /^Attended/ }).click();
    const card = page.locator('div.rounded-xl', { hasText: 'Pat Agreement' });
    await expect(card).toBeVisible();

    await card.getByRole('button', { name: /Prepare agreement/ }).click();

    // Leaves the Attended tab (status -> agreement).
    await expect(page.locator('div.rounded-xl', { hasText: 'Pat Agreement' })).toHaveCount(0);

    // In the Agreement stage the send tools appear: download the PDF + open WhatsApp.
    await page.getByRole('button', { name: /^Agreement sent/ }).click();
    const agrCard = page.locator('div.rounded-xl', { hasText: 'Pat Agreement' });
    await expect(agrCard).toBeVisible();
    await expect(agrCard.getByRole('link', { name: /Download PDF/ })).toBeVisible();
    await expect(agrCard.getByRole('button', { name: /Open WhatsApp/ })).toBeVisible();

    // Baileys-free: NO document was transmitted via any socket.
    const sent: Array<{ jid: string; content: { document?: unknown } }> =
      await (await fetch('http://localhost:10001/__test/sent')).json();
    const patDocs = sent.filter((s) => s.jid?.includes('6512349999') && s.content?.document);
    expect(patDocs.length).toBe(0);
  });
});
