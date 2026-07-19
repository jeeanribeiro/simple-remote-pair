// Captures the screenshots used in the README and the landing page.
// Usage: node scripts/screenshots.mjs (dev server with SRP_INJECTOR=fake must
// be running on :5173 — `npx vite --port 5173` — or pass a base URL argv[2]).
//
// getDisplayMedia is stubbed with a canvas-drawn fake desktop so captures are
// deterministic and never leak the real screen.
import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';

const base = process.argv[2] ?? 'http://localhost:5173';
const outDir = new URL('../docs/assets/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
mkdirSync(outDir, { recursive: true });

const fakeDisplay = () => {
  const canvas = document.createElement('canvas');
  canvas.width = 1920;
  canvas.height = 1080;
  const ctx = canvas.getContext('2d');
  const lines = [
    ['#7dd8ff', 260],
    ['#34d0b6', 420],
    ['#e8ecf4', 380],
    ['#9aa5bb', 520],
    ['#34d0b6', 300],
    ['#e8ecf4', 460],
    ['#f4b26a', 340],
    ['#9aa5bb', 500],
    ['#7dd8ff', 280],
    ['#e8ecf4', 440],
    ['#34d0b6', 360],
    ['#9aa5bb', 480],
    ['#e8ecf4', 320],
    ['#f4b26a', 400],
    ['#7dd8ff', 300],
    ['#9aa5bb', 540],
  ];
  let tick = 0;
  const draw = () => {
    tick++;
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, 1920, 1080);
    // editor window
    ctx.fillStyle = '#161d2b';
    ctx.beginPath();
    ctx.roundRect(160, 90, 1600, 900, 16);
    ctx.fill();
    // traffic lights
    for (const [i, c] of ['#f47174', '#f4b26a', '#34d0b6'].entries()) {
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.arc(200 + i * 34, 130, 9, 0, Math.PI * 2);
      ctx.fill();
    }
    // sidebar
    ctx.fillStyle = '#121722';
    ctx.fillRect(160, 170, 300, 820);
    for (let i = 0; i < 12; i++) {
      ctx.fillStyle = i === 3 ? '#34d0b6' : '#2a3550';
      ctx.beginPath();
      ctx.roundRect(200, 210 + i * 56, 220 - (i % 3) * 40, 16, 8);
      ctx.fill();
    }
    // code lines
    lines.forEach(([color, width], i) => {
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      ctx.roundRect(520 + (i % 4 === 0 ? 0 : 60), 220 + i * 46, width, 16, 8);
      ctx.fill();
      ctx.globalAlpha = 1;
    });
    // blinking cursor keeps frames flowing
    if (Math.floor(tick / 30) % 2 === 0) {
      ctx.fillStyle = '#e8ecf4';
      ctx.fillRect(520 + 340, 220 + 15 * 46, 3, 22);
    }
    requestAnimationFrame(draw);
  };
  draw();
  return canvas.captureStream(30);
};

const stub = `navigator.mediaDevices.getDisplayMedia = async () => (${fakeDisplay.toString()})();`;

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  colorScheme: 'dark',
});
await context.addInitScript(stub);

const page = await context.newPage();

// Home
await page.goto(`${base}/#/`);
await page.waitForSelector('.home-cards');
await page.screenshot({ path: `${outDir}home.png` });

// Host view, sharing, with one guest connected
await page.goto(`${base}/#/host`);
await page.waitForFunction(() =>
  /^[A-Z2-9]{6}$/.test(document.querySelector('.session-code')?.textContent ?? ''),
);
const code = await page.locator('.session-code').textContent();
await page.getByRole('button', { name: 'Start sharing screen' }).click();
await page.waitForSelector('.preview.visible');

const guestPage = await context.newPage();
await guestPage.goto(`${base}/#/join/${code}`);
await guestPage.waitForFunction(
  () => (document.querySelector('video')?.videoWidth ?? 0) > 0,
  undefined,
  { timeout: 20000 },
);
await guestPage.waitForTimeout(2500); // let the stats badge populate

await page.bringToFront();
await page.waitForTimeout(400);
await page.screenshot({ path: `${outDir}host.png` });
await guestPage.bringToFront();
await guestPage.screenshot({ path: `${outDir}guest.png` });

await browser.close();
console.log(`saved home.png, host.png, guest.png to ${outDir}`);
