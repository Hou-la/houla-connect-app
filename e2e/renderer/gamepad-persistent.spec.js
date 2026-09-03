const { test, expect } = require('@playwright/test');
const { boot } = require('./_boot');

// DIAGNOSTIC D'UN UTILISATEUR (Flicky, 2026-09-03), exact :
//   « quand je lance le test, ça ajoute puis retire rapidement un périphérique de la liste
//     des contrôleurs de jeux (le même bruit qu'une clé USB) »
//   « je pense qu'il détecte ça comme une autre manette »
// C'était le code : la manette virtuelle était créée pour le test puis DÉTRUITE aussitôt.
// Un jeu qui lit XInput à l'instant de l'appel s'en accommode (Meccha, via la DLL proxy) ;
// un ÉMULATEUR qui lie le périphérique à l'énumération ne peut RIEN en faire.
//
// Elle reste donc branchée. Corollaire : le joueur doit le VOIR et pouvoir la débrancher,
// sinon c'est une manette subie qui occupe un emplacement XInput sans qu'il comprenne.
const GAMEPAD_CX = { id: 'local-gamepad', type: 'gamepad', name: 'Manette virtuelle (ViGEm)', enabled: true };

test('manette branchée : l’état est visible et le débranchement est proposé', async ({ page }) => {
    await boot(page, {
        connectors: [GAMEPAD_CX],
        gamepadDriverInstalled: true,
        gamepadStatus: { connected: true, engineRunning: false },
    });
    await page.locator('.nav[data-view="connecteurs"]').click();
    const row = page.locator('.cx-row', { hasText: 'Manette virtuelle' });
    await expect(row.locator('.cx-padoff')).toBeVisible();
    await expect(row.locator('.cx-padoff')).toContainText(/Branchée/i);

    await row.locator('.cx-padoff').click();
    await expect
        .poll(() => page.evaluate(() => (window.__E2E_CALLS__.releaseGamepad || []).length))
        .toBe(1);
});

test('manette débranchée : aucun bouton, rien à débrancher', async ({ page }) => {
    // CONTRE-TÉMOIN : sans lui, « le bouton s'affiche » ne prouverait pas qu'il dépend
    // vraiment de l'état — il pourrait s'afficher tout le temps.
    await boot(page, {
        connectors: [GAMEPAD_CX],
        gamepadDriverInstalled: true,
        gamepadStatus: { connected: false, engineRunning: false },
    });
    await page.locator('.nav[data-view="connecteurs"]').click();
    await expect(page.locator('.cx-padoff')).toHaveCount(0);
});

test('un pack tourne : le refus est EXPLIQUÉ, pas silencieux', async ({ page }) => {
    // Débrancher pendant qu'un pack tourne couperait ses cadeaux. Le main refuse ; l'écran
    // doit dire pourquoi, sinon le clic paraît mort.
    await boot(page, {
        connectors: [GAMEPAD_CX],
        gamepadDriverInstalled: true,
        gamepadStatus: { connected: true, engineRunning: true },
        releaseGamepadResult: { ok: false, reason: 'Un pack tourne : arrête-le d’abord.' },
    });
    await page.locator('.nav[data-view="connecteurs"]').click();
    await page.locator('.cx-padoff').click();
    const toast = page.locator('[data-toast="pad"]');
    await expect(toast).toBeVisible({ timeout: 10000 });
    await expect(toast).toContainText(/Un pack tourne/i);
});

test('le connecteur manette reste utilisable si l’état est indisponible', async ({ page }) => {
    // Une sonde d'état qui échoue ne doit jamais casser la vue Connecteurs.
    await boot(page, {
        connectors: [GAMEPAD_CX],
        gamepadDriverInstalled: true,
        gamepadStatusError: true,
    });
    await page.locator('.nav[data-view="connecteurs"]').click();
    await expect(page.locator('.cx-row', { hasText: 'Manette virtuelle' })).toBeVisible();
    await expect(page.locator('.cx-padoff')).toHaveCount(0); // on ne propose rien à tort
});
