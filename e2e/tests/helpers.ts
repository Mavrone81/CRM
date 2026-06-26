import { Page, expect } from '@playwright/test';

export const CREDS = { user: 'testadmin', pass: 'testpass' };

// Log in through the real login form and wait for the dashboard to render.
export async function login(page: Page, user = CREDS.user, pass = CREDS.pass) {
  await page.goto('/login');
  await page.getByLabel('Username').fill(user);
  await page.getByLabel('Password').fill(pass);
  await page.getByRole('button', { name: 'Sign in' }).click();
  // Dashboard header shows a "Sign out" button once authenticated.
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}
