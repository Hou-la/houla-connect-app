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
        if (e.backend === 'interception') {
            // Pilotage bas niveau via le sidecar vérifié (helper interception-keys).
            await this.sidecar().call('interception-keys', { keys: e.keys });
            return;
        }
        await this.pressSpecNut(e.keys);
    }

    // ── nut.js : parse et exécute la key-spec ─────────────────────────
    private async pressSpecNut(spec: string): Promise<void> {
        const { keyboard, Key } = await import('@nut-tree-fork/nut-js');
        keyboard.config.autoDelayMs = 0;
        const resolve = (token: string): any => {
            const t = token.trim().toLowerCase();
            const named: Record<string, any> = {
                space: Key.Space, enter: Key.Enter, tab: Key.Tab, esc: Key.Escape,
                up: Key.Up, down: Key.Down, left: Key.Left, right: Key.Right,
                shift: Key.LeftShift, ctrl: Key.LeftControl, alt: Key.LeftAlt,
            };
            if (named[t]) return named[t];
            if (t.length === 1 && t >= 'a' && t <= 'z') return (Key as any)[t.toUpperCase()];
            if (t.length === 1 && t >= '0' && t <= '9') return (Key as any)['Num' + t];
            const fmatch = t.match(/^f([1-9]|1[0-2])$/);
            if (fmatch) return (Key as any)['F' + fmatch[1]];
            throw new Error(`touche inconnue "${token}"`);
        };
        for (const rawStep of String(spec).split(',')) {
            const [combo, holdMs] = rawStep.split(':');
            const keys = combo.split('+').map(resolve);
            if (holdMs) {
                await keyboard.pressKey(...keys);
                this.held.push(...keys);
                await sleep(Math.min(Number(holdMs) || 0, 2000));
                await keyboard.releaseKey(...keys);
                this.held = [];
            } else {
                await keyboard.type(...keys);
            }
            await sleep(40);
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
