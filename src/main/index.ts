import { app, BrowserWindow, ipcMain, globalShortcut, shell, dialog, Tray, Menu, nativeImage } from 'electron';
import { autoUpdater } from 'electron-updater';
import * as path from 'path';
import * as fs from 'fs';
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

// Version des CGU : à incrémenter à chaque révision substantielle -> re-acceptation.
const LEGAL_VERSION = '1.0';

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false; // vrai seulement quand on quitte VRAIMENT (menu tray)
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

/** Applique le calque de perso locale à un manifeste (copie, ne mute rien) :
 *  retire les interactions désactivées, override les cooldowns. Le manifeste SIGNÉ
 *  reste intact ; c'est un réglage runtime propre au streamer, qui survit aux MAJ. */
function applyPackOverlay(
    manifest: BundleManifest,
    overlay: { disabled: string[]; cooldownMs: Record<string, number> },
): BundleManifest {
    const disabled = new Set(overlay.disabled);
    const rules = (manifest.rules || [])
        .filter((r) => !disabled.has(r.id))
        .map((r) => {
            const cd = overlay.cooldownMs[r.id];
            return cd != null ? { ...r, effect: { ...r.effect, cooldownMs: cd } } : r;
        });
    return { ...manifest, rules };
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
    autoUpdater.on('error', (e: any) => {
        const raw = String(e?.message || e || '');
        console.error('[autoUpdate] error:', raw); // détail technique en console seulement
        // 404 / latest.yml absent = pas encore de métadonnées de mise à jour pour cette
        // plateforme -> bénin, on affiche « à jour » plutôt qu'une trace effrayante.
        if (/latest\.yml|404|not found|ENOTFOUND|getaddrinfo/i.test(raw)) {
            send('onUpdate', { status: 'none' });
        } else {
            send('onUpdate', { status: 'error', message: 'Vérification des mises à jour indisponible pour le moment.' });
        }
    });
}

// ── Moteur : le renderer n'envoie que du déclaratif, MAIN exécute ──
const engine = new Engine({
    getCapabilities: () => store.getCapabilities(),
    getVars: () => store.resolveVars(),
    getHostAllowlist: () => store.getHostAllowlist(),
    getRconConfig: () => store.getRconConfig(),
    getObsConfig: () => store.getObsConfig(),
    getMqttConfig: () => store.getMqttConfig(),
    // Résout le connecteur lié à un effet : rôle = effect.connector || type ;
    // liaison du bundle (actif en live, ou passé en test depuis le Lab).
    resolveConnector: (effect: any, bundleSlug?: string) => {
        const slug = bundleSlug || store.getActiveBundleSlug();
        if (!slug) return null;
        const role = effect?.connector || effect?.type;
        const id = store.getBindings(slug)[role];
        return id ? store.getConnectorConfig(id) : null;
    },
    hasEnabledConnector: (type: string) => store.hasEnabledConnector(type),
    sidecar,
    // TODO focus-guard natif (fenêtre au premier plan). Permissif tant que non implémenté.
    isTargetFocused: () => true,
    audit: (e: AuditEntry) => send('onLog', e),
});
const router = new TriggerRouter(engine, () => store.resolveVars());

const conn = new ConnectionService(router, (s: ConnState) => send('onState', s), () => api.base());

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
    // Fermer = réduire dans le tray (l'app tourne EN ARRIÈRE-PLAN : le moteur continue
    // de déclencher les effets). Seul « Quitter » (tray) ferme vraiment.
    win.on('close', (e) => {
        if (!isQuitting) {
            e.preventDefault();
            win?.hide();
        }
    });
}

// ═══════════════════════ Tray (arrière-plan) ═══════════════════════
function trayIcon(): Electron.NativeImage {
    const p = path.join(__dirname, '..', '..', 'resources', 'icon.png');
    try {
        const img = nativeImage.createFromPath(p).resize({ width: 16, height: 16 });
        if (!img.isEmpty()) return img;
    } catch {
        /* fallback vide */
    }
    return nativeImage.createEmpty();
}
function createTray(): void {
    if (tray) return;
    tray = new Tray(trayIcon());
    tray.setToolTip('Hou.la Connect');
    const menu = Menu.buildFromTemplate([
        { label: 'Afficher', click: () => { win?.show(); win?.focus(); } },
        { type: 'separator' },
        {
            label: 'PANIC (tout arrêter)',
            click: () => {
                conn.disconnect();
                engine.panic();
                sidecarInstance?.kill();
                send('onState', { connected: false });
            },
        },
        { type: 'separator' },
        { label: 'Quitter', click: () => { isQuitting = true; app.quit(); } },
    ]);
    tray.setContextMenu(menu);
    tray.on('click', () => {
        if (win?.isVisible()) win.hide();
        else { win?.show(); win?.focus(); }
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
    ipcMain.handle('auth:isAdmin', () => api.isAdmin());
    ipcMain.handle('env:get', () => store.getEnvironment() || 'prod');
    ipcMain.handle('env:set', (_e, env: string) => {
        // Changer d'environnement invalide la session (tokens propres à l'API) :
        // on déconnecte pour forcer une reconnexion sur le bon environnement.
        store.setEnvironment(env);
        conn.disconnect();
        auth.logout();
        store.clearEventKey();
        return { ok: true };
    });
    ipcMain.handle('workspaces:list', () => api.listWorkspaces());
    ipcMain.handle('workspaces:current', () => ({ id: store.getWorkspaceId(), name: store.getWorkspaceName() }));
    ipcMain.handle('app:version', () => app.getVersion());
    ipcMain.handle('update:check', () => {
        if (!app.isPackaged) {
            send('onUpdate', { status: 'dev' });
            return { ok: false };
        }
        // L'event autoUpdater 'error' (assaini) gère l'affichage : ici on ne fait que logger.
        autoUpdater.checkForUpdates().catch((e: any) => console.error('[autoUpdate] check:', e?.message || e));
        return { ok: true };
    });
    ipcMain.handle('update:install', () => autoUpdater.quitAndInstall());
    ipcMain.handle('workspaces:select', (_e, ws: { id: string; name: string }) => {
        store.setWorkspace(ws.id, ws.name);
        store.clearEventKey(); // la clé event est par-workspace : la re-minter
        return { ok: true };
    });

    // Store
    ipcMain.handle('gifts:catalog', (_e, force?: boolean) => api.getGiftCatalog(!!force));
    ipcMain.handle('store:list', (_e, q) => api.listStore(q || {}));
    ipcMain.handle('store:preview', (_e, slug: string) => api.previewBundle(slug));
    ipcMain.handle('store:install', async (_e, slug: string, version?: string) => {
        const d = await api.fetchVerifiedManifest(slug, version); // vérifie signature
        const list = store.getInstalled().filter((b) => b.slug !== slug);
        list.push({ slug, version: d.version, contentHash: d.contentHash });
        store.setInstalled(list);
        // Connecteurs requis (rôle + type) à lier : protocoles réseau du manifeste.
        const NET = ['rcon', 'obs', 'mqtt', 'ws', 'http', 'osc'];
        const req = new Map<string, { role: string; type: string }>();
        for (const r of (d.manifest?.rules || []) as any[]) {
            const t = r?.effect?.type;
            if (!NET.includes(t)) continue;
            const role = r.effect.connector || t;
            req.set(`${role}:${t}`, { role, type: t });
        }
        return { ok: true, capabilities: d.capabilities, hosts: d.hosts, requiredConnectors: [...req.values()] };
    });
    ipcMain.handle('store:installed', () => store.getInstalled());

    // Lab (créateur)
    ipcMain.handle('lab:create', (_e, dto) => api.createBundle(dto));
    ipcMain.handle('lab:update', (_e, slug: string, dto) => api.updateBundle(slug, dto));
    ipcMain.handle('lab:dictionary', (_e, kind?: string) => api.getDictionary(kind));
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
    // Choisir une icône SANS uploader : on renvoie le chemin (pour l'upload différé)
    // + un data-URL pour l'aperçu immédiat. L'upload se fait à la création du pack.
    ipcMain.handle('lab:pickIcon', async () => {
        const r = await dialog.showOpenDialog({
            properties: ['openFile'],
            filters: [{ name: 'Icône PNG transparent', extensions: ['png', 'webp'] }],
        });
        if (r.canceled || !r.filePaths[0]) return null;
        const filePath = r.filePaths[0];
        try {
            const buf = fs.readFileSync(filePath);
            const ext = filePath.toLowerCase().endsWith('.webp') ? 'webp' : 'png';
            return { filePath, dataUrl: `data:image/${ext};base64,${buf.toString('base64')}` };
        } catch {
            return { filePath, dataUrl: null };
        }
    });
    ipcMain.handle('lab:uploadIconFile', (_e, slug: string, slot: string, filePath: string) =>
        api.uploadSlotIcon(slug, slot, filePath),
    );
    ipcMain.handle('store:uninstall', (_e, slug: string) => {
        store.setInstalled(store.getInstalled().filter((b) => b.slug !== slug));
        if (store.getActiveBundleSlug() === slug) store.setActiveBundleSlug(undefined);
        return { ok: true };
    });

    // ── Personnalisation LOCALE d'un pack installé (calque, pas de publication) ──
    ipcMain.handle('customize:get', async (_e, slug: string) => {
        const d = await api.fetchVerifiedManifest(slug); // manifeste signé (lecture seule)
        const overlay = store.getPackOverlay(slug);
        const disabled = new Set(overlay.disabled);
        const rules = ((d.manifest?.rules || []) as any[]).map((r) => ({
            id: r.id,
            label: r.label || '',
            trigger: r.on?.type || 'gift',
            giftSlug: r.on?.giftSlug || r.on?.slot || '',
            effectType: r.effect?.type || '',
            defaultCooldownMs: r.effect?.cooldownMs ?? 0,
            cooldownMs: overlay.cooldownMs[r.id], // override local, ou undefined
            enabled: !disabled.has(r.id),
        }));
        return { slug, version: d.version, rules };
    });
    ipcMain.handle('customize:save', (_e, slug: string, overlay: any) => {
        store.setPackOverlay(slug, overlay || {});
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

    // ── Connecteurs (multiple par protocole) + liaisons bundle -> rôle ──
    ipcMain.handle('connectors:list', () => store.listConnectors());
    ipcMain.handle('connectors:save', (_e, c: any) => store.saveConnector(c));
    ipcMain.handle('connectors:delete', (_e, id: string) => (store.deleteConnector(id), { ok: true }));
    ipcMain.handle('connectors:enable', (_e, id: string, enabled: boolean) => (store.setConnectorEnabled(id, !!enabled), { ok: true }));
    ipcMain.handle('bindings:get', (_e, slug: string) => store.getBindings(slug));
    ipcMain.handle('bindings:set', (_e, slug: string, role: string, connectorId: string) => (store.setBinding(slug, role, connectorId), { ok: true }));

    // ── Légal (CGU / charte d'usage acceptable) ──
    ipcMain.handle('legal:text', () => {
        for (const p of [
            path.join(app.getAppPath(), 'docs', 'conditions-utilisation.html'),
            path.join(process.resourcesPath || '', 'docs', 'conditions-utilisation.html'),
        ]) {
            try {
                return fs.readFileSync(p, 'utf8');
            } catch {
                /* essaie le chemin suivant */
            }
        }
        return '<h1>Conditions d\'utilisation</h1><p>Texte indisponible.</p>';
    });
    ipcMain.handle('legal:status', () => ({
        version: LEGAL_VERSION,
        accepted: store.getLegalAcceptedVersion() === LEGAL_VERSION,
    }));
    ipcMain.handle('legal:accept', () => (store.setLegalAcceptedVersion(LEGAL_VERSION), { ok: true }));

    // Runtime
    ipcMain.handle('engine:start', async (_e, slug: string) => {
        const d = await api.fetchVerifiedManifest(slug); // re-vérifie signature avant exécution
        store.setActiveBundleSlug(slug); // seulement APRÈS un fetch réussi (pas de pack fantôme)
        // Applique le CALQUE local (perso streamer) : désactive des interactions,
        // override des cooldowns. N'altère jamais le manifeste signé sur le disque.
        activeManifest = applyPackOverlay(d.manifest as BundleManifest, store.getPackOverlay(slug));
        router.setManifest(activeManifest);
        const reactSlugs = activeManifest.rules.filter((r) => r.on.type === 'gift').map((r) => r.on.giftSlug ?? r.on.slot!);
        const events = ['gift', 'follow', 'comment', 'viewer', 'hearts'];
        const key = await api.ensureEventKey(events);
        // Pose le pack VISUEL du pack actif sur la clé AVANT la connexion : à l'auth
        // socket, la passerelle lit ce bundleId et l'active côté viewer (le viewer voit
        // CE pack). setKeyBundle invalide le cache de validation -> lu frais au connect.
        await api.setActivePackBundle(d.visualBundleId ?? null).catch(() => {});
        conn.connect(key);
        engineRunning = true;
        send('onState', { connected: false, events, reactSlugs });
        return { ok: true };
    });
    ipcMain.handle('engine:stop', async () => {
        conn.disconnect();
        router.setManifest(null);
        engineRunning = false;
        // Retire le pack visuel côté viewer : plus de pack actif -> plus rien à montrer.
        await api.setActivePackBundle(null).catch(() => {});
        return { ok: true };
    });
    ipcMain.handle('engine:panic', async () => {
        conn.disconnect();
        await engine.panic();
        sidecarInstance?.kill();
        engineRunning = false;
        await api.setActivePackBundle(null).catch(() => {});
        send('onState', { connected: false });
        return { ok: true };
    });
    // Test manuel d'UNE règle depuis le Lab (déclaratif : trigger + effet, joué via
    // le pipeline sécurisé du moteur). Renvoie un verdict {ok, reason} pour l'UI.
    ipcMain.handle('engine:testRule', (_e, rule: any, bundleSlug?: string) => {
        if (!rule || typeof rule !== 'object' || !rule.effect) return { ok: false, reason: 'règle invalide' };
        return engine.testFire({ id: rule.id || 'test', on: rule.on || { type: 'gift' }, effect: rule.effect }, bundleSlug);
    });
    ipcMain.handle('engine:test', (_e, slug?: string) => {
        // Sans slug : simule la 1re interaction cadeau du pack actif (générique ou slot).
        const firstGift = activeManifest?.rules.find((r) => r.on.type === 'gift');
        const s = slug || firstGift?.on.giftSlug || firstGift?.on.slot || 'ix_slot_01';
        conn.simulateGift(s);
        return { ok: true, slug: s };
    });
    ipcMain.handle('engine:status', () => ({ running: engineRunning, connected: conn.connected }));
    ipcMain.handle('prefs:language', (_e, lang?: string) => {
        if (lang) store.setLanguage(lang);
        return store.getLanguage();
    });

    // Contrôles de fenêtre (titlebar custom, frameless). Fermer = réduire au tray.
    ipcMain.handle('win:minimize', () => win?.minimize());
    ipcMain.handle('win:maximize', () => (win?.isMaximized() ? win.unmaximize() : win?.maximize()));
    ipcMain.handle('win:close', () => win?.hide());

    // Démarrage automatique avec le système (arrière-plan).
    ipcMain.handle('prefs:autolaunch', (_e, enabled?: boolean) => {
        if (typeof enabled === 'boolean') {
            store.setAutoLaunch(enabled);
            applyAutoLaunch();
        }
        return store.getAutoLaunch();
    });
}

/** Applique la préférence de lancement au démarrage (openAsHidden : direct au tray). */
function applyAutoLaunch(): void {
    try {
        const enabled = store.getAutoLaunch();
        app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true });
    } catch {
        /* non supporté sur cette plateforme */
    }
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
        store.ensureDefaultConnectors(); // clavier/manette/pilote pré-créés, désactivés
        registerIpc();
        createWindow();
        createTray();
        applyAutoLaunch();
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
    // On NE quitte PAS quand la fenêtre se ferme : l'app vit dans le tray
    // (arrière-plan). Seul « Quitter » (menu tray) termine le process.
    app.on('window-all-closed', () => {
        /* rester en arrière-plan (tray) */
    });
}
