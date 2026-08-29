'use strict';
// TU du module partagé manifest-lib (fonctions pures du manifeste de bundle).
// Runner : node --test (intégré, zéro dépendance).
const { test } = require('node:test');
const assert = require('node:assert');
const M = require('../src/renderer/manifest-lib.js');

// ─────────────────────────────────────────────────────────────────────────
// validateManifestClient — LE garde qui empêche le bundle "orphelin" (perte de
// travail). Ce bloc de tests aurait rendu ROUGE le bug remonté par l'utilisateur.
// ─────────────────────────────────────────────────────────────────────────
test('validateManifestClient : manifeste vide (aucune règle) rejeté', () => {
    assert.match(M.validateManifestClient({ schema: 2, rules: [] }), /au moins une interaction/i);
    assert.match(M.validateManifestClient({}), /au moins une interaction/i);
    assert.match(M.validateManifestClient(null), /au moins une interaction/i);
});

test('validateManifestClient : effet clavier avec keys vide rejeté (le déclencheur du bug)', () => {
    const m = { rules: [{ on: { type: 'gift', giftSlug: 'x' }, effect: { type: 'keyboard', keys: '' } }] };
    assert.match(M.validateManifestClient(m), /clavier est vide/i);
    // keys uniquement des espaces = toujours vide
    m.rules[0].effect.keys = '   ';
    assert.match(M.validateManifestClient(m), /clavier est vide/i);
});

test('validateManifestClient : clavier avec une vraie touche accepté', () => {
    const m = { rules: [{ on: { type: 'gift', giftSlug: 'x' }, effect: { type: 'keyboard', keys: 'space' } }] };
    assert.strictEqual(M.validateManifestClient(m), null);
});

test('validateManifestClient : rcon/obs/mqtt/osc/http vides rejetés', () => {
    const cases = [
        [{ type: 'rcon', command: '' }, /RCON/i],
        [{ type: 'obs', request: '' }, /OBS/i],
        [{ type: 'mqtt', topic: '' }, /MQTT/i],
        [{ type: 'osc', address: '' }, /OSC/i],
        [{ type: 'http', method: '' }, /HTTP/i],
        [{ type: 'python' /* helper manquant */ }, /Python/i],
        [{ /* type manquant */ }, /type d'action/i],
    ];
    for (const [effect, re] of cases) {
        assert.match(M.validateManifestClient({ rules: [{ on: { type: 'gift' }, effect }] }), re);
    }
});

test('validateManifestClient : gamepad accepté même minimal (défaut bouton A garanti côté build)', () => {
    // Le validateur ne DOIT PAS rejeter un gamepad : buildRule garantit toujours un bouton.
    assert.strictEqual(M.validateManifestClient({ rules: [{ on: { type: 'gift' }, effect: { type: 'gamepad', button: 'UP' } }] }), null);
    assert.strictEqual(M.validateManifestClient({ rules: [{ on: { type: 'gift' }, effect: { type: 'gamepad' } }] }), null);
});

test('validateManifestClient : rejette la PREMIÈRE règle fautive, en indiquant son numéro', () => {
    const m = { rules: [
        { on: { type: 'gift' }, effect: { type: 'keyboard', keys: 'a' } },
        { on: { type: 'gift' }, effect: { type: 'rcon', command: '' } },
    ] };
    assert.match(M.validateManifestClient(m), /Interaction 2/);
});

// ─────────────────────────────────────────────────────────────────────────
// manifestToRules — aller-retour manifeste <-> modèle d'édition (intégrité des données)
// ─────────────────────────────────────────────────────────────────────────
test('manifestToRules : préserve on/effect/label/flags', () => {
    const m = { rules: [{
        on: { type: 'comment', contains: 'gg' },
        effect: { type: 'keyboard', keys: 'shift+a', backend: 'nut' },
        label: 'Bravo', followersOnly: true, moderatorsOnly: false,
    }] };
    const rules = M.manifestToRules(m);
    assert.strictEqual(rules.length, 1);
    assert.deepStrictEqual(rules[0].event, { type: 'comment', contains: 'gg' });
    assert.deepStrictEqual(rules[0].effect, { type: 'keyboard', keys: 'shift+a', backend: 'nut' });
    assert.strictEqual(rules[0].label, 'Bravo');
    assert.strictEqual(rules[0].followersOnly, true);
    assert.strictEqual(rules[0].moderatorsOnly, false);
});

test('manifestToRules : normalise l\'alias déprécié slot -> giftSlug', () => {
    const rules = M.manifestToRules({ rules: [{ on: { type: 'gift', slot: 'coal' }, effect: { type: 'rcon', command: 'x' } }] });
    assert.strictEqual(rules[0].event.giftSlug, 'coal');
    assert.strictEqual(rules[0].event.slot, undefined);
});

test('manifestToRules : un slot réservé ix_slot_NN devient la vue "gift-custom"', () => {
    const rules = M.manifestToRules({ rules: [{ on: { type: 'gift', giftSlug: 'ix_slot_01' }, effect: { type: 'rcon', command: 'x' } }] });
    assert.strictEqual(rules[0].event.type, 'gift-custom');
    // un slug normal reste "gift"
    const rules2 = M.manifestToRules({ rules: [{ on: { type: 'gift', giftSlug: 'heart_kawaii' }, effect: { type: 'rcon', command: 'x' } }] });
    assert.strictEqual(rules2[0].event.type, 'gift');
});

test('manifestToRules : manifeste vide -> []', () => {
    assert.deepStrictEqual(M.manifestToRules({ rules: [] }), []);
    assert.deepStrictEqual(M.manifestToRules({}), []);
    assert.deepStrictEqual(M.manifestToRules(null), []);
});

// ─────────────────────────────────────────────────────────────────────────
// canonicalize — DOIT être déterministe (indépendant de l'ordre des clés) : le
// contentHash signé en dépend. Une divergence casserait la vérification des bundles.
// ─────────────────────────────────────────────────────────────────────────
test('canonicalize : indépendant de l\'ordre des clés', () => {
    assert.strictEqual(M.canonicalize({ b: 1, a: 2 }), M.canonicalize({ a: 2, b: 1 }));
    assert.strictEqual(M.canonicalize({ a: 2, b: 1 }), '{"a":2,"b":1}');
});

test('canonicalize : tableaux, imbrication, primitives', () => {
    assert.strictEqual(M.canonicalize([3, { y: 1, x: 2 }, 'z']), '[3,{"x":2,"y":1},"z"]');
    assert.strictEqual(M.canonicalize(null), 'null');
    assert.strictEqual(M.canonicalize('a'), '"a"');
    assert.strictEqual(M.canonicalize(42), '42');
});

test('canonicalize : deux manifestes sémantiquement identiques -> même chaîne', () => {
    const m1 = { schema: 2, rules: [{ id: 'r1', on: { type: 'gift', giftSlug: 'x' }, effect: { type: 'keyboard', keys: 'a' } }] };
    const m2 = { rules: [{ effect: { keys: 'a', type: 'keyboard' }, on: { giftSlug: 'x', type: 'gift' }, id: 'r1' }], schema: 2 };
    assert.strictEqual(M.canonicalize(m1), M.canonicalize(m2));
});
