import { test, expect } from '@playwright/test';

const randomEmail = () => `vh-e2e-${Date.now()}-${Math.random().toString(16).slice(2)}@example.test`;

const SIGNUP_PASSWORD = 'Secret123!';
const DISPLAY_NAME = 'Playwright User';

test.describe('Authentication flow', () => {
  test('allows a visitor to sign up and log in', async ({ page }) => {
    const email = randomEmail();

    await page.goto('/');
    await expect(page.getByRole('heading', { name: /hear your heart/i })).toBeVisible();

    await page.getByRole('link', { name: /login/i }).click();
    await expect(page).toHaveURL(/\/auth/);

    await page.getByRole('button', { name: /^sign up$/i }).first().click();

    await page.getByPlaceholder(/email/i).fill(email);
    await page.getByPlaceholder(/password/i).fill(SIGNUP_PASSWORD);
    await page.getByPlaceholder(/display name/i).fill(DISPLAY_NAME);

    await page.getByRole('button', { name: /create account/i }).click();

    await expect(page).toHaveURL(/\/onboarding/);
    await expect(page.getByText(/verify email/i)).toBeVisible();

    await page.evaluate(() => {
      localStorage.removeItem('vh_token');
      try { window.__vh_user = null; } catch {}
    });
    await page.goto('/auth');

    await page.getByPlaceholder(/email/i).fill(email);
    await page.getByPlaceholder(/password/i).fill(SIGNUP_PASSWORD);
    await page.locator('form').getByRole('button', { name: /^login$/i }).click();

    await expect(page).toHaveURL(/\/($|\?)/);
    await expect(page.getByRole('link', { name: /login/i })).toHaveCount(0);
    const token = await page.evaluate(() => localStorage.getItem('vh_token'));
    expect(token).toBeTruthy();
  });
});
