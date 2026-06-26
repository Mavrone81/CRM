import { test, expect } from '@playwright/test';
import { login, CREDS } from './helpers';

test.describe('authentication', () => {
  test('wrong credentials are rejected and stay on the login page', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Username').fill('testadmin');
    await page.getByLabel('Password').fill('definitely-wrong');
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page.getByText('Invalid username or password')).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
    // The dashboard must NOT have rendered.
    await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
  });

  test('an unauthenticated visit to / redirects to /login', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('correct credentials land on the dashboard', async ({ page }) => {
    await login(page, CREDS.user, CREDS.pass);
    // Header + the default Directory view chrome are present.
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Directory/ })).toBeVisible();
    await expect(page.getByPlaceholder('Search name, phone, email…')).toBeVisible();
  });
});
