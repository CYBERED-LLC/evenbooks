import { test, expect } from '@playwright/test';

/**
 * Public pages: render without a session, in both themes, without horizontal
 * overflow on a phone. Content assertions stay loose on purpose: copy changes.
 */
const pages = ['/', '/pricing', '/how-we-make-money', '/source-available', '/legal/terms', '/legal/privacy'];

test.describe('Marketing pages', () => {
  for (const path of pages) {
    test(`${path} renders signed out`, async ({ page, context }) => {
      await context.clearCookies();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const res = await page.goto(path);
      expect(res?.ok()).toBeTruthy();
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Start for free' }).first()).toBeVisible();
      expect(errors).toEqual([]);
    });
  }

  test('theme link sets the mode cookie and the page follows it', async ({ page, context }) => {
    await context.clearCookies();
    await page.goto('/api/theme?set=dark&next=/pricing');
    await expect(page).toHaveURL(/\/pricing$/);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.goto('/api/theme?set=system&next=/pricing');
    await expect(page.locator('html')).toHaveAttribute('data-mode', 'system');
  });

  test('homepage demo posts balanced entries and plays the month', async ({ page, context }) => {
    await context.clearCookies();
    await page.goto('/');
    const approve = page.getByRole('button', { name: 'Approve' });
    await expect(approve).toHaveCount(5);
    while ((await approve.count()) > 0) await approve.first().click();
    await expect(page.getByText('All caught up. Every entry balanced.')).toBeVisible();
    await expect(page.getByRole('img', { name: /^Balanced: debits \$3,529\.50 equal credits \$3,529\.50/ }).first()).toBeAttached();

    await page.getByRole('button', { name: /The payout matches/ }).click();
    await expect(page.getByRole('button', { name: /The payout matches/ })).toHaveAttribute('aria-current', 'step');

    // The demo is set in the current month; scrub to its last day.
    const day = page.getByLabel(/^Day of /);
    await day.fill((await day.getAttribute('max'))!);
    await expect(page.getByText(/^Every transaction ticked off against the bank statement\. \w+ is closed\.$/)).toBeVisible();
  });

  test('pricing fits a phone without horizontal scrolling', async ({ page, context }) => {
    await context.clearCookies();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/pricing');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    expect(overflow).toBe(false);
    await page.getByLabel('Invoice amount').fill('250');
    await expect(page.getByText('$12.50', { exact: false }).first()).toBeVisible(); // 5% of 250, free plan card total
  });
});
