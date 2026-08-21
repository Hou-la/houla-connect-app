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

// Exécuteur RCON (serveurs de jeu type Minecraft). Connexions réutilisées PAR
// endpoint (host:port) -> plusieurs connecteurs RCON possibles.
export class RconExecutor implements Executor {
    readonly type = 'rcon' as const;
    readonly capability = 'allowRcon';
    readonly requiresCapability = false; // gardé par la présence d'un connecteur
    private clients = new Map<string, any>();

    constructor(private readonly getConfig: () => RconConfig | null) {}

    validate(effect: BundleEffect): void {
        const e = effect as RconEffect;
        if (!e.command) throw new Error('rcon.command manquant');
        const verb = e.command.trim().replace(/^\//, '').split(/\s+/)[0]?.toLowerCase() ?? '';
        if (FORBIDDEN_RCON_VERBS.has(verb)) throw new Error(`verbe RCON interdit : ${verb}`);
    }

    private resolve(ctx: FireContext): RconConfig | null {
        const c = ctx.connector?.type === 'rcon' ? ctx.connector.config : null;
        if (c?.host) return { host: c.host, port: Number(c.port) || 25575, password: c.password || '' };
        return this.getConfig(); // repli sur l'ancienne config unique
    }

    private async connect(cfg: RconConfig): Promise<any> {
        const key = `${cfg.host}:${cfg.port}`;
        const existing = this.clients.get(key);
        if (existing) return existing;
        const { Rcon } = await import('rcon-client');
        const c: any = await Rcon.connect({ host: cfg.host, port: cfg.port, password: cfg.password });
        c.on('end', () => this.clients.delete(key));
        this.clients.set(key, c);
        return c;
    }

    async fire(effect: BundleEffect, ctx: FireContext): Promise<void> {
        const cfg = this.resolve(ctx);
        if (!cfg?.host) throw new Error('RCON non configuré (aucun connecteur lié)');
        const command = resolveVars((effect as RconEffect).command, ctx);
        const client = await this.connect(cfg);
        await client.send(command);
    }

    async dispose(): Promise<void> {
        for (const c of this.clients.values()) {
            try {
                await c.end();
            } catch {
                /* noop */
            }
        }
        this.clients.clear();
    }
}
