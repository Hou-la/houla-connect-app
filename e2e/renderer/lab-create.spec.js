const { test, expect } = require('@playwright/test');
const { boot } = require('./_boot');

async function gotoLab(page) {
    await boot(page);
    await page.locator('.nav[data-view="lab"]').click();
    await expect(page.locator('#view-lab')).toBeVisible();
    // enterCreateMode() tourne APRÈS des await (catalogue/dico/connecteurs) et EFFACE
    // slug/titre : on attend qu'il ait rendu l'interaction par défaut avant de saisir.
    await expect(page.locator('#view-lab .r-keys')).toBeVisible();
    await page.fill('#lab-slug', 'mon-pack');
    await page.fill('#lab-title', 'Mon Pack');
}

// LE test qui aurait attrapé le bug remonté par l'utilisateur : sauver une interaction
// dont l'effet est vide ne doit PAS partir au serveur (sinon bundle orphelin = travail perdu).
test('interaction clavier VIDE : refusée AVANT tout appel serveur (garde anti-perte)', async ({ page }) => {
    await gotoLab(page);
    const keys = page.locator('#view-lab .r-keys').first();
    await expect(keys).toBeVisible();
    await keys.fill(''); // vide la touche par défaut ('space')
    await page.locator('#lab-submit-btn').click();
    await expect(page.locator('[data-toast="lab-save"]')).toContainText(/clavier est vide|incompl/i);
    // Aucun appel serveur -> pas d'orphelin
    expect(await page.evaluate(() => (window.__E2E_CALLS__.create || []).length)).toBe(0);
    expect(await page.evaluate(() => (window.__E2E_CALLS__.submitVersion || []).length)).toBe(0);
});

test('identifiant unique : masque de saisie (minuscules, chiffres, tirets ; accents retirés)', async ({ page }) => {
    await boot(page);
    await page.locator('.nav[data-view="lab"]').click();
    await expect(page.locator('#view-lab .r-keys')).toBeVisible(); // create mode prêt
    const slug = page.locator('#lab-slug');
    await slug.fill('Mon Pack Génial!! (v2)');
    await expect(slug).toHaveValue('mon-pack-genial-v2');
});

test('interaction valide : create PUIS submitVersion appelés', async ({ page }) => {
    await gotoLab(page);
    // touche 'space' par défaut -> manifeste valide -> la sauvegarde part au serveur
    await page.locator('#lab-submit-btn').click();
    await expect
        .poll(() => page.evaluate(() => (window.__E2E_CALLS__.submitVersion || []).length), { timeout: 8000 })
        .toBeGreaterThan(0);
    expect(await page.evaluate(() => (window.__E2E_CALLS__.create || []).length)).toBe(1);
});
