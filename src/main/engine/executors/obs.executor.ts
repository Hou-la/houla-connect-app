import { Executor, BundleEffect, ObsEffect, FireContext } from '../types';
import { resolveDeep } from '../substitute';

export interface ObsConfig {
    url: string; // ws://127.0.0.1:4455
    password?: string;
}

// Exécuteur OBS (obs-websocket v5). Connexion lazy réutilisée.
export class ObsExecutor implements Executor {
    readonly type = 'obs' as const;
    readonly capability = 'allowObs';
    private obs: any = null;
    private connecting: Promise<any> | null = null;

    constructor(private readonly getConfig: () => ObsConfig | null) {}

    validate(effect: BundleEffect): void {
        const e = effect as ObsEffect;
        if (!e.request) throw new Error('obs.request manquant');
    }

    private async connect(): Promise<any> {
        if (this.obs) return this.obs;
        if (this.connecting) return this.connecting;
        const cfg = this.getConfig();
        if (!cfg?.url) throw new Error('OBS non configuré (url ws://…:4455)');
        const OBSWebSocket = (await import('obs-websocket-js')).default;
        const obs = new OBSWebSocket();
        this.connecting = obs
            .connect(cfg.url, cfg.password)
            .then(() => {
                this.obs = obs;
                obs.on('ConnectionClosed', () => (this.obs = null));
                return obs;
            })
            .finally(() => (this.connecting = null));
        return this.connecting;
    }

    async fire(effect: BundleEffect, ctx: FireContext): Promise<void> {
        const e = effect as ObsEffect;
        const params = e.params ? (resolveDeep(e.params, ctx) as Record<string, unknown>) : undefined;
        const obs = await this.connect();
        await obs.call(e.request, params);
    }

    async dispose(): Promise<void> {
        try {
            await this.obs?.disconnect();
        } catch {
            /* noop */
        }
        this.obs = null;
    }
}
