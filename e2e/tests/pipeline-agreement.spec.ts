import { test, expect } from '@playwright/test';
import { login } from './helpers';

// Regression for the "no attachment sent" bug: the Pipeline "Send agreement"
// action must send the agreement PDF (a document message), not just text, and
// advance the lead to Agreement.
test.describe('pipeline — send agreement (PDF)', () => {
  test('Send agreement sends the PDF document and advances to Agreement', async ({ page }) => {
    await login(page);
    await page.getByRole('banner').getByRole('button', { name: /Pipeline/ }).click();
    await expect(page.getByRole('heading', { name: 'Recruitment Pipeline' })).toBeVisible();

    await page.getByRole('button', { name: /^Attended/ }).click();
    const card = page.locator('div.rounded-xl', { hasText: 'Pat Agreement' });
    await expect(card).toBeVisible();

    await card.getByRole('button', { name: '📎 Send agreement' }).click();

    // Leaves the Attended tab (status -> agreement).
    await expect(page.locator('div.rounded-xl', { hasText: 'Pat Agreement' })).toHaveCount(0);

    // A real DOCUMENT (the PDF) was sent to Pat's number — not just text.
    const sent: Array<{ jid: string; content: { document?: unknown; text?: string } }> =
      await (await fetch('http://localhost:10001/__test/sent')).json();
    const patDocs = sent.filter((s) => s.jid?.includes('6512349999') && s.content?.document);
    expect(patDocs.length).toBeGreaterThan(0);
  });
});
