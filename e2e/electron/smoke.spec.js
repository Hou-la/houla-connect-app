// E2E Electron (projet "electron") : lance l'app packagée réelle. Fondation — à
// stabiliser en CI headless (xvfb + libs natives). Prérequis : `npm run build`.
const path = require('path');
const { test, expect, _electron: electron } = require('@playwright/test');

const APP_ROOT = path.join(__dirname, '..', '..');

test('l\'app se lance et ouvre la fenêtre principale', async () => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE; // retirer le mode "node pur" qui empêche l'ouverture d'une fenêtre
    const app = await electron.launch({ args: [APP_ROOT], env });
    try {
        const win = await app.firstWindow();
        await win.waitForLoadState('domcontentloaded');
        await expect(win).toHaveTitle(/Hou\.?la Connect/i);
        const hasLib = await win.evaluate(() => typeof window.HoulaManifest === 'object');
        expect(hasLib).toBe(true);
    } finally {
        await app.close();
    }
});
