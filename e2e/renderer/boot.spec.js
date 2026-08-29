const { test, expect } = require('@playwright/test');
const { boot } = require('./_boot');

test('démarre authentifié -> vue principale, workspace mocké affiché', async ({ page }) => {
    await boot(page);
    await expect(page.locator('#app-main')).toBeVisible();
    await expect(page.locator('#view-auth')).toBeHidden();
    await expect(page.locator('#ws-current-name')).toHaveText(/Test Studio/);
    // le module partagé s'est bien chargé avant renderer.js
    expect(await page.evaluate(() => typeof window.HoulaManifest.validateManifestClient)).toBe('function');
});

test('navigation Store -> état vide (mock sans pack)', async ({ page }) => {
    await boot(page);
    await page.locator('.nav[data-view="store"]').click();
    await expect(page.locator('#view-store')).toBeVisible();
    await expect(page.locator('#store-list')).toContainText(/store est encore vide|Aucun/i);
});

test('navigation Mes bundles -> état vide (mock sans bundle)', async ({ page }) => {
    await boot(page);
    await page.locator('.nav[data-view="mine"]').click();
    await expect(page.locator('#view-mine')).toBeVisible();
    await expect(page.locator('#mine-list')).toContainText(/premier pack|Aucun/i);
});
