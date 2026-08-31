const { test, expect } = require('@playwright/test');
const { boot } = require('./_boot');

// LE test qui manquait et qui aurait attrapé le bug remonté par l'utilisateur :
// on écrit des « Instructions / prérequis », on enregistre, on rouvre -> ça doit être là.
// Deux causes se cumulaient : (1) l'API droppait `instructions` (createBundle/updateBundle
// ne le mappaient pas), (2) en ÉDITION, « Enregistrer la version » n'appelait jamais
// lab.update -> la saisie ne partait même pas. Ces tests verrouillent le CONTRAT CLIENT
// (les instructions PARTENT au serveur) ; le test unitaire serveur verrouille la persistance.

async function gotoCreateLab(page) {
    await boot(page);
    await page.locator('.nav[data-view="lab"]').click();
    await expect(page.locator('#view-lab')).toBeVisible();
    // enterCreateMode() tourne APRÈS des await et efface slug/titre : on attend l'interaction
    // par défaut (r-keys) avant de saisir.
    await expect(page.locator('#view-lab .r-keys')).toBeVisible();
    await page.fill('#lab-slug', 'mon-pack');
    await page.fill('#lab-title', 'Mon Pack');
}

test('création : les instructions saisies PARTENT au serveur (create)', async ({ page }) => {
    await gotoCreateLab(page);
    await page.fill('#lab-instructions', '# Prérequis\n- Serveur RCON activé');
    await page.locator('#lab-submit-btn').click(); // bouton UNIQUE « Créer le pack »
    await expect
        .poll(() => page.evaluate(() => (window.__E2E_CALLS__.create || []).map((a) => a[0] && a[0].instructions)))
        .toContain('# Prérequis\n- Serveur RCON activé');
});

// Édition : le pack a déjà des instructions en base + une version au manifeste valide.
const EDIT_BUNDLE = {
    slug: 'mario-pack', title: 'Mario Kart', description: 'course de kart',
    game: 'mario-kart', instructions: '# Prérequis\n- Manette branchée',
    visibility: 'private', creatorFeePercent: 0, tags: [], bannerUrl: null,
};
const EDIT_VERSION = {
    version: '1.0.0', visibility: 'private', moderationStatus: 'approved', createdAt: '2026-01-01T00:00:00Z',
    manifestJson: { schema: 2, rules: [{ on: { type: 'gift', giftSlug: 'licorne' }, effect: { type: 'keyboard', keys: 'space' } }] },
};

test('édition : instructions RECHARGÉES puis RENVOYÉES par l\'unique bouton (LE bug)', async ({ page }) => {
    await boot(page, {
        myBundles: [{ slug: 'mario-pack', title: 'Mario Kart', version: '1.0.0', visibility: 'private', creatorFeePercent: 0, publisher: null }],
        labDetail: { bundle: EDIT_BUNDLE, versions: [EDIT_VERSION] },
    });
    await page.locator('.nav[data-view="mine"]').click();
    await expect(page.locator('#view-mine .bundle-card .edit').first()).toBeVisible();
    await page.locator('#view-mine .bundle-card .edit').first().click();

    // Chemin de LECTURE : le champ contient ce qui était réellement en base.
    await expect(page.locator('#lab-instructions')).toHaveValue(/Prérequis/);

    // L'utilisateur modifie les instructions puis clique sur l'UNIQUE bouton du bas.
    await page.fill('#lab-instructions', '# Nouveau prérequis\n- Manette Switch Pro');
    await page.locator('#lab-submit-btn').click();

    // Le gros bouton DOIT enregistrer les instructions (via lab.update)...
    await expect
        .poll(() => page.evaluate(() => (window.__E2E_CALLS__.update || []).map((a) => a[1] && a[1].instructions)))
        .toContain('# Nouveau prérequis\n- Manette Switch Pro');
    // ...ET soumettre la version : un seul bouton sauve TOUT.
    expect(await page.evaluate(() => (window.__E2E_CALLS__.submitVersion || []).length)).toBeGreaterThan(0);
});

test('un seul bouton d\'enregistrement dans le Lab (plus de « Enregistrer les infos »)', async ({ page }) => {
    await gotoCreateLab(page);
    // La barre d'action unique existe ; l'ancien second bouton a disparu.
    await expect(page.locator('#lab-actionbar #lab-submit-btn')).toBeVisible();
    expect(await page.locator('#lab-save-meta').count()).toBe(0);
});
