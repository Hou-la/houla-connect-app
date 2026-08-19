import { Executor, BundleEffect, PythonEffect, FireContext } from '../types';
import { PythonSidecar, SidecarHelper } from '../python-sidecar';
import { resolveDeep } from '../substitute';

const HELPERS: SidecarHelper[] = ['interception-keys', 'vigem-gamepad'];

// Exécuteur python : appelle un HELPER VÉRIFIÉ du sidecar (énum fermée), avec des
// args déclaratifs. Jamais un chemin de script, jamais du code d'auteur.
export class PythonExecutor implements Executor {
    readonly type = 'python' as const;
    readonly capability = 'allowPythonDriver';

    constructor(private readonly sidecar: () => PythonSidecar) {}

    validate(effect: BundleEffect): void {
        const e = effect as PythonEffect;
        if (!HELPERS.includes(e.helper)) throw new Error(`python.helper non vérifié: ${e.helper}`);
    }

    async fire(effect: BundleEffect, ctx: FireContext): Promise<void> {
        const e = effect as PythonEffect;
        const args = (e.args ? resolveDeep(e.args, ctx) : {}) as Record<string, unknown>;
        await this.sidecar().call(e.helper, args);
    }
}
