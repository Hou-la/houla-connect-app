import { Executor, BundleEffect, GamepadEffect, FireContext } from '../types';
import { PythonSidecar } from '../python-sidecar';

// Jeu de tokens CONNU du sidecar (_BUTTONS ∪ _TRIGGERS). Doit rester aligné avec
// resources/sidecar/houla_sidecar.py : un token hors de ce set plante au runtime
// (« bouton inconnu ») — on le rejette DÈS la validation, pas en plein live.
const GP_TOKENS = new Set([
    'A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT',
    'UP', 'DOWN', 'LEFT', 'RIGHT', 'START', 'BACK', 'LS', 'RS',
]);
function assertTokens(list: unknown, where: string): void {
    if (!Array.isArray(list)) return;
    for (const t of list) {
        if (typeof t !== 'string' || !GP_TOKENS.has(t)) {
            throw new Error(`gamepad : bouton inconnu « ${String(t)} » dans ${where}`);
        }
    }
}

// Exécuteur manette virtuelle : passe par le sidecar (helper vigem-gamepad, ViGEm).
// C'est la voie qui pilote les jeux refusant l'input clavier synthétique (Meccha).
export class GamepadExecutor implements Executor {
    readonly type = 'gamepad' as const;
    readonly capability = 'allowGamepad';
    readonly requiresCapability = true;
    readonly localConnectorType = 'gamepad';

    constructor(private readonly sidecar: () => PythonSidecar) {}

    validate(effect: BundleEffect): void {
        const e = effect as GamepadEffect;
        const has =
            e.button ||
            (e.buttons && e.buttons.length) ||
            (e.sequence && e.sequence.length) ||
            (e.randomFrom && e.randomFrom.length) ||
            (e.steps && e.steps.length) ||
            e.analog;
        if (!has) {
            throw new Error('gamepad : aucune action (button/buttons/sequence/randomFrom/steps/analog)');
        }
        // Tokens : rejet DÈS la validation (typos, noms PlayStation 'L2'/'TRIANGLE'…),
        // pour ne pas planter en plein live au moment du fire().
        if (e.button !== undefined) assertTokens([e.button], 'button');
        assertTokens(e.buttons, 'buttons');
        assertTokens(e.sequence, 'sequence');
        assertTokens(e.randomFrom, 'randomFrom');
        for (const s of e.steps ?? []) {
            if (s.button !== undefined) assertTokens([s.button], 'steps.button');
            assertTokens(s.buttons, 'steps.buttons');
        }
    }

    async fire(effect: BundleEffect, _ctx: FireContext): Promise<void> {
        const e = effect as GamepadEffect;
        const hold = Math.min(Math.max(e.holdMs ?? 120, 0), 10000);
        const gap = Math.min(Math.max(e.gapMs ?? 150, 0), 30000);
        // Répétition optionnelle (X fois, avec un intervalle entre chaque passe) —
        // honorée par TOUS les chemins (boutons/steps ET analogique).
        const repeat = Math.min(Math.max(e.repeat ?? 1, 1), 20);
        const repeatGap = Math.min(Math.max(e.repeatGapMs ?? 0, 0), 30000);

        // Analogique : stick/gâchette à une intensité, tenu holdMs, puis relâché.
        if (e.analog && typeof e.analog === 'object') {
            const analogHold = e.holdMs ?? 300;
            for (let r = 0; r < repeat; r++) {
                await this.sidecar().call('vigem-gamepad', { analog: e.analog, holdMs: analogHold }, analogHold);
                if (r < repeat - 1 && repeatGap > 0) await new Promise((res) => setTimeout(res, repeatGap));
            }
            return;
        }

        // Compile l'effet en TIMELINE d'étapes (le sidecar joue chaque étape :
        // presse l'ensemble simultané -> tient holdMs -> relâche -> attend waitMs).
        let steps: Array<{ buttons?: string[]; button?: string; holdMs?: number; waitMs?: number }>;
        if (e.steps?.length) {
            steps = e.steps.map((s) => ({
                buttons: s.buttons,
                button: s.button,
                holdMs: s.holdMs ?? hold,
                waitMs: s.waitMs,
            }));
        } else {
            steps = [];
            if (e.buttons?.length) {
                steps.push({ buttons: e.buttons, holdMs: hold }); // chord : tout ensemble
            } else {
                if (e.button) steps.push({ button: e.button, holdMs: hold });
                for (const b of e.sequence ?? []) steps.push({ button: b, holdMs: hold });
            }
            if (e.randomFrom?.length) {
                steps.push({ button: e.randomFrom[Math.floor(Math.random() * e.randomFrom.length)], holdMs: hold });
            }
            // gap entre deux étapes = waitMs sur chaque étape sauf la dernière.
            for (let i = 0; i < steps.length - 1; i++) steps[i].waitMs = gap;
        }
        if (!steps.length) return;

        // Le sidecar joue la timeline entière (maintiens + attentes) avant de répondre :
        // le timeout doit couvrir sa durée totale.
        const budget = steps.reduce((s, st) => s + (st.holdMs ?? hold) + (st.waitMs ?? 0), 0);
        for (let r = 0; r < repeat; r++) {
            await this.sidecar().call('vigem-gamepad', { steps }, budget);
            if (r < repeat - 1 && repeatGap > 0) await new Promise((res) => setTimeout(res, repeatGap));
        }
    }

    async releaseAll(): Promise<void> {
        try {
            await this.sidecar().call('vigem-gamepad', { release: true });
        } catch {
            /* noop */
        }
    }
}
