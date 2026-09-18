const { test, expect } = require('@playwright/test');
const { boot } = require('./_boot');

// L'ILLUSTRATION N'EST PLUS UN PÉAGE (2026-09-18).
//
// Le garde « chaque cadeau personnalisé doit avoir une icône » était l'étape 2
// sur 13 de l'enregistrement, quand le refus serveur arrivait à l'étape 12. Un
// créateur fabriquait donc 34 icônes AVANT d'apprendre que son pack était
// refusé pour une raison sans aucun rapport avec elles.
//
// Rien n'est relâché : le serveur n'a jamais exigé `on.iconUrl` (optionnel dans
// le validateur, vérifié par exécution), `buildRule` omet la clé quand elle
// manque, et le repli existe (médaillon à l'éclair côté app, et désormais côté
// web où un `<img>` nu donnait une image cassée).
//
// Ce fichier est né d'un échec réel : le spec du refus localisé n'atteignait
// jamais le serveur, parce que ce garde coupait avant.

const MINE = {
    slug: 'gta-chaos', title: 'GTA Chaos', version: '1.0.0', visibility: 'private',
    description: 'd', game: '', creatorFeePercent: 0, bannerUrl: null, tags: [], instructions: '',
};

// `ix_slot_NN` + aucun `iconUrl` => le Lab en fait un « cadeau personnalisé »
// sans illustration (manifest-lib.js). C'est exactement le cas qui bloquait.
const regleSansIcone = (n) => ({
    id: `r${n}`,
    on: { type: 'gift', giftSlug: `ix_slot_${String(n).padStart(2, '0')}` },
    effect: { type: 'keyboard', keys: 'space' },
});

const bootLab = (page, rules) => boot(page, {
    store: [],
    myBundles: [MINE],
    labDetail: {
        bundle: MINE,
        versions: [{
            id: 'v1', version: '1.0.0', moderationStatus: 'approved', visibility: 'private',
            createdAt: '2026-01-01',
            manifestJson: { schema: 2, rules },
        }],
    },
});

async function enregistrer(page) {
    await page.locator('.nav[data-view="mine"]').click();
    await page.locator('.bundle-card', { hasText: 'GTA Chaos' }).locator('.edit').click();
    await expect(page.locator('#lab-mode-title')).toContainText(/Éditer/i);
    await page.locator('#lab-submit-btn').click();
}

test('un pack SANS aucune icône part bien au serveur', async ({ page }) => {
    await bootLab(page, [regleSansIcone(1)]);
    await enregistrer(page);

    // LE point : l'appel serveur a réellement eu lieu.
    const appels = await page.evaluate(() => window.__E2E_CALLS__.submitVersion || []);
    expect(appels.length).toBe(1);

    const toast = page.locator('[data-toast="lab-save"]');
    await expect(toast).toContainText(/enregistrée/i);
    // CONTRE-TÉMOIN : l'ancien message bloquant ne doit plus jamais apparaître.
    await expect(toast).not.toContainText(/doit avoir une icône/i);
});

test('on DIT combien d’illustrations restent, au singulier comme au pluriel', async ({ page }) => {
    await bootLab(page, [regleSansIcone(1), regleSansIcone(2), regleSansIcone(3)]);
    await enregistrer(page);

    const msg = page.locator('[data-toast="lab-save"] .toast__msg');
    await expect(msg).toContainText('Il reste 3 illustrations à ajouter');
    // Le repli est NOMMÉ : le créateur sait ce que verra le viewer.
    await expect(msg).toContainText(/médaillon à l’éclair/i);
});

test('une seule manquante : la phrase reste au singulier', async ({ page }) => {
    await bootLab(page, [regleSansIcone(1)]);
    await enregistrer(page);

    const msg = page.locator('[data-toast="lab-save"] .toast__msg');
    await expect(msg).toContainText('Il reste 1 illustration à ajouter');
    await expect(msg).not.toContainText('illustrations');
    await expect(msg).toContainText(/ce cadeau s’affiche/i);
});

test('CONTRE-TÉMOIN : toutes les icônes posées, aucun décompte', async ({ page }) => {
    // Sans lui, « le toast parle d'illustrations » pourrait être vrai toujours.
    const avecIcone = {
        ...regleSansIcone(1),
        on: { type: 'gift', giftSlug: 'ix_slot_01', iconUrl: 'https://cdn.hou.la/a.png' },
    };
    await bootLab(page, [avecIcone]);
    await enregistrer(page);

    const msg = page.locator('[data-toast="lab-save"] .toast__msg');
    await expect(msg).toContainText(/enregistrée|enregistrées/i);
    await expect(msg).not.toContainText('Il reste');
    await expect(msg).not.toContainText('illustration');
});

test('CONTRE-TÉMOIN : les autres gardes bloquants, eux, bloquent TOUJOURS', async ({ page }) => {
    // Retirer le péage de l'icône ne doit pas avoir ouvert les vannes : un
    // déclencheur incomplet doit encore couper avant tout appel serveur.
    await bootLab(page, [{
        id: 'r1', on: { type: 'viewer' }, effect: { type: 'keyboard', keys: 'space' },
    }]);
    await enregistrer(page);

    await expect(page.locator('[data-toast="lab-save"]')).toContainText(/Déclencheur incomplet/i);
    const appels = await page.evaluate(() => window.__E2E_CALLS__.submitVersion || []);
    expect(appels.length).toBe(0);
});
