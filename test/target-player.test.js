'use strict';
// TU du CIBLAGE DE JOUEUR (dist/main/engine/…, compilé depuis les .ts).
// Runner : node --test.
//
// Plusieurs joueurs sur la même machine : le spectateur choisit à qui son
// cadeau s'applique. Deux maillons décident, et l'oubli de l'un donne un échec
// INDISCERNABLE D'UN SUCCÈS — tous les cadeaux arriveraient au joueur 1, l'app
// dirait « fired », et le pack serait accusé à tort.
//
//   1. `joueurVise` : le numéro reçu du serveur finit en INDEX DE MANETTE.
//   2. l'exécuteur manette : il doit poser `player` dans l'appel au sidecar.
const { test } = require('node:test');
const assert = require('node:assert');
const { joueurVise, MAX_JOUEURS } = require('../dist/main/engine/trigger-router.js');
const { GamepadExecutor } = require('../dist/main/engine/executors/gamepad.executor.js');

// ── 1. Bornage du numéro de joueur ───────────────────────────────────────
test('accepte les joueurs 1..8', () => {
    for (let i = 1; i <= MAX_JOUEURS; i++) assert.strictEqual(joueurVise(i), i);
});

test('REFUSE tout ce qui n’est pas un joueur exploitable', () => {
    // Le serveur valide déjà la cible, mais ce nombre devient un index de
    // manette : hors plage, mieux vaut l'ignorer (l'effet part au joueur par
    // défaut, comme avant) que de le deviner.
    for (const v of [0, -1, 9, 99, 1.5, NaN, Infinity, null, undefined, '', 'x', {}, []]) {
        assert.strictEqual(joueurVise(v), undefined, `${JSON.stringify(v)} aurait dû être refusé`);
    }
});

test('une chaîne numérique reste acceptée (le transport JSON peut la produire)', () => {
    assert.strictEqual(joueurVise('3'), 3);
});

// ── 2. L'exécuteur transmet-il vraiment la cible ? ───────────────────────
function executeurEspion() {
    const appels = [];
    const sidecar = { call: async (methode, args) => { appels.push({ methode, args }); return {}; } };
    // L'exécuteur reçoit un fournisseur de sidecar (il est résolu à chaud).
    const ex = new GamepadExecutor(() => sidecar);
    return { ex, appels };
}

const ctx = (extra = {}) => ({
    ruleId: 'r1', senderName: 'Q', isFollower: false, isModerator: false,
    quantity: 1, coins: 5, giftName: 'X', vars: {}, ...extra,
});

test('cible posée -> `player` part au sidecar', async () => {
    const { ex, appels } = executeurEspion();
    await ex.fire({ type: 'gamepad', button: 'A' }, ctx({ targetPlayer: 3 }));
    assert.strictEqual(appels.length, 1);
    assert.strictEqual(appels[0].methode, 'vigem-gamepad');
    assert.strictEqual(appels[0].args.player, 3);
});

test('CONTRE-TÉMOIN : sans cible, AUCUN `player` n’est envoyé', async () => {
    // Sans ce test, « player vaut 3 » pourrait être vrai parce qu'on l'écrit
    // toujours. Et l'absence est porteuse de sens : le sidecar prend alors le
    // joueur 1, c'est-à-dire le comportement d'avant le multi-manettes, que
    // tous les packs existants attendent.
    const { ex, appels } = executeurEspion();
    await ex.fire({ type: 'gamepad', button: 'A' }, ctx());
    assert.strictEqual(appels.length, 1);
    assert.ok(!('player' in appels[0].args), 'aucun player ne devait être posé');
});

test('la cible suit aussi le chemin ANALOGIQUE', async () => {
    // Deux chemins distincts dans `fire()` : les étapes et l'analogique. En
    // oublier un donnerait des cadeaux qui visent juste… sauf les sticks.
    const { ex, appels } = executeurEspion();
    await ex.fire({ type: 'gamepad', analog: { lx: 1 }, holdMs: 50 }, ctx({ targetPlayer: 5 }));
    assert.strictEqual(appels[0].args.player, 5);
    assert.ok(appels[0].args.analog, 'l’effet analogique doit être transmis');
});

test('deux joueurs différents -> deux appels distincts', async () => {
    // LE cas d'usage : ce qui doit se voir en recette, c'est deux joueurs qui
    // réagissent DIFFÉREMMENT. Un seul joueur qui réagit ne prouve rien.
    const { ex, appels } = executeurEspion();
    await ex.fire({ type: 'gamepad', button: 'A' }, ctx({ targetPlayer: 2 }));
    await ex.fire({ type: 'gamepad', button: 'A' }, ctx({ targetPlayer: 7 }));
    assert.deepStrictEqual(appels.map((a) => a.args.player), [2, 7]);
});
