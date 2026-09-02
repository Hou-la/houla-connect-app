const { test, expect } = require('@playwright/test');
const { boot } = require('./_boot');

// « Lier mon jeu » pose le proxy XInput dans le dossier du jeu (il lira la manette virtuelle
// comme Joueur 1). Bouton sur la ligne « Manette virtuelle » de la vue Connecteurs.
const GAMEPAD_CX = { id: 'local-gamepad', type: 'gamepad', name: 'Manette virtuelle (ViGEm)', enabled: true };

test('Connecteurs : « Lier mon jeu » appelle game.link et affiche le jeu lié', async ({ page }) => {
    await boot(page, { connectors: [GAMEPAD_CX] }); // pas de jeu lié au départ
    await page.locator('.nav[data-view="connecteurs"]').click();
    await expect(page.locator('#view-connecteurs')).toBeVisible();
    await expect(page.locator('.cx-row .cx-game')).toBeVisible();
    await page.locator('.cx-row .cx-game').click();
    await expect
        .poll(() => page.evaluate(() => (window.__E2E_CALLS__.gameLink || []).length))
        .toBeGreaterThan(0);
    await expect(page.locator('.cx-row .cx-game-ok')).toContainText(/game\.exe/i); // badge du jeu lié
    await expect(page.locator('.cx-row .cx-game')).toHaveCount(0); // plus de bouton « Lier »
});

test('Connecteurs : jeu DÉJÀ lié -> badge, pas de bouton « Lier »', async ({ page }) => {
    await boot(page, { connectors: [GAMEPAD_CX], gameStatus: { exe: 'D:/Steam/MECCHA/game.exe', dir: 'D:/Steam/MECCHA', placed: true } });
    await page.locator('.nav[data-view="connecteurs"]').click();
    await expect(page.locator('.cx-row .cx-game-ok')).toContainText(/game\.exe/i);
    await expect(page.locator('.cx-row .cx-game')).toHaveCount(0);
});

test('Connecteurs : « Délier » appelle game.unlink et le bouton « Lier » revient', async ({ page }) => {
    await boot(page, { connectors: [GAMEPAD_CX], gameStatus: { exe: 'D:/Steam/MECCHA/game.exe', dir: 'D:/Steam/MECCHA', placed: true } });
    await page.locator('.nav[data-view="connecteurs"]').click();
    await page.locator('.cx-row .cx-game-un').click();
    await expect
        .poll(() => page.evaluate(() => (window.__E2E_CALLS__.gameUnlink || []).length))
        .toBeGreaterThan(0);
    await expect(page.locator('.cx-row .cx-game')).toBeVisible();
});
