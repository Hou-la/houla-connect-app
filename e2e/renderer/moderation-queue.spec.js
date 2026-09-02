const { test, expect } = require('@playwright/test');
const { boot } = require('./_boot');

// CONSTAT PROD (2026-09-03) : 13 versions bloquées en modération, dont 10 soumises par un
// créateur TIERS entre le 30/08 et le 01/09. L'IA de modération ne peut que REFUSER, jamais
// approuver ; l'étape humaine était le seul chemin vers la publication, et elle n'existait
// nulle part — ni alerte, ni écran, ni rappel. Aucun pack tiers n'a donc JAMAIS été publié.
const V = (id, slug, title, version, jours, statut) => ({
    version: {
        id, version, moderationStatus: statut || 'in_review', visibility: 'public',
        createdAt: new Date(Date.now() - jours * 86400000).toISOString(),
    },
    bundle: { slug, title },
});

const QUEUE = {
    ok: true,
    items: [
        V('v-mk-9', 'mk8dx-6a85262f21b90364-1', 'Mario Kart 8 Deluxe', '1.0.9', 3),
        V('v-meccha-7', 'meccha-chameleon', 'Meccha Chameleon', '1.0.7', 0),
    ],
};

test('l’onglet Modération est CACHÉ pour un compte non-admin', async ({ page }) => {
    await boot(page, { isAdmin: false });
    await expect(page.locator('#nav-moderation')).toBeHidden();
});

test('admin : la file affiche les versions en attente et leur ancienneté', async ({ page }) => {
    await boot(page, { isAdmin: true, moderationQueue: QUEUE });
    await expect(page.locator('#nav-moderation')).toBeVisible();
    await page.locator('.nav[data-view="moderation"]').click();

    await expect(page.locator('.mod-row')).toHaveCount(2);
    const mk = page.locator('.mod-row', { hasText: 'Mario Kart 8 Deluxe' });
    await expect(mk).toContainText('v1.0.9');
    // l'ancienneté est écrite en TEXTE (jamais un simple code couleur)
    await expect(mk).toContainText(/en attente depuis 3 j/i);
    // le statut technique est traduit, pas affiché brut
    await expect(mk).not.toContainText('in_review');
    await expect(mk).toContainText(/relecture/i);
});

test('approuver appelle bien moderation.approve avec l’id de la VERSION', async ({ page }) => {
    await boot(page, { isAdmin: true, moderationQueue: QUEUE });
    await page.locator('.nav[data-view="moderation"]').click();
    await page.locator('.mod-row', { hasText: 'Mario Kart' }).locator('.mod-approve').click();
    await expect
        .poll(() => page.evaluate(() => (window.__E2E_CALLS__.modApprove || []).map((a) => a[0])))
        .toEqual(['v-mk-9']);
});

test('refuser EXIGE un motif, et le motif part avec le refus', async ({ page }) => {
    await boot(page, { isAdmin: true, moderationQueue: QUEUE });
    await page.locator('.nav[data-view="moderation"]').click();
    await page.locator('.mod-row', { hasText: 'Meccha' }).locator('.mod-reject').click();

    // une modale de motif s'ouvre : refuser sans explication laisse le créateur deviner
    await expect(page.locator('#choice-modal')).toBeVisible();
    await expect(page.locator('#choice-title')).toContainText(/Refuser/i);
    await page.locator('#choice-actions button', { hasText: 'Instructions insuffisantes' }).click();

    await expect
        .poll(() => page.evaluate(() => (window.__E2E_CALLS__.modReject || []).map((a) => [a[0], a[1]])))
        .toEqual([['v-meccha-7', 'Instructions insuffisantes pour un joueur.']]);
});

test('un échec serveur est AFFICHÉ, pas avalé', async ({ page }) => {
    await boot(page, {
        isAdmin: true, moderationQueue: QUEUE,
        moderationApproveResult: { ok: false, reason: 'Approbation refusée (403).' },
    });
    await page.locator('.nav[data-view="moderation"]').click();
    await page.locator('.mod-row', { hasText: 'Mario Kart' }).locator('.mod-approve').click();
    await expect(page.locator('.mod-row', { hasText: 'Mario Kart' }).locator('.mod-row__res'))
        .toContainText(/403/);
});

test('file vide : on le DIT, au lieu d’afficher un écran blanc', async ({ page }) => {
    // CONTRE-TÉMOIN : « rien à l'écran » est exactement ce qu'on verrait si la file n'avait
    // pas chargé du tout. Le message explicite est ce qui distingue les deux cas.
    await boot(page, { isAdmin: true, moderationQueue: { ok: true, items: [] } });
    await page.locator('.nav[data-view="moderation"]').click();
    await expect(page.locator('#mod-list')).toContainText(/Aucune version en attente/i);
});

test('file indisponible : l’erreur est visible', async ({ page }) => {
    await boot(page, { isAdmin: true, moderationQueue: { ok: false, reason: 'File de modération indisponible (500).' } });
    await page.locator('.nav[data-view="moderation"]').click();
    await expect(page.locator('#mod-list')).toContainText(/500/);
});
