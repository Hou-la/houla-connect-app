const { test, expect } = require('@playwright/test');
const { boot } = require('./_boot');

// Un même jeu se joue au clavier OU à la manette, et le joueur ne peut RIEN remapper de son
// côté (le calque local ne porte que disabled/cooldownMs). Un pack décrit donc ses actions
// une fois par matériel, et le joueur choisit sa configuration à l'installation.
//
// Le test qui compte est le CONTRE-TÉMOIN : un joueur qui choisit « Clavier » ne doit JAMAIS
// se voir réclamer l'exécutable du jeu, alors même que le pack propose par ailleurs une
// configuration manette. « Rien ne s'affiche » est aussi ce qu'on observerait si l'install
// avait échoué : on vérifie donc en plus que le pack est bien installé.
const PACK = { slug: 'demo-pack', title: 'Pack Démo', version: '1.0.0', versionDate: '2026-01-01', bannerUrl: null, installCount: 0 };
const PROFILES = [
    { id: 'clavier', label: 'Clavier', default: true },
    { id: 'manette', label: 'Manette' },
];

const bootDual = (page, extra = {}) => boot(page, {
    store: [PACK],
    usesGamepad: true, // le pack pilote une manette... mais SEULEMENT dans la config manette
    profiles: PROFILES,
    gamepadProfiles: ['manette'],
    gamePackStatus: { exe: null, dir: null, placed: false },
    ...extra,
});

const install = async (page) => {
    await page.locator('.nav[data-view="store"]').click();
    await page.locator('.bundle-card', { hasText: 'Pack Démo' }).locator('.install').click();
};

test('install d’un pack à deux configurations : on demande COMMENT le joueur joue', async ({ page }) => {
    await bootDual(page);
    await install(page);
    await expect(page.locator('#choice-modal')).toBeVisible();
    await expect(page.locator('#choice-title')).toContainText(/comment joues-tu/i);
    await expect(page.locator('#choice-actions button', { hasText: 'Clavier' })).toBeVisible();
    await expect(page.locator('#choice-actions button', { hasText: 'Manette' })).toBeVisible();
});

test('choix CLAVIER : le jeu n’est jamais demandé, et le choix est enregistré', async ({ page }) => {
    await bootDual(page);
    await install(page);
    await page.locator('#choice-actions button', { hasText: 'Clavier' }).click();

    // le choix part bien au main (sinon le moteur retomberait sur le défaut sans le savoir)
    await expect
        .poll(() => page.evaluate(() => (window.__E2E_CALLS__.setProfile || []).map((a) => a[1])))
        .toEqual(['clavier']);
    // CONTRE-TÉMOIN : le pack est bien installé (donc « pas de modale » ne vient pas d'un échec)
    await expect
        .poll(() => page.evaluate(() => (window.__E2E_CALLS__.install || []).length))
        .toBe(1);
    // ... et AUCUNE demande de jeu n'a été faite
    await expect(page.locator('#choice-modal')).toBeHidden();
    expect(await page.evaluate(() => (window.__E2E_CALLS__.gameLinkPack || []).length)).toBe(0);
});

test('choix MANETTE : le jeu est demandé, lui', async ({ page }) => {
    await bootDual(page);
    await install(page);
    await page.locator('#choice-actions button', { hasText: 'Manette' }).click();
    // la modale enchaîne sur la demande de jeu
    await expect(page.locator('#choice-title')).toContainText(/quel jeu/i);
});

test('réglages du pack : le joueur peut changer de configuration après coup', async ({ page }) => {
    await bootDual(page, {
        installed: [{ slug: 'demo-pack', version: '1.0.0' }],
        customize: {
            slug: 'demo-pack', version: '1.0.0', instructions: null,
            profiles: PROFILES,
            activeProfile: 'clavier',
            rules: [{ id: 'r1', label: 'Saut', trigger: 'gift', giftSlug: 'ix_slot_24', effectType: 'keyboard', enabled: true, defaultCooldownMs: 0 }],
        },
    });
    await page.locator('.nav[data-view="store"]').click();
    await page.locator('.bundle-card', { hasText: 'Pack Démo' }).locator('.customize').click();
    await expect(page.locator('#cx-modal')).toBeVisible();
    await expect(page.locator('#cx-rules')).toContainText(/Tu joues en/i);
    await page.locator('.cx-profile').selectOption('manette');
    await expect
        .poll(() => page.evaluate(() => (window.__E2E_CALLS__.setProfile || []).map((a) => a[1])))
        .toEqual(['manette']);
});

test('pack à configuration UNIQUE : rien ne change (aucune question posée)', async ({ page }) => {
    await boot(page, {
        store: [PACK],
        usesGamepad: false,
        profiles: [], // cas historique
        gamepadProfiles: [],
    });
    await install(page);
    await expect
        .poll(() => page.evaluate(() => (window.__E2E_CALLS__.install || []).length))
        .toBe(1);
    await expect(page.locator('#choice-modal')).toBeHidden();
    expect(await page.evaluate(() => (window.__E2E_CALLS__.setProfile || []).length)).toBe(0);
});

// ── Lab (créateur) ──
test('Lab : ajouter une configuration rattache les interactions existantes, et l’onglet filtre', async ({ page }) => {
    await boot(page, { store: [], gifts: [] });
    await page.locator('.nav[data-view="lab"]').click();
    await expect(page.locator('#lab-rules .rule')).toHaveCount(1); // une interaction par défaut

    await page.locator('#lab-add-profile').click();
    await page.locator('#choice-actions button', { hasText: 'Clavier' }).click();

    // l'interaction déjà écrite est rattachée à la 1re configuration (elle reste visible)
    await expect(page.locator('.lab-tab--on')).toContainText('Clavier');
    await expect(page.locator('#lab-rules .rule')).toHaveCount(1);

    // dupliquer vers Manette : les déclencheurs sont recopiés, l'action repart à neuf
    await page.locator('.lab-prof-dup').click();
    await page.locator('#choice-actions button', { hasText: 'Dupliquer' }).click();
    await expect(page.locator('.lab-tab--on')).toContainText('Manette');
    await expect(page.locator('#lab-rules .rule')).toHaveCount(1); // seulement celles de l'onglet
    await expect(page.locator('#lab-rules .r-exec')).toHaveValue('gamepad');

    // l'onglet « Toutes » montre bien les deux
    await page.locator('.lab-tab[data-profile=""]').click();
    await expect(page.locator('#lab-rules .rule')).toHaveCount(2);
});
