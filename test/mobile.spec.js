import { expect, test } from '@playwright/test';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shots = path.join(root, '.tmp', 'screenshots');
const artifacts = process.env.ARTIFACT_DIR || '/opt/cursor/artifacts';

// A small PNG label. The phone resizes it to JPEG before upload.
const LABEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAIUlEQVQoU2NkYGD4z4AHMP7//5+hnoEEwDhgCWMgw3AgGg0AAK0pBAHa2/3pAAAAAElFTkSuQmCC',
  'base64',
);

async function shot(page, name) {
  await mkdir(shots, { recursive: true });
  await mkdir(artifacts, { recursive: true });
  const file = path.join(shots, `${name}.png`);
  await page.screenshot({ path: file });
  await copyFile(file, path.join(artifacts, `${name}.png`));
}

async function openApp(page) {
  await page.goto('/');
  await expect(page.locator('#view-login')).toBeHidden();
  await expect(page.locator('#view-start')).toBeVisible();
  await expect(page.locator('#sign-out')).toBeHidden();
}

async function chooseStockTake(page) {
  await expect(page.locator('#start-button')).toBeDisabled();
  await page.locator('[data-location="Via Borgonuovo"]').click();
  await page.locator('[data-person="Anna"]').click();
  await page.locator('#staff-name').fill('Giulia');
  await expect(page.locator('#start-button')).toBeEnabled();
}

test.beforeAll(async () => {
  await mkdir(path.join(root, '.tmp', 'fixtures'), { recursive: true });
  await writeFile(path.join(root, '.tmp', 'fixtures', 'label-a.png'), LABEL_PNG);
  await writeFile(path.join(root, '.tmp', 'fixtures', 'label-b.png'), LABEL_PNG);
});

test('photographs a stock take on a phone', async ({ page }) => {
  const labelA = path.join(root, '.tmp', 'fixtures', 'label-a.png');
  const labelB = path.join(root, '.tmp', 'fixtures', 'label-b.png');

  await openApp(page);
  await chooseStockTake(page);
  const startButton = await page.locator('#start-button').boundingBox();
  const viewport = page.viewportSize();
  expect(startButton.y).toBeGreaterThanOrEqual(0);
  expect(startButton.y + startButton.height).toBeLessThanOrEqual(viewport.height + 1);
  await shot(page, 'start_screen');

  await page.locator('#start-button').click();
  await expect(page.locator('#view-capture')).toBeVisible();
  await expect(page.locator('#capture-place')).toHaveText('Via Borgonuovo');
  await page.waitForFunction(() => {
    const shutter = document.querySelector('#shutter');
    const fallback = document.querySelector('#camera-fallback');
    return (shutter && !shutter.hidden) || (fallback && !fallback.hidden);
  });

  const cameraReady = await page.locator('#shutter').isVisible();
  if (cameraReady) {
    await page.locator('[data-quantity="3"]').click();
    await expect(page.locator('[data-quantity="3"]')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('#shutter').click();
    await expect(page.locator('#count')).toHaveText('1');
    await expect(page.locator('[data-quantity="1"]')).toHaveAttribute('aria-pressed', 'true');
  }

  const rollChooser = page.waitForEvent('filechooser');
  await page.locator('#roll-button').click();
  await (await rollChooser).setFiles([labelA, labelB]);
  const photos = cameraReady ? 3 : 2;
  const quantity = cameraReady ? 5 : 2;
  await expect(page.locator('#count')).toHaveText(String(photos));
  await shot(page, 'capture_screen');

  await page.locator('#finish-button').click();
  await expect(page.locator('#confirm')).toBeVisible();
  await page.locator('#confirm-finish').click();
  await expect(page.locator('#view-summary')).toBeVisible();
  await expect(page.locator('#summary-place')).toHaveText('Via Borgonuovo');
  await expect(page.locator('#summary-photos')).toHaveText(String(photos));
  await expect(page.locator('#summary-quantity')).toHaveText(String(quantity));
  await expect(page.locator('#uploaded')).toHaveText(String(photos));
  await shot(page, 'summary_screen');

  await page.reload();
  await expect(page.locator('#staff-name')).toHaveValue('Giulia');
});

test('falls back to the camera file input', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: () => Promise.reject(new Error('denied')) },
    });
  });
  const label = path.join(root, '.tmp', 'fixtures', 'label-a.png');
  await openApp(page);
  await chooseStockTake(page);
  await page.locator('#start-button').click();
  await expect(page.locator('#camera-fallback')).toBeVisible();
  await expect(page.locator('#shutter')).toBeHidden();

  await page.locator('[data-quantity="2"]').click();
  const chooser = page.waitForEvent('filechooser');
  await page.locator('#fallback-shutter').click();
  await (await chooser).setFiles(label);
  await expect(page.locator('#count')).toHaveText('1');
  await page.locator('#finish-button').click();
  await page.locator('#confirm-finish').click();
  await expect(page.locator('#summary-quantity')).toHaveText('2');
  await expect(page.locator('#uploaded')).toHaveText('1');
});

test('retries a photo after the connection drops', async ({ page }) => {
  let attempts = 0;
  await page.route('**/api/sessions/*/photos', async (route) => {
    attempts += 1;
    if (attempts < 3) {
      await route.abort('failed');
      return;
    }
    await route.continue();
  });
  const label = path.join(root, '.tmp', 'fixtures', 'label-a.png');
  await openApp(page);
  await page.locator('[data-location="Travel Pack"]').click();
  await page.locator('#staff-name').fill('Giulia');
  await page.locator('#start-button').click();
  await expect(page.locator('#view-capture')).toBeVisible();
  await page.locator('#roll-input').setInputFiles(label);
  await expect(page.locator('#count')).toHaveText('1');
  await expect(page.locator('#uploaded')).toHaveText('1', { timeout: 20_000 });
  expect(attempts).toBeGreaterThanOrEqual(3);
});
