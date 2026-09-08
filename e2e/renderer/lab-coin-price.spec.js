const { test, expect } = require('@playwright/test');
const { boot } = require('./_boot');

// LE blocage que ce changement lève (2026-09-08).
//
// Jusqu'ici le PRIX d'un cadeau interactif était le NUMÉRO de son emplacement :
// 30 emplacements, 30 prix distincts, un par emplacement. Un créateur voulant
// 97 filtres au même tarif n'avait aucun moyen de l'exprimer — le pack
// `snap-camera-v1210` en prod porte 97 règles TOUTES entassées sur
// `ix_slot_01`, et le spectateur n'en voyait donc qu'une seule tuile.
//
// Désormais l'emplacement est une PLACE et le prix se choisit à côté, dans une
// liste FERMÉE : le montant part sur le chemin de l'argent réel (coins ->
// étoiles -> euros payables), il ne se saisit pas librement.

async function ouvrirLab(page) {
    await boot(page);
    await page.locator('.nav[data-view="lab"]').click();
    await expect(page.locator('#view-lab')).toBeVisible();
    await expect(page.locator('#view-lab .r-keys')).toBeVisible();
}

/** Bascule la première interaction en « Cadeau personnalisé » (le seul type qui
 *  occupe un emplacement réservé, et donc le seul qui porte un prix). */
async function passerEnCadeauPersonnalise(page) {
    await page.locator('#view-lab .r-event').first().selectOption('gift-custom');
    await expect(page.locator('#view-lab .r-giftslug').first()).toBeVisible();
}

test('99 emplacements proposés, et pas un de plus', async ({ page }) => {
    await ouvrirLab(page);
    await passerEnCadeauPersonnalise(page);
    const slots = page.locator('#view-lab .r-giftslug').first().locator('option');

    // 99 et pas 100 : à trois chiffres, `ix_slot_100` cesse d'être reconnu par
    // les regex `\d{2}` de cette page et le champ ICÔNE disparaît sans erreur.
    await expect(slots).toHaveCount(99);
    await expect(slots.first()).toHaveAttribute('value', 'ix_slot_01');
    await expect(slots.last()).toHaveAttribute('value', 'ix_slot_99');
});

test('le prix est un choix SÉPARÉ de l’emplacement', async ({ page }) => {
    await ouvrirLab(page);
    await passerEnCadeauPersonnalise(page);

    const prix = page.locator('#view-lab .r-coincost').first();
    await expect(prix).toBeVisible();
    // 30 paliers, exactement ceux que le serveur accepte. Toute autre valeur
    // fait refuser le manifeste ENTIER à la soumission.
    await expect(prix.locator('option')).toHaveCount(30);
    await expect(prix.locator('option').first()).toHaveAttribute('value', '5');
    await expect(prix.locator('option').last()).toHaveAttribute('value', '1700');
});

test('DEUX emplacements différents peuvent porter le MÊME prix', async ({ page }) => {
    // C'est exactement ce qui était impossible, et toute la raison du chantier.
    await ouvrirLab(page);
    await passerEnCadeauPersonnalise(page);

    // Interaction 1 : emplacement 1, à 5 coins.
    await page.locator('#view-lab .r-giftslug').first().selectOption('ix_slot_01');
    await page.locator('#view-lab .r-coincost').first().selectOption('5');

    // Interaction 2 : un AUTRE emplacement, au MÊME prix.
    await page.locator('#lab-add-rule').click();
    await expect(page.locator('#view-lab .r-event')).toHaveCount(2);
    await page.locator('#view-lab .r-event').nth(1).selectOption('gift-custom');
    await page.locator('#view-lab .r-giftslug').nth(1).selectOption('ix_slot_42');
    await page.locator('#view-lab .r-coincost').nth(1).selectOption('5');

    const emplacements = await page.locator('#view-lab .r-giftslug').evaluateAll(
        (els) => els.map((e) => e.value),
    );
    const prix = await page.locator('#view-lab .r-coincost').evaluateAll(
        (els) => els.map((e) => e.value),
    );

    expect(new Set(emplacements).size).toBe(2); // deux places distinctes…
    expect(new Set(prix)).toEqual(new Set(['5'])); // …un seul prix.
});

test('CONTRE-TÉMOIN : un cadeau du CATALOGUE n’a pas de sélecteur de prix', async ({ page }) => {
    // Sans lui, « le sélecteur est là » ne prouverait rien : il pourrait être
    // affiché pour tous les types d'interaction. Seul un emplacement réservé
    // porte un prix déclaré par le pack ; un cadeau du catalogue a le sien.
    await ouvrirLab(page);
    await page.locator('#view-lab .r-event').first().selectOption('gift');
    await expect(page.locator('#view-lab .r-giftslug').first()).toBeVisible();
    await expect(page.locator('#view-lab .r-coincost')).toHaveCount(0);
});
