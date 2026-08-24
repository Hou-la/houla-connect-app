'use strict';
const api = window.houlaConnect;
const $ = (id) => document.getElementById(id);
const TRANSPARENT = 'data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=';
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
// Message d'erreur lisible : garde nos messages courts et propres (erreurs API),
// remplace les dumps techniques (stack, HttpError, réseau) par un repli user-friendly.
// Le détail complet part TOUJOURS en console pour le debug.
function friendlyError(e, fallback) {
    if (e) console.error(e);
    let m = (e && e.message != null ? String(e.message) : String(e || '')).split('\n')[0].trim();
    // Electron enveloppe les rejets IPC : « Error invoking remote method 'x': Error: <vrai msg> ».
    // On retire l'enveloppe (et un « Error: » résiduel) pour ne garder QUE le message métier.
    m = m.replace(/^Error invoking remote method '[^']*':\s*/i, '').replace(/^(Uncaught\s+)?Error:\s*/i, '').trim();
    if (!m || m.length > 240 || /HttpError|node_modules|\bat\s|Failed to fetch|NetworkError|ENOTFOUND|ECONN|getaddrinfo|<!DOCTYPE|\bstack\b/i.test(m)) {
        return fallback || 'Une erreur est survenue. Réessaie.';
    }
    return m;
}
// Seule l'injection LOCALE invasive exige un consentement explicite. Les protocoles
// réseau (RCON/OBS/MQTT/WS/HTTP/OSC) sont gardés par la présence d'un CONNECTEUR.
const CAPS = [
    ['allowKeyboard', 'Clavier (nut.js)'],
    ['allowGamepad', 'Manette virtuelle (ViGEm)'],
    ['allowPythonDriver', 'Pilotage bas niveau (Interception/ViGEm)'],
];
// Protocoles qui passent par un CONNECTEUR (endpoint + identifiants).
const CONNECTOR_TYPES = {
    rcon: { label: 'RCON (jeu)', fields: [['host', 'Adresse du serveur', 'text'], ['port', 'Port (défaut 25575)', 'number'], ['password', 'Mot de passe RCON', 'password'], ['player', 'Ton pseudo en jeu (remplace {player})', 'text']] },
    obs: { label: 'OBS', fields: [['url', 'URL (ws://127.0.0.1:4455)', 'text'], ['password', 'Mot de passe (optionnel)', 'password']] },
    mqtt: { label: 'MQTT (domotique)', fields: [['url', 'URL (mqtt://127.0.0.1:1883)', 'text'], ['username', 'Utilisateur (optionnel)', 'text'], ['password', 'Mot de passe (optionnel)', 'password']] },
    ws: { label: 'WebSocket', fields: [['url', 'URL (wss://…)', 'text']] },
    http: { label: 'HTTP / API', fields: [['baseUrl', 'URL de base (https://…)', 'text']] },
    osc: { label: 'OSC (VRChat, VJ)', fields: [['host', 'Adresse (défaut 127.0.0.1)', 'text'], ['port', 'Port (défaut 9000)', 'number']] },
};
const CONNECTOR_PROTOCOLS = Object.keys(CONNECTOR_TYPES);
function slugifyRole(s) {
    return String(s || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'connecteur';
}
let myConnectors = []; // [{id,name,type,config,hasSecret}]
async function loadConnectors() { try { myConnectors = (await api.connectors.list()) || []; } catch { myConnectors = []; } }

// ── Window controls ──
$('win-min').onclick = () => api.win.minimize();
$('win-max').onclick = () => api.win.maximize();
$('win-close').onclick = () => api.win.close();

// ── Auth ──
async function showLoginEnvHint() {
    try {
        const env = (await api.env.get()) || 'prod';
        if (env !== 'prod') {
            $('auth-env-name').textContent = env;
            $('auth-env').classList.remove('hidden');
        } else $('auth-env').classList.add('hidden');
    } catch { /* noop */ }
}
async function refreshAuth() {
    const { authenticated } = await api.authStatus();
    if (authenticated) return showApp();
    $('view-auth').classList.remove('hidden');
    $('app-main').classList.add('hidden');
    showLoginEnvHint();
}
$('btn-login').onclick = () => { $('auth-error').classList.add('hidden'); api.login(); };
$('btn-logout').onclick = async () => { await api.logout(); location.reload(); };
$('auth-env-reset').onclick = async (e) => { e.preventDefault(); await api.env.set('prod'); location.reload(); };
api.onAuth(async (a) => {
    if (a.authenticated) { $('auth-error').classList.add('hidden'); await showApp(); }
    else {
        // Échec silencieux évité : message clair + l'indicateur d'environnement (souvent la cause).
        if (a.error) console.error('[auth] callback:', a.error);
        $('auth-error').textContent = 'Connexion échouée. Vérifie l’environnement ci-dessous, puis réessaie.';
        $('auth-error').classList.remove('hidden');
        showLoginEnvHint();
    }
});

// Switch d'identité DANS l'app (multi-workspace) : on utilise le workspace choisi
// à l'auth par défaut, et on peut en changer. Plus de double sélection.
function setCurrentWs(ws) {
    if (!ws) return;
    $('ws-current-av').src = ws.avatarUrl || TRANSPARENT;
    $('ws-current-name').textContent = ws.name || ws.slug || ws.id;
}
async function loadWorkspaces() {
    const [list, current] = await Promise.all([api.listWorkspaces(), api.currentWorkspace()]);
    const menu = $('ws-menu');
    menu.innerHTML = '';
    let currentWs = (list || []).find((w) => w.id === (current && current.id)) || (list && list[0]);
    if (currentWs && (!current || current.id !== currentWs.id)) {
        await api.selectWorkspace({ id: currentWs.id, name: currentWs.name || '' });
    }
    setCurrentWs(currentWs);
    (list || []).forEach((ws) => {
        const item = document.createElement('div');
        item.className = 'ws-item';
        item.innerHTML = `<img class="av" src="${esc(ws.avatarUrl || TRANSPARENT)}" alt=""/><span>${esc(ws.name || ws.slug || ws.id)}</span>`;
        item.onclick = async () => {
            menu.classList.add('hidden');
            await api.selectWorkspace({ id: ws.id, name: ws.name || '' });
            setCurrentWs(ws);
            api.engine.stop();
            engineState = 'idle';
            loggedConnected = false;
            setBadge('off', 'Déconnecté');
            await loadInstalled();
        };
        menu.appendChild(item);
    });
}
$('ws-current').onclick = () => $('ws-menu').classList.toggle('hidden');
document.addEventListener('click', (e) => {
    if (!e.target.closest('.ws-switch')) $('ws-menu').classList.add('hidden');
});

async function showApp() {
    $('view-auth').classList.add('hidden');
    $('app-main').classList.remove('hidden');
    await loadWorkspaces();
    await loadInstalled();
    switchView('capture');
}

// ── Nav ──
function switchView(name) {
    document.querySelectorAll('.nav').forEach((n) => n.classList.toggle('active', n.dataset.view === name));
    ['capture', 'store', 'lab', 'mine', 'connecteurs', 'settings'].forEach((v) =>
        $('view-' + v).classList.toggle('hidden', v !== name),
    );
    if (name === 'store') loadStore();
    if (name === 'mine') loadMyBundles();
    if (name === 'lab') loadLab();
    if (name === 'connecteurs') loadConnectorsView();
    if (name === 'settings') loadSettings();
}
// Réglages : l'encart Environnement n'apparaît que pour un compte ADMIN.
async function loadSettings() {
    try {
        if (await api.isAdmin()) {
            $('env-card').classList.remove('hidden');
            $('env-select').value = (await api.env.get()) || 'prod';
        }
    } catch { /* noop */ }
}
document.querySelectorAll('.nav').forEach((n) => (n.onclick = () => switchView(n.dataset.view)));

// ── Capture ──
// Machine à états du bouton toggle : un SEUL bouton, l'état est lisible par le TEXTE
// + la forme (plein « Démarrer » / spinner « Connexion… » / contour « Déconnecter »),
// pas seulement la couleur (propriétaire daltonien). Le chip haut-droite est doublé
// par une ligne dans le journal.
let engineState = 'idle'; // 'idle' | 'connecting' | 'running'
let hasPack = false;
let connectingSince = 0;
let connectWatchdog = null;
let loggedConnected = false;

function setBadge(kind, text) {
    const badge = $('conn-badge');
    badge.textContent = text;
    badge.className = 'badge badge--' + kind; // 'on' | 'off' | 'pending'
}
function setEngineButton() {
    const b = $('btn-start');
    b.classList.remove('btn--primary', 'btn--stop', 'is-loading');
    if (engineState === 'connecting') {
        b.classList.add('btn--primary', 'is-loading');
        b.disabled = true;
        b.innerHTML = '<span class="spinner"></span>Connexion…';
    } else if (engineState === 'running') {
        b.classList.add('btn--stop');
        b.disabled = false;
        b.textContent = 'Déconnecter';
    } else {
        b.classList.add('btn--primary');
        b.disabled = !hasPack;
        b.textContent = 'Démarrer';
    }
    $('btn-test').disabled = engineState !== 'running'; // le test-fire exige une connexion active
}

async function loadInstalled(toMine) {
    const installed = (await api.store.installed()) || [];
    const sel = $('active-bundle');
    const noPack = $('no-pack');
    hasPack = installed.length > 0;
    if (!hasPack) {
        sel.classList.add('hidden');
        noPack.classList.remove('hidden');
    } else {
        sel.classList.remove('hidden');
        noPack.classList.add('hidden');
        sel.innerHTML = '';
        installed.forEach((b) => {
            const o = document.createElement('option');
            o.value = b.slug;
            o.textContent = `${b.slug} (v${b.version})`;
            sel.appendChild(o);
        });
    }
    // Resynchronise l'état réel du moteur (si on revient sur la vue en plein live).
    try {
        const st = await api.engine.status();
        if (st && st.connected && engineState === 'idle') { engineState = 'running'; setBadge('on', 'Connecté'); }
    } catch { /* noop */ }
    setEngineButton();
}

$('btn-start').onclick = async () => {
    // Toggle : connecté ou en cours de connexion -> on coupe.
    if (engineState === 'running' || engineState === 'connecting') {
        clearTimeout(connectWatchdog);
        try { await api.engine.stop(); } catch { /* noop */ }
        engineState = 'idle';
        loggedConnected = false;
        setBadge('off', 'Déconnecté');
        setEngineButton();
        logLine({ allowed: false, ruleId: 'live', reason: 'Déconnecté' });
        return;
    }
    const slug = $('active-bundle').value;
    if (!slug) return;
    engineState = 'connecting';
    connectingSince = Date.now();
    loggedConnected = false;
    setBadge('pending', 'Connexion…');
    setEngineButton();
    logLine({ allowed: true, ruleId: 'live', reason: 'Connexion au live…' });
    // Garde-fou : sans confirmation de connexion sous 12 s, retour à l'état initial.
    clearTimeout(connectWatchdog);
    connectWatchdog = setTimeout(() => {
        if (engineState === 'connecting') {
            engineState = 'idle';
            api.engine.stop().catch(() => {});
            setBadge('off', 'Déconnecté');
            setEngineButton();
            logLine({ allowed: false, ruleId: 'live', reason: 'Connexion impossible (délai dépassé). Réessaie.' });
        }
    }, 12000);
    try {
        await api.engine.start(slug);
    } catch (e) {
        clearTimeout(connectWatchdog);
        engineState = 'idle';
        setBadge('off', 'Déconnecté');
        setEngineButton();
        logLine({ allowed: false, reason: friendlyError(e, "Le pack n'a pas pu démarrer."), ruleId: 'start' });
    }
};
$('btn-test').onclick = () => api.engine.test();
$('btn-panic').onclick = () => {
    clearTimeout(connectWatchdog);
    api.engine.panic();
    engineState = 'idle';
    loggedConnected = false;
    setBadge('off', 'Déconnecté');
    setEngineButton();
};

api.onState((s) => {
    if (s.connected) {
        clearTimeout(connectWatchdog);
        setBadge('on', 'Connecté');
        if (engineState === 'connecting') {
            // Au moins ~1,2 s d'animation « Connexion… » pour que le clic soit ressenti.
            const wait = Math.max(0, 1200 - (Date.now() - connectingSince));
            setTimeout(() => {
                // Si l'utilisateur a coupé entre-temps (état revenu à idle), on n'affiche pas « running ».
                if (engineState !== 'connecting') return;
                engineState = 'running';
                setEngineButton();
                if (!loggedConnected) { loggedConnected = true; logLine({ allowed: true, ruleId: 'live', reason: 'Connecté au live' }); }
            }, wait);
        }
    } else if (s.error) {
        clearTimeout(connectWatchdog);
        engineState = 'idle';
        loggedConnected = false;
        setBadge('off', 'Déconnecté');
        setEngineButton();
        logLine({ allowed: false, ruleId: 'live', reason: friendlyError({ message: s.error }, 'Connexion perdue.') });
    } else if (engineState === 'connecting') {
        // onState{connected:false} émis juste après engine:start : on l'ignore, on attend la vraie connexion.
    } else {
        setBadge('off', 'Déconnecté');
        if (engineState === 'running') { engineState = 'idle'; setEngineButton(); }
    }
});
api.onLog((l) => logLine(l));
function logLine(l) {
    const el = document.createElement('div');
    const ok = !!l.allowed;
    const cls = ok ? 'ok' : 'no';
    const sign = ok ? '✓' : '✕';
    let body;
    if (l.ruleId === 'live' || l.ruleId === 'start') {
        // Lignes système / connexion : afficher le motif tel quel.
        body = esc(l.reason || (ok ? 'OK' : 'Échec'));
    } else {
        // Ligne d'interaction : QUI a envoyé QUOI (× combien) → QUEL exécuteur → résultat.
        const who = esc(l.sender || 'Quelqu\'un');
        const qty = l.quantity && l.quantity > 1 ? `${l.quantity}× ` : '';
        const what = l.giftName
            ? `${qty}${esc(l.giftName)}`
            : (l.trigger === 'gift' ? `${qty}cadeau` : esc(l.trigger || 'événement'));
        const exec = esc((l.executor || '').toUpperCase());
        let outcome;
        if (ok) {
            const reps = l.fired && l.fired > 1 ? ` ×${l.fired}` : '';
            outcome = `${exec}${reps} exécuté${l.reason ? ' — ' + esc(l.reason) : ''}`;
        } else {
            outcome = `ignoré — ${esc(l.reason || 'refusé')}`;
        }
        body = `<b>${who}</b> → ${what} → ${outcome}`;
    }
    const time = l.ts ? new Date(l.ts).toLocaleTimeString() : '';
    el.innerHTML = `<span class="log-t">${esc(time)}</span> <span class="${cls}">${sign}</span> ${body}`;
    const log = $('log');
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
}

// ── Store ──
function fmtDate(d) { try { return d ? new Date(d).toLocaleDateString() : ''; } catch { return ''; } }
function publisherHtml(pub, installs) {
    pub = pub || {};
    // Nom du créateur CLIQUABLE -> ouvre son profil public hou.la/@slug (abonnement, DM).
    const name = esc(pub.name || 'Hou.la');
    const creator = pub.slug
        ? `<a href="#" class="creator-link" data-slug="${esc(pub.slug)}" title="Voir le profil de ${name}">${name}</a>`
        : `<span>${name}</span>`;
    return `<img class="av" src="${esc(pub.avatarUrl || TRANSPARENT)}" alt=""/>
        ${creator}
        ${pub.isVerified ? '<span class="verified" title="Vérifié">✓</span>' : ''}
        <span>· ${installs || 0} installs</span>`;
}
// Clic sur un nom de créateur (partout) -> profil public dans le navigateur.
document.addEventListener('click', (e) => {
    const link = e.target.closest ? e.target.closest('.creator-link') : null;
    if (!link) return;
    e.preventDefault();
    const slug = link.dataset.slug;
    if (slug) api.openExternal(`https://hou.la/@${encodeURIComponent(slug)}`);
});
async function installBundle(slug, btn) {
    if (btn) btn.textContent = '…';
    try {
        const res = await api.store.install(slug);
        await bindRequiredConnectors(slug, (res && res.requiredConnectors) || []);
        if (btn) btn.textContent = 'Installé ✓';
        await loadInstalled();
    } catch { if (btn) btn.textContent = 'Échec'; }
}
/** À l'install : lie chaque connecteur requis (auto sur le 1er du type, sinon création). */
async function bindRequiredConnectors(slug, required) {
    if (!required.length) return;
    await loadConnectors();
    const existing = (await api.bindings.get(slug)) || {};
    for (const rc of required) {
        if (existing[rc.role]) continue; // déjà lié
        const ofType = myConnectors.filter((c) => c.type === rc.type);
        if (ofType.length) {
            await api.bindings.set(slug, rc.role, ofType[0].id);
        } else {
            await new Promise((resolve) => openConnectorModal(null, async (saved) => {
                if (saved) await api.bindings.set(slug, rc.role, saved.id);
                resolve();
            }, rc.type));
        }
    }
}
async function loadStore() {
    // On croise la liste du store avec les packs DÉJÀ installés (état local persistant),
    // pour que le bouton reflète la réalité au retour sur la vue (bug : il repassait à
    // « Installer » alors que le pack était installé).
    const [list, installed] = await Promise.all([api.store.list(), api.store.installed()]);
    const items = list || [];
    const installedBy = new Map((installed || []).map((b) => [b.slug, b]));
    const el = $('store-list');
    el.innerHTML = '';
    if (!items.length) { el.innerHTML = '<p class="muted">Le store est vide pour l\'instant.</p>'; return; }
    items.forEach((b) => {
        const inst = installedBy.get(b.slug);
        const card = document.createElement('div');
        card.className = 'bundle-card';
        const banner = b.bannerUrl ? ` style="background-image:url('${esc(b.bannerUrl)}')"` : '';
        const installBtn = inst
            ? `<button class="btn btn--ghost install" disabled>Installé ✓${inst.version ? ' · v' + esc(inst.version) : ''}</button>`
            : `<button class="btn btn--primary install">Installer</button>`;
        const customizeBtn = inst ? `<button class="btn btn--ghost customize">Personnaliser</button>` : '';
        card.innerHTML = `
            <div class="bundle-card__banner"${banner}></div>
            <div class="bundle-card__body">
                <h3>${esc(b.title || b.slug)}</h3>
                <div class="publisher">${publisherHtml(b.publisher, b.installCount)}</div>
                ${b.version ? `<div class="muted small">v${esc(b.version)}${b.versionDate ? ' · ' + esc(fmtDate(b.versionDate)) : ''}</div>` : ''}
                <div class="row gap wrap">
                    ${installBtn}
                    ${customizeBtn}
                    <button class="btn btn--ghost more">Voir plus</button>
                </div>
            </div>`;
        if (!inst) card.querySelector('.install').onclick = (e) => installBundle(b.slug, e.target);
        if (inst) { const cb = card.querySelector('.customize'); if (cb) cb.onclick = () => openCustomize(b.slug, b.title || b.slug); }
        card.querySelector('.more').onclick = () => openModal(b, !!inst);
        el.appendChild(card);
    });
}

// ── Modal détail ──
function openModal(b, isInstalled) {
    $('modal-banner').style.backgroundImage = b.bannerUrl ? `url('${b.bannerUrl}')` : '';
    $('modal-title').textContent = b.title || b.slug;
    $('modal-publisher').innerHTML = publisherHtml(b.publisher, b.installCount);
    $('modal-desc').textContent = b.description || 'Aucune description.';
    $('modal-version').textContent = b.version ? `Version ${b.version}${b.versionDate ? ' · ' + fmtDate(b.versionDate) : ''}` : '';
    $('modal-changelog').textContent = b.changelog || '';
    $('modal-caps').innerHTML = '';
    api.store
        .preview(b.slug)
        .then((p) => {
            const caps = (p && p.capabilities) || [];
            $('modal-caps').innerHTML = caps.map((c) => `<span class="chip">${esc(c)}</span>`).join('');
        })
        .catch(() => {});
    const btn = $('modal-install');
    if (isInstalled) {
        btn.textContent = 'Installé ✓';
        btn.disabled = true;
        btn.onclick = null;
    } else {
        btn.textContent = 'Installer';
        btn.disabled = false;
        btn.onclick = () => installBundle(b.slug, btn);
    }
    $('modal').classList.remove('hidden');
}
$('modal-close').onclick = () => $('modal').classList.add('hidden');
$('modal').onclick = (e) => { if (e.target.id === 'modal') $('modal').classList.add('hidden'); };

// ── Personnalisation LOCALE d'un pack installé (calque : activer/désactiver + cooldown) ──
async function openCustomize(slug, title) {
    $('cx-title').textContent = title || slug;
    $('cx-msg').textContent = '';
    $('cx-modal').dataset.slug = slug;
    const box = $('cx-rules');
    box.innerHTML = '<p class="muted">Chargement…</p>';
    $('cx-modal').classList.remove('hidden');
    let data;
    try { data = await api.customize.get(slug); }
    catch (e) { box.innerHTML = `<p class="no">${esc(friendlyError(e, 'Pack indisponible.'))}</p>`; return; }
    const rules = (data && data.rules) || [];
    if (!rules.length) { box.innerHTML = '<p class="muted">Ce pack n\'a pas d\'interaction personnalisable.</p>'; return; }
    box.innerHTML = '';
    rules.forEach((r) => {
        const row = document.createElement('div');
        row.className = 'cx-rule';
        row.dataset.id = r.id;
        const what = r.giftSlug ? esc(r.giftSlug) : esc(r.trigger || 'événement');
        const name = r.label ? esc(r.label) : what;
        row.innerHTML =
            `<label class="switch" title="Activer / désactiver cette interaction"><input type="checkbox" class="cx-en"${r.enabled ? ' checked' : ''}/><span class="switch__track"><span class="switch__thumb"></span></span></label>`
            + `<div class="cx-rule__info"><b>${name}</b> <span class="muted">${esc(r.effectType || '')}${r.giftSlug ? ' · ' + what : ''}</span></div>`
            + `<label class="cx-cd muted" title="Temps minimum entre deux déclenchements">cooldown ms <input type="number" min="0" class="cx-cd-in" placeholder="${Number(r.defaultCooldownMs) || 0}" value="${r.cooldownMs != null ? r.cooldownMs : ''}"/></label>`;
        box.appendChild(row);
    });
}
$('cx-close').onclick = () => $('cx-modal').classList.add('hidden');
$('cx-modal').onclick = (e) => { if (e.target.id === 'cx-modal') $('cx-modal').classList.add('hidden'); };
$('cx-save').onclick = async () => {
    const slug = $('cx-modal').dataset.slug;
    const disabled = [];
    const cooldownMs = {};
    $('cx-rules').querySelectorAll('.cx-rule').forEach((row) => {
        const id = row.dataset.id;
        if (!row.querySelector('.cx-en').checked) disabled.push(id);
        const v = row.querySelector('.cx-cd-in').value;
        if (v !== '' && Number.isFinite(Number(v))) cooldownMs[id] = Math.max(0, Math.round(Number(v)));
    });
    try {
        await api.customize.save(slug, { disabled, cooldownMs });
        $('cx-msg').textContent = 'Enregistré ✓ — appliqué au prochain Démarrer.';
    } catch (e) { $('cx-msg').textContent = friendlyError(e, "L'enregistrement a échoué."); }
};

// ── Lab : éditeur visuel (QUAND … ALORS …) ──
const EVENTS = [['gift', 'Cadeau'], ['gift-custom', 'Cadeau personnalisé'], ['follow', 'Nouvel abonné'], ['comment', 'Message chat'], ['hearts', 'Palier de likes'], ['share', 'Partage']];
const EXECS = [['keyboard', 'Clavier'], ['gamepad', 'Manette'], ['rcon', 'RCON'], ['obs', 'OBS'], ['http', 'HTTP'], ['mqtt', 'MQTT'], ['osc', 'OSC'], ['ws', 'WebSocket']];
const ROLES = [['all', 'Tout le monde'], ['followers', 'Abonnés'], ['moderators', 'Modérateurs']];
const GP_BUTTONS = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'START', 'BACK', 'LS', 'RS'];
let labRules = [];
let labDragIndex = -1; // index de la règle en cours de glisser (échange de slot)
let labCurrentSlug = null;
let labLatestVersion = null;
let labJsonMode = false;
let labMode = 'create'; // 'create' | 'edit'
let labTags = []; // types d'intégration (slugs)
let pendingEditSlug = null; // pack à ouvrir en édition quand on arrive sur le Lab
let pendingBannerFile = null; // bannière choisie avant la création du pack (upload différé)
let giftCatalog = []; // [{slug,name,thumbnailUrl,coinCost,isInteractiveSlot}] depuis GET /api/gifts

// Échelle FIXE des 30 slots interactifs (coins) — miroir de la config plateforme
// (les slots interactifs ne sont pas exposés dans /api/gifts, on porte l'échelle ici).
// Le PRIX est lié au NUMÉRO de slot : ranger un cadeau dans un slot moins cher = moins cher.
const INTERACTIVE_SLOT_COINS = [5, 10, 15, 20, 30, 45, 60, 80, 100, 125, 155, 190, 230, 280, 340, 410, 490, 580, 680, 790, 900, 1010, 1120, 1230, 1340, 1440, 1530, 1600, 1660, 1700];
const COIN_EUR_CENTS = 1.3; // ~1,3 cent / coin (packs de coins 0,99 €/70 … 99,99 €/8500)
function slotIndex(slug) { const m = /^ix_slot_(\d{2})$/.exec(slug || ''); return m ? (+m[1] - 1) : -1; }
function slotCoins(slug) { const i = slotIndex(slug); return i >= 0 ? INTERACTIVE_SLOT_COINS[i] : null; }
function slotPriceLabel(slug) {
    const c = slotCoins(slug);
    if (c == null) return '';
    const eur = (c * COIN_EUR_CENTS) / 100;
    return `${c} coins ≈ ${eur.toFixed(2).replace('.', ',')} €`;
}

async function loadGiftCatalog() {
    try { giftCatalog = (await api.gifts.catalog()) || []; } catch { giftCatalog = []; }
}
// « Cadeau » = un cadeau du CATALOGUE réel (art par défaut, pas d'icône à fournir).
function giftOptionsGeneric(selected) {
    const generic = giftCatalog.filter((g) => !g.isInteractiveSlot);
    let known = false;
    const opts = generic.map((g) => {
        if (g.slug === selected) known = true;
        return `<option value="${esc(g.slug)}"${g.slug === selected ? ' selected' : ''}>${esc(g.name)}</option>`;
    }).join('');
    const fallback = selected && !known ? `<option value="${esc(selected)}" selected>${esc(selected)}</option>` : '';
    return fallback + (opts || '<option value="">(catalogue indisponible)</option>');
}
// « Cadeau personnalisé » = un SLOT réservé (ix_slot_01..30), art custom (icône obligatoire).
function slotOptions(selected) {
    let s = '';
    for (let i = 1; i <= 30; i++) {
        const v = `ix_slot_${String(i).padStart(2, '0')}`;
        s += `<option value="${v}"${v === selected ? ' selected' : ''}>Slot ${i} · ${INTERACTIVE_SLOT_COINS[i - 1]} coins</option>`;
    }
    return s;
}
/** Slug par défaut d'un cadeau générique (1er du catalogue). */
function defaultGiftSlug() {
    const g = giftCatalog.find((x) => !x.isInteractiveSlot);
    return g ? g.slug : 'ix_slot_01';
}
function defaultSlot() { return 'ix_slot_01'; }
function eventFieldHtml(r) {
    if (r.event.type === 'gift') return `<select class="r-giftslug">${giftOptionsGeneric(r.event.giftSlug)}</select>`;
    if (r.event.type === 'gift-custom') {
        const src = r.event.iconUrl || r.event._iconPreview;
        const ic = src ? `background-image:url('${esc(src)}')` : '';
        return `<select class="r-giftslug">${slotOptions(r.event.giftSlug)}</select>`
            + `<span class="r-icon" title="icône du cadeau" style="${ic}"></span>`
            + `<button type="button" class="r-iconbtn">Icône…</button>`
            + `<button type="button" class="r-iconguide" title="Comment réaliser l'icône ?">i</button>`;
    }
    if (r.event.type === 'comment') return `<input type="text" class="r-contains" placeholder="contient ce mot…" />`;
    if (r.event.type === 'hearts') return `<input type="number" class="r-milestone" placeholder="palier (ex. 100)" min="1" />`;
    return '';
}
function execFieldHtml(r) {
    switch (r.effect.type) {
        case 'keyboard': return `<input type="text" class="r-keys" placeholder="touches (ex. space, shift+c)" /><select class="r-backend"><option value="auto">clavier normal</option><option value="interception">bas niveau (pilote)</option></select>`;
        case 'gamepad': return `<select class="r-button">${GP_BUTTONS.map((b) => `<option>${b}</option>`).join('')}</select>`;
        case 'rcon': return `<input type="text" class="r-command" placeholder="commande (ex. give {player} minecraft:diamond 1)" />`;
        case 'obs': return `<input type="text" class="r-request" placeholder="requête OBS (ex. SetCurrentProgramScene)" />`;
        case 'http': return `<select class="r-method"><option>GET</option><option>POST</option><option>PUT</option></select><input type="text" class="r-path" placeholder="chemin (ex. /api/toggle) — optionnel" />`;
        case 'mqtt': return `<input type="text" class="r-topic" placeholder="topic (ex. maison/led/set)" /><input type="text" class="r-payload" placeholder="message (ex. ON)" />`;
        case 'osc': return `<input type="text" class="r-address" placeholder="/avatar/parameters/… (VRChat)" /><input type="text" class="r-oscargs" placeholder="valeurs séparées par , (ex. 1, true)" />`;
        case 'ws': return `<input type="text" class="r-wsmsg" placeholder="message à envoyer" />`;
        default: return '';
    }
}
/** Sélecteur de connecteur (protocoles réseau) : les connecteurs de CE type + « Nouveau ». */
function connectorPickerHtml(r) {
    const t = r.effect.type;
    if (!CONNECTOR_PROTOCOLS.includes(t)) return '';
    const opts = myConnectors.filter((c) => c.type === t)
        .map((c) => `<option value="${esc(c.id)}"${r.effect._connectorId === c.id ? ' selected' : ''}>${esc(c.name)}</option>`).join('');
    return `<select class="r-connector" title="Connecteur (adresse + identifiants)"><option value="">— connecteur —</option>${opts}<option value="__new__">+ Nouveau…</option></select>`;
}
function newRule() { return { event: { type: 'gift', giftSlug: defaultGiftSlug() }, effect: { type: 'keyboard', keys: 'space', backend: 'auto' }, followersOnly: false, moderatorsOnly: false }; }

function readRule(el, r) {
    const q = (s) => el.querySelector(s);
    if (r.event.type === 'gift' || r.event.type === 'gift-custom') r.event.giftSlug = q('.r-giftslug') ? q('.r-giftslug').value : r.event.giftSlug;
    if (r.event.type === 'comment') r.event.contains = q('.r-contains') ? q('.r-contains').value : '';
    if (r.event.type === 'hearts') r.event.milestone = q('.r-milestone') ? Number(q('.r-milestone').value) || undefined : undefined;
    if (r.effect.type === 'keyboard') { r.effect.keys = q('.r-keys') ? q('.r-keys').value : ''; r.effect.backend = q('.r-backend') ? q('.r-backend').value : 'auto'; }
    if (r.effect.type === 'gamepad') r.effect.button = q('.r-button') ? q('.r-button').value : 'A';
    if (r.effect.type === 'rcon') r.effect.command = q('.r-command') ? q('.r-command').value : '';
    if (r.effect.type === 'obs') r.effect.request = q('.r-request') ? q('.r-request').value : '';
    if (r.effect.type === 'http') { r.effect.method = q('.r-method') ? q('.r-method').value : 'POST'; r.effect.path = q('.r-path') ? q('.r-path').value : ''; }
    if (r.effect.type === 'mqtt') { r.effect.topic = q('.r-topic') ? q('.r-topic').value : ''; r.effect.payload = q('.r-payload') ? q('.r-payload').value : ''; }
    if (r.effect.type === 'osc') {
        r.effect.address = q('.r-address') ? q('.r-address').value : '';
        r.effect.args = q('.r-oscargs') ? parseOscArgs(q('.r-oscargs').value) : [];
    }
    if (r.effect.type === 'ws') { r.effect.message = q('.r-wsmsg') ? q('.r-wsmsg').value : ''; }
    const role = q('.r-role') ? q('.r-role').value : 'all';
    r.followersOnly = role === 'followers';
    r.moderatorsOnly = role === 'moderators';
}
// Parse « 1, true, coucou » -> [1, true, "coucou"] (nombre, booléen, sinon chaîne).
function parseOscArgs(raw) {
    return String(raw || '').split(',').map((s) => s.trim()).filter((s) => s.length).map((s) => {
        if (s === 'true') return true;
        if (s === 'false') return false;
        const n = Number(s);
        return Number.isFinite(n) && s !== '' ? n : s;
    });
}
/** Lie (localement) le rôle de l'effet au connecteur choisi, pour le pack en cours. */
function bindLabConnector(r) {
    if (labCurrentSlug && r.effect.connector && r.effect._connectorId) {
        api.bindings.set(labCurrentSlug, r.effect.connector, r.effect._connectorId);
    }
}
/** Enregistre toutes les liaisons rôle->connecteur du pack (une fois le slug connu). */
function syncLabBindings() {
    if (!labCurrentSlug) return;
    for (const r of labRules) bindLabConnector(r);
}
/** true s'il reste une interaction réseau sans connecteur choisi (non bloquant : on prévient). */
function missingConnector() {
    return labRules.some((r) => CONNECTOR_PROTOCOLS.includes(r.effect.type) && !r.effect._connectorId && !r.effect.connector);
}
function onConnectorPick(el, r) {
    const sel = el.querySelector('.r-connector');
    const val = sel.value;
    if (val === '__new__') {
        openConnectorModal(null, async (saved) => {
            await loadConnectors();
            if (saved) { r.effect._connectorId = saved.id; r.effect.connector = slugifyRole(saved.name); bindLabConnector(r); }
            renderRules();
        }, r.effect.type);
        sel.value = r.effect._connectorId || '';
        return;
    }
    if (!val) { r.effect._connectorId = null; r.effect.connector = undefined; return; }
    const c = myConnectors.find((x) => x.id === val);
    const role = c ? slugifyRole(c.name) : r.effect.type;
    r.effect._connectorId = val; r.effect.connector = role;
    bindLabConnector(r);
    // Confort : applique le même connecteur aux autres interactions du MÊME type
    // encore VIDES (ex. 30 règles RCON d'un coup). Override par règle toujours possible.
    for (const other of labRules) {
        if (other !== r && other.effect.type === r.effect.type && !other.effect._connectorId) {
            other.effect._connectorId = val; other.effect.connector = role; bindLabConnector(other);
        }
    }
    renderRules();
}
// Prochaine règle « Cadeau personnalisé » dans la liste (au-dessus si dir=-1, au-dessous si +1).
function adjacentCustomIndex(i, dir) {
    for (let j = i + dir; j >= 0 && j < labRules.length; j += dir) {
        if (labRules[j].event.type === 'gift-custom') return j;
    }
    return -1;
}
// Échange les SLOTS (donc les prix) de deux cadeaux interactifs.
function swapSlots(i, j) {
    const a = labRules[i], b = labRules[j];
    if (!a || !b) return;
    const t = a.event.giftSlug; a.event.giftSlug = b.event.giftSlug; b.event.giftSlug = t;
}
function renderRules() {
    const box = $('lab-rules');
    box.innerHTML = '';
    labRules.forEach((r, i) => {
        const el = document.createElement('div');
        el.className = 'rule';
        el.innerHTML = `
            <div class="rule__part"><span class="rule__lbl">QUAND</span>
                <div class="rule__fields">
                    <select class="r-event">${EVENTS.map(([v, l]) => `<option value="${v}"${r.event.type === v ? ' selected' : ''}>${l}</option>`).join('')}</select>
                    ${eventFieldHtml(r)}</div></div>
            <div class="rule__part"><span class="rule__lbl">ALORS</span>
                <div class="rule__fields">
                    <select class="r-exec">${EXECS.map(([v, l]) => `<option value="${v}"${r.effect.type === v ? ' selected' : ''}>${l}</option>`).join('')}</select>
                    ${execFieldHtml(r)}${connectorPickerHtml(r)}</div></div>
            <div class="rule__part rule__part--foot"><span class="rule__lbl">SI</span>
                <div class="rule__fields">
                    <select class="r-role" title="Qui peut déclencher cette règle ?">${ROLES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></div>
                <button class="r-test" title="Déclencher cette interaction pour la tester">&#9654; Tester</button>
                <button class="r-del" title="Supprimer cette interaction">&#10005;</button>
                <span class="rule__grip" draggable="true" title="Glisser pour déplacer cette interaction">&#8942;&#8942;</span></div>
            <div class="rule__result"></div>`;
        const q = (s) => el.querySelector(s);
        if (r.event.type === 'comment' && q('.r-contains')) q('.r-contains').value = r.event.contains || '';
        if (r.event.type === 'hearts' && q('.r-milestone')) q('.r-milestone').value = r.event.milestone || '';
        if (r.effect.type === 'keyboard') { if (q('.r-keys')) q('.r-keys').value = r.effect.keys || ''; if (q('.r-backend')) q('.r-backend').value = r.effect.backend || 'auto'; }
        if (r.effect.type === 'gamepad' && q('.r-button')) q('.r-button').value = r.effect.button || 'A';
        if (r.effect.type === 'rcon' && q('.r-command')) q('.r-command').value = r.effect.command || '';
        if (r.effect.type === 'obs' && q('.r-request')) q('.r-request').value = r.effect.request || '';
        if (r.effect.type === 'http') { if (q('.r-method')) q('.r-method').value = r.effect.method || 'POST'; if (q('.r-path')) q('.r-path').value = r.effect.path || ''; }
        if (r.effect.type === 'mqtt') { if (q('.r-topic')) q('.r-topic').value = r.effect.topic || ''; if (q('.r-payload')) q('.r-payload').value = r.effect.payload || ''; }
        if (r.effect.type === 'osc') { if (q('.r-address')) q('.r-address').value = r.effect.address || ''; if (q('.r-oscargs')) q('.r-oscargs').value = (r.effect.args || []).join(', '); }
        if (r.effect.type === 'ws') { if (q('.r-wsmsg')) q('.r-wsmsg').value = r.effect.message || ''; }
        if (q('.r-role')) q('.r-role').value = r.moderatorsOnly ? 'moderators' : r.followersOnly ? 'followers' : 'all';
        if (q('.r-connector')) q('.r-connector').onchange = () => onConnectorPick(el, r);
        if (q('.r-iconguide')) q('.r-iconguide').onclick = () => $('icon-guide-modal').classList.remove('hidden');
        if (q('.r-iconbtn')) q('.r-iconbtn').onclick = async () => {
            readRule(el, r);
            const picked = await api.lab.pickIcon(); // choisir SANS créer le pack
            if (!picked || !picked.filePath) return;
            // Garde l'icône EN MÉMOIRE (aperçu immédiat) ; upload différé à la création.
            r.event._iconFile = picked.filePath;
            r.event._iconPreview = picked.dataUrl || '';
            r.event.iconUrl = null; // sera posé à l'upload
            // Si le pack existe déjà (édition), on peut uploader tout de suite.
            if (labCurrentSlug) {
                $('lab-msg2').textContent = 'Envoi de l’icône…';
                try {
                    const res = await api.lab.uploadIconFile(labCurrentSlug, r.event.giftSlug, picked.filePath);
                    if (res && res.url) { r.event.iconUrl = res.url; r.event._iconFile = null; $('lab-msg2').textContent = 'Icône ajoutée ✓'; }
                } catch (e) { $('lab-msg2').textContent = friendlyError(e, "L'icône n'a pas pu être envoyée."); }
            } else {
                $('lab-msg2').textContent = 'Icône prête ✓ (envoyée à la création du pack).';
            }
            renderRules();
        };
        q('.r-event').onchange = (e) => {
            const t = e.target.value; r.event = { type: t };
            if (t === 'gift') r.event.giftSlug = defaultGiftSlug();
            if (t === 'gift-custom') r.event.giftSlug = defaultSlot();
            renderRules();
        };
        q('.r-exec').onchange = (e) => { r.effect = { type: e.target.value }; renderRules(); };
        // Slot interactif : re-render au changement pour rafraîchir le prix affiché + l'icône.
        if (r.event.type === 'gift-custom' && q('.r-giftslug')) {
            q('.r-giftslug').addEventListener('change', () => { readRule(el, r); renderRules(); });
        }
        // Poignée à DROITE : glisser pour DÉPLACER l'interaction (réordonner la liste).
        // On lit d'abord la saisie DOM courante pour ne rien perdre au re-render.
        const grip = q('.rule__grip');
        if (grip) {
            grip.ondragstart = (e) => {
                readRule(el, r);
                labDragIndex = i;
                try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); } catch { /* noop */ }
                el.classList.add('rule--dragging');
            };
            grip.ondragend = () => { el.classList.remove('rule--dragging'); labDragIndex = -1; };
        }
        el.addEventListener('dragover', (e) => {
            if (labDragIndex >= 0 && labDragIndex !== i) { e.preventDefault(); el.classList.add('rule--dropthere'); }
        });
        el.addEventListener('dragleave', () => el.classList.remove('rule--dropthere'));
        el.addEventListener('drop', (e) => {
            e.preventDefault();
            el.classList.remove('rule--dropthere');
            const from = labDragIndex; labDragIndex = -1;
            if (from < 0 || from === i) return;
            const [moved] = labRules.splice(from, 1); // retire de sa position
            labRules.splice(i, 0, moved); // ré-insère à la position de la cible
            renderRules();
        });
        el.querySelectorAll('input, select').forEach((inp) => {
            if (inp.classList.contains('r-event') || inp.classList.contains('r-exec') || inp.classList.contains('r-connector')) return;
            inp.addEventListener('input', () => readRule(el, r));
        });
        q('.r-del').onclick = () => { labRules.splice(i, 1); renderRules(); };
        q('.r-test').onclick = async () => {
            readRule(el, r); // synchronise la saisie DOM -> objet règle
            const res = q('.rule__result');
            res.textContent = 'Test en cours…'; res.className = 'rule__result';
            try {
                const v = await api.engine.testRule(buildRule(r, i), labCurrentSlug);
                if (v && v.ok) { res.textContent = '✓ Déclenché'; res.className = 'rule__result ok'; }
                else { res.textContent = '✗ ' + ((v && v.reason) || 'échec'); res.className = 'rule__result no'; }
            } catch (e) { res.textContent = '✗ ' + friendlyError(e, 'test impossible'); res.className = 'rule__result no'; }
        };
        box.appendChild(el);
    });
}
function buildRule(r, i) {
    // « Cadeau » et « Cadeau personnalisé » sont deux vues UI du même trigger 'gift'.
    const onType = r.event.type === 'gift-custom' ? 'gift' : r.event.type;
    const on = { type: onType };
    if (onType === 'gift') on.giftSlug = r.event.giftSlug || r.event.slot;
    if (r.event.type === 'gift-custom' && r.event.iconUrl) on.iconUrl = r.event.iconUrl;
    if (r.event.type === 'comment') on.contains = r.event.contains;
    if (r.event.type === 'hearts') on.milestone = r.event.milestone;
    const effect = { type: r.effect.type };
    if (r.effect.type === 'keyboard') { effect.keys = r.effect.keys; if (r.effect.backend && r.effect.backend !== 'auto') effect.backend = r.effect.backend; }
    if (r.effect.type === 'gamepad') effect.button = r.effect.button;
    if (r.effect.type === 'rcon') effect.command = r.effect.command;
    if (r.effect.type === 'obs') effect.request = r.effect.request;
    if (r.effect.type === 'http') { effect.method = r.effect.method; if (r.effect.path) effect.path = r.effect.path; }
    if (r.effect.type === 'mqtt') { effect.topic = r.effect.topic; effect.payload = r.effect.payload || ''; }
    if (r.effect.type === 'osc') { effect.address = r.effect.address; if (r.effect.args && r.effect.args.length) effect.args = r.effect.args; }
    if (r.effect.type === 'ws') { effect.message = r.effect.message || ''; }
    // Rôle de connecteur (protocoles réseau) : l'endpoint est lié à l'installation.
    if (CONNECTOR_PROTOCOLS.includes(r.effect.type) && r.effect.connector) effect.connector = r.effect.connector;
    const rule = { id: 'r' + (i + 1), on, effect };
    if (r.followersOnly) rule.followersOnly = true;
    if (r.moderatorsOnly) rule.moderatorsOnly = true;
    return rule;
}
function buildManifest() {
    return { schema: 2, rules: labRules.map((r, i) => buildRule(r, i)) };
}
function manifestToRules(m) {
    return ((m && m.rules) || []).map((rule) => {
        const event = { ...rule.on };
        // Normalise l'alias déprécié slot -> giftSlug pour l'édition.
        if (event.type === 'gift' && !event.giftSlug && event.slot) { event.giftSlug = event.slot; delete event.slot; }
        // Un slug de slot réservé -> vue « Cadeau personnalisé » ; sinon « Cadeau ».
        if (event.type === 'gift' && /^ix_slot_\d{2}$/.test(event.giftSlug || '')) event.type = 'gift-custom';
        return { event, effect: { ...rule.effect }, followersOnly: !!rule.followersOnly, moderatorsOnly: !!rule.moderatorsOnly };
    });
}
function bumpVersion(v, type) {
    if (!v) return '1.0.0';
    const [maj, min, pat] = v.split('.').map(Number);
    if (type === 'major') return `${maj + 1}.0.0`;
    if (type === 'minor') return `${maj}.${min + 1}.0`;
    return `${maj}.${min}.${pat + 1}`;
}

$('lab-add-rule').onclick = () => { labRules.push(newRule()); renderRules(); };
$('lab-mode').onchange = () => {
    labJsonMode = $('lab-mode').checked;
    if (labJsonMode) {
        $('lab-manifest').value = JSON.stringify(buildManifest(), null, 2);
        $('lab-builder').classList.add('hidden');
        $('lab-json-mode').classList.remove('hidden');
        $('lab-mode-label').textContent = 'Mode simplifié';
    } else {
        try { labRules = manifestToRules(JSON.parse($('lab-manifest').value)); } catch { /* garde l'existant */ }
        renderRules();
        $('lab-builder').classList.remove('hidden');
        $('lab-json-mode').classList.add('hidden');
        $('lab-mode-label').textContent = 'Mode avancé (JSON)';
    }
};

// ── Tags (chips) ──
function normTag(s) {
    return String(s || '').trim().toLowerCase().normalize('NFD')
        .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}
function renderTags() {
    const box = $('lab-tags');
    box.innerHTML = labTags.map((t, i) => `<span class="tag-chip">${esc(t)}<button data-i="${i}" title="retirer">&#10005;</button></span>`).join('');
    box.querySelectorAll('button').forEach((b) => (b.onclick = () => { labTags.splice(Number(b.dataset.i), 1); renderTags(); }));
}
function addTagFromInput() {
    const el = $('lab-tag-input');
    const t = normTag(el.value);
    if (t && !labTags.includes(t) && labTags.length < 6) labTags.push(t);
    el.value = '';
    renderTags();
}
$('lab-tag-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTagFromInput(); } });
$('lab-tag-input').addEventListener('change', () => { if ($('lab-tag-input').value) addTagFromInput(); });

// ── Dictionnaires (autocomplétion type + jeu, approuvés uniquement) ──
async function loadDictionaries() {
    const [types, games] = await Promise.all([api.lab.dictionary('type'), api.lab.dictionary('game')]);
    $('lab-tag-list').innerHTML = (types || []).map((t) => `<option value="${esc(t.slug)}">${esc(t.label)}</option>`).join('');
    $('lab-game-list').innerHTML = (games || []).map((g) => `<option value="${esc(g.slug)}">${esc(g.label)}</option>`).join('');
}

// ── Visibilité par version (toggle : position + texte, daltonien-safe) ──
$('lab-vis').onchange = () => { $('lab-vis-label').textContent = $('lab-vis').checked ? 'Public' : 'Privé'; };

// ── Bascule création / édition ──
function setLabMode(mode) {
    labMode = mode;
    const create = mode === 'create';
    $('lab-mode-title').textContent = create ? 'Créer un pack' : 'Éditer : ' + (labCurrentSlug || '');
    $('lab-slug').readOnly = !create;
    $('lab-bump').classList.toggle('hidden', create);
    $('lab-save-meta').classList.toggle('hidden', create);
    $('lab-new-btn').classList.toggle('hidden', create);
    $('lab-submit-btn').textContent = create ? 'Créer le pack' : 'Enregistrer la version';
}
function enterCreateMode() {
    labCurrentSlug = null; labLatestVersion = null; labTags = [];
    labRules = [newRule()];
    $('lab-slug').value = ''; $('lab-title').value = ''; $('lab-game').value = '';
    $('lab-banner-preview').style.backgroundImage = '';
    $('lab-versions').innerHTML = '';
    $('lab-msg').textContent = ''; $('lab-msg2').textContent = '';
    $('lab-vis').checked = false; $('lab-vis-label').textContent = 'Privé';
    renderTags();
    if (labJsonMode) $('lab-manifest').value = JSON.stringify(buildManifest(), null, 2); else renderRules();
    setLabMode('create');
}
async function enterEditMode(slug) {
    const detail = await api.lab.detail(slug);
    if (!detail || !detail.bundle) { $('lab-msg').textContent = 'Pack introuvable.'; return; }
    const b = detail.bundle;
    const versions = detail.versions || []; // triées DESC
    labCurrentSlug = b.slug;
    labLatestVersion = versions.length ? versions[0].version : null;
    labTags = Array.isArray(b.tags) ? b.tags.slice() : [];
    $('lab-slug').value = b.slug; $('lab-title').value = b.title || ''; $('lab-game').value = b.game || '';
    $('lab-banner-preview').style.backgroundImage = b.bannerUrl ? `url('${b.bannerUrl}')` : '';
    // Historique des versions (numéro + statut de modération + date + changelog).
    $('lab-versions').innerHTML = versions.length
        ? '<span class="lab-sub">Versions</span>' + versions.map((v) =>
            `<div class="lab-ver"><b>v${esc(v.version)}</b> <span class="badge badge--off">${esc(v.moderationStatus || v.visibility || '')}</span> <span class="muted small">${esc(fmtDate(v.createdAt))}</span>${v.changelog ? `<div class="changelog">${esc(v.changelog)}</div>` : ''}</div>`
        ).join('')
        : '<span class="lab-sub">Versions</span><p class="muted small">Aucune version encore.</p>';
    $('lab-msg').textContent = ''; $('lab-msg2').textContent = '';
    const lastVis = versions.length ? versions[0].visibility : b.visibility;
    $('lab-vis').checked = lastVis === 'public'; $('lab-vis-label').textContent = lastVis === 'public' ? 'Public' : 'Privé';
    labRules = versions.length ? manifestToRules(versions[0].manifestJson) : [newRule()];
    // Restaure le connecteur choisi par rôle (liaisons locales du pack).
    try {
        const bindings = (await api.bindings.get(b.slug)) || {};
        for (const r of labRules) {
            if (r.effect.connector && bindings[r.effect.connector]) r.effect._connectorId = bindings[r.effect.connector];
        }
    } catch { /* noop */ }
    renderTags();
    if (labJsonMode) $('lab-manifest').value = JSON.stringify(buildManifest(), null, 2); else renderRules();
    setLabMode('edit');
}
$('lab-new-btn').onclick = () => enterCreateMode();

async function loadLab() {
    await Promise.all([loadGiftCatalog(), loadDictionaries(), loadConnectors()]);
    if (pendingEditSlug) { const s = pendingEditSlug; pendingEditSlug = null; await enterEditMode(s); }
    else if (!(labMode === 'edit' && labCurrentSlug)) enterCreateMode();
}

$('lab-banner-btn').onclick = async () => {
    // 1) Choisir -> aperçu IMMÉDIAT (data-URL), avant tout upload.
    const picked = await api.lab.pickBanner();
    if (!picked || !picked.filePath) return; // annulé
    if (picked.dataUrl) $('lab-banner-preview').style.backgroundImage = `url('${picked.dataUrl}')`;
    // 2) Pack pas encore créé : on garde le fichier, upload différé à la création.
    if (!labCurrentSlug) {
        pendingBannerFile = picked.filePath;
        $('lab-msg2').textContent = 'Aperçu prêt ✓ — la bannière sera envoyée à la création du pack.';
        return;
    }
    // 3) Upload avec état de chargement visible.
    $('lab-banner-btn').disabled = true;
    $('lab-msg2').textContent = 'Envoi de la bannière…';
    try {
        const r = await api.lab.uploadBannerFile(labCurrentSlug, picked.filePath);
        const url = r && (r.bannerUrl || r.url);
        if (url) $('lab-banner-preview').style.backgroundImage = `url('${url}')`;
        $('lab-msg2').textContent = 'Bannière mise à jour ✓';
    } catch (e) {
        $('lab-msg2').textContent = friendlyError(e, "La bannière n'a pas pu être envoyée.");
    } finally {
        $('lab-banner-btn').disabled = false;
    }
};
$('lab-save-meta').onclick = async () => {
    if (!labCurrentSlug) return;
    try {
        await api.lab.update(labCurrentSlug, { title: $('lab-title').value.trim(), game: $('lab-game').value.trim() || '', tags: labTags });
        $('lab-msg').textContent = 'Infos enregistrées ✓';
    } catch (e) { $('lab-msg').textContent = friendlyError(e, "Les infos n'ont pas pu être enregistrées."); }
};
/** true s'il reste un « cadeau personnalisé » sans icône (uploadée OU en mémoire). */
function missingCustomIcon() {
    return labRules.some((r) => r.event.type === 'gift-custom' && !r.event.iconUrl && !r.event._iconFile);
}
/** Upload les icônes gardées EN MÉMOIRE (une fois le pack créé). */
async function uploadHeldIcons() {
    for (const r of labRules) {
        if (r.event.type === 'gift-custom' && r.event._iconFile && !r.event.iconUrl) {
            const res = await api.lab.uploadIconFile(labCurrentSlug, r.event.giftSlug, r.event._iconFile);
            if (res && res.url) { r.event.iconUrl = res.url; r.event._iconFile = null; r.event._iconPreview = ''; }
        }
    }
}
$('lab-submit-btn').onclick = async () => {
    const visibility = $('lab-vis').checked ? 'public' : 'private';

    if (!labJsonMode && missingConnector())
        return ($('lab-msg2').textContent = 'Chaque interaction réseau doit avoir un connecteur — choisis-en un ou crée-en un (+ Nouveau…).');
    if (!labJsonMode && missingCustomIcon())
        return ($('lab-msg2').textContent = 'Chaque « cadeau personnalisé » doit avoir une icône.');

    if (labMode === 'create') {
        const slug = $('lab-slug').value.trim(), title = $('lab-title').value.trim();
        if (!slug || !title) return ($('lab-msg').textContent = 'Slug et titre sont obligatoires.');
        try {
            await api.lab.create({ slug, title, game: $('lab-game').value.trim() || undefined, tags: labTags });
            labCurrentSlug = slug; labLatestVersion = null;
            syncLabBindings(); // enregistre les liaisons rôle->connecteur (slug désormais connu)
            await uploadHeldIcons(); // pose les icônes gardées en mémoire
            if (pendingBannerFile) { // bannière choisie avant création -> upload maintenant
                try { await api.lab.uploadBannerFile(slug, pendingBannerFile); } catch { /* non bloquant */ }
                pendingBannerFile = null;
            }
            const manifest = labJsonMode ? JSON.parse($('lab-manifest').value) : buildManifest();
            await api.lab.submitVersion(slug, { version: '1.0.0', manifest, visibility });
            await enterEditMode(slug);
            $('lab-msg2').textContent = visibility === 'public' ? 'Pack créé + v1.0.0 en modération ✓' : 'Pack créé (privé) + v1.0.0 ✓';
        } catch (e) { $('lab-msg2').textContent = friendlyError(e, 'La création du pack a échoué.'); }
        return;
    }

    // Édition : nouvelle version
    syncLabBindings();
    await uploadHeldIcons();
    let manifest;
    if (labJsonMode) { try { manifest = JSON.parse($('lab-manifest').value); } catch { return ($('lab-msg2').textContent = 'JSON invalide.'); } }
    else manifest = buildManifest();
    const version = labLatestVersion ? bumpVersion(labLatestVersion, $('lab-bump').value) : '1.0.0';
    try {
        await api.lab.submitVersion(labCurrentSlug, { version, manifest, visibility });
        labLatestVersion = version;
        $('lab-msg2').textContent = `Version ${version} enregistrée (${visibility === 'public' ? 'publique, en modération' : 'privée'}) ✓`;
    } catch (e) { $('lab-msg2').textContent = friendlyError(e, 'Version refusée.'); }
};

// ── Mes bundles (cliquables -> édition dans le Lab) ──
async function loadMyBundles() {
    const mine = (await api.lab.myBundles()) || [];
    const box = $('mine-list');
    box.innerHTML = '';
    if (!mine.length) { box.innerHTML = '<p class="muted">Aucun bundle créé. Va dans le Lab pour en créer un.</p>'; return; }
    mine.forEach((b) => {
        const card = document.createElement('div');
        card.className = 'bundle-card';
        const banner = b.bannerUrl ? ` style="background-image:url('${esc(b.bannerUrl)}')"` : '';
        const ver = b.version ? `v${esc(b.version)}${b.versionDate ? ' · ' + esc(fmtDate(b.versionDate)) : ''}` : 'aucune version publiée';
        card.innerHTML = `
            <div class="bundle-card__banner"${banner}></div>
            <div class="bundle-card__body">
                <div class="row between"><h3>${esc(b.title || b.slug)}</h3><span class="badge badge--off">${esc(b.visibility)}</span></div>
                <div class="publisher">${publisherHtml(b.publisher, b.installCount)}</div>
                <div class="muted small">${ver}${b.official ? ' · officiel' : ''}</div>
                ${b.changelog ? `<div class="changelog">${esc(b.changelog)}</div>` : ''}
                <div class="row gap wrap"><button class="btn btn--primary edit">Éditer</button></div>
            </div>`;
        card.querySelector('.edit').onclick = () => { pendingEditSlug = b.slug; switchView('lab'); };
        box.appendChild(card);
    });
}

// ── Settings ──
$('lang').onchange = (e) => api.language(e.target.value);
$('env-select').onchange = async () => {
    await api.env.set($('env-select').value);
    // Déconnecté par le changement d'env : on revient à l'écran de connexion.
    $('app-main').classList.add('hidden');
    $('view-auth').classList.remove('hidden');
};
api.autoLaunch().then((v) => ($('autolaunch').checked = !!v));
$('autolaunch').onchange = () => api.autoLaunch($('autolaunch').checked);

// ══════════ Connecteurs (composant partagé : modale + Réglages + Lab) ══════════
/** Construit le formulaire d'un connecteur dans `container`. Réutilisé partout. */
function buildConnectorForm(container, connector, presetType) {
    const type = connector?.type || presetType || 'rcon';
    container.dataset.connectorId = connector?.id || '';
    const typeLocked = !!presetType && !connector; // depuis le Lab : type imposé
    container.innerHTML =
        `<input class="cf-name" placeholder="Nom (ex. Serveur Minecraft, Broker salon)" />`
        + `<select class="cf-type"${typeLocked ? ' disabled' : ''}>${Object.entries(CONNECTOR_TYPES).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('')}</select>`
        + `<div class="cf-fields"></div>`;
    const nameEl = container.querySelector('.cf-name'); nameEl.value = connector?.name || '';
    const typeEl = container.querySelector('.cf-type'); typeEl.value = type;
    const renderFields = () => {
        const t = typeEl.value;
        container.querySelector('.cf-fields').innerHTML = CONNECTOR_TYPES[t].fields.map(([k, label, kind]) => {
            const val = connector && connector.type === t ? esc(connector.config?.[k] || '') : '';
            const isPw = kind === 'password';
            const ph = isPw && connector?.hasSecret ? '✓ défini (laisser vide pour garder)' : label;
            return `<input class="cf-f" data-k="${k}" type="${kind === 'number' ? 'number' : isPw ? 'password' : 'text'}" placeholder="${esc(ph)}" value="${isPw ? '' : val}" />`;
        }).join('');
    };
    typeEl.onchange = renderFields;
    renderFields();
}
function readConnectorForm(container) {
    const id = container.dataset.connectorId || undefined;
    const name = container.querySelector('.cf-name').value.trim();
    const type = container.querySelector('.cf-type').value;
    const config = {};
    container.querySelectorAll('.cf-f').forEach((el) => { config[el.dataset.k] = el.value.trim(); });
    return { id, name, type, config };
}
let connectorOnSaved = null;
function openConnectorModal(connector, onSaved, presetType) {
    connectorOnSaved = onSaved || null;
    $('connector-modal-title').textContent = connector ? 'Éditer le connecteur' : 'Nouveau connecteur';
    $('connector-msg').textContent = '';
    buildConnectorForm($('connector-form'), connector, presetType);
    $('connector-modal').classList.remove('hidden');
}
function closeConnectorModal() { $('connector-modal').classList.add('hidden'); connectorOnSaved = null; }
$('connector-close').onclick = closeConnectorModal;
$('connector-cancel').onclick = closeConnectorModal;
$('connector-save').onclick = async () => {
    const dto = readConnectorForm($('connector-form'));
    if (!dto.name) { $('connector-msg').textContent = 'Donne un nom au connecteur.'; return; }
    try {
        const res = await api.connectors.save(dto);
        await loadConnectors();
        const saved = myConnectors.find((c) => c.id === (res && res.id)) || null;
        closeConnectorModal();
        if (connectorOnSaved) connectorOnSaved(saved);
    } catch (e) { $('connector-msg').textContent = friendlyError(e, "Le connecteur n'a pas pu être enregistré."); }
};

// ── Vue Connecteurs ──
function connectorTypeLabel(type) { return (CONNECTOR_TYPES[type] || {}).label || 'Local'; }
function renderConnectorsList() {
    const box = $('cx-list');
    if (!myConnectors.length) { box.innerHTML = '<p class="muted">Aucun connecteur.</p>'; return; }
    box.innerHTML = myConnectors.map((c) => {
        const isLocal = !CONNECTOR_TYPES[c.type];
        return `<div class="cx-row" data-id="${esc(c.id)}">`
            + `<label class="switch" title="Activer / désactiver"><input type="checkbox" class="cx-enable"${c.enabled ? ' checked' : ''}/><span class="switch__track"><span class="switch__thumb"></span></span></label>`
            + `<span class="cx-type">${esc(connectorTypeLabel(c.type))}</span><b>${esc(c.name)}</b>`
            + (isLocal ? '' : `<button class="cx-edit">Éditer</button><button class="cx-del" title="Supprimer">&#10005;</button>`)
            + `</div>`;
    }).join('');
    box.querySelectorAll('.cx-row').forEach((row) => {
        const c = myConnectors.find((x) => x.id === row.dataset.id);
        // Pas de re-render au toggle : sinon le DOM est remplacé et le switch « saute »
        // au lieu de glisser. On met à jour l'état local + on persiste, c'est tout.
        row.querySelector('.cx-enable').onchange = (e) => { c.enabled = e.target.checked; api.connectors.enable(c.id, e.target.checked); };
        const edit = row.querySelector('.cx-edit'); if (edit) edit.onclick = () => openConnectorModal(c, () => renderConnectorsList());
        const del = row.querySelector('.cx-del'); if (del) del.onclick = async () => { await api.connectors.remove(c.id); await loadConnectors(); renderConnectorsList(); };
    });
}
async function loadConnectorsView() { await loadConnectors(); renderConnectorsList(); }
$('cx-add').onclick = () => openConnectorModal(null, () => renderConnectorsList());
$('cx-info').onclick = () => $('cx-info-modal').classList.remove('hidden');
$('cx-info-close').onclick = () => $('cx-info-modal').classList.add('hidden');

// ── Mises à jour ──
function renderUpdate(u) {
    const s = $('update-status');
    const install = $('update-install');
    if (!s) return;
    switch (u.status) {
        case 'checking': s.textContent = 'Vérification…'; break;
        case 'available': s.textContent = `Mise à jour ${u.version || ''} trouvée, téléchargement…`; break;
        case 'downloading': s.textContent = `Téléchargement… ${u.percent || 0}%`; break;
        case 'downloaded':
            s.textContent = `Mise à jour ${u.version || ''} prête à installer.`;
            install.classList.remove('hidden');
            $('app-ver').textContent = 'v' + (u.version || '') + ' · maj prête';
            break;
        case 'none': s.textContent = 'Tu es à jour.'; break;
        case 'dev': s.textContent = 'Mode dev (pas de mise à jour).'; break;
        case 'error': s.textContent = 'Erreur : ' + (u.message || ''); break;
        default: s.textContent = '—';
    }
}
api.onUpdate(renderUpdate);
$('update-check').onclick = () => api.update.check();
$('update-install').onclick = () => api.update.install();

// ── CGU / charte d'usage acceptable (contenu HTML servi par main) ──
let cguLoaded = false;
async function openCgu(gate) {
    $('cgu-modal').classList.remove('hidden');
    $('cgu-close').classList.toggle('hidden', !!gate); // pas de fermeture tant que non accepté
    $('cgu-actions').classList.toggle('hidden', !gate);
    if (!cguLoaded) {
        try { $('cgu-content').innerHTML = await api.legal.text(); cguLoaded = true; }
        catch { $('cgu-content').textContent = 'Conditions indisponibles.'; }
    }
    $('cgu-content').scrollTop = 0;
}
$('icon-guide-close').onclick = () => $('icon-guide-modal').classList.add('hidden');
$('cgu-open').onclick = () => openCgu(false);
$('cgu-close').onclick = () => $('cgu-modal').classList.add('hidden');
$('cgu-accept').onclick = async () => { await api.legal.accept(); $('cgu-modal').classList.add('hidden'); };
async function checkLegalGate() {
    try { const s = await api.legal.status(); if (s && !s.accepted) await openCgu(true); } catch { /* noop */ }
}

// ── Boot ──
refreshAuth();
checkLegalGate(); // acceptation obligatoire au premier lancement (bloquant)
api.language().then((l) => ($('lang').value = l));
api.appVersion().then((v) => ($('app-ver').textContent = 'v' + v));
api.update.check(); // check silencieux au démarrage (installe en tâche de fond)
