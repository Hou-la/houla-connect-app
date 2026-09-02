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

// ── « Je valide à l'aveugle » ──────────────────────────────────────────────
// Retour du propriétaire : impossible de voir ce que contient une version, ni ce qui a
// changé depuis la précédente. Et surtout : il a approuvé 10 versions PRIVÉES du pack
// Mario Kart, ce qui ne publie RIEN (le pointeur public n'est posé que pour une version
// publique), sans que rien ne l'en avertisse.
const MANIFEST = (rules) => ({ schema: 2, slug: 'mk8dx', rules });
const R = (id, label, effect) => ({ id, label, on: { type: 'gift', giftSlug: 'ix_slot_01' }, effect });

const QUEUE_DIFF = {
    ok: true,
    items: [{
        version: {
            id: 'v-2', version: '1.0.9', moderationStatus: 'in_review', visibility: 'private',
            createdAt: new Date().toISOString(),
            changelog: 'Ajout du saut',
            capabilities: ['gamepad'], hostAllowlist: [],
            manifestJson: MANIFEST([
                R('r1', 'Accélérer', { type: 'gamepad', button: 'A' }),
                R('r3', 'Objet', { type: 'gamepad', button: 'X' }),          // AJOUTÉE
                R('r2', 'Klaxon', { type: 'rcon', command: 'say hop' }),      // MODIFIÉE
            ]),
        },
        bundle: { slug: 'mk8dx', title: 'Mario Kart 8 Deluxe' },
        previous: {
            id: 'v-1', version: '1.0.8', moderationStatus: 'in_review',
            createdAt: new Date(Date.now() - 86400000).toISOString(),
            manifestJson: MANIFEST([
                R('r1', 'Accélérer', { type: 'gamepad', button: 'A' }),       // inchangée
                R('r2', 'Klaxon', { type: 'gamepad', button: 'B' }),
                R('r9', 'Vieux truc', { type: 'keyboard', keys: 'p' }),       // RETIRÉE
            ]),
            capabilities: ['gamepad'],
        },
    }],
};

test('« Examiner » montre le contenu de la version, replié par défaut', async ({ page }) => {
    await boot(page, { isAdmin: true, moderationQueue: QUEUE_DIFF });
    await page.locator('.nav[data-view="moderation"]').click();
    const row = page.locator('.mod-row');
    await expect(row.locator('.mod-detail')).toBeHidden(); // on ne noie pas la file
    await row.locator('.mod-toggle').click();
    await expect(row.locator('.mod-detail')).toBeVisible();
    // les interactions sont lisibles en clair, pas en JSON
    await expect(row.locator('.mod-rules')).toContainText('Accélérer');
    await expect(row.locator('.mod-rules')).toContainText('manette A');
    await expect(row.locator('.mod-rules')).toContainText('RCON « say hop »');
    await expect(row.locator('.mod-detail')).toContainText(/Capacités\s*:\s*gamepad/i);
});

test('le DIFF distingue ajoutée / retirée / modifiée, en toutes lettres', async ({ page }) => {
    await boot(page, { isAdmin: true, moderationQueue: QUEUE_DIFF });
    await page.locator('.nav[data-view="moderation"]').click();
    await page.locator('.mod-row .mod-toggle').click();
    const diff = page.locator('.mod-diff');
    await expect(diff).toContainText('AJOUTÉE');
    await expect(diff).toContainText('Objet');
    await expect(diff).toContainText('RETIRÉE');
    await expect(diff).toContainText('Vieux truc');
    await expect(diff).toContainText('MODIFIÉE');
    await expect(diff).toContainText('Klaxon');
    // CONTRE-TÉMOIN : une règle INCHANGÉE ne doit PAS apparaître dans le diff, sinon
    // « tout est signalé » équivaut à « rien n'est signalé ».
    await expect(diff).not.toContainText('Accélérer');
});

test('version PRIVÉE : on prévient que l’approuver ne publiera rien', async ({ page }) => {
    await boot(page, { isAdmin: true, moderationQueue: QUEUE_DIFF });
    await page.locator('.nav[data-view="moderation"]').click();
    await expect(page.locator('.mod-warn')).toContainText(/privée/i);
    await expect(page.locator('.mod-warn')).toContainText(/ne la publiera pas/i);
});

test('approuver ne RECHARGE PAS toute la file (cause des 429)', async ({ page }) => {
    await boot(page, { isAdmin: true, moderationQueue: QUEUE_DIFF });
    await page.locator('.nav[data-view="moderation"]').click();
    const avant = await page.evaluate(() => (window.__E2E_CALLS__.modQueue || []).length);
    await page.locator('.mod-approve').click();
    await expect(page.locator('#mod-list')).toContainText(/Aucune version en attente/i, { timeout: 10000 });
    const apres = await page.evaluate(() => (window.__E2E_CALLS__.modQueue || []).length);
    expect(apres).toBe(avant); // aucune requête de file supplémentaire
});
