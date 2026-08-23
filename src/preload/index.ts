import { contextBridge, ipcRenderer } from 'electron';

// Surface FIXE exposée au renderer. Aucun canal n'accepte de payload exécutable :
// le renderer n'envoie que du déclaratif (slug, cap, nom de secret, toggle).
const invoke = (ch: string, ...args: unknown[]) => ipcRenderer.invoke(ch, ...args);
const on = (ch: string, cb: (payload: any) => void) => {
    const listener = (_e: unknown, payload: any) => cb(payload);
    ipcRenderer.on(ch, listener);
    return () => ipcRenderer.removeListener(ch, listener);
};

contextBridge.exposeInMainWorld('houlaConnect', {
    login: () => invoke('auth:login'),
    logout: () => invoke('auth:logout'),
    authStatus: () => invoke('auth:status'),
    isAdmin: () => invoke('auth:isAdmin'),
    env: {
        get: () => invoke('env:get'),
        set: (env: string) => invoke('env:set', env),
    },
    listWorkspaces: () => invoke('workspaces:list'),
    currentWorkspace: () => invoke('workspaces:current'),
    selectWorkspace: (ws: { id: string; name: string }) => invoke('workspaces:select', ws),
    appVersion: () => invoke('app:version'),

    gifts: {
        catalog: (force?: boolean) => invoke('gifts:catalog', force),
    },
    store: {
        list: (q?: Record<string, string>) => invoke('store:list', q),
        preview: (slug: string) => invoke('store:preview', slug),
        install: (slug: string, version?: string) => invoke('store:install', slug, version),
        installed: () => invoke('store:installed'),
        uninstall: (slug: string) => invoke('store:uninstall', slug),
    },
    customize: {
        get: (slug: string) => invoke('customize:get', slug),
        save: (slug: string, overlay: unknown) => invoke('customize:save', slug, overlay),
    },
    lab: {
        create: (dto: unknown) => invoke('lab:create', dto),
        update: (slug: string, dto: unknown) => invoke('lab:update', slug, dto),
        dictionary: (kind?: string) => invoke('lab:dictionary', kind),
        myBundles: () => invoke('lab:mybundles'),
        detail: (slug: string) => invoke('lab:detail', slug),
        submitVersion: (slug: string, dto: unknown) => invoke('lab:version', slug, dto),
        publish: (slug: string) => invoke('lab:publish', slug),
        uploadBanner: (slug: string) => invoke('lab:banner', slug),
        pickIcon: () => invoke('lab:pickIcon'),
        uploadIconFile: (slug: string, slot: string, filePath: string) => invoke('lab:uploadIconFile', slug, slot, filePath),
    },
    caps: {
        get: () => invoke('caps:get'),
        grant: (cap: string) => invoke('caps:grant', cap),
        revoke: (cap: string) => invoke('caps:revoke', cap),
        setHosts: (hosts: string[]) => invoke('caps:setHosts', hosts),
        setFocusTarget: (t: { exe?: string; title?: string }) => invoke('caps:setFocusTarget', t),
    },
    secrets: {
        set: (name: string, value: string) => invoke('secrets:set', name, value), // write-only
        names: () => invoke('secrets:names'),
    },
    connectors: {
        list: () => invoke('connectors:list'),
        save: (c: unknown) => invoke('connectors:save', c),
        remove: (id: string) => invoke('connectors:delete', id),
        enable: (id: string, enabled: boolean) => invoke('connectors:enable', id, enabled),
    },
    bindings: {
        get: (slug: string) => invoke('bindings:get', slug),
        set: (slug: string, role: string, connectorId: string) => invoke('bindings:set', slug, role, connectorId),
    },
    engine: {
        start: (slug: string) => invoke('engine:start', slug),
        stop: () => invoke('engine:stop'),
        panic: () => invoke('engine:panic'),
        test: (slug: string) => invoke('engine:test', slug),
        testRule: (rule: unknown, bundleSlug?: string) => invoke('engine:testRule', rule, bundleSlug),
        status: () => invoke('engine:status'),
    },
    language: (lang?: string) => invoke('prefs:language', lang),
    autoLaunch: (enabled?: boolean) => invoke('prefs:autolaunch', enabled),
    legal: {
        text: () => invoke('legal:text'),
        status: () => invoke('legal:status'),
        accept: () => invoke('legal:accept'),
    },
    update: {
        check: () => invoke('update:check'),
        install: () => invoke('update:install'),
    },

    // frameless window controls
    win: {
        minimize: () => invoke('win:minimize'),
        maximize: () => invoke('win:maximize'),
        close: () => invoke('win:close'),
    },

    // streams main -> renderer
    onState: (cb: (s: any) => void) => on('onState', cb),
    onLog: (cb: (l: any) => void) => on('onLog', cb),
    onAuth: (cb: (a: any) => void) => on('onAuth', cb),
    onUpdate: (cb: (u: any) => void) => on('onUpdate', cb),
});
