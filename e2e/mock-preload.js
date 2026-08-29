// Mock de window.houlaConnect pour l'E2E "renderer" (Chromium headless). Injecté par
// page.addInitScript AVANT renderer.js. App AUTHENTIFIÉE + défauts sensés ; un test
// surcharge via window.__E2E_MOCK__ (DONNÉES uniquement — les fonctions ne passent pas
// la frontière d'injection). Les appels clés sont enregistrés dans window.__E2E_CALLS__.
(function () {
    const cfg = window.__E2E_MOCK__ || {};
    const R = (v) => Promise.resolve(v);
    const rej = (m) => Promise.reject(new Error(m));
    const noop = () => {};
    const unsub = () => noop;
    const calls = (window.__E2E_CALLS__ = {});
    const rec = (name, fn) => (...args) => { (calls[name] = calls[name] || []).push(args); return fn(...args); };

    window.houlaConnect = {
        login: () => R(), logout: () => R(),
        authStatus: () => R({ authenticated: cfg.authenticated !== false }),
        isAdmin: () => R(false),
        env: { get: () => R('prod'), set: () => R() },
        listWorkspaces: () => R(cfg.workspaces || [{ id: 'ws1', name: 'Test Studio', slug: 'test', avatarUrl: null }]),
        currentWorkspace: () => R(cfg.currentWorkspace || { id: 'ws1', name: 'Test Studio' }),
        selectWorkspace: rec('selectWorkspace', () => R({})),
        appVersion: () => R('0.0.0-e2e'),
        isDevBuild: () => R(false),
        openExternal: () => R(),
        gifts: { catalog: () => R(cfg.gifts || []) },
        store: {
            list: () => R(cfg.store || []),
            preview: (slug) => R({ bundle: { slug } }),
            install: rec('install', () => (cfg.installError ? rej(cfg.installError) : R({ ok: true, requiredConnectors: [] }))),
            installed: () => R(cfg.installed || []),
            uninstall: rec('uninstall', () => R({ ok: true })),
        },
        customize: { get: () => R(cfg.customize || { slug: 's', version: '1.0.0', rules: [], instructions: null }), save: () => R({ ok: true }) },
        lab: {
            create: rec('create', () => (cfg.createError ? rej(cfg.createError) : R({ ok: true }))),
            update: () => R({ ok: true }),
            dictionary: () => R(cfg.dictionary || []), // liste de {slug,label} (types/games)
            myBundles: () => R(cfg.myBundles || []),
            detail: () => R(cfg.labDetail || { bundle: { slug: 's' }, versions: [] }),
            stats: () => R({}), topBroadcasters: () => R([]),
            submitVersion: rec('submitVersion', () => (cfg.submitVersionError ? rej(cfg.submitVersionError) : R({ ok: true }))),
            publish: rec('publish', () => R({ ok: true })),
            pickBanner: () => R(null), uploadBannerFile: () => R({ ok: true }),
            pickIcon: () => R(null), uploadIconFile: () => R({ ok: true }),
        },
        caps: { get: () => R([]), grant: () => R(), revoke: () => R(), setHosts: () => R(), setFocusTarget: () => R() },
        secrets: { set: () => R(), names: () => R([]) },
        connectors: { list: () => R(cfg.connectors || []), save: () => R({ id: 'c1' }), remove: () => R(), enable: rec('enable', () => R()) },
        bindings: { get: () => R({}), set: () => R() },
        engine: {
            start: () => R({ ok: true }), stop: () => R(), panic: () => R(),
            test: () => R({ ok: true }),
            testRule: rec('testRule', () => R(cfg.testRuleResult || { ok: true })),
            testInstalled: rec('testInstalled', () => R(cfg.testRuleResult || { ok: true })),
            status: () => R({ state: 'idle' }),
        },
        language: () => R(), autoLaunch: () => R(false),
        legal: { text: () => R(''), status: () => R({ accepted: true }), accept: () => R() },
        update: { check: () => R(), install: () => R() },
        win: { minimize: noop, maximize: noop, close: noop },
        onState: unsub, onLog: unsub, onAuth: unsub, onUpdate: unsub, onApiStatus: unsub,
    };
})();
