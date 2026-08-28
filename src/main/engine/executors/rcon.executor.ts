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
    // On cache la PROMESSE de connexion (pas le client résolu) : deux fire concurrents
    // sur un endpoint froid partagent alors le MÊME handshake au lieu d'ouvrir deux
    // sockets dont l'un fuirait (jamais fermé, jamais référencé).
    private clients = new Map<string, Promise<any>>();

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

    private connect(cfg: RconConfig): Promise<any> {
        const key = `${cfg.host}:${cfg.port}`;
        const existing = this.clients.get(key);
        if (existing) return existing;
        const p = (async () => {
            const { Rcon } = await import('rcon-client');
            const c: any = await Rcon.connect({ host: cfg.host, port: cfg.port, password: cfg.password });
            // Évince dès que le socket meurt — sur 'end' ET 'error' (un serveur qui
            // redémarre coupe souvent via 'error') : le prochain fire reconnecte alors
            // proprement au lieu de réutiliser un socket mort.
            const drop = () => { if (this.clients.get(key) === p) this.clients.delete(key); };
            c.on('end', drop);
            c.on('error', drop);
            return c;
        })();
        this.clients.set(key, p);
        // Connexion échouée -> on retire la promesse rejetée pour permettre une nouvelle tentative.
        p.catch(() => { if (this.clients.get(key) === p) this.clients.delete(key); });
        return p;
    }

    private dropClient(key: string): void {
        const p = this.clients.get(key);
        if (!p) return;
        this.clients.delete(key);
        Promise.resolve(p).then((c) => c?.end?.()).catch(() => { /* fermeture best-effort */ });
    }

    async fire(effect: BundleEffect, ctx: FireContext): Promise<void> {
        const cfg = this.resolve(ctx);
        if (!cfg?.host) throw new Error('RCON non configuré (aucun connecteur lié)');
        const command = resolveVars((effect as RconEffect).command, ctx);
        const key = `${cfg.host}:${cfg.port}`;
        // Étape 1 — obtenir une connexion. On ne retente QUE l'établissement (aucune
        // commande n'est encore partie) : un socket caché mort échoue, on l'évince et
        // on ouvre une connexion fraîche.
        let client: any;
        try {
            client = await this.connect(cfg);
        } catch {
            this.dropClient(key);
            client = await this.connect(cfg);
        }
        // Étape 2 — envoyer. Un send qui échoue a PU atteindre le serveur (Minecraft
        // exécute à la réception, même si l'ack se perd) : on ne le REJOUE JAMAIS
        // (double give/tp/spawn). On évince juste pour repartir propre au prochain fire.
        try {
            await client.send(command);
        } catch (e) {
            this.dropClient(key);
            throw e;
        }
    }

    async dispose(): Promise<void> {
        for (const p of this.clients.values()) {
            try {
                const c = await p;
                await c?.end?.();
            } catch {
                /* noop */
            }
        }
        this.clients.clear();
    }
}
