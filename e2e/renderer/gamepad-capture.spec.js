const { test, expect } = require('@playwright/test');
const { boot } = require('./_boot');

// BUG VÉCU : « la capture du joystick ne détecte rien ». captureGamepadToken ne lisait que
// `p.buttons` et jamais `p.axes` : bouger un stick ne produisait STRICTEMENT RIEN, sans le
// moindre message. Le créateur appuyait, relâchait, et concluait que l'outil était cassé.
//
// ⚠️ PIÈGE DE CE TEST, à ne pas reproduire : « la capture ne renvoie rien » est le résultat
// attendu pour une dérive sous le seuil ET pour une capture qui ne tourne pas du tout. Chaque
// cas négatif est donc DOUBLÉ d'un contre-témoin positif qui, lui, doit remonter.

/** Branche une fausse manette : axes et boutons pilotés depuis le test. */
const fakePad = (page, { axes = [0, 0, 0, 0], buttons = new Array(16).fill(0) } = {}) =>
    page.evaluate(({ axes, buttons }) => {
        navigator.getGamepads = () => [{
            id: 'fake', index: 0, connected: true, mapping: 'standard',
            axes,
            buttons: buttons.map((v) => ({ pressed: v > 0.5, touched: v > 0, value: v })),
        }];
    }, { axes, buttons });

const capture = (page, ms = 600, opts) =>
    page.evaluate(([ms, opts]) => window.captureGamepadToken(ms, opts), [ms, opts]);

test('stick poussé vers le HAUT : capturé, et le SIGNE est inversé (navigateur -1 = haut)', async ({ page }) => {
    await boot(page, {});
    // axes[1] = stick gauche vertical. Le navigateur donne NÉGATIF vers le haut ; XInput
    // (donc notre manette virtuelle) attend POSITIF vers le haut.
    await fakePad(page, { axes: [0, -1, 0, 0] });
    const tok = await capture(page);
    expect(tok).toEqual({ analog: { ly: 1 } }); // ← inversé : c'est TOUT l'enjeu
});

test('stick vers le BAS, et stick droit : signes et axes corrects', async ({ page }) => {
    await boot(page, {});
    await fakePad(page, { axes: [0, 1, 0, 0] });
    expect(await capture(page)).toEqual({ analog: { ly: -1 } });

    await fakePad(page, { axes: [0, 0, -0.8, 0] }); // stick droit horizontal : PAS inversé
    expect(await capture(page)).toEqual({ analog: { rx: -0.8 } });
});

test('diagonale : c’est l’axe le PLUS poussé qui gagne (résultat déterministe)', async ({ page }) => {
    await boot(page, {});
    // Sans cette règle, le résultat dépendrait de l'ordre de lecture des axes.
    await fakePad(page, { axes: [0.6, -0.95, 0, 0] });
    expect(await capture(page)).toEqual({ analog: { ly: 0.95 } });
});

test('une DÉRIVE de manette usée ne déclenche pas de capture — mais une vraie poussée, si', async ({ page }) => {
    await boot(page, {});
    // Une manette usée dérive couramment jusqu'à ~0.1 ; les zones mortes XInput de référence
    // valent 0.24 / 0.265. Rien ne doit être capturé ici.
    await fakePad(page, { axes: [0.2, 0.15, 0.1, 0.22] });
    expect(await capture(page, 400)).toBeNull();

    // CONTRE-TÉMOIN : sans lui, « null » serait indiscernable d'une capture qui ne tourne pas.
    await fakePad(page, { axes: [0, 0, 0, 0.9] });
    expect(await capture(page, 600)).toEqual({ analog: { ry: -0.9 } });
});

test('les BOUTONS continuent de marcher, et priment sur les axes', async ({ page }) => {
    await boot(page, {});
    const b = new Array(16).fill(0); b[0] = 1; // A
    await fakePad(page, { axes: [0, 0, 0, 0], buttons: b });
    expect(await capture(page)).toBe('A');

    // Bouton ET stick en même temps : le bouton l'emporte (intention la plus explicite).
    await fakePad(page, { axes: [0, -1, 0, 0], buttons: b });
    expect(await capture(page)).toBe('A');
});

test('analog:false (sélecteurs de boutons) ignore les sticks — contre-témoin inclus', async ({ page }) => {
    await boot(page, {});
    await fakePad(page, { axes: [0, -1, 0, 0] });
    expect(await capture(page, 400, { analog: false })).toBeNull();

    // CONTRE-TÉMOIN : le même appel voit bien un bouton, donc il tourne vraiment.
    const b = new Array(16).fill(0); b[3] = 1; // Y
    await fakePad(page, { axes: [0, -1, 0, 0], buttons: b });
    expect(await capture(page, 600, { analog: false })).toBe('Y');
});

test('aucune manette branchée : null, sans planter', async ({ page }) => {
    await boot(page, {});
    await page.evaluate(() => { navigator.getGamepads = () => []; });
    expect(await capture(page, 300)).toBeNull();
});

test('Lab : capturer un stick transforme l’interaction en action ANALOGIQUE', async ({ page }) => {
    await boot(page, { store: [], gifts: [] });
    await page.locator('.nav[data-view="lab"]').click();
    // passe l'action en Manette pour faire apparaître le bouton « Capturer »
    await page.locator('#lab-rules .r-exec').selectOption('gamepad');
    await fakePad(page, { axes: [0, -1, 0, 0] });
    await page.locator('#lab-rules .r-gp-cap').click();

    // la ligne bascule sur le résumé d'action avancée (plus de sélecteur de bouton)
    await expect(page.locator('#lab-rules .r-combo')).toBeVisible();
    await expect(page.locator('#lab-msg2')).toContainText(/Stick gauche vers le haut/i);
    // et le manifeste produit porte bien l'effet analogique, du bon signe
    const eff = await page.evaluate(() => window.buildManifest().rules[0].effect);
    expect(eff.type).toBe('gamepad');
    expect(eff.analog).toEqual({ ly: 1 });
});
