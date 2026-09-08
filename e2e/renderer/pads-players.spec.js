const { test, expect } = require('@playwright/test');
const { boot } = require('./_boot');

// DÉCLARER LES JOUEURS (2026-09-08).
//
// C'est cette carte qui donne son existence au ciblage : sans elle, le
// sélecteur « À qui ? » n'apparaît JAMAIS chez le spectateur. Trois choses
// doivent tenir, et deux d'entre elles évitent une panne muette :
//
//   1. Au-delà de 2 joueurs, les manettes Xbox 360 virtuelles sont INVISIBLES
//      du jeu (Windows n'a que 4 emplacements XInput, partagés avec les
//      manettes physiques). On bascule en DualShock 4 et on le DIT.
//   2. On publie ce qui EXISTE vraiment, pas ce qui a été demandé. Annoncer
//      4 joueurs quand Windows n'en publie que 3 ferait payer un spectateur
//      pour un cadeau qui n'agirait nulle part.
//   3. Zéro joueur RETIRE la liste, au lieu de laisser des noms périmés.

async function ouvrirReglages(page, cfg = {}) {
    await boot(page, cfg);
    await page.locator('.nav[data-view="settings"]').click();
    await expect(page.locator('#pads-card')).toBeVisible();
}

test('un champ de nom par manette, avec le repli visible', async ({ page }) => {
    await ouvrirReglages(page);
    await page.locator('#pads-count').selectOption('3');

    const champs = page.locator('#pads-list .pad-label');
    await expect(champs).toHaveCount(3);
    // Le placeholder EST le repli réel côté serveur : le diffuseur voit donc
    // exactement ce que verront ses spectateurs s'il ne saisit rien.
    await expect(champs.nth(0)).toHaveAttribute('placeholder', 'Contrôleur 1');
    await expect(champs.nth(2)).toHaveAttribute('placeholder', 'Contrôleur 3');
    await expect(champs.nth(0)).toHaveAttribute('maxlength', '24');
});

test('au-delà de 2 joueurs : bascule en DualShock 4, et on le DIT', async ({ page }) => {
    await ouvrirReglages(page);
    await expect(page.locator('#pads-kind')).toHaveValue('x360');

    await page.locator('#pads-count').selectOption('4');

    await expect(page.locator('#pads-kind')).toHaveValue('ds4');
    // Basculer en silence laisserait le diffuseur croire qu'il joue en Xbox.
    await expect(page.locator('#pads-status')).toContainText(/DualShock 4/);
});

test('CONTRE-TÉMOIN : à 2 joueurs, aucune bascule', async ({ page }) => {
    // Sans lui, « ça passe en DS4 » serait vrai quel que soit le nombre, et on
    // priverait de XInput des configurations qui en ont besoin.
    await ouvrirReglages(page);
    await page.locator('#pads-count').selectOption('2');
    await expect(page.locator('#pads-kind')).toHaveValue('x360');
});

test('publier : les noms saisis partent, avec le bon numéro de joueur', async ({ page }) => {
    await ouvrirReglages(page);
    await page.locator('#pads-count').selectOption('2');
    await page.locator('#pads-list .pad-label').nth(0).fill('Flicky');
    await page.locator('#pads-list .pad-label').nth(1).fill('Mika');
    await page.locator('#pads-apply').click();

    await expect
        .poll(() => page.evaluate(() => (window.__E2E_CALLS__.publishPlayers || []).length))
        .toBeGreaterThan(0);
    const envoye = await page.evaluate(
        () => window.__E2E_CALLS__.publishPlayers[0][0],
    );
    expect(envoye).toEqual([
        { id: 1, label: 'Flicky', connected: true },
        { id: 2, label: 'Mika', connected: true },
    ]);
    await expect(page.locator('#pads-status')).toContainText(/2 joueur/);
});

test('on publie ce qui EXISTE, et on signale ce qui manque', async ({ page }) => {
    // Windows énumère une manette virtuelle en ~3 s : demander 4 manettes ne
    // veut pas dire que le jeu en voit 4. Annoncer 4 joueurs aux spectateurs
    // ferait payer un cadeau qui n'agirait nulle part.
    await ouvrirReglages(page, {
        gamepadPadsResult: {
            ok: true,
            max: 8,
            devices: 2, // Windows n'en publie que 2…
            pads: [
                { player: 1, kind: 'ds4' },
                { player: 2, kind: 'ds4' },
                { player: 3, kind: 'ds4' }, // …alors qu'on en a demandé 3
            ],
        },
    });
    await page.locator('#pads-count').selectOption('3');
    await page.locator('#pads-apply').click();

    await expect(page.locator('#pads-status')).toContainText(/n’en publie que 2/);
});

test('le refus du sidecar est TRADUIT, pas recraché brut', async ({ page }) => {
    await ouvrirReglages(page, {
        gamepadPadsResult: {
            ok: false,
            reason: 'Windows n\'a que 4 emplacements de manette Xbox, partagés avec tes manettes physiques.',
        },
    });
    await page.locator('#pads-count').selectOption('4');
    await page.locator('#pads-apply').click();

    await expect(page.locator('#pads-status')).toContainText(/4 emplacements/);
    // Et surtout : RIEN n'est publié, sinon les spectateurs verraient des
    // joueurs qui n'existent pas.
    expect(
        await page.evaluate(() => (window.__E2E_CALLS__.publishPlayers || []).length),
    ).toBe(0);
});

test('zéro joueur : la liste est RETIRÉE chez les spectateurs', async ({ page }) => {
    await ouvrirReglages(page);
    await page.locator('#pads-count').selectOption('2');
    await page.locator('#pads-apply').click();
    await expect(page.locator('#pads-status')).toContainText(/2 joueur/);

    await page.locator('#pads-count').selectOption('0');
    await expect(page.locator('#pads-list .pad-label')).toHaveCount(0);
    await page.locator('#pads-apply').click();

    await expect
        .poll(() => page.evaluate(() => (window.__E2E_CALLS__.publishPlayers || []).length))
        .toBe(2);
    // Une liste VIDE, pas l'absence d'appel : c'est ce qui fait disparaître le
    // sélecteur au lieu de laisser des noms périmés.
    const dernier = await page.evaluate(() => {
        const c = window.__E2E_CALLS__.publishPlayers;
        return c[c.length - 1][0];
    });
    expect(dernier).toEqual([]);
});
