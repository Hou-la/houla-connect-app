const { test, expect } = require('@playwright/test');
const { boot } = require('./_boot');

test('switch workspace : choisir une autre identité -> selectWorkspace + bascule affichée', async ({ page }) => {
    await boot(page, {
        workspaces: [{ id: 'ws1', name: 'Studio A', slug: 'a' }, { id: 'ws2', name: 'Studio B', slug: 'b' }],
        currentWorkspace: { id: 'ws1', name: 'Studio A' },
    });
    await expect(page.locator('#ws-current-name')).toHaveText(/Studio A/);

    await page.locator('#ws-current').click(); // ouvre le menu d'identités
    await page.locator('#ws-menu .ws-item', { hasText: 'Studio B' }).click();

    // selectWorkspace appelé avec la nouvelle identité
    await expect
        .poll(() => page.evaluate(() => (window.__E2E_CALLS__.selectWorkspace || []).map((a) => a[0] && a[0].id)))
        .toContain('ws2');
    // l'identité active affichée bascule (purge + rechargement déclenchés)
    await expect(page.locator('#ws-current-name')).toHaveText(/Studio B/);
});
