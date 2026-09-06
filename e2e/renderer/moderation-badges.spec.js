const { test, expect } = require('@playwright/test');
const { boot } = require('./_boot');

// TROIS REPROCHES DU PROPRIÉTAIRE, le 2026-09-06 :
//  1. « je ne vois pas s'il y a de nouveaux bundles à modérer » -> pastille de comptage ;
//  2. « je ne reçois pas de notification Telegram » -> corrigé côté API (l'alerte n'était
//     branchée que sur le verdict de l'IA code, pas sur le chemin vision) ;
//  3. une pastille sur le Store, mais sur les MISES À JOUR à faire, pas sur les installés.
//
// Et le constat le plus grave, découvert en vérifiant sa première affirmation : il a
// approuvé deux versions que l'IA avait REFUSÉES, sans que rien à l'écran ne le dise.
const PACK = { slug: 'demo-pack', title: 'Pack Démo', version: '1.0.0', versionDate: '2026-01-01', bannerUrl: null, installCount: 0 };
const V = (extra = {}) => ({
    version: {
        id: 'v1', version: '1.0.1', moderationStatus: 'in_review', visibility: 'public',
        createdAt: new Date().toISOString(), capabilities: ['keyboard'], hostAllowlist: [],
        manifestJson: { schema: 2, rules: [] },
    },
    bundle: { slug: 'snap-camera', title: 'Snap Camera' },
    previous: null,
    ...extra,
});

test('pastille Modération : le nombre s’affiche, avec le retard en infobulle', async ({ page }) => {
    await boot(page, { isAdmin: true, moderationCount: { ok: true, count: 3, oldestDays: 4 } });
    const badge = page.locator('#badge-moderation');
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText('3');
    // Le RETARD est écrit en toutes lettres : la couleur seule ne dirait rien.
    await expect(badge).toHaveAttribute('title', /4 jours/);
});

test('file vide : AUCUNE pastille (une pastille « 0 » est du bruit)', async ({ page }) => {
    await boot(page, { isAdmin: true, moderationCount: { ok: true, count: 0, oldestDays: null } });
    await expect(page.locator('#badge-moderation')).toBeHidden();
});

test('non-admin : ni onglet ni pastille', async ({ page }) => {
    await boot(page, { isAdmin: false, moderationCount: { ok: true, count: 7, oldestDays: 1 } });
    await expect(page.locator('#nav-moderation')).toBeHidden();
    await expect(page.locator('#badge-moderation')).toBeHidden();
});

test('pastille Store : compte les MISES À JOUR, pas les packs installés', async ({ page }) => {
    await boot(page, {
        store: [
            { ...PACK, slug: 'a', version: '2.0.0' },   // installé en 1.0.0 -> à mettre à jour
            { ...PACK, slug: 'b', version: '1.0.0' },   // installé en 1.0.0 -> à jour
            { ...PACK, slug: 'c', version: '3.0.0' },   // PAS installé -> ne compte pas
        ],
        installed: [{ slug: 'a', version: '1.0.0' }, { slug: 'b', version: '1.0.0' }],
    });
    const badge = page.locator('#badge-store');
    await expect(badge).toBeVisible();
    // 2 packs installés, 3 dans le store, mais UNE seule mise à jour : c'est ce chiffre-là
    // qui demande une action, et c'est le seul qui doit s'afficher.
    await expect(badge).toHaveText('1');
});

test('tout est à jour : pas de pastille Store', async ({ page }) => {
    await boot(page, {
        store: [{ ...PACK, slug: 'a', version: '1.0.0' }],
        installed: [{ slug: 'a', version: '1.0.0' }],
    });
    await expect(page.locator('#badge-store')).toBeHidden();
});

test('MODÉRATION : un refus de l’IA saute aux yeux avant tout clic', async ({ page }) => {
    await boot(page, {
        isAdmin: true,
        moderationCount: { ok: true, count: 1, oldestDays: 0 },
        moderationQueue: { ok: true, items: [V({
            aiRejected: true,
            reviews: [
                { status: 'in_review', reviewerType: 'ai', attemptNumber: 1, rejectionReason: null },
                { status: 'rejected', reviewerType: 'ai', attemptNumber: 2, confidenceScore: 0.9,
                  rejectionReason: "Les instructions invitent l'utilisateur à télécharger un fichier externe." },
            ],
        })] },
    });
    await page.locator('.nav[data-view="moderation"]').click();
    const alerte = page.locator('.mod-warn--ia');
    await expect(alerte).toBeVisible();
    await expect(alerte).toContainText(/REFUSÉ/);
    await expect(alerte).toContainText(/télécharger un fichier externe/);
});

test('CONTRE-TÉMOIN : sans refus IA, aucune alerte rouge', async ({ page }) => {
    // Sans lui, « l'alerte s'affiche » ne prouverait pas qu'elle dépend du verdict.
    await boot(page, {
        isAdmin: true,
        moderationCount: { ok: true, count: 1, oldestDays: 0 },
        moderationQueue: { ok: true, items: [V({
            aiRejected: false,
            reviews: [{ status: 'in_review', reviewerType: 'ai', attemptNumber: 1,
                        rejectionReason: 'IA : rien de malveillant détecté, revue humaine requise.' }],
        })] },
    });
    await page.locator('.nav[data-view="moderation"]').click();
    await expect(page.locator('.mod-warn--ia')).toHaveCount(0);
    // ... mais l'historique reste consultable
    await page.locator('.mod-toggle').click();
    await expect(page.locator('.mod-detail')).toContainText(/rien de malveillant/i);
});
