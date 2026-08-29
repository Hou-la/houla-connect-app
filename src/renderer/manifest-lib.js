// Fonctions PURES du manifeste de bundle, extraites du renderer pour etre TESTABLES
// (elles n'ont aucune dependance au DOM). UMD : expose window.HoulaManifest dans le
// navigateur (charge par index.html AVANT renderer.js) ET module.exports pour les tests.
//
// Pourquoi ici : le bug de "perte de travail au Lab" venait d'une sauvegarde qui laissait
// un bundle orphelin quand le manifeste etait rejete par le serveur. validateManifestClient
// est le garde qui l'empeche ; le tester en CI evite toute regression silencieuse.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.HoulaManifest = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // Validation CLIENT du manifeste AVANT tout appel serveur. Le serveur est fail-closed
    // (un seul effet invalide rejette TOUT le manifeste). Retourne un message ou null.
    function validateManifestClient(m) {
        const rules = (m && m.rules) || [];
        if (!rules.length) return 'Ajoute au moins une interaction avant d\'enregistrer.';
        const empty = (v) => !String(v == null ? '' : v).trim();
        for (let i = 0; i < rules.length; i++) {
            const e = (rules[i] && rules[i].effect) || {};
            const n = 'Interaction ' + (i + 1);
            switch (e.type) {
                case 'keyboard': if (empty(e.keys)) return n + ' : la touche ou le combo clavier est vide.'; break;
                case 'rcon': if (empty(e.command)) return n + ' : la commande RCON est vide.'; break;
                case 'obs': if (empty(e.request)) return n + ' : la requête OBS est vide.'; break;
                case 'mqtt': if (empty(e.topic)) return n + ' : le topic MQTT est vide.'; break;
                case 'osc': if (empty(e.address)) return n + ' : l\'adresse OSC est vide.'; break;
                case 'http': if (empty(e.method)) return n + ' : la méthode HTTP est vide.'; break;
                case 'python': if (!e.helper) return n + ' : helper Python manquant.'; break;
                case undefined: case '': return n + ' : le type d\'action est manquant.';
                default: break; // gamepad (défaut bouton A garanti) / ws (message optionnel)
            }
        }
        return null;
    }

    // Manifeste (rules) -> modele d'edition du Lab (aller-retour avec buildRule/buildManifest).
    function manifestToRules(m) {
        return ((m && m.rules) || []).map(function (rule) {
            const event = Object.assign({}, rule.on);
            // Normalise l'alias deprecie slot -> giftSlug pour l'edition.
            if (event.type === 'gift' && !event.giftSlug && event.slot) { event.giftSlug = event.slot; delete event.slot; }
            // Un slug de slot reserve -> vue "Cadeau personnalise" ; sinon "Cadeau".
            if (event.type === 'gift' && /^ix_slot_\d{2}$/.test(event.giftSlug || '')) event.type = 'gift-custom';
            return {
                event: event,
                effect: Object.assign({}, rule.effect),
                label: rule.label || '',
                followersOnly: !!rule.followersOnly,
                moderatorsOnly: !!rule.moderatorsOnly,
            };
        });
    }

    // Serialisation canonique deterministe (cles triees) : DOIT etre identique au
    // canonicalize serveur/executeur (sha256 du manifeste canonicalise = contentHash signe).
    function canonicalize(value) {
        if (value === null || typeof value !== 'object') return JSON.stringify(value);
        if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
        const keys = Object.keys(value).sort();
        return '{' + keys.map(function (k) { return JSON.stringify(k) + ':' + canonicalize(value[k]); }).join(',') + '}';
    }

    // ── Résolution de la touche capturée -> token de la key-spec ──────────────
    // Symboles rangée principale (repli si e.code absent) : « + » « , » « : » sont les
    // séparateurs de la grammaire et casseraient le spec bruts.
    const KB_SYMBOL = {
        '+': 'plus', '-': 'minus', '=': 'equal', ',': 'comma', '.': 'period',
        '/': 'slash', ';': 'semicolon', "'": 'quote', '\\': 'backslash',
        '[': 'bracketleft', ']': 'bracketright', '`': 'grave', ':': 'semicolon',
    };
    // e.code = touche PHYSIQUE (indépendante de Maj/disposition) : distingue le « + » du
    // PAVÉ de celui de la rangée du haut, et reste stable entre keydown/keyup.
    const KB_CODE = {
        Equal: 'equal', Minus: 'minus', Comma: 'comma', Period: 'period', Slash: 'slash',
        Semicolon: 'semicolon', Quote: 'quote', Backslash: 'backslash',
        BracketLeft: 'bracketleft', BracketRight: 'bracketright', Backquote: 'grave',
        Backspace: 'backspace', Delete: 'delete', Home: 'home', End: 'end',
        PageUp: 'pageup', PageDown: 'pagedown', Insert: 'insert',
        NumpadAdd: 'numadd', NumpadSubtract: 'numsubtract', NumpadMultiply: 'nummultiply',
        NumpadDivide: 'numdivide', NumpadDecimal: 'numdecimal', NumpadEnter: 'enter',
    };
    // Convertit un event clavier ({key, code}) en token de key-spec. Échap -> 'esc'
    // (l'exécuteur ne connaît pas 'escape'), pavé numérique distinct, etc.
    function kbToken(e) {
        const k = e.key;
        if (k === 'Control') return 'ctrl';
        if (k === 'Shift') return 'shift';
        if (k === 'Alt') return 'alt';
        if (k === 'Meta') return 'meta';
        if (k === 'Escape') return 'esc';
        if (k === ' ') return 'space';
        if (k.startsWith('Arrow')) return k.slice(5).toLowerCase();
        const code = e.code || '';
        if (KB_CODE[code]) return KB_CODE[code];
        if (/^Numpad[0-9]$/.test(code)) return 'num' + code.slice(6);
        if (KB_SYMBOL[k]) return KB_SYMBOL[k];
        return k.toLowerCase();
    }

    return { validateManifestClient: validateManifestClient, manifestToRules: manifestToRules, canonicalize: canonicalize, kbToken: kbToken };
});
