const { test, expect } = require('@playwright/test');
const { boot } = require('./_boot');

async function gotoLab(page) {
    await boot(page);
    await page.locator('.nav[data-view="lab"]').click();
    await expect(page.locator('#view-lab .r-keys')).toBeVisible(); // create mode prêt
    await page.fill('#lab-slug', 'mon-pack');
    await page.fill('#lab-title', 'Mon Pack');
}

const visSent = (page) => page.evaluate(() => (window.__E2E_CALLS__.submitVersion || [])[0][1].visibility);
const submitted = (page) => page.evaluate(() => (window.__E2E_CALLS__.submitVersion || []).length);

test('publication : privé par défaut -> visibility "private" envoyée', async ({ page }) => {
    await gotoLab(page);
    await expect(page.locator('#lab-vis-label')).toHaveText(/Privé/);
    await page.locator('#lab-submit-btn').click();
    await expect.poll(() => submitted(page)).toBeGreaterThan(0);
    expect(await visSent(page)).toBe('private');
});

test('publication : toggle public -> visibility "public" envoyée', async ({ page }) => {
    await gotoLab(page);
    // #lab-vis est une checkbox cachée (switch stylé) : on bascule son état + déclenche
    // 'change' comme le ferait un clic sur le switch visible.
    await page.evaluate(() => { const el = document.getElementById('lab-vis'); el.checked = true; el.dispatchEvent(new Event('change')); });
    await expect(page.locator('#lab-vis-label')).toHaveText(/Public/);
    await page.locator('#lab-submit-btn').click();
    await expect.poll(() => submitted(page)).toBeGreaterThan(0);
    expect(await visSent(page)).toBe('public');
});
