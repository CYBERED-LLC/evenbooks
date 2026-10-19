import { expect, type Locator, type Page } from '@playwright/test';

export const ORGS = {
  alpha: { orgId: 'org_dev_alpha', name: 'Alpha Consulting LLC' },
  beta: { orgId: 'org_dev_beta', name: 'Beta Design Studio' },
};

/** Sign in through the dev auth adapter (AUTH_MODE=dev) as a given user/org/role. */
export async function devLogin(page: Page, opts: { userId?: string; orgId?: string; orgRole?: 'org:admin' | 'org:member' } = {}) {
  const res = await page.request.post('/api/dev-auth', {
    data: { userId: opts.userId ?? 'user_dev_owner', orgId: opts.orgId ?? ORGS.alpha.orgId, orgRole: opts.orgRole ?? 'org:admin' },
  });
  expect(res.ok()).toBeTruthy();
}

export async function switchOrg(page: Page, orgId: string) {
  const res = await page.request.post('/api/dev-auth', { data: { orgId } });
  expect(res.ok()).toBeTruthy();
}

export function unique(prefix: string): string {
  return `${prefix} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export async function apiGet<T>(page: Page, path: string): Promise<T> {
  const session = await page.request.get('/api/session');
  const { company } = (await session.json()) as { company: { id: string } };
  const res = await page.request.get(path, { headers: { 'x-company-id': company.id } });
  expect(res.ok(), `${path} -> ${res.status()}`).toBeTruthy();
  return (await res.json()) as T;
}

export async function apiPost<T>(page: Page, path: string, body: unknown, method: 'POST' | 'PATCH' = 'POST'): Promise<T> {
  const session = await page.request.get('/api/session');
  const { company } = (await session.json()) as { company: { id: string } };
  const res = await page.request.fetch(path, { method, data: body, headers: { 'x-company-id': company.id } });
  expect(res.ok(), `${method} ${path} -> ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()) as T;
}

/** Navigate and wait until the client has hydrated (dev-mode compiles can be slow). */
export async function gotoReady(page: Page, url: string) {
  await page.goto(url);
  await page.waitForLoadState('networkidle');
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Pick from a searchable combobox (AccountPicker, ContactPicker, ItemPicker…):
 * type `search`, then click the option whose text starts with `option` (default: `search`).
 * Use the full label ("5140 Meals") so the match is unambiguous.
 */
export async function pickOption(field: Locator, search: string, option?: string | RegExp) {
  await field.click();
  await field.fill(search);
  const name = option instanceof RegExp ? option : new RegExp(`^${escapeRegExp(option ?? search)}`);
  const choice = field.page().getByRole('option', { name }).first();
  await choice.click();
  await expect(field).toHaveAttribute('aria-expanded', 'false');
}

/**
 * Open the page's "More actions" menu and return one of its items. Secondary and
 * destructive record actions (Void…, Delete…, Duplicate…) live in this menu.
 */
export async function menuItem(page: Page, name: string | RegExp): Promise<Locator> {
  const trigger = page.getByRole('button', { name: 'More actions' });
  if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click();
  return page.getByRole('menu').getByRole('menuitem', { name });
}
