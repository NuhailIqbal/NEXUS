import { test, expect, Page } from '@playwright/test';

const BASE = 'http://localhost:8080';
const SS = 'tests/screenshots/full';

const EMAIL = `tester_${Date.now()}@mailinator.com`;
const PASSWORD = 'Test@12345!';

async function shot(page: Page, name: string) {
  await page.screenshot({ path: `${SS}/${name}.png`, fullPage: true });
}

async function wait(page: Page, ms = 1200) {
  await page.waitForTimeout(ms);
}

async function clickIfVisible(page: Page, selector: string, label: string) {
  try {
    const el = page.locator(selector).first();
    if (await el.isVisible({ timeout: 3000 })) {
      await el.click();
      await page.waitForTimeout(800);
      console.log(`   ✓ Clicked: ${label}`);
      return true;
    }
  } catch {}
  console.log(`   - Skipped (not visible): ${label}`);
  return false;
}

// ── SHARED: Register & Login ─────────────────────────────────────────────────
async function loginOrRegister(page: Page) {
  await page.goto(`${BASE}/register`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);
  const inputs = page.locator('input');
  await inputs.nth(0).fill('Test User');
  await inputs.nth(1).fill('NEXUS QA');
  await inputs.nth(2).fill(EMAIL);
  await inputs.nth(3).fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForTimeout(4000);
  if (!page.url().includes('dashboard')) {
    await page.goto(`${BASE}/login`);
    await page.waitForLoadState('networkidle');
    await page.locator('input[type="email"]').first().fill(EMAIL);
    await page.locator('input[type="password"]').first().fill(PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForTimeout(4000);
  }
  console.log(`   → Authenticated. URL: ${page.url()}`);
}

// ════════════════════════════════════════════════════════════════════════════
//  TEST 1 — AI AGENTS: Create full agent through all 5 steps
// ════════════════════════════════════════════════════════════════════════════
test('1 - AI Agents: create full agent + test all buttons', async ({ page }) => {
  page.setDefaultTimeout(30000);
  await loginOrRegister(page);

  // ── Visit AI Agents list ───────────────────────────────────────────────
  console.log('\n📋 AI Agents list page...');
  await page.goto(`${BASE}/dashboard/ai-agents`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);
  await shot(page, '01-agents-list');

  // Click "Advanced" filter button
  await clickIfVisible(page, 'button:has-text("Advanced")', 'Advanced filter');
  await shot(page, '01b-agents-advanced-filter');
  await page.keyboard.press('Escape');

  // Click "Add New Agent" button
  console.log('\n🤖 Creating new AI Agent...');
  await page.locator('button:has-text("Add New Agent")').click();
  await page.waitForURL('**/ai-agents/create');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);

  // ── STEP 1: Complete Setup (Basic Information) ─────────────────────────
  console.log('\n   📝 Step 1: Basic Information...');
  await shot(page, '02-create-step1');

  // Fill Agent Name
  await page.locator('input[placeholder*="agent"]').first().fill('Nexus Sales Bot');

  // Fill Website
  const websiteInput = page.locator('input[placeholder*="example.com"], input[placeholder*="https"]').first();
  if (await websiteInput.isVisible({ timeout: 2000 }).catch(() => false)) {
    await websiteInput.fill('https://nexus.com');
  }

  // Fill Main Goal
  const goalTextarea = page.locator('textarea').first();
  if (await goalTextarea.isVisible({ timeout: 2000 }).catch(() => false)) {
    await goalTextarea.fill('Qualify inbound leads, book demo calls, and answer product questions for the NEXUS AI platform.');
  }

  // Click an industry (e.g. SaaS & Technology)
  await clickIfVisible(page, 'div:has-text("SaaS & Technology")', 'SaaS & Technology industry');
  await shot(page, '02b-step1-filled');

  // Select Language dropdown
  const langSelect = page.locator('select, [role="combobox"]').first();
  if (await langSelect.isVisible({ timeout: 2000 }).catch(() => false)) {
    await langSelect.click();
    await page.waitForTimeout(500);
    await shot(page, '02c-language-dropdown');
    await page.keyboard.press('Escape');
  }

  // Click Continue
  await page.locator('button:has-text("Continue")').click();
  await page.waitForTimeout(2000);
  await shot(page, '03-create-step2');

  // ── STEP 2: AI Tools ──────────────────────────────────────────────────
  console.log('\n   🔧 Step 2: AI Tools...');
  // Toggle any available tools
  const toolToggles = page.locator('button[role="checkbox"], input[type="checkbox"]');
  const toolCount = await toolToggles.count();
  console.log(`   Found ${toolCount} tool toggles`);
  for (let i = 0; i < Math.min(toolCount, 3); i++) {
    try {
      await toolToggles.nth(i).click();
      await page.waitForTimeout(400);
    } catch {}
  }
  await shot(page, '03b-tools-selected');
  await clickIfVisible(page, 'button:has-text("Continue")', 'Continue to Knowledge Center');
  await page.waitForTimeout(2000);

  // ── STEP 3: Knowledge Center ──────────────────────────────────────────
  console.log('\n   📚 Step 3: Knowledge Center...');
  await shot(page, '04-create-step3-knowledge');

  // Fill text knowledge if textarea exists
  const knowledgeTextarea = page.locator('textarea').first();
  if (await knowledgeTextarea.isVisible({ timeout: 2000 }).catch(() => false)) {
    await knowledgeTextarea.fill('NEXUS is an AI-powered performance marketing platform. We offer neural routing, fraud detection, and autonomous voice agents. Pricing starts at $0.05 per call minute. Enterprise plans available. Contact sales@nexus.com.');
  }

  // Check for file upload button
  await clickIfVisible(page, 'button:has-text("Upload"), button:has-text("Add"), label[for*="file"]', 'Upload knowledge file');
  await shot(page, '04b-knowledge-filled');
  await clickIfVisible(page, 'button:has-text("Continue")', 'Continue to Prompt Studio');
  await page.waitForTimeout(2000);

  // ── STEP 4: Prompt Studio ─────────────────────────────────────────────
  console.log('\n   ✍️  Step 4: Prompt Studio...');
  await shot(page, '05-create-step4-prompt');

  // Fill system prompt if textarea exists
  const promptTextareas = page.locator('textarea');
  const ptCount = await promptTextareas.count();
  if (ptCount > 0) {
    await promptTextareas.first().fill(`You are Nexus Sales Bot, an AI sales assistant for EDM NEXUS.
Your role is to qualify leads, answer questions about our platform, and book demo calls.
Always be professional, concise, and helpful.
Key info: We offer AI voice agents, neural routing, and real-time analytics.
If user wants a demo, collect their name, company, email, and preferred time.`);
  }
  // Fill first message if second textarea exists
  if (ptCount > 1) {
    await promptTextareas.nth(1).fill("Hello! I'm Nexus Sales Bot. How can I help you today? I can answer questions about our platform or book you a demo.");
  }

  await shot(page, '05b-prompt-filled');

  // Click any "Enhance" or AI buttons in prompt studio
  await clickIfVisible(page, 'button:has-text("Enhance"), button:has-text("Generate"), button:has-text("Improve")', 'Enhance prompt');
  await page.waitForTimeout(2000);
  await shot(page, '05c-prompt-enhanced');

  await clickIfVisible(page, 'button:has-text("Continue")', 'Continue to Testing');
  await page.waitForTimeout(2000);

  // ── STEP 5: Testing ───────────────────────────────────────────────────
  console.log('\n   🧪 Step 5: Testing...');
  await shot(page, '06-create-step5-testing');

  // Click "Create Agent" or "Finish" or "Launch"
  const createBtn = page.locator('button:has-text("Create"), button:has-text("Finish"), button:has-text("Launch"), button:has-text("Save")').first();
  if (await createBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await createBtn.click();
    await page.waitForTimeout(4000);
    await shot(page, '06b-agent-created');
    console.log(`   → After create: ${page.url()}`);
  }

  // ── Back on Agents list: test buttons on existing agent ───────────────
  await page.goto(`${BASE}/dashboard/ai-agents`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1500);
  await shot(page, '07-agents-with-agent');

  // Click on agent row or settings icon
  await clickIfVisible(page, 'button[aria-label*="settings"], button[aria-label*="edit"], button:has-text("Settings")', 'Agent settings');
  await page.waitForTimeout(1000);
  await shot(page, '07b-agent-settings');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  // Click Test Voice / Live Call button
  await clickIfVisible(page, 'button:has-text("Test"), button:has-text("Voice"), button:has-text("Call")', 'Test voice');
  await page.waitForTimeout(1000);
  await shot(page, '07c-test-voice-modal');
  await page.keyboard.press('Escape');

  console.log('\n✅ AI Agents test complete');
});

// ════════════════════════════════════════════════════════════════════════════
//  TEST 2 — TOOLS
// ════════════════════════════════════════════════════════════════════════════
test('2 - Tools: create tool + test all buttons', async ({ page }) => {
  page.setDefaultTimeout(30000);
  await loginOrRegister(page);

  console.log('\n🔧 Tools page...');
  await page.goto(`${BASE}/dashboard/tools`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);
  await shot(page, '08-tools-list');

  // Click "Create Tool" or "Add Tool"
  const createToolBtn = page.locator('button:has-text("Create Tool"), button:has-text("Add Tool"), button:has-text("New Tool"), button:has-text("Add")').first();
  if (await createToolBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await createToolBtn.click();
    await page.waitForTimeout(1000);
    await shot(page, '08b-create-tool-dialog');

    // Fill tool details
    const nameInput = page.locator('input[placeholder*="name"], input[placeholder*="Name"]').first();
    if (await nameInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      await nameInput.fill('Book Meeting Tool');
    }

    const descInput = page.locator('input[placeholder*="desc"], textarea[placeholder*="desc"]').first();
    if (await descInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      await descInput.fill('Books a meeting with the sales team via calendar link');
    }

    // Fill webhook URL if visible
    const urlInput = page.locator('input[placeholder*="url"], input[placeholder*="URL"], input[placeholder*="https"]').first();
    if (await urlInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      await urlInput.fill('https://hooks.example.com/book-meeting');
    }

    await shot(page, '08c-tool-filled');

    // Click Next/Continue steps
    const nextBtn = page.locator('button:has-text("Next"), button:has-text("Continue")').first();
    if (await nextBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await nextBtn.click();
      await page.waitForTimeout(1000);
      await shot(page, '08d-tool-step2');
      const nextBtn2 = page.locator('button:has-text("Next"), button:has-text("Continue")').first();
      if (await nextBtn2.isVisible({ timeout: 2000 }).catch(() => false)) {
        await nextBtn2.click();
        await page.waitForTimeout(1000);
        await shot(page, '08e-tool-step3');
      }
    }

    // Save / Create
    const saveBtn = page.locator('button:has-text("Save"), button:has-text("Create"), button:has-text("Finish")').first();
    if (await saveBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await saveBtn.click();
      await page.waitForTimeout(2000);
    } else {
      await page.keyboard.press('Escape');
    }
    await shot(page, '08f-tool-saved');
  }
  console.log('\n✅ Tools test complete');
});

// ════════════════════════════════════════════════════════════════════════════
//  TEST 3 — AI VOICES
// ════════════════════════════════════════════════════════════════════════════
test('3 - AI Voices: preview voices + clone voice', async ({ page }) => {
  page.setDefaultTimeout(30000);
  await loginOrRegister(page);

  console.log('\n🎙️ AI Voices page...');
  await page.goto(`${BASE}/dashboard/ai-voices`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);
  await shot(page, '09-voices-list');

  // Click Preview on first voice only
  const previewBtns = page.locator('button:has-text("Preview")');
  const previewCount = await previewBtns.count();
  console.log(`   Found ${previewCount} Preview buttons`);

  for (let i = 0; i < Math.min(previewCount, 2); i++) {
    try {
      await previewBtns.nth(i).click();
      await page.waitForTimeout(1500);
      await shot(page, `09b-voice-preview-${i + 1}`);
      // Close dialog if it opened
      const closeBtn = page.locator('[role="dialog"] button[aria-label*="Close"], [role="dialog"] button:has-text("Close"), [role="dialog"] button:has-text("Cancel")').first();
      if (await closeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await closeBtn.click();
        await page.waitForTimeout(600);
      } else {
        await page.keyboard.press('Escape');
        await page.waitForTimeout(600);
      }
      // Wait for dialog to close
      await page.waitForTimeout(800);
    } catch (e) {
      console.log(`   - Preview ${i+1} skipped: dialog issue`);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(600);
    }
  }

  // Click "Clone Voice" button
  await clickIfVisible(page, 'button:has-text("Clone Voice")', 'Clone Voice');
  await page.waitForTimeout(1000);
  await shot(page, '09d-clone-voice-dialog');
  await page.keyboard.press('Escape');

  console.log('\n✅ AI Voices test complete');
});

// ════════════════════════════════════════════════════════════════════════════
//  TEST 4 — INTEGRATIONS
// ════════════════════════════════════════════════════════════════════════════
test('4 - Integrations: add integration + test buttons', async ({ page }) => {
  page.setDefaultTimeout(30000);
  await loginOrRegister(page);

  console.log('\n🔌 Integrations page...');
  await page.goto(`${BASE}/dashboard/integrations`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);
  await shot(page, '10-integrations');

  // Click "Add Integration" or "Connect"
  const addBtn = page.locator('button:has-text("Add Integration"), button:has-text("Connect"), button:has-text("Add")').first();
  if (await addBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await addBtn.click();
    await page.waitForTimeout(1000);
    await shot(page, '10b-add-integration-dialog');

    // Fill integration name if input visible
    const nameInput = page.locator('input').first();
    if (await nameInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      await nameInput.fill('Test Integration');
    }

    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  }

  // Click any existing integration "Configure" or "Test" buttons
  await clickIfVisible(page, 'button:has-text("Configure"), button:has-text("Test Connection"), button:has-text("Test")', 'Test connection');
  await page.waitForTimeout(1000);
  await shot(page, '10c-integration-tested');
  await page.keyboard.press('Escape');

  console.log('\n✅ Integrations test complete');
});

// ════════════════════════════════════════════════════════════════════════════
//  TEST 5 — VOICE WIDGETS
// ════════════════════════════════════════════════════════════════════════════
test('5 - Voice Widgets: create widget + test buttons', async ({ page }) => {
  page.setDefaultTimeout(30000);
  await loginOrRegister(page);

  console.log('\n📻 Voice Widgets page...');
  await page.goto(`${BASE}/dashboard/voice-widgets`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);
  await shot(page, '11-voice-widgets');

  // Click "Create Widget" or "Add Widget"
  const createBtn = page.locator('button:has-text("Create"), button:has-text("Add Widget"), button:has-text("New Widget")').first();
  if (await createBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await createBtn.click();
    await page.waitForTimeout(1000);
    await shot(page, '11b-create-widget-dialog');

    // Fill widget name
    const nameInput = page.locator('input').first();
    if (await nameInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      await nameInput.fill('Sales Widget');
    }

    // Fill any other fields
    const inputs = page.locator('input');
    const count = await inputs.count();
    for (let i = 1; i < Math.min(count, 4); i++) {
      const placeholder = await inputs.nth(i).getAttribute('placeholder') || '';
      if (placeholder.toLowerCase().includes('url') || placeholder.toLowerCase().includes('domain')) {
        await inputs.nth(i).fill('https://nexus.com');
      }
    }

    await shot(page, '11c-widget-filled');

    // Save
    const saveBtn = page.locator('button:has-text("Save"), button:has-text("Create"), button:has-text("Add")').last();
    if (await saveBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await saveBtn.click();
      await page.waitForTimeout(2000);
    } else {
      await page.keyboard.press('Escape');
    }
    await shot(page, '11d-widget-saved');
  }

  console.log('\n✅ Voice Widgets test complete');
});

// ════════════════════════════════════════════════════════════════════════════
//  TEST 6 — DATABASE: Contacts
// ════════════════════════════════════════════════════════════════════════════
test('6 - Contacts: add contact + test all buttons', async ({ page }) => {
  page.setDefaultTimeout(30000);
  await loginOrRegister(page);

  console.log('\n👥 Contacts page...');
  await page.goto(`${BASE}/dashboard/database/contacts`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);
  await shot(page, '12-contacts');

  // Search bar
  const searchBar = page.locator('input[placeholder*="Search"], input[placeholder*="search"]').first();
  if (await searchBar.isVisible({ timeout: 2000 }).catch(() => false)) {
    await searchBar.fill('test');
    await page.waitForTimeout(800);
    await shot(page, '12b-contacts-search');
    await searchBar.clear();
    await page.waitForTimeout(500);
  }

  // Click "Import CSV"
  await clickIfVisible(page, 'button:has-text("Import CSV"), button:has-text("Import")', 'Import CSV');
  await page.waitForTimeout(800);
  await shot(page, '12c-import-csv-dialog');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  // Click "Add Contact"
  await clickIfVisible(page, 'button:has-text("Add Contact"), button:has-text("Add")', 'Add Contact');
  await page.waitForTimeout(1000);
  await shot(page, '12d-add-contact-dialog');

  // Fill contact form
  const inputs = page.locator('dialog input, [role="dialog"] input');
  const count = await inputs.count();
  console.log(`   Found ${count} inputs in dialog`);

  for (let i = 0; i < count; i++) {
    const input = inputs.nth(i);
    const placeholder = (await input.getAttribute('placeholder') || '').toLowerCase();
    const type = await input.getAttribute('type') || 'text';
    if (placeholder.includes('name')) await input.fill('John Smith');
    else if (type === 'email' || placeholder.includes('email')) await input.fill('john.smith@company.com');
    else if (placeholder.includes('phone') || type === 'tel') await input.fill('+1 555 000 1234');
    else if (placeholder.includes('company')) await input.fill('ACME Corp');
  }

  await shot(page, '12e-contact-filled');

  // Click Save / Add
  const saveBtn = page.locator('dialog button:has-text("Save"), dialog button:has-text("Add"), [role="dialog"] button:has-text("Save"), [role="dialog"] button:has-text("Add")').last();
  if (await saveBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await saveBtn.click();
    await page.waitForTimeout(2000);
    await shot(page, '12f-contact-saved');
  } else {
    await page.keyboard.press('Escape');
  }

  // If contact was added, test Edit and Delete buttons
  await page.waitForTimeout(1000);
  await clickIfVisible(page, 'button[aria-label*="edit"], button:has-text("Edit")', 'Edit contact');
  await page.waitForTimeout(800);
  await shot(page, '12g-edit-contact');
  await page.keyboard.press('Escape');

  console.log('\n✅ Contacts test complete');
});

// ════════════════════════════════════════════════════════════════════════════
//  TEST 7 — DATABASE: Lists
// ════════════════════════════════════════════════════════════════════════════
test('7 - Lists: create list + test buttons', async ({ page }) => {
  page.setDefaultTimeout(30000);
  await loginOrRegister(page);

  console.log('\n📋 Lists page...');
  await page.goto(`${BASE}/dashboard/database/lists`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);
  await shot(page, '13-lists');

  // Click "Create List" or "New List"
  const createBtn = page.locator('button:has-text("Create List"), button:has-text("New List"), button:has-text("Add List"), button:has-text("Create")').first();
  if (await createBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await createBtn.click();
    await page.waitForTimeout(1000);
    await shot(page, '13b-create-list-dialog');

    const nameInput = page.locator('dialog input, [role="dialog"] input').first();
    if (await nameInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      await nameInput.fill('VIP Prospects');
    }

    const descInput = page.locator('dialog textarea, [role="dialog"] textarea').first();
    if (await descInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      await descInput.fill('High-value prospects from Q4 campaign');
    }

    await shot(page, '13c-list-filled');

    const saveBtn = page.locator('dialog button:has-text("Save"), dialog button:has-text("Create"), [role="dialog"] button:has-text("Create"), [role="dialog"] button:has-text("Save")').last();
    if (await saveBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await saveBtn.click();
      await page.waitForTimeout(2000);
    } else {
      await page.keyboard.press('Escape');
    }
    await shot(page, '13d-list-saved');
  }

  console.log('\n✅ Lists test complete');
});

// ════════════════════════════════════════════════════════════════════════════
//  TEST 8 — DATABASE: Custom Fields
// ════════════════════════════════════════════════════════════════════════════
test('8 - Custom Fields: create field + test buttons', async ({ page }) => {
  page.setDefaultTimeout(30000);
  await loginOrRegister(page);

  console.log('\n🏷️ Custom Fields page...');
  await page.goto(`${BASE}/dashboard/database/custom-fields`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);
  await shot(page, '14-custom-fields');

  const createBtn = page.locator('button:has-text("Add Field"), button:has-text("Create Field"), button:has-text("New Field"), button:has-text("Add")').first();
  if (await createBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await createBtn.click();
    await page.waitForTimeout(1000);
    await shot(page, '14b-create-field-dialog');

    const nameInput = page.locator('dialog input, [role="dialog"] input').first();
    if (await nameInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      await nameInput.fill('Lead Score');
    }

    // Click dropdown type if visible
    const typeSelect = page.locator('dialog select, dialog [role="combobox"], [role="dialog"] select, [role="dialog"] [role="combobox"]').first();
    if (await typeSelect.isVisible({ timeout: 2000 }).catch(() => false)) {
      await typeSelect.click();
      await page.waitForTimeout(500);
      await shot(page, '14c-field-type-dropdown');
      // Pick "Number"
      const numberOption = page.locator('[role="option"]:has-text("Number"), option:has-text("Number")').first();
      if (await numberOption.isVisible({ timeout: 1000 }).catch(() => false)) {
        await numberOption.click();
      } else {
        await page.keyboard.press('Escape');
      }
    }

    await shot(page, '14d-field-filled');
    try {
      const saveBtn = page.locator('[role="dialog"] button').filter({ hasText: /Create|Save|Add/ }).last();
      await saveBtn.waitFor({ state: 'visible', timeout: 5000 });
      await saveBtn.click({ force: true });
      await page.waitForTimeout(2000);
    } catch {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
    }
    await shot(page, '14e-field-saved');
  }

  console.log('\n✅ Custom Fields test complete');
});

// ════════════════════════════════════════════════════════════════════════════
//  TEST 9 — TELEPHONY: Phone Numbers
// ════════════════════════════════════════════════════════════════════════════
test('9 - Phone Numbers: add number + test buttons', async ({ page }) => {
  page.setDefaultTimeout(30000);
  await loginOrRegister(page);

  console.log('\n📞 Phone Numbers page...');
  await page.goto(`${BASE}/dashboard/telephony/phone-numbers`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);
  await shot(page, '15-phone-numbers');

  const addBtn = page.locator('button:has-text("Add Number"), button:has-text("Buy Number"), button:has-text("Provision"), button:has-text("Add")').first();
  if (await addBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await addBtn.click();
    await page.waitForTimeout(1000);
    await shot(page, '15b-add-number-dialog');

    // Click "Local" type if available
    await clickIfVisible(page, 'button:has-text("Local"), [data-value="local"]', 'Local number type');

    // Fill area code or search
    const searchInput = page.locator('dialog input, [role="dialog"] input').first();
    if (await searchInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      await searchInput.fill('212');
    }

    await shot(page, '15c-number-search');

    // Click search / find numbers
    await clickIfVisible(page, 'button:has-text("Search"), button:has-text("Find")', 'Search numbers');
    await page.waitForTimeout(2000);
    await shot(page, '15d-numbers-found');

    await page.keyboard.press('Escape');
  }

  console.log('\n✅ Phone Numbers test complete');
});

// ════════════════════════════════════════════════════════════════════════════
//  TEST 10 — TELEPHONY: Outbound Campaigns
// ════════════════════════════════════════════════════════════════════════════
test('10 - Outbound Campaigns: create campaign + test buttons', async ({ page }) => {
  page.setDefaultTimeout(30000);
  await loginOrRegister(page);

  console.log('\n📤 Outbound Campaigns page...');
  await page.goto(`${BASE}/dashboard/telephony/outbound`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);
  await shot(page, '16-outbound');

  const createBtn = page.locator('button:has-text("Create Campaign"), button:has-text("New Campaign"), button:has-text("Add Campaign"), button:has-text("Create")').first();
  if (await createBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await createBtn.click();
    await page.waitForTimeout(1000);
    await shot(page, '16b-create-campaign-dialog');

    // Fill campaign name
    const nameInput = page.locator('dialog input[placeholder*="name" i], [role="dialog"] input[placeholder*="name" i]').first();
    if (await nameInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      await nameInput.fill('Q4 Outreach Campaign');
    } else {
      const firstInput = page.locator('dialog input, [role="dialog"] input').first();
      if (await firstInput.isVisible({ timeout: 2000 }).catch(() => false)) {
        await firstInput.fill('Q4 Outreach Campaign');
      }
    }

    await shot(page, '16c-campaign-filled');

    // Click next step if wizard
    await clickIfVisible(page, 'button:has-text("Next"), button:has-text("Continue")', 'Next step');
    await page.waitForTimeout(1000);
    await shot(page, '16d-campaign-step2');

    const saveBtn = page.locator('button:has-text("Create"), button:has-text("Save"), button:has-text("Launch")').last();
    if (await saveBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await saveBtn.click();
      await page.waitForTimeout(2000);
    } else {
      await page.keyboard.press('Escape');
    }
    await shot(page, '16e-campaign-saved');
  }

  console.log('\n✅ Outbound Campaigns test complete');
});

// ════════════════════════════════════════════════════════════════════════════
//  TEST 11 — TELEPHONY: Inbound Queues
// ════════════════════════════════════════════════════════════════════════════
test('11 - Inbound Queues: create queue + test buttons', async ({ page }) => {
  page.setDefaultTimeout(30000);
  await loginOrRegister(page);

  console.log('\n📥 Inbound Queues page...');
  await page.goto(`${BASE}/dashboard/telephony/inbound`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);
  await shot(page, '17-inbound');

  const createBtn = page.locator('button:has-text("Create Queue"), button:has-text("Add Queue"), button:has-text("New Queue"), button:has-text("Create")').first();
  if (await createBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await createBtn.click();
    await page.waitForTimeout(1000);
    await shot(page, '17b-create-queue-dialog');

    const nameInput = page.locator('dialog input, [role="dialog"] input').first();
    if (await nameInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      await nameInput.fill('Support Queue');
    }

    await shot(page, '17c-queue-filled');

    const saveBtn = page.locator('dialog button:has-text("Create"), dialog button:has-text("Save"), [role="dialog"] button:has-text("Create"), [role="dialog"] button:has-text("Save")').last();
    if (await saveBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await saveBtn.click();
      await page.waitForTimeout(2000);
    } else {
      await page.keyboard.press('Escape');
    }
    await shot(page, '17d-queue-saved');
  }

  console.log('\n✅ Inbound Queues test complete');
});

// ════════════════════════════════════════════════════════════════════════════
//  TEST 12 — CONVERSATIONS
// ════════════════════════════════════════════════════════════════════════════
test('12 - Conversations: filters + buttons', async ({ page }) => {
  page.setDefaultTimeout(30000);
  await loginOrRegister(page);

  console.log('\n💬 Conversations page...');
  await page.goto(`${BASE}/dashboard/conversations`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);
  await shot(page, '18-conversations');

  // Search
  const searchBar = page.locator('input[placeholder*="Search"], input[placeholder*="search"]').first();
  if (await searchBar.isVisible({ timeout: 2000 }).catch(() => false)) {
    await searchBar.fill('test');
    await page.waitForTimeout(800);
    await shot(page, '18b-conversations-search');
    await searchBar.clear();
  }

  // Status filter
  const statusFilter = page.locator('select, [role="combobox"]').first();
  if (await statusFilter.isVisible({ timeout: 2000 }).catch(() => false)) {
    await statusFilter.click();
    await page.waitForTimeout(500);
    await shot(page, '18c-status-filter-open');
    await page.keyboard.press('Escape');
  }

  // Click any filter chips if visible
  const filterBtns = page.locator('button:has-text("Completed"), button:has-text("Voice"), button:has-text("All")');
  const filterCount = await filterBtns.count();
  for (let i = 0; i < Math.min(filterCount, 3); i++) {
    await filterBtns.nth(i).click();
    await page.waitForTimeout(600);
    await shot(page, `18d-filter-${i}`);
  }

  console.log('\n✅ Conversations test complete');
});

// ════════════════════════════════════════════════════════════════════════════
//  TEST 13 — ANALYTICS (all 4 sub-pages)
// ════════════════════════════════════════════════════════════════════════════
test('13 - Analytics: all sub-pages + filters', async ({ page }) => {
  page.setDefaultTimeout(30000);
  await loginOrRegister(page);

  const analyticsRoutes = [
    ['channel', '19-analytics-channel'],
    ['campaign', '20-analytics-campaign'],
    ['scenario', '21-analytics-scenario'],
    ['flow', '22-analytics-flow'],
  ];

  for (const [route, shotName] of analyticsRoutes) {
    console.log(`\n📊 Analytics: ${route}...`);
    await page.goto(`${BASE}/dashboard/analytics/${route}`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1200);
    await shot(page, shotName);

    // Click date range filter
    const dateFilter = page.locator('button:has-text("7 days"), button:has-text("14 days"), button:has-text("30 days"), button:has-text("Last")').first();
    if (await dateFilter.isVisible({ timeout: 2000 }).catch(() => false)) {
      await dateFilter.click();
      await page.waitForTimeout(800);
      await shot(page, `${shotName}-date-filter`);
      await page.keyboard.press('Escape');
    }

    // Click any tabs
    const tabs = page.locator('[role="tab"]');
    const tabCount = await tabs.count();
    for (let i = 0; i < Math.min(tabCount, 4); i++) {
      await tabs.nth(i).click();
      await page.waitForTimeout(600);
      await shot(page, `${shotName}-tab-${i}`);
    }
  }

  console.log('\n✅ Analytics test complete');
});

// ════════════════════════════════════════════════════════════════════════════
//  TEST 14 — AUTOMATION: create flow + open editor
// ════════════════════════════════════════════════════════════════════════════
test('14 - Automation: create flow + test node editor', async ({ page }) => {
  page.setDefaultTimeout(30000);
  await loginOrRegister(page);

  console.log('\n⚙️ Automation page...');
  await page.goto(`${BASE}/dashboard/automation`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);
  await shot(page, '23-automation-list');

  // Click "Create Flow" or "New Flow"
  const createBtn = page.locator('button:has-text("Create Flow"), button:has-text("New Flow"), button:has-text("Create"), button:has-text("Add")').first();
  if (await createBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await createBtn.click();
    await page.waitForTimeout(1000);
    await shot(page, '23b-create-flow-dialog');

    const nameInput = page.locator('dialog input, [role="dialog"] input').first();
    if (await nameInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      await nameInput.fill('Lead Nurture Flow');
    }

    const descInput = page.locator('dialog textarea, [role="dialog"] textarea').first();
    if (await descInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      await descInput.fill('Automatically nurture inbound leads with voice + SMS follow-ups');
    }

    await shot(page, '23c-flow-filled');

    const saveBtn = page.locator('dialog button:has-text("Create"), [role="dialog"] button:has-text("Create"), dialog button:has-text("Save"), [role="dialog"] button:has-text("Save")').last();
    if (await saveBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await saveBtn.click();
      await page.waitForTimeout(2000);
    } else {
      await page.keyboard.press('Escape');
    }
    await shot(page, '23d-flow-created');
  }

  // Open the flow editor (click on a flow)
  await page.waitForTimeout(1000);
  const flowLinks = page.locator('a[href*="/automation/"], button:has-text("Edit"), button:has-text("Open")');
  if (await flowLinks.first().isVisible({ timeout: 3000 }).catch(() => false)) {
    await flowLinks.first().click();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);
    await shot(page, '23e-flow-editor');

    // Test node panel buttons
    await clickIfVisible(page, 'button:has-text("Add Node"), button:has-text("Add Trigger"), button:has-text("+")', 'Add node');
    await page.waitForTimeout(1000);
    await shot(page, '23f-flow-add-node');
    await page.keyboard.press('Escape');

    // Test Save button
    await clickIfVisible(page, 'button:has-text("Save"), button:has-text("Publish")', 'Save flow');
    await page.waitForTimeout(1000);
    await shot(page, '23g-flow-saved');
  }

  console.log('\n✅ Automation test complete');
});

// ════════════════════════════════════════════════════════════════════════════
//  TEST 15 — PROFILE & TEAMS
// ════════════════════════════════════════════════════════════════════════════
test('15 - Profile: edit profile + invite team member', async ({ page }) => {
  page.setDefaultTimeout(30000);
  await loginOrRegister(page);

  console.log('\n👤 Profile page...');
  await page.goto(`${BASE}/dashboard/profile`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);
  await shot(page, '24-profile');

  // Click any tabs (Profile, Teams, Billing, etc.)
  const tabs = page.locator('[role="tab"]');
  const tabCount = await tabs.count();
  console.log(`   Found ${tabCount} tabs`);
  for (let i = 0; i < tabCount; i++) {
    await tabs.nth(i).click();
    await page.waitForTimeout(800);
    await shot(page, `24-profile-tab-${i}`);
  }

  // Edit profile fields
  const inputs = page.locator('input:not([type="hidden"])');
  const inputCount = await inputs.count();
  for (let i = 0; i < Math.min(inputCount, 4); i++) {
    const input = inputs.nth(i);
    const placeholder = (await input.getAttribute('placeholder') || '').toLowerCase();
    const readOnly = await input.getAttribute('readonly');
    const disabled = await input.getAttribute('disabled');
    if (readOnly !== null || disabled !== null) continue;
    if (placeholder.includes('name')) await input.fill('Test User Updated');
    else if (placeholder.includes('company')) await input.fill('NEXUS QA Corp');
    else if (placeholder.includes('phone')) await input.fill('+1 555 123 4567');
  }

  // Click Save
  await clickIfVisible(page, 'button:has-text("Save"), button:has-text("Update"), button:has-text("Save Changes")', 'Save profile');
  await page.waitForTimeout(1500);
  await shot(page, '24b-profile-saved');

  // Invite team member
  await clickIfVisible(page, 'button:has-text("Invite"), button:has-text("Add Member")', 'Invite team member');
  await page.waitForTimeout(1000);
  await shot(page, '24c-invite-dialog');

  const emailInput = page.locator('dialog input[type="email"], [role="dialog"] input[type="email"]').first();
  if (await emailInput.isVisible({ timeout: 2000 }).catch(() => false)) {
    await emailInput.fill('teammate@company.com');
    // Select role
    await clickIfVisible(page, 'dialog [role="combobox"], [role="dialog"] [role="combobox"]', 'Role selector');
    await page.waitForTimeout(500);
    await shot(page, '24d-invite-filled');
  }
  await page.keyboard.press('Escape');

  console.log('\n✅ Profile test complete');
});

// ════════════════════════════════════════════════════════════════════════════
//  TEST 16 — SUPPORT
// ════════════════════════════════════════════════════════════════════════════
test('16 - Support: browse FAQs + test buttons', async ({ page }) => {
  page.setDefaultTimeout(30000);
  await loginOrRegister(page);

  console.log('\n🆘 Support page...');
  await page.goto(`${BASE}/dashboard/support`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);
  await shot(page, '25-support');

  // Click FAQ items to expand them
  const faqItems = page.locator('[data-state], button:has-text("?"), details summary, [role="button"]').filter({ hasText: /\?/ });
  const faqCount = await faqItems.count();
  console.log(`   Found ${faqCount} FAQ items`);

  const accordionTriggers = page.locator('[data-radix-collection-item], button[aria-expanded]');
  const accordionCount = await accordionTriggers.count();
  for (let i = 0; i < Math.min(accordionCount, 5); i++) {
    await accordionTriggers.nth(i).click();
    await page.waitForTimeout(500);
    await shot(page, `25b-faq-${i}`);
  }

  // Click documentation / help links
  await clickIfVisible(page, 'a:has-text("Docs"), a:has-text("Documentation"), button:has-text("View Docs")', 'Documentation link');
  await page.waitForTimeout(1000);
  await shot(page, '25c-docs-clicked');

  // Contact support button
  await clickIfVisible(page, 'button:has-text("Contact"), button:has-text("Chat"), a:has-text("Contact Support")', 'Contact support');
  await page.waitForTimeout(1000);
  await shot(page, '25d-contact-support');

  console.log('\n✅ Support test complete');
});

// ════════════════════════════════════════════════════════════════════════════
//  TEST 17 — QUICK SETUP: click all checklist items
// ════════════════════════════════════════════════════════════════════════════
test('17 - Quick Setup: click all checklist steps', async ({ page }) => {
  page.setDefaultTimeout(30000);
  await loginOrRegister(page);

  console.log('\n🚀 Quick Setup page...');
  await page.goto(`${BASE}/dashboard/quick-setup`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);
  await shot(page, '26-quick-setup');

  // Click all "Start →" buttons
  const startBtns = page.locator('button:has-text("Start"), a:has-text("Start")');
  const startCount = await startBtns.count();
  console.log(`   Found ${startCount} Start buttons`);

  for (let i = 0; i < startCount; i++) {
    const btn = startBtns.nth(i);
    const text = await btn.textContent();
    console.log(`   Clicking: ${text?.trim()}`);
    try {
      await btn.click();
      await page.waitForTimeout(1500);
      await shot(page, `26-setup-step-${i}`);
      await page.goBack();
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(800);
    } catch {}
  }

  console.log('\n✅ Quick Setup test complete');
});
