// Screenshots of key pages in every theme at desktop and phone sizes.
// usage: node shoot.mjs <baseUrl> <outDir>
import { chromium } from '@playwright/test';
const [base = 'http://localhost:3000', out = '/tmp/brand-shots'] = process.argv.slice(2);
const themes = ['light', 'dark'];
const pages = [
  ['dashboard', '/dashboard'],
  ['invoices', '/invoices'],
  ['journal', '/journal'],
  ['invoice-new', '/invoices/new'],
  ['settings-payments', '/settings/payments'],
];
const sizes = { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } };
const browser = await chromium.launch();
for (const [sizeName, viewport] of Object.entries(sizes)) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const login = await page.request.post(`${base}/api/dev-auth`, { data: { userId: 'user_dev_owner', orgId: 'org_dev_alpha', orgRole: 'org:admin' } });
  if (!login.ok()) throw new Error(`dev login failed ${login.status()}`);
  for (const theme of themes) {
    await page.goto(`${base}/api/theme?set=${theme}&next=/dashboard`, { waitUntil: 'networkidle' });
    for (const [name, path] of pages) {
      await page.goto(`${base}${path}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${out}/${theme}-${sizeName}-${name}.png`, fullPage: sizeName === 'phone' });
    }
    if (sizeName === 'phone') {
      await page.goto(`${base}/dashboard`, { waitUntil: 'networkidle' });
      await page.getByRole('button', { name: 'Open menu' }).click();
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${out}/${theme}-phone-menu.png` });
    }
  }
  await ctx.close();
}
await browser.close();
console.log('done');
