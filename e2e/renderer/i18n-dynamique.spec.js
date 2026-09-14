const { test, expect } = require('@playwright/test');
const { boot } = require('./_boot');
const EN = require('../../src/renderer/locales/en.json');

// L'INTERNATIONALISATION, VUE DE L'ÉCRAN (2026-09-14).
//
// Deux défauts empilés, invisibles l'un derrière l'autre :
//   1. les catalogues n'étaient JAMAIS chargés (fetch depuis une page `file:` avec
//      `connect-src 'none'`) : l'app restait en français quelle que soit la langue ;
//   2. une fois le chargement réparé, sept libellés du Lab et de la modale connecteur
//      étaient RÉÉCRITS en français en dur par le code au premier geste.
// Le harnais sert la page en http, où `fetch` marche : aucun test ne voyait (1). Ces
// tests passent donc par le vrai canal (`i18nCatalog`) et le vrai catalogue anglais.

const MINE = {
    slug: 'mario-kart', title: 'Mario Kart', version: '1.0.0', visibility: 'private',
    description: 'd', game: '', creatorFeePercent: 5, bannerUrl: null, tags: [], instructions: '',
};
const bootEn = (page) => boot(page, {
    catalogs: { en: EN },
    store: [],
    myBundles: [MINE],
    labDetail: {
        bundle: MINE,
        versions: [{
            id: 'v1', version: '1.0.0', moderationStatus: 'approved', visibility: 'private', createdAt: '2026-01-01',
            manifestJson: { schema: 2, rules: [{ id: 'r1', on: { type: 'follow' }, effect: { type: 'keyboard', keys: 'space' } }] },
        }],
    },
});

async function passerEnAnglais(page) {
    await page.locator('.nav[data-view="settings"]').click();
    await page.locator('#lang').selectOption('en');
    // Signe DISCRIMINANT du chargement : un libellé du HTML passe en anglais.
    await expect(page.locator('.nav[data-view="settings"]')).toContainText(/Settings/);
}

test('le catalogue anglais est RÉELLEMENT appliqué', async ({ page }) => {
    await bootEn(page);
    await passerEnAnglais(page);
});

test('édition d’un pack en anglais : titre et bouton restent en anglais', async ({ page }) => {
    // Avant : « Éditer : mario-kart » et « Enregistrer », dès l'ouverture du pack.
    await bootEn(page);
    await passerEnAnglais(page);
    await page.locator('.nav[data-view="mine"]').click();
    await page.locator('.bundle-card', { hasText: 'Mario Kart' }).locator('.edit').click();

    await expect(page.locator('#lab-mode-title')).toHaveText('Edit: mario-kart');
    await expect(page.locator('#lab-submit-btn')).toHaveText('Save');
    await expect(page.locator('#lab-fee-val')).toContainText('of the stars');
});

test('langue appliquée PENDANT l’édition : pas de retour au libellé du démarrage', async ({ page }) => {
    // `apply()` réécrit depuis la clé HTML (« Create a pack ») : sans re-rendu des
    // libellés dynamiques, un pack en cours d'édition s'afficherait comme une création.
    //
    // On applique la langue SANS quitter le Lab : en sortir remet volontairement le Lab
    // en création (régression corrigée et testée dans lab-new-after-edit.spec.js), ce
    // qui masquerait exactement le défaut que ce test cherche.
    await bootEn(page);
    await page.locator('.nav[data-view="mine"]').click();
    await page.locator('.bundle-card', { hasText: 'Mario Kart' }).locator('.edit').click();
    await expect(page.locator('#lab-mode-title')).toHaveText('Éditer : mario-kart');

    await page.evaluate(() => applyLanguage('en'));
    await expect(page.locator('#lab-mode-title')).toHaveText('Edit: mario-kart');
    await expect(page.locator('#lab-submit-btn')).toHaveText('Save');
});

test('CONTRE-TÉMOIN : sans changer de langue, tout reste en français', async ({ page }) => {
    // Sans lui, « c'est en anglais » pourrait venir d'un libellé anglais en dur.
    await bootEn(page);
    await page.locator('.nav[data-view="mine"]').click();
    await page.locator('.bundle-card', { hasText: 'Mario Kart' }).locator('.edit').click();
    await expect(page.locator('#lab-mode-title')).toHaveText('Éditer : mario-kart');
    await expect(page.locator('#lab-submit-btn')).toHaveText('Enregistrer');
});
