import { Executor, BundleEffect, RconEffect, FireContext } from '../types';
import { resolveVars } from '../substitute';

export interface RconConfig {
    host: string;
    port: number;
    password: string;
}

// Verbes RCON de sabotage serveur, refusés en DÉFENSE EN PROFONDEUR (miroir du
// validateur serveur) : même un manifeste signé/altéré ne doit pas pouvoir les jouer.
const FORBIDDEN_RCON_VERBS = new Set([
    'stop', 'restart', 'op', 'deop', 'ban', 'ban-ip', 'banip', 'pardon',
    'kick', 'whitelist', 'save-off', 'save-all', 'gamemode',
    'shutdown', 'sudo', 'rm', 'del', 'format', 'mkfs',
]);

// Exécuteur RCON (serveurs de jeu type Minecraft). Connexion lazy réutilisée.
export class RconExecutor implements Executor {
    readonly type = 'rcon' as const;
    readonly capability = 'allowRcon';
    private client: any = null;
    private connecting: Promise<any> | null = null;

    constructor(private readonly getConfig: () => RconConfig | null) {}

    validate(effect: BundleEffect): void {
        const e = effect as RconEffect;
        if (!e.command) throw new Error('rcon.command manquant');
        const verb = e.command.trim().replace(/^\//, '').split(/\s+/)[0]?.toLowerCase() ?? '';
        if (FORBIDDEN_RCON_VERBS.has(verb)) throw new Error(`verbe RCON interdit : ${verb}`);
    }

    private async connect(): Promise<any> {
        if (this.client) return this.client;
        if (this.connecting) return this.connecting;
        const cfg = this.getConfig();
        if (!cfg?.host) throw new Error('RCON non configuré (host/port/password)');
        // Import paresseux : optionalDependency.
        const { Rcon } = await import('rcon-client');
        this.connecting = Rcon.connect({ host: cfg.host, port: cfg.port, password: cfg.password })
            .then((c: any) => {
                this.client = c;
                c.on('end', () => (this.client = null));
                return c;
            })
            .finally(() => (this.connecting = null));
        return this.connecting;
    }

    async fire(effect: BundleEffect, ctx: FireContext): Promise<void> {
        const e = effect as RconEffect;
        const command = resolveVars(e.command, ctx);
        const client = await this.connect();
        await client.send(command);
    }

    async dispose(): Promise<void> {
        try {
            await this.client?.end();
        } catch {
            /* noop */
        }
        this.client = null;
    }
}
