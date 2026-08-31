const { test, expect } = require('@playwright/test');
const { boot } = require('./_boot');

// Manette virtuelle : le pilote ViGEmBus doit pouvoir s'installer depuis les Réglages
// (chemin PROACTIF, sans avoir à échouer un test d'abord). On vérifie que le bouton
// appelle bien driver.installGamepad et reflète le résultat.

test('Réglages : « Installer le pilote manette » appelle driver.installGamepad', async ({ page }) => {
    await boot(page);
    await page.locator('.nav[data-view="settings"]').click();
    await expect(page.locator('#view-settings')).toBeVisible();
    await page.locator('#driver-gamepad-install').click();
    await expect
        .poll(() => page.evaluate(() => (window.__E2E_CALLS__.installGamepad || []).length))
        .toBeGreaterThan(0);
    // Succès (mock ok:true) -> statut confirmé à l'utilisateur.
    await expect(page.locator('#driver-gamepad-status')).toContainText(/installé/i);
});

test('Réglages : échec d\'install -> message actionnable (UAC), pas d\'état « installé »', async ({ page }) => {
    await boot(page, { installGamepadResult: { ok: false, reason: 'Installation annulée ou refusée (UAC ?).' } });
    await page.locator('.nav[data-view="settings"]').click();
    await page.locator('#driver-gamepad-install').click();
    await expect(page.locator('[data-toast="driver"]')).toContainText(/UAC|non terminée|refusée/i);
    await expect(page.locator('#driver-gamepad-status')).not.toContainText(/installé ✓/i);
});
