'use strict';
const api = window.houlaConnect;
const $ = (id) => document.getElementById(id);
const TRANSPARENT = 'data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=';
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// Message d'erreur lisible : garde nos messages courts et propres (erreurs API),
// remplace les dumps techniques (stack, HttpError, réseau) par un repli user-friendly.
// Le détail complet part TOUJOURS en console pour le debug.
function friendlyError(e, fallback) {
    if (e) console.error(e);
    let m = (e && e.message != null ? String(e.message) : String(e || '')).split('\n')[0].trim();
    // Electron enveloppe les rejets IPC : « Error invoking remote method 'x': Error: <vrai msg> ».
    // On retire l'enveloppe (et un « Error: » résiduel) pour ne garder QUE le message métier.
    m = m.replace(/^Error invoking remote method '[^']*':\s*/i, '').replace(/^(Uncaught\s+)?Error:\s*/i, '').trim();
    // Erreur de taille de fichier (upload icône/bannière) -> message clair avec la limite.
    const fsz = /current file size is (\d+), expected size is less than (\d+)/i.exec(m);
    if (fsz) {
        const maxMo = Math.max(1, Math.round(Number(fsz[2]) / (1024 * 1024)));
        return `Image trop lourde (max ${maxMo} Mo). Choisis une image plus légère.`;
    }
    if (!m || m.length > 240 || /HttpError|node_modules|\bat\s|Failed to fetch|NetworkError|ENOTFOUND|ECONN|getaddrinfo|<!DOCTYPE|\bstack\b/i.test(m)) {
        return fallback || 'Une erreur est survenue. Réessaie.';
    }
    return m;
}
// ── Test d'effet avec décompte ─────────────────────────────────────
// Un test clavier/manette/driver ENVOIE de vraies touches à la fenêtre au premier
// plan. Un décompte visible (« Test dans 3… ») laisse le temps de basculer sur le
// jeu AVANT le tir. Les effets réseau (RCON/OBS/HTTP) partent sans délai.
// NB honnête : le focus-guard côté moteur est encore un stub permissif (il ne
// RESTREINT pas à la fenêtre cible) ; le décompte ne PRÉVIENT donc pas un tir mal
// dirigé, il laisse juste le temps de viser. D'où l'importance d'annuler le décompte
// dès que le contexte disparaît (modale fermée, liste re-rendue) : sinon un tir
// clavier partirait « à l'aveugle » dans l'appli active, contre l'intention.
const TEST_COUNTDOWN_S = 3;
const effectNeedsFocus = (type) => type === 'keyboard' || type === 'gamepad' || type === 'python';
let _testCountdown = null; // { timer, btn, resEl, cls } du décompte VISIBLE en cours (un seul)
function cancelTestCountdown() {
    if (!_testCountdown) return;
    const { timer, btn, resEl, cls } = _testCountdown;
    clearTimeout(timer);
    if (btn) btn.disabled = false;
    // Efface le « Test dans N… » s'il est encore à l'écran (ne touche pas un résultat déjà posé).
    if (resEl && resEl.isConnected && /Test dans/.test(resEl.textContent || '')) {
        resEl.textContent = ''; resEl.className = cls;
    }
    _testCountdown = null;
}
function runEffectTest({ resEl, cls, needsFocus, btn, fire }) {
    cancelTestCountdown(); // jamais deux décomptes en vol (anti double-tir / anti-orphelin)
    const state = { timer: null, btn, resEl, cls };
    const setRes = (txt, extra) => {
        if (resEl && resEl.isConnected) { resEl.textContent = txt; resEl.className = cls + (extra ? ' ' + extra : ''); }
    };
    // Ne détache l'état global QUE s'il est encore le nôtre (un test suivant a pu prendre la main).
    const finish = () => { if (btn) btn.disabled = false; if (_testCountdown === state) _testCountdown = null; };
    const doFire = async () => {
        // resEl détaché = modale fermée / liste re-rendue : on N'INJECTE PAS à l'aveugle.
        if (needsFocus && resEl && !resEl.isConnected) { finish(); return; }
        setRes('Test…');
        try {
            const v = await fire();
            if (v && v.ok) setRes('✓ Déclenché', 'ok');
            else {
                // Un échec s'écrit dans un span minuscule ; or pour clavier/manette on vient
                // d'envoyer l'utilisateur SUR SON JEU (décompte) -> il ne voit pas le span.
                // On double donc par un TOAST, visible au retour dans Connect.
                const r = (v && v.reason) || 'échec';
                setRes('✗ ' + r, 'no');
                showToast('effect-test', { kind: 'warn', title: 'Test non déclenché', msg: r });
            }
        } catch (e) {
            const r = friendlyError(e, 'test impossible');
            setRes('✗ ' + r, 'no');
            showToast('effect-test', { kind: 'error', title: 'Test impossible', msg: r });
        }
        finish();
    };
    if (btn) btn.disabled = true;
    if (!needsFocus) { doFire(); return; }
    let n = TEST_COUNTDOWN_S;
    setRes('⏱ Test dans ' + n + '… bascule sur ton jeu');
    const tick = () => {
        if (_testCountdown !== state) return; // annulé ou remplacé entre-temps
        n -= 1;
        if (n > 0) { setRes('⏱ Test dans ' + n + '… bascule sur ton jeu'); state.timer = setTimeout(tick, 1000); }
        else doFire(); // finish() détachera l'état s'il est encore le nôtre
    };
    state.timer = setTimeout(tick, 1000);
    _testCountdown = state;
}
// ── Toasts (notifications non bloquantes) ──────────────────────────
// Le sens ne repose JAMAIS sur la seule couleur (propriétaire daltonien) : chaque
// toast porte une ICÔNE distincte + un TITRE en gras explicite ; la couleur (barre
// de gauche) n'est qu'un renfort. Un id réutilisé met à jour le MÊME toast (pas de doublon).
const TOAST_ICON = { error: '⚠', warn: '⚠', info: 'ℹ', ok: '✓' };
function showToast(id, { kind = 'info', title = '', msg = '', action = null, persist = false } = {}) {
    const host = $('toaster');
    if (!host) return null;
    let el = host.querySelector(`[data-toast="${id}"]`);
    if (!el) {
        el = document.createElement('div');
        el.dataset.toast = id;
        host.appendChild(el);
    }
    el.className = `toast toast--${kind}`;
    el.innerHTML =
        `<span class="toast__ic" aria-hidden="true">${TOAST_ICON[kind] || 'ℹ'}</span>` +
        `<div class="toast__body">${title ? `<div class="toast__title">${esc(title)}</div>` : ''}<div class="toast__msg">${esc(msg)}</div></div>` +
        `<div class="toast__actions"></div>` +
        `<button class="toast__close" title="Fermer" aria-label="Fermer">&#10005;</button>`;
    el.querySelector('.toast__close').onclick = () => dismissToast(id);
    if (action) {
        const b = document.createElement('button');
        b.className = 'toast__btn';
        b.textContent = action.label;
        b.onclick = () => action.onClick(b); // passe le bouton (état « occupé »)
        el.querySelector('.toast__actions').appendChild(b);
    }
    clearTimeout(el._t);
    if (!persist) el._t = setTimeout(() => dismissToast(id), 6000);
    return el;
}
function dismissToast(id) {
    const host = $('toaster');
    const el = host && host.querySelector(`[data-toast="${id}"]`);
    if (el) { clearTimeout(el._t); el.remove(); }
}

// ── Rendu Markdown SÛR (instructions/prérequis d'un pack) ───────────────
// Principe anti-XSS : on n'injecte JAMAIS de HTML venu de l'utilisateur. Tout
// segment de texte est ÉCHAPPÉ (esc) AVANT d'être enveloppé ; seules des balises
// que NOUS produisons (h/ul/li/p/code/pre/strong/em/a) apparaissent. Les liens
// sont bornés à http(s)/mailto. La coloration de code opère sur le texte BRUT
// (chaque jeton est ré-échappé), donc aucune balise ne peut naître du contenu.
function mdHighlight(raw) {
    const re = /(#[^\n]*|\/\/[^\n]*)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(\{[a-zA-Z0-9_]+\})|(\b[a-z][a-z0-9_]*:[a-z0-9_/.:-]+\b)|(\b\d+(?:\.\d+)?\b)/g;
    let out = '', last = 0, m;
    while ((m = re.exec(raw))) {
        out += esc(raw.slice(last, m.index));
        const cls = m[1] ? 'c-com' : m[2] ? 'c-str' : m[3] ? 'c-ph' : m[4] ? 'c-id' : 'c-num';
        out += `<span class="${cls}">${esc(m[0])}</span>`;
        last = m.index + m[0].length;
    }
    return out + esc(raw.slice(last));
}
function mdInline(raw) {
    return String(raw == null ? '' : raw).split(/(`[^`]+`)/g).map((seg) => {
        if (seg.length >= 2 && seg[0] === '`' && seg[seg.length - 1] === '`') {
            return `<code>${esc(seg.slice(1, -1))}</code>`;
        }
        let s = esc(seg);
        s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g,
            (mm, txt, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${txt}</a>`);
        s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
        return s;
    }).join('');
}
function mdToSafeHtml(src) {
    const lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let i = 0;
    const flushList = (buf, tag) => { if (buf.length) { out.push(`<${tag}>${buf.map((x) => `<li>${mdInline(x)}</li>`).join('')}</${tag}>`); buf.length = 0; } };
    while (i < lines.length) {
        const line = lines[i];
        // Bloc de code clôturé ```lang … ```
        const fence = /^```(\w*)\s*$/.exec(line);
        if (fence) {
            const lang = fence[1] || '';
            const body = [];
            i++;
            while (i < lines.length && !/^```\s*$/.test(lines[i])) { body.push(lines[i]); i++; }
            i++; // saute la clôture
            out.push(
                `<div class="md-code"><div class="md-code__bar"><span class="md-code__lang">${esc(lang || 'code')}</span>` +
                `<button type="button" class="md-copy" title="Copier le code">Copier</button></div>` +
                `<pre><code>${mdHighlight(body.join('\n'))}</code></pre></div>`,
            );
            continue;
        }
        const h = /^(#{1,6})\s+(.*)$/.exec(line);
        if (h) { const lvl = Math.min(h[1].length + 2, 6); out.push(`<h${lvl}>${mdInline(h[2])}</h${lvl}>`); i++; continue; }
        if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { out.push('<hr/>'); i++; continue; }
        if (/^\s*[-*]\s+/.test(line)) {
            const buf = [];
            while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { buf.push(lines[i].replace(/^\s*[-*]\s+/, '')); i++; }
            flushList(buf, 'ul'); continue;
        }
        if (/^\s*\d+\.\s+/.test(line)) {
            const buf = [];
            while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { buf.push(lines[i].replace(/^\s*\d+\.\s+/, '')); i++; }
            flushList(buf, 'ol'); continue;
        }
        if (/^\s*>\s?/.test(line)) {
            const buf = [];
            while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
            out.push(`<blockquote>${mdInline(buf.join(' '))}</blockquote>`); continue;
        }
        if (!line.trim()) { i++; continue; }
        const para = [];
        while (i < lines.length && lines[i].trim() && !/^(```|#{1,6}\s|\s*[-*]\s|\s*\d+\.\s|\s*>\s?)/.test(lines[i])) { para.push(lines[i]); i++; }
        out.push(`<p>${mdInline(para.join(' '))}</p>`);
    }
    return out.join('');
}
// Copie robuste (Electron) : Clipboard API, repli execCommand.
async function copyToClipboard(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* repli */ }
    try {
        const ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        const ok = document.execCommand('copy'); ta.remove(); return ok;
    } catch { return false; }
}
// Pose du Markdown rendu dans un conteneur + câblage des boutons « Copier ».
function renderMarkdownInto(el, src) {
    if (!el) return;
    const text = String(src || '').trim();
    if (!text) { el.innerHTML = ''; el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    el.innerHTML = mdToSafeHtml(text);
    el.querySelectorAll('.md-code').forEach((block) => {
        const btn = block.querySelector('.md-copy');
        const code = block.querySelector('code');
        if (!btn || !code) return;
        btn.onclick = async () => {
            const ok = await copyToClipboard(code.textContent || '');
            btn.textContent = ok ? 'Copié ✓' : 'Échec';
            setTimeout(() => { btn.textContent = 'Copier'; }, 1400);
        };
    });
}
// Section « Instructions / prérequis » titrée : masquée si vide, sinon libellé + rendu.
function renderInstructionsBlock(wrapperId, src) {
    const wrap = $(wrapperId);
    if (!wrap) return;
    const text = String(src || '').trim();
    if (!text) { wrap.innerHTML = ''; wrap.classList.add('hidden'); return; }
    wrap.classList.remove('hidden');
    wrap.innerHTML = '<div class="modal__seclabel">Instructions / prérequis</div><div class="md-body"></div>';
    renderMarkdownInto(wrap.querySelector('.md-body'), text);
}

// ── Joignabilité de l'API ──────────────────────────────────────────
// Un back injoignable (dev : API non démarrée) ouvrait l'app « vide » en silence :
// aucun workspace sélectionnable, aucun pack, aucune explication. On l'affiche.
let apiOffline = false;
function markApiOffline() {
    apiOffline = true;
    showToast('api-offline', {
        kind: 'error',
        title: 'Problème de connexion',
        msg: 'Impossible de joindre le serveur Hou.la. Vérifie ta connexion internet.',
        persist: true,
        action: { label: 'Réessayer', onClick: retryConnection },
    });
}
function markApiOnline() {
    dismissToast('api-offline');
    if (apiOffline) {
        apiOffline = false;
        showToast('api-online', { kind: 'ok', title: 'Connexion rétablie', msg: 'Le serveur répond à nouveau.' });
    }
}
// « Réessayer » : relance un VRAI appel à l'API (recharge workspaces + packs). Le
// résultat (joignable ou non) est signalé par l'événement api:status -> markApiOnline
// / markApiOffline mettent le toast à jour tout seuls. Ici on rend juste le clic VISIBLE
// (bouton « Connexion… » + spinner) et on ré-affiche les données si ça passe.
async function retryConnection(btn) {
    if (btn) setBtnBusy(btn, true, 'Connexion…');
    try {
        $('view-auth').classList.add('hidden');
        $('app-main').classList.remove('hidden');
        await loadWorkspaces(); // déclenche le fetch réel -> api:status bascule le toast
        await loadInstalled();
        const active = document.querySelector('.nav.active');
        switchView(active && active.dataset.view ? active.dataset.view : 'capture');
    } catch (e) {
        console.error('[retry] échec:', e);
        if (!apiOffline) markApiOffline(); // filet si l'événement de statut n'est pas venu
    } finally {
        if (btn) setBtnBusy(btn, false);
    }
}
if (api.onApiStatus) {
    api.onApiStatus((s) => {
        if (s && s.online === false) markApiOffline();
        else if (s && s.online === true) markApiOnline();
    });
}

// Codes de rejet de modération -> message lisible (au lieu de « TOO_MANY_RULES : … »).
const REJECTION_FR = {
    INVALID_MANIFEST: 'Le manifeste est invalide.',
    INVALID_TRIGGER: 'Un déclencheur est invalide.',
    INVALID_EFFECT: 'Un effet est invalide.',
    FORBIDDEN_EXECUTOR: "Un type d'effet interdit est utilisé.",
    TOO_MANY_RULES: "Trop d'interactions dans ce pack.",
    MALICIOUS_COMMAND: 'Une commande a été jugée dangereuse.',
    SSRF_HOST: 'Une URL vise une adresse interdite.',
    UNSAFE_URL_SCHEME: "Un schéma d'URL non autorisé est utilisé.",
    RCE_SUSPECTED: "Commande suspecte (exécution de code).",
    EXFILTRATION_SUSPECTED: 'Fuite de données suspectée.',
    ABUSE_SUSPECTED: 'Contenu jugé abusif.',
};
function friendlyRejection(e) {
    const raw = e && e.message != null ? String(e.message) : String(e || '');
    const found = Object.keys(REJECTION_FR).filter((c) => raw.includes(c));
    if (found.length) return found.map((c) => REJECTION_FR[c]).join(' ');
    return friendlyError(e, 'Version refusée.');
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
    rcon: { label: 'RCON (jeu)', fields: [['host', 'Adresse du serveur (ex. 127.0.0.1)', 'text'], ['port', 'Port RCON (souvent 25575 — PAS le port du jeu 25565)', 'number'], ['password', 'Mot de passe RCON (server.properties)', 'password'], ['player', 'Ton pseudo en jeu (remplace {player})', 'text']] },
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
        // Le repère d'environnement n'a de sens qu'en build DEV : un build distribué
        // est verrouillé sur la prod, on ne montre rien.
        if (!api.isDevBuild || !(await api.isDevBuild())) { $('auth-env').classList.add('hidden'); return; }
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
            await refreshAfterAccountSwitch();
        };
        menu.appendChild(item);
    });
}
// Switch de compte : PURGE les caches/états scopés à l'ancienne identité puis
// recharge tout, sinon le Store (filtre/recherche figés), les connecteurs, le
// catalogue et le Lab affichent les données du compte précédent.
async function refreshAfterAccountSwitch() {
    // 1) Réinitialise l'état du Store (un filtre « Installés » ou une recherche
    //    laissés par l'ancien compte masqueraient les bundles du nouveau).
    storeQuery = ''; storeFilter = 'all';
    const ss = $('store-search'); if (ss) ss.value = '';
    document.querySelectorAll('.store-filter .seg__btn').forEach((x) =>
        x.classList.toggle('is-active', x.dataset.storeFilter === 'all'),
    );
    mineQuery = ''; mineAll = []; const msr = $('mine-search'); if (msr) msr.value = '';
    // 2) Vide les caches renderer scopés au compte (re-remplis par les loaders).
    giftCatalog = [];
    myConnectors = [];
    labTags = [];
    // 3) Force le refetch du catalogue de cadeaux (cache main 6 h).
    try { await api.gifts.catalog(true); } catch { /* noop */ }
    // 4) Recharge les packs installés + la vue courante avec la NOUVELLE identité.
    await loadInstalled();
    const active = document.querySelector('.nav.active');
    if (active && active.dataset.view) switchView(active.dataset.view);
}
$('ws-current').onclick = () => $('ws-menu').classList.toggle('hidden');
document.addEventListener('click', (e) => {
    if (!e.target.closest('.ws-switch')) $('ws-menu').classList.add('hidden');
});

async function showApp() {
    $('view-auth').classList.add('hidden');
    $('app-main').classList.remove('hidden');
    try {
        await loadWorkspaces();
        await loadInstalled();
        switchView('capture');
    } catch (e) {
        // API injoignable au démarrage : on garde l'app ouverte mais on NE laisse PAS
        // croire que tout va bien. Le toast onApiStatus s'affiche déjà en général ; ce
        // filet le garantit même si l'événement de statut n'est pas encore arrivé.
        console.error('[showApp] chargement initial échoué:', e);
        switchView('capture');
        markApiOffline();
    }
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
        // Sélecteur d'environnement = outil de DEV uniquement. Un build distribué
        // (téléchargé) est verrouillé sur la prod : on ne l'affiche jamais.
        const devBuild = api.isDevBuild ? await api.isDevBuild() : false;
        if (devBuild && await api.isAdmin()) {
            $('env-card').classList.remove('hidden');
            $('env-select').value = (await api.env.get()) || 'prod';
        } else {
            $('env-card').classList.add('hidden');
        }
    } catch { /* noop */ }
}
document.querySelectorAll('.nav').forEach((n) => (n.onclick = () => switchView(n.dataset.view)));
// Boutons Rafraîchir (Store / Mes bundles) : re-fetch à la demande.
{ const b = $('store-refresh'); if (b) b.onclick = () => loadStore(); }
{ const b = $('mine-refresh'); if (b) b.onclick = () => loadMyBundles(); }
// Recherche + filtre du Store (retrouver ses packs parmi des milliers).
{
    const s = $('store-search');
    if (s) s.oninput = () => { storeQuery = s.value.trim(); clearTimeout(storeSearchTimer); storeSearchTimer = setTimeout(loadStore, 250); };
    document.querySelectorAll('.store-filter .seg__btn').forEach((btn) => {
        btn.onclick = () => {
            document.querySelectorAll('.store-filter .seg__btn').forEach((x) => x.classList.toggle('is-active', x === btn));
            storeFilter = btn.dataset.storeFilter;
            loadStore();
        };
    });
    // Recherche « Mes bundles » (client, débounce) : re-filtre + re-rend par chunks.
    const ms = $('mine-search');
    if (ms) ms.oninput = () => { mineQuery = ms.value.trim(); clearTimeout(mineSearchTimer); mineSearchTimer = setTimeout(renderMine, 200); };
}
// Scroll infini : quand on approche du bas de .content, charge la suite de la vue active.
function maybeLoadMore() {
    const content = document.querySelector('.content');
    if (!content) return;
    if (content.scrollTop + content.clientHeight < content.scrollHeight - 260) return;
    const active = document.querySelector('.nav.active');
    const view = active && active.dataset.view;
    if (view === 'store') loadStorePage();
    else if (view === 'mine' && mineRendered < mineFiltered.length) renderMoreMine();
}
{
    const content = document.querySelector('.content');
    if (content) content.addEventListener('scroll', maybeLoadMore, { passive: true });
}

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
    // Test dispo dès qu'un pack est actif : off-live (rejoue l'effet localement) OU
    // on-live (simule un vrai cadeau de bout en bout, une fois connecté).
    const testBtn = $('btn-test');
    testBtn.disabled = !hasPack;
    testBtn.title = engineState === 'running'
        ? 'Simule un vrai cadeau de bout en bout (en live)'
        : 'Rejoue la 1ʳᵉ interaction MAINTENANT, sans être en live';
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
$('btn-test').onclick = async () => {
    const slug = $('active-bundle').value;
    if (!slug) return;
    if (engineState === 'running') { api.engine.test(slug); return; } // on-live : cadeau simulé de bout en bout
    // Off-live : rejoue la 1re interaction du pack via le pipeline sécurisé (sans connexion).
    logLine({ allowed: true, ruleId: 'test', reason: 'Test hors live…' });
    try {
        const v = await api.engine.testInstalled(slug);
        if (v && v.ok) logLine({ allowed: true, ruleId: 'test', reason: '✓ Interaction déclenchée (hors live)' });
        else logLine({ allowed: false, ruleId: 'test', reason: '✗ ' + ((v && v.reason) || 'échec') });
    } catch (e) { logLine({ allowed: false, ruleId: 'test', reason: '✗ ' + friendlyError(e, 'test impossible') }); }
};
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
        await loadInstalled(); // rafraîchit le menu Capture
        await loadStore(); // rafraîchit l'état installé/mise à jour des cartes
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
let storeFilter = 'all'; // 'all' | 'installed'
let storeQuery = '';
let storeSearchTimer = null;
// Scroll infini du Store (« Tous ») : pages serveur via limit/offset.
const STORE_PAGE = 40;
let storeOffset = 0, storeLoading = false, storeExhausted = false, storeInstalledBy = new Map();
// Jeton de génération : toute continuation async d'un chargement PÉRIMÉ (filtre/recherche
// changés entre-temps) se voit et n'écrit ni le DOM ni l'état.
let storeGen = 0;

/** État vide riche (icône + titre + sous-texte + CTA optionnel). data-cta = classe du bouton. */
function emptyStateHtml(icon, title, sub, ctaLabel, ctaClass) {
    return `<div class="empty-state"><div class="empty-state__ic" aria-hidden="true">${icon}</div>`
        + `<div class="empty-state__title">${esc(title)}</div>`
        + `<div class="empty-state__sub">${esc(sub)}</div>`
        + (ctaLabel ? `<button class="btn btn--primary ${ctaClass}">${esc(ctaLabel)}</button>` : '')
        + '</div>';
}
// Câble les CTA des états vides (une seule fois par rendu).
function wireEmptyCtas(scope) {
    const root = scope || document;
    root.querySelectorAll('.empty-cta-lab').forEach((b) => (b.onclick = () => switchView('lab')));
    root.querySelectorAll('.empty-cta-all').forEach((b) => (b.onclick = () => {
        storeFilter = 'all'; storeQuery = '';
        const s = $('store-search'); if (s) s.value = '';
        document.querySelectorAll('.store-filter .seg__btn').forEach((x) => x.classList.toggle('is-active', x.dataset.storeFilter === 'all'));
        loadStore();
    }));
}

/** Une carte de pack (Store ou vue Installés). `inst` = entrée installée (ou undefined). */
// ── Chargement (spinner centré / squelettes) — voir styles.css .loading/.skeleton-* ──
function loadingHtml(text) {
    return `<div class="loading"><span class="spinner"></span><span>${esc(text || 'Chargement…')}</span></div>`;
}
function skeletonCardsHtml(n) {
    const one = '<div class="skeleton-card" aria-hidden="true"><div class="skeleton-card__banner"></div>'
        + '<div class="skeleton-card__body"><div class="skeleton-line sk-60"></div>'
        + '<div class="skeleton-line sk-40"></div><div class="skeleton-line sk-80"></div></div></div>';
    return one.repeat(Math.max(1, n || 6));
}
function skeletonRowsHtml(n) {
    return '<div class="skeleton-row" aria-hidden="true"></div>'.repeat(Math.max(1, n || 5));
}

function buildStoreCard(b, inst) {
    const updateAvail = !!inst && !!b.version && !!inst.version && inst.version !== b.version;
    const card = document.createElement('div');
    card.className = 'bundle-card';
    const banner = b.bannerUrl ? ` style="background-image:url('${esc(b.bannerUrl)}')"` : '';
    const installBtn = !inst
        ? `<button class="btn btn--primary install">Installer</button>`
        : updateAvail
            ? `<button class="btn btn--primary install" title="Une nouvelle version est disponible">Mettre à jour → v${esc(b.version)}</button>`
            : `<button class="btn btn--ghost install" disabled>Installé ✓${inst.version ? ' · v' + esc(inst.version) : ''}</button>`;
    const customizeBtn = inst ? `<button class="btn btn--ghost customize">Personnaliser</button>` : '';
    const uninstallBtn = inst ? `<button class="btn btn--ghost uninstall" title="Retirer ce pack de tes packs installés (réversible)">Désinstaller</button>` : '';
    card.innerHTML = `
        <div class="bundle-card__banner"${banner}></div>
        <div class="bundle-card__body">
            <h3>${esc(b.title || b.slug)}</h3>
            <div class="publisher">${publisherHtml(b.publisher, b.installCount)}</div>
            <div class="muted small">${b.version ? `v${esc(b.version)}${b.versionDate ? ' · ' + esc(fmtDate(b.versionDate)) : ''}` : '&nbsp;'}</div>
            <div class="row gap wrap card-actions">
                ${installBtn}
                ${customizeBtn}
                <button class="btn btn--ghost more">Voir plus</button>
                ${uninstallBtn}
            </div>
        </div>`;
    if (!inst || updateAvail) card.querySelector('.install').onclick = (e) => installBundle(b.slug, e.target);
    if (inst) { const cb = card.querySelector('.customize'); if (cb) cb.onclick = () => openCustomize(b.slug, b.title || b.slug); }
    card.querySelector('.more').onclick = () => openModal(b, !!inst);
    if (inst) {
        const ub = card.querySelector('.uninstall');
        // Deux temps (« Désinstaller » -> « Confirmer ? ») : évite un retrait accidentel, sans modale.
        if (ub) ub.onclick = async () => {
            if (ub.dataset.armed !== '1') {
                ub.dataset.armed = '1'; ub.textContent = 'Confirmer ?'; ub.classList.add('is-confirm');
                setTimeout(() => { if (ub.isConnected && ub.dataset.armed === '1') { ub.dataset.armed = ''; ub.textContent = 'Désinstaller'; ub.classList.remove('is-confirm'); } }, 3000);
                return;
            }
            ub.disabled = true; ub.textContent = '…';
            try {
                await api.store.uninstall(b.slug);
                showToast('uninstall', { kind: 'ok', title: 'Pack désinstallé', msg: `${b.title || b.slug} a été retiré.` });
                await loadInstalled(); // rafraîchit le menu Capture
                await loadStore();     // la carte repasse à « Installer »
            } catch (e) {
                ub.disabled = false; ub.dataset.armed = ''; ub.textContent = 'Désinstaller'; ub.classList.remove('is-confirm');
                showToast('uninstall', { kind: 'error', title: 'Désinstallation échouée', msg: friendlyError(e, 'Réessaie dans un instant.') });
            }
        };
    }
    return card;
}

async function loadStore() {
    const gen = ++storeGen; // invalide tout chargement précédent en vol
    const el = $('store-list');
    storeOffset = 0; storeLoading = false; storeExhausted = false;
    el.innerHTML = skeletonCardsHtml(8); $('store-more').textContent = ''; // squelettes le temps du fetch
    storeInstalledBy = new Map(((await api.store.installed()) || []).map((b) => [b.slug, b]));
    if (gen !== storeGen) return; // périmé pendant l'await
    if (storeFilter === 'installed') return renderInstalledStore(gen);
    // Vue « Tous » : recherche + scroll infini SERVEUR (limit/offset).
    await loadStorePage(gen);
    if (gen !== storeGen) return;
    if (!el.children.length) {
        el.innerHTML = storeQuery
            ? emptyStateHtml('🔎', 'Aucun résultat', `Aucun pack public ne correspond à « ${storeQuery} ».`, null)
            : emptyStateHtml('📦', 'Le store est encore vide', 'Aucun pack public pour l\'instant. Reviens bientôt, ou crée le tien dans le Lab.', 'Ouvrir le Lab', 'empty-cta-lab');
        wireEmptyCtas(el);
    }
}
async function loadStorePage(gen) {
    if (gen === undefined) gen = storeGen; // appel depuis le scroll = génération courante
    if (storeLoading || storeExhausted || storeFilter !== 'all' || gen !== storeGen) return;
    storeLoading = true;
    const el = $('store-list'); const more = $('store-more');
    if (storeOffset > 0) more.textContent = 'Chargement…';
    let items = [];
    try {
        const q = { limit: String(STORE_PAGE), offset: String(storeOffset) };
        if (storeQuery) q.q = storeQuery;
        items = (await api.store.list(q)) || [];
    } catch { items = []; }
    // Périmé (un nouveau loadStore a démarré pendant la requête) : on jette CE résultat
    // sans toucher au DOM ni à l'offset — le chargement courant gère storeLoading.
    if (gen !== storeGen) return;
    if (storeOffset === 0) el.innerHTML = ''; // 1re page : on retire les squelettes avant d'insérer
    items.forEach((b) => el.appendChild(buildStoreCard(b, storeInstalledBy.get(b.slug))));
    storeOffset += items.length;
    if (items.length < STORE_PAGE) storeExhausted = true;
    more.textContent = '';
    storeLoading = false;
    // La 1re page ne remplit pas l'écran mais il reste des packs -> charge la suite.
    if (!storeExhausted) maybeLoadMore();
}
/** Vue « Installés » : packs locaux enrichis par aperçu (best-effort), sans paging. */
async function renderInstalledStore(gen) {
    const el = $('store-list');
    el.innerHTML = skeletonCardsHtml(6);
    const installed = [...storeInstalledBy.values()];
    let items = await Promise.all(installed.map(async (i) => {
        try { const p = await api.store.preview(i.slug); return (p && p.bundle) || { slug: i.slug }; }
        catch { return { slug: i.slug }; }
    }));
    if (gen !== storeGen) return; // filtre/recherche changés pendant les aperçus -> on abandonne
    const q = storeQuery.toLowerCase();
    if (q) items = items.filter((b) => `${b.title || ''} ${b.slug || ''}`.toLowerCase().includes(q));
    storeExhausted = true;
    el.innerHTML = '';
    if (!items.length) {
        el.innerHTML = storeQuery
            ? emptyStateHtml('🔎', 'Aucun résultat', 'Aucun pack installé ne correspond à ta recherche.', null)
            : emptyStateHtml('🧩', 'Aucun pack installé', 'Installe un pack depuis « Tous » pour le personnaliser et le piloter en live.', 'Voir tous les packs', 'empty-cta-all');
        wireEmptyCtas(el);
        return;
    }
    items.forEach((b) => el.appendChild(buildStoreCard(b, storeInstalledBy.get(b.slug))));
}

// ── Modal détail ──
function openModal(b, isInstalled) {
    $('modal-banner').style.backgroundImage = b.bannerUrl ? `url('${b.bannerUrl}')` : '';
    $('modal-title').textContent = b.title || b.slug;
    $('modal-publisher').innerHTML = publisherHtml(b.publisher, b.installCount);
    $('modal-desc').textContent = b.description || 'Aucune description.';
    $('modal-version').textContent = b.version ? `Version ${b.version}${b.versionDate ? ' · ' + fmtDate(b.versionDate) : ''}` : '';
    $('modal-fee').textContent = b.creatorFeePercent > 0
        ? `Ce pack reverse ${b.creatorFeePercent}% des étoiles au créateur (prélevé sur tes gains, le viewer paie pareil).`
        : '';
    $('modal-changelog').textContent = b.changelog || '';
    $('modal-changelog-wrap').classList.toggle('hidden', !(b.changelog && b.changelog.trim()));
    $('modal-caps').innerHTML = '';
    // Instructions / prérequis (Markdown) : rendu immédiat depuis l'item de liste,
    // puis rafraîchi depuis l'aperçu (source autoritaire).
    renderInstructionsBlock('modal-instructions', b.instructions);
    api.store
        .preview(b.slug)
        .then((p) => {
            const caps = (p && p.capabilities) || [];
            $('modal-caps').innerHTML = caps.map((c) => `<span class="chip">${esc(c)}</span>`).join('');
            renderInstructionsBlock('modal-instructions', p && p.bundle && p.bundle.instructions);
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
    cancelTestCountdown(); // on va vider la liste des règles (rows détachées)
    $('cx-title').textContent = title || slug;
    $('cx-msg').textContent = '';
    $('cx-modal').dataset.slug = slug;
    const box = $('cx-rules');
    box.innerHTML = skeletonRowsHtml(6);
    $('cx-modal').classList.remove('hidden');
    let data;
    try { data = await api.customize.get(slug); }
    catch (e) { box.innerHTML = `<p class="no">${esc(friendlyError(e, 'Pack indisponible.'))}</p>`; return; }
    // Instructions / prérequis du créateur (Markdown) — visibles sur un pack installé.
    renderInstructionsBlock('cx-instructions', data && data.instructions);
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
            + `<label class="cx-cd muted" title="Temps minimum entre deux déclenchements">cooldown ms <input type="number" min="0" class="cx-cd-in" placeholder="${Number(r.defaultCooldownMs) || 0}" value="${r.cooldownMs != null ? r.cooldownMs : ''}"/></label>`
            + `<span class="cx-test-res"></span>`
            + `<button class="btn btn--ghost cx-test" title="Tester cette interaction MAINTENANT, sans être en live">&#9654; Tester</button>`;
        // Test OFF-LIVE : rejoue l'effet du manifeste signé via le pipeline sécurisé.
        row.querySelector('.cx-test').onclick = (ev) => {
            runEffectTest({
                resEl: row.querySelector('.cx-test-res'),
                cls: 'cx-test-res',
                needsFocus: effectNeedsFocus(r.effectType),
                btn: ev.currentTarget,
                fire: () => api.engine.testInstalled(slug, r.id),
            });
        };
        box.appendChild(row);
    });
}
const cxCloseModal = () => { cancelTestCountdown(); $('cx-modal').classList.add('hidden'); };
$('cx-close').onclick = cxCloseModal;
$('cx-modal').onclick = (e) => { if (e.target.id === 'cx-modal') cxCloseModal(); };
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

// ── Stats créateur d'un pack (revenus + graphe) ──
async function openStats(slug, title) {
    $('stats-title').textContent = title || slug;
    $('stats-totals').innerHTML = loadingHtml('Chargement des stats…');
    $('stats-graph').innerHTML = '';
    $('stats-top').innerHTML = '';
    $('stats-modal').classList.remove('hidden');
    let s;
    try { s = await api.lab.stats(slug); }
    catch (e) { $('stats-totals').innerHTML = `<p class="no">${esc(friendlyError(e, 'Stats indisponibles.'))}</p>`; return; }
    if (!s) { $('stats-totals').innerHTML = '<p class="muted">Aucune donnée pour l\'instant.</p>'; return; }
    $('stats-totals').innerHTML =
        `<div class="stat"><b>${Number(s.installCount || 0)}</b><span>installs</span></div>`
        + `<div class="stat"><b>${Number(s.totalEffects || 0)}</b><span>effets déclenchés</span></div>`
        + `<div class="stat"><b>${Number(s.totalStars || 0)} ⭐</b><span>étoiles générées</span></div>`
        + `<div class="stat"><b>${Number(s.totalCreatorStars || 0)} ⭐</b><span>étoiles gagnées (ta commission)</span></div>`;
    $('stats-graph').innerHTML = statsGraphSvg(s.daily || []);
    // Top streamers qui rapportent le plus à ce pack.
    try { $('stats-top').innerHTML = topBroadcastersHtml(await api.lab.topBroadcasters(slug)); }
    catch { $('stats-top').innerHTML = ''; }
}
// Liste « Top streamers » d'un pack (triée par étoiles gagnées = commission).
function topBroadcastersHtml(list) {
    if (!Array.isArray(list) || !list.length) {
        return '<div class="stats-top"><div class="stats-top__h">Top streamers</div><p class="muted small">Personne n\'a encore utilisé ce pack en live.</p></div>';
    }
    const max = Math.max(1, ...list.map((b) => Number(b.creatorStars || 0)));
    const rows = list.slice(0, 10).map((b, i) => {
        const gained = Number(b.creatorStars || 0);
        const gen = Number(b.stars || 0);
        const w = Math.round((gained / max) * 100);
        const name = b.slug
            ? `<a href="#" class="creator-link" data-slug="${esc(b.slug)}">${esc(b.name || b.slug)}</a>`
            : esc(b.name || 'Streamer');
        const av = b.avatarUrl ? `<span class="av" style="background-image:url('${esc(b.avatarUrl)}')"></span>` : '<span class="av av--ph">🎥</span>';
        return `<div class="stats-top__row"><span class="stats-top__rank">${i + 1}</span>${av}
            <span class="stats-top__name">${name}</span>
            <span class="stats-top__bar"><span style="width:${w}%"></span></span>
            <span class="stats-top__val"><b>${gained}</b>&nbsp;⭐ gagnées <span class="muted">· ${gen} générées</span></span></div>`;
    }).join('');
    return `<div class="stats-top"><div class="stats-top__h">Top streamers — qui te rapporte le plus</div>${rows}</div>`;
}
$('stats-close').onclick = () => $('stats-modal').classList.add('hidden');
$('stats-modal').onclick = (e) => { if (e.target.id === 'stats-modal') $('stats-modal').classList.add('hidden'); };
// Graphe en barres (hauteur = valeur, pas de code couleur -> lisible daltonien) + info-bulle.
function statsGraphSvg(daily) {
    if (!daily.length) return '<p class="muted small">Pas encore d\'activité. Envoie des cadeaux interactifs pendant un live pour remplir ce graphe.</p>';
    const W = 560, H = 170, pad = 26;
    const max = Math.max(1, ...daily.map((d) => Number(d.stars || 0)));
    const bw = (W - pad * 2) / daily.length;
    const bars = daily.map((d, i) => {
        const v = Number(d.stars || 0);
        const h = Math.round((v / max) * (H - pad * 2));
        const x = pad + i * bw;
        const y = H - pad - h;
        return `<rect x="${(x + 1).toFixed(1)}" y="${y}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${h}" rx="2" fill="var(--accent)"><title>${esc(d.date)} : ${v} ⭐ générées · ${Number(d.creatorStars || 0)} ⭐ gagnées</title></rect>`;
    }).join('');
    return `<svg viewBox="0 0 ${W} ${H}" class="stats-svg" role="img" aria-label="coins générés par jour">
        <line x1="${pad}" y1="${H - pad}" x2="${W - pad}" y2="${H - pad}" stroke="var(--border)"/>
        <text x="${pad}" y="14" class="stats-axis">${max} coins/jour (max) — survole une barre pour le détail</text>
        ${bars}
    </svg>`;
}

// ── Lab : éditeur visuel (QUAND … ALORS …) ──
const EVENTS = [['gift', 'Cadeau'], ['gift-custom', 'Cadeau personnalisé'], ['follow', 'Nouvel abonné'], ['comment', 'Message chat'], ['hearts', 'Likes'], ['share', 'Partage'], ['viewer', 'Spectateurs']];
const EXECS = [['keyboard', 'Clavier'], ['gamepad', 'Manette'], ['rcon', 'RCON'], ['obs', 'OBS'], ['http', 'HTTP'], ['mqtt', 'MQTT'], ['osc', 'OSC'], ['ws', 'WebSocket']];
const ROLES = [['all', 'Tout le monde'], ['followers', 'Abonnés'], ['moderators', 'Modérateurs']];
const GP_BUTTONS = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'START', 'BACK', 'LS', 'RS'];
// Libellés HUMAINS (Xbox + équivalent Switch/PlayStation courant) — Flicky : « LT c'est ZL,
// RS c'est le clic du stick droit ». Le token stocké reste l'énum manette (A/LT/RS…).
const GP_LABEL = {
    A: 'A (bas)', B: 'B (droite)', X: 'X (gauche)', Y: 'Y (haut)',
    LB: 'LB · L', RB: 'RB · R', LT: 'LT · ZL (gâchette G)', RT: 'RT · ZR (gâchette D)',
    UP: 'Croix ↑', DOWN: 'Croix ↓', LEFT: 'Croix ←', RIGHT: 'Croix →',
    START: 'Start · +', BACK: 'Select · −', LS: 'L3 (clic stick G)', RS: 'R3 (clic stick D)',
};
const gpLabel = (t) => GP_LABEL[t] || t;
// Résumé humain court d'un effet manette (affiché dans la ligne d'interaction).
function gpSummary(e) {
    if (e.analog) {
        const a = e.analog; const parts = [];
        if (a.lx != null || a.ly != null) parts.push(`stick G(${a.lx ?? 0},${a.ly ?? 0})`);
        if (a.rx != null || a.ry != null) parts.push(`stick D(${a.rx ?? 0},${a.ry ?? 0})`);
        if (a.lt != null) parts.push(`ZL ${Math.round((a.lt) * 100)}%`);
        if (a.rt != null) parts.push(`ZR ${Math.round((a.rt) * 100)}%`);
        return 'Analogique : ' + (parts.join(' · ') || '—');
    }
    if (e.steps && e.steps.length) {
        return 'Chronologie : ' + e.steps.map((s) => {
            const btns = (s.buttons && s.buttons.length ? s.buttons : (s.button ? [s.button] : [])).map(gpLabelShort).join('+');
            return (btns || '⏸') + (s.waitMs ? ` ⏱${s.waitMs}ms` : '');
        }).join(' → ');
    }
    if (e.buttons && e.buttons.length) return 'Combo : ' + e.buttons.map(gpLabelShort).join(' + ');
    const parts = [];
    if (e.button) parts.push(gpLabelShort(e.button));
    for (const b of e.sequence || []) parts.push(gpLabelShort(b));
    if (e.randomFrom && e.randomFrom.length) parts.push('aléa(' + e.randomFrom.map(gpLabelShort).join('/') + ')');
    let s = parts.join(' → ');
    if (e.repeat && e.repeat > 1) s += ` ×${e.repeat}`;
    return s || '—';
}
// Libellé court (juste l'équivalent Switch quand il existe) pour les résumés compacts.
const GP_SHORT = { LT: 'ZL', RT: 'ZR', LB: 'L', RB: 'R', LS: 'L3', RS: 'R3', START: '+', BACK: '−', UP: '↑', DOWN: '↓', LEFT: '←', RIGHT: '→' };
const gpLabelShort = (t) => GP_SHORT[t] || t;
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
// Couleur de rareté par défaut d'un slot (bordure/halo si le créateur ne choisit
// pas de couleur). Paliers par prix croissant — variés en TEINTE *et* en clarté
// (le propriétaire est daltonien : la rareté reste lisible par la luminosité + le
// prix affiché à côté, jamais par la seule teinte).
function slotRarityHex(slug) {
    const n = parseInt(String(slug || '').replace('ix_slot_', ''), 10) || 1;
    if (n <= 6) return '#9aa4b2';   //  commun    — gris clair
    if (n <= 12) return '#46c37b';  //  peu commun — vert
    if (n <= 18) return '#3d8bff';  //  rare       — bleu
    if (n <= 24) return '#a855f7';  //  épique     — violet
    return '#f5a623';               //  légendaire — or (le plus lumineux)
}
function eventFieldHtml(r) {
    if (r.event.type === 'gift') return `<select class="r-giftslug">${giftOptionsGeneric(r.event.giftSlug)}</select>`;
    if (r.event.type === 'gift-custom') {
        const src = r.event.iconUrl || r.event._iconPreview;
        const accent = r.event.accentColor || slotRarityHex(r.event.giftSlug);
        const hasAccent = !!r.event.accentColor;
        // Aperçu : la vignette porte déjà le halo (auto par rareté, ou choisi).
        const ic = (src ? `background-image:url('${esc(src)}');` : '')
            + `box-shadow:0 0 0 2px ${esc(accent)}, 0 0 8px ${esc(accent)};`;
        return `<input type="text" class="r-name" placeholder="Nom du cadeau (ex. Torches)" value="${esc(r.label || '')}" title="Nom affiché au viewer" />`
            + `<select class="r-giftslug">${slotOptions(r.event.giftSlug)}</select>`
            + `<span class="r-icon" title="icône du cadeau" style="${ic}"></span>`
            + `<button type="button" class="r-iconbtn">Icône…</button>`
            + `<button type="button" class="r-iconguide" title="Comment réaliser l'icône ?">i</button>`
            + `<label class="r-accent-wrap" title="Bordure colorée du cadeau (halo). Décochée = auto selon la rareté (le prix).">`
            + `<input type="checkbox" class="r-accent-on"${hasAccent ? ' checked' : ''}> bordure`
            + `<input type="color" class="r-accent" value="${esc(accent)}"></label>`;
    }
    if (r.event.type === 'comment') {
        const mode = r.event._cmode || (r.event.every != null ? 'every' : 'contains');
        return `<select class="r-cmode" title="Déclencher sur un mot-clé, ou toutes les N messages"><option value="contains"${mode === 'contains' ? ' selected' : ''}>contient le mot</option><option value="every"${mode === 'every' ? ' selected' : ''}>tous les N messages</option></select>`
            + (mode === 'every'
                ? `<input type="number" class="r-every" min="1" placeholder="tous les N (ex. 100)" />`
                : `<input type="text" class="r-contains" placeholder="contient ce mot…" />`);
    }
    if (r.event.type === 'hearts') {
        const mode = r.event._hmode || (r.event.every != null ? 'every' : 'milestone');
        return `<select class="r-hmode" title="Un palier atteint une fois, ou toutes les N likes"><option value="milestone"${mode === 'milestone' ? ' selected' : ''}>palier atteint</option><option value="every"${mode === 'every' ? ' selected' : ''}>tous les N likes</option></select>`
            + (mode === 'every'
                ? `<input type="number" class="r-every" min="1" placeholder="tous les N (ex. 100)" />`
                : `<input type="number" class="r-milestone" min="1" placeholder="palier (ex. 100)" />`);
    }
    if (r.event.type === 'share') return `<input type="number" class="r-every" min="1" placeholder="tous les N partages (vide = chaque partage)" />`;
    if (r.event.type === 'viewer') return `<input type="number" class="r-every" min="1" placeholder="tous les N nouveaux spectateurs (ex. 100)" />`;
    return '';
}
function execFieldHtml(r) {
    switch (r.effect.type) {
        case 'keyboard': return `<input type="text" class="r-keys" placeholder="touche (ex. e, space, up)…" title="Astuce : + = touches ENSEMBLE · virgule = à la suite · :ms = maintenir. Ou clique « Action avancée » pour enregistrer une suite." /><button type="button" class="r-kb-edit btn btn--ghost btn--mini" title="Options avancées : enregistrer une suite de touches, un combo, régler le rythme et le maintien">⚙</button><select class="r-backend"><option value="auto">clavier normal</option><option value="interception">bas niveau (pilote)</option></select>`;
        case 'gamepad': {
            const adv = (r.effect.buttons && r.effect.buttons.length) ||
                (r.effect.sequence && r.effect.sequence.length) ||
                (r.effect.randomFrom && r.effect.randomFrom.length) ||
                (r.effect.steps && r.effect.steps.length) || r.effect.analog;
            if (adv) {
                // Action manette avancée : résumé humain + bouton pour rouvrir l'éditeur.
                return `<span class="r-combo" title="Action manette avancée">🎮 ${esc(gpSummary(r.effect))}</span>` +
                    `<button type="button" class="r-gp-edit btn btn--ghost btn--mini" title="Modifier l'action avancée : combo, séquence, chronologie, analogique, répétition">⚙</button>`;
            }
            // Cas simple : bouton unique (libellés humains) + capturer + options avancées.
            return `<select class="r-button" title="Bouton manette">${GP_BUTTONS.map((b) => `<option value="${b}">${esc(gpLabel(b))}</option>`).join('')}</select>` +
                `<button type="button" class="r-gp-cap btn btn--ghost btn--mini" title="Capturer un bouton depuis ta manette">Capturer</button>` +
                `<button type="button" class="r-gp-edit btn btn--ghost btn--mini" title="Options avancées : combo, séquence, chronologie, analogique, répétition">⚙</button>`;
        }
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
    if (r.event.type === 'gift-custom') {
        // Nom affiché au viewer (le label de la règle). Sans ça -> « Interactif N ».
        if (q('.r-name')) r.label = q('.r-name').value;
        // Bordure : cochée = couleur explicite (override), décochée = auto (rareté) => undefined.
        const on = q('.r-accent-on');
        r.event.accentColor = (on && on.checked && q('.r-accent')) ? q('.r-accent').value : undefined;
    }
    if (r.event.type === 'comment') {
        // NON destructif : le mode décide ce qui part (buildRule), on garde les deux
        // saisies en mémoire pour ne rien perdre en basculant contient <-> tous les N.
        const cmode = q('.r-cmode') ? q('.r-cmode').value : (r.event._cmode || (r.event.every != null ? 'every' : 'contains'));
        r.event._cmode = cmode;
        if (cmode === 'every') { if (q('.r-every')) r.event.every = Number(q('.r-every').value) || undefined; }
        else if (q('.r-contains')) r.event.contains = q('.r-contains').value;
    }
    if (r.event.type === 'hearts') {
        const hmode = q('.r-hmode') ? q('.r-hmode').value : (r.event._hmode || (r.event.every != null ? 'every' : 'milestone'));
        r.event._hmode = hmode;
        if (hmode === 'every') { if (q('.r-every')) r.event.every = Number(q('.r-every').value) || undefined; }
        else if (q('.r-milestone')) r.event.milestone = Number(q('.r-milestone').value) || undefined;
    }
    if (r.event.type === 'share' || r.event.type === 'viewer') {
        const v = q('.r-every') ? Number(q('.r-every').value) : NaN;
        r.event.every = Number.isFinite(v) && v >= 1 ? v : undefined;
    }
    if (r.effect.type === 'keyboard') { r.effect.keys = q('.r-keys') ? q('.r-keys').value : ''; r.effect.backend = q('.r-backend') ? q('.r-backend').value : 'auto'; }
    // Ne touche button QUE si le sélecteur simple est présent (un combo n'en a pas
    // -> on préserve sequence/randomFrom/gapMs déjà sur r.effect).
    if (r.effect.type === 'gamepad' && q('.r-button')) r.effect.button = q('.r-button').value;
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
    cancelTestCountdown(); // un décompte en cours pointe une ligne qu'on va détacher
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
        if (q('.r-every')) q('.r-every').value = r.event.every || '';
        // Bascule du mode (contient/tous les N, palier/tous les N) : re-render pour
        // échanger le champ affiché, après avoir lu la saisie courante.
        if (q('.r-cmode')) q('.r-cmode').onchange = () => { readRule(el, r); renderRules(); };
        if (q('.r-hmode')) q('.r-hmode').onchange = () => { readRule(el, r); renderRules(); };
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
        // Capturer un bouton depuis la VRAIE manette branchée (auto-sélection).
        if (q('.r-gp-cap')) q('.r-gp-cap').onclick = async (ev) => {
            const b = ev.currentTarget; const old = b.textContent; b.textContent = 'Appuie…'; b.disabled = true;
            const tok = await captureGamepadToken(4000);
            b.textContent = old; b.disabled = false;
            if (tok && q('.r-button')) { q('.r-button').value = tok; readRule(el, r); }
            else if (!tok) $('lab-msg2').textContent = 'Aucun bouton détecté (manette branchée + appuie pendant la capture).';
        };
        // Éditeur avancé manette : combo, séquence, chronologie, analogique, répétition.
        if (q('.r-gp-edit')) q('.r-gp-edit').onclick = () => {
            readRule(el, r);
            openGamepadEditor(r.effect, (built) => { r.effect = { type: 'gamepad', ...built }; renderRules(); });
        };
        // Capturer une touche depuis le clavier (auto-sélection).
        if (q('.r-kb-cap')) q('.r-kb-cap').onclick = async (ev) => {
            const b = ev.currentTarget; const old = b.textContent; b.textContent = 'Appuie…'; b.disabled = true;
            // Capture un COMBO (plusieurs touches ensemble). Une seule touche = combo d'un.
            const spec = await captureKeyboardChord(6000);
            b.textContent = old; b.disabled = false;
            if (spec && q('.r-keys')) { q('.r-keys').value = spec; readRule(el, r); }
        };
        // Éditeur clavier visuel (touche / combo / suite + rythme).
        if (q('.r-kb-edit')) q('.r-kb-edit').onclick = () => {
            readRule(el, r);
            openKeyboardEditor(r.effect, (built) => { r.effect = { type: 'keyboard', ...built }; renderRules(); });
        };
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
        // Bordure colorée : aperçu du halo en direct (case à cocher + sélecteur).
        if (r.event.type === 'gift-custom') {
            const ico = q('.r-icon'), onbox = q('.r-accent-on'), col = q('.r-accent');
            const applyAccent = () => {
                const c = (onbox && onbox.checked && col) ? col.value : slotRarityHex(r.event.giftSlug);
                if (ico) ico.style.boxShadow = `0 0 0 2px ${c}, 0 0 8px ${c}`;
            };
            if (onbox) onbox.addEventListener('change', () => { readRule(el, r); applyAccent(); });
            if (col) col.addEventListener('input', () => { if (onbox) onbox.checked = true; readRule(el, r); applyAccent(); });
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
        q('.r-test').onclick = (ev) => {
            readRule(el, r); // synchronise la saisie DOM -> objet règle
            const rule = buildRule(r, i);
            runEffectTest({
                resEl: q('.rule__result'),
                cls: 'rule__result',
                needsFocus: effectNeedsFocus(rule.effect && rule.effect.type),
                btn: ev.currentTarget,
                fire: () => api.engine.testRule(rule, labCurrentSlug),
            });
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
    if (r.event.type === 'gift-custom' && r.event.accentColor) on.accentColor = r.event.accentColor;
    // Le MODE choisi (et non la simple présence d'un champ) décide ce qui part :
    // les deux saisies (contient/tous les N, palier/tous les N) coexistent en mémoire.
    if (r.event.type === 'comment') {
        const cm = r.event._cmode || (r.event.every != null ? 'every' : 'contains');
        if (cm === 'every') { if (r.event.every != null) on.every = r.event.every; }
        else if (r.event.contains) on.contains = r.event.contains;
    }
    if (r.event.type === 'hearts') {
        const hm = r.event._hmode || (r.event.every != null ? 'every' : 'milestone');
        if (hm === 'every') { if (r.event.every != null) on.every = r.event.every; }
        else if (r.event.milestone != null) on.milestone = r.event.milestone;
    }
    if (r.event.type === 'share' && r.event.every != null) on.every = r.event.every;
    if (r.event.type === 'viewer' && r.event.every != null) on.every = r.event.every;
    const effect = { type: r.effect.type };
    if (r.effect.type === 'keyboard') { effect.keys = r.effect.keys; if (r.effect.backend && r.effect.backend !== 'auto') effect.backend = r.effect.backend; if (typeof r.effect.gapMs === 'number') effect.gapMs = r.effect.gapMs; }
    if (r.effect.type === 'gamepad') {
        const g = r.effect;
        if (g.analog && Object.keys(g.analog).length) {
            effect.analog = g.analog;
        } else if (Array.isArray(g.steps) && g.steps.length) {
            effect.steps = g.steps;
        } else {
            if (Array.isArray(g.buttons) && g.buttons.length) effect.buttons = g.buttons;
            else if (g.button) effect.button = g.button;
            if (Array.isArray(g.sequence) && g.sequence.length) effect.sequence = g.sequence;
            if (Array.isArray(g.randomFrom) && g.randomFrom.length) effect.randomFrom = g.randomFrom;
            if (typeof g.gapMs === 'number') effect.gapMs = g.gapMs;
        }
        if (typeof g.holdMs === 'number') effect.holdMs = g.holdMs;
        if (typeof g.repeat === 'number' && g.repeat > 1) effect.repeat = g.repeat;
        if (typeof g.repeatGapMs === 'number' && g.repeatGapMs > 0) effect.repeatGapMs = g.repeatGapMs;
        // Filet : basculer en « Manette » sans toucher au sélecteur laisse le bouton A
        // affiché mais non écrit dans le modèle -> effet vide refusé par le validateur.
        // On garantit une action valide (le bouton A visible par défaut).
        if (!effect.button && !effect.buttons && !effect.sequence && !effect.randomFrom && !effect.steps && !effect.analog) {
            effect.button = 'A';
        }
    }
    if (r.effect.type === 'rcon') effect.command = r.effect.command;
    if (r.effect.type === 'obs') effect.request = r.effect.request;
    if (r.effect.type === 'http') { effect.method = r.effect.method; if (r.effect.path) effect.path = r.effect.path; }
    if (r.effect.type === 'mqtt') { effect.topic = r.effect.topic; effect.payload = r.effect.payload || ''; }
    if (r.effect.type === 'osc') { effect.address = r.effect.address; if (r.effect.args && r.effect.args.length) effect.args = r.effect.args; }
    if (r.effect.type === 'ws') { effect.message = r.effect.message || ''; }
    // Rôle de connecteur (protocoles réseau) : l'endpoint est lié à l'installation.
    if (CONNECTOR_PROTOCOLS.includes(r.effect.type) && r.effect.connector) effect.connector = r.effect.connector;
    const rule = { id: 'r' + (i + 1), on, effect };
    // Nom du cadeau affiché au viewer (sinon le nom générique du slot « Interactif N »).
    const lbl = (r.label || '').trim();
    if (lbl) rule.label = lbl;
    if (r.followersOnly) rule.followersOnly = true;
    if (r.moderatorsOnly) rule.moderatorsOnly = true;
    return rule;
}
function buildManifest() {
    return { schema: 2, rules: labRules.map((r, i) => buildRule(r, i)) };
}
// validateManifestClient / manifestToRules / canonicalize vivent dans le module PARTAGÉ
// et TESTÉ src/renderer/manifest-lib.js (chargé avant renderer.js). On les alias ici pour
// que le renderer et les tests exécutent EXACTEMENT le même code.
const validateManifestClient = HoulaManifest.validateManifestClient;
// Le slug existe déjà, m'appartient, et n'a AUCUNE version (orphelin d'une création
// ratée) ? -> on peut y rattacher la version au lieu d'échouer sur « slug déjà pris ».
async function isMyOrphanSlug(slug) {
    try { const d = await api.lab.detail(slug); return !!d && (!d.versions || d.versions.length === 0); }
    catch { return false; } // pas à moi / introuvable
}
const manifestToRules = HoulaManifest.manifestToRules; // module partagé testé (voir ci-dessus)
function bumpVersion(v, type) {
    if (!v) return '1.0.0';
    const [maj, min, pat] = v.split('.').map(Number);
    if (type === 'major') return `${maj + 1}.0.0`;
    if (type === 'minor') return `${maj}.${min + 1}.0`;
    return `${maj}.${min}.${pat + 1}`;
}

// ══════════════ AUTO-CAPTURE (manette + clavier) ══════════════
// Lit l'entrée PHYSIQUE branchée sur ce PC pour auto-sélectionner un bouton/une
// touche (retour de Flicky : « on appuie, ça se sélectionne tout seul »). Lecture
// SEULE (API Gamepad du renderer / keydown) : aucun pilotage, aucun sidecar.
const GP_STD_INDEX = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'BACK', 'START', 'LS', 'RS', 'UP', 'DOWN', 'LEFT', 'RIGHT'];
function captureGamepadToken(timeoutMs = 4000) {
    return new Promise((resolve) => {
        if (!navigator.getGamepads) { resolve(null); return; }
        const start = performance.now();
        let raf = 0;
        const scan = () => {
            const pads = navigator.getGamepads();
            for (const p of pads) {
                if (!p || !p.buttons) continue;
                for (let i = 0; i < p.buttons.length && i < GP_STD_INDEX.length; i++) {
                    const btn = p.buttons[i];
                    const pressed = typeof btn === 'object' ? (btn.pressed || btn.value > 0.5) : btn > 0.5;
                    if (pressed) { cancelAnimationFrame(raf); resolve(GP_STD_INDEX[i]); return; }
                }
            }
            if (performance.now() - start > timeoutMs) { resolve(null); return; }
            raf = requestAnimationFrame(scan);
        };
        raf = requestAnimationFrame(scan);
    });
}
function captureKeyboardSpec(timeoutMs = 4000) {
    return new Promise((resolve) => {
        let done = false;
        const finish = (spec) => {
            if (done) return; done = true;
            clearTimeout(to);
            window.removeEventListener('keydown', onKey, true);
            resolve(spec);
        };
        const onKey = (e) => {
            if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return; // attend une vraie touche
            e.preventDefault();
            const mods = [];
            if (e.ctrlKey) mods.push('ctrl');
            if (e.shiftKey) mods.push('shift');
            if (e.altKey) mods.push('alt');
            let k = e.key;
            if (k === ' ') k = 'space';
            else if (k.startsWith('Arrow')) k = k.slice(5).toLowerCase();
            else k = k.toLowerCase();
            finish([...mods, k].join('+'));
        };
        const to = setTimeout(() => finish(null), timeoutMs);
        window.addEventListener('keydown', onKey, true);
    });
}
// Capture un COMBO clavier : appuie sur PLUSIEURS touches EN MÊME TEMPS (ex. a+b+c,
// ctrl+shift+e). On mémorise l'ensemble le plus large tenu simultanément, et on rend
// dès que tout est relâché -> « touche1+touche2+… » (modificateurs en tête).
// KB_TOKEN vit dans le module partagé TESTÉ manifest-lib.js (kbToken). Alias ici.
const KB_TOKEN = HoulaManifest.kbToken;
const KB_ORDER = ['ctrl', 'shift', 'alt', 'meta'];
const orderChord = (arr) => arr.slice().sort((a, b) => {
    const ia = KB_ORDER.indexOf(a), ib = KB_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
}).join('+');
function captureKeyboardChord(timeoutMs = 6000) {
    return new Promise((resolve) => {
        let done = false;
        const held = new Set();
        let maxChord = [];
        const finish = (spec) => {
            if (done) return; done = true;
            clearTimeout(to);
            window.removeEventListener('keydown', onDown, true);
            window.removeEventListener('keyup', onUp, true);
            resolve(spec);
        };
        const onDown = (e) => {
            e.preventDefault();
            held.add(KB_TOKEN(e));
            if (held.size > maxChord.length) maxChord = [...held];
        };
        const onUp = (e) => {
            held.delete(KB_TOKEN(e));
            if (held.size === 0 && maxChord.length) finish(orderChord(maxChord));
        };
        const to = setTimeout(() => finish(maxChord.length ? orderChord(maxChord) : null), timeoutMs);
        window.addEventListener('keydown', onDown, true);
        window.addEventListener('keyup', onUp, true);
    });
}

// ══════════════ ÉDITEUR MANETTE avancé (modale) ══════════════
let gpEdit = null; // { mode, gp, onSave }
const GP_MODE_HELP = {
    single: 'Un seul bouton (ex. ZR pour accélérer). « Capturer » lit ta manette.',
    chord: 'Plusieurs boutons EN MÊME TEMPS (ex. L + clic du stick gauche).',
    sequence: 'Des boutons l\'un APRÈS l\'autre (ex. ↓ puis A).',
    random: 'Un bouton AU HASARD parmi la sélection (résultat imprévisible à chaque déclenchement). Tu peux le faire précéder d\'un bouton fixe (ex. ↓ pour ouvrir un menu, puis une direction au hasard).',
    timeline: 'Chronologie : chaque étape presse des boutons puis attend. Idéal « combo, puis dans 5 s la touche stop ».',
    analog: 'Pousse les sticks / gâchettes à une intensité (ex. stick à moitié = tourner doucement), tenu pendant « Appui (ms) ».',
};
function gpDetectMode(e) {
    if (e.analog && Object.keys(e.analog).length) return 'analog';
    if (Array.isArray(e.steps) && e.steps.length) return 'timeline';
    if (Array.isArray(e.buttons) && e.buttons.length) return 'chord';
    if (Array.isArray(e.sequence) && e.sequence.length) return 'sequence';
    if (Array.isArray(e.randomFrom) && e.randomFrom.length) return 'random';
    return 'single';
}
const gpSelect = (cls, val) => `<select class="${cls}">${GP_BUTTONS.map((b) => `<option value="${b}"${b === val ? ' selected' : ''}>${esc(gpLabel(b))}</option>`).join('')}</select>`;
const gpChip = (cls, b, checked) => `<label class="gp-chip"><input type="checkbox" class="${cls}" value="${b}"${checked ? ' checked' : ''}/> ${esc(gpLabelShort(b))}</label>`;

function openGamepadEditor(effect, onSave) {
    cancelTestCountdown(); // tue un décompte orphelin d'une session d'édition précédente
    const gp = {
        button: effect.button || 'A',
        buttons: Array.isArray(effect.buttons) ? effect.buttons.slice() : [],
        sequence: Array.isArray(effect.sequence) ? effect.sequence.slice() : [],
        steps: Array.isArray(effect.steps) ? effect.steps.map((s) => ({ buttons: (s.buttons || (s.button ? [s.button] : [])).slice(), holdMs: s.holdMs, waitMs: s.waitMs })) : [],
        analog: effect.analog ? { ...effect.analog } : {},
        randomFrom: Array.isArray(effect.randomFrom) ? effect.randomFrom.slice() : [],
        // Lead du mode Aléatoire = bouton fixe joué AVANT le tirage. DÉCOUPLÉ de
        // gp.button (mode Bouton) : sinon un effet 'A' rouvert en Aléatoire hériterait
        // d'un appui 'A' fantôme. N'existe que si l'effet portait DÉJÀ button + randomFrom.
        randLead: (Array.isArray(effect.randomFrom) && effect.randomFrom.length && effect.button) ? effect.button : '',
        gapMs: typeof effect.gapMs === 'number' ? effect.gapMs : null,
        holdMs: typeof effect.holdMs === 'number' ? effect.holdMs : 120,
        repeat: typeof effect.repeat === 'number' ? effect.repeat : 1,
        repeatGapMs: typeof effect.repeatGapMs === 'number' ? effect.repeatGapMs : 0,
    };
    gpEdit = { mode: gpDetectMode(effect), gp, onSave };
    $('gp-hold').value = gp.holdMs;
    $('gp-repeat').value = gp.repeat;
    $('gp-repeatgap').value = gp.repeatGapMs;
    $('gp-test-res').textContent = '';
    document.querySelectorAll('#gp-modal .seg__btn').forEach((b) => b.classList.toggle('is-active', b.dataset.mode === gpEdit.mode));
    renderGpBody();
    $('gp-modal').classList.remove('hidden');
}
function renderGpBody() {
    const { mode, gp } = gpEdit;
    $('gp-mode-help').textContent = GP_MODE_HELP[mode] || '';
    const body = $('gp-body');
    if (mode === 'single') {
        body.innerHTML = `<div class="gp-row">Bouton ${gpSelect('gp-single', gp.button)} <button type="button" class="btn btn--ghost btn--mini gp-cap-single">Capturer</button></div>`;
        body.querySelector('.gp-single').onchange = (e) => { gp.button = e.target.value; };
        body.querySelector('.gp-cap-single').onclick = (ev) => gpCaptureInto(ev.currentTarget, (tok) => { gp.button = tok; body.querySelector('.gp-single').value = tok; });
    } else if (mode === 'chord') {
        const set = new Set(gp.buttons);
        body.innerHTML = `<div class="gp-chips">${GP_BUTTONS.map((b) => gpChip('gp-chord-btn', b, set.has(b))).join('')}</div>` +
            `<button type="button" class="btn btn--ghost btn--mini gp-cap-chord">Capturer (ajouter)</button>`;
        const sync = () => { gp.buttons = [...body.querySelectorAll('.gp-chord-btn:checked')].map((x) => x.value); };
        body.querySelectorAll('.gp-chord-btn').forEach((c) => (c.onchange = sync));
        body.querySelector('.gp-cap-chord').onclick = (ev) => gpCaptureInto(ev.currentTarget, (tok) => {
            const cb = body.querySelector(`.gp-chord-btn[value="${tok}"]`); if (cb) cb.checked = true; sync();
        });
    } else if (mode === 'sequence') {
        if (!gp.sequence.length) gp.sequence = ['A'];
        const items = gp.sequence.map((b, i) => `<div class="gp-seq-item" data-i="${i}"><span class="gp-seq-n">${i + 1}.</span> ${gpSelect('gp-seq-sel', b)} <button type="button" class="btn btn--ghost btn--mini gp-seq-del">✕</button></div>`).join('');
        body.innerHTML = `<div class="gp-seq">${items}</div><div class="row gap"><button type="button" class="btn btn--ghost btn--mini gp-seq-add">+ étape</button><button type="button" class="btn btn--ghost btn--mini gp-seq-cap">Capturer (ajouter)</button></div>`;
        body.querySelectorAll('.gp-seq-item').forEach((it) => {
            const i = Number(it.dataset.i);
            it.querySelector('.gp-seq-sel').onchange = (e) => { gp.sequence[i] = e.target.value; };
            it.querySelector('.gp-seq-del').onclick = () => { gp.sequence.splice(i, 1); renderGpBody(); };
        });
        body.querySelector('.gp-seq-add').onclick = () => { gp.sequence.push('A'); renderGpBody(); };
        body.querySelector('.gp-seq-cap').onclick = (ev) => gpCaptureInto(ev.currentTarget, (tok) => { gp.sequence.push(tok); renderGpBody(); });
    } else if (mode === 'random') {
        const pool = new Set(gp.randomFrom);
        body.innerHTML =
            '<div class="gp-row muted">Un bouton AU HASARD parmi la sélection (au moins 2).</div>' +
            `<div class="gp-chips">${GP_BUTTONS.map((b) => gpChip('gp-rand-btn', b, pool.has(b))).join('')}</div>` +
            '<button type="button" class="btn btn--ghost btn--mini gp-cap-rand">Capturer (ajouter au tirage)</button>' +
            `<label class="gp-row" style="margin-top:8px">Précédé de (optionnel) <select class="gp-rand-lead"><option value="">— aucun —</option>${GP_BUTTONS.map((b) => `<option value="${b}"${gp.randLead === b ? ' selected' : ''}>${esc(gpLabel(b))}</option>`).join('')}</select></label>`;
        const sync = () => { gp.randomFrom = [...body.querySelectorAll('.gp-rand-btn:checked')].map((x) => x.value); };
        body.querySelectorAll('.gp-rand-btn').forEach((c) => (c.onchange = sync));
        body.querySelector('.gp-cap-rand').onclick = (ev) => gpCaptureInto(ev.currentTarget, (tok) => {
            const cb = body.querySelector(`.gp-rand-btn[value="${tok}"]`); if (cb) cb.checked = true; sync();
        });
        // Bouton fixe joué AVANT le tirage (ex. ouvrir un menu) ; vide = tirage seul.
        body.querySelector('.gp-rand-lead').onchange = (e) => { gp.randLead = e.target.value || ''; };
    } else if (mode === 'timeline') {
        if (!gp.steps.length) gp.steps = [{ buttons: ['A'], holdMs: 120, waitMs: 0 }];
        const stepHtml = (s, i) => `<div class="gp-step" data-i="${i}">` +
            `<div class="gp-step__head"><b>Étape ${i + 1}</b> <button type="button" class="btn btn--ghost btn--mini gp-step-del">✕</button></div>` +
            `<div class="gp-chips">${GP_BUTTONS.map((b) => gpChip('gp-step-btn', b, (s.buttons || []).includes(b))).join('')}</div>` +
            `<div class="row gap wrap"><label class="gp-field">appui ms <input type="number" class="gp-step-hold" min="0" max="10000" value="${s.holdMs != null ? s.holdMs : 120}"/></label>` +
            `<label class="gp-field">puis attendre ms <input type="number" class="gp-step-wait" min="0" max="30000" value="${s.waitMs != null ? s.waitMs : 0}"/></label>` +
            `<button type="button" class="btn btn--ghost btn--mini gp-step-cap">Capturer</button></div></div>`;
        body.innerHTML = `<div class="gp-steps">${gp.steps.map(stepHtml).join('')}</div><button type="button" class="btn btn--ghost btn--mini gp-step-add">+ étape</button>`;
        const readSteps = () => {
            gp.steps = [...body.querySelectorAll('.gp-step')].map((el) => ({
                buttons: [...el.querySelectorAll('.gp-step-btn:checked')].map((x) => x.value),
                holdMs: Math.max(0, Math.min(Number(el.querySelector('.gp-step-hold').value) || 0, 10000)),
                waitMs: Math.max(0, Math.min(Number(el.querySelector('.gp-step-wait').value) || 0, 30000)),
            }));
        };
        body.querySelectorAll('.gp-step').forEach((el) => {
            const i = Number(el.dataset.i);
            el.querySelectorAll('.gp-step-btn, .gp-step-hold, .gp-step-wait').forEach((inp) => (inp.onchange = readSteps));
            el.querySelector('.gp-step-del').onclick = () => { readSteps(); gp.steps.splice(i, 1); renderGpBody(); };
            el.querySelector('.gp-step-cap').onclick = (ev) => gpCaptureInto(ev.currentTarget, (tok) => {
                const cb = el.querySelector(`.gp-step-btn[value="${tok}"]`); if (cb) cb.checked = true; readSteps();
            });
        });
        body.querySelector('.gp-step-add').onclick = () => { readSteps(); gp.steps.push({ buttons: ['A'], holdMs: 120, waitMs: 0 }); renderGpBody(); };
    } else if (mode === 'analog') {
        const sliderRow = (k, label, min, max) => {
            const v = gp.analog[k] != null ? gp.analog[k] : 0;
            return `<label class="gp-slider">${label} <input type="range" class="gp-an" data-k="${k}" min="${min}" max="${max}" step="0.05" value="${v}"/><output class="gp-an-out" data-k="${k}">${v}</output></label>`;
        };
        body.innerHTML = `<div class="gp-analog">${sliderRow('lx', 'Stick G ←→', -1, 1)}${sliderRow('ly', 'Stick G ↑↓', -1, 1)}${sliderRow('rx', 'Stick D ←→', -1, 1)}${sliderRow('ry', 'Stick D ↑↓', -1, 1)}${sliderRow('lt', 'Gâchette ZL', 0, 1)}${sliderRow('rt', 'Gâchette ZR', 0, 1)}</div>`;
        body.querySelectorAll('.gp-an').forEach((sl) => {
            sl.oninput = (e) => {
                const k = e.target.dataset.k; const val = Number(e.target.value);
                gp.analog[k] = val;
                const out = body.querySelector(`.gp-an-out[data-k="${k}"]`); if (out) out.textContent = String(val);
            };
        });
    }
}
// Capture manette et applique via callback ; feedback visuel sur le bouton.
async function gpCaptureInto(btn, apply) {
    const old = btn.textContent; btn.textContent = 'Appuie…'; btn.disabled = true;
    const tok = await captureGamepadToken(4000);
    btn.textContent = old; btn.disabled = false;
    if (tok) apply(tok);
}
// Construit l'effet manette depuis le mode actif + champs communs.
function gpBuildEffect() {
    const { mode, gp } = gpEdit;
    const hold = Math.max(0, Math.min(Number($('gp-hold').value) || 0, 10000));
    const repeat = Math.max(1, Math.min(Number($('gp-repeat').value) || 1, 20));
    const repeatGapMs = Math.max(0, Math.min(Number($('gp-repeatgap').value) || 0, 30000));
    const e = {};
    if (mode === 'single') e.button = gp.button || 'A';
    else if (mode === 'chord') e.buttons = gp.buttons.length ? gp.buttons : ['A'];
    else if (mode === 'sequence') e.sequence = gp.sequence.length ? gp.sequence : ['A'];
    else if (mode === 'random') {
        // Un bouton au hasard parmi la sélection (min 2), éventuellement précédé d'un bouton fixe (lead).
        e.randomFrom = gp.randomFrom.length >= 2 ? gp.randomFrom : ['A', 'B'];
        if (gp.randLead) e.button = gp.randLead;
    }
    // randomFrom est édité par le mode « Aléatoire » : on ne le ré-injecte PAS ici
    // (sinon bascule random -> Bouton impossible, et tirage dégénéré). On préserve
    // juste gapMs (espacement de séquence, sans UI dédiée) pour ne pas le perdre.
    if (mode === 'sequence' && typeof gp.gapMs === 'number') e.gapMs = gp.gapMs;
    if (mode === 'timeline') {
        // Une étape « attente seule » ne doit PAS sérialiser un chord vide (le
        // validateur exige 1..8 boutons) : on n'émet `buttons` que s'il y en a.
        e.steps = gp.steps.map((s) => {
            const st = {};
            if (s.buttons && s.buttons.length) { st.buttons = s.buttons; if (typeof s.holdMs === 'number') st.holdMs = s.holdMs; }
            if (typeof s.waitMs === 'number' && s.waitMs > 0) st.waitMs = s.waitMs;
            return st;
        }).filter((st) => st.buttons || st.waitMs != null);
        if (!e.steps.length) e.steps = [{ button: 'A', holdMs: hold }];
    } else if (mode === 'analog') {
        const a = {};
        for (const k of ['lx', 'ly', 'rx', 'ry']) if (gp.analog[k]) a[k] = gp.analog[k];
        for (const k of ['lt', 'rt']) if (gp.analog[k] > 0) a[k] = gp.analog[k];
        e.analog = Object.keys(a).length ? a : { lt: 1 };
    }
    e.holdMs = hold;
    if (repeat > 1) e.repeat = repeat;
    if (repeatGapMs > 0) e.repeatGapMs = repeatGapMs;
    return e;
}
document.querySelectorAll('#gp-modal .seg__btn').forEach((b) => {
    b.onclick = () => {
        if (!gpEdit) return;
        document.querySelectorAll('#gp-modal .seg__btn').forEach((x) => x.classList.toggle('is-active', x === b));
        gpEdit.mode = b.dataset.mode;
        renderGpBody();
    };
});
const gpCloseModal = () => { cancelTestCountdown(); $('gp-modal').classList.add('hidden'); };
$('gp-close').onclick = gpCloseModal;
$('gp-cancel').onclick = gpCloseModal;
$('gp-modal').onclick = (e) => { if (e.target.id === 'gp-modal') gpCloseModal(); };
$('gp-save').onclick = () => {
    if (!gpEdit) return;
    const built = gpBuildEffect();
    $('gp-modal').classList.add('hidden');
    gpEdit.onSave(built);
};
$('gp-test').onclick = (ev) => {
    const built = gpBuildEffect();
    runEffectTest({
        resEl: $('gp-test-res'),
        cls: 'cx-test-res',
        needsFocus: true,
        btn: ev.currentTarget,
        fire: () => api.engine.testRule({ id: 'gp-test', on: { type: 'gift' }, effect: { type: 'gamepad', ...built } }, labCurrentSlug),
    });
};

// ══════════════ ÉDITEUR CLAVIER (modale) ══════════════
// Une touche / Combo (ensemble) / Suite (enchaînement + rythme). Émet la key-spec
// ('e' | 'a+b' | 'up,up,down,down') + gapMs (délai entre touches d'une suite).
let kbEdit = null; // { mode, single, combo, seq, onSave }
const KB_MODE_HELP = {
    single: 'Une seule touche (ex. « e » pour interagir). « Capturer » : appuie, ça s\'écrit.',
    combo: 'Plusieurs touches EN MÊME TEMPS (ex. Ctrl + Espace). Capture : appuie sur toutes ensemble.',
    sequence: 'Des touches L\'UNE APRÈS L\'AUTRE (ex. ↑ ↑ ↓ ↓ ← →). Ajoute-les puis règle le RYTHME (délai entre chaque).',
};
function kbParse(effect) {
    const raw = String(effect.keys || '').trim();
    const backend = effect.backend || 'auto';
    const gapMs = typeof effect.gapMs === 'number' ? effect.gapMs : 40;
    const steps = raw.split(',').map((s) => s.trim()).filter(Boolean);
    const holdOf = (h) => (h ? Math.max(0, Math.min(Number(h) || 0, 2000)) : null);
    if (steps.length > 1) {
        return { mode: 'sequence', single: { key: '', hold: null }, combo: { keys: '', hold: null }, seq: { steps, gapMs }, backend };
    }
    const [combo, hold] = (steps[0] || '').split(':');
    const parts = (combo || '').split('+').map((s) => s.trim()).filter(Boolean);
    if (parts.length > 1) return { mode: 'combo', single: { key: parts[0] || '', hold: holdOf(hold) }, combo: { keys: parts.join('+'), hold: holdOf(hold) }, seq: { steps: [], gapMs }, backend };
    return { mode: 'single', single: { key: parts[0] || '', hold: holdOf(hold) }, combo: { keys: '', hold: null }, seq: { steps: parts.length ? [parts[0]] : [], gapMs }, backend };
}
function openKeyboardEditor(effect, onSave) {
    cancelTestCountdown(); // tue un décompte orphelin d'une session d'édition précédente
    kbStopSeqRecording();
    const s = kbParse(effect);
    kbEdit = { ...s, onSave, recording: false };
    if (kbEdit.mode === 'sequence' && !kbEdit.seq.steps.length) kbEdit.seq.steps = ['up'];
    $('kb-backend').value = s.backend === 'interception' ? 'interception' : 'auto';
    $('kb-test-res').textContent = '';
    document.querySelectorAll('#kb-modal .seg__btn').forEach((b) => b.classList.toggle('is-active', b.dataset.kbmode === kbEdit.mode));
    renderKbBody();
    $('kb-modal').classList.remove('hidden');
}
function renderKbBody() {
    const { mode } = kbEdit;
    $('kb-mode-help').textContent = KB_MODE_HELP[mode] || '';
    const body = $('kb-body');
    if (mode === 'single') {
        body.innerHTML = `<div class="gp-row">Touche <input type="text" class="kb-single" value="${esc(kbEdit.single.key)}" placeholder="ex. e, space, up" style="width:130px;margin:0"/> `
            + `<button type="button" class="btn btn--ghost btn--mini kb-cap-single">Capturer</button> `
            + `<label class="gp-field">maintenir ms <input type="number" class="kb-hold" min="0" max="2000" value="${kbEdit.single.hold != null ? kbEdit.single.hold : ''}" placeholder="0"/></label></div>`;
        body.querySelector('.kb-single').oninput = (e) => { kbEdit.single.key = e.target.value.trim(); };
        body.querySelector('.kb-hold').oninput = (e) => { kbEdit.single.hold = Number(e.target.value) || null; };
        body.querySelector('.kb-cap-single').onclick = (ev) => kbCaptureInto(ev.currentTarget, (spec) => { kbEdit.single.key = spec; body.querySelector('.kb-single').value = spec; });
    } else if (mode === 'combo') {
        body.innerHTML = `<div class="gp-row">Combo <input type="text" class="kb-combo" value="${esc(kbEdit.combo.keys)}" placeholder="ex. ctrl+space" style="flex:1;min-width:160px;margin:0"/> `
            + `<button type="button" class="btn btn--ghost btn--mini kb-cap-combo">Capturer combo</button> `
            + `<label class="gp-field">maintenir ms <input type="number" class="kb-hold" min="0" max="2000" value="${kbEdit.combo.hold != null ? kbEdit.combo.hold : ''}" placeholder="0"/></label></div>`;
        body.querySelector('.kb-combo').oninput = (e) => { kbEdit.combo.keys = e.target.value.trim(); };
        body.querySelector('.kb-hold').oninput = (e) => { kbEdit.combo.hold = Number(e.target.value) || null; };
        body.querySelector('.kb-cap-combo').onclick = (ev) => kbCaptureInto(ev.currentTarget, (spec) => { kbEdit.combo.keys = spec; body.querySelector('.kb-combo').value = spec; });
    } else { // sequence
        const rec = kbEdit.recording;
        const items = kbEdit.seq.steps.map((k, i) => `<div class="gp-seq-item" data-i="${i}"><span class="gp-seq-n">${i + 1}.</span> <input type="text" class="kb-seq-in" value="${esc(k)}" placeholder="touche" style="flex:1;margin:0"/> <button type="button" class="btn btn--ghost btn--mini kb-seq-cap">Capturer</button> <button type="button" class="btn btn--ghost btn--mini kb-seq-del">✕</button></div>`).join('')
            || '<div class="muted" style="padding:6px 2px">Clique « Enregistrer » puis tape tes touches (↑ ↑ ↓ ↓ ← →), ou ajoute-les à la main.</div>';
        const recBtn = rec
            ? '<button type="button" class="btn btn--panic btn--mini kb-rec">⏹ Arrêter</button> <span class="kb-rec-live">● Enregistrement… appuie sur tes touches (Échap pour finir)</span>'
            : '<button type="button" class="btn btn--primary btn--mini kb-rec">🎬 Enregistrer une suite</button> <span class="muted">Tape tes touches l\'une après l\'autre, elles se listent.</span>';
        body.innerHTML = `<div class="gp-row" style="margin-bottom:8px">${recBtn}</div>`
            + `<div class="gp-seq">${items}</div>`
            + `<div class="row gap" style="margin:8px 0"><button type="button" class="btn btn--ghost btn--mini kb-seq-add">+ étape</button><button type="button" class="btn btn--ghost btn--mini kb-seq-addcap">Capturer et ajouter</button></div>`
            + `<label class="gp-field">Délai entre chaque touche (ms) <input type="number" id="kb-gap" min="0" max="5000" step="10" value="${kbEdit.seq.gapMs != null ? kbEdit.seq.gapMs : 40}"/></label>`
            + `<div class="hint">Augmente le délai si le jeu « rate » des touches jouées trop vite (ex. 120 ms pour un rythme net). 0 = aucune pause.</div>`;
        body.querySelector('.kb-rec').onclick = () => {
            if (kbEdit.recording) kbStopSeqRecording();
            else {
                kbEdit.recording = true;
                kbEdit.seq.steps = []; // suite fraîche
                kbStartSeqRecording((tok) => { kbEdit.seq.steps.push(tok); renderKbBody(); }, () => { kbStopSeqRecording(); renderKbBody(); });
            }
            renderKbBody();
        };
        // Synchronise le délai à CHAQUE frappe (sinon ajouter/retirer une étape recrée
        // le champ depuis une valeur périmée). 0 est une valeur VALIDE (aucune pause).
        body.querySelector('#kb-gap').oninput = (e) => {
            const v = e.target.value;
            kbEdit.seq.gapMs = v === '' ? 40 : Math.max(0, Math.min(Number(v) || 0, 5000));
        };
        body.querySelectorAll('.gp-seq-item').forEach((it) => {
            const i = Number(it.dataset.i);
            it.querySelector('.kb-seq-in').oninput = (e) => { kbEdit.seq.steps[i] = e.target.value.trim(); };
            it.querySelector('.kb-seq-del').onclick = () => { kbEdit.seq.steps.splice(i, 1); renderKbBody(); };
            it.querySelector('.kb-seq-cap').onclick = (ev) => kbCaptureInto(ev.currentTarget, (spec) => { kbEdit.seq.steps[i] = spec; it.querySelector('.kb-seq-in').value = spec; });
        });
        body.querySelector('.kb-seq-add').onclick = () => { kbEdit.seq.steps.push('up'); renderKbBody(); };
        body.querySelector('.kb-seq-addcap').onclick = (ev) => kbCaptureInto(ev.currentTarget, (spec) => { kbEdit.seq.steps.push(spec); renderKbBody(); });
    }
}
// Enregistrement d'une SUITE : chaque appui de touche s'ajoute comme une étape.
let kbRecStop = null;
function kbStartSeqRecording(onKey, onStop) {
    kbStopSeqRecording();
    const onDown = (e) => {
        if (e.repeat) return;
        e.preventDefault();
        if (e.key === 'Escape') { if (onStop) onStop(); return; }
        if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return; // ignore les modificateurs seuls
        onKey(KB_TOKEN(e));
    };
    window.addEventListener('keydown', onDown, true);
    kbRecStop = () => { window.removeEventListener('keydown', onDown, true); kbRecStop = null; };
}
function kbStopSeqRecording() {
    if (kbRecStop) kbRecStop();
    if (kbEdit) kbEdit.recording = false;
}
async function kbCaptureInto(btn, apply) {
    const old = btn.textContent; btn.textContent = 'Appuie…'; btn.disabled = true;
    const spec = await captureKeyboardChord(6000);
    btn.textContent = old; btn.disabled = false;
    if (spec) apply(spec);
}
function kbBuildEffect() {
    const { mode, single, combo, seq } = kbEdit;
    const backend = $('kb-backend').value;
    const holdSuffix = (h) => (h && h > 0 ? ':' + Math.round(Math.min(h, 2000)) : '');
    const out = { keys: '' };
    if (backend === 'interception') out.backend = 'interception';
    if (mode === 'single') out.keys = (single.key || 'space') + holdSuffix(single.hold);
    else if (mode === 'combo') out.keys = (combo.keys || 'ctrl+space') + holdSuffix(combo.hold);
    else {
        const steps = seq.steps.map((s) => s.trim()).filter(Boolean);
        out.keys = (steps.length ? steps : ['up', 'down']).join(',');
        // gapMs est synchronisé en direct (oninput #kb-gap). 0 est une valeur VALIDE
        // (aucune pause) : on l'émet dès qu'il diffère du défaut 40.
        const g = typeof seq.gapMs === 'number' ? Math.max(0, Math.min(seq.gapMs, 5000)) : 40;
        if (g !== 40) out.gapMs = g;
    }
    return out;
}
document.querySelectorAll('#kb-modal .seg__btn').forEach((b) => {
    b.onclick = () => {
        if (!kbEdit) return;
        kbStopSeqRecording(); // ne pas laisser un enregistrement actif en changeant de mode
        document.querySelectorAll('#kb-modal .seg__btn').forEach((x) => x.classList.toggle('is-active', x === b));
        kbEdit.mode = b.dataset.kbmode;
        if (kbEdit.mode === 'sequence' && !kbEdit.seq.steps.length) kbEdit.seq.steps = ['up'];
        renderKbBody();
    };
});
const kbCloseModal = () => { cancelTestCountdown(); kbStopSeqRecording(); $('kb-modal').classList.add('hidden'); };
$('kb-close').onclick = kbCloseModal;
$('kb-cancel').onclick = kbCloseModal;
$('kb-modal').onclick = (e) => { if (e.target.id === 'kb-modal') kbCloseModal(); };
$('kb-save').onclick = () => {
    if (!kbEdit) return;
    kbStopSeqRecording();
    const built = kbBuildEffect();
    $('kb-modal').classList.add('hidden');
    kbEdit.onSave(built);
};
$('kb-test').onclick = (ev) => {
    const built = kbBuildEffect();
    runEffectTest({
        resEl: $('kb-test-res'),
        cls: 'cx-test-res',
        needsFocus: true,
        btn: ev.currentTarget,
        fire: () => api.engine.testRule({ id: 'kb-test', on: { type: 'gift' }, effect: { type: 'keyboard', ...built } }, labCurrentSlug),
    });
};

$('lab-add-rule').onclick = () => { labRules.push(newRule()); renderRules(); };
setupLabMarkdownEditor();
setupFeeSlider();
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
    $('lab-changelog-field').classList.toggle('hidden', create); // changelog = nouvelle version (édition)
    $('lab-save-meta').classList.toggle('hidden', create);
    $('lab-new-btn').classList.toggle('hidden', create);
    $('lab-submit-btn').textContent = create ? 'Créer le pack' : 'Enregistrer la version';
    $('lab-changelog').value = ''; // une nouvelle version démarre avec un changelog vierge
}
// Libellé vivant du curseur de commission (0 = gratuit, sinon N % des étoiles).
function syncFeeLabel() {
    const v = Number($('lab-fee').value) || 0;
    $('lab-fee-val').innerHTML = v > 0 ? v + ' % des étoiles' : '0 % · gratuit';
}
// Curseur de commission CUSTOM : reflète la valeur (input caché #lab-fee) sur --pct.
function renderFeeSlider() {
    const val = Math.max(0, Math.min(Number($('lab-fee').value) || 0, 15));
    const slider = $('lab-fee-slider');
    if (slider) { slider.style.setProperty('--pct', (val / 15) * 100 + '%'); slider.setAttribute('aria-valuenow', String(val)); }
}
function setupFeeSlider() {
    const slider = $('lab-fee-slider');
    if (!slider) return;
    const MAX = 15;
    const setFromX = (clientX) => {
        const r = slider.getBoundingClientRect();
        const pct = r.width ? Math.max(0, Math.min(1, (clientX - r.left) / r.width)) : 0;
        $('lab-fee').value = String(Math.round(pct * MAX));
        renderFeeSlider(); syncFeeLabel();
    };
    let dragging = false;
    slider.addEventListener('pointerdown', (e) => { dragging = true; try { slider.setPointerCapture(e.pointerId); } catch { /* noop */ } setFromX(e.clientX); });
    slider.addEventListener('pointermove', (e) => { if (dragging) setFromX(e.clientX); });
    const end = (e) => { dragging = false; try { slider.releasePointerCapture(e.pointerId); } catch { /* noop */ } };
    slider.addEventListener('pointerup', end);
    slider.addEventListener('pointercancel', end);
    slider.addEventListener('keydown', (e) => {
        let v = Number($('lab-fee').value) || 0;
        if (e.key === 'ArrowRight' || e.key === 'ArrowUp') v = Math.min(MAX, v + 1);
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') v = Math.max(0, v - 1);
        else if (e.key === 'Home') v = 0;
        else if (e.key === 'End') v = MAX;
        else return;
        e.preventDefault(); $('lab-fee').value = String(v); renderFeeSlider(); syncFeeLabel();
    });
}
// ── Éditeur Markdown des Instructions (Lab) : onglets Éditer/Aperçu + compteurs ──
function syncLabCounters() {
    const d = $('lab-desc-count'); if (d) d.textContent = String(($('lab-desc').value || '').length);
    const i = $('lab-instr-count'); if (i) i.textContent = String(($('lab-instructions').value || '').length);
}
function showLabInstrTab(which) {
    const editing = which !== 'preview';
    $('lab-instr-edit-tab').classList.toggle('is-active', editing);
    $('lab-instr-preview-tab').classList.toggle('is-active', !editing);
    $('lab-instructions').classList.toggle('hidden', !editing);
    $('lab-instr-toolbar').classList.toggle('hidden', !editing); // outils cachés en Aperçu
    const prev = $('lab-instr-preview');
    prev.classList.toggle('hidden', editing);
    if (!editing) renderMarkdownInto(prev, $('lab-instructions').value); // rendu SÛR (même moteur)
}
// Mini-WYSIWYG : insère du Markdown au niveau de la sélection du textarea (aucune
// lib externe — la CSP bloquerait un CDN de toute façon). Opère sur #lab-instructions.
function applyMdTool(action) {
    const ta = $('lab-instructions');
    if (!ta) return;
    const s = ta.selectionStart, e = ta.selectionEnd;
    const sel = ta.value.slice(s, e);
    const done = () => { ta.focus(); ta.dispatchEvent(new Event('input')); };
    const wrap = (b, a, ph) => {
        const inner = sel || ph;
        ta.setRangeText(b + inner + a, s, e, 'end');
        if (!sel) { ta.selectionStart = s + b.length; ta.selectionEnd = s + b.length + inner.length; }
        done();
    };
    const prefixLines = (pfx) => {
        // Couvre les LIGNES ENTIÈRES touchées (début de la 1re -> fin de la dernière),
        // pas seulement jusqu'au curseur : sinon on écrase le texte / on double le marqueur.
        const ls = ta.value.lastIndexOf('\n', s - 1) + 1;
        const nl = ta.value.indexOf('\n', e);
        const le = nl === -1 ? ta.value.length : nl;
        const block = ta.value.slice(ls, le); // peut être '' (ligne vide) -> insère juste le préfixe
        const out = block.split('\n').map((l) => (l.startsWith(pfx) ? l : pfx + l)).join('\n');
        ta.setRangeText(out, ls, le, 'end');
        done();
    };
    switch (action) {
        case 'bold': return wrap('**', '**', 'texte en gras');
        case 'italic': return wrap('*', '*', 'texte en italique');
        case 'code': return wrap('`', '`', 'code');
        case 'link': return wrap('[', '](https://)', 'texte du lien');
        case 'title': return prefixLines('## ');
        case 'list': return prefixLines('- ');
        case 'codeblock': {
            const inner = sel || 'ton code ici';
            const pre = (s > 0 && ta.value[s - 1] !== '\n') ? '\n' : '';
            ta.setRangeText(pre + '```\n' + inner + '\n```\n', s, e, 'end');
            return done();
        }
        default: return undefined;
    }
}
function setupLabMarkdownEditor() {
    $('lab-instr-edit-tab').onclick = () => showLabInstrTab('edit');
    $('lab-instr-preview-tab').onclick = () => showLabInstrTab('preview');
    $('lab-desc').addEventListener('input', syncLabCounters);
    $('lab-instructions').addEventListener('input', syncLabCounters);
    // Barre d'outils : chaque bouton insère le Markdown correspondant.
    $('lab-instr-toolbar').querySelectorAll('.md-tool').forEach((b) => {
        b.onclick = () => applyMdTool(b.dataset.md);
    });
    // Raccourcis clavier dans l'éditeur (gras / italique).
    $('lab-instructions').addEventListener('keydown', (ev) => {
        if (!(ev.ctrlKey || ev.metaKey)) return;
        const k = ev.key.toLowerCase();
        if (k === 'b') { ev.preventDefault(); applyMdTool('bold'); }
        else if (k === 'i') { ev.preventDefault(); applyMdTool('italic'); }
    });
}
function enterCreateMode() {
    labCurrentSlug = null; labLatestVersion = null; labTags = [];
    labRules = [newRule()];
    $('lab-slug').value = ''; $('lab-title').value = ''; $('lab-game').value = '';
    $('lab-desc').value = ''; $('lab-fee').value = 0;
    $('lab-instructions').value = ''; showLabInstrTab('edit'); syncLabCounters();
    renderFeeSlider(); syncFeeLabel();
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
    $('lab-desc').value = b.description || ''; $('lab-fee').value = b.creatorFeePercent || 0;
    $('lab-instructions').value = b.instructions || ''; showLabInstrTab('edit'); syncLabCounters();
    renderFeeSlider(); syncFeeLabel();
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
    // Édition demandée : on VIDE tout de suite l'éditeur (sinon, pendant le chargement
    // async ci-dessous, l'utilisateur voit encore le pack précédemment édité — d'où
    // « je tombe sur chaos au lieu de ferme »).
    if (pendingEditSlug) {
        $('lab-mode-title').textContent = 'Chargement…';
        $('lab-slug').value = ''; $('lab-title').value = ''; $('lab-desc').value = '';
        $('lab-instructions').value = ''; showLabInstrTab('edit'); syncLabCounters();
        $('lab-versions').innerHTML = ''; labRules = [];
        if (!labJsonMode) renderRules();
    }
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
    const btn = $('lab-save-meta');
    setBtnBusy(btn, true, 'Enregistrement…');
    try {
        await api.lab.update(labCurrentSlug, { title: $('lab-title').value.trim(), description: $('lab-desc').value.trim(), instructions: $('lab-instructions').value.trim(), game: $('lab-game').value.trim() || '', tags: labTags, creatorFeePercent: Math.max(0, Math.min(Number($('lab-fee').value) || 0, 15)) });
        showToast('lab-save', { kind: 'ok', title: 'Infos enregistrées', msg: 'Titre, description et réglages du pack sont à jour.' });
    } catch (e) {
        showToast('lab-save', { kind: 'error', title: 'Échec de l’enregistrement', msg: friendlyError(e, "Les infos n'ont pas pu être enregistrées.") });
    } finally { setBtnBusy(btn, false); }
};
/** true s'il reste un « cadeau personnalisé » sans icône (uploadée OU en mémoire). */
function missingCustomIcon() {
    return labRules.some((r) => r.event.type === 'gift-custom' && !r.event.iconUrl && !r.event._iconFile);
}
/** Première règle dont le déclencheur « tous les N » (ou contient/palier) est vide :
 *  sinon la règle part MORTE (le routeur l'ignore) ou le serveur refuse la version. */
function incompleteTrigger() {
    return labRules.find((r) => {
        const t = r.event.type;
        if (t === 'viewer') return r.event.every == null;
        if (t === 'comment') {
            const cm = r.event._cmode || (r.event.every != null ? 'every' : 'contains');
            return cm === 'every' ? r.event.every == null : !(r.event.contains && r.event.contains.trim());
        }
        if (t === 'hearts') {
            const hm = r.event._hmode || (r.event.every != null ? 'every' : 'milestone');
            return hm === 'every' ? r.event.every == null : r.event.milestone == null;
        }
        return false;
    });
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
/** État « occupé » d'un bouton : libellé « … » + spinner (FORME animée, pas la couleur) + désactivé. */
function setBtnBusy(btn, busy, busyLabel) {
    if (!btn) return;
    if (busy) {
        if (!btn.dataset.idleLabel) btn.dataset.idleLabel = btn.textContent;
        btn.disabled = true;
        btn.classList.add('is-busy');
        btn.textContent = busyLabel || 'Enregistrement…';
    } else {
        btn.disabled = false;
        btn.classList.remove('is-busy');
        if (btn.dataset.idleLabel) { btn.textContent = btn.dataset.idleLabel; delete btn.dataset.idleLabel; }
    }
}
/** Le manifeste porte-t-il ≥1 icône custom ? (déclenche la modération serveur, même en privé.) */
function manifestHasCustomIcons(m) {
    return ((m && m.rules) || []).some((r) => r && r.on && typeof r.on.iconUrl === 'string' && r.on.iconUrl);
}
/** Toast de confirmation, HONNÊTE sur la modération : public ou icônes -> validation avant diffusion. */
function saveVersionToast(version, visibility, inReview) {
    if (inReview) {
        showToast('lab-save', {
            kind: 'ok',
            title: `Version ${version} enregistrée`,
            msg: visibility === 'public'
                ? "Elle passe en validation avant d'être publiée. Toi, tu peux déjà la tester."
                : "Bien enregistrée. Tes icônes passent en validation avant d'être vues par les viewers — ton pack, lui, les utilise déjà.",
        });
    } else {
        showToast('lab-save', { kind: 'ok', title: `Version ${version} enregistrée`, msg: 'Tes modifications sont enregistrées.' });
    }
}
$('lab-submit-btn').onclick = async () => {
    const btn = $('lab-submit-btn');
    const visibility = $('lab-vis').checked ? 'public' : 'private';

    if (!labJsonMode && missingConnector())
        return showToast('lab-save', { kind: 'warn', title: 'Connecteur manquant', msg: 'Chaque interaction réseau doit avoir un connecteur — choisis-en un ou crée-en un (+ Nouveau…).' });
    if (!labJsonMode && missingCustomIcon())
        return showToast('lab-save', { kind: 'warn', title: 'Icône manquante', msg: 'Chaque « cadeau personnalisé » doit avoir une icône avant l’enregistrement.' });
    if (!labJsonMode) {
        const bad = incompleteTrigger();
        if (bad) {
            const t = bad.event.type;
            const msg = t === 'viewer' ? 'Indique un nombre pour « tous les N nouveaux spectateurs ».'
                : t === 'comment' ? 'Un message chat doit avoir un mot-clé, ou un nombre pour « tous les N messages ».'
                    : 'Un déclencheur Likes doit avoir un palier, ou un nombre pour « tous les N likes ».';
            return showToast('lab-save', { kind: 'warn', title: 'Déclencheur incomplet', msg });
        }
    }

    // Manifeste construit + VALIDÉ avant tout appel serveur : le serveur est fail-closed
    // (un seul effet invalide rejette TOUT) -> sans ce garde, la création laissait un
    // bundle orphelin sans version = travail perdu à la réouverture.
    let manifest;
    try { manifest = labJsonMode ? JSON.parse($('lab-manifest').value) : buildManifest(); }
    catch { return showToast('lab-save', { kind: 'error', title: 'JSON invalide', msg: "Le manifeste JSON n'est pas valide." }); }
    const manifestProblem = validateManifestClient(manifest);
    if (manifestProblem) return showToast('lab-save', { kind: 'warn', title: 'Interaction incomplète', msg: manifestProblem });

    if (labMode === 'create') {
        const slug = $('lab-slug').value.trim(), title = $('lab-title').value.trim();
        if (!slug || !title) return showToast('lab-save', { kind: 'warn', title: 'Champs requis', msg: 'Le slug et le titre sont obligatoires.' });
        setBtnBusy(btn, true, 'Création…');
        try {
            // Tolérant à l'orphelin : si le slug est déjà à MOI sans version (création
            // précédente ratée), on saute create et on rattache directement la version.
            try {
                await api.lab.create({ slug, title, description: $('lab-desc').value.trim() || undefined, instructions: $('lab-instructions').value.trim() || undefined, game: $('lab-game').value.trim() || undefined, tags: labTags, creatorFeePercent: Math.max(0, Math.min(Number($('lab-fee').value) || 0, 15)) });
            } catch (e) {
                if (!(await isMyOrphanSlug(slug))) throw e; // slug pris par un autre / vraie erreur
            }
            labCurrentSlug = slug; labLatestVersion = null;
            syncLabBindings(); // enregistre les liaisons rôle->connecteur (slug désormais connu)
            await uploadHeldIcons(); // pose les icônes gardées en mémoire
            if (pendingBannerFile) { // bannière choisie avant création -> upload maintenant
                try { await api.lab.uploadBannerFile(slug, pendingBannerFile); } catch { /* non bloquant */ }
                pendingBannerFile = null;
            }
            await api.lab.submitVersion(slug, { version: '1.0.0', manifest, visibility });
            await enterEditMode(slug);
            saveVersionToast('1.0.0', visibility, visibility === 'public' || manifestHasCustomIcons(manifest));
        } catch (e) {
            showToast('lab-save', { kind: 'error', title: 'Création échouée', msg: friendlyRejection(e) });
        } finally { setBtnBusy(btn, false); }
        return;
    }

    // Édition : nouvelle version
    setBtnBusy(btn, true, 'Enregistrement…');
    try {
        syncLabBindings();
        await uploadHeldIcons();
        const version = labLatestVersion ? bumpVersion(labLatestVersion, $('lab-bump').value) : '1.0.0';
        const changelog = ($('lab-changelog').value || '').trim() || undefined;
        await api.lab.submitVersion(labCurrentSlug, { version, manifest, visibility, changelog });
        saveVersionToast(version, visibility, visibility === 'public' || manifestHasCustomIcons(manifest));
        // Recharge depuis le serveur : la nouvelle version apparaît dans l'historique ET
        // l'éditeur ré-affiche l'état RÉELLEMENT enregistré (icônes comprises) = preuve visible.
        try { await enterEditMode(labCurrentSlug); } catch { labLatestVersion = version; }
    } catch (e) {
        showToast('lab-save', { kind: 'error', title: 'Enregistrement échoué', msg: friendlyRejection(e) });
    } finally { setBtnBusy(btn, false); }
};

// Indicateur de croissance (étoiles 7j vs 7j précédents). Flèche = FORME (pas la
// seule couleur, daltonien) + le pourcentage signé. null = activité toute neuve.
function growthChip(g) {
    if (g === null || g === undefined) return '<span class="growth growth--new" title="Activité récente, pas encore de comparaison">✦ nouveau</span>';
    if (g > 0) return `<span class="growth growth--up" title="Croissance sur 7 jours">↗ +${g}%</span>`;
    if (g < 0) return `<span class="growth growth--down" title="Baisse sur 7 jours">↘ ${g}%</span>`;
    return '<span class="growth growth--flat" title="Stable sur 7 jours">→ stable</span>';
}

// ── Mes bundles (cliquables -> édition dans le Lab) ──
const MINE_PAGE = 24;
let mineAll = [], mineFiltered = [], mineRendered = 0, mineQuery = '', mineSearchTimer = null;

function buildMineCard(b) {
    const card = document.createElement('div');
    card.className = 'bundle-card';
    const banner = b.bannerUrl ? ` style="background-image:url('${esc(b.bannerUrl)}')"` : '';
    const ver = b.version ? `v${esc(b.version)}${b.versionDate ? ' · ' + esc(fmtDate(b.versionDate)) : ''}` : 'aucune version publiée';
    card.innerHTML = `
        <div class="bundle-card__banner"${banner}></div>
        <div class="bundle-card__body">
            <div class="row between"><h3>${esc(b.title || b.slug)}</h3><span class="chips">${Number(b.creatorFeePercent) > 0 ? `<span class="badge badge--fee">${Number(b.creatorFeePercent)}% commission</span>` : ''}<span class="badge badge--off">${esc(b.visibility)}</span></span></div>
            <div class="publisher">${publisherHtml(b.publisher, b.installCount)}</div>
            <div class="muted small">${ver}${b.official ? ' · officiel' : ''}</div>
            <div class="mine-earn"><span>Généré&nbsp;: <b>${Number(b.earnedStars || 0)}</b>&nbsp;⭐</span><span>Gagné&nbsp;: <b>${Number(b.earnedCreatorStars || 0)}</b>&nbsp;⭐</span>${growthChip(b.growthPct)}</div>
            <div class="row gap wrap mine-foot">
                <button class="btn btn--ghost stats">Voir les stats</button>
                <button class="btn btn--primary edit">Éditer</button>
            </div>
        </div>`;
    card.querySelector('.edit').onclick = () => { pendingEditSlug = b.slug; switchView('lab'); };
    card.querySelector('.stats').onclick = () => openStats(b.slug, b.title || b.slug);
    return card;
}
async function loadMyBundles() {
    $('mine-list').innerHTML = skeletonCardsHtml(6); $('mine-more').textContent = ''; // le temps du fetch
    try { mineAll = (await api.lab.myBundles()) || []; }
    catch { mineAll = []; }
    renderMine();
}
// Recherche (client) + rendu par CHUNKS (scroll infini) : prêt pour un créateur qui
// publie beaucoup de bundles.
function renderMine() {
    const box = $('mine-list');
    const q = mineQuery.toLowerCase();
    mineFiltered = q ? mineAll.filter((b) => `${b.title || ''} ${b.slug || ''}`.toLowerCase().includes(q)) : mineAll;
    mineRendered = 0;
    box.innerHTML = ''; $('mine-more').textContent = '';
    if (!mineFiltered.length) {
        box.innerHTML = mineAll.length
            ? emptyStateHtml('🔎', 'Aucun résultat', `Aucun de tes bundles ne correspond à « ${mineQuery} ».`, null)
            : emptyStateHtml('✨', 'Crée ton premier pack', 'Dans le Lab, mappe des cadeaux, messages, likes ou partages de ton live sur des actions réelles : commandes Minecraft (RCON), scènes OBS, manette, domotique…', 'Ouvrir le Lab', 'empty-cta-lab');
        wireEmptyCtas(box);
        return;
    }
    renderMoreMine();
}
function renderMoreMine() {
    const box = $('mine-list');
    const next = mineFiltered.slice(mineRendered, mineRendered + MINE_PAGE);
    next.forEach((b) => box.appendChild(buildMineCard(b)));
    mineRendered += next.length;
    // Auto-remplissage : si le chunk ne crée pas de barre de défilement, on continue
    // (sinon, sur grand écran, les bundles au-delà du 1er chunk resteraient invisibles).
    if (mineRendered < mineFiltered.length) maybeLoadMore();
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
async function loadConnectorsView() { $('cx-list').innerHTML = skeletonRowsHtml(3); await loadConnectors(); renderConnectorsList(); }
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
