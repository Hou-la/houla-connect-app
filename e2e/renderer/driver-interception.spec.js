const { test, expect } = require('@playwright/test');
const { boot } = require('./_boot');

// Le clavier bas niveau echouait avec le message BRUT de la bibliotheque, en anglais :
// « Interception driver was not found or is not installed. Please confirm that it has been
// installed properly and is added to PATH. » Personne ne sait quoi en faire.
//
// Contrairement a la manette, l'app n'embarque PAS l'installeur de ce pilote (licence a
// trancher avant toute redistribution) : on ne peut donc pas proposer un bouton qui installe.
// Ce qu'on DOIT faire, c'est expliquer, et donner la sortie immediate.
const PACK = { slug: 'demo-pack', title: 'Pack Démo', version: '1.0.0', versionDate: '2026-01-01', bannerUrl: null, installCount: 0 };

const bootAvecVerdict = (page, verdict) => boot(page, {
    store: [PACK],
    installed: [{ slug: 'demo-pack', version: '1.0.0' }],
    customize: {
        slug: 'demo-pack', version: '1.0.0', instructions: null, profiles: [], activeProfile: null,
        rules: [{ id: 'k1', label: 'Sauter', trigger: 'gift', giftSlug: 'ix_slot_01', effectType: 'keyboard', enabled: true, defaultCooldownMs: 0 }],
    },
    testRuleResult: verdict,
});

const ouvrir = async (page) => {
    await page.locator('.nav[data-view="store"]').click();
    await page.locator('.bundle-card', { hasText: 'Pack Démo' }).locator('.customize').click();
    await expect(page.locator('#cx-modal')).toBeVisible();
};

test('pilote absent : le message dit quoi faire, et reste affiché', async ({ page }) => {
    await bootAvecVerdict(page, {
        ok: false, code: 'interception',
        reason: 'Le pilote clavier bas niveau (Interception) n’est pas installé sur cet ordinateur. Les autres actions du pack fonctionnent ; seules les touches « bas niveau » ont besoin de lui. Son installation demande un redémarrage. En attendant, bascule cette interaction sur le mode clavier « normal ».',
    });
    await ouvrir(page);
    await page.locator('.cx-rule[data-id="k1"] .cx-test').click();

    const toast = page.locator('[data-toast="effect-test"]');
    await expect(toast).toBeVisible({ timeout: 15000 });
    await expect(toast).toContainText(/Pilote clavier bas niveau absent/i);
    // la SORTIE immédiate est donnée, pas seulement le diagnostic
    await expect(toast).toContainText(/mode clavier .*normal/i);
    // et plus jamais le message brut en anglais
    await expect(toast).not.toContainText(/added to PATH/i);
});

test('CONTRE-TÉMOIN : un échec ordinaire garde le message générique', async ({ page }) => {
    // Sans ce test, « le toast s'affiche » ne prouverait pas que c'est le BON toast : il
    // s'affiche aussi pour n'importe quel autre échec.
    await bootAvecVerdict(page, { ok: false, reason: 'connexion refusée' });
    await ouvrir(page);
    await page.locator('.cx-rule[data-id="k1"] .cx-test').click();

    const toast = page.locator('[data-toast="effect-test"]');
    await expect(toast).toBeVisible({ timeout: 15000 });
    await expect(toast).toContainText(/Test non déclenché/i);
    await expect(toast).not.toContainText(/Pilote clavier bas niveau/i);
});
