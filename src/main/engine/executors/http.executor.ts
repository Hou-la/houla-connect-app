import { Executor, BundleEffect, HttpEffect, FireContext } from '../types';
import { resolveVars, resolveDeep, hostAllowed } from '../substitute';

// Exécuteur HTTP (webhook REST / domotique / API). L'endpoint vient du CONNECTEUR
// (config.baseUrl, de confiance) + le chemin `path` de l'effet ; à défaut, l'URL
// complète de l'effet (garde SSRF allowlist).
export class HttpExecutor implements Executor {
    readonly type = 'http' as const;
    readonly capability = 'allowHttp';
    readonly requiresCapability = false;

    constructor(private readonly userHostAllowlist: () => string[]) {}

    validate(effect: BundleEffect): void {
        const e = effect as HttpEffect;
        if (!['GET', 'POST', 'PUT'].includes(e.method)) throw new Error('http.method invalide');
        if (!e.url && !e.connector) throw new Error('http : url ou connecteur requis');
    }

    private resolveUrl(e: HttpEffect, ctx: FireContext): string {
        const c = ctx.connector?.type === 'http' ? ctx.connector.config : null;
        if (c?.baseUrl) {
            const base = c.baseUrl.replace(/\/+$/, '');
            const path = resolveVars(e.path || '', ctx);
            return path ? `${base}/${path.replace(/^\/+/, '')}` : base;
        }
        const url = resolveVars(e.url || '', ctx);
        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch {
            throw new Error(`http.url non parseable: ${url}`);
        }
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('schéma non autorisé');
        if (!hostAllowed(parsed.hostname, this.userHostAllowlist()))
            throw new Error(`host non autorisé (SSRF / hors allowlist): ${parsed.hostname}`);
        return url;
    }

    async fire(effect: BundleEffect, ctx: FireContext): Promise<void> {
        const e = effect as HttpEffect;
        const url = this.resolveUrl(e, ctx);
        const body = e.json ? JSON.stringify(resolveDeep(e.json, ctx)) : undefined;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        try {
            await fetch(url, {
                method: e.method,
                headers: body ? { 'Content-Type': 'application/json' } : undefined,
                body,
                signal: controller.signal,
            });
        } finally {
            clearTimeout(timer);
        }
    }
}
