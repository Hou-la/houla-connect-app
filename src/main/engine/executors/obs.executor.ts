import { Executor, BundleEffect, ObsEffect, FireContext } from '../types';
import { resolveDeep } from '../substitute';

export interface ObsConfig {
    url: string; // ws://127.0.0.1:4455
    password?: string;
}

// Exécuteur OBS (obs-websocket v5). Connexions réutilisées PAR url (plusieurs OBS possibles).
export class ObsExecutor implements Executor {
    readonly type = 'obs' as const;
    readonly capability = 'allowObs';
    readonly requiresCapability = false;
    private clients = new Map<string, any>();

    constructor(private readonly getConfig: () => ObsConfig | null) {}

    validate(effect: BundleEffect): void {
        if (!(effect as ObsEffect).request) throw new Error('obs.request manquant');
    }

    private resolve(ctx: FireContext): ObsConfig | null {
        const c = ctx.connector?.type === 'obs' ? ctx.connector.config : null;
        if (c?.url) return { url: c.url, password: c.password || undefined };
        return this.getConfig();
    }

    private async connect(cfg: ObsConfig): Promise<any> {
        const existing = this.clients.get(cfg.url);
        if (existing) return existing;
        const OBSWebSocket = (await import('obs-websocket-js')).default;
        const obs: any = new OBSWebSocket();
        await obs.connect(cfg.url, cfg.password);
        obs.on('ConnectionClosed', () => this.clients.delete(cfg.url));
        this.clients.set(cfg.url, obs);
        return obs;
    }

    async fire(effect: BundleEffect, ctx: FireContext): Promise<void> {
        const e = effect as ObsEffect;
        const cfg = this.resolve(ctx);
        if (!cfg?.url) throw new Error('OBS non configuré (aucun connecteur lié)');
        const params = e.params ? (resolveDeep(e.params, ctx) as Record<string, unknown>) : undefined;
        const obs = await this.connect(cfg);
        await obs.call(e.request, params);
    }

    async dispose(): Promise<void> {
        for (const obs of this.clients.values()) {
            try {
                await obs.disconnect();
            } catch {
                /* noop */
            }
        }
        this.clients.clear();
    }
}
