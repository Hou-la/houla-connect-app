// E2E. Deux projets :
//  - "renderer" (Chromium headless) : charge le VRAI renderer via un serveur statique,
//    avec window.houlaConnect MOCKÉ -> teste l'UI + la logique sans Electron ni OAuth.
//    Fiable en CI.
//  - "electron" (Playwright _electron) : lance l'app packagée. Fondation, pas encore
//    stabilisée en CI headless -> on ne le lance pas par défaut en CI.
const { defineConfig } = require('@playwright/test');
const PORT = Number(process.env.E2E_PORT || 5177);

module.exports = defineConfig({
    timeout: 60_000,
    expect: { timeout: 15_000 },
    fullyParallel: false,
    workers: 1,
    retries: process.env.CI ? 1 : 0,
    reporter: [['list']],
    use: { baseURL: 'http://localhost:' + PORT },
    webServer: {
        command: 'node e2e/serve.js',
        port: PORT,
        reuseExistingServer: !process.env.CI,
        timeout: 20_000,
    },
    projects: [
        { name: 'renderer', testDir: './e2e/renderer' },
        { name: 'electron', testDir: './e2e/electron' },
    ],
});
