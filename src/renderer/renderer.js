'use strict';
const api = window.houlaConnect;
const $ = (id) => document.getElementById(id);
const TRANSPARENT = 'data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=';
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const CAPS = [
    ['allowKeyboard', 'Clavier (nut.js)'],
    ['allowGamepad', 'Manette virtuelle (ViGEm)'],
    ['allowPythonDriver', 'Pilotage bas niveau (Interception/ViGEm)'],
    ['allowRcon', 'RCON (Minecraft…)'],
    ['allowObs', 'OBS'],
    ['allowHttp', 'HTTP / domotique'],
    ['allowMqtt', 'MQTT (domotique / IoT)'],
    ['allowOsc', 'OSC (VRChat, VJ, lumières)'],
    ['allowWs', 'WebSocket (overlays custom)'],
];

// ── Window controls ──
$('win-min').onclick = () => api.win.minimize();
$('win-max').onclick = () => api.win.maximize();
$('win-close').onclick = () => api.win.close();

// ── Auth ──
async function refreshAuth() {
    const { authenticated } = await api.authStatus();
    if (authenticated) return showApp();
    $('view-auth').classList.remove('hidden');
    $('app-main').classList.add('hidden');
}
$('btn-login').onclick = () => api.login();
$('btn-logout').onclick = async () => { await api.logout(); location.reload(); };
api.onAuth(async (a) => { if (a.authenticated) await showApp(); });

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
    await loadCaps();
    switchView('capture');
}

// ── Nav ──
function switchView(name) {
    document.querySelectorAll('.nav').forEach((n) => n.classList.toggle('active', n.dataset.view === name));
    ['capture', 'store', 'lab', 'mine', 'settings'].forEach((v) =>
        $('view-' + v).classList.toggle('hidden', v !== name),
    );
    if (name === 'store') loadStore();
    if (name === 'mine') loadMyBundles();
    if (name === 'lab') loadLab();
}
document.querySelectorAll('.nav').forEach((n) => (n.onclick = () => switchView(n.dataset.view)));

// ── Capture ──
async function loadInstalled(toMine) {
    const installed = (await api.store.installed()) || [];
    const sel = $('active-bundle');
    const noPack = $('no-pack');
    if (!installed.length) {
        // Aucun pack : on cache le select et on affiche l'état vide.
        sel.classList.add('hidden');
        noPack.classList.remove('hidden');
        $('btn-start').disabled = true;
    } else {
        sel.classList.remove('hidden');
        noPack.classList.add('hidden');
        $('btn-start').disabled = false;
        sel.innerHTML = '';
        installed.forEach((b) => {
            const o = document.createElement('option');
            o.value = b.slug;
            o.textContent = `${b.slug} (v${b.version})`;
            sel.appendChild(o);
        });
    }
}
$('btn-start').onclick = async () => {
    const slug = $('active-bundle').value;
    if (!slug) return;
    try { await api.engine.start(slug); } catch (e) { logLine({ allowed: false, reason: e.message, ruleId: 'start' }); }
};
$('btn-stop').onclick = () => api.engine.stop();
$('btn-test').onclick = () => api.engine.test();
$('btn-panic').onclick = () => api.engine.panic();

api.onState((s) => {
    const badge = $('conn-badge');
    badge.textContent = s.connected ? 'Connecté' : (s.error ? 'Erreur: ' + s.error : 'Déconnecté');
    badge.className = 'badge ' + (s.connected ? 'badge--on' : 'badge--off');
});
api.onLog((l) => logLine(l));
function logLine(l) {
    const el = document.createElement('div');
    const cls = l.allowed ? 'ok' : 'no';
    const sign = l.allowed ? '✓' : '✕';
    el.innerHTML = `<span class="${cls}">${sign}</span> ${l.ruleId || ''} ${l.executor || ''} ${l.sender ? '— ' + l.sender : ''} ${l.reason ? '(' + l.reason + ')' : ''}`;
    const log = $('log');
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
}

// ── Store ──
function publisherHtml(pub, installs) {
    pub = pub || {};
    return `<img class="av" src="${esc(pub.avatarUrl || TRANSPARENT)}" alt=""/>
        <span>${esc(pub.name || 'Hou.la')}</span>
        ${pub.isVerified ? '<span class="verified" title="Vérifié">✓</span>' : ''}
        <span>· ${installs || 0} installs</span>`;
}
function installBundle(slug, btn) {
    if (btn) btn.textContent = '…';
    api.store
        .install(slug)
        .then(() => { if (btn) btn.textContent = 'Installé ✓'; return loadInstalled(); })
        .catch(() => { if (btn) btn.textContent = 'Échec'; });
}
async function loadStore() {
    const list = (await api.store.list()) || [];
    const el = $('store-list');
    el.innerHTML = '';
    if (!list.length) { el.innerHTML = '<p class="muted">Le store est vide pour l\'instant.</p>'; return; }
    list.forEach((b) => {
        const card = document.createElement('div');
        card.className = 'bundle-card';
        const banner = b.bannerUrl ? ` style="background-image:url('${esc(b.bannerUrl)}')"` : '';
        card.innerHTML = `
            <div class="bundle-card__banner"${banner}></div>
            <div class="bundle-card__body">
                <h3>${esc(b.title || b.slug)}</h3>
                <div class="publisher">${publisherHtml(b.publisher, b.installCount)}</div>
                <div class="row gap">
                    <button class="btn btn--primary install">Installer</button>
                    <button class="btn btn--ghost more">Voir plus</button>
                </div>
            </div>`;
        card.querySelector('.install').onclick = (e) => installBundle(b.slug, e.target);
        card.querySelector('.more').onclick = () => openModal(b);
        el.appendChild(card);
    });
}

// ── Modal détail ──
function openModal(b) {
    $('modal-banner').style.backgroundImage = b.bannerUrl ? `url('${b.bannerUrl}')` : '';
    $('modal-title').textContent = b.title || b.slug;
    $('modal-publisher').innerHTML = publisherHtml(b.publisher, b.installCount);
    $('modal-desc').textContent = b.description || 'Aucune description.';
    $('modal-caps').innerHTML = '';
    api.store
        .preview(b.slug)
        .then((p) => {
            const caps = (p && p.capabilities) || [];
            $('modal-caps').innerHTML = caps.map((c) => `<span class="chip">${esc(c)}</span>`).join('');
        })
        .catch(() => {});
    $('modal-install').onclick = () => installBundle(b.slug, $('modal-install'));
    $('modal-install').textContent = 'Installer';
    $('modal').classList.remove('hidden');
}
$('modal-close').onclick = () => $('modal').classList.add('hidden');
$('modal').onclick = (e) => { if (e.target.id === 'modal') $('modal').classList.add('hidden'); };

// ── Lab : éditeur visuel (QUAND … ALORS …) ──
const EVENTS = [['gift', 'Cadeau'], ['follow', 'Nouvel abonné'], ['comment', 'Message chat'], ['hearts', 'Palier de likes'], ['share', 'Partage']];
const EXECS = [['keyboard', 'Clavier'], ['gamepad', 'Manette'], ['rcon', 'RCON'], ['obs', 'OBS'], ['http', 'HTTP'], ['mqtt', 'MQTT'], ['osc', 'OSC'], ['ws', 'WebSocket']];
const ROLES = [['all', 'Tout le monde'], ['followers', 'Abonnés'], ['moderators', 'Modérateurs']];
const GP_BUTTONS = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'START', 'BACK', 'LS', 'RS'];
let labRules = [];
let labCurrentSlug = null;
let labLatestVersion = null;
let labJsonMode = false;
let giftCatalog = []; // [{slug,name,thumbnailUrl,coinCost,isInteractiveSlot}] depuis GET /api/gifts

async function loadGiftCatalog() {
    try { giftCatalog = (await api.gifts.catalog()) || []; } catch { giftCatalog = []; }
}
// Options du cadeau déclencheur : le catalogue RÉEL (par slug) + les slots réservés
// (art custom d'un pack). `selected` toujours présent même hors catalogue (offline).
function giftOptions(selected) {
    const generic = giftCatalog.filter((g) => !g.isInteractiveSlot);
    let known = false;
    const gOpts = generic.map((g) => {
        if (g.slug === selected) known = true;
        return `<option value="${esc(g.slug)}"${g.slug === selected ? ' selected' : ''}>${esc(g.name)}</option>`;
    }).join('');
    let sOpts = '';
    for (let i = 1; i <= 30; i++) {
        const s = `ix_slot_${String(i).padStart(2, '0')}`;
        if (s === selected) known = true;
        sOpts += `<option value="${s}"${s === selected ? ' selected' : ''}>Slot interactif ${i}</option>`;
    }
    const fallback = selected && !known ? `<option value="${esc(selected)}" selected>${esc(selected)}</option>` : '';
    const g1 = gOpts ? `<optgroup label="Cadeaux">${gOpts}</optgroup>` : '';
    return `${fallback}${g1}<optgroup label="Slots interactifs (art custom)">${sOpts}</optgroup>`;
}
/** Slug de cadeau par défaut : 1er cadeau du catalogue, sinon 1er slot réservé. */
function defaultGiftSlug() {
    const g = giftCatalog.find((x) => !x.isInteractiveSlot);
    return g ? g.slug : 'ix_slot_01';
}
function eventFieldHtml(r) {
    if (r.event.type === 'gift') return `<select class="r-giftslug">${giftOptions(r.event.giftSlug)}</select>`;
    if (r.event.type === 'comment') return `<input type="text" class="r-contains" placeholder="contient ce mot…" />`;
    if (r.event.type === 'hearts') return `<input type="number" class="r-milestone" placeholder="palier (ex. 100)" min="1" />`;
    return '';
}
function execFieldHtml(r) {
    switch (r.effect.type) {
        case 'keyboard': return `<input type="text" class="r-keys" placeholder="touches (ex. space, shift+c)" /><select class="r-backend"><option value="auto">clavier normal</option><option value="interception">bas niveau (Meccha)</option></select>`;
        case 'gamepad': return `<select class="r-button">${GP_BUTTONS.map((b) => `<option>${b}</option>`).join('')}</select>`;
        case 'rcon': return `<input type="text" class="r-command" placeholder="commande (ex. give {player} minecraft:diamond 1)" />`;
        case 'obs': return `<input type="text" class="r-request" placeholder="requête OBS (ex. SetCurrentProgramScene)" />`;
        case 'http': return `<select class="r-method"><option>GET</option><option>POST</option><option>PUT</option></select><input type="text" class="r-url" placeholder="https://…" />`;
        case 'mqtt': return `<input type="text" class="r-topic" placeholder="topic (ex. maison/led/set)" /><input type="text" class="r-payload" placeholder="message (ex. ON)" />`;
        case 'osc': return `<input type="text" class="r-address" placeholder="/avatar/parameters/… (VRChat)" /><input type="text" class="r-oscargs" placeholder="valeurs séparées par , (ex. 1, true)" />`;
        case 'ws': return `<input type="text" class="r-wsurl" placeholder="wss://…" /><input type="text" class="r-wsmsg" placeholder="message à envoyer" />`;
        default: return '';
    }
}
function newRule() { return { event: { type: 'gift', giftSlug: defaultGiftSlug() }, effect: { type: 'keyboard', keys: 'space', backend: 'auto' }, followersOnly: false, moderatorsOnly: false }; }

function readRule(el, r) {
    const q = (s) => el.querySelector(s);
    if (r.event.type === 'gift') r.event.giftSlug = q('.r-giftslug') ? q('.r-giftslug').value : r.event.giftSlug;
    if (r.event.type === 'comment') r.event.contains = q('.r-contains') ? q('.r-contains').value : '';
    if (r.event.type === 'hearts') r.event.milestone = q('.r-milestone') ? Number(q('.r-milestone').value) || undefined : undefined;
    if (r.effect.type === 'keyboard') { r.effect.keys = q('.r-keys') ? q('.r-keys').value : ''; r.effect.backend = q('.r-backend') ? q('.r-backend').value : 'auto'; }
    if (r.effect.type === 'gamepad') r.effect.button = q('.r-button') ? q('.r-button').value : 'A';
    if (r.effect.type === 'rcon') r.effect.command = q('.r-command') ? q('.r-command').value : '';
    if (r.effect.type === 'obs') r.effect.request = q('.r-request') ? q('.r-request').value : '';
    if (r.effect.type === 'http') { r.effect.method = q('.r-method') ? q('.r-method').value : 'POST'; r.effect.url = q('.r-url') ? q('.r-url').value : ''; }
    if (r.effect.type === 'mqtt') { r.effect.topic = q('.r-topic') ? q('.r-topic').value : ''; r.effect.payload = q('.r-payload') ? q('.r-payload').value : ''; }
    if (r.effect.type === 'osc') {
        r.effect.address = q('.r-address') ? q('.r-address').value : '';
        r.effect.args = q('.r-oscargs') ? parseOscArgs(q('.r-oscargs').value) : [];
    }
    if (r.effect.type === 'ws') { r.effect.url = q('.r-wsurl') ? q('.r-wsurl').value : ''; r.effect.message = q('.r-wsmsg') ? q('.r-wsmsg').value : ''; }
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
                    ${execFieldHtml(r)}</div></div>
            <div class="rule__part rule__part--foot"><span class="rule__lbl">SI</span>
                <div class="rule__fields">
                    <select class="r-role" title="Qui peut déclencher cette règle ?">${ROLES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></div>
                <button class="r-del" title="Supprimer cette interaction">&#10005;</button></div>`;
        const q = (s) => el.querySelector(s);
        if (r.event.type === 'comment' && q('.r-contains')) q('.r-contains').value = r.event.contains || '';
        if (r.event.type === 'hearts' && q('.r-milestone')) q('.r-milestone').value = r.event.milestone || '';
        if (r.effect.type === 'keyboard') { if (q('.r-keys')) q('.r-keys').value = r.effect.keys || ''; if (q('.r-backend')) q('.r-backend').value = r.effect.backend || 'auto'; }
        if (r.effect.type === 'gamepad' && q('.r-button')) q('.r-button').value = r.effect.button || 'A';
        if (r.effect.type === 'rcon' && q('.r-command')) q('.r-command').value = r.effect.command || '';
        if (r.effect.type === 'obs' && q('.r-request')) q('.r-request').value = r.effect.request || '';
        if (r.effect.type === 'http') { if (q('.r-method')) q('.r-method').value = r.effect.method || 'POST'; if (q('.r-url')) q('.r-url').value = r.effect.url || ''; }
        if (r.effect.type === 'mqtt') { if (q('.r-topic')) q('.r-topic').value = r.effect.topic || ''; if (q('.r-payload')) q('.r-payload').value = r.effect.payload || ''; }
        if (r.effect.type === 'osc') { if (q('.r-address')) q('.r-address').value = r.effect.address || ''; if (q('.r-oscargs')) q('.r-oscargs').value = (r.effect.args || []).join(', '); }
        if (r.effect.type === 'ws') { if (q('.r-wsurl')) q('.r-wsurl').value = r.effect.url || ''; if (q('.r-wsmsg')) q('.r-wsmsg').value = r.effect.message || ''; }
        if (q('.r-role')) q('.r-role').value = r.moderatorsOnly ? 'moderators' : r.followersOnly ? 'followers' : 'all';
        q('.r-event').onchange = (e) => { const t = e.target.value; r.event = { type: t }; if (t === 'gift') r.event.giftSlug = defaultGiftSlug(); renderRules(); };
        q('.r-exec').onchange = (e) => { r.effect = { type: e.target.value }; renderRules(); };
        el.querySelectorAll('input, select').forEach((inp) => {
            if (inp.classList.contains('r-event') || inp.classList.contains('r-exec')) return;
            inp.addEventListener('input', () => readRule(el, r));
        });
        q('.r-del').onclick = () => { labRules.splice(i, 1); renderRules(); };
        box.appendChild(el);
    });
}
function buildManifest() {
    return {
        schema: 2,
        rules: labRules.map((r, i) => {
            const on = { type: r.event.type };
            if (r.event.type === 'gift') on.giftSlug = r.event.giftSlug || r.event.slot;
            if (r.event.type === 'comment') on.contains = r.event.contains;
            if (r.event.type === 'hearts') on.milestone = r.event.milestone;
            const effect = { type: r.effect.type };
            if (r.effect.type === 'keyboard') { effect.keys = r.effect.keys; if (r.effect.backend && r.effect.backend !== 'auto') effect.backend = r.effect.backend; }
            if (r.effect.type === 'gamepad') effect.button = r.effect.button;
            if (r.effect.type === 'rcon') effect.command = r.effect.command;
            if (r.effect.type === 'obs') effect.request = r.effect.request;
            if (r.effect.type === 'http') { effect.method = r.effect.method; effect.url = r.effect.url; }
            if (r.effect.type === 'mqtt') { effect.topic = r.effect.topic; effect.payload = r.effect.payload || ''; }
            if (r.effect.type === 'osc') { effect.address = r.effect.address; if (r.effect.args && r.effect.args.length) effect.args = r.effect.args; }
            if (r.effect.type === 'ws') { effect.url = r.effect.url; effect.message = r.effect.message || ''; }
            const rule = { id: 'r' + (i + 1), on, effect };
            if (r.followersOnly) rule.followersOnly = true;
            if (r.moderatorsOnly) rule.moderatorsOnly = true;
            return rule;
        }),
    };
}
function manifestToRules(m) {
    return ((m && m.rules) || []).map((rule) => {
        const event = { ...rule.on };
        // Normalise l'alias déprécié slot -> giftSlug pour l'édition.
        if (event.type === 'gift' && !event.giftSlug && event.slot) { event.giftSlug = event.slot; delete event.slot; }
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

async function loadLab() {
    await loadGiftCatalog();
    const mine = (await api.lab.myBundles()) || [];
    const sel = $('lab-bundle-sel');
    // Défaut = « — Nouveau bundle — » : on N'auto-charge PLUS un pack existant.
    sel.innerHTML = '<option value="">— Nouveau bundle —</option>'
        + mine.map((b) => `<option value="${esc(b.slug)}">${esc(b.slug)} (${esc(b.visibility)})</option>`).join('');
    sel.onchange = () => (sel.value ? loadLabBundle(sel.value) : startNewLab());
    sel.value = '';
    startNewLab();
}
/** État vierge : pas de pack sélectionné, une seule interaction prête à remplir. */
function startNewLab() {
    labCurrentSlug = null;
    labLatestVersion = null;
    labRules = [newRule()];
    $('lab-banner-preview').style.backgroundImage = '';
    if (labJsonMode) $('lab-manifest').value = JSON.stringify(buildManifest(), null, 2);
    else renderRules();
}
async function loadLabBundle(slug) {
    labCurrentSlug = slug;
    if (!slug) return startNewLab();
    const detail = await api.lab.detail(slug);
    const versions = (detail && detail.versions) || [];
    labLatestVersion = versions.length ? versions[0].version : null; // triées DESC
    const bundle = detail && detail.bundle;
    $('lab-banner-preview').style.backgroundImage = bundle && bundle.bannerUrl ? `url('${bundle.bannerUrl}')` : '';
    // Pack fraîchement créé (0 version) : on démarre avec une interaction vide.
    labRules = versions.length ? manifestToRules(versions[0].manifestJson) : [newRule()];
    if (labJsonMode) $('lab-manifest').value = JSON.stringify(buildManifest(), null, 2);
    else renderRules();
}

$('lab-create-btn').onclick = async () => {
    const dto = { slug: $('lab-slug').value.trim(), title: $('lab-title').value.trim(), game: $('lab-game').value.trim() || undefined, theme: $('lab-theme').value };
    try {
        await api.lab.create(dto);
        $('lab-msg').textContent = 'Pack créé : ' + dto.slug + ' — ajoute tes interactions puis publie.';
        $('lab-slug').value = '';
        $('lab-title').value = '';
        await loadLab();
        // Sélectionne le pack qu'on vient de créer (prêt à recevoir des interactions).
        $('lab-bundle-sel').value = dto.slug;
        await loadLabBundle(dto.slug);
    } catch (e) {
        $('lab-msg').textContent = 'Erreur : ' + e.message;
    }
};
$('lab-banner-btn').onclick = async () => {
    if (!labCurrentSlug) return ($('lab-msg2').textContent = "Crée/choisis un pack d'abord.");
    try {
        const r = await api.lab.uploadBanner(labCurrentSlug);
        if (r && r.bannerUrl) { $('lab-banner-preview').style.backgroundImage = `url('${r.bannerUrl}')`; $('lab-msg2').textContent = 'Bannière mise à jour ✓'; }
    } catch (e) { $('lab-msg2').textContent = 'Bannière : ' + e.message; }
};
$('lab-submit-btn').onclick = async () => {
    const slug = $('lab-bundle-sel').value;
    if (!slug) return ($('lab-msg2').textContent = "Crée un pack d'abord.");
    let manifest;
    if (labJsonMode) { try { manifest = JSON.parse($('lab-manifest').value); } catch { return ($('lab-msg2').textContent = 'JSON invalide.'); } }
    else manifest = buildManifest();
    const version = labLatestVersion ? bumpVersion(labLatestVersion, $('lab-bump').value) : '1.0.0';
    try {
        await api.lab.submitVersion(slug, { version, manifest });
        labLatestVersion = version;
        $('lab-msg2').textContent = `Version ${version} enregistrée ✓`;
    } catch (e) { $('lab-msg2').textContent = 'Refusé : ' + e.message; }
};
$('lab-publish-btn').onclick = async () => {
    const slug = $('lab-bundle-sel').value;
    if (!slug) return;
    try { await api.lab.publish(slug); $('lab-msg2').textContent = 'Publié (en modération) ✓'; }
    catch (e) { $('lab-msg2').textContent = 'Erreur : ' + e.message; }
};

// ── Mes bundles ──
async function loadMyBundles() {
    const mine = (await api.lab.myBundles()) || [];
    $('mine-list').innerHTML = mine.length
        ? mine
              .map(
                  (b) =>
                      `<div class="card"><div class="row between"><b>${b.title || b.slug}</b><span class="badge badge--off">${b.visibility}</span></div><p class="muted">${b.slug}${b.official ? ' · officiel' : ''} · installs ${b.installCount || 0}</p></div>`,
              )
              .join('')
        : '<p class="muted">Aucun bundle créé. Va dans le Lab pour en créer un.</p>';
}

// ── Settings ──
async function loadCaps() {
    const { capabilities } = await api.caps.get();
    const granted = new Set(capabilities);
    $('caps').innerHTML = '';
    CAPS.forEach(([key, label]) => {
        const row = document.createElement('div');
        row.className = 'cap-row';
        row.innerHTML = `<span>${label}</span>`;
        const t = document.createElement('input');
        t.type = 'checkbox';
        t.style.width = 'auto';
        t.checked = granted.has(key);
        t.onchange = () => (t.checked ? api.caps.grant(key) : api.caps.revoke(key));
        row.appendChild(t);
        $('caps').appendChild(row);
    });
}
$('lang').onchange = (e) => api.language(e.target.value);

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

// ── Boot ──
refreshAuth();
api.language().then((l) => ($('lang').value = l));
api.appVersion().then((v) => ($('app-ver').textContent = 'v' + v));
api.update.check(); // check silencieux au démarrage (installe en tâche de fond)
