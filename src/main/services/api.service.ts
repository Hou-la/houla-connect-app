import { createHash, verify } from 'crypto';
import { CONFIG, ENV_API_URLS } from '../config';
import { StoreService } from './store.service';

// Client API : token exchange, workspaces, mint de clé event, store, manifeste.
// Vérifie la SIGNATURE Ed25519 des manifestes avant de les rendre exécutables.
export class ApiService {
    private cachedPublicKey: string | null = null;
    private statusListener?: (online: boolean) => void;

    constructor(private readonly store: StoreService) {}

    /** Rapporte la joignabilité de l'API à l'UI (toast « problème de connexion »). */
    setStatusListener(fn: (online: boolean) => void): void {
        this.statusListener = fn;
    }

    /** URL d'API courante : environnement choisi (admin) sinon défaut. */
    base(): string {
        const env = this.store.getEnvironment();
        return (env && ENV_API_URLS[env]) || CONFIG.apiUrl;
    }

    /** Sonde le statut admin : un endpoint AdminGuard renvoie 200 si admin, sinon 403. */
    async isAdmin(): Promise<boolean> {
        try {
            const res = await this.authFetch('/api/admin/bundles/moderation/queue');
            return res.status === 200;
        } catch {
            return false;
        }
    }

    private async authFetch(path: string, init: RequestInit = {}, retry = true): Promise<Response> {
        const token = this.store.getAccessToken();
        const headers: Record<string, string> = {
            ...(init.headers as Record<string, string>),
            Authorization: `Bearer ${token || ''}`,
        };
        const wsId = this.store.getWorkspaceId();
        if (wsId) headers['X-Workspace-Id'] = wsId;
        let res: Response;
        try {
            res = await fetch(`${this.base()}${path}`, { ...init, headers });
        } catch (e) {
            // fetch NE REJETTE que sur échec réseau (API éteinte, DNS KO, refus de
            // connexion) — jamais sur un statut HTTP. C'est LE signal « API injoignable ».
            this.statusListener?.(false);
            throw e;
        }
        this.statusListener?.(true); // la réponse est arrivée (même un 4xx/5xx) → API joignable
        if (res.status === 401 && retry) {
            await this.refresh();
            return this.authFetch(path, init, false);
        }
        return res;
    }

    // ── OAuth ──
    async exchangeCode(code: string, codeVerifier: string): Promise<void> {
        const res = await fetch(`${this.base()}/api/oauth/token`, {
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
        const res = await fetch(`${this.base()}/api/oauth/token`, {
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
        if (d.id) this.store.setEventKeyId(d.id);
        return d.key;
    }

    /** Id de la clé event courante (pour poser son bundle visuel). Le retrouve via la
     *  liste si on n'a que le secret en cache (clé mintée avant cette version). */
    private async resolveEventKeyId(): Promise<string | null> {
        const cached = this.store.getEventKeyId();
        if (cached) return cached;
        const key = this.store.getEventKey();
        if (!key) return null;
        try {
            const res = await this.authFetch('/api/manager/event-key');
            const list = res.ok ? await res.json() : [];
            // keyPrefix est MASQUÉ en base (ex. « hle_jca1... ») : on retire les points
            // de suspension avant de tester si c'est un préfixe du secret en cache.
            const norm = (p: unknown) => String(p || '').replace(/\.+$/, '');
            const match = Array.isArray(list)
                ? list.find((k: any) => { const p = norm(k?.keyPrefix); return p.length >= 6 && key.startsWith(p); })
                : null;
            if (match?.id) { this.store.setEventKeyId(match.id); return match.id; }
        } catch { /* best-effort */ }
        return null;
    }

    /** Pose (ou retire avec null) le pack VISUEL que le viewer voit pendant le live,
     *  d'après le pack ACTIF de l'app. Best-effort : ne bloque jamais le live. */
    async setActivePackBundle(bundleId: string | null): Promise<void> {
        const keyId = await this.resolveEventKeyId();
        if (!keyId) return;
        try {
            await this.authFetch(`/api/manager/event-key/${encodeURIComponent(keyId)}/bundle`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ bundleId }),
            });
        } catch { /* best-effort */ }
    }

    // ── Catalogue de cadeaux (public, évolue -> l'app le rafraîchit toute seule) ──
    // Sert le Lab (piocher le cadeau déclencheur par SLUG). Cache 6 h ; si l'API
    // est injoignable, on renvoie le dernier cache connu.
    async getGiftCatalog(force = false): Promise<any[]> {
        const cache = this.store.getGiftCatalogCache();
        const fresh = cache && Date.now() - cache.at < 6 * 3600 * 1000;
        if (cache && fresh && !force) return cache.gifts;
        try {
            const res = await fetch(`${this.base()}/api/gifts`);
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
        const res = await fetch(`${this.base()}/api/bundles${qs ? '?' + qs : ''}`);
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
            const res = await fetch(`${this.base()}/api/bundles/dictionary${qs}`);
            return res.ok ? res.json() : [];
        } catch {
            return [];
        }
    }
    async myBundleDetail(slug: string): Promise<any> {
        const res = await this.authFetch(`/api/manager/bundles/${encodeURIComponent(slug)}`);
        return res.ok ? res.json() : null;
    }
    /** Stats créateur d'un pack : totaux (coins/étoiles/effets) + série journalière. */
    async getBundleStats(slug: string): Promise<any> {
        const res = await this.authFetch(`/api/manager/bundles/${encodeURIComponent(slug)}/stats`);
        return res.ok ? res.json() : null;
    }
    /** Top streamers qui rapportent le plus au créateur via ce pack. */
    async getTopBroadcasters(slug: string): Promise<any[]> {
        const res = await this.authFetch(`/api/manager/bundles/${encodeURIComponent(slug)}/top-broadcasters`);
        return res.ok ? res.json() : [];
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
    /** Type MIME depuis l'extension — INDISPENSABLE : un Blob sans type est rejeté par
     *  le FileTypeValidator du serveur (image/png|jpeg|webp|gif). C'était le bug bannière. */
    private mimeOf(filePath: string): string {
        const p = filePath.toLowerCase();
        if (p.endsWith('.png')) return 'image/png';
        if (p.endsWith('.webp')) return 'image/webp';
        if (p.endsWith('.gif')) return 'image/gif';
        return 'image/jpeg';
    }

    async uploadBanner(slug: string, filePath: string): Promise<any> {
        const fs = await import('fs/promises');
        const path = await import('path');
        const buf = await fs.readFile(filePath);
        const fd = new FormData();
        fd.append('file', new Blob([buf], { type: this.mimeOf(filePath) }), path.basename(filePath));
        // NB: ne PAS poser Content-Type, fetch pose le boundary multipart lui-même.
        const res = await this.authFetch(`/api/manager/bundles/${encodeURIComponent(slug)}/banner`, {
            method: 'POST',
            body: fd as any,
        });
        if (!res.ok) throw new Error(`banner ${res.status}`);
        return res.json();
    }

    async uploadSlotIcon(slug: string, slot: string, filePath: string): Promise<any> {
        const fs = await import('fs/promises');
        const path = await import('path');
        const buf = await fs.readFile(filePath);
        const fd = new FormData();
        fd.append('file', new Blob([buf], { type: this.mimeOf(filePath) }), path.basename(filePath));
        fd.append('slot', slot);
        const res = await this.authFetch(`/api/manager/bundles/${encodeURIComponent(slug)}/slot-icon`, {
            method: 'POST',
            body: fd as any,
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || `icône ${res.status}`);
        return res.json(); // { slot, url }
    }

    async previewBundle(slug: string): Promise<any> {
        const res = await fetch(`${this.base()}/api/bundles/${encodeURIComponent(slug)}`);
        if (!res.ok) throw new Error('preview failed');
        return res.json();
    }

    /** Libellé humain de l'environnement courant (pour les messages d'erreur). */
    private envLabel(): string {
        const e = this.store.getEnvironment();
        return e === 'dev' ? 'Développement' : e === 'staging' ? 'Staging' : 'Production';
    }

    /** Récupère + VÉRIFIE le manifeste signé d'un bundle. Lève si signature invalide. */
    async fetchVerifiedManifest(slug: string, version?: string): Promise<any> {
        const qs = version ? `?version=${encodeURIComponent(version)}` : '';
        const res = await this.authFetch(`/api/manager/bundles/${encodeURIComponent(slug)}/manifest${qs}`);
        if (!res.ok) {
            // 404/403 = le pack n'existe pas (ou pas publié) SUR CET ENVIRONNEMENT.
            // Un pack installé en Production n'a pas de manifeste en Développement.
            if (res.status === 404 || res.status === 403) {
                throw new Error(
                    `Le pack « ${slug} » est introuvable sur l'environnement ${this.envLabel()}. ` +
                        `Il n'existe peut-être que sur un autre environnement — bascule d'environnement dans les Réglages, ou (re)crée-le dans le Lab.`,
                );
            }
            throw new Error(`Impossible de récupérer le pack « ${slug} » (${res.status}). Réessaie dans un instant.`);
        }
        const d: any = await res.json();
        await this.verifySignature(d);
        return d;
    }

    private async getSigningPublicKey(): Promise<string | null> {
        if (this.cachedPublicKey) return this.cachedPublicKey;
        try {
            const res = await fetch(`${this.base()}/api/download/connect/signing-key`);
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
