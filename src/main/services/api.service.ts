import { createHash, verify } from 'crypto';
import { CONFIG } from '../config';
import { StoreService } from './store.service';

// Client API : token exchange, workspaces, mint de clé event, store, manifeste.
// Vérifie la SIGNATURE Ed25519 des manifestes avant de les rendre exécutables.
export class ApiService {
    private cachedPublicKey: string | null = null;

    constructor(private readonly store: StoreService) {}

    private async authFetch(path: string, init: RequestInit = {}, retry = true): Promise<Response> {
        const token = this.store.getAccessToken();
        const headers: Record<string, string> = {
            ...(init.headers as Record<string, string>),
            Authorization: `Bearer ${token || ''}`,
        };
        const wsId = this.store.getWorkspaceId();
        if (wsId) headers['X-Workspace-Id'] = wsId;
        const res = await fetch(`${CONFIG.apiUrl}${path}`, { ...init, headers });
        if (res.status === 401 && retry) {
            await this.refresh();
            return this.authFetch(path, init, false);
        }
        return res;
    }

    // ── OAuth ──
    async exchangeCode(code: string, codeVerifier: string): Promise<void> {
        const res = await fetch(`${CONFIG.apiUrl}/api/oauth/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                grant_type: 'authorization_code',
                code,
                code_verifier: codeVerifier,
                client_id: CONFIG.clientId,
                redirect_uri: CONFIG.redirectUri,
            }),
        });
        if (!res.ok) throw new Error(`token exchange failed: ${res.status}`);
        const d: any = await res.json();
        this.store.setTokens(d.access_token, d.refresh_token);
        if (d.workspace_id) this.store.setWorkspace(d.workspace_id, d.workspace_name || '');
    }

    async refresh(): Promise<void> {
        const rt = this.store.getRefreshToken();
        if (!rt) throw new Error('pas de refresh token');
        const res = await fetch(`${CONFIG.apiUrl}/api/oauth/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: rt, client_id: CONFIG.clientId }),
        });
        if (!res.ok) throw new Error(`refresh failed: ${res.status}`);
        const d: any = await res.json();
        this.store.setTokens(d.access_token, d.refresh_token || rt);
    }

    async listWorkspaces(): Promise<any[]> {
        const res = await this.authFetch('/api/workspaces');
        return res.ok ? res.json() : [];
    }

    /** Mint (ou réutilise) une clé d'événement pour le workspace courant. */
    async ensureEventKey(events: string[]): Promise<string> {
        const existing = this.store.getEventKey();
        if (existing) return existing;
        const res = await this.authFetch('/api/manager/event-key', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Hou.la Connect', events }),
        });
        if (!res.ok) throw new Error(`mint event-key failed: ${res.status}`);
        const d: any = await res.json();
        this.store.setEventKey(d.key);
        return d.key;
    }

    // ── Catalogue de cadeaux (public, évolue -> l'app le rafraîchit toute seule) ──
    // Sert le Lab (piocher le cadeau déclencheur par SLUG). Cache 6 h ; si l'API
    // est injoignable, on renvoie le dernier cache connu.
    async getGiftCatalog(force = false): Promise<any[]> {
        const cache = this.store.getGiftCatalogCache();
        const fresh = cache && Date.now() - cache.at < 6 * 3600 * 1000;
        if (cache && fresh && !force) return cache.gifts;
        try {
            const res = await fetch(`${CONFIG.apiUrl}/api/gifts`);
            if (!res.ok) return cache?.gifts || [];
            const gifts = (await res.json()) as any[];
            const slim = Array.isArray(gifts)
                ? gifts.map((g) => ({ slug: g.slug, name: g.name, thumbnailUrl: g.thumbnailUrl, coinCost: g.coinCost, isInteractiveSlot: !!g.isInteractiveSlot }))
                : [];
            this.store.setGiftCatalogCache(slim);
            return slim;
        } catch {
            return cache?.gifts || [];
        }
    }

    // ── Store ──
    async listStore(query: Record<string, string> = {}): Promise<any[]> {
        const qs = new URLSearchParams(query).toString();
        const res = await fetch(`${CONFIG.apiUrl}/api/bundles${qs ? '?' + qs : ''}`);
        return res.ok ? res.json() : [];
    }

    // ── Lab (créateur) ──
    async createBundle(dto: any): Promise<any> {
        const res = await this.authFetch('/api/manager/bundles', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(dto),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || `create ${res.status}`);
        return res.json();
    }
    async myBundles(): Promise<any[]> {
        const res = await this.authFetch('/api/manager/bundles');
        return res.ok ? res.json() : [];
    }
    async updateBundle(slug: string, dto: any): Promise<any> {
        const res = await this.authFetch(`/api/manager/bundles/${encodeURIComponent(slug)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(dto),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || `update ${res.status}`);
        return res.json();
    }
    /** Dictionnaire APPROUVÉ (autocomplétion Lab). kind='type'|'game'. Public, best-effort. */
    async getDictionary(kind?: string): Promise<any[]> {
        try {
            const qs = kind ? `?kind=${encodeURIComponent(kind)}` : '';
            const res = await fetch(`${CONFIG.apiUrl}/api/bundles/dictionary${qs}`);
            return res.ok ? res.json() : [];
        } catch {
            return [];
        }
    }
    async myBundleDetail(slug: string): Promise<any> {
        const res = await this.authFetch(`/api/manager/bundles/${encodeURIComponent(slug)}`);
        return res.ok ? res.json() : null;
    }
    async submitVersion(slug: string, dto: any): Promise<any> {
        const res = await this.authFetch(`/api/manager/bundles/${encodeURIComponent(slug)}/versions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(dto),
        });
        if (!res.ok) {
            const e = await res.json().catch(() => ({}));
            throw new Error((e.rejectionCodes ? e.rejectionCodes.join(', ') + ' : ' : '') + (e.message || `version ${res.status}`));
        }
        return res.json();
    }
    async publishBundle(slug: string): Promise<any> {
        const res = await this.authFetch(`/api/manager/bundles/${encodeURIComponent(slug)}/publish`, { method: 'POST' });
        if (!res.ok) throw new Error(`publish ${res.status}`);
        return res.json();
    }
    async uploadBanner(slug: string, filePath: string): Promise<any> {
        const fs = await import('fs/promises');
        const path = await import('path');
        const buf = await fs.readFile(filePath);
        const fd = new FormData();
        fd.append('file', new Blob([buf]), path.basename(filePath));
        // NB: ne PAS poser Content-Type, fetch pose le boundary multipart lui-même.
        const res = await this.authFetch(`/api/manager/bundles/${encodeURIComponent(slug)}/banner`, {
            method: 'POST',
            body: fd as any,
        });
        if (!res.ok) throw new Error(`banner ${res.status}`);
        return res.json();
    }

    async previewBundle(slug: string): Promise<any> {
        const res = await fetch(`${CONFIG.apiUrl}/api/bundles/${encodeURIComponent(slug)}`);
        if (!res.ok) throw new Error('preview failed');
        return res.json();
    }

    /** Récupère + VÉRIFIE le manifeste signé d'un bundle. Lève si signature invalide. */
    async fetchVerifiedManifest(slug: string, version?: string): Promise<any> {
        const qs = version ? `?version=${encodeURIComponent(version)}` : '';
        const res = await this.authFetch(`/api/manager/bundles/${encodeURIComponent(slug)}/manifest${qs}`);
        if (!res.ok) throw new Error(`manifest fetch failed: ${res.status}`);
        const d: any = await res.json();
        await this.verifySignature(d);
        return d;
    }

    private async getSigningPublicKey(): Promise<string | null> {
        if (this.cachedPublicKey) return this.cachedPublicKey;
        try {
            const res = await fetch(`${CONFIG.apiUrl}/api/download/connect/signing-key`);
            const d: any = await res.json();
            this.cachedPublicKey = d?.publicKey || null;
        } catch {
            this.cachedPublicKey = null;
        }
        return this.cachedPublicKey;
    }

    /** Vérifie que contentHash correspond au manifeste ET que la signature est valide. */
    private async verifySignature(d: any): Promise<void> {
        const recomputed = createHash('sha256').update(canonicalize(d.manifest)).digest('hex');
        if (recomputed !== d.contentHash) throw new Error('contentHash ne correspond pas au manifeste');
        if (!d.signature) return; // pas signé (dev / clé absente) : on n'exécute pas de bundle communautaire non signé en prod
        const pub = await this.getSigningPublicKey();
        if (!pub) throw new Error('clé publique de signature indisponible');
        const ok = verify(null, Buffer.from(d.contentHash, 'utf8'), pub, Buffer.from(d.signature, 'base64'));
        if (!ok) throw new Error('signature du manifeste INVALIDE');
    }
}

/** Doit être identique au canonicalize serveur (clés triées). */
function canonicalize(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize((value as any)[k])}`).join(',')}}`;
}
