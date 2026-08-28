import { Executor, BundleEffect, KeyboardEffect, FireContext } from '../types';
import { PythonSidecar } from '../python-sidecar';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Exécuteur clavier. backend 'auto'/'nut' => nut.js (SendInput). backend
// 'interception' => sidecar Python (driver bas niveau, pour les jeux qui ignorent
// l'input synthétique comme Meccha). Grammaire de key-spec :
//   'space' | 'shift+c' | 'c,c,c' | 'space:400'
export class KeyboardExecutor implements Executor {
    readonly type = 'keyboard' as const;
    readonly capability = 'allowKeyboard';
    readonly requiresCapability = true;
    readonly localConnectorType = 'keyboard';
    private held: any[] = [];

    constructor(private readonly sidecar: () => PythonSidecar) {}

    validate(effect: BundleEffect): void {
        const e = effect as KeyboardEffect;
        if (!e.keys) throw new Error('keyboard.keys manquant');
    }

    async fire(effect: BundleEffect, _ctx: FireContext): Promise<void> {
        const e = effect as KeyboardEffect;
        // Délai (ms) entre chaque touche d'une SUITE (rythme). Défaut 40, borné.
        const gap = Math.min(Math.max(e.gapMs ?? 40, 0), 5000);
        if (e.backend === 'interception') {
            // Pilotage bas niveau via le sidecar vérifié (helper interception-keys).
            // Le sidecar répond à la FIN : le timeout doit couvrir (hold max + gap) par étape.
            const steps = String(e.keys).split(',').length;
            const budget = steps * (2000 + gap);
            await this.sidecar().call('interception-keys', { keys: e.keys, gapMs: gap }, budget);
            return;
        }
        await this.pressSpecNut(e.keys, gap);
    }

    // ── nut.js : parse et exécute la key-spec ─────────────────────────
    private async pressSpecNut(spec: string, gap: number): Promise<void> {
        const { keyboard, Key } = await import('@nut-tree-fork/nut-js');
        keyboard.config.autoDelayMs = 0;
        const resolve = (token: string): any => {
            const t = token.trim().toLowerCase();
            const named: Record<string, any> = {
                space: Key.Space, enter: Key.Enter, tab: Key.Tab,
                esc: Key.Escape, escape: Key.Escape, // les deux alias (la capture émet 'esc')
                up: Key.Up, down: Key.Down, left: Key.Left, right: Key.Right,
                shift: Key.LeftShift, ctrl: Key.LeftControl, alt: Key.LeftAlt,
                meta: Key.LeftSuper, backspace: Key.Backspace, delete: Key.Delete,
                home: Key.Home, end: Key.End, pageup: Key.PageUp, pagedown: Key.PageDown,
                insert: Key.Insert,
                // Symboles rangée principale (le « + » littéral casserait le séparateur de combo).
                plus: Key.Add, minus: Key.Minus, equal: Key.Equal,
                comma: Key.Comma, period: Key.Period, slash: Key.Slash,
                semicolon: Key.Semicolon, quote: Key.Quote, backslash: Key.Backslash,
                bracketleft: Key.LeftBracket, bracketright: Key.RightBracket, grave: Key.Grave,
                // Pavé numérique : identité PHYSIQUE distincte de la rangée principale (un jeu
                // lit le scancode, numpad '+' ≠ '+' de la rangée du haut).
                numadd: Key.Add, numsubtract: Key.Subtract, nummultiply: Key.Multiply,
                numdivide: Key.Divide, numdecimal: Key.Decimal,
                num0: Key.NumPad0, num1: Key.NumPad1, num2: Key.NumPad2, num3: Key.NumPad3,
                num4: Key.NumPad4, num5: Key.NumPad5, num6: Key.NumPad6, num7: Key.NumPad7,
                num8: Key.NumPad8, num9: Key.NumPad9,
            };
            // `t in named` et NON `named[t]` : Key.Escape === 0 est falsy → échap serait avalée.
            if (t in named) return named[t];
            if (t.length === 1 && t >= 'a' && t <= 'z') return (Key as any)[t.toUpperCase()];
            if (t.length === 1 && t >= '0' && t <= '9') return (Key as any)['Num' + t];
            const fmatch = t.match(/^f([1-9]|1[0-2])$/);
            if (fmatch) return (Key as any)['F' + fmatch[1]];
            throw new Error(`touche inconnue "${token}"`);
        };
        for (const rawStep of String(spec).split(',')) {
            if (!rawStep.trim()) continue; // étape vide (virgule en trop) : on l'ignore
            const [combo, holdMs] = rawStep.split(':');
            const tokens = combo.split('+').map((s) => s.trim()).filter(Boolean);
            if (!tokens.length) continue; // « :400 » nu (maintien sans touche) : rien à presser
            const keys = tokens.map(resolve);
            if (holdMs) {
                await keyboard.pressKey(...keys);
                this.held.push(...keys);
                await sleep(Math.min(Number(holdMs) || 0, 2000));
                await keyboard.releaseKey(...keys);
                this.held = [];
            } else {
                await keyboard.type(...keys);
            }
            await sleep(gap);
        }
    }

    async releaseAll(): Promise<void> {
        if (!this.held.length) return;
        try {
            const { keyboard } = await import('@nut-tree-fork/nut-js');
            await keyboard.releaseKey(...this.held);
        } catch {
            /* noop */
        }
        this.held = [];
    }
}
