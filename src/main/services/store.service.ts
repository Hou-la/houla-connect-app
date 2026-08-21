import Store from 'electron-store';
import { safeStorage } from 'electron';

// Stockage local : config non sensible en clair, secrets (tokens, mots de passe
// RCON/OBS, clé d'événement) chiffrés via safeStorage (DPAPI Windows / Keychain).
// Le renderer n'accède JAMAIS aux secrets en lecture (bridge write-only).

export interface InstalledBundle {
    slug: string;
    version: string;
    contentHash: string;
}

interface Schema {
    accessToken?: string; // chiffré
    refreshToken?: string; // chiffré
    pkceVerifier?: string; // PKCE verifier en cours (survit à une instance fraîche)
    eventKey?: string; // chiffré (hle_...)
    workspaceId?: string;
    workspaceName?: string;
    language?: string;
    autostart?: boolean;
    focusTarget?: { exe?: string; title?: string };
    capabilities?: Record<string, boolean>; // par exécuteur
    hostAllowlist?: string[];
    secrets?: Record<string, string>; // valeurs chiffrées (rconHost, rconPassword, obsUrl, ...)
    vars?: Record<string, string>; // variables non secrètes ({player}, ...)
    installedBundles?: InstalledBundle[];
    activeBundleSlug?: string;
}

export class StoreService {
    private store = new Store<Schema>({ name: 'houla-connect-config' });

    private enc(v: string): string {
        if (!safeStorage.isEncryptionAvailable()) return v;
        return safeStorage.encryptString(v).toString('base64');
    }
    private dec(v?: string): string | undefined {
        if (!v) return undefined;
        if (!safeStorage.isEncryptionAvailable()) return v;
        try {
            return safeStorage.decryptString(Buffer.from(v, 'base64'));
        } catch {
            return undefined;
        }
    }

    // ── Auth ──
    setTokens(access: string, refresh: string) {
        this.store.set('accessToken', this.enc(access));
        this.store.set('refreshToken', this.enc(refresh));
    }
    getAccessToken() {
        return this.dec(this.store.get('accessToken'));
    }
    getRefreshToken() {
        return this.dec(this.store.get('refreshToken'));
    }
    setEventKey(key: string) {
        this.store.set('eventKey', this.enc(key));
    }
    getEventKey() {
        return this.dec(this.store.get('eventKey'));
    }
    setWorkspace(id: string, name: string) {
        this.store.set('workspaceId', id);
        this.store.set('workspaceName', name);
    }
    getWorkspaceId() {
        return this.store.get('workspaceId');
    }
    getWorkspaceName() {
        return this.store.get('workspaceName');
    }
    clearAuth() {
        for (const k of ['accessToken', 'refreshToken', 'eventKey', 'workspaceId', 'workspaceName'] as const)
            this.store.delete(k);
    }
    clearEventKey() {
        this.store.delete('eventKey');
    }
    setPkceVerifier(v: string) {
        this.store.set('pkceVerifier', v);
    }
    getPkceVerifier() {
        return this.store.get('pkceVerifier');
    }
    clearPkceVerifier() {
        this.store.delete('pkceVerifier');
    }

    // ── Prefs ──
    getLanguage() {
        return this.store.get('language', 'fr');
    }
    setLanguage(l: string) {
        this.store.set('language', l);
    }
    getFocusTarget() {
        return this.store.get('focusTarget', {} as any);
    }
    setFocusTarget(t: { exe?: string; title?: string }) {
        this.store.set('focusTarget', t);
    }

    // ── Capacités (toutes OFF par défaut) ──
    getCapabilities(): Set<string> {
        const caps = this.store.get('capabilities', {} as Record<string, boolean>);
        return new Set(Object.entries(caps).filter(([, v]) => v).map(([k]) => k));
    }
    setCapability(cap: string, enabled: boolean) {
        const caps = this.store.get('capabilities', {} as Record<string, boolean>);
        caps[cap] = enabled;
        this.store.set('capabilities', caps);
    }
    getHostAllowlist() {
        return this.store.get('hostAllowlist', [] as string[]);
    }
    setHostAllowlist(hosts: string[]) {
        this.store.set('hostAllowlist', hosts);
    }

    // ── Secrets (write-only depuis le renderer) + vars ──
    setSecret(name: string, value: string) {
        const s = this.store.get('secrets', {} as Record<string, string>);
        s[name] = this.enc(value);
        this.store.set('secrets', s);
    }
    listSecretNames(): string[] {
        return Object.keys(this.store.get('secrets', {} as Record<string, string>));
    }
    /** Résout secrets (déchiffrés) + vars en une map de variables (usage MAIN only). */
    resolveVars(): Record<string, string | number> {
        const out: Record<string, string | number> = {};
        const secrets = this.store.get('secrets', {} as Record<string, string>);
        for (const [k, v] of Object.entries(secrets)) {
            const d = this.dec(v);
            if (d !== undefined) out[k] = d;
        }
        Object.assign(out, this.store.get('vars', {} as Record<string, string>));
        return out;
    }
    getRconConfig() {
        const v = this.resolveVars();
        if (!v.rconHost) return null;
        return { host: String(v.rconHost), port: Number(v.rconPort) || 25575, password: String(v.rconPassword || '') };
    }
    getObsConfig() {
        const v = this.resolveVars();
        if (!v.obsUrl) return null;
        return { url: String(v.obsUrl), password: v.obsPassword ? String(v.obsPassword) : undefined };
    }
    getMqttConfig() {
        const v = this.resolveVars();
        if (!v.mqttUrl) return null;
        return {
            url: String(v.mqttUrl),
            username: v.mqttUsername ? String(v.mqttUsername) : undefined,
            password: v.mqttPassword ? String(v.mqttPassword) : undefined,
        };
    }

    // ── Bundles installés ──
    getInstalled(): InstalledBundle[] {
        return this.store.get('installedBundles', [] as InstalledBundle[]);
    }
    setInstalled(list: InstalledBundle[]) {
        this.store.set('installedBundles', list);
    }
    getActiveBundleSlug() {
        return this.store.get('activeBundleSlug');
    }

    // ── Cache du catalogue de cadeaux (rafraîchi depuis l'API publique) ──
    getGiftCatalogCache(): { at: number; gifts: any[] } | undefined {
        return this.store.get('giftCatalogCache') as any;
    }
    setGiftCatalogCache(gifts: any[]) {
        this.store.set('giftCatalogCache', { at: Date.now(), gifts });
    }
    setActiveBundleSlug(slug?: string) {
        if (slug) this.store.set('activeBundleSlug', slug);
        else this.store.delete('activeBundleSlug');
    }
}
