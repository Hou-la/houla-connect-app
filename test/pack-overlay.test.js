'use strict';
// TU du CALQUE LOCAL d'un pack (dist/main/engine/pack-overlay.js, compilé depuis le .ts).
// Runner : node --test.
//
// Ce fichier porte une FRONTIÈRE DE SÉCURITÉ, pas seulement du confort : le joueur peut
// remapper la touche d'une interaction, mais il ne doit JAMAIS pouvoir changer le TYPE de
// l'effet. Sinon, éditer un fichier de config local suffirait à transformer une action
// clavier d'un pack signé en commande RCON ou en appel HTTP vers n'importe quel hôte.
const { test } = require('node:test');
const assert = require('node:assert');
const { applyPackOverlay, resolveActiveProfile } = require('../dist/main/engine/pack-overlay.js');

const M = (rules, profiles) => {
    const m = { schema: 2, slug: 'demo', rules };
    if (profiles) m.profiles = profiles;
    return m;
};
const O = (o = {}) => ({ disabled: [], cooldownMs: {}, ...o });

// ── Frontière de sécurité ────────────────────────────────────────────────
test('un remappage ne peut PAS changer le type d’effet (clavier -> rcon refusé)', () => {
    const m = M([{ id: 'r1', on: { type: 'follow' }, effect: { type: 'keyboard', keys: 'space' } }]);
    // Calque forgé à la main (fichier de config édité) : il tente d'injecter une commande.
    const out = applyPackOverlay(m, O({ keyBindings: { r1: { type: 'rcon', command: 'op pirate', keys: 'f' } } }));
    assert.strictEqual(out.rules[0].effect.type, 'keyboard'); // le type reste celui du manifeste signé
    assert.strictEqual(out.rules[0].effect.command, undefined); // aucune commande injectée
    assert.strictEqual(out.rules[0].effect.keys, 'f'); // seule la touche a bougé
});

test('un remappage de BOUTON ne s’applique pas à un effet clavier, et inversement', () => {
    const m = M([
        { id: 'k', on: { type: 'follow' }, effect: { type: 'keyboard', keys: 'space' } },
        { id: 'g', on: { type: 'follow' }, effect: { type: 'gamepad', button: 'A' } },
    ]);
    const out = applyPackOverlay(m, O({ keyBindings: { k: { button: 'Y' }, g: { keys: 'f' } } }));
    assert.strictEqual(out.rules[0].effect.keys, 'space'); // inchangé : mauvais champ
    assert.strictEqual(out.rules[0].effect.button, undefined);
    assert.strictEqual(out.rules[1].effect.button, 'A'); // inchangé : mauvais champ
});

test('un effet RÉSEAU ne se remappe jamais', () => {
    for (const effect of [
        { type: 'rcon', command: 'weather clear' },
        { type: 'http', method: 'POST', url: 'https://ok.example.com/' },
        { type: 'obs', request: 'SetCurrentProgramScene' },
    ]) {
        const m = M([{ id: 'n', on: { type: 'follow' }, effect }]);
        const out = applyPackOverlay(m, O({ keyBindings: { n: { keys: 'f', button: 'Y' } } }));
        assert.deepStrictEqual(out.rules[0].effect, effect, `${effect.type} ne doit pas bouger`);
    }
});

test('une valeur de remappage vide ou non-chaîne est ignorée', () => {
    const m = M([{ id: 'r1', on: { type: 'follow' }, effect: { type: 'keyboard', keys: 'space' } }]);
    for (const bad of [{ keys: '' }, { keys: '   ' }, { keys: 42 }, { keys: null }, {}]) {
        const out = applyPackOverlay(m, O({ keyBindings: { r1: bad } }));
        assert.strictEqual(out.rules[0].effect.keys, 'space', `refusé pour ${JSON.stringify(bad)}`);
    }
});

// ── Comportement fonctionnel ─────────────────────────────────────────────
test('remapper une touche clavier et un bouton manette', () => {
    const m = M([
        { id: 'k', on: { type: 'follow' }, effect: { type: 'keyboard', keys: 'space' } },
        { id: 'g', on: { type: 'follow' }, effect: { type: 'gamepad', button: 'A' } },
    ]);
    const out = applyPackOverlay(m, O({ keyBindings: { k: { keys: 'shift+f' }, g: { button: 'Y' } } }));
    assert.strictEqual(out.rules[0].effect.keys, 'shift+f');
    assert.strictEqual(out.rules[1].effect.button, 'Y');
});

test('un bouton simple REMPLACE une action manette avancée (pas de mélange incohérent)', () => {
    // Sans ce nettoyage, l'effet porterait à la fois `analog` et `button` : l'exécuteur
    // jouerait l'analogique et le joueur croirait avoir remappé un bouton.
    const m = M([{ id: 'g', on: { type: 'follow' }, effect: { type: 'gamepad', analog: { ly: 1 }, holdMs: 300 } }]);
    const out = applyPackOverlay(m, O({ keyBindings: { g: { button: 'B' } } }));
    assert.strictEqual(out.rules[0].effect.button, 'B');
    assert.strictEqual(out.rules[0].effect.analog, undefined);
    assert.strictEqual(out.rules[0].effect.holdMs, 300); // les réglages de durée survivent
});

test('le manifeste d’origine n’est JAMAIS muté', () => {
    const effect = { type: 'keyboard', keys: 'space' };
    const m = M([{ id: 'r1', on: { type: 'follow' }, effect }]);
    applyPackOverlay(m, O({ keyBindings: { r1: { keys: 'f' } }, cooldownMs: { r1: 900 } }));
    assert.strictEqual(effect.keys, 'space');
    assert.strictEqual(effect.cooldownMs, undefined);
});

test('désactivation et cooldown continuent de marcher (aucune régression)', () => {
    const m = M([
        { id: 'a', on: { type: 'follow' }, effect: { type: 'keyboard', keys: 'a' } },
        { id: 'b', on: { type: 'follow' }, effect: { type: 'keyboard', keys: 'b' } },
    ]);
    const out = applyPackOverlay(m, O({ disabled: ['a'], cooldownMs: { b: 1500 } }));
    assert.strictEqual(out.rules.length, 1);
    assert.strictEqual(out.rules[0].id, 'b');
    assert.strictEqual(out.rules[0].effect.cooldownMs, 1500);
});

// ── Configurations de commandes ──────────────────────────────────────────
test('seule la configuration active est gardée ; une règle sans profile reste commune', () => {
    const m = M(
        [
            { id: 'k', on: { type: 'follow' }, effect: { type: 'keyboard', keys: 'a' }, profile: 'clavier' },
            { id: 'g', on: { type: 'follow' }, effect: { type: 'gamepad', button: 'A' }, profile: 'manette' },
            { id: 'o', on: { type: 'follow' }, effect: { type: 'obs', request: 'X' } },
        ],
        [{ id: 'clavier', label: 'Clavier', default: true }, { id: 'manette', label: 'Manette' }],
    );
    assert.deepStrictEqual(applyPackOverlay(m, O()).rules.map((r) => r.id), ['k', 'o']);
    assert.deepStrictEqual(applyPackOverlay(m, O({ profile: 'manette' })).rules.map((r) => r.id), ['g', 'o']);
    // profil inconnu -> on retombe sur le défaut, jamais sur un pack vide
    assert.deepStrictEqual(applyPackOverlay(m, O({ profile: 'volant' })).rules.map((r) => r.id), ['k', 'o']);
});

test('resolveActiveProfile : défaut, premier, ou null si le pack n’en déclare aucun', () => {
    assert.strictEqual(resolveActiveProfile(M([])), null);
    assert.strictEqual(resolveActiveProfile(M([], [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }])), 'a');
    assert.strictEqual(resolveActiveProfile(M([], [{ id: 'a', label: 'A' }, { id: 'b', label: 'B', default: true }])), 'b');
    assert.strictEqual(resolveActiveProfile(M([], [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]), 'b'), 'b');
});
