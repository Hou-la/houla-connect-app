const { test, expect } = require('@playwright/test');
const { boot } = require('./_boot');

// Un jeu ou un ÉMULATEUR qui lit ses manettes via SDL (Ryujinx, Dolphin, RetroArch, et
// beaucoup de jeux) n'a AUCUN besoin de notre DLL proxy : il présente une liste de manettes
// et laisse l'utilisateur choisir, il n'y a pas de « slot 0 » à détourner. Pire, la DLL lui
// NUIT : SDL résout l'ordinal 108 pour lire le VID/PID qui compose l'identité d'une manette.
//
// Vérifié le 2026-09-04 : SDL3.dll est livré à côté de Ryujinx.exe.
//
// Le piège d'affichage qu'on corrige ici : annoncer « Jeu prêt » serait FAUX. Il reste une
// manipulation, mais dans les réglages DU JEU. Un message rassurant qui laisse l'utilisateur
// devant un pack inerte est pire qu'une erreur.
const PACK = { slug: 'demo-pack', title: 'Pack Démo', version: '1.0.0', versionDate: '2026-01-01', bannerUrl: null, installCount: 0 };

const installer = async (page) => {
    await page.locator('.nav[data-view="store"]').click();
    await page.locator('.bundle-card', { hasText: 'Pack Démo' }).locator('.install').click();
};

test('jeu SDL : on dit d’aller le régler DANS le jeu, pas « Jeu prêt »', async ({ page }) => {
    await boot(page, {
        store: [PACK],
        usesGamepad: true,
        gamePackStatus: { exe: null, dir: null, placed: false },
        gameLinkResult: {
            ok: true, exe: 'C:/Ryujinx/Ryujinx.exe', dir: 'C:/Ryujinx', sdl: true,
            reason: 'Ce jeu lit les manettes via SDL : aucun fichier à poser.',
        },
    });
    await installer(page);
    await page.locator('#choice-actions button', { hasText: 'Choisir le fichier du jeu' }).click();

    const toast = page.locator('[data-toast="game"]');
    await expect(toast).toBeVisible({ timeout: 15000 });
    await expect(toast).toContainText(/réglage à faire dans le jeu/i);
    await expect(toast).toContainText(/Xbox 360 Controller/);
    // et surtout PAS le message qui laisserait croire qu'il n'y a plus rien à faire
    await expect(toast).not.toContainText(/Jeu prêt/);
});

test('CONTRE-TÉMOIN : un jeu NON-SDL garde « Jeu prêt » et sa consigne de relance', async ({ page }) => {
    // Sans lui, « le message SDL s'affiche » ne prouverait pas qu'il dépend vraiment du jeu.
    await boot(page, {
        store: [PACK],
        usesGamepad: true,
        gamePackStatus: { exe: null, dir: null, placed: false },
        gameLinkResult: { ok: true, exe: 'E:/Steam/Meccha/game.exe', dir: 'E:/Steam/Meccha' },
    });
    await installer(page);
    await page.locator('#choice-actions button', { hasText: 'Choisir le fichier du jeu' }).click();

    const toast = page.locator('[data-toast="game"]');
    await expect(toast).toBeVisible({ timeout: 15000 });
    await expect(toast).toContainText(/Jeu prêt/);
    await expect(toast).toContainText(/Relance le jeu/i);
    await expect(toast).not.toContainText(/Xbox 360 Controller/);
});
