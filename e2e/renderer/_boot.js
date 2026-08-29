// Helper des tests "renderer" : injecte le mock window.houlaConnect puis charge l'app,
// et attend que la vue principale (authentifiée) soit affichée.
const path = require('path');
const MOCK = path.join(__dirname, '..', 'mock-preload.js');

async function boot(page, overrides) {
    page.on('pageerror', (e) => console.log('[pageerror]', e.message)); // filet : une erreur JS non gérée doit se voir
    if (overrides) await page.addInitScript((o) => { window.__E2E_MOCK__ = o; }, overrides);
    await page.addInitScript({ path: MOCK });
    await page.goto('/index.html');
    await page.waitForSelector('#app-main:not(.hidden)', { timeout: 15000 });
}

module.exports = { boot };
