import { Executor, BundleEffect, MqttEffect, FireContext } from '../types';
import { resolveVars } from '../substitute';

export interface MqttConfig {
    url: string; // mqtt://host:1883 ou mqtts://…
    username?: string;
    password?: string;
}

// Exécuteur MQTT (domotique / IoT). Connexions réutilisées PAR broker (url) :
// plusieurs connecteurs MQTT possibles (plusieurs brokers).
export class MqttExecutor implements Executor {
    readonly type = 'mqtt' as const;
    readonly capability = 'allowMqtt';
    readonly requiresCapability = false;
    private clients = new Map<string, any>();

    constructor(private readonly getConfig: () => MqttConfig | null) {}

    validate(effect: BundleEffect): void {
        if (!(effect as MqttEffect).topic) throw new Error('mqtt.topic manquant');
    }

    private resolve(ctx: FireContext): MqttConfig | null {
        const c = ctx.connector?.type === 'mqtt' ? ctx.connector.config : null;
        if (c?.url) return { url: c.url, username: c.username || undefined, password: c.password || undefined };
        return this.getConfig();
    }

    private async connect(cfg: MqttConfig): Promise<any> {
        const existing = this.clients.get(cfg.url);
        if (existing && existing.connected) return existing;
        const mqtt = await import('mqtt');
        const c = await new Promise<any>((resolve, reject) => {
            const client = mqtt.connect(cfg.url, {
                username: cfg.username,
                password: cfg.password,
                reconnectPeriod: 0,
                connectTimeout: 4000,
            });
            client.on('connect', () => resolve(client));
            client.on('error', (err: any) => { reject(err); client.end(true); });
        });
        this.clients.set(cfg.url, c);
        return c;
    }

    async fire(effect: BundleEffect, ctx: FireContext): Promise<void> {
        const e = effect as MqttEffect;
        const cfg = this.resolve(ctx);
        if (!cfg?.url) throw new Error('MQTT non configuré (aucun connecteur lié)');
        const topic = resolveVars(e.topic, ctx);
        const payload = resolveVars(e.payload || '', ctx);
        const c = await this.connect(cfg);
        await new Promise<void>((res, rej) =>
            c.publish(topic, payload, { qos: e.qos || 0, retain: !!e.retain }, (err: any) => (err ? rej(err) : res())),
        );
    }

    async dispose(): Promise<void> {
        for (const c of this.clients.values()) {
            try {
                c.end(true);
            } catch {
                /* noop */
            }
        }
        this.clients.clear();
    }
}
