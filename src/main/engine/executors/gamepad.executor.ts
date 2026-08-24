import { Executor, BundleEffect, GamepadEffect, FireContext } from '../types';
import { PythonSidecar } from '../python-sidecar';

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
        if (!e.button && !(e.sequence && e.sequence.length) && !(e.randomFrom && e.randomFrom.length)) {
            throw new Error('gamepad : button, sequence ou randomFrom manquant');
        }
    }

    async fire(effect: BundleEffect, _ctx: FireContext): Promise<void> {
        const e = effect as GamepadEffect;
        // Construit la liste des appuis : bouton simple, puis séquence, puis UN
        // bouton tiré au hasard (combo « ouvre le menu -> choisit une entrée »).
        const presses: string[] = [];
        if (e.button) presses.push(e.button);
        if (e.sequence?.length) presses.push(...e.sequence);
        if (e.randomFrom?.length) {
            presses.push(e.randomFrom[Math.floor(Math.random() * e.randomFrom.length)]);
        }
        const hold = Math.min(e.holdMs ?? 120, 2000);
        const gap = Math.min(Math.max(e.gapMs ?? 150, 0), 2000);
        for (let i = 0; i < presses.length; i++) {
            await this.sidecar().call('vigem-gamepad', { button: presses[i], holdMs: hold });
            if (i < presses.length - 1 && gap > 0) {
                await new Promise((r) => setTimeout(r, gap));
            }
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
