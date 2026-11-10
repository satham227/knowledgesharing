import { expect, test, type Browser, type Page } from '@playwright/test';

async function join(
  page: Page,
  room: string,
  name: string,
  mode: 'websocket' | 'webtransport',
): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Room ID').fill(room);
  await page.getByLabel('Your name').fill(name);
  if (mode === 'webtransport') await page.getByRole('button', { name: /WebTransport/ }).click();
  await page.getByRole('button', { name: 'Join room' }).click();
  await expect(page.getByText('Connected', { exact: true })).toBeVisible();
  await expect(page.locator('.object-count')).toContainText('state synced');
}

async function twoClientDrawing(
  browser: Browser,
  mode: 'websocket' | 'webtransport',
): Promise<void> {
  const room = `e2e-${mode}-${Date.now()}`;
  const firstContext = await browser.newContext();
  const secondContext = await browser.newContext();
  const first = await firstContext.newPage();
  const second = await secondContext.newPage();
  try {
    await join(first, room, 'Avery', mode);
    await join(second, room, 'Riley', mode);
    await expect(first.getByText('2 online')).toBeVisible();
    const canvas = first.locator('canvas');
    const bounds = await canvas.boundingBox();
    if (!bounds) throw new Error('Canvas is not visible');
    await first.mouse.move(bounds.x + bounds.width * 0.22, bounds.y + bounds.height * 0.3);
    await first.mouse.down();
    await first.mouse.move(bounds.x + bounds.width * 0.48, bounds.y + bounds.height * 0.55, {
      steps: 10,
    });
    await first.mouse.up();
    await expect(second.locator('.object-count')).toContainText('1 objects');
    await second.reload();
    await join(second, room, 'Riley', mode);
    await expect(second.locator('.object-count')).toContainText('1 objects');
  } finally {
    await firstContext.close();
    await secondContext.close();
  }
}

test('WebSocket clients synchronize drawing and reconnect snapshots', async ({ browser }) => {
  await twoClientDrawing(browser, 'websocket');
});

test('WebTransport clients synchronize drawing and reconnect snapshots', async ({ browser }) => {
  test.skip(
    process.env['WT_E2E'] !== '1',
    'Set WT_E2E=1 with trusted HTTPS and HTTP/3 certificates to run this scenario.',
  );
  await twoClientDrawing(browser, 'webtransport');
});
