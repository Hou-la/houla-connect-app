// E2E smoke : l'app Electron se lance, la fenêtre principale s'ouvre et charge la
// coquille. Fondation E2E — à étendre (login mocké, création de bundle, aller-retour
// sauvegarde/rechargement, test d'effet). Prérequis : `npm run build` avant.
// NB : hors de test/ pour ne PAS être ramassé par `node --test` (runner des TU).
const path = require('path');
const { test, expect, _electron: electron } = require('@playwright/test');

const APP_ROOT = path.join(__dirname, '..');

test('l\'app se lance et ouvre la fenêtre principale', async () => {
    // Certains environnements posent ELECTRON_RUN_AS_NODE=1 (mode "node pur") qui empêche
    // l'ouverture d'une fenêtre : on le RETIRE (une valeur vide ne suffit pas).
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const app = await electron.launch({ args: [APP_ROOT], env });
    try {
        const win = await app.firstWindow();
        await win.waitForLoadState('domcontentloaded');
        await expect(win).toHaveTitle(/Hou\.?la Connect/i);
        // Le renderer a bien évalué manifest-lib + renderer.js (pas d'erreur de chargement) :
        const hasLib = await win.evaluate(() => typeof window.HoulaManifest === 'object');
        expect(hasLib).toBe(true);
    } finally {
        await app.close();
    }
});
