const { test, expect } = require('@playwright/test');
const { boot } = require('./_boot');

// UTILISER SES PROPRES PACKS, PRIVÉS COMPRIS (2026-09-18).
//
// Il n'y avait AUCUN verrou de sécurité à lever : `getManifest` autorise depuis
// toujours le propriétaire à récupérer son pack privé, y compris un brouillon
// jamais approuvé, et c'est explicitement testé côté API. Ce qui manquait était
// un chemin dans l'UI : la carte de « Mes bundles » ne portait que « Voir les
// stats » et « Éditer », et « Installer » n'existait que sur les cartes du
// Store — lequel ne liste que le public approuvé.
//
// La garde tiers ne bouge pas : le Store continue de ne lister que le public
// approuvé, et le pack privé d'un AUTRE workspace reste refusé par le serveur.

const pack = (over = {}) => ({
    slug: 'mon-pack', title: 'Mon Pack', version: '1.0.0', visibility: 'private',
    description: '', game: '', creatorFeePercent: 0, bannerUrl: null, tags: [],
    instructions: '', earnedStars: 0, earnedCreatorStars: 0, growthPct: null,
    ...over,
});

const bootMine = (page, bundles, installed = []) => boot(page, {
    store: [],
    installed,
    myBundles: bundles,
});

const carte = (page, titre) => page.locator('.bundle-card', { hasText: titre });

test('un pack PRIVÉ porte un bouton « Utiliser » et s’installe vraiment', async ({ page }) => {
    await bootMine(page, [pack()]);
    await page.locator('.nav[data-view="mine"]').click();

    const bouton = carte(page, 'Mon Pack').locator('.use');
    await expect(bouton).toHaveText('Utiliser');

    await bouton.click();

    // LE point : c'est bien le chemin d'installation du Store qui est réutilisé.
    await expect
        .poll(() => page.evaluate(() => (window.__E2E_CALLS__.install || []).map((a) => a[0])))
        .toEqual(['mon-pack']);
    await expect(bouton).toHaveText('Installé ✓');
});

test('déjà installé : le bouton le DIT, et n’installe pas une seconde fois', async ({ page }) => {
    await bootMine(page, [pack()], [{ slug: 'mon-pack', version: '1.0.0' }]);
    await page.locator('.nav[data-view="mine"]').click();

    const bouton = carte(page, 'Mon Pack').locator('.use');
    await expect(bouton).toHaveText('Installé ✓');

    await bouton.click();
    // Il emmène à Capture au lieu de réinstaller.
    await expect(page.locator('#view-capture')).toBeVisible();
    const appels = await page.evaluate(() => window.__E2E_CALLS__.install || []);
    expect(appels.length).toBe(0);
});

test('AUCUNE version : pas de bouton du tout, il n’y aurait rien à installer', async ({ page }) => {
    await bootMine(page, [pack({ version: null })]);
    await page.locator('.nav[data-view="mine"]').click();

    await expect(carte(page, 'Mon Pack')).toBeVisible(); // la carte existe bel et bien
    await expect(carte(page, 'Mon Pack').locator('.use')).toHaveCount(0);
});

test('CONTRE-TÉMOIN : les boutons existants sont intacts', async ({ page }) => {
    // Sans lui, « il y a un bouton .use » pourrait venir d'une carte cassée.
    await bootMine(page, [pack()]);
    await page.locator('.nav[data-view="mine"]').click();

    await expect(carte(page, 'Mon Pack').locator('.edit')).toHaveText('Éditer');
    await expect(carte(page, 'Mon Pack').locator('.stats')).toHaveText('Voir les stats');
});

test('CONTRE-TÉMOIN : le Store ne s’est pas mis à lister les packs privés', async ({ page }) => {
    // La frontière qui compte : « Mes bundles » expose MES packs privés, le
    // Store n'expose que le public approuvé. Le store mocké est vide ici, donc
    // aucune carte de pack ne doit apparaître dans cette vue.
    await bootMine(page, [pack()]);
    await page.locator('.nav[data-view="store"]').click();

    await expect(page.locator('#store-list .bundle-card')).toHaveCount(0);
});
