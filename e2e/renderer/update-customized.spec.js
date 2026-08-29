const { test, expect } = require('@playwright/test');
const { boot } = require('./_boot');

const PACK = { slug: 'demo-pack', title: 'Pack Démo', version: '1.0.1', versionDate: '2026-01-01', bannerUrl: null };
// customize.get renvoie une interaction DÉSACTIVÉE -> le pack est "personnalisé".
const CUSTOMIZED = { slug: 'demo-pack', version: '1.0.0', instructions: null, rules: [{ id: 'r1', label: 'A', enabled: false, effectType: 'keyboard' }] };

async function gotoStoreWithUpdate(page) {
    await boot(page, { store: [PACK], installed: [{ slug: 'demo-pack', version: '1.0.0' }], customize: CUSTOMIZED });
    await page.locator('.nav[data-view="store"]').click();
    const card = page.locator('.bundle-card', { hasText: 'Pack Démo' });
    await expect(card.locator('.install')).toContainText(/v1\.0\.1/); // CTA de mise à jour (↑ v1.0.1)
    return card;
}
const installedSlugs = (page) => page.evaluate(() => (window.__E2E_CALLS__.install || []).map((a) => a[0]));
const savedOverlays = (page) => page.evaluate(() => (window.__E2E_CALLS__.customizeSave || []).map((a) => JSON.stringify(a[1])));
const nSaves = (page) => page.evaluate(() => (window.__E2E_CALLS__.customizeSave || []).length);
const nInstalls = (page) => page.evaluate(() => (window.__E2E_CALLS__.install || []).length);

test('pack customisé + update dispo : la modale de choix apparaît', async ({ page }) => {
    const card = await gotoStoreWithUpdate(page);
    await card.locator('.install').click();
    await expect(page.locator('#choice-modal')).toBeVisible();
    await expect(page.locator('#choice-title')).toHaveText(/personnalisé/i);
});

test('« Repartir des réglages du créateur » -> customize.save({}) PUIS install', async ({ page }) => {
    const card = await gotoStoreWithUpdate(page);
    await card.locator('.install').click();
    await page.locator('#choice-actions .btn', { hasText: 'créateur' }).click();
    await expect.poll(() => savedOverlays(page)).toContain('{}'); // overlay vidé
    await expect.poll(() => installedSlugs(page)).toContain('demo-pack'); // puis install
});

test('« Garder mes réglages » -> install SANS vider l\'overlay', async ({ page }) => {
    const card = await gotoStoreWithUpdate(page);
    await card.locator('.install').click();
    await page.locator('#choice-actions .btn', { hasText: 'Garder' }).click();
    await expect.poll(() => installedSlugs(page)).toContain('demo-pack');
    expect(await nSaves(page)).toBe(0);
});

test('« Annuler » -> ni install ni écrasement', async ({ page }) => {
    const card = await gotoStoreWithUpdate(page);
    await card.locator('.install').click();
    await page.locator('#choice-actions .btn', { hasText: 'Annuler' }).click();
    await expect(page.locator('#choice-modal')).toBeHidden();
    expect(await nInstalls(page)).toBe(0);
    expect(await nSaves(page)).toBe(0);
});
