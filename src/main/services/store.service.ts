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
    eventKeyId?: string; // id de la clé event (pour poser son bundle visuel)
    workspaceId?: string;
    workspaceName?: string;
    language?: string;
    autostart?: boolean;
    focusTarget?: { exe?: string; title?: string; dir?: string }; // dir = dossier du jeu où est posé le proxy XInput
    capabilities?: Record<string, boolean>; // par exécuteur
    hostAllowlist?: string[];
    secrets?: Record<string, string>; // valeurs chiffrées (rconHost, rconPassword, obsUrl, ...)
    vars?: Record<string, string>; // variables non secrètes ({player}, ...)
    installedBundles?: InstalledBundle[]; // legacy (global) — migré vers installedByEnv
    activeBundleSlug?: string; // legacy (global) — migré vers activeByEnv
    installedByEnv?: Record<string, InstalledBundle[]>; // packs installés PAR environnement
    activeByEnv?: Record<string, string>; // pack actif PAR environnement
    connectors?: StoredConnector[]; // connecteurs nommés (multiple par type)
    bundleBindings?: Record<string, Record<string, string>>; // slug -> role -> connectorId
    // Calque de PERSONNALISATION locale par pack (streamer) : n'édite JAMAIS le
    // manifeste signé, juste des réglages appliqués au runtime. Survit aux MAJ.
    packOverlays?: Record<string, { disabled?: string[]; cooldownMs?: Record<string, number> }>;
    environment?: string; // 'prod' | 'staging' | 'dev' (sélecteur admin)
    // Cache OFFLINE des identités : dernière liste de workspaces connue (avatars en
    // data: URL) pour que le sélecteur d'identité reste utilisable sans connexion.
    workspacesCache?: any[];
    avatarCache?: Record<string, string>; // avatarUrl distante -> data: URL
}

/** Un connecteur : endpoint + identifiants d'un protocole, OU une capacité locale. */
export interface StoredConnector {
    id: string;
    name: string;
    type: string; // réseau: rcon|obs|mqtt|ws|http|osc — local: keyboard|gamepad|driver
    enabled: boolean;
    config: Record<string, string>; // les champs 'password' sont chiffrés au repos
}

/** Champs sensibles (chiffrés) par type de connecteur. */
const SECRET_FIELDS = new Set(['password']);

/** Connecteurs LOCAUX (injection : clavier/manette/pilote) pré-créés, désactivés. */
const DEFAULT_LOCAL_CONNECTORS: Array<{ id: string; type: string; name: string }> = [
    { id: 'local-keyboard', type: 'keyboard', name: 'Clavier' },
    { id: 'local-gamepad', type: 'gamepad', name: 'Manette virtuelle (ViGEm)' },
    { id: 'local-driver', type: 'driver', name: 'Pilotage bas niveau (Interception/ViGEm)' },
];

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
    setEventKeyId(id: string) {
        this.store.set('eventKeyId', id);
    }
    getEventKeyId(): string | undefined {
        return this.store.get('eventKeyId');
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
    // ── Cache OFFLINE des identités (workspaces + avatars) ──
    setWorkspacesCache(list: any[]) {
        this.store.set('workspacesCache', Array.isArray(list) ? list : []);
    }
    getWorkspacesCache(): any[] {
        return (this.store.get('workspacesCache') as any[]) || [];
    }
    getAvatarCache(): Record<string, string> {
        return (this.store.get('avatarCache') as Record<string, string>) || {};
    }
    setAvatarCache(map: Record<string, string>) {
        this.store.set('avatarCache', map || {});
    }
    clearAuth() {
        for (const k of ['accessToken', 'refreshToken', 'eventKey', 'eventKeyId', 'workspaceId', 'workspaceName', 'workspacesCache', 'avatarCache'] as const)
            this.store.delete(k);
    }
    clearEventKey() {
        this.store.delete('eventKey');
        this.store.delete('eventKeyId');
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
    setFocusTarget(t: { exe?: string; title?: string; dir?: string }) {
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

    // ═══════════════════ Connecteurs (multiple par protocole + locaux) ═══════════════════
    private rawConnectors(): StoredConnector[] {
        return this.store.get('connectors', [] as StoredConnector[]);
    }
    /** Pré-crée les 3 connecteurs LOCAUX (clavier/manette/pilote), désactivés. Idempotent. */
    ensureDefaultConnectors(): void {
        const list = this.rawConnectors();
        let changed = false;
        for (const d of DEFAULT_LOCAL_CONNECTORS) {
            if (!list.some((c) => c.id === d.id)) {
                list.push({ id: d.id, name: d.name, type: d.type, enabled: false, config: {} });
                changed = true;
            }
        }
        if (changed) this.store.set('connectors', list);
    }
    /** Liste pour le renderer : SANS les champs secrets (juste un booléen hasSecret). */
    listConnectors(): Array<{ id: string; name: string; type: string; enabled: boolean; config: Record<string, string>; hasSecret: boolean }> {
        return this.rawConnectors().map((c) => {
            const clean: Record<string, string> = {};
            let hasSecret = false;
            for (const [k, val] of Object.entries(c.config || {})) {
                if (SECRET_FIELDS.has(k)) { hasSecret = hasSecret || !!val; continue; }
                clean[k] = val;
            }
            return { id: c.id, name: c.name, type: c.type, enabled: !!c.enabled, config: clean, hasSecret };
        });
    }
    /** Crée (sans id, activé) ou met à jour (avec id) un connecteur. 'password' vide en MAJ = inchangé. */
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
        list.push({ id, name: input.name, type: input.type, enabled: true, config: cfg });
        this.store.set('connectors', list);
        return { id };
    }
    setConnectorEnabled(id: string, enabled: boolean): void {
        const list = this.rawConnectors();
        const c = list.find((x) => x.id === id);
        if (c) { c.enabled = enabled; this.store.set('connectors', list); }
    }
    /** true si un connecteur ACTIVÉ de ce type existe (garde des exécuteurs locaux). */
    hasEnabledConnector(type: string): boolean {
        return this.rawConnectors().some((c) => c.type === type && c.enabled);
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
    /** Config DÉCHIFFRÉE d'un connecteur ACTIVÉ (usage MAIN uniquement). null si absent/désactivé. */
    getConnectorConfig(id: string): { type: string; config: Record<string, string> } | null {
        const c = this.rawConnectors().find((x) => x.id === id);
        if (!c || !c.enabled) return null; // désactivé => non utilisable
        const out: Record<string, string> = {};
        for (const [k, val] of Object.entries(c.config || {})) {
            out[k] = SECRET_FIELDS.has(k) ? this.dec(val) ?? '' : val;
        }
        return { type: c.type, config: out };
    }

    // ── Personnalisation locale d'un pack (calque, jamais dans le manifeste signé) ──
    getPackOverlay(slug: string): { disabled: string[]; cooldownMs: Record<string, number> } {
        const all = this.store.get('packOverlays', {} as Record<string, { disabled?: string[]; cooldownMs?: Record<string, number> }>);
        const o = all[slug] || {};
        return { disabled: o.disabled || [], cooldownMs: o.cooldownMs || {} };
    }
    setPackOverlay(slug: string, overlay: { disabled?: string[]; cooldownMs?: Record<string, number> }): void {
        const all = this.store.get('packOverlays', {} as Record<string, { disabled?: string[]; cooldownMs?: Record<string, number> }>);
        all[slug] = { disabled: overlay.disabled || [], cooldownMs: overlay.cooldownMs || {} };
        this.store.set('packOverlays', all);
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

    // ── Bundles installés (SCOPÉS par environnement) ──
    // Un pack n'existe que dans la base de SON environnement : un pack installé en
    // prod n'a pas de manifeste en dev (-> 404 au démarrage). On isole donc la liste
    // installée ET le pack actif PAR environnement, pour ne jamais proposer un pack
    // fantôme après un changement d'env. Les anciennes clés globales sont migrées
    // une fois vers le bucket 'prod' (l'app ne parlait qu'à la prod avant le sélecteur).
    private envKey(): string {
        const e = this.getEnvironment();
        return !e || e === 'prod' ? 'prod' : e;
    }
    private installedMap(): Record<string, InstalledBundle[]> {
        let byEnv = this.store.get('installedByEnv') as Record<string, InstalledBundle[]> | undefined;
        if (!byEnv) {
            const legacy = this.store.get('installedBundles', [] as InstalledBundle[]);
            byEnv = legacy.length ? { prod: legacy } : {};
            this.store.set('installedByEnv', byEnv);
        }
        return byEnv;
    }
    private activeMap(): Record<string, string> {
        let byEnv = this.store.get('activeByEnv') as Record<string, string> | undefined;
        if (!byEnv) {
            const legacy = this.store.get('activeBundleSlug') as string | undefined;
            byEnv = legacy ? { prod: legacy } : {};
            this.store.set('activeByEnv', byEnv);
        }
        return byEnv;
    }
    getInstalled(): InstalledBundle[] {
        return this.installedMap()[this.envKey()] || [];
    }
    setInstalled(list: InstalledBundle[]) {
        const byEnv = this.installedMap();
        byEnv[this.envKey()] = list;
        this.store.set('installedByEnv', byEnv);
    }
    getActiveBundleSlug(): string | undefined {
        return this.activeMap()[this.envKey()];
    }

    // ── Démarrage automatique (arrière-plan) — activé par défaut ──
    getAutoLaunch(): boolean {
        return this.store.get('autoLaunch', true) as boolean;
    }
    setAutoLaunch(v: boolean) {
        this.store.set('autoLaunch', v);
    }

    // ── Environnement (sélecteur admin) ──
    getEnvironment(): string {
        return (this.store.get('environment') as any) || '';
    }
    setEnvironment(env: string) {
        this.store.set('environment', env);
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
        const byEnv = this.activeMap();
        if (slug) byEnv[this.envKey()] = slug;
        else delete byEnv[this.envKey()];
        this.store.set('activeByEnv', byEnv);
    }
}
