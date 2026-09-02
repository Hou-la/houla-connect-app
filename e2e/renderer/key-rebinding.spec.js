const { test, expect } = require('@playwright/test');
const { boot } = require('./_boot');

// Le site promet « tu glisses des cadeaux sur des actions » depuis le premier jour. En
// réalité le joueur ne pouvait RIEN remapper : le calque local ne portait que `disabled` et
// `cooldownMs`, et les touches étaient figées dans le manifeste signé. Un pack écrit pour une
// autre configuration de touches était donc inutilisable, sans aucun recours.
const PACK = { slug: 'demo-pack', title: 'Pack Démo', version: '1.0.0', versionDate: '2026-01-01', bannerUrl: null, installCount: 0 };

const RULES = [
    // clavier, remappable
    { id: 'k1', label: 'Sauter', trigger: 'gift', giftSlug: 'ix_slot_01', effectType: 'keyboard', enabled: true, defaultCooldownMs: 0, bindable: true, defaultBinding: 'space' },
    // manette simple, remappable
    { id: 'g1', label: 'Attaquer', trigger: 'gift', giftSlug: 'ix_slot_02', effectType: 'gamepad', enabled: true, defaultCooldownMs: 0, bindable: true, defaultBinding: 'A' },
    // action RÉSEAU : jamais remappable (frontière de sécurité)
    { id: 'r1', label: 'Météo', trigger: 'follow', giftSlug: '', effectType: 'rcon', enabled: true, defaultCooldownMs: 0, bindable: false, defaultBinding: '' },
    // manette AVANCÉE (combo) : pas réductible à un bouton unique
    { id: 'g2', label: 'Combo', trigger: 'gift', giftSlug: 'ix_slot_03', effectType: 'gamepad', enabled: true, defaultCooldownMs: 0, bindable: false, defaultBinding: '' },
];

const bootCx = (page, rules = RULES) => boot(page, {
    store: [PACK],
    installed: [{ slug: 'demo-pack', version: '1.0.0' }],
    customize: { slug: 'demo-pack', version: '1.0.0', instructions: null, rules, profiles: [], activeProfile: null },
});

const openCx = async (page) => {
    await page.locator('.nav[data-view="store"]').click();
    await page.locator('.bundle-card', { hasText: 'Pack Démo' }).locator('.customize').click();
    await expect(page.locator('#cx-modal')).toBeVisible();
};

const fakePad = (page, idx) => page.evaluate((idx) => {
    const b = new Array(16).fill(0); b[idx] = 1;
    navigator.getGamepads = () => [{
        id: 'fake', index: 0, connected: true, mapping: 'standard', axes: [0, 0, 0, 0],
        buttons: b.map((v) => ({ pressed: v > 0.5, touched: v > 0, value: v })),
    }];
}, idx);

test('la touche du créateur est affichée, et seules les actions remappables ont le contrôle', async ({ page }) => {
    await bootCx(page);
    await openCx(page);
    await expect(page.locator('.cx-rule[data-id="k1"] .cx-bind-val')).toHaveText('space');
    await expect(page.locator('.cx-rule[data-id="g1"] .cx-bind-val')).toHaveText('A');
    // FRONTIÈRE : une action réseau ou une action manette avancée ne se remappe pas.
    await expect(page.locator('.cx-rule[data-id="r1"] .cx-bind')).toHaveCount(0);
    await expect(page.locator('.cx-rule[data-id="g2"] .cx-bind')).toHaveCount(0);
});

test('remapper une touche CLAVIER : capturée, affichée, envoyée dans keys', async ({ page }) => {
    await bootCx(page);
    await openCx(page);
    const row = page.locator('.cx-rule[data-id="k1"]');
    await row.locator('.cx-bind-cap').click();
    await expect(row.locator('.cx-bind-cap')).toContainText(/Appuie sur une touche/i);
    await page.keyboard.press('KeyF');
    await expect(row.locator('.cx-bind-val')).toHaveText('f');

    await page.locator('#cx-save').click();
    await expect
        .poll(() => page.evaluate(() => (window.__E2E_CALLS__.customizeSave || [])[0]?.[1]?.keyBindings))
        .toEqual({ k1: { keys: 'f' } }); // champ `keys`, pas `button`
});

test('remapper un bouton MANETTE : envoyé dans button, jamais dans keys', async ({ page }) => {
    await bootCx(page);
    await openCx(page);
    const row = page.locator('.cx-rule[data-id="g1"]');
    await fakePad(page, 3); // Y
    await row.locator('.cx-bind-cap').click();
    await expect(row.locator('.cx-bind-val')).toHaveText('Y');

    await page.locator('#cx-save').click();
    await expect
        .poll(() => page.evaluate(() => (window.__E2E_CALLS__.customizeSave || [])[0]?.[1]?.keyBindings))
        .toEqual({ g1: { button: 'Y' } });
});

test('« ↺ » revient au réglage du créateur ET retire le remappage de la sauvegarde', async ({ page }) => {
    // Le piège : si le retour n'envoyait rien, le main conserverait l'ancienne valeur et le
    // joueur resterait coincé avec sa touche. On vérifie donc la charge utile RÉELLE.
    await bootCx(page, [{ ...RULES[0], binding: 'f' }]); // le joueur avait déjà remappé
    await openCx(page);
    const row = page.locator('.cx-rule[data-id="k1"]');
    await expect(row.locator('.cx-bind-val')).toHaveText('f');
    await expect(row.locator('.cx-bind-reset')).toBeVisible();

    await row.locator('.cx-bind-reset').click();
    await expect(row.locator('.cx-bind-val')).toHaveText('space'); // le réglage du créateur
    await expect(row.locator('.cx-bind-reset')).toBeHidden();

    await page.locator('#cx-save').click();
    await expect
        .poll(() => page.evaluate(() => (window.__E2E_CALLS__.customizeSave || [])[0]?.[1]?.keyBindings))
        .toEqual({}); // objet VIDE envoyé : c'est ce qui efface le remappage côté main
});

test('sans remappage, la sauvegarde continue de marcher (aucune régression)', async ({ page }) => {
    await bootCx(page);
    await openCx(page);
    await page.locator('#cx-save').click();
    await expect
        .poll(() => page.evaluate(() => (window.__E2E_CALLS__.customizeSave || []).length))
        .toBe(1);
    await expect(page.locator('#cx-save-msg')).toContainText(/Enregistré/i);
});

test('capture sans rien appuyer : le joueur est PRÉVENU, la touche ne change pas', async ({ page }) => {
    // Contre-témoin du silence : avant, une capture ratée ne disait rien du tout.
    await bootCx(page);
    await openCx(page);
    const row = page.locator('.cx-rule[data-id="g1"]');
    await page.evaluate(() => { navigator.getGamepads = () => []; });
    await row.locator('.cx-bind-cap').click();
    await expect(page.locator('.toast, #toast-host')).toContainText(/Rien capté|Manette branchée/i, { timeout: 10000 });
    await expect(row.locator('.cx-bind-val')).toHaveText('A'); // inchangé
});
