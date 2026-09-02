#!/usr/bin/env node
'use strict';
/**
 * Extraction des chaines traduisibles de src/renderer/index.html.
 *
 * POURQUOI UN SCRIPT. Il y a ~200 chaines dans le HTML : les annoter a la main, c'est la
 * garantie d'en oublier, d'en casser, et de ne jamais pouvoir recommencer. Le script est
 * IDEMPOTENT (relancable apres une modif du HTML) et ne touche QUE :
 *   - le texte d'un element dont c'est le SEUL contenu (pas de balise imbriquee) ;
 *   - les attributs `title` et `placeholder`.
 * Tout element a contenu mixte est SAUTE et compte dans le rapport : mieux vaut une
 * couverture partielle mesuree qu'un HTML mange par une regexp trop gourmande.
 *
 * Sortie : index.html annote (data-i18n / data-i18n-title / data-i18n-ph)
 *          + src/renderer/locales/fr.json (le catalogue de reference).
 *
 * Usage : node scripts/i18n-extract.js [--dry]
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HTML = path.join(ROOT, 'src', 'renderer', 'index.html');
const OUT_DIR = path.join(ROOT, 'src', 'renderer', 'locales');
const DRY = process.argv.includes('--dry');

// Elements dont le texte n'est PAS de l'interface.
const SKIP_TAGS = new Set(['script', 'style', 'code', 'pre']);
// Un texte purement symbolique (fleches, croix, chiffres) n'a rien a traduire.
const HAS_WORD = /[A-Za-zÀ-ÿ]{2}/;

/** Cle stable et lisible depuis le texte francais : minuscule, sans accent, tirets. */
function slugify(txt) {
    return txt
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48) || 'txt';
}

function main() {
    let html = fs.readFileSync(HTML, 'utf8');
    const catalog = {};
    const used = new Set();
    let annotated = 0, skippedMixed = 0, already = 0;

    const keyFor = (txt) => {
        const b = slugify(txt);
        let k = b, i = 2;
        while (used.has(k) && catalog[k] !== txt) k = `${b}-${i++}`;
        used.add(k);
        catalog[k] = txt;
        return k;
    };

    // ── 1) Attributs title="" et placeholder="" ──
    for (const [attr, marker] of [['title', 'data-i18n-title'], ['placeholder', 'data-i18n-ph']]) {
        const re = new RegExp(`<([a-zA-Z][\\w-]*)([^>]*?)\\s${attr}="([^"]+)"`, 'g');
        html = html.replace(re, (m, tag, attrs, val) => {
            if (SKIP_TAGS.has(tag.toLowerCase()) || !HAS_WORD.test(val)) return m;
            if (m.includes(marker)) { already++; return m; }
            const k = keyFor(val.trim());
            return `<${tag}${attrs} ${marker}="${k}" ${attr}="${val}"`;
        });
    }

    // ── 2) Texte SEUL contenu d'un element ──
    // `[^<>]*` interdit toute balise imbriquee : un element a contenu mixte ne matche pas,
    // il est donc laisse tel quel (et compte comme saute).
    html = html.replace(/<([a-zA-Z][\w-]*)([^>]*)>([^<>]+)<\/\1>/g, (m, tag, attrs, txt) => {
        if (SKIP_TAGS.has(tag.toLowerCase())) return m;
        const trimmed = txt.trim();
        if (!trimmed || !HAS_WORD.test(trimmed)) return m;
        if (attrs.includes('data-i18n=')) { already++; return m; }
        const k = keyFor(trimmed);
        annotated++;
        return `<${tag}${attrs} data-i18n="${k}">${txt}</${tag}>`;
    });

    // Comptage des elements a contenu MIXTE qui portent du texte (non traduits) : c'est la
    // part que ce script ne sait pas prendre, et qu'il faut connaitre honnetement.
    const mixed = html.match(/<(p|span|div|b|label|h1|h2|h3|button)[^>]*>[^<>]*[A-Za-zÀ-ÿ]{3}[^<>]*<[a-zA-Z]/g);
    skippedMixed = mixed ? mixed.length : 0;

    if (!DRY) {
        fs.writeFileSync(HTML, html, 'utf8');
        fs.mkdirSync(OUT_DIR, { recursive: true });
        const sorted = {};
        for (const k of Object.keys(catalog).sort()) sorted[k] = catalog[k];
        fs.writeFileSync(path.join(OUT_DIR, 'fr.json'), JSON.stringify(sorted, null, 2) + '\n', 'utf8');
    }

    console.log(`cles extraites        : ${Object.keys(catalog).length}`);
    console.log(`elements annotes      : ${annotated}`);
    console.log(`deja annotes (rejeu)  : ${already}`);
    console.log(`contenu mixte SAUTE   : ${skippedMixed}  <- non traduit par ce script`);
    console.log(DRY ? '(--dry : rien ecrit)' : `ecrit : ${HTML} + ${path.join(OUT_DIR, 'fr.json')}`);
}

main();
