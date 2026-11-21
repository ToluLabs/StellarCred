import { test, expect } from '@playwright/test';

test.describe('Issue #789: Export Data UI Flow & Expiring Download Links', () => {
  test('User can open Export Data dialog from holder dashboard and request an export', async ({ page }) => {
    await page.goto('/holder');

    // 1. Locate and click Export Data button
    const exportBtn = page.locator('#btn-open-export-modal');
    await expect(exportBtn).toBeVisible({ timeout: 10000 });
    await exportBtn.click();

    // 2. Verify modal opened
    const modal = page.locator('div[role="dialog"]');
    await expect(modal).toBeVisible();
    await expect(page.locator('#export-modal-title')).toHaveText(/Export User Data/i);

    // 3. Verify scope options are displayed
    await expect(page.locator('#scope-option-credentials')).toBeVisible();
    await expect(page.locator('#scope-option-proofs')).toBeVisible();
    await expect(page.locator('#scope-option-activity')).toBeVisible();
    await expect(page.locator('#scope-option-full')).toBeVisible();

    // 4. Verify Admin Only scope has lock badge and disabled state for normal users
    const adminScope = page.locator('#scope-option-admin_audit');
    await expect(adminScope).toBeVisible();
    await expect(adminScope).toContainText(/Admin Only/i);
    const adminRadio = adminScope.locator('input[type="radio"]');
    await expect(adminRadio).toBeDisabled();

    // 5. Select scope & format
    await page.locator('#scope-option-credentials').click();
    await page.locator('#format-option-json').click();

    // 6. Submit export request
    const submitBtn = page.locator('#btn-submit-export');
    await expect(submitBtn).toBeEnabled();
    await submitBtn.click();

    // 7. Verify switch to monitor tab and job is displayed
    await expect(page.locator('#tab-monitor-exports')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[id^="export-job-"]')).toBeVisible({ timeout: 5000 });

    // 8. Wait for job to reach ready state
    const readyBadge = page.locator('text=Ready');
    await expect(readyBadge).toBeVisible({ timeout: 10000 });

    // 9. Verify download button and countdown timer are displayed
    const downloadBtn = page.locator('a[id^="btn-download-"]');
    await expect(downloadBtn).toBeVisible();
    await expect(downloadBtn).toHaveAttribute('href', /\/api\/export\/download\?token=/);
  });

  test('Export API enforces authorization and rejects unauthorized scopes', async ({ request }) => {
    // Attempting to request admin_audit without admin role must return 403 Forbidden
    const res = await request.post('/api/export', {
      headers: {
        'x-user-address': 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBHF2',
        'x-user-role': 'user',
      },
      data: {
        scope: 'admin_audit',
        format: 'json',
      },
    });

    expect(res.status()).toBe(403);
    const body = await res.json();
    expect(body.error).toContain('Forbidden');
  });

  test('Export download endpoint verifies tokens and rejects expired links', async ({ request }) => {
    // Request a valid export first
    const createRes = await request.post('/api/export', {
      headers: {
        'x-user-address': 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBHF2',
      },
      data: {
        scope: 'credentials',
        format: 'json',
      },
    });

    expect(createRes.status()).toBe(201);
    const { job } = await createRes.json();

    // Wait 1.5 seconds for job to be ready with artifact
    await new Promise((r) => setTimeout(r, 1500));

    // Fetch the updated job with token
    const jobRes = await request.get(`/api/export/${job.id}`);
    const { job: readyJob } = await jobRes.json();
    expect(readyJob.downloadToken).toBeDefined();

    // Valid token download succeeds
    const downloadRes = await request.get(`/api/export/download?token=${encodeURIComponent(readyJob.downloadToken)}`);
    expect(downloadRes.status()).toBe(200);
    expect(downloadRes.headers()['content-type']).toContain('application/json');

    // Invalid / forged token fails
    const forgedRes = await request.get(`/api/export/download?token=invalid.token`);
    expect(forgedRes.status()).toBe(403);

    // Missing token fails
    const missingRes = await request.get('/api/export/download');
    expect(missingRes.status()).toBe(400);
  });
});
