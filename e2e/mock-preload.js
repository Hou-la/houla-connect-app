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
    // État d'installation MUTABLE : install(slug) ajoute le pack, uninstall le retire ->
    // les cartes du Store reflètent la transition (Installer <-> Installé ✓) en E2E.
    const installedState = (cfg.installed || []).slice();
    // CAPACITE machine + EFFECTIF par pack : etat MUTABLE, comme le vrai stockage.
    const padCap = Object.assign({ count: 0, kind: 'x360' }, cfg.padCapacity || {});
    const rosters = Object.assign({}, cfg.rosters || {});
    const verOf = (slug) => ((cfg.store || []).find((p) => p.slug === slug) || {}).version || '1.0.0';

    window.houlaConnect = {
        login: () => R(), logout: () => R(),
        authStatus: () => R({ authenticated: cfg.authenticated !== false }),
        isAdmin: () => R(!!cfg.isAdmin),
        moderation: {
            queue: rec('modQueue', () => R(cfg.moderationQueue || { ok: true, items: [] })),
            count: () => R(cfg.moderationCount || { ok: true, count: 0, oldestDays: null }),
            approve: rec('modApprove', () => R(cfg.moderationApproveResult || { ok: true })),
            reject: rec('modReject', () => R({ ok: true })),
        },
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
            preview: (slug) => R({ bundle: (cfg.store || []).find((p) => p.slug === slug) || { slug } }),
            install: rec('install', (slug) => {
                if (cfg.installError) return rej(cfg.installError);
                if (!installedState.find((x) => x.slug === slug)) installedState.push({ slug, version: verOf(slug) });
                return R({ ok: true, requiredConnectors: cfg.requiredConnectors || [],
                    usesGamepad: !!cfg.usesGamepad,
                    profiles: cfg.profiles || [], gamepadProfiles: cfg.gamepadProfiles || [] });
            }),
            installed: () => R(installedState),
            uninstall: rec('uninstall', (slug) => {
                const i = installedState.findIndex((x) => x.slug === slug);
                if (i >= 0) installedState.splice(i, 1);
                return R({ ok: true });
            }),
        },
        customize: {
            get: () => R(cfg.customize || { slug: 's', version: '1.0.0', rules: [], instructions: null }),
            save: rec('customizeSave', () => R({ ok: true })),
            setProfile: rec('setProfile', (slug, profile) => R({ ok: true, profile })),
        },
        lab: {
            create: rec('create', () => (cfg.createError ? rej(cfg.createError) : R({ ok: true }))),
            update: rec('update', () => R({ ok: true })),
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
        driver: {
            installGamepad: rec('installGamepad', () => R(cfg.installGamepadResult || { ok: true })),
            isGamepadInstalled: () => R({ installed: !!cfg.gamepadDriverInstalled }),
            gamepadStatus: () => (cfg.gamepadStatusError
                ? rej('sonde indisponible')
                : R(cfg.gamepadStatus || { connected: false, engineRunning: false })),
            releaseGamepad: rec('releaseGamepad', () => R(cfg.releaseGamepadResult || { ok: true })),
            // CAPACITE (machine, globale) : mutable, avec la MEME regle que le
            // main -- au-dela de 2 manettes le type bascule en ds4, parce que
            // Windows n'a que 4 emplacements XInput. Un mock qui ne la porterait
            // pas laisserait passer une regression invisible en test.
            capacity: rec('capacity', (req) => {
                if (req && typeof req.count === 'number') {
                    padCap.count = Math.max(0, Math.min(8, Math.round(req.count)));
                    if (req.kind === 'x360' || req.kind === 'ds4') padCap.kind = req.kind;
                }
                // Le type n'est PLUS force ici : c'est une PREFERENCE. Le type
                // reellement cree depend de l'effectif du soir (typeManettes).
                // Forcer sur la capacite creait des manettes DS4 invisibles d'un
                // jeu XInput alors qu'on ne jouait qu'a deux.
                return R({ count: padCap.count, kind: padCap.kind });
            }),
            seedLabels: rec('seedLabels', () => R({ ok: true })),
            // EFFECTIF (par pack) : memorise en memoire pour la duree du test,
            // pour que « je regle, je change de pack, je reviens » se teste.
            roster: rec('roster', (slug) => {
                const memo = rosters[slug];
                return R({
                    slug,
                    capacity: padCap.count,
                    kind: padCap.kind,
                    usesGamepad: cfg.rosterUsesGamepad === undefined ? true : cfg.rosterUsesGamepad,
                    configured: memo !== undefined,
                    players: memo === undefined
                        ? Array.from({ length: padCap.count }, (_, i) => ({ id: i + 1 }))
                        : memo,
                });
            }),
            setRoster: rec('setRoster', (slug, players) => {
                rosters[slug] = (players || []).map((p) => ({ id: p.id, label: p.label || '' }));
                return R(cfg.setRosterResult || { ok: true, published: false });
            }),
        },
        game: {
            detect: () => R(cfg.gameDetected || []),
            linkPackTo: rec('gameLinkPackTo', () => R({ ok: true, exe: 'C:/Games/Demo/game.exe', dir: 'C:/Games/Demo' })),
            linkPack: rec('gameLinkPack', () => R(cfg.gameLinkResult || { ok: true, exe: 'C:/Games/Demo/game.exe', dir: 'C:/Games/Demo' })),
            packStatus: () => R(cfg.gamePackStatus || { exe: null, dir: null, placed: false }),
            listLinked: () => R(cfg.gameLinked || []),
            unlinkPack: rec('gameUnlinkPack', () => R({ ok: true })),
        },
        // Catalogues de langue : servis par le MAIN dans l'app reelle. Le harnais
        // e2e sert la page en http, ou `fetch` marcherait -- ce qui masquait
        // justement que l'i18n ne marche PAS dans l'app packagee.
        i18nCatalog: (lang) => R((cfg.catalogs || {})[lang] || {}),
        language: () => R(), autoLaunch: () => R(false),
        legal: { text: () => R(''), status: () => R({ accepted: true }), accept: () => R() },
        update: { check: () => R(), install: () => R() },
        win: { minimize: noop, maximize: noop, close: noop },
        onState: unsub, onLog: unsub, onAuth: unsub, onUpdate: unsub, onApiStatus: unsub,
    };
})();
