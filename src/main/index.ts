import { app, BrowserWindow, ipcMain, globalShortcut, shell, dialog } from 'electron';
import { autoUpdater } from 'electron-updater';
import * as path from 'path';
import { CONFIG } from './config';
import { StoreService } from './services/store.service';
import { ApiService } from './services/api.service';
import { AuthService } from './services/auth.service';
import { ConnectionService, ConnState } from './services/connection.service';
import { TriggerRouter } from './engine/trigger-router';
import { Engine, AuditEntry } from './engine/engine';
import { PythonSidecar } from './engine/python-sidecar';
import { BundleManifest } from './engine/types';

const store = new StoreService();
const api = new ApiService(store);
const auth = new AuthService(api, store);

let win: BrowserWindow | null = null;
let sidecarInstance: PythonSidecar | null = null;
let activeManifest: BundleManifest | null = null;
let engineRunning = false;

function sidecarPath(): string {
    const bin = process.platform === 'win32' ? 'houla-sidecar.exe' : 'houla-sidecar';
    return app.isPackaged
        ? path.join(process.resourcesPath, 'sidecar', bin)
        : path.join(__dirname, '..', '..', 'resources', 'sidecar', bin);
}
function sidecar(): PythonSidecar {
    if (!sidecarInstance) sidecarInstance = new PythonSidecar(sidecarPath());
    return sidecarInstance;
}

function send(channel: string, payload: unknown): void {
    win?.webContents.send(channel, payload);
}

// Auto-update depuis GitHub Releases (dépôt public). On câble les événements ;
// le renderer déclenche le check (pour qu'il écoute déjà) et propose Installer.
function setupAutoUpdate(): void {
    if (!app.isPackaged) return;
    autoUpdater.autoDownload = true;
    autoUpdater.on('checking-for-update', () => send('onUpdate', { status: 'checking' }));
    autoUpdater.on('update-available', (i: any) => send('onUpdate', { status: 'available', version: i?.version }));
    autoUpdater.on('update-not-available', () => send('onUpdate', { status: 'none' }));
    autoUpdater.on('download-progress', (p: any) => send('onUpdate', { status: 'downloading', percent: Math.round(p?.percent || 0) }));
    autoUpdater.on('update-downloaded', (i: any) => send('onUpdate', { status: 'downloaded', version: i?.version }));
    autoUpdater.on('error', (e: any) => send('onUpdate', { status: 'error', message: String(e?.message || e) }));
}

// ── Moteur : le renderer n'envoie que du déclaratif, MAIN exécute ──
const engine = new Engine({
    getCapabilities: () => store.getCapabilities(),
    getVars: () => store.resolveVars(),
    getHostAllowlist: () => store.getHostAllowlist(),
    getRconConfig: () => store.getRconConfig(),
    getObsConfig: () => store.getObsConfig(),
    sidecar,
    // TODO focus-guard natif (fenêtre au premier plan). Permissif tant que non implémenté.
    isTargetFocused: () => true,
    audit: (e: AuditEntry) => send('onLog', e),
});
const router = new TriggerRouter(engine, () => store.resolveVars());

const conn = new ConnectionService(router, (s: ConnState) => send('onState', s));

// ═══════════════════════ Fenêtre frameless ═══════════════════════
function createWindow(): void {
    win = new BrowserWindow({
        width: 1180,
        height: 780,
        minWidth: 900,
        minHeight: 620,
        frame: false, // fenêtre SANS bordure Windows (titlebar custom)
        titleBarStyle: 'hidden',
        backgroundColor: '#0e0f13',
        icon: path.join(__dirname, '..', '..', 'resources', 'icon.png'),
        webPreferences: {
            preload: path.join(__dirname, '..', 'preload', 'index.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });
    win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\//.test(url)) shell.openExternal(url);
        return { action: 'deny' };
    });
    // Lancement à FROID par le protocole (Windows) : l'URL est dans argv, on la
    // traite une fois le renderer prêt (sinon le message onAuth est perdu).
    win.webContents.once('did-finish-load', () => {
        const coldUrl = process.argv.find((a) => a.startsWith(`${CONFIG.protocol}://`));
        if (coldUrl) handleDeepLink(coldUrl);
    });
}

// ── Deep-link OAuth (houla-connect://callback?code=...) ──
function handleDeepLink(url: string): void {
    if (!url?.startsWith(`${CONFIG.protocol}://`)) return;
    auth
        .handleCallback(url)
        .then(() => send('onAuth', { authenticated: true }))
        .catch((e) => send('onAuth', { authenticated: false, error: e.message }));
}

// ═══════════════════════ IPC (surface fixe) ═══════════════════════
function registerIpc(): void {
    ipcMain.handle('auth:login', () => auth.login());
    ipcMain.handle('auth:logout', () => {
        conn.disconnect();
        auth.logout();
        return { authenticated: false };
    });
    ipcMain.handle('auth:status', () => ({ authenticated: auth.isAuthenticated() }));
    ipcMain.handle('workspaces:list', () => api.listWorkspaces());
    ipcMain.handle('workspaces:current', () => ({ id: store.getWorkspaceId(), name: store.getWorkspaceName() }));
    ipcMain.handle('app:version', () => app.getVersion());
    ipcMain.handle('update:check', () => {
        if (!app.isPackaged) {
            send('onUpdate', { status: 'dev' });
            return { ok: false };
        }
        autoUpdater
            .checkForUpdates()
            .catch((e: any) => send('onUpdate', { status: 'error', message: String(e?.message || e) }));
        return { ok: true };
    });
    ipcMain.handle('update:install', () => autoUpdater.quitAndInstall());
    ipcMain.handle('workspaces:select', (_e, ws: { id: string; name: string }) => {
        store.setWorkspace(ws.id, ws.name);
        store.clearEventKey(); // la clé event est par-workspace : la re-minter
        return { ok: true };
    });

    // Store
    ipcMain.handle('store:list', (_e, q) => api.listStore(q || {}));
    ipcMain.handle('store:preview', (_e, slug: string) => api.previewBundle(slug));
    ipcMain.handle('store:install', async (_e, slug: string, version?: string) => {
        const d = await api.fetchVerifiedManifest(slug, version); // vérifie signature
        const list = store.getInstalled().filter((b) => b.slug !== slug);
        list.push({ slug, version: d.version, contentHash: d.contentHash });
        store.setInstalled(list);
        return { ok: true, capabilities: d.capabilities, hosts: d.hosts };
    });
    ipcMain.handle('store:installed', () => store.getInstalled());

    // Lab (créateur)
    ipcMain.handle('lab:create', (_e, dto) => api.createBundle(dto));
    ipcMain.handle('lab:mybundles', () => api.myBundles());
    ipcMain.handle('lab:detail', (_e, slug: string) => api.myBundleDetail(slug));
    ipcMain.handle('lab:version', (_e, slug: string, dto) => api.submitVersion(slug, dto));
    ipcMain.handle('lab:publish', (_e, slug: string) => api.publishBundle(slug));
    ipcMain.handle('lab:banner', async (_e, slug: string) => {
        const r = await dialog.showOpenDialog({
            properties: ['openFile'],
            filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
        });
        if (r.canceled || !r.filePaths[0]) return null;
        return api.uploadBanner(slug, r.filePaths[0]);
    });
    ipcMain.handle('store:uninstall', (_e, slug: string) => {
        store.setInstalled(store.getInstalled().filter((b) => b.slug !== slug));
        if (store.getActiveBundleSlug() === slug) store.setActiveBundleSlug(undefined);
        return { ok: true };
    });

    // Capacités / secrets / focus
    ipcMain.handle('caps:get', () => ({
        capabilities: [...store.getCapabilities()],
        hostAllowlist: store.getHostAllowlist(),
        focusTarget: store.getFocusTarget(),
    }));
    ipcMain.handle('caps:grant', (_e, cap: string) => (store.setCapability(cap, true), { ok: true }));
    ipcMain.handle('caps:revoke', (_e, cap: string) => (store.setCapability(cap, false), { ok: true }));
    ipcMain.handle('caps:setHosts', (_e, hosts: string[]) => (store.setHostAllowlist(hosts || []), { ok: true }));
    ipcMain.handle('caps:setFocusTarget', (_e, t) => (store.setFocusTarget(t || {}), { ok: true }));
    ipcMain.handle('secrets:set', (_e, name: string, value: string) => (store.setSecret(name, value), { ok: true }));
    ipcMain.handle('secrets:names', () => store.listSecretNames());

    // Runtime
    ipcMain.handle('engine:start', async (_e, slug: string) => {
        store.setActiveBundleSlug(slug);
        const d = await api.fetchVerifiedManifest(slug); // re-vérifie signature avant exécution
        activeManifest = d.manifest as BundleManifest;
        router.setManifest(activeManifest);
        const reactSlugs = activeManifest.rules.filter((r) => r.on.type === 'gift').map((r) => r.on.slot!);
        const events = ['gift', 'follow', 'comment', 'viewer', 'hearts'];
        const key = await api.ensureEventKey(events);
        conn.connect(key);
        engineRunning = true;
        send('onState', { connected: false, events, reactSlugs });
        return { ok: true };
    });
    ipcMain.handle('engine:stop', () => {
        conn.disconnect();
        router.setManifest(null);
        engineRunning = false;
        return { ok: true };
    });
    ipcMain.handle('engine:panic', async () => {
        conn.disconnect();
        await engine.panic();
        sidecarInstance?.kill();
        engineRunning = false;
        send('onState', { connected: false });
        return { ok: true };
    });
    ipcMain.handle('engine:test', (_e, slug: string) => (conn.simulateGift(slug), { ok: true }));
    ipcMain.handle('engine:status', () => ({ running: engineRunning, connected: conn.connected }));
    ipcMain.handle('prefs:language', (_e, lang?: string) => {
        if (lang) store.setLanguage(lang);
        return store.getLanguage();
    });

    // Contrôles de fenêtre (titlebar custom, frameless).
    ipcMain.handle('win:minimize', () => win?.minimize());
    ipcMain.handle('win:maximize', () => (win?.isMaximized() ? win.unmaximize() : win?.maximize()));
    ipcMain.handle('win:close', () => win?.close());
}

// ═══════════════════════ Lifecycle ═══════════════════════
if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', (_e, argv) => {
        const url = argv.find((a) => a.startsWith(`${CONFIG.protocol}://`));
        if (url) handleDeepLink(url);
        win?.show();
        win?.focus();
    });
    app.on('open-url', (_e, url) => handleDeepLink(url)); // macOS

    app.whenReady().then(() => {
        // En dev (electron .), il faut passer execPath + le chemin de l'app, sinon
        // le protocole relance electron.exe sans l'app et l'auth ne revient pas.
        if (process.defaultApp && process.argv.length >= 2) {
            app.setAsDefaultProtocolClient(CONFIG.protocol, process.execPath, [path.resolve(process.argv[1])]);
        } else if (!app.isDefaultProtocolClient(CONFIG.protocol)) {
            app.setAsDefaultProtocolClient(CONFIG.protocol);
        }
        registerIpc();
        createWindow();
        setupAutoUpdate();
        // PANIC global : Ctrl+Alt+Pause.
        globalShortcut.register('Control+Alt+Pause', () => {
            conn.disconnect();
            engine.panic();
            sidecarInstance?.kill();
            send('onState', { connected: false });
            send('onLog', { ts: Date.now(), ruleId: 'PANIC', trigger: 'panic', sender: '', executor: 'keyboard', allowed: false, reason: 'PANIC déclenché' });
        });
        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) createWindow();
        });
    });

    app.on('will-quit', () => {
        globalShortcut.unregisterAll();
        conn.disconnect();
        engine.dispose();
        sidecarInstance?.kill();
    });
    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') app.quit();
    });
}
