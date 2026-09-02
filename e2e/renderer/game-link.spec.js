const { test, expect } = require('@playwright/test');
const { boot } = require('./_boot');

// Le jeu piloté appartient au PACK, pas au connecteur manette (la manette sert à tous les
// jeux). On le demande UNE fois, à l'installation d'un pack manette ; ensuite c'est automatique.
const PACK = { slug: 'demo-pack', title: 'Pack Démo', version: '1.0.0', versionDate: '2026-01-01', bannerUrl: null, installCount: 0 };
const GAMEPAD_CX = { id: 'local-gamepad', type: 'gamepad', name: 'Manette virtuelle (ViGEm)', enabled: true };

test('install d’un pack MANETTE : on demande le jeu et « Choisir mon jeu » appelle game.linkPack', async ({ page }) => {
    await boot(page, {
        store: [PACK],
        connectors: [GAMEPAD_CX],
        // La manette est un connecteur LOCAL : elle n'est PAS dans requiredConnectors (réservé
        // au réseau). C'est ce drapeau qui dit qu'un pack la pilote — le bug corrigé ici.
        usesGamepad: true,
        gamePackStatus: { exe: null, dir: null, placed: false }, // aucun jeu connu pour ce pack
    });
    await page.locator('.nav[data-view="store"]').click();
    await page.locator('.bundle-card', { hasText: 'Pack Démo' }).locator('.install').click();

    // La modale explique et propose de choisir le jeu
    await expect(page.locator('#choice-modal')).toBeVisible();
    await expect(page.locator('#choice-title')).toContainText(/quel jeu/i);
    // Aucun jeu detecte -> repli sur l'explorateur
    await page.locator('#choice-actions button', { hasText: 'Choisir le fichier du jeu' }).click();

    await expect
        .poll(() => page.evaluate(() => (window.__E2E_CALLS__.gameLinkPack || []).map((a) => a[0])))
        .toContain('demo-pack'); // lié AU PACK, pas au connecteur
});

test('install d’un pack MANETTE : le jeu LANCÉ est propose en 1 clic (sans explorateur)', async ({ page }) => {
    await boot(page, {
        store: [PACK],
        connectors: [GAMEPAD_CX],
        usesGamepad: true,
        gamePackStatus: { exe: null, dir: null, placed: false },
        // L'app reconnait le jeu qui tourne : on doit pouvoir cliquer son NOM directement.
        gameDetected: [{ name: 'MECCHA CHAMELEON', exe: 'E:/steam/steamapps/common/MECCHA CHAMELEON/g.exe', dir: 'E:/steam/steamapps/common/MECCHA CHAMELEON' }],
    });
    await page.locator('.nav[data-view="store"]').click();
    await page.locator('.bundle-card', { hasText: 'Pack Démo' }).locator('.install').click();
    await expect(page.locator('#choice-modal')).toBeVisible();
    await page.locator('#choice-actions button', { hasText: 'MECCHA CHAMELEON' }).click();
    await expect
        .poll(() => page.evaluate(() => (window.__E2E_CALLS__.gameLinkPackTo || []).map((a) => a[0])))
        .toContain('demo-pack'); // lié sans passer par l'explorateur
});

test('install d’un pack SANS manette : aucune demande de jeu', async ({ page }) => {
    await boot(page, { store: [PACK], usesGamepad: false });
    await page.locator('.nav[data-view="store"]').click();
    await page.locator('.bundle-card', { hasText: 'Pack Démo' }).locator('.install').click();
    await expect(page.locator('.bundle-card', { hasText: 'Pack Démo' }).locator('.install')).toContainText(/Installé/i);
    // jamais demandé : pas de manette dans ce pack
    expect(await page.evaluate(() => (window.__E2E_CALLS__.gameLinkPack || []).length)).toBe(0);
});

test('Connecteurs : la ligne manette montre le NOMBRE de jeux liés (pas un jeu unique)', async ({ page }) => {
    await boot(page, {
        connectors: [GAMEPAD_CX],
        gameLinked: [
            { slug: 'pack-a', exe: 'D:/Games/A/a.exe', dir: 'D:/Games/A', placed: true },
            { slug: 'pack-b', exe: 'D:/Games/B/b.exe', dir: 'D:/Games/B', placed: true },
        ],
    });
    await page.locator('.nav[data-view="connecteurs"]').click();
    await expect(page.locator('#view-connecteurs')).toBeVisible();
    await expect(page.locator('.cx-row .cx-games')).toContainText(/2 jeux liés/i);
});

test('Connecteurs : « Jeux liés » permet de retirer -> game.unlinkPack(slug)', async ({ page }) => {
    await boot(page, {
        connectors: [GAMEPAD_CX],
        gameLinked: [{ slug: 'pack-a', exe: 'D:/Games/A/a.exe', dir: 'D:/Games/A', placed: true }],
    });
    await page.locator('.nav[data-view="connecteurs"]').click();
    await page.locator('.cx-row .cx-games').click();
    await expect(page.locator('#choice-modal')).toBeVisible();
    await page.locator('#choice-actions button', { hasText: 'Retirer a.exe' }).click();
    await expect
        .poll(() => page.evaluate(() => (window.__E2E_CALLS__.gameUnlinkPack || []).map((a) => a[0])))
        .toContain('pack-a');
});
