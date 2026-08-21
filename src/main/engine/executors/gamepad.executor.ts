import { Executor, BundleEffect, GamepadEffect, FireContext } from '../types';
import { PythonSidecar } from '../python-sidecar';

// Exécuteur manette virtuelle : passe par le sidecar (helper vigem-gamepad, ViGEm).
// C'est la voie qui pilote les jeux refusant l'input clavier synthétique (Meccha).
export class GamepadExecutor implements Executor {
    readonly type = 'gamepad' as const;
    readonly capability = 'allowGamepad';
    readonly requiresCapability = true;

    constructor(private readonly sidecar: () => PythonSidecar) {}

    validate(effect: BundleEffect): void {
        const e = effect as GamepadEffect;
        if (!e.button) throw new Error('gamepad.button manquant');
    }

    async fire(effect: BundleEffect, _ctx: FireContext): Promise<void> {
        const e = effect as GamepadEffect;
        await this.sidecar().call('vigem-gamepad', {
            button: e.button,
            holdMs: Math.min(e.holdMs ?? 120, 2000),
        });
    }

    async releaseAll(): Promise<void> {
        try {
            await this.sidecar().call('vigem-gamepad', { release: true });
        } catch {
            /* noop */
        }
    }
}
