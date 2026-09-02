// Traduction de l'interface. UMD : expose window.HoulaI18n dans le navigateur (chargé par
// index.html AVANT renderer.js) ET module.exports pour les tests.
//
// POURQUOI CE FICHIER. Le sélecteur « Langue » des Réglages proposait fr/en/it/es/pt,
// écrivait le choix dans electron-store... et PERSONNE ne le relisait : toute l'interface
// était en français codé en dur, alors que le site annonce 5 langues. Constaté et corrigé
// le 2026-09-03.
//
// ⚠️ RÈGLE DE REPLI, non négociable : une clé absente ne doit JAMAIS afficher son nom à
// l'écran. On retombe sur le français, puis sur le texte déjà présent dans le DOM. Une
// traduction incomplète donne donc une interface partiellement traduite, jamais cassée.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.HoulaI18n = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const SUPPORTED = ['fr', 'en', 'it', 'es', 'pt'];
    let locale = 'fr';
    let dict = {};      // catalogue de la langue courante
    let base = {};      // catalogue français : repli systématique

    function setCatalogs(frCatalog, localeCatalog, lang) {
        base = frCatalog || {};
        dict = localeCatalog || {};
        locale = SUPPORTED.indexOf(lang) !== -1 ? lang : 'fr';
    }

    /**
     * Traduit une clé. `fallback` est le texte à utiliser si la clé est inconnue PARTOUT
     * (typiquement le texte déjà écrit dans le HTML). `vars` remplace les {jetons}.
     */
    function t(key, vars, fallback) {
        let s = dict[key];
        if (s == null) s = base[key];
        if (s == null) s = fallback != null ? fallback : key;
        if (vars) {
            s = String(s).replace(/\{(\w+)\}/g, function (m, k) {
                return Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m;
            });
        }
        return s;
    }

    /**
     * Applique les traductions au DOM.
     *   data-i18n="cle"            -> textContent
     *   data-i18n-title="cle"      -> attribut title
     *   data-i18n-ph="cle"         -> attribut placeholder
     * Le texte D'ORIGINE de l'element sert de repli : il est memorise au premier passage,
     * pour qu'un changement de langue ne le perde pas.
     */
    function apply(rootEl) {
        const r = rootEl || (typeof document !== 'undefined' ? document : null);
        if (!r || !r.querySelectorAll) return 0;
        let n = 0;
        r.querySelectorAll('[data-i18n]').forEach(function (el) {
            if (el.dataset.i18nOrig == null) el.dataset.i18nOrig = el.textContent;
            el.textContent = t(el.dataset.i18n, null, el.dataset.i18nOrig);
            n++;
        });
        r.querySelectorAll('[data-i18n-title]').forEach(function (el) {
            if (el.dataset.i18nTitleOrig == null) el.dataset.i18nTitleOrig = el.getAttribute('title') || '';
            el.setAttribute('title', t(el.dataset.i18nTitle, null, el.dataset.i18nTitleOrig));
            n++;
        });
        r.querySelectorAll('[data-i18n-ph]').forEach(function (el) {
            if (el.dataset.i18nPhOrig == null) el.dataset.i18nPhOrig = el.getAttribute('placeholder') || '';
            el.setAttribute('placeholder', t(el.dataset.i18nPh, null, el.dataset.i18nPhOrig));
            n++;
        });
        return n;
    }

    /** Couverture du catalogue courant, pour savoir ce qui reste a traduire (diagnostic). */
    function coverage() {
        const total = Object.keys(base).length;
        if (!total) return { locale: locale, total: 0, translated: 0, percent: 100 };
        let done = 0;
        for (const k in base) if (dict[k] != null && dict[k] !== '') done++;
        return { locale: locale, total: total, translated: done, percent: Math.round((done / total) * 100) };
    }

    return {
        SUPPORTED: SUPPORTED,
        setCatalogs: setCatalogs,
        t: t,
        apply: apply,
        coverage: coverage,
        get locale() { return locale; },
    };
});
