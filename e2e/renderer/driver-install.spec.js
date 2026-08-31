const { test, expect } = require('@playwright/test');
const { boot } = require('./_boot');

// Le pilote de la manette virtuelle (ViGEmBus) s'installe DIRECTEMENT depuis la ligne
// « Manette virtuelle » de la vue Connecteurs (là où on l'active), pas enterré ailleurs.
const GAMEPAD_CX = { id: 'local-gamepad', type: 'gamepad', name: 'Manette virtuelle (ViGEm)', enabled: true };

test('Connecteurs : « Installer le pilote » (ligne Manette) appelle driver.installGamepad', async ({ page }) => {
    await boot(page, { connectors: [GAMEPAD_CX] });
    await page.locator('.nav[data-view="connecteurs"]').click();
    await expect(page.locator('#view-connecteurs')).toBeVisible();
    await page.locator('.cx-row .cx-driver').click();
    await expect
        .poll(() => page.evaluate(() => (window.__E2E_CALLS__.installGamepad || []).length))
        .toBeGreaterThan(0);
    await expect(page.locator('[data-toast="driver"]')).toContainText(/installé|prête/i);
});

test('Connecteurs : échec d\'install -> message actionnable (UAC), pas de faux succès', async ({ page }) => {
    await boot(page, { connectors: [GAMEPAD_CX], installGamepadResult: { ok: false, reason: 'Installation annulée ou refusée (UAC ?).' } });
    await page.locator('.nav[data-view="connecteurs"]').click();
    await page.locator('.cx-row .cx-driver').click();
    await expect(page.locator('[data-toast="driver"]')).toContainText(/UAC|non terminée|refusée/i);
});

test('Connecteurs : le bouton pilote n\'apparaît QUE sur la ligne Manette', async ({ page }) => {
    await boot(page, {
        connectors: [
            { id: 'local-keyboard', type: 'keyboard', name: 'Clavier', enabled: true },
            GAMEPAD_CX,
            { id: 'c-rcon', type: 'rcon', name: 'Mon serveur', enabled: false },
        ],
    });
    await page.locator('.nav[data-view="connecteurs"]').click();
    await expect(page.locator('.cx-driver')).toHaveCount(1); // pas sur clavier ni RCON
    await expect(page.locator('.cx-row', { hasText: 'Manette virtuelle' }).locator('.cx-driver')).toBeVisible();
});
