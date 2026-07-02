import { test, expect } from '@playwright/test';

// E-sign portal: the lead opens their tokened /sign page (public — no login), fills
// the required fields, draws a signature, submits → status advances to `signed` and
// an encrypted signature-certificate PDF is stored. Replaces PDF-over-chat.
test.describe('e-sign portal', () => {
  test('a lead signs the agreement online and advances to signed', async ({ page }) => {
    // The sign link comes from the (server-side) helper endpoint — HMAC token.
    const { url } = await (await fetch('http://localhost:10001/api/leads/90/sign-link')).json();
    const token = url.split('/sign/')[1];

    await page.goto(`/sign/${token}`); // public: no login needed
    await expect(page.getByRole('heading', { name: 'Associate Agreement' })).toBeVisible();
    await expect(page.getByText(/Hi Esign Erin/)).toBeVisible();

    // Required text fields from config (the signature field is the canvas).
    await page.getByLabel('Full name (as in NRIC)').fill('Erin Tan');
    await page.getByLabel('NRIC number').fill('S9876543Z');
    await page.getByLabel('Mobile number').fill('91239090');

    // Draw a signature stroke on the canvas.
    const canvas = page.getByLabel(/Signature area/);
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + 30, box.y + 60);
    await page.mouse.down();
    await page.mouse.move(box.x + 120, box.y + 40, { steps: 8 });
    await page.mouse.move(box.x + 200, box.y + 80, { steps: 8 });
    await page.mouse.up();

    await page.getByRole('checkbox').check();
    const submit = page.getByRole('button', { name: 'Sign agreement' });
    await expect(submit).toBeEnabled();
    await submit.click();

    await expect(page.getByText('Agreement signed!')).toBeVisible();

    // Server side: the lead is now `signed` with a complete e-sign record.
    const lead = (await (await fetch('http://localhost:10001/api/leads')).json()).find((l: { id: number }) => l.id === 90);
    expect(lead.status).toBe('signed');
    expect(lead.wf.signed.result.complete).toBe(true);
    expect(lead.wf.signed.result.method).toBe('esign');
  });

  test('an invalid token shows an error, not the form', async ({ page }) => {
    await page.goto('/sign/90.forged-token');
    await expect(page.getByText(/invalid or has expired/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign agreement' })).toHaveCount(0);
  });
});
