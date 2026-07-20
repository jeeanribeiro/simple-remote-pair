import { type BrowserContext, expect, type Page, test } from '@playwright/test';

interface RecordedInjection {
  type: 'move' | 'button' | 'scroll' | 'key' | 'text';
  args: (string | number | boolean)[];
}

/**
 * Stub getDisplayMedia with a canvas-drawn stream. Headless CI can't do real
 * screen capture, and this keeps the test off the real desktop everywhere.
 */
const GET_DISPLAY_MEDIA_STUB = () => {
  navigator.mediaDevices.getDisplayMedia = async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 1280;
    canvas.height = 720;
    const ctx = canvas.getContext('2d');
    let tick = 0;
    const draw = () => {
      tick++;
      if (ctx) {
        ctx.fillStyle = '#0d1117';
        ctx.fillRect(0, 0, 1280, 720);
        ctx.fillStyle = '#34d0b6';
        ctx.fillRect((tick * 7) % 1200, 340, 60, 40);
      }
      requestAnimationFrame(draw);
    };
    draw();
    return (canvas as HTMLCanvasElement & { captureStream(fps: number): MediaStream }).captureStream(
      30,
    );
  };
};

async function readInjections(page: Page): Promise<RecordedInjection[]> {
  const body = await page.evaluate(async () => {
    const res = await fetch('/__test/injections');
    return (await res.json()) as { events: RecordedInjection[] };
  });
  return body.events;
}

async function clearInjections(page: Page): Promise<void> {
  await page.evaluate(() => fetch('/__test/injections', { method: 'DELETE' }));
}

async function startHosting(context: BrowserContext): Promise<{ page: Page; code: string }> {
  await context.addInitScript(GET_DISPLAY_MEDIA_STUB);
  const page = await context.newPage();
  await page.goto('/#/host');
  const codeEl = page.locator('.session-code');
  await expect(codeEl).toHaveText(/^[A-Z2-9]{6}$/);
  const code = (await codeEl.textContent()) ?? '';
  await page.getByRole('button', { name: 'Start sharing screen' }).click();
  await expect(page.getByText('Sharing your screen with all guests.')).toBeVisible();
  return { page, code };
}

async function joinAsGuest(context: BrowserContext, code: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`/#/join/${code}`);
  // Wait until real frames arrive over WebRTC.
  await expect
    .poll(() => page.evaluate(() => document.querySelector('video')?.videoWidth ?? 0), {
      timeout: 20_000,
    })
    .toBeGreaterThan(0);
  return page;
}

test('host streams the screen and a guest drives mouse and keyboard', async ({ browser }) => {
  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  const { page: hostPage, code } = await startHosting(hostContext);
  const guestPage = await joinAsGuest(guestContext, code);

  await expect(hostPage.locator('.guest-row')).toHaveCount(1);
  await expect(guestPage.locator('.pill').first()).toHaveText('Live');
  await clearInjections(guestPage);

  // Take control and interact.
  const stage = guestPage.locator('.stage');
  await stage.click();
  await expect(guestPage.getByText('Controlling — Esc ×2 to release')).toBeVisible();
  const box = await stage.boundingBox();
  if (!box) throw new Error('stage has no bounding box');
  await guestPage.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
  await guestPage.mouse.down();
  await guestPage.mouse.up();
  await guestPage.keyboard.press('a');

  await expect
    .poll(async () => {
      const events = await readInjections(guestPage);
      return {
        buttons: events.filter((e) => e.type === 'button').length,
        keys: events.filter((e) => e.type === 'key').length,
        moves: events.filter((e) => e.type === 'move').length,
      };
    })
    .toEqual(
      expect.objectContaining({
        buttons: 2, // down + up
        keys: 2, // a down + a up
      }),
    );
  const events = await readInjections(guestPage);
  expect(events.some((e) => e.type === 'move')).toBe(true);

  // Double-Esc releases control.
  await guestPage.keyboard.press('Escape');
  await guestPage.keyboard.press('Escape');
  await expect(guestPage.getByText('Click the screen to take control')).toBeVisible();

  await hostContext.close();
  await guestContext.close();
});

test('pausing control blocks injection until resumed', async ({ browser }) => {
  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  const { page: hostPage, code } = await startHosting(hostContext);
  const guestPage = await joinAsGuest(guestContext, code);

  await hostPage.getByLabel('Pause all control').check();
  await expect(guestPage.locator('.pill').first()).toHaveText('Control paused by host');

  await clearInjections(guestPage);
  const stage = guestPage.locator('.stage');
  const box = await stage.boundingBox();
  if (!box) throw new Error('stage has no bounding box');
  await guestPage.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 3 });
  await guestPage.waitForTimeout(300);
  expect(await readInjections(guestPage)).toEqual([]);

  await hostPage.getByLabel('Pause all control').uncheck();
  await expect(guestPage.locator('.pill').first()).toHaveText('Live');

  await hostContext.close();
  await guestContext.close();
});

test('kicked guests see the removal screen', async ({ browser }) => {
  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  const { page: hostPage, code } = await startHosting(hostContext);
  const guestPage = await joinAsGuest(guestContext, code);

  await hostPage.getByRole('button', { name: /Remove Guest 1/ }).click();
  await expect(guestPage.locator('.stage-end')).toContainText(
    'The host removed you from the session.',
  );
  await expect(hostPage.locator('.guest-row')).toHaveCount(0);

  await hostContext.close();
  await guestContext.close();
});

test('joining a non-existent session shows a clear error', async ({ page }) => {
  await page.goto('/#/join/ABC234');
  await expect(page.locator('.stage-end')).toContainText(
    'No session with that code. Check it and try again.',
  );
});

test('home validates codes before enabling join', async ({ page }) => {
  await page.goto('/');
  const join = page.getByRole('button', { name: 'Join session' });
  await expect(join).toBeDisabled();
  await page.getByLabel('Session code').fill('abc234');
  await expect(page.getByLabel('Session code')).toHaveValue('ABC234');
  await expect(join).toBeEnabled();
});
