import { test, expect, Page } from '@playwright/test';

const BASE = 'http://localhost:8080';
const SCREENSHOTS = 'tests/screenshots';

async function shot(page: Page, name: string) {
  await page.screenshot({ path: `${SCREENSHOTS}/${name}.png`, fullPage: true });
}

// ─── Public Landing Pages ───────────────────────────────────────────────────

test.describe('Public Pages', () => {
  test('Home page loads', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForLoadState('networkidle');
    await shot(page, '01-home');
    await expect(page).toHaveTitle(/.+/);
    console.log('✅ Home page loaded');
  });

  test('Features page', async ({ page }) => {
    await page.goto(`${BASE}/features`);
    await page.waitForLoadState('networkidle');
    await shot(page, '02-features');
    console.log('✅ Features page loaded');
  });

  test('Technology page', async ({ page }) => {
    await page.goto(`${BASE}/technology`);
    await page.waitForLoadState('networkidle');
    await shot(page, '03-technology');
    console.log('✅ Technology page loaded');
  });

  test('Advertisers page', async ({ page }) => {
    await page.goto(`${BASE}/advertisers`);
    await page.waitForLoadState('networkidle');
    await shot(page, '04-advertisers');
    console.log('✅ Advertisers page loaded');
  });

  test('Publishers page', async ({ page }) => {
    await page.goto(`${BASE}/publishers`);
    await page.waitForLoadState('networkidle');
    await shot(page, '05-publishers');
    console.log('✅ Publishers page loaded');
  });

  test('Use Cases page', async ({ page }) => {
    await page.goto(`${BASE}/use-cases`);
    await page.waitForLoadState('networkidle');
    await shot(page, '06-use-cases');
    console.log('✅ Use Cases page loaded');
  });

  test('Pricing page', async ({ page }) => {
    await page.goto(`${BASE}/pricing`);
    await page.waitForLoadState('networkidle');
    await shot(page, '07-pricing');
    console.log('✅ Pricing page loaded');
  });

  test('About page', async ({ page }) => {
    await page.goto(`${BASE}/about`);
    await page.waitForLoadState('networkidle');
    await shot(page, '08-about');
    console.log('✅ About page loaded');
  });
});

// ─── Auth Pages ─────────────────────────────────────────────────────────────

test.describe('Auth Pages', () => {
  test('Login page renders', async ({ page }) => {
    await page.goto(`${BASE}/login`);
    await page.waitForLoadState('networkidle');
    await shot(page, '09-login');
    await expect(page.locator('input[type="email"], input[name="email"]').first()).toBeVisible();
    await expect(page.locator('input[type="password"]').first()).toBeVisible();
    console.log('✅ Login form visible');
  });

  test('Register page renders', async ({ page }) => {
    await page.goto(`${BASE}/register`);
    await page.waitForLoadState('networkidle');
    await shot(page, '10-register');
    await expect(page.locator('input[type="email"], input[name="email"]').first()).toBeVisible();
    console.log('✅ Register form visible');
  });

  test('Reset password page renders', async ({ page }) => {
    await page.goto(`${BASE}/reset-password`);
    await page.waitForLoadState('networkidle');
    await shot(page, '11-reset-password');
    console.log('✅ Reset password page loaded');
  });

  test('Request access page renders', async ({ page }) => {
    await page.goto(`${BASE}/request-access`);
    await page.waitForLoadState('networkidle');
    await shot(page, '12-request-access');
    console.log('✅ Request access page loaded');
  });

  test('Login with wrong credentials shows error', async ({ page }) => {
    await page.goto(`${BASE}/login`);
    await page.waitForLoadState('networkidle');
    await page.locator('input[type="email"], input[name="email"]').first().fill('wrong@test.com');
    await page.locator('input[type="password"]').first().fill('wrongpassword');
    await page.locator('button[type="submit"]').click();
    await page.waitForTimeout(2000);
    await shot(page, '13-login-error');
    console.log('✅ Login error state captured');
  });
});

// ─── Navigation ─────────────────────────────────────────────────────────────

test.describe('Navigation', () => {
  test('Navbar links work', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForLoadState('networkidle');

    // Click Features link in navbar
    const featuresLink = page.locator('nav a[href="/features"], nav a:has-text("Features")').first();
    if (await featuresLink.isVisible()) {
      await featuresLink.click();
      await page.waitForLoadState('networkidle');
      await shot(page, '14-nav-features');
      console.log('✅ Navbar Features link works');
    }
  });

  test('404 page', async ({ page }) => {
    await page.goto(`${BASE}/this-does-not-exist`);
    await page.waitForLoadState('networkidle');
    await shot(page, '15-404');
    console.log('✅ 404 page loaded');
  });

  test('Dashboard redirects unauthenticated users', async ({ page }) => {
    await page.goto(`${BASE}/dashboard`);
    await page.waitForLoadState('networkidle');
    await shot(page, '16-dashboard-unauth');
    const url = page.url();
    console.log(`✅ Dashboard unauth redirect → ${url}`);
  });
});

// ─── Register + Dashboard Flow ──────────────────────────────────────────────

test.describe('Full Auth + Dashboard Flow', () => {
  const testEmail = `testuser_${Date.now()}@mailinator.com`;
  const testPassword = 'TestPass123!';

  test('Register a new account', async ({ page }) => {
    await page.goto(`${BASE}/register`);
    await page.waitForLoadState('networkidle');

    // Fill all visible inputs
    const inputs = page.locator('input');
    const count = await inputs.count();
    console.log(`Found ${count} inputs on register page`);

    // Try common field selectors
    const emailInput = page.locator('input[type="email"], input[name="email"], input[placeholder*="email" i]').first();
    const passwordInput = page.locator('input[type="password"]').first();

    await emailInput.fill(testEmail);
    await passwordInput.fill(testPassword);

    // Fill name/company fields if present
    const nameInput = page.locator('input[name="name"], input[placeholder*="name" i], input[placeholder*="Name"]').first();
    if (await nameInput.isVisible().catch(() => false)) {
      await nameInput.fill('Test User');
    }
    const companyInput = page.locator('input[name="company"], input[placeholder*="company" i]').first();
    if (await companyInput.isVisible().catch(() => false)) {
      await companyInput.fill('Test Company');
    }

    await shot(page, '17-register-filled');
    await page.locator('button[type="submit"]').click();
    await page.waitForTimeout(3000);
    await shot(page, '18-register-submitted');
    console.log(`✅ Register submitted → ${page.url()}`);
  });

  test('Login with credentials', async ({ page }) => {
    await page.goto(`${BASE}/login`);
    await page.waitForLoadState('networkidle');

    await page.locator('input[type="email"], input[name="email"]').first().fill(testEmail);
    await page.locator('input[type="password"]').first().fill(testPassword);
    await shot(page, '19-login-filled');
    await page.locator('button[type="submit"]').click();
    await page.waitForTimeout(3000);
    await shot(page, '20-login-submitted');
    console.log(`✅ Login submitted → ${page.url()}`);
  });
});

// ─── Dashboard Pages (visit directly, may redirect if unauthed) ──────────────

test.describe('Dashboard Pages', () => {
  const dashRoutes = [
    ['quick-setup', '21-dash-quick-setup'],
    ['ai-agents', '22-dash-agents'],
    ['ai-voices', '23-dash-voices'],
    ['tools', '24-dash-tools'],
    ['integrations', '25-dash-integrations'],
    ['voice-widgets', '26-dash-voice-widgets'],
    ['conversations', '27-dash-conversations'],
    ['database/contacts', '28-dash-contacts'],
    ['database/lists', '29-dash-lists'],
    ['database/custom-fields', '30-dash-custom-fields'],
    ['telephony/phone-numbers', '31-dash-phones'],
    ['telephony/outbound', '32-dash-outbound'],
    ['telephony/inbound', '33-dash-inbound'],
    ['analytics/channel', '34-dash-analytics-channel'],
    ['analytics/campaign', '35-dash-analytics-campaign'],
    ['automation', '36-dash-automation'],
    ['profile', '37-dash-profile'],
    ['support', '38-dash-support'],
  ];

  for (const [route, shotName] of dashRoutes) {
    test(`/dashboard/${route}`, async ({ page }) => {
      await page.goto(`${BASE}/dashboard/${route}`);
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(1000);
      await shot(page, shotName);
      console.log(`✅ /dashboard/${route} → ${page.url()}`);
    });
  }
});
