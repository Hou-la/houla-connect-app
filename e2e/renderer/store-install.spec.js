const { test, expect } = require('@playwright/test');
const { boot } = require('./_boot');

const PACK = { slug: 'demo-pack', title: 'Pack Démo', version: '1.0.0', versionDate: '2026-01-01', bannerUrl: null, installCount: 0 };

test('install : clic Installer -> api.store.install(slug) -> carte « Installé ✓ »', async ({ page }) => {
    await boot(page, { store: [PACK] });
    await page.locator('.nav[data-view="store"]').click();
    await expect(page.locator('#view-store')).toBeVisible();

    const card = page.locator('.bundle-card', { hasText: 'Pack Démo' });
    await expect(card).toBeVisible();
    await expect(card.locator('.install')).toContainText(/Installer/);

    await card.locator('.install').click();

    // install appelé avec le bon slug
    await expect
        .poll(() => page.evaluate(() => (window.__E2E_CALLS__.install || []).map((a) => a[0])))
        .toContain('demo-pack');
    // la carte est re-rendue en « Installé ✓ » (mock stateful)
    await expect(page.locator('.bundle-card', { hasText: 'Pack Démo' }).locator('.install')).toContainText(/Installé/i);
});

test('désinstall : clic Désinstaller (2 temps) -> api.store.uninstall(slug) -> retour « Installer »', async ({ page }) => {
    await boot(page, { store: [PACK], installed: [{ slug: 'demo-pack', version: '1.0.0' }] });
    await page.locator('.nav[data-view="store"]').click();
    const card = page.locator('.bundle-card', { hasText: 'Pack Démo' });
    await expect(card.locator('.install')).toContainText(/Installé/i);
    // Désinstaller = 2 temps ("Désinstaller" -> "Confirmer ?")
    await card.locator('.uninstall').click();
    await card.locator('.uninstall').click();
    await expect
        .poll(() => page.evaluate(() => (window.__E2E_CALLS__.uninstall || []).map((a) => a[0])))
        .toContain('demo-pack');
    await expect(page.locator('.bundle-card', { hasText: 'Pack Démo' }).locator('.install')).toContainText(/Installer/);
});
