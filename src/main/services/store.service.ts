import Store from 'electron-store';
import { safeStorage } from 'electron';
import { randomUUID } from 'crypto';

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
    connectors?: StoredConnector[]; // connecteurs nommés (multiple par type)
    bundleBindings?: Record<string, Record<string, string>>; // slug -> role -> connectorId
}

/** Un connecteur : endpoint + identifiants d'un protocole (RCON/OBS/MQTT/WS/HTTP/OSC). */
export interface StoredConnector {
    id: string;
    name: string;
    type: string; // rcon | obs | mqtt | ws | http | osc
    config: Record<string, string>; // les champs 'password' sont chiffrés au repos
}

/** Champs sensibles (chiffrés) par type de connecteur. */
const SECRET_FIELDS = new Set(['password']);

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

    // ═══════════════════ Connecteurs (multiple par protocole) ═══════════════════
    private rawConnectors(): StoredConnector[] {
        return this.store.get('connectors', [] as StoredConnector[]);
    }
    /** Liste pour le renderer : SANS les champs secrets (juste un booléen hasSecret). */
    listConnectors(): Array<{ id: string; name: string; type: string; config: Record<string, string>; hasSecret: boolean }> {
        return this.rawConnectors().map((c) => {
            const clean: Record<string, string> = {};
            let hasSecret = false;
            for (const [k, val] of Object.entries(c.config || {})) {
                if (SECRET_FIELDS.has(k)) { hasSecret = hasSecret || !!val; continue; }
                clean[k] = val;
            }
            return { id: c.id, name: c.name, type: c.type, config: clean, hasSecret };
        });
    }
    /** Crée (sans id) ou met à jour (avec id) un connecteur. Champ 'password' vide en MAJ = inchangé. */
    saveConnector(input: { id?: string; name: string; type: string; config: Record<string, string> }): { id: string } {
        const list = this.rawConnectors();
        const cfg: Record<string, string> = {};
        const existing = input.id ? list.find((c) => c.id === input.id) : undefined;
        for (const [k, val] of Object.entries(input.config || {})) {
            if (SECRET_FIELDS.has(k)) {
                if (val) cfg[k] = this.enc(val); // nouveau secret -> chiffré
                else if (existing?.config?.[k]) cfg[k] = existing.config[k]; // vide -> garde l'ancien
            } else {
                cfg[k] = String(val ?? '');
            }
        }
        if (existing) {
            existing.name = input.name;
            existing.type = input.type;
            existing.config = cfg;
            this.store.set('connectors', list);
            return { id: existing.id };
        }
        const id = randomUUID();
        list.push({ id, name: input.name, type: input.type, config: cfg });
        this.store.set('connectors', list);
        return { id };
    }
    deleteConnector(id: string): void {
        this.store.set('connectors', this.rawConnectors().filter((c) => c.id !== id));
        // Nettoie les liaisons qui pointaient dessus.
        const bindings = this.store.get('bundleBindings', {} as Record<string, Record<string, string>>);
        for (const slug of Object.keys(bindings)) {
            for (const role of Object.keys(bindings[slug])) {
                if (bindings[slug][role] === id) delete bindings[slug][role];
            }
        }
        this.store.set('bundleBindings', bindings);
    }
    /** Config DÉCHIFFRÉE d'un connecteur (usage MAIN uniquement). */
    getConnectorConfig(id: string): { type: string; config: Record<string, string> } | null {
        const c = this.rawConnectors().find((x) => x.id === id);
        if (!c) return null;
        const out: Record<string, string> = {};
        for (const [k, val] of Object.entries(c.config || {})) {
            out[k] = SECRET_FIELDS.has(k) ? this.dec(val) ?? '' : val;
        }
        return { type: c.type, config: out };
    }

    // ── Liaisons bundle -> rôle -> connecteur ──
    getBindings(slug: string): Record<string, string> {
        return this.store.get('bundleBindings', {} as Record<string, Record<string, string>>)[slug] || {};
    }
    setBinding(slug: string, role: string, connectorId: string): void {
        const all = this.store.get('bundleBindings', {} as Record<string, Record<string, string>>);
        all[slug] = all[slug] || {};
        if (connectorId) all[slug][role] = connectorId;
        else delete all[slug][role];
        this.store.set('bundleBindings', all);
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

    // ── Démarrage automatique (arrière-plan) — activé par défaut ──
    getAutoLaunch(): boolean {
        return this.store.get('autoLaunch', true) as boolean;
    }
    setAutoLaunch(v: boolean) {
        this.store.set('autoLaunch', v);
    }

    // ── Acceptation des CGU (version acceptée) ──
    getLegalAcceptedVersion(): string | undefined {
        return this.store.get('legalAcceptedVersion') as any;
    }
    setLegalAcceptedVersion(v: string) {
        this.store.set('legalAcceptedVersion', v);
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
