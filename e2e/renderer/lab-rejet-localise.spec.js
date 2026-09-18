const { test, expect } = require('@playwright/test');
const { boot } = require('./_boot');

// LE REFUS DOIT DIRE OÙ (2026-09-18).
//
// Un créateur avait un pack de 34 règles refusé avec « Une commande a été jugée
// dangereuse », sans rien d'autre. Une seule règle était en cause. Il n'avait
// aucun moyen de savoir laquelle, et a passé sa soirée à relire son manifeste.
//
// Le serveur renvoie désormais `issues[]` (index, id et libellé de la règle).
// Comme `ipcMain.handle` ne sérialise QUE `message`/`stack` d'une Error, la
// charge voyage DANS le message derrière un marqueur — et c'est très exactement
// ce que ce test reproduit, puisque le mock rejette avec `new Error(message)`.
//
// CONTRE-TÉMOIN indispensable : « le toast contient du texte » est aussi vrai
// quand rien n'a été décodé. On vérifie donc qu'il nomme l'interaction 13 ET
// qu'il ne contient NI le JSON brut, NI la signature qui a déclenché le refus.

const MARQUEUR = '[[houla-rejection]]';

const MINE = {
    slug: 'gta-chaos', title: 'GTA Chaos', version: '1.0.0', visibility: 'private',
    description: 'd', game: '', creatorFeePercent: 0, bannerUrl: null, tags: [], instructions: '',
};

const refus = (issues, rejectionCodes = ['MALICIOUS_COMMAND']) =>
    MARQUEUR + JSON.stringify({
        message: 'Manifeste refusé par la garde statique.',
        errors: issues.map((i) => i.message),
        rejectionCodes,
        issues,
    });

const bootLab = (page, submitVersionError) => boot(page, {
    store: [],
    myBundles: [MINE],
    submitVersionError,
    labDetail: {
        bundle: MINE,
        versions: [{
            id: 'v1', version: '1.0.0', moderationStatus: 'approved', visibility: 'private',
            createdAt: '2026-01-01',
            // Déclencheur `follow` À DESSEIN : un déclencheur `gift` déclencherait
            // d'abord le garde « icône obligatoire », qui coupe AVANT tout appel
            // serveur (renderer.js, étape 2 sur 13). Ce test porte sur le refus
            // serveur, pas sur les icônes.
            manifestJson: {
                schema: 2,
                rules: [{ id: 'r1', on: { type: 'follow' }, effect: { type: 'keyboard', keys: 'space' } }],
            },
        }],
    },
});

async function enregistrer(page) {
    await page.locator('.nav[data-view="mine"]').click();
    await page.locator('.bundle-card', { hasText: 'GTA Chaos' }).locator('.edit').click();
    await expect(page.locator('#lab-mode-title')).toContainText(/Éditer/i);
    await page.locator('#lab-submit-btn').click();
    return page.locator('[data-toast="lab-save"] .toast__msg');
}

test('le refus NOMME l’interaction fautive, et dit quoi faire', async ({ page }) => {
    await bootLab(page, refus([{
        code: 'MALICIOUS_COMMAND',
        message: "effet 'http': le champ 'path' a été refusé par le contrôle de sécurité",
        ruleIndex: 12,
        ruleId: 'r13',
        ruleLabel: 'Tempête du sommet',
    }]));

    const msg = await enregistrer(page);
    await expect(msg).toContainText('interaction n° 13');
    await expect(msg).toContainText('Tempête du sommet');
    await expect(msg).toContainText('Une commande a été jugée dangereuse.');
    // La consigne « quoi faire », sans laquelle le créateur sait qu'il est
    // refusé mais pas par où commencer.
    await expect(msg).toContainText(/Renomme ou reformule/i);

    // CONTRE-TÉMOINS : ni JSON brut, ni marqueur, ni signature déclenchante.
    await expect(msg).not.toContainText('houla-rejection');
    await expect(msg).not.toContainText('{');
    await expect(msg).not.toContainText('rejectionCodes');
});

test('plusieurs problèmes : au plus trois lignes, puis un décompte', async ({ page }) => {
    await bootLab(page, refus(
        Array.from({ length: 5 }, (_, k) => ({
            code: 'INVALID_EFFECT',
            message: 'effet invalide',
            ruleIndex: k,
            ruleId: `r${k + 1}`,
            ruleLabel: `Interaction ${k + 1}`,
        })),
        ['INVALID_EFFECT'],
    ));

    const msg = await enregistrer(page);
    await expect(msg).toContainText('interaction n° 1');
    await expect(msg).toContainText('interaction n° 3');
    await expect(msg).toContainText('et 2 autres problèmes');
    // Un mur de cinq lignes ne se lit pas : la 4e ne doit PAS être détaillée.
    await expect(msg).not.toContainText('interaction n° 4');
});

test('les sauts de ligne sont RÉELLEMENT rendus (pre-line), pas collapsés', async ({ page }) => {
    // Sans `white-space: pre-line` sur `.toast__msg`, tout arrive en un seul pavé
    // et la consigne se noie dans la phrase précédente. Mesuré sur la hauteur
    // rendue plutôt que sur le texte, qui lui est identique dans les deux cas.
    await bootLab(page, refus([{
        code: 'MALICIOUS_COMMAND',
        message: 'refusé',
        ruleIndex: 12, ruleId: 'r13', ruleLabel: 'Tempête du sommet',
    }]));

    const msg = await enregistrer(page);
    await expect(msg).toBeVisible();
    expect(await msg.evaluate((el) => getComputedStyle(el).whiteSpace)).toBe('pre-line');
    // Deux lignes de texte + une ligne vide : la boîte doit dépasser une ligne.
    const h = await msg.evaluate((el) => el.getBoundingClientRect().height);
    const lh = await msg.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight));
    expect(h).toBeGreaterThan(lh * 2);
});

test('SERVEUR ANCIEN (aucun issues[]) : on reste lisible, sans JSON à l’écran', async ({ page }) => {
    // Un Connect à jour parlant à une API pas encore déployée. Chemin dégradé.
    await bootLab(page, 'MALICIOUS_COMMAND : Manifeste refusé par la garde statique.');

    const msg = await enregistrer(page);
    await expect(msg).toContainText('Une commande a été jugée dangereuse.');
    await expect(msg).toContainText(/Renomme ou reformule/i);
    await expect(msg).not.toContainText('MALICIOUS_COMMAND');
});

test('CONTRE-TÉMOIN : sans erreur, aucun toast de refus et le pack est enregistré', async ({ page }) => {
    // Sans lui, « le toast dit la bonne chose » pourrait venir d'un toast qui
    // s'affiche toujours.
    await bootLab(page, null);
    await page.locator('.nav[data-view="mine"]').click();
    await page.locator('.bundle-card', { hasText: 'GTA Chaos' }).locator('.edit').click();
    await page.locator('#lab-submit-btn').click();

    const toast = page.locator('[data-toast="lab-save"]');
    await expect(toast).toBeVisible();
    await expect(toast).not.toContainText(/échoué|échouée/i);
    await expect(toast).not.toContainText('interaction n°');
});
