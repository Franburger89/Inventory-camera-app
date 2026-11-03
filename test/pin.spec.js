import { expect, test } from '@playwright/test';

test.use({ baseURL: 'http://127.0.0.1:4174' });

test('asks for the PIN when STAFF_PIN is set', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#view-login')).toBeVisible();
  await expect(page.locator('#view-start')).toBeHidden();

  await page.locator('#pin').fill('0000');
  await page.locator('#login-button').click();
  await expect(page.locator('#login-error')).toHaveText('That PIN is not recognised');

  await page.locator('#pin').fill('2468');
  await page.locator('#login-button').click();
  await expect(page.locator('#view-start')).toBeVisible();
  await expect(page.locator('#sign-out')).toBeVisible();
  await expect(page.locator('#view-login')).toBeHidden();
});
