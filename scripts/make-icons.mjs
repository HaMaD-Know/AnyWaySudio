// Renders public/logo.svg into PNG app icons + a splash screen using the bundled Chromium.
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import { readFileSync, mkdirSync } from 'node:fs';

const svg = readFileSync(new URL('../public/logo.svg', import.meta.url), 'utf8');
const dataUrl = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
mkdirSync('assets', { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage();
async function render(size, out, splash = false) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(splash
    ? `<body style="margin:0;background:#14161f;display:grid;place-items:center;height:100vh"><img src="${dataUrl}" style="width:${Math.round(size * 0.22)}px;border-radius:${Math.round(size * 0.05)}px"></body>`
    : `<body style="margin:0"><img src="${dataUrl}" style="width:${size}px;height:${size}px;display:block"></body>`);
  await page.waitForTimeout(50);
  await page.screenshot({ path: out, omitBackground: false });
  console.log('wrote', out);
}
await render(1024, 'assets/AppIcon-1024.png');
await render(512, 'public/icon-512.png');
await render(192, 'public/icon-192.png');
await render(180, 'public/icon-180.png');
await render(2732, 'assets/splash-2732.png', true);
await browser.close();
