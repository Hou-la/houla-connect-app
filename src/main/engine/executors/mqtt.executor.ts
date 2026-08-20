import { Executor, BundleEffect, MqttEffect, FireContext } from '../types';
import { resolveVars } from '../substitute';

export interface MqttConfig {
    url: string; // mqtt://host:1883 ou mqtts://…
    username?: string;
    password?: string;
}

// Exécuteur MQTT (domotique / IoT : Home Assistant, Zigbee2MQTT, ESP32…).
// Broker + identifiants = config locale du streamer (secrets). Connexion lazy.
export class MqttExecutor implements Executor {
    readonly type = 'mqtt' as const;
    readonly capability = 'allowMqtt';
    private client: any = null;
    private connecting: Promise<any> | null = null;

    constructor(private readonly getConfig: () => MqttConfig | null) {}

    validate(effect: BundleEffect): void {
        if (!(effect as MqttEffect).topic) throw new Error('mqtt.topic manquant');
    }

    private async connect(): Promise<any> {
        if (this.client && this.client.connected) return this.client;
        if (this.connecting) return this.connecting;
        const cfg = this.getConfig();
        if (!cfg?.url) throw new Error('MQTT non configuré (broker)');
        const mqtt = await import('mqtt');
        this.connecting = new Promise((resolve, reject) => {
            const c = mqtt.connect(cfg.url, {
                username: cfg.username,
                password: cfg.password,
                reconnectPeriod: 0,
                connectTimeout: 4000,
            });
            c.on('connect', () => { this.client = c; resolve(c); });
            c.on('error', (err: any) => { reject(err); c.end(true); });
        }).finally(() => (this.connecting = null));
        return this.connecting;
    }

    async fire(effect: BundleEffect, ctx: FireContext): Promise<void> {
        const e = effect as MqttEffect;
        const topic = resolveVars(e.topic, ctx);
        const payload = resolveVars(e.payload || '', ctx);
        const c = await this.connect();
        await new Promise<void>((res, rej) =>
            c.publish(topic, payload, { qos: e.qos || 0, retain: !!e.retain }, (err: any) => (err ? rej(err) : res())),
        );
    }

    async dispose(): Promise<void> {
        try {
            this.client?.end(true);
        } catch {
            /* noop */
        }
        this.client = null;
    }
}
