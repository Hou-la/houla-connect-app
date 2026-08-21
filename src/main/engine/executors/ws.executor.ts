import { Executor, BundleEffect, WsEffect, FireContext } from '../types';
import { resolveVars, hostAllowed } from '../substitute';

// Exécuteur WebSocket brut. L'URL vient du CONNECTEUR (config.url, endpoint choisi
// par l'utilisateur = de confiance) ; à défaut, de l'effet (garde SSRF allowlist).
// Connexions réutilisées PAR url (plusieurs serveurs WS possibles).
export class WsExecutor implements Executor {
    readonly type = 'ws' as const;
    readonly capability = 'allowWs';
    readonly requiresCapability = false;
    private clients = new Map<string, any>();

    constructor(private readonly userHostAllowlist: () => string[]) {}

    validate(effect: BundleEffect): void {
        const e = effect as WsEffect;
        if (!e.url && !e.connector) throw new Error('ws : url ou connecteur requis');
    }

    private resolveUrl(e: WsEffect, ctx: FireContext): string {
        const c = ctx.connector?.type === 'ws' ? ctx.connector.config : null;
        if (c?.url) return c.url; // connecteur = endpoint de confiance
        const url = resolveVars(e.url || '', ctx);
        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch {
            throw new Error(`ws.url invalide: ${url}`);
        }
        if (!['ws:', 'wss:'].includes(parsed.protocol)) throw new Error('schéma ws invalide');
        if (!hostAllowed(parsed.hostname, this.userHostAllowlist()))
            throw new Error(`host non autorisé (SSRF / hors allowlist): ${parsed.hostname}`);
        return url;
    }

    private async open(url: string): Promise<any> {
        const existing = this.clients.get(url);
        if (existing && existing.readyState === 1) return existing;
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
            ws.on('open', () => { clearTimeout(t); this.clients.set(url, ws); resolve(ws); });
            ws.on('error', (err: any) => { clearTimeout(t); reject(err); });
            ws.on('close', () => this.clients.delete(url));
        });
    }

    async fire(effect: BundleEffect, ctx: FireContext): Promise<void> {
        const e = effect as WsEffect;
        const url = this.resolveUrl(e, ctx);
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
