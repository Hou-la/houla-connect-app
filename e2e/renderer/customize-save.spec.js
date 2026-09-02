const { test, expect } = require('@playwright/test');
const { boot } = require('./_boot');

// RÉGRESSION VÉCUE EN PROD : la ligne « 🎮 Jeu piloté » (affichée pour les packs manette)
// partageait la classe `.cx-rule` des vraies interactions, sans case à cocher ni `data-id`.
// La boucle de sauvegarde tombait dessus et plantait AVANT son `try` : le bouton
// « Enregistrer » ne faisait plus RIEN, en silence, et rien ne le signalait.
// Contre-témoin obligatoire : « ça n'appelle pas save » est justement l'état bugué, donc on
// vérifie que `customize.save` est RÉELLEMENT appelé, pas seulement que rien n'a explosé.
const PACK = { slug: 'demo-pack', title: 'Pack Démo', version: '1.0.0', versionDate: '2026-01-01', bannerUrl: null, installCount: 0 };

const bootWith = (page, effectType, extra = {}) => boot(page, {
    store: [PACK],
    installed: [{ slug: 'demo-pack', version: '1.0.0' }],
    customize: {
        slug: 'demo-pack', version: '1.0.0', instructions: null,
        rules: [{ id: 'r1', label: 'Saut', trigger: 'gift', giftSlug: 'ix_slot_24', effectType, enabled: true, defaultCooldownMs: 0 }],
    },
    ...extra,
});

test('Personnaliser un pack MANETTE : « Enregistrer » appelle bien customize.save', async ({ page }) => {
    await bootWith(page, 'gamepad', { gamePackStatus: { exe: 'E:/Games/Demo/game.exe', dir: 'E:/Games/Demo', placed: true } });
    await page.locator('.nav[data-view="store"]').click();
    await page.locator('.bundle-card', { hasText: 'Pack Démo' }).locator('.customize').click();
    await expect(page.locator('#cx-modal')).toBeVisible();
    // la ligne « Jeu piloté » est bien là (c'est elle qui cassait la sauvegarde)
    await expect(page.locator('#cx-rules')).toContainText(/Jeu piloté/i);

    await page.locator('#cx-save').click();
    await expect
        .poll(() => page.evaluate(() => (window.__E2E_CALLS__.customizeSave || []).length))
        .toBe(1);
    await expect(page.locator('#cx-save-msg')).toContainText(/Enregistré/i);
});

test('Personnaliser : l’interrupteur OFF part bien dans disabled', async ({ page }) => {
    await bootWith(page, 'gamepad', { gamePackStatus: { exe: 'E:/Games/Demo/game.exe', dir: 'E:/Games/Demo', placed: true } });
    await page.locator('.nav[data-view="store"]').click();
    await page.locator('.bundle-card', { hasText: 'Pack Démo' }).locator('.customize').click();
    // On clique l'INTERRUPTEUR visible (l'input reel est masque par le style), comme l'utilisateur
    await page.locator('.cx-rule[data-id="r1"] .switch').click();
    await expect(page.locator('.cx-rule[data-id="r1"] .cx-en')).not.toBeChecked();
    await page.locator('#cx-save').click();
    await expect
        .poll(() => page.evaluate(() => {
            const c = (window.__E2E_CALLS__.customizeSave || [])[0];
            return c ? (c[1] || {}).disabled : null;
        }))
        .toContain('r1'); // la ligne « Jeu piloté » ne doit PAS polluer la charge utile
});

test('Personnaliser un pack SANS manette : la sauvegarde marche aussi', async ({ page }) => {
    await bootWith(page, 'keyboard');
    await page.locator('.nav[data-view="store"]').click();
    await page.locator('.bundle-card', { hasText: 'Pack Démo' }).locator('.customize').click();
    await expect(page.locator('#cx-rules')).not.toContainText(/Jeu piloté/i);
    await page.locator('#cx-save').click();
    await expect
        .poll(() => page.evaluate(() => (window.__E2E_CALLS__.customizeSave || []).length))
        .toBe(1);
});
