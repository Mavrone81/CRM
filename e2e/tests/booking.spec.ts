import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// test-server.mjs writes valid HMAC booking tokens for fixture leads #10 / #11.
const __dirname = dirname(fileURLToPath(import.meta.url));
let tokens: { briefing: string; signed: string };

test.beforeAll(() => {
  tokens = JSON.parse(readFileSync(join(__dirname, '..', '.book-tokens.json'), 'utf8'));
});

test.describe('self-serve booking (public, no login)', () => {
  test('a briefing lead can pick an open slot and gets a confirmation', async ({ page }) => {
    await page.goto('/book/' + tokens.briefing);

    // Briefing page heading + at least one slot button.
    await expect(page.getByRole('heading', { name: /Pick your briefing session/i })).toBeVisible();
    const openSlot = page.getByRole('button', { name: /7:30pm/ });
    await expect(openSlot).toBeVisible();

    // The capacity-1 slot that another lead already booked shows as Full + disabled.
    const fullSlot = page.getByRole('button', { name: /Full/ });
    await expect(fullSlot).toBeVisible();
    await expect(fullSlot).toBeDisabled();

    // Pick the open slot -> ✅ confirmation.
    await openSlot.click();
    await expect(page.getByText("You're booked")).toBeVisible();
    await expect(page.getByText('✅')).toBeVisible();
  });

  test('a signed lead is offered onboarding slots', async ({ page }) => {
    await page.goto('/book/' + tokens.signed);
    await expect(page.getByRole('heading', { name: /Pick your onboarding session/i })).toBeVisible();
    // An onboarding slot is selectable (ob1 = 7pm).
    await expect(page.getByRole('button', { name: /7pm/ })).toBeVisible();
  });

  test('an invalid token shows an error', async ({ page }) => {
    await page.goto('/book/1.bogus');
    await expect(page.getByText(/invalid or has expired/i)).toBeVisible();
  });
});
