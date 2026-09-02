const { test, expect } = require('@playwright/test');
const { boot } = require('./_boot');

// RÉGRESSION VÉCUE : après avoir édité un pack, l'onglet « Lab » restait collé sur CE pack.
// Il devenait impossible d'en créer un nouveau — donc impossible de tester quoi que ce soit.
// La condition fautive prétendait « garder l'édition en cours », mais elle ne protégeait
// rien : loadLab() remet labDirty à false, et la garde de switchView a déjà fait enregistrer
// ou abandonner au moment de quitter.
//
// CONTRE-TÉMOIN indispensable : « le formulaire est vide » est aussi ce qu'on observerait si
// le Lab n'avait rien chargé du tout. On vérifie donc en plus que le titre est bien repassé
// à « Créer un pack » et que le champ slug est REDEVENU modifiable (il est en lecture seule
// en édition) — deux signes que le mode a réellement basculé.
const MINE = {
    slug: 'mon-pack', title: 'Mon Pack', version: '1.0.0', visibility: 'private',
    description: 'desc', game: '', creatorFeePercent: 0, bannerUrl: null, tags: [],
    instructions: 'Instructions du pack.',
};

const bootLab = (page) => boot(page, {
    store: [],
    myBundles: [MINE],
    labDetail: { bundle: MINE, versions: [{ id: 'v1', version: '1.0.0', moderationStatus: 'approved', visibility: 'private', createdAt: '2026-01-01', manifestJson: { schema: 2, rules: [{ id: 'r1', on: { type: 'gift', giftSlug: 'ix_slot_01' }, effect: { type: 'keyboard', keys: 'space' } }] } }] },
});

test('éditer un pack puis revenir au Lab : on peut créer un NOUVEAU pack', async ({ page }) => {
    await bootLab(page);

    // 1) on édite un pack existant depuis « Mes bundles »
    await page.locator('.nav[data-view="mine"]').click();
    await page.locator('.bundle-card', { hasText: 'Mon Pack' }).locator('.edit').click();
    await expect(page.locator('#lab-mode-title')).toContainText(/Éditer/i);
    await expect(page.locator('#lab-slug')).toHaveValue('mon-pack');

    // 2) on part ailleurs, puis on revient sur l'onglet Lab
    await page.locator('.nav[data-view="store"]').click();
    await page.locator('.nav[data-view="lab"]').click();

    // 3) LE BUG : on doit être sur un pack NEUF, pas sur « mon-pack »
    await expect(page.locator('#lab-mode-title')).toContainText(/Créer un pack/i);
    await expect(page.locator('#lab-slug')).toHaveValue('');
    await expect(page.locator('#lab-title')).toHaveValue('');
    // contre-témoins : le mode a VRAIMENT basculé (pas juste des champs vidés)
    await expect(page.locator('#lab-slug')).not.toHaveAttribute('readonly', /.*/);
    await expect(page.locator('#lab-submit-btn')).toContainText(/Créer le pack/i);
    // ... et le Lab a bien chargé (une interaction vierge est présente)
    await expect(page.locator('#lab-rules .rule')).toHaveCount(1);
});

test('re-cliquer sur l’onglet Lab pendant une édition ne l’efface PAS', async ({ page }) => {
    await bootLab(page);
    await page.locator('.nav[data-view="mine"]').click();
    await page.locator('.bundle-card', { hasText: 'Mon Pack' }).locator('.edit').click();
    await expect(page.locator('#lab-slug')).toHaveValue('mon-pack');

    // on reclique sur l'onglet où l'on se trouve déjà : rien ne doit bouger
    await page.locator('.nav[data-view="lab"]').click();
    await expect(page.locator('#lab-mode-title')).toContainText(/Éditer/i);
    await expect(page.locator('#lab-slug')).toHaveValue('mon-pack');
});

test('« + Nouveau pack » depuis l’édition remet aussi un formulaire vierge', async ({ page }) => {
    await bootLab(page);
    await page.locator('.nav[data-view="mine"]').click();
    await page.locator('.bundle-card', { hasText: 'Mon Pack' }).locator('.edit').click();
    await expect(page.locator('#lab-new-btn')).toBeVisible(); // visible seulement en édition
    await page.locator('#lab-new-btn').click();
    await expect(page.locator('#lab-mode-title')).toContainText(/Créer un pack/i);
    await expect(page.locator('#lab-slug')).toHaveValue('');
});
