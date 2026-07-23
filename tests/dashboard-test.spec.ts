import { test, expect, Page } from '@playwright/test';

const BASE = 'http://localhost:8080';
const SS = 'tests/screenshots';

const EMAIL = `tester_${Date.now()}@mailinator.com`;
const PASSWORD = 'Test@12345!';

async function shot(page: Page, name: string) {
  await page.screenshot({ path: `${SS}/${name}.png`, fullPage: true });
}

async function pause(ms = 1500) {
  await new Promise(r => setTimeout(r, ms));
}

test('Dashboard full walkthrough', async ({ page }) => {
  page.setDefaultTimeout(20000);

  // ── STEP 1: Register ────────────────────────────────────────────────────
  console.log('\n🔵 Step 1: Registering new account...');
  await page.goto(`${BASE}/register`);
  await page.waitForLoadState('networkidle');
  await pause();
  await shot(page, '01-register-page');

  // Register form field order: Full Name, Company Name, Email, Password
  const allInputs = page.locator('input');
  await allInputs.nth(0).fill('Test User');       // Full Name
  await allInputs.nth(1).fill('NEXUS QA');        // Company Name
  await allInputs.nth(2).fill(EMAIL);             // Email
  await allInputs.nth(3).fill(PASSWORD);          // Password

  await shot(page, '02-register-filled');
  await page.locator('button[type="submit"]').click();
  await pause(3000);
  await shot(page, '03-after-register');
  console.log(`   → Landed on: ${page.url()}`);

  // ── STEP 2: Login if not already on dashboard ───────────────────────────
  if (!page.url().includes('dashboard')) {
    console.log('\n🔵 Step 2: Logging in...');
    await page.goto(`${BASE}/login`);
    await page.waitForLoadState('networkidle');
    await pause();

    await page.locator('input[type="email"], input[name="email"]').first().fill(EMAIL);
    await page.locator('input[type="password"]').first().fill(PASSWORD);
    await shot(page, '04-login-filled');
    await page.locator('button[type="submit"]').click();
    await pause(3000);
    await shot(page, '05-after-login');
    console.log(`   → Landed on: ${page.url()}`);
  }

  // If still not on dashboard, stop
  if (!page.url().includes('dashboard')) {
    await shot(page, '06-stuck');
    console.log('⚠️  Could not reach dashboard. Check auth.');
    return;
  }

  // ── STEP 3: Quick Setup ─────────────────────────────────────────────────
  console.log('\n🔵 Step 3: Quick Setup...');
  await page.goto(`${BASE}/dashboard/quick-setup`);
  await page.waitForLoadState('networkidle');
  await pause();
  await shot(page, '07-quick-setup');

  // ── STEP 4: AI Agents ───────────────────────────────────────────────────
  console.log('\n🔵 Step 4: AI Agents...');
  await page.goto(`${BASE}/dashboard/ai-agents`);
  await page.waitForLoadState('networkidle');
  await pause();
  await shot(page, '08-ai-agents');

  // ── STEP 5: Create Agent ─────────────────────────────────────────────────
  console.log('\n🔵 Step 5: Create AI Agent...');
  await page.goto(`${BASE}/dashboard/ai-agents/create`);
  await page.waitForLoadState('networkidle');
  await pause();
  await shot(page, '09-create-agent');

  // ── STEP 6: AI Voices ──────────────────────────────────────────────────
  console.log('\n🔵 Step 6: AI Voices...');
  await page.goto(`${BASE}/dashboard/ai-voices`);
  await page.waitForLoadState('networkidle');
  await pause();
  await shot(page, '10-ai-voices');

  // ── STEP 7: Tools ──────────────────────────────────────────────────────
  console.log('\n🔵 Step 7: Tools...');
  await page.goto(`${BASE}/dashboard/tools`);
  await page.waitForLoadState('networkidle');
  await pause();
  await shot(page, '11-tools');

  // ── STEP 8: Integrations ───────────────────────────────────────────────
  console.log('\n🔵 Step 8: Integrations...');
  await page.goto(`${BASE}/dashboard/integrations`);
  await page.waitForLoadState('networkidle');
  await pause();
  await shot(page, '12-integrations');

  // ── STEP 9: Voice Widgets ──────────────────────────────────────────────
  console.log('\n🔵 Step 9: Voice Widgets...');
  await page.goto(`${BASE}/dashboard/voice-widgets`);
  await page.waitForLoadState('networkidle');
  await pause();
  await shot(page, '13-voice-widgets');

  // ── STEP 10: Contacts ──────────────────────────────────────────────────
  console.log('\n🔵 Step 10: Contacts...');
  await page.goto(`${BASE}/dashboard/database/contacts`);
  await page.waitForLoadState('networkidle');
  await pause();
  await shot(page, '14-contacts');

  // ── STEP 11: Lists ─────────────────────────────────────────────────────
  console.log('\n🔵 Step 11: Lists...');
  await page.goto(`${BASE}/dashboard/database/lists`);
  await page.waitForLoadState('networkidle');
  await pause();
  await shot(page, '15-lists');

  // ── STEP 12: Custom Fields ─────────────────────────────────────────────
  console.log('\n🔵 Step 12: Custom Fields...');
  await page.goto(`${BASE}/dashboard/database/custom-fields`);
  await page.waitForLoadState('networkidle');
  await pause();
  await shot(page, '16-custom-fields');

  // ── STEP 13: Phone Numbers ─────────────────────────────────────────────
  console.log('\n🔵 Step 13: Phone Numbers...');
  await page.goto(`${BASE}/dashboard/telephony/phone-numbers`);
  await page.waitForLoadState('networkidle');
  await pause();
  await shot(page, '17-phone-numbers');

  // ── STEP 14: Outbound Campaigns ────────────────────────────────────────
  console.log('\n🔵 Step 14: Outbound Campaigns...');
  await page.goto(`${BASE}/dashboard/telephony/outbound`);
  await page.waitForLoadState('networkidle');
  await pause();
  await shot(page, '18-outbound');

  // ── STEP 15: Inbound Queues ────────────────────────────────────────────
  console.log('\n🔵 Step 15: Inbound Queues...');
  await page.goto(`${BASE}/dashboard/telephony/inbound`);
  await page.waitForLoadState('networkidle');
  await pause();
  await shot(page, '19-inbound');

  // ── STEP 16: Conversations ─────────────────────────────────────────────
  console.log('\n🔵 Step 16: Conversations...');
  await page.goto(`${BASE}/dashboard/conversations`);
  await page.waitForLoadState('networkidle');
  await pause();
  await shot(page, '20-conversations');

  // ── STEP 17: Analytics ─────────────────────────────────────────────────
  console.log('\n🔵 Step 17: Analytics - Channel...');
  await page.goto(`${BASE}/dashboard/analytics/channel`);
  await page.waitForLoadState('networkidle');
  await pause();
  await shot(page, '21-analytics-channel');

  await page.goto(`${BASE}/dashboard/analytics/campaign`);
  await page.waitForLoadState('networkidle');
  await pause();
  await shot(page, '22-analytics-campaign');

  await page.goto(`${BASE}/dashboard/analytics/scenario`);
  await page.waitForLoadState('networkidle');
  await pause();
  await shot(page, '23-analytics-scenario');

  await page.goto(`${BASE}/dashboard/analytics/flow`);
  await page.waitForLoadState('networkidle');
  await pause();
  await shot(page, '24-analytics-flow');

  // ── STEP 18: Automation ────────────────────────────────────────────────
  console.log('\n🔵 Step 18: Automation...');
  await page.goto(`${BASE}/dashboard/automation`);
  await page.waitForLoadState('networkidle');
  await pause();
  await shot(page, '25-automation');

  // ── STEP 19: Profile ───────────────────────────────────────────────────
  console.log('\n🔵 Step 19: Profile...');
  await page.goto(`${BASE}/dashboard/profile`);
  await page.waitForLoadState('networkidle');
  await pause();
  await shot(page, '26-profile');

  // ── STEP 20: Support ───────────────────────────────────────────────────
  console.log('\n🔵 Step 20: Support...');
  await page.goto(`${BASE}/dashboard/support`);
  await page.waitForLoadState('networkidle');
  await pause();
  await shot(page, '27-support');

  console.log('\n✅ Dashboard walkthrough complete! Screenshots saved to tests/screenshots/');
});
