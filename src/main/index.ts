import { app, BrowserWindow, ipcMain, globalShortcut, shell, dialog, Tray, Menu, nativeImage } from 'electron';
import { autoUpdater } from 'electron-updater';
import * as path from 'path';
import * as fs from 'fs';
import { CONFIG, IS_DEV_BUILD } from './config';
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
let gameFocused = true; // focus-guard : le jeu cible est-il au 1er plan (permissif si aucun jeu lié)
let focusPollTimer: NodeJS.Timeout | null = null;
let gamepadSessionOn = false; // manette virtuelle deja presente (evite de re-attendre a chaque test)

function sidecarPath(): string {
    const bin = process.platform === 'win32' ? 'houla-sidecar.exe' : 'houla-sidecar';
    const dir = app.isPackaged
        ? path.join(process.resourcesPath, 'sidecar')
        : path.join(__dirname, '..', '..', 'resources', 'sidecar');
    const exe = path.join(dir, bin);
    // DEV : si l'exe figé (PyInstaller) n'existe pas encore, on lance le script
    // Python directement (nécessite python + interception-python/vgamepad + le driver).
    if (!app.isPackaged && !fs.existsSync(exe)) {
        const py = path.join(dir, 'houla_sidecar.py');
        if (fs.existsSync(py)) return py;
    }
    return exe;
}
function sidecar(): PythonSidecar {
    if (!sidecarInstance) sidecarInstance = new PythonSidecar(sidecarPath());
    return sidecarInstance;
}

// Installeur du pilote ViGEmBus (manette virtuelle Xbox 360), empaqueté À CÔTÉ du sidecar
// figé (même dossier). La manette virtuelle EXIGE ce pilote noyau ; il s'installe via UAC.
function driverMsiPath(): string {
    const dir = app.isPackaged
        ? path.join(process.resourcesPath, 'sidecar')
        : path.join(__dirname, '..', '..', 'resources', 'sidecar');
    return path.join(dir, 'ViGEmBusSetup_x64.msi');
}

// Dossier des DLL proxy XInput empaquetées (xinput1_4/1_3/9_1_0.dll). Posées dans le
// dossier d'un jeu, elles lui font lire la manette VIRTUELLE comme Joueur 1 (voir
// resources/xinput-proxy/proxy.c). C'est ce qui rend les cadeaux effectifs en jeu.
const PROXY_DLL_NAMES = ['xinput1_4.dll', 'xinput1_3.dll', 'xinput9_1_0.dll'];
function proxyDllDir(): string {
    return app.isPackaged
        ? path.join(process.resourcesPath, 'xinput-proxy')
        : path.join(__dirname, '..', '..', 'resources', 'xinput-proxy');
}

// Nos DLL portent ce marqueur (cf. resources/xinput-proxy/proxy.c). On reconnaît ainsi LES
// NÔTRES — y compris une version antérieure lors d'une mise à jour — sans jamais confondre
// avec une DLL xinput TIERCE livrée par un jeu. Comparer les octets ne marcherait pas : la
// moindre nouvelle version du proxy serait prise pour une DLL étrangère et bloquerait tout.
const PROXY_MARKER = Buffer.from('HoulaConnectXInputProxy');
function isOurProxy(file: string): boolean {
    try { return fs.readFileSync(file).includes(PROXY_MARKER); } catch { return false; }
}
/** Pose nos DLL proxy dans le dossier d'un jeu. Refuse d'écraser une DLL xinput ÉTRANGÈRE
 *  (certains jeux livrent la leur) : on préfère renoncer et l'expliquer. */
function placeProxyDlls(dir: string): { ok: boolean; reason?: string } {
    const src = proxyDllDir();
    const foreign = PROXY_DLL_NAMES.find((n) => {
        const dst = path.join(dir, n);
        return fs.existsSync(dst) && !isOurProxy(dst);
    });
    if (foreign) return { ok: false, reason: `Une DLL « ${foreign} » est déjà présente dans le dossier du jeu et n’est pas la nôtre. Retire-la d’abord (ou ce jeu n’en a pas besoin).` };
    try {
        for (const n of PROXY_DLL_NAMES) {
            const s = path.join(src, n);
            if (fs.existsSync(s)) fs.copyFileSync(s, path.join(dir, n));
        }
    } catch (e) {
        return { ok: false, reason: `Impossible d’écrire dans le dossier du jeu : ${(e as Error)?.message || ''}` };
    }
    return { ok: true };
}
/** Retire UNIQUEMENT nos DLL (reconnues au marqueur), jamais celle du jeu. */
function removeProxyDlls(dir: string): void {
    for (const n of PROXY_DLL_NAMES) {
        const dst = path.join(dir, n);
        if (fs.existsSync(dst) && isOurProxy(dst)) {
            try { fs.unlinkSync(dst); } catch { /* déjà retirée, ou tenue par le jeu ouvert */ }
        }
    }
}

// ── Détection automatique du JEU ──
// L'utilisateur ne doit jamais avoir à chercher un .exe dans l'explorateur. On repère les
// jeux EN COURS d'exécution à leur emplacement (bibliothèques de jeux connues) et on les
// propose en un clic. Le pack pourra en plus déclarer son jeu (nom d'exe / dossier Steam) :
// on filtrera alors sur lui, et il n'y aura plus rien à demander.
const GAME_LIB_RX = /(steamapps[\\/]common|Epic Games|GOG Galaxy[\\/]Games|GOG Games|Origin Games|Ubisoft[\\/]Ubisoft Game Launcher|XboxGames)/i;
/** Nom lisible d'un jeu depuis le chemin de son exe (dossier de la bibliothèque). */
function gameNameFromPath(exe: string): string {
    const m = exe.match(/(?:steamapps[\\/]common|Epic Games|GOG Games|Origin Games|XboxGames)[\\/]([^\\/]+)/i);
    return (m && m[1]) || path.basename(exe, path.extname(exe));
}
/** Clé d'un jeu : son dossier dans la bibliothèque (ex. « MECCHA CHAMELEON »). Deux process
 *  du même jeu (lanceur + exécutable réel) partagent cette clé. */
function gameKeyFromPath(exe: string): string {
    const m = exe.match(/((?:steamapps[\\/]common|Epic Games|GOG Games|Origin Games|XboxGames)[\\/][^\\/]+)/i);
    return (m && m[1].toLowerCase()) || exe.toLowerCase();
}
/**
 * Jeux actuellement lancés. `exeName` filtre si le pack déclare son exécutable.
 *
 * ⚠️ Un jeu expose souvent DEUX process : un lanceur à la racine (PenguinHotel.exe) et
 * l'exécutable réel (PenguinHotel-Win64-Shipping.exe, dans Binaries/Win64). Proposer les deux
 * sous le même nom est ingérable, et poser le fichier à côté du lanceur ne sert à RIEN : le
 * jeu ne le charge jamais. On départage donc sur le seul critère qui compte — **quel process
 * a chargé XInput**, c'est-à-dire celui qui lit vraiment la manette — puis on dédoublonne par
 * jeu pour n'en proposer qu'un.
 */
async function detectRunningGames(exeName?: string): Promise<{ name: string; exe: string; dir: string }[]> {
    if (process.platform !== 'win32') return [];
    return await new Promise((resolve) => {
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { spawn } = require('child_process') as typeof import('child_process');
            // On FILTRE D'ABORD sur l'emplacement (quelques process), et on n'inspecte les
            // modules que de ceux-là : inspecter les modules de TOUS les process prenait
            // plusieurs secondes, pendant lesquelles l'interface semblait ne rien faire.
            const script = "Get-Process | Where-Object { $_.Path -and ($_.Path -match 'steamapps\\\\common|Epic Games|GOG Games|Origin Games|XboxGames|Ubisoft') } | ForEach-Object { $x=0; try { if ($_.Modules | Where-Object { $_.ModuleName -like 'xinput*' }) { $x=1 } } catch {}; \"$x|$($_.Path)\" }";
            const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
            let out = '';
            ps.stdout?.on('data', (d: Buffer) => { out += String(d); });
            ps.on('error', () => resolve([]));
            ps.on('exit', () => {
                const want = exeName ? exeName.toLowerCase() : null;
                const rows = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
                    .map((l) => { const i = l.indexOf('|'); return { xi: l.slice(0, i) === '1', exe: l.slice(i + 1) }; })
                    .filter((r) => r.exe && (want ? path.basename(r.exe).toLowerCase() === want : GAME_LIB_RX.test(r.exe)));
                // Un seul candidat par jeu : celui qui lit la manette gagne ; sinon le chemin le
                // plus profond (l'exécutable réel est sous Binaries/…, le lanceur est à la racine).
                const best = new Map<string, { xi: boolean; exe: string }>();
                for (const r of rows) {
                    const k = gameKeyFromPath(r.exe);
                    const cur = best.get(k);
                    if (!cur) { best.set(k, r); continue; }
                    const better = (r.xi && !cur.xi)
                        || (r.xi === cur.xi && r.exe.split(/[\\/]/).length > cur.exe.split(/[\\/]/).length);
                    if (better) best.set(k, r);
                }
                resolve([...best.values()].map((r) => ({ name: gameNameFromPath(r.exe), exe: r.exe, dir: path.dirname(r.exe) })));
            });
        } catch { resolve([]); }
    });
}

// Poll du focus-guard : rafraîchit gameFocused = (fenêtre au 1er plan == exe du jeu lié).
// Sans jeu lié, permissif (true) et AUCUN appel sidecar (self-guard). Démarré pendant un
// pack, arrêté à l'arrêt/panic.
function startFocusPoll(): void {
    stopFocusPoll();
    focusPollTimer = setInterval(async () => {
        const target = store.getFocusTarget();
        if (!target?.exe) { gameFocused = true; return; } // pas de jeu lié -> ne rien bloquer
        try {
            const r = await sidecar().call('foreground', {}, 3000);
            const fg = String((r && (r as { exe?: string }).exe) || '').toLowerCase();
            const base = path.basename(target.exe).toLowerCase();
            gameFocused = fg === target.exe.toLowerCase() || fg.endsWith('\\' + base);
        } catch { /* garder l'état précédent */ }
    }, 350);
}
function stopFocusPoll(): void {
    if (focusPollTimer) { clearInterval(focusPollTimer); focusPollTimer = null; }
    gameFocused = true; // au repos, ne bloquer aucun effet
}

// Avant un TEST manette : activer le passthrough (crée la virtuelle + écrit sa config pour
// la DLL proxy) afin que l'effet ATTEIGNE le jeu même sans pack démarré. Idempotent ; reste
// actif ensuite (le jeu lit la virtuelle = état voulu), nettoyé à l'arrêt/fermeture.
async function ensureGamepadRemap(effect: unknown): Promise<void> {
    if ((effect as { type?: string })?.type !== 'gamepad') return;
    try {
        const already = gamepadSessionOn;
        await sidecar().call('vigem-passthrough', { enable: true });
        gamepadSessionOn = true;
        // Laisser le jeu VOIR la manette qui vient d'apparaître avant de lui parler.
        if (!already) await new Promise((r) => setTimeout(r, 400));
        // ⚠️ « Le premier test ne fait rien, le second marche ».
        // Pour tester, le joueur quitte le jeu (souris/clavier) puis y revient : le jeu a
        // basculé son affichage en mode CLAVIER entre-temps. La première entrée manette qui
        // arrive est alors CONSOMMÉE pour rebasculer en mode manette, sans exécuter l'action.
        // Une simple attente au repos n'y change rien : ces jeux réagissent à une ACTIVITÉ,
        // pas à la présence du périphérique. On envoie donc d'abord une activité de réveil
        // inoffensive — une brève poussée du stick DROIT (caméra), qui ne déclenche aucune
        // action de jeu — puis l'effet réel, qui n'est plus le premier et part vraiment.
        // NB : réservé aux TESTS. En live, le joueur a sa manette en main, le jeu est déjà en
        // mode manette : y ajouter un réveil à chaque cadeau bougerait la caméra pour rien.
        await sidecar().call('vigem-gamepad', { analog: { rx: 0.25 }, holdMs: 80 }, 80);
        await new Promise((r) => setTimeout(r, 250));
    } catch { /* le test remontera l'échec */ }
}
/** Après un test manette HORS pack : débrancher la manette virtuelle.
 *  Sinon elle reste et OCCUPE un emplacement XInput — si c'est le 0, le jeu lit une manette
 *  inerte et celle du joueur « ne marche plus ». Un test ne doit rien laisser derrière lui. */
async function releaseGamepadAfterTest(effect: unknown): Promise<void> {
    if ((effect as { type?: string })?.type !== 'gamepad') return;
    if (engineRunning) return; // un pack tourne : la virtuelle doit rester en place
    try { await sidecar().call('release-pad', {}); } catch { /* noop */ }
    gamepadSessionOn = false;
}

// Traduit un verdict de test en message ACTIONNABLE + un CODE que le renderer utilise pour
// proposer l'installation du bon pilote, au lieu d'un message technique opaque.
//  - 'vigembus' : manette virtuelle -> pilote ViGEmBus absent (installable in-app).
//  - 'sidecar'  : moteur bas niveau introuvable (build sans exe figé / python absent en dev).
function withDriverCode(res: { ok: boolean; reason?: string }): { ok: boolean; reason?: string; code?: string } {
    if (res.ok || !res.reason) return res;
    if (/VIGEMBUS_MISSING/i.test(res.reason))
        return { ok: false, code: 'vigembus', reason: 'Le pilote de la manette virtuelle (ViGEmBus) n\'est pas installé.' };
    if (/pilote\/sidecar non installé|moteur de pilotage bas niveau introuvable/i.test(res.reason))
        return { ok: false, code: 'sidecar', reason: res.reason };
    return res;
}

function send(channel: string, payload: unknown): void {
    win?.webContents.send(channel, payload);
}

// Joignabilité de l'API → toast côté renderer. Sans ça, un back injoignable ouvre
// l'app « vide » en silence (aucun workspace, aucun pack), sans jamais l'expliquer.
api.setStatusListener((online) => send('api:status', { online }));

/**
 * Configuration de commandes ACTIVE d'un pack : celle que le joueur a choisie, sinon
 * celle marquée par défaut, sinon la première. Renvoie `null` si le pack n'en déclare
 * aucune (packs à configuration unique : tout s'applique, comportement historique).
 */
function resolveActiveProfile(manifest: BundleManifest, chosen?: string | null): string | null {
    const profiles = manifest?.profiles || [];
    if (!profiles.length) return null;
    if (chosen && profiles.some((p) => p.id === chosen)) return chosen;
    return (profiles.find((p) => p.default) || profiles[0]).id;
}

/** Applique le calque de perso locale à un manifeste (copie, ne mute rien) :
 *  ne garde que la configuration de commandes choisie par le joueur, retire les
 *  interactions désactivées, override les cooldowns. Le manifeste SIGNÉ reste intact ;
 *  c'est un réglage runtime propre au streamer, qui survit aux MAJ. */
function applyPackOverlay(
    manifest: BundleManifest,
    overlay: { disabled: string[]; cooldownMs: Record<string, number>; profile?: string },
): BundleManifest {
    const disabled = new Set(overlay.disabled);
    const active = resolveActiveProfile(manifest, overlay.profile);
    const rules = (manifest.rules || [])
        // une règle SANS `profile` vaut pour toutes les configurations (OBS, RCON, HTTP…)
        .filter((r) => !r.profile || r.profile === active)
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
    // Build Windows NON SIGNÉ : sinon electron-updater rejette la mise à jour téléchargée
    // (« not signed by the application owner ») -> l'utilisateur voit « Vérification
    // indisponible ». On saute la vérif de SIGNATURE (il n'y a pas de signature à vérifier) ;
    // l'INTÉGRITÉ du téléchargement reste garantie par le sha512 de latest.yml. À retirer
    // le jour où le build est signé (Azure Trusted Signing, cf. docs/CODE_SIGNING.md).
    if (process.platform === 'win32') {
        (autoUpdater as unknown as { verifyUpdateCodeSignature?: () => Promise<string | null> })
            .verifyUpdateCodeSignature = () => Promise.resolve(null);
    }
    autoUpdater.on('checking-for-update', () => send('onUpdate', { status: 'checking' }));
    autoUpdater.on('update-available', (i: any) => send('onUpdate', { status: 'available', version: i?.version }));
    autoUpdater.on('update-not-available', () => send('onUpdate', { status: 'none' }));
    autoUpdater.on('download-progress', (p: any) => send('onUpdate', { status: 'downloading', percent: Math.round(p?.percent || 0) }));
    autoUpdater.on('update-downloaded', (i: any) => send('onUpdate', { status: 'downloaded', version: i?.version }));
    autoUpdater.on('error', (e: any) => {
        const raw = String(e?.message || e || '');
        console.error('[autoUpdate] error:', raw); // détail technique en console seulement
        // NE JAMAIS masquer une erreur en « à jour ». Un ancien code affichait « à jour » sur
        // un 404/latest.yml absent -> l'utilisateur croyait avoir la dernière version alors que
        // le CHECK avait ÉCHOUÉ (ex. une release « la plus récente » sans latest.yml Windows,
        // le temps que son build se termine) et restait BLOQUÉ sur une vieille version. Seul
        // l'event `update-not-available` dit « à jour ». Toute erreur = message honnête + lien.
        send('onUpdate', { status: 'error', message: 'Vérification des mises à jour indisponible pour le moment. Télécharge la dernière version sur hou.la.' });
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
    // Focus-guard : ne tirer les effets manette/clavier QUE si le jeu cible est au premier
    // plan. Sinon un cadeau qui presse « A » pendant qu'on est dans Discord/VS Code fuit
    // (navigation manette Windows -> clavier tactile qui tape une touche). `gameFocused` est
    // rafraîchi par un poll (voir startFocusPoll). Permissif si AUCUN jeu n'est lié.
    isTargetFocused: () => gameFocused,
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
    // Menu applicatif MINIMAL : on garde le presse-papiers (Ctrl+C/V/X, indispensable
    // dans les champs) mais on RETIRE les accélérateurs par défaut Ctrl+W (fermer) /
    // Ctrl+R (recharger) / Ctrl+Q (quitter) / Ctrl+Shift+I. Sinon, capturer un combo
    // clavier qui tombe sur l'un d'eux ferme ou recharge l'app par accident.
    const menuTemplate: Electron.MenuItemConstructorOptions[] = [{ role: 'editMenu' }];
    if (!app.isPackaged) {
        // DevTools seulement (F12). PAS de « reload » par accélérateur : capturer un
        // combo qui tombe dessus rechargerait le renderer en pleine capture.
        menuTemplate.push({ label: 'Dev', submenu: [{ role: 'toggleDevTools', accelerator: 'F12' }] });
    }
    Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));
    win.setMenuBarVisibility(false); // frameless : pas de barre de menu visible
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
    // ── Modération des packs (ADMIN) ──
    // La garde AdminGuard côté API fait foi : ces canaux ne donnent aucun pouvoir à un
    // non-admin, le serveur répond 401/403. On renvoie un verdict lisible plutôt qu'une
    // exception brute, pour ne jamais laisser l'écran muet sur un échec.
    ipcMain.handle('moderation:queue', async () => {
        try { return { ok: true, items: await api.moderationQueue() }; }
        catch (e: any) { return { ok: false, reason: e?.message || 'File indisponible.' }; }
    });
    ipcMain.handle('moderation:approve', async (_e, versionId: string) => {
        try { await api.moderationApprove(versionId); return { ok: true }; }
        catch (e: any) { return { ok: false, reason: e?.message || 'Approbation impossible.' }; }
    });
    ipcMain.handle('moderation:reject', async (_e, versionId: string, reason: string) => {
        try { await api.moderationReject(versionId, String(reason || '').slice(0, 500)); return { ok: true }; }
        catch (e: any) { return { ok: false, reason: e?.message || 'Refus impossible.' }; }
    });
    ipcMain.handle('app:isDevBuild', () => IS_DEV_BUILD);
    // Build distribué = verrouillé prod : on n'expose ni ne change l'environnement.
    ipcMain.handle('env:get', () => (IS_DEV_BUILD ? store.getEnvironment() || 'prod' : 'prod'));
    ipcMain.handle('env:set', (_e, env: string) => {
        if (!IS_DEV_BUILD) return { ok: false, locked: true }; // ignoré hors dev
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
        const wasInstalled = store.getInstalled().some((b) => b.slug === slug);
        const list = store.getInstalled().filter((b) => b.slug !== slug);
        list.push({ slug, version: d.version, contentHash: d.contentHash });
        store.setInstalled(list);
        // Compteur d'installations du store. Uniquement à la PREMIÈRE install : une mise à
        // jour de version repasse par ici, et la compter gonflerait le chiffre sans qu'un
        // nouvel utilisateur soit arrivé. Best-effort, jamais bloquant.
        if (!wasInstalled) void api.reportInstall(slug);
        // Connecteurs requis (rôle + type) à lier : protocoles réseau du manifeste.
        const NET = ['rcon', 'obs', 'mqtt', 'ws', 'http', 'osc'];
        const req = new Map<string, { role: string; type: string }>();
        for (const r of (d.manifest?.rules || []) as any[]) {
            const t = r?.effect?.type;
            if (!NET.includes(t)) continue;
            const role = r.effect.connector || t;
            req.set(`${role}:${t}`, { role, type: t });
        }
        // Configurations de commandes proposées par le pack (clavier / manette / …). Le joueur
        // en choisit une JUSTE APRÈS l'installation : c'est elle qui décide des interactions
        // actives, et donc de ce qu'on doit encore lui demander (le jeu, seulement en manette).
        const manifest = (d.manifest || {}) as BundleManifest;
        const profiles = manifest.profiles || [];
        // La MANETTE est un connecteur LOCAL : elle n'apparaît jamais dans requiredConnectors
        // (réservé aux protocoles réseau à configurer). On signale donc à part qu'un pack la
        // pilote, pour pouvoir demander À L'INSTALLATION quel jeu il vise. Avec plusieurs
        // configurations, on répond PAR CONFIGURATION : le joueur au clavier n'a pas de jeu à
        // désigner, même si le pack propose par ailleurs une configuration manette.
        const usesGamepadIn = (profileId: string | null) =>
            (manifest.rules || []).some(
                (r: any) => r?.effect?.type === 'gamepad' && (!r.profile || r.profile === profileId),
            );
        const gamepadProfiles = profiles.filter((p) => usesGamepadIn(p.id)).map((p) => p.id);
        const usesGamepad = profiles.length
            ? gamepadProfiles.length > 0
            : (manifest.rules || []).some((r: any) => r?.effect?.type === 'gamepad');
        return {
            ok: true,
            capabilities: d.capabilities,
            hosts: d.hosts,
            requiredConnectors: [...req.values()],
            usesGamepad,
            profiles,
            gamepadProfiles,
        };
    });
    ipcMain.handle('store:installed', () => store.getInstalled());

    // Lab (créateur)
    ipcMain.handle('lab:create', (_e, dto) => api.createBundle(dto));
    ipcMain.handle('lab:update', (_e, slug: string, dto) => api.updateBundle(slug, dto));
    ipcMain.handle('lab:dictionary', (_e, kind?: string) => api.getDictionary(kind));
    ipcMain.handle('lab:mybundles', () => api.myBundles());
    ipcMain.handle('lab:detail', (_e, slug: string) => api.myBundleDetail(slug));
    ipcMain.handle('lab:stats', (_e, slug: string) => api.getBundleStats(slug));
    ipcMain.handle('lab:topbroadcasters', (_e, slug: string) => api.getTopBroadcasters(slug));
    ipcMain.handle('lab:version', (_e, slug: string, dto) => api.submitVersion(slug, dto));
    ipcMain.handle('lab:publish', (_e, slug: string) => api.publishBundle(slug));
    // Choisir la bannière SANS uploader : renvoie le chemin + un data-URL pour un
    // aperçu IMMÉDIAT (l'upload — qui peut prendre un instant — est déclenché après,
    // avec un état de chargement visible). Évite l'échec silencieux d'avant.
    ipcMain.handle('lab:pickBanner', async () => {
        const r = await dialog.showOpenDialog({
            properties: ['openFile'],
            filters: [{ name: 'Bannière (PNG/JPG/WebP)', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
        });
        if (r.canceled || !r.filePaths[0]) return null;
        const filePath = r.filePaths[0];
        try {
            const buf = fs.readFileSync(filePath);
            const low = filePath.toLowerCase();
            const mime = low.endsWith('.webp') ? 'image/webp' : low.endsWith('.png') ? 'image/png' : 'image/jpeg';
            return { filePath, dataUrl: `data:${mime};base64,${buf.toString('base64')}` };
        } catch {
            return { filePath, dataUrl: null };
        }
    });
    ipcMain.handle('lab:uploadBannerFile', (_e, slug: string, filePath: string) => api.uploadBanner(slug, filePath));
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
        const manifest = (d.manifest || {}) as BundleManifest;
        const profiles = manifest.profiles || [];
        const activeProfile = resolveActiveProfile(manifest, overlay.profile);
        const rules = ((manifest.rules || []) as any[])
            // On ne montre que les interactions de la configuration active : afficher celles
            // des autres périphériques laisserait croire qu'elles vont se déclencher.
            .filter((r) => !r.profile || r.profile === activeProfile)
            .map((r) => ({
                id: r.id,
                label: r.label || '',
                trigger: r.on?.type || 'gift',
                giftSlug: r.on?.giftSlug || r.on?.slot || '',
                effectType: r.effect?.type || '',
                defaultCooldownMs: r.effect?.cooldownMs ?? 0,
                cooldownMs: overlay.cooldownMs[r.id], // override local, ou undefined
                enabled: !disabled.has(r.id),
            }));
        return { slug, version: d.version, rules, profiles, activeProfile, instructions: d.instructions ?? null };
    });
    // Test OFF-LIVE d'une interaction d'un pack INSTALLÉ (pack tiers ou le sien) :
    // on rejoue l'effet du manifeste SIGNÉ via le pipeline sécurisé du moteur, sans
    // aucune connexion live. Sans ruleId : la 1re interaction cadeau du pack.
    ipcMain.handle('engine:testInstalled', async (_e, slug: string, ruleId?: string) => {
        try {
            const d = await api.fetchVerifiedManifest(slug); // signature vérifiée
            const rules = (d.manifest?.rules || []) as any[];
            const rule = ruleId
                ? rules.find((r) => r.id === ruleId)
                : rules.find((r) => r.on?.type === 'gift') || rules[0];
            if (!rule) return { ok: false, reason: 'aucune interaction à tester dans ce pack' };
            await ensureGamepadRemap(rule.effect); // manette : proxy actif pour que le test atteigne le jeu
            const v = withDriverCode(await engine.testFire({ id: rule.id, on: rule.on, effect: rule.effect }, slug));
            await releaseGamepadAfterTest(rule.effect); // ne rien laisser squatter l'emplacement 0
            return v;
        } catch (e: any) {
            return withDriverCode({ ok: false, reason: e?.message || 'test impossible' });
        }
    });
    ipcMain.handle('customize:save', (_e, slug: string, overlay: any) => {
        store.setPackOverlay(slug, overlay || {});
        return { ok: true };
    });
    // Choix de la CONFIGURATION DE COMMANDES (clavier / manette / …), sans toucher au reste
    // du calque. Le renderer ne peut envoyer qu'un id ; on le confronte au manifeste SIGNÉ et
    // on refuse tout id inconnu, plutôt que d'enregistrer un choix qui rendrait le pack inerte.
    ipcMain.handle('customize:setProfile', async (_e, slug: string, profile: string) => {
        try {
            const d = await api.fetchVerifiedManifest(slug);
            const profiles = ((d.manifest || {}) as BundleManifest).profiles || [];
            if (!profiles.some((p) => p.id === profile)) return { ok: false, reason: 'configuration inconnue' };
            const overlay = store.getPackOverlay(slug);
            store.setPackOverlay(slug, { ...overlay, profile });
            return { ok: true, profile };
        } catch (e: any) {
            return { ok: false, reason: e?.message || 'configuration non enregistrée' };
        }
    });

    // Ouvrir une URL EXTERNE (profil créateur) — bornée à https://…hou.la (anti-abus).
    ipcMain.handle('shell:openExternal', (_e, url: string) => {
        try {
            const u = new URL(String(url));
            if (u.protocol === 'https:' && /(^|\.)hou\.la$/i.test(u.hostname)) {
                void shell.openExternal(u.toString());
                return { ok: true };
            }
        } catch { /* url invalide */ }
        return { ok: false };
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
        // Le CALQUE local est appliqué D'ABORD : il fixe la configuration de commandes choisie
        // par le joueur (clavier / manette / …). Tout ce qui suit doit raisonner sur ce qui va
        // RÉELLEMENT tourner, pas sur l'ensemble des règles du pack — sinon un joueur au clavier
        // se verrait réclamer le jeu à cause des interactions manette qu'il n'utilisera jamais.
        const overlaid = applyPackOverlay(d.manifest as BundleManifest, store.getPackOverlay(slug));
        // Pack MANETTE : le jeu piloté est une propriété du PACK (demandé à l'installation).
        // Si l'info manque (pack installé avant cette version, ou jeu déplacé/désinstallé), on
        // le redemande AVANT de rien démarrer — plutôt que de lancer un pack qui n'agirait pas
        // en jeu, ce qui donnerait « ça ne marche pas » sans explication.
        if (overlaid.rules.some((r) => (r.effect as { type?: string })?.type === 'gamepad')) {
            const g = store.getGameForPack(slug);
            if (!g?.exe || !fs.existsSync(g.exe)) return { ok: false, needGame: true, slug };
        }
        store.setActiveBundleSlug(slug); // seulement APRÈS un fetch réussi (pas de pack fantôme)
        // Le moteur tourne sur la DERNIÈRE version : on synchronise l'enregistrement
        // local (numéro + hash) pour que le menu Capture reflète ce qui tourne vraiment.
        const installed = store.getInstalled();
        const entry = installed.find((b) => b.slug === slug);
        if (entry && (entry.version !== d.version || entry.contentHash !== d.contentHash)) {
            entry.version = d.version;
            entry.contentHash = d.contentHash;
            store.setInstalled(installed);
        }
        // Applique le CALQUE local (perso streamer) : désactive des interactions,
        // override des cooldowns. N'altère jamais le manifeste signé sur le disque.
        activeManifest = overlaid;
        router.setManifest(activeManifest);
        // Pack qui utilise la MANETTE -> mode « une seule manette » : le sidecar recopie EN
        // CONTINU la manette PHYSIQUE du joueur dans la virtuelle et y superpose les cadeaux.
        // Le joueur règle Joueur 1 = manette virtuelle UNE fois, conduit normalement, et les
        // cadeaux s'ajoutent (résout « le jeu lit la physique, pas la virtuelle »). Sans pilote
        // installé, l'appel échoue -> le 1er test manette guidera l'installation.
        const usesGamepad = activeManifest.rules.some((r) => (r.effect as { type?: string })?.type === 'gamepad');
        if (usesGamepad) {
            // Jeu de CE pack (garanti présent : vérifié en tête du handler).
            const game = store.getGameForPack(slug)!;
            // Re-pose la DLL si elle a disparu (une mise à jour du jeu peut nettoyer son dossier).
            if (!fs.existsSync(path.join(game.dir, 'xinput1_4.dll'))) placeProxyDlls(game.dir);
            store.setFocusTarget({ exe: game.exe, dir: game.dir }); // focus-guard sur CE jeu
            try {
                // targetExe : la DLL ne remappera QUE dans ce jeu (les autres restent intacts).
                const pt = await sidecar().call('vigem-passthrough', { enable: true, targetExe: game.exe }) as { physicalIndex?: number | null };
                // Retour DISCRIMINANT (texte, pas couleur) : le joueur doit SAVOIR si sa manette
                // physique est recopiée, ou si seuls les cadeaux piloteront la virtuelle (cas où
                // il a démarré sans manette branchée -> le mirroring ne se fera pas).
                const hasPhys = pt && typeof pt.physicalIndex === 'number';
                send('onLog', {
                    ts: Date.now(), ruleId: 'MANETTE', trigger: 'gamepad', sender: '', executor: 'gamepad',
                    allowed: !!hasPhys,
                    reason: hasPhys
                        ? `Manette physique détectée (emplacement ${pt.physicalIndex}) : elle est recopiée dans la manette virtuelle, les cadeaux s'y ajoutent.`
                        : "Aucune manette physique détectée : seuls les cadeaux piloteront la manette virtuelle. Branche ta manette AVANT de démarrer, puis relance le pack.",
                });
            } catch (e) {
                console.error('[passthrough] start:', (e as Error)?.message || e);
                send('onLog', {
                    ts: Date.now(), ruleId: 'MANETTE', trigger: 'gamepad', sender: '', executor: 'gamepad',
                    allowed: false,
                    reason: "Pilote manette indisponible : installe-le depuis Connecteurs, puis relance le pack.",
                });
            }
        }
        const reactSlugs = activeManifest.rules.filter((r) => r.on.type === 'gift').map((r) => r.on.giftSlug ?? r.on.slot!);
        const events = ['gift', 'follow', 'comment', 'viewer', 'hearts'];
        const key = await api.ensureEventKey(events);
        // Pose le pack VISUEL du pack actif sur la clé AVANT la connexion : à l'auth
        // socket, la passerelle lit ce bundleId et l'active côté viewer (le viewer voit
        // CE pack). setKeyBundle invalide le cache de validation -> lu frais au connect.
        await api.setActivePackBundle(d.visualBundleId ?? null).catch(() => {});
        // workspaceId : pour le poll de fallback du compte de viewers (endpoint public).
        conn.connect(key, store.getWorkspaceId() || undefined);
        engineRunning = true;
        startFocusPoll(); // focus-guard : n'autoriser les effets manette/clavier que si le jeu est actif
        send('onState', { connected: false, events, reactSlugs });
        return { ok: true };
    });
    ipcMain.handle('engine:stop', async () => {
        conn.disconnect();
        router.setManifest(null);
        engineRunning = false;
        stopFocusPoll();
        // Coupe le mode « une seule manette » (sinon le thread de mirroring tourne encore et
        // garde la manette virtuelle active après l'arrêt du pack).
        if (sidecarInstance) { try { await sidecar().call('vigem-passthrough', { enable: false }); } catch { /* noop */ } }
        gamepadSessionOn = false; // la virtuelle a disparu : le prochain test devra re-patienter
        // Retire le pack visuel côté viewer : plus de pack actif -> plus rien à montrer.
        await api.setActivePackBundle(null).catch(() => {});
        return { ok: true };
    });
    ipcMain.handle('engine:panic', async () => {
        conn.disconnect();
        await engine.panic();
        stopFocusPoll();
        if (sidecarInstance) { try { await sidecar().call('vigem-passthrough', { enable: false }); } catch { /* noop */ } }
        gamepadSessionOn = false;
        sidecarInstance?.kill();
        engineRunning = false;
        await api.setActivePackBundle(null).catch(() => {});
        send('onState', { connected: false });
        return { ok: true };
    });
    // Test manuel d'UNE règle depuis le Lab (déclaratif : trigger + effet, joué via
    // le pipeline sécurisé du moteur). Renvoie un verdict {ok, reason} pour l'UI.
    ipcMain.handle('engine:testRule', async (_e, rule: any, bundleSlug?: string) => {
        if (!rule || typeof rule !== 'object' || !rule.effect) return { ok: false, reason: 'règle invalide' };
        await ensureGamepadRemap(rule.effect); // manette : proxy actif pour que le test atteigne le jeu
        const v = withDriverCode(await engine.testFire({ id: rule.id || 'test', on: rule.on || { type: 'gift' }, effect: rule.effect }, bundleSlug));
        await releaseGamepadAfterTest(rule.effect); // ne rien laisser squatter l'emplacement 0
        return v;
    });
    ipcMain.handle('engine:test', (_e, slug?: string) => {
        // Sans slug : simule la 1re interaction cadeau du pack actif (générique ou slot).
        const firstGift = activeManifest?.rules.find((r) => r.on.type === 'gift');
        const s = slug || firstGift?.on.giftSlug || firstGift?.on.slot || 'ix_slot_01';
        conn.simulateGift(s);
        return { ok: true, slug: s };
    });
    ipcMain.handle('engine:status', () => ({ running: engineRunning, connected: conn.connected }));

    // Installe le pilote ViGEmBus (manette virtuelle) depuis son MSI empaqueté, AVEC
    // élévation UAC. Appelé quand un test manette signale le pilote manquant (code
    // 'vigembus'), ou proactivement depuis les Réglages. Windows uniquement.
    ipcMain.handle('driver:installGamepad', async () => {
        if (process.platform !== 'win32') return { ok: false, reason: 'Le pilote manette n\'est nécessaire que sur Windows.' };
        const msi = driverMsiPath();
        if (!fs.existsSync(msi)) return { ok: false, reason: 'Installeur du pilote absent de cette version. Mets l\'app à jour puis réessaie.' };
        return await new Promise<{ ok: boolean; reason?: string }>((resolve) => {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { spawn } = require('child_process') as typeof import('child_process');
            // Élévation via UAC (Start-Process -Verb RunAs). Deux pièges DÉJÀ vérifiés :
            //  1) Le chemin du MSI est mis entre GUILLEMETS DOUBLES dans l'élément d'ArgumentList.
            //     Start-Process réassemble les éléments séparés par des espaces SANS les re-quoter :
            //     sans ces guillemets, « ...\Hou.la Connect\... » est coupé à l'espace (msiexec voit
            //     « /i C:\Program ») et l'install échoue sur 100 % des machines.
            //  2) -PassThru + exit $p.ExitCode : sinon Start-Process -Wait JETTE le code de msiexec,
            //     PowerShell sort 0 et tout échec passerait pour un succès (« installé ✓ » mensonger).
            // Script passé en -EncodedCommand (base64 UTF-16LE) : élimine toute couche de quoting
            // entre Node et PowerShell (les guillemets ne sont pas remaniés).
            const psScript =
                `try { $p = Start-Process msiexec -ArgumentList '/i','"${msi}"','/qb','/norestart' -Verb RunAs -Wait -PassThru; exit $p.ExitCode } catch { exit 1 }`;
            const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
            const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true });
            let err = '';
            p.stderr?.on('data', (d: Buffer) => { err += String(d); });
            p.on('error', (e: Error) => resolve({ ok: false, reason: e?.message || 'lancement de l\'installeur impossible' }));
            p.on('exit', (code: number | null) => {
                // Repart d'un sidecar NEUF : la prochaine tentative recharge vgamepad avec le
                // pilote fraîchement installé (sinon l'ancienne instance garde son échec).
                sidecarInstance?.kill();
                sidecarInstance = null;
                // 0 = OK ; 3010 = OK (redémarrage conseillé) ; 1638 = déjà installé.
                if (code === 0 || code === 3010 || code === 1638) resolve({ ok: true });
                else resolve({ ok: false, reason: err.trim() || `Installation non terminée (code ${code ?? '?'}). Autorise la fenêtre Windows (UAC) puis réessaie.` });
            });
        });
    });
    // Le pilote manette (ViGEmBus) est-il déjà installé sur ce PC ? Sert à la vue
    // Connecteurs pour montrer « Pilote installé » au lieu du bouton d'installation. On
    // interroge le SERVICE Windows du pilote : `sc query ViGEmBus` sort 0 s'il existe
    // (donc installé), 1060 sinon. Léger, pas besoin du sidecar. Windows uniquement.
    ipcMain.handle('driver:isGamepadInstalled', async () => {
        if (process.platform !== 'win32') return { installed: false };
        return await new Promise<{ installed: boolean }>((resolve) => {
            try {
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                const { spawn } = require('child_process') as typeof import('child_process');
                const p = spawn('sc.exe', ['query', 'ViGEmBus'], { windowsHide: true });
                p.on('error', () => resolve({ installed: false }));
                p.on('exit', (code: number | null) => resolve({ installed: code === 0 }));
            } catch {
                resolve({ installed: false });
            }
        });
    });
    // ── Jeu piloté par un PACK (proxy XInput) ──
    // Pour qu'un cadeau agisse en jeu, le jeu doit LIRE notre manette virtuelle comme Joueur 1 :
    // on pose une DLL proxy dans le dossier de son exe (resources/xinput-proxy). Le jeu est une
    // propriété du PACK (la manette, elle, sert à tous les jeux) : demandé UNE fois à
    // l'installation d'un pack manette, automatique ensuite. La DLL posée reste INERTE tant
    // qu'aucun pack ne tourne (config -1) et ne remappe que le jeu visé -> aucun verrou, aucun
    // autre jeu impacté.
    ipcMain.handle('game:linkPack', async (_e, slug: string) => {
        const r = await dialog.showOpenDialog({
            title: 'Choisis l’exécutable du jeu que ce pack pilote (le .exe que tu lances)',
            properties: ['openFile'],
            filters: [{ name: 'Jeu', extensions: ['exe'] }],
        });
        if (r.canceled || !r.filePaths[0]) return { ok: false };
        const exe = r.filePaths[0];
        const dir = path.dirname(exe);
        const placed = placeProxyDlls(dir);
        if (!placed.ok) return placed;
        if (slug) store.setGameForPack(slug, { exe, dir });
        return { ok: true, exe, dir };
    });
    // Jeux détectés en cours d'exécution (pour proposer en 1 clic, sans explorateur).
    ipcMain.handle('game:detect', async (_e, exeName?: string) => detectRunningGames(exeName));
    // Lier un pack à un jeu DÉJÀ identifié (issu de la détection) : aucun explorateur.
    ipcMain.handle('game:linkPackTo', async (_e, slug: string, exe: string) => {
        if (!slug || !exe || !fs.existsSync(exe)) return { ok: false, reason: 'Jeu introuvable.' };
        const dir = path.dirname(exe);
        const placed = placeProxyDlls(dir);
        if (!placed.ok) return placed;
        store.setGameForPack(slug, { exe, dir });
        return { ok: true, exe, dir };
    });
    ipcMain.handle('game:packStatus', (_e, slug: string) => {
        const g = slug ? store.getGameForPack(slug) : null;
        const placed = !!(g?.dir && fs.existsSync(path.join(g.dir, 'xinput1_4.dll')));
        return { exe: g?.exe || null, dir: g?.dir || null, placed };
    });
    ipcMain.handle('game:listLinked', () => {
        const all = store.getLinkedGames();
        return Object.entries(all).map(([slug, g]) => ({
            slug, exe: g.exe, dir: g.dir,
            placed: fs.existsSync(path.join(g.dir, 'xinput1_4.dll')),
        }));
    });
    ipcMain.handle('game:unlinkPack', async (_e, slug: string) => {
        const g = slug ? store.getGameForPack(slug) : null;
        if (g?.dir) removeProxyDlls(g.dir);
        if (slug) store.removeGameForPack(slug);
        return { ok: true };
    });
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
