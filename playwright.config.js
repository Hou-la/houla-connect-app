// Config Playwright pour l'E2E Electron. On ne teste PAS un navigateur : on lance
// l'app packagée (dist/main via _electron.launch). testDir séparé des TU (node:test).
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
    testDir: './e2e',
    timeout: 60_000,
    expect: { timeout: 15_000 },
    fullyParallel: false,
    workers: 1, // une seule instance Electron à la fois (single-instance lock)
    retries: process.env.CI ? 1 : 0,
    reporter: [['list']],
});
