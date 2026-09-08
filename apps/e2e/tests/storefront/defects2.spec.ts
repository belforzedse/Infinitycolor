import { test, expect } from '@playwright/test';
import { prepareStorefrontPage } from '../../helpers/page';
import { E2E_PRODUCT_SLUG } from '../../fixtures/storefront';
const authOrigin = process.env.E2E_AUTH_ORIGIN || 'http://localhost:2889';
async function signIn(page: import('@playwright/test').Page) {
  const response = await page.request.post(`${authOrigin}/api/auth/infinity/password/sign-in`, {
    headers: { Origin: new URL(process.env.E2E_BASE_URL || 'http://localhost:2888').origin },
    data: { phone: '+989000000101', password: 'E2eCustomer!123' },
  });
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  expect(body.redirectTo).toContain('/auth/callback');
  // WebKit rejects Secure route-hint cookies on plain HTTP localhost.
  // Seed the same non-authoritative hint as global-setup; real session/JWT checks remain active.
  if (test.info().project.name.startsWith('webkit') && new URL(body.redirectTo).protocol === 'http:') {
    await page.context().addCookies([{ name: 'infinity_route_hint', value: '1', domain: 'localhost', path: '/', httpOnly: true, secure: false, sameSite: 'Lax' }]);
  }
  await page.goto(body.redirectTo);
  await expect(page).not.toHaveURL(/callback|\/auth/, { timeout: 15000 });
  await expect(page.getByText('حساب من', { exact: true }).first()).toBeAttached();
}

test('widget preserves fields through close and retry, and honors reduced motion', async ({ page }) => {
  await prepareStorefrontPage(page);
  const payloads: any[] = [];
  const interceptRetry = true;
  await page.route('**/*', async route => {
    if (!interceptRetry || !route.request().url().includes('/issue-reports') || route.request().method() !== 'POST') return route.fallback();
    payloads.push(route.request().postDataJSON());
    await new Promise(resolve => setTimeout(resolve, 300));
    await route.fulfill({ status: payloads.length === 1 ? 503 : 200, contentType: 'application/json', body: JSON.stringify(payloads.length === 1 ? { error: { message: 'Unavailable' } } : { data: { id: 1 } }) });
  });
  await page.goto('/about');
  const trigger = page.getByRole('button', { name: 'گزارش مشکل', exact: true });
  await trigger.click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('شماره تماس').fill('09000000101');
  await dialog.getByLabel('عنوان', { exact: true }).fill('آزمایش نمایش');
  await dialog.getByLabel('توضیحات', { exact: true }).fill('آزمایش رفت و برگشت فرم');
  await dialog.getByRole('button', { name: 'بستن', exact: true }).first().click();
  await expect(dialog).toHaveCount(0);
  await trigger.click();
  await expect(dialog.getByLabel('عنوان', { exact: true })).toHaveValue('آزمایش نمایش');
  await dialog.getByRole('button', { name: 'ارسال گزارش' }).click();
  await expect(dialog.getByRole('button', { name: 'در حال ارسال...' })).toBeDisabled();
  if (interceptRetry) {
    await expect(dialog.getByRole('alert')).toBeVisible();
    await dialog.getByRole('button', { name: 'ارسال گزارش' }).click();
  }
  await expect(dialog.getByRole('status')).toContainText('گزارش شما ثبت شد');
  if (interceptRetry) expect(payloads[0].data?.submissionId ?? payloads[0].submissionId).toBe(payloads[1].data?.submissionId ?? payloads[1].submissionId);
  await dialog.getByRole('button', { name: 'بستن', exact: true }).first().click();
  await expect(dialog).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await trigger.click();
  await expect.poll(() => dialog.locator('[class*="panel"]').evaluate(el => getComputedStyle(el).transitionDuration)).toBe('0s');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('category overlay covers floating controls and releases them', async ({ page }) => {
  test.skip((test.info().project.use.viewport?.width || 1440) >= 1024);
  await prepareStorefrontPage(page);
  await page.goto('/about');
  await page.getByRole('link', { name: 'دسته بندی ها', exact: true }).click();
  await expect(page.getByRole('button', { name: 'گزارش مشکل', exact: true })).toBeHidden();
  await page.getByRole('button', { name: 'Close categories' }).click();
  await expect(page.getByRole('button', { name: 'گزارش مشکل', exact: true })).toBeVisible();
});

test('desktop search dismisses after submit and Escape', async ({ page }) => {
  test.skip((test.info().project.use.viewport?.width || 1440) < 1024);
  await prepareStorefrontPage(page);
  await page.goto('/about');
  const input = page.getByPlaceholder('دنبال چی میگردی؟');
  await input.fill('E2E');
  await expect(page.getByRole('listbox', { name: 'پیشنهادهای جستجو' })).toBeVisible();
  await input.press('Enter');
  await expect(page).toHaveURL(/search=E2E/);
  await expect(page.getByRole('listbox', { name: 'پیشنهادهای جستجو' })).toHaveCount(0);
  await input.fill('other');
  await input.press('Escape');
  await expect(page.getByRole('listbox', { name: 'پیشنهادهای جستجو' })).toHaveCount(0);
});

test('session survives refresh and account navigation; password uses central recovery', async ({ page }) => {
  await prepareStorefrontPage(page);
  await signIn(page);
  await page.goto('/orders');
  await page.reload();
  await expect(page).toHaveURL(/\/orders/);
  if ((test.info().project.use.viewport?.width || 1440) < 1024) {
    await page.getByRole('button', { name: 'Open menu' }).click();
    await page.getByRole('dialog').locator('a[href="/orders"]').click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
  await page.goto('/password');
  await expect(page).toHaveURL(new RegExp(`${authOrigin}/auth/forgot-password`));
  expect(new URL(page.url()).searchParams.get('returnTo')).toBe('http://localhost:2888/account');
});

test('PDP renders matching variant controls without runtime errors', async ({ page }) => {
  const runtime = await prepareStorefrontPage(page);
  await page.goto(`/pdp/${E2E_PRODUCT_SLUG}`);
  await expect(page.locator('[data-testid="pdp-product-title"]:visible').first()).toBeVisible();
  await expect(page.getByText('دیدگاه و امتیاز خریداران', { exact: true })).toBeAttached();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  // WebKit reports the production report-only CSP against this HTTP fixture.
  const localCsp = /Content Security Policy directive 'frame-ancestors'|\[Report Only\] Refused to connect to http:\/\/127\.0\.0\.1:1337/;
  runtime.errors.splice(0, runtime.errors.length, ...runtime.errors.filter(error => !localCsp.test(error)));
  runtime.assertClean();
});

test('comment submission succeeds with the real flat response and remains pending', async ({ page }) => {
  await prepareStorefrontPage(page);
  await signIn(page);
  await page.goto(`/pdp/${E2E_PRODUCT_SLUG}`);
  const addComment = page.getByRole('button', { name: 'افزودن نظر', exact: true });
  await addComment.scrollIntoViewIfNeeded();
  await addComment.click();
  const dialog = page.getByRole('dialog');
  await dialog.getByPlaceholder('نظر شما').fill('این دیدگاه برای آزمایش ثبت و نمایش نوشته شده است.');
  await dialog.getByRole('button', { name: '5 ستاره' }).click();
  const submitted = page.waitForResponse(response => response.url().includes('/product-reviews/submit') && response.request().method() === 'POST');
  await dialog.getByRole('button', { name: 'ثبت نظر', exact: true }).click();
  const response = await submitted;
  expect(response.ok()).toBeTruthy();
  expect((await response.json()).Status).toBe('Need for Review');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('دیدگاه شما با موفقیت ثبت شد و پس از تأیید نمایش داده خواهد شد', { exact: true })).toBeVisible();
  await expect(page.locator('[data-comments-section]').getByText('این دیدگاه برای آزمایش ثبت و نمایش نوشته شده است.', { exact: true })).toHaveCount(0);
});

for (const surface of ['storefront', 'social']) {
  test(`${surface} story close accepts touch/mouse and Escape and restores focus`, async ({ page }) => {
    await prepareStorefrontPage(page);
    await page.goto(surface === 'social' ? 'http://localhost:2890/' : '/', { waitUntil: 'load' });
    await page.waitForFunction(() => document.querySelector('button[aria-label^="نمایش استوری"]') && Object.keys(document.querySelector('button[aria-label^="نمایش استوری"]')!).some(key => key.startsWith('__reactProps')));
    const trigger = page.getByRole('button', { name: /نمایش استوری E2E story/ }).first();
    await trigger.click();
    const close = page.getByRole('button', { name: 'Close story viewer' });
    await expect(close).toBeVisible();
    if (test.info().project.use.hasTouch) await close.tap(); else await close.click();
    await expect(close).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await trigger.click();
    await expect(close).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(close).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });
}

test('footer Cart navigation starts at top and Back restores the prior page', async ({ page }) => {
  await prepareStorefrontPage(page);
  await page.goto('/about');
  const link = page.locator('footer a[href="/cart"]:visible').first();
  await link.scrollIntoViewIfNeeded();
  const previous = await page.evaluate(() => scrollY);
  expect(previous).toBeGreaterThan(100);
  await link.click();
  await expect(page).toHaveURL(/\/cart$/);
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
  await page.goBack({ waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/\/about$/);
  await expect.poll(async () => Math.abs((await page.evaluate(() => scrollY)) - previous)).toBeLessThan(40);
});

test('address editor keeps postal numbers LTR inside its bounded mobile form', async ({ page }) => {
  test.skip(test.info().project.name !== 'chromium-390');
  await prepareStorefrontPage(page);
  await signIn(page);
  await page.goto('/addresses');
  await page.getByRole('button', { name: /ویرایش/ }).first().click();
  const dialog = page.getByRole('dialog');
  const postal = dialog.getByPlaceholder('کد پستی ۱۰ رقمی');
  await expect(postal).toHaveValue('1234567890');
  await expect(postal).toHaveAttribute('dir', 'ltr');
  const box = await dialog.boundingBox();
  expect(box?.width).toBeLessThanOrEqual(test.info().project.use.viewport!.width);
  await postal.fill('1234567891');
  await dialog.getByRole('button', { name: 'ثبت تغییرات', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', { name: /ویرایش/ }).first().click();
  await expect(postal).toHaveValue('1234567891');
  await postal.fill('1234567890');
  await dialog.getByRole('button', { name: 'ثبت تغییرات', exact: true }).click();
});

test('minimal quality preserves product geometry, controls and cart behavior', async ({ page }) => {
  test.skip(!['chromium-390', 'chromium-1440'].includes(test.info().project.name));
  await prepareStorefrontPage(page);
  await page.goto(`/pdp/${E2E_PRODUCT_SLUG}`);
  const action = page.getByTestId('pdp-cart-action');
  await action.scrollIntoViewIfNeeded();
  await expect(action).toHaveAttribute('data-cart-ready', 'true');
  const hero = page.getByTestId('pdp-hero');
  const before = { text: await hero.innerText(), box: await hero.boundingBox() };
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('infinity:adaptive-quality:v2'))).not.toBeNull();
  await page.evaluate(() => {
    const key = 'infinity:adaptive-quality:v2';
    const current = JSON.parse(sessionStorage.getItem(key)!);
    sessionStorage.setItem(key, JSON.stringify({ ...current, runtimeConstraint: { rendering: 'safe', media: 'economy', motion: 'minimal' }, lastBadAt: Date.now(), penaltyExpiresAt: Date.now() + 1800000, lastReason: 'severe-loaf' }));
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload();
  await action.scrollIntoViewIfNeeded();
  await expect(action).toHaveAttribute('data-cart-ready', 'true');
  await expect(page.locator('html')).toHaveAttribute('data-aq-rendering', 'safe');
  await expect(page.locator('html')).toHaveAttribute('data-aq-motion', 'minimal');
  expect(await hero.innerText()).toBe(before.text);
  const after = await hero.boundingBox();
  expect(Math.abs(after!.width - before.box!.width)).toBeLessThan(1);
  expect(Math.abs(after!.height - before.box!.height)).toBeLessThan(1);
  await page.getByTestId('pdp-add-to-cart').click();
  await expect(page.getByTestId('pdp-add-to-cart')).toContainText('در سبد خرید');
});
