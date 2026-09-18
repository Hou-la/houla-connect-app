const { test, expect } = require('@playwright/test');
const { boot } = require('./_boot');

// L'APERÇU MENTAIT (2026-09-18).
//
// Le créateur écrivait deux paragraphes séparés par une ligne vide, l'aperçu
// les affichait collés, et il en concluait que le saut de ligne était ignoré.
// Le rendu FINAL, lui, était correct depuis la 0.1.47.
//
// La cause n'était pas le moteur Markdown : les quatre conteneurs d'aperçu ne
// portaient pas la classe `.md-body`, à laquelle TOUTE la typographie est
// scopée — et le reset global `* { margin: 0 }` écrasait le reste. Un double
// saut rendait donc exactement comme un simple.
//
// Ces tests mesurent la GÉOMÉTRIE, pas le balisage : « il y a deux <p> » était
// déjà vrai avant, et n'a jamais empêché le bug de se voir à l'écran.

const MINE = {
    slug: 'mon-pack', title: 'Mon Pack', version: '1.0.0', visibility: 'private',
    description: '', game: '', creatorFeePercent: 0, bannerUrl: null, tags: [], instructions: '',
};

const bootLab = (page) => boot(page, {
    store: [],
    myBundles: [MINE],
    labDetail: {
        bundle: MINE,
        versions: [{
            id: 'v1', version: '1.0.0', moderationStatus: 'approved', visibility: 'private',
            createdAt: '2026-01-01',
            manifestJson: { schema: 2, rules: [{ id: 'r1', on: { type: 'follow' }, effect: { type: 'keyboard', keys: 'space' } }] },
        }],
    },
});

/** Écrit dans la description puis bascule sur l'onglet Aperçu. */
async function apercu(page, texte) {
    await page.locator('.nav[data-view="lab"]').click();
    await page.locator('#lab-desc').fill(texte);
    await page.locator('#lab-desc-preview-tab').click();
    const prev = page.locator('#lab-desc-preview');
    await expect(prev).toBeVisible();
    return prev;
}

test('le conteneur d’aperçu porte bien « md-body »', async ({ page }) => {
    await bootLab(page);
    const prev = await apercu(page, 'Bonjour');
    await expect(prev).toHaveClass(/\bmd-body\b/);
});

test('les QUATRE surfaces de rendu portent « md-body »', async ({ page }) => {
    // Poser la classe dans `renderMarkdownInto` rend tous les appelants
    // cohérents par construction. Ce test le prouve là où c'est vérifiable
    // sans ouvrir chaque modale : les deux aperçus du Lab.
    await bootLab(page);
    await apercu(page, 'Bonjour');
    await page.locator('#lab-instructions').fill('Étape 1');
    await page.locator('#lab-instr-preview-tab').click();

    await expect(page.locator('#lab-desc-preview')).toHaveClass(/\bmd-body\b/);
    await expect(page.locator('#lab-instr-preview')).toHaveClass(/\bmd-body\b/);
});

test('un DOUBLE saut sépare VISIBLEMENT deux paragraphes', async ({ page }) => {
    await bootLab(page);
    const prev = await apercu(page, 'Premier paragraphe.\n\nSecond paragraphe.');

    const ps = prev.locator('p');
    await expect(ps).toHaveCount(2);

    // LE point : l'écart vertical RÉEL entre les deux blocs. Avec `* {margin:0}`
    // et sans `.md-body`, les deux `<p>` existaient déjà mais se touchaient.
    const ecart = await prev.evaluate((el) => {
        const [a, b] = el.querySelectorAll('p');
        return b.getBoundingClientRect().top - a.getBoundingClientRect().bottom;
    });
    expect(ecart).toBeGreaterThan(4);
});

test('un saut SIMPLE reste dans le même paragraphe, avec un retour à la ligne', async ({ page }) => {
    await bootLab(page);
    const prev = await apercu(page, 'Ligne A\nLigne B');

    await expect(prev.locator('p')).toHaveCount(1);
    expect(await prev.locator('p br').count()).toBe(1);
});

test('CONTRE-TÉMOIN : simple et double ne rendent PAS la même hauteur', async ({ page }) => {
    // Sans ce témoin, « il y a un écart » pourrait être vrai dans les deux cas
    // et ne rien prouver du tout.
    await bootLab(page);

    const prevSimple = await apercu(page, 'Ligne A\nLigne B');
    const hSimple = await prevSimple.evaluate((el) => el.scrollHeight);

    await page.locator('#lab-desc-edit-tab').click();
    const prevDouble = await apercu(page, 'Ligne A\n\nLigne B');
    const hDouble = await prevDouble.evaluate((el) => el.scrollHeight);

    expect(hDouble).toBeGreaterThan(hSimple);
});

test('une citation multi-lignes garde ses lignes (plus de jointure à l’espace)', async ({ page }) => {
    await bootLab(page);
    const prev = await apercu(page, '> Première ligne\n> Deuxième ligne');

    const bq = prev.locator('blockquote');
    await expect(bq).toHaveCount(1);
    expect(await bq.locator('br').count()).toBe(1);
    await expect(bq).toContainText('Première ligne');
    await expect(bq).toContainText('Deuxième ligne');
});
