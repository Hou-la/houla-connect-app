import { Executor, BundleEffect, WsEffect, FireContext } from '../types';
import { resolveVars, hostAllowed } from '../substitute';

// Exécuteur WebSocket brut (overlays custom, Streamer.bot, bridges maison).
// Même garde SSRF que HTTP : le host doit être dans l'allowlist utilisateur, sinon
// les IP privées/loopback/metadata sont refusées. Connexions réutilisées par URL.
export class WsExecutor implements Executor {
    readonly type = 'ws' as const;
    readonly capability = 'allowWs';
    private clients = new Map<string, any>(); // url -> WebSocket

    constructor(private readonly userHostAllowlist: () => string[]) {}

    validate(effect: BundleEffect): void {
        if (!(effect as WsEffect).url) throw new Error('ws.url manquant');
    }

    private async open(url: string): Promise<any> {
        const existing = this.clients.get(url);
        if (existing && existing.readyState === 1) return existing; // OPEN
        const WebSocket = (await import('ws')).default;
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(url);
            const t = setTimeout(() => {
                reject(new Error('ws timeout'));
                try {
                    ws.terminate();
                } catch {
                    /* noop */
                }
            }, 4000);
            ws.on('open', () => {
                clearTimeout(t);
                this.clients.set(url, ws);
                resolve(ws);
            });
            ws.on('error', (err: any) => {
                clearTimeout(t);
                reject(err);
            });
            ws.on('close', () => this.clients.delete(url));
        });
    }

    async fire(effect: BundleEffect, ctx: FireContext): Promise<void> {
        const e = effect as WsEffect;
        const url = resolveVars(e.url, ctx);
        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch {
            throw new Error(`ws.url non parseable: ${url}`);
        }
        if (!['ws:', 'wss:'].includes(parsed.protocol)) throw new Error('schéma ws invalide');
        if (!hostAllowed(parsed.hostname, this.userHostAllowlist())) {
            throw new Error(`host non autorisé (SSRF / hors allowlist): ${parsed.hostname}`);
        }
        const message = resolveVars(e.message || '', ctx);
        const ws = await this.open(url);
        ws.send(message);
    }

    dispose(): void {
        for (const ws of this.clients.values()) {
            try {
                ws.close();
            } catch {
                /* noop */
            }
        }
        this.clients.clear();
    }
}
