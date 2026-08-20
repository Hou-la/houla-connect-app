'use strict';
const api = window.houlaConnect;
const $ = (id) => document.getElementById(id);
const CAPS = [
    ['allowKeyboard', 'Clavier (nut.js)'],
    ['allowGamepad', 'Manette virtuelle (ViGEm)'],
    ['allowPythonDriver', 'Pilotage bas niveau (Interception/ViGEm)'],
    ['allowRcon', 'RCON (Minecraft…)'],
    ['allowObs', 'OBS'],
    ['allowHttp', 'HTTP / domotique'],
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
async function loadWorkspaces() {
    const [list, current] = await Promise.all([api.listWorkspaces(), api.currentWorkspace()]);
    const sel = $('ws-select');
    sel.innerHTML = '';
    (list || []).forEach((ws) => {
        const o = document.createElement('option');
        o.value = ws.id;
        o.textContent = ws.name || ws.slug || ws.id;
        sel.appendChild(o);
    });
    if (current && current.id && [...sel.options].some((o) => o.value === current.id)) {
        sel.value = current.id;
    } else if (list && list.length) {
        sel.value = list[0].id;
        await api.selectWorkspace({ id: list[0].id, name: list[0].name || '' });
    }
    sel.onchange = async () => {
        const ws = (list || []).find((w) => w.id === sel.value);
        await api.selectWorkspace({ id: sel.value, name: (ws && ws.name) || '' });
        api.engine.stop();
        await loadInstalled();
    };
}

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
    if (name === 'mine') loadInstalled(true);
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
    if (toMine) {
        $('mine-list').innerHTML = installed.length
            ? installed.map((b) => `<div class="card"><b>${b.slug}</b> — v${b.version}</div>`).join('')
            : '<p class="muted">Aucun bundle installé.</p>';
    }
}
$('btn-start').onclick = async () => {
    const slug = $('active-bundle').value;
    if (!slug) return;
    try { await api.engine.start(slug); } catch (e) { logLine({ allowed: false, reason: e.message, ruleId: 'start' }); }
};
$('btn-stop').onclick = () => api.engine.stop();
$('btn-test').onclick = () => api.engine.test('ix_slot_01');
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
async function loadStore() {
    const list = (await api.store.list()) || [];
    $('store-list').innerHTML = '';
    list.forEach((b) => {
        const card = document.createElement('div');
        card.className = 'bundle-card';
        card.innerHTML = `<div class="bundle-card__body">
            <h3>${b.title || b.slug}</h3>
            <p class="muted">${b.game || b.theme || ''}</p>
            <button class="btn btn--primary" data-slug="${b.slug}">Installer</button>
        </div>`;
        card.querySelector('button').onclick = async (e) => {
            e.target.textContent = '…';
            try {
                const r = await api.store.install(b.slug);
                e.target.textContent = 'Installé';
                await loadInstalled();
            } catch (err) {
                e.target.textContent = 'Échec';
            }
        };
        $('store-list').appendChild(card);
    });
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

// ── Boot ──
refreshAuth();
api.language().then((l) => ($('lang').value = l));
api.appVersion().then((v) => ($('app-ver').textContent = 'v' + v));
