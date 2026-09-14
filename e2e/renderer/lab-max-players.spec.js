const { test, expect } = require('@playwright/test');
const { boot } = require('./_boot');

// JOUEURS SIMULTANÉS DÉCLARÉS PAR LE CRÉATEUR (2026-09-14).
//
// Promis à un créateur de packs et absent jusqu'ici : le ciblage se DÉDUISAIT de la
// seule présence d'une règle manette, et un pack Minecraft joué seul à la manette
// proposait des cibles qui ne mènent nulle part. Le créateur sait, lui, que son pack
// ne pilote qu'un personnage : le select « Joueurs simultanés » le lui fait dire.

async function gotoLab(page) {
    await boot(page);
    await page.locator('.nav[data-view="lab"]').click();
    await expect(page.locator('#view-lab')).toBeVisible();
    // enterCreateMode() tourne après des await et EFFACE slug/titre : on attend
    // l'interaction par défaut avant de saisir.
    await expect(page.locator('#view-lab .r-keys')).toBeVisible();
    await page.fill('#lab-slug', 'mon-pack');
    await page.fill('#lab-title', 'Mon Pack');
}

/** Bascule le mode JSON. La case est un interrupteur masqué : on déclenche son
 *  `change`, exactement ce que produit le clic sur l'interrupteur. */
const modeJson = (page, on) => page.locator('#lab-mode').evaluate((el, v) => {
    el.checked = v;
    el.dispatchEvent(new Event('change', { bubbles: true }));
}, on);

const derniereVersion = (page) => page.evaluate(() => {
    const c = window.__E2E_CALLS__.submitVersion || [];
    return c.length ? c[c.length - 1][1].manifest : null;
});

test('pack CLAVIER déclaré à 4 joueurs : refusé AVANT le serveur, et on dit pourquoi', async ({ page }) => {
    // Un clavier envoie ses touches à la fenêtre active, pas à une personne. Laisser
    // partir ce manifeste, c'était un refus serveur opaque et un pack orphelin.
    await gotoLab(page);
    await page.locator('#lab-max-players').selectOption('4');
    await page.locator('#lab-submit-btn').click();

    await expect(page.locator('[data-toast="lab-save"]')).toContainText(/manette/);
    expect(await page.evaluate(() => (window.__E2E_CALLS__.create || []).length)).toBe(0);
    expect(await page.evaluate(() => (window.__E2E_CALLS__.submitVersion || []).length)).toBe(0);
});

test('CONTRE-TÉMOIN : « Non précisé » sur un pack clavier part, sans la clé', async ({ page }) => {
    // Sans lui, le refus ci-dessus pourrait venir d'autre chose que maxPlayers.
    await gotoLab(page);
    await expect(page.locator('#lab-max-players')).toHaveValue('');
    await page.locator('#lab-submit-btn').click();

    await expect.poll(() => derniereVersion(page), { timeout: 8000 }).not.toBeNull();
    expect(await derniereVersion(page)).not.toHaveProperty('maxPlayers');
});

test('pack MANETTE déclaré solo : la valeur se recharge ET part au serveur', async ({ page }) => {
    await gotoLab(page);
    // Mode JSON : la voie la plus directe pour poser une interaction manette, et elle
    // exerce le rechargement du select au retour dans le mode simplifié. Déclencheur
    // « follow » : il n'exige aucune icône, le test ne mesure donc que maxPlayers.
    await modeJson(page, true);
    await page.fill('#lab-manifest', JSON.stringify({
        schema: 2,
        maxPlayers: 1,
        rules: [{ id: 'r1', on: { type: 'follow' }, effect: { type: 'gamepad', button: 'A' } }],
    }));
    await modeJson(page, false);

    // Le select REFLÈTE le manifeste : sinon le créateur croirait son réglage perdu.
    await expect(page.locator('#lab-max-players')).toHaveValue('1');

    await page.locator('#lab-submit-btn').click();
    await expect.poll(() => derniereVersion(page), { timeout: 8000 }).not.toBeNull();
    expect((await derniereVersion(page)).maxPlayers).toBe(1);
});

test('éditer un pack déclaré à 3, puis « + Nouveau pack » : la valeur suit, puis repart à zéro', async ({ page }) => {
    // Deux risques d'un coup. Au CHARGEMENT : un pack déjà déclaré à 3 qui s'ouvrirait
    // sur « Non précisé » ferait republier la version suivante sans plafond. À la
    // CRÉATION : un réglage qui survivrait d'un pack à l'autre serait publié sur le
    // mauvais pack.
    const MINE = {
        slug: 'mario-kart', title: 'Mario Kart', version: '1.0.0', visibility: 'private',
        description: 'd', game: '', creatorFeePercent: 0, bannerUrl: null, tags: [], instructions: '',
    };
    await boot(page, {
        store: [],
        myBundles: [MINE],
        labDetail: {
            bundle: MINE,
            versions: [{
                id: 'v1', version: '1.0.0', moderationStatus: 'approved', visibility: 'private', createdAt: '2026-01-01',
                manifestJson: {
                    schema: 2,
                    maxPlayers: 3,
                    rules: [{ id: 'r1', on: { type: 'follow' }, effect: { type: 'gamepad', button: 'A' } }],
                },
            }],
        },
    });
    await page.locator('.nav[data-view="mine"]').click();
    await page.locator('.bundle-card', { hasText: 'Mario Kart' }).locator('.edit').click();
    await expect(page.locator('#lab-slug')).toHaveValue('mario-kart');
    await expect(page.locator('#lab-max-players')).toHaveValue('3'); // chargé depuis la version

    await page.locator('#lab-new-btn').click();
    await expect(page.locator('#lab-mode-title')).toContainText(/Créer un pack/i); // mode RÉELLEMENT basculé
    await expect(page.locator('#lab-max-players')).toHaveValue('');
});
