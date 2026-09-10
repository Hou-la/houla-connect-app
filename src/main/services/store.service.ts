import Store from 'electron-store';
import { safeStorage } from 'electron';
import { randomUUID } from 'crypto';

// Stockage local : config non sensible en clair, secrets (tokens, mots de passe
// RCON/OBS, clé d'événement) chiffrés via safeStorage (DPAPI Windows / Keychain).
// Le renderer n'accède JAMAIS aux secrets en lecture (bridge write-only).

import { MAX_JOUEURS } from '../engine/joueurs';

export interface InstalledBundle {
    slug: string;
    version: string;
    contentHash: string;
    /**
     * Ce pack pilote-t-il une MANETTE (dans la configuration de commandes choisie) ?
     *
     * Mémorisé à l'installation et rafraîchi à chaque lecture réussie du manifeste :
     * c'est le repli HORS LIGNE. Sans lui, ouvrir l'app sans réseau cacherait
     * l'effectif du pack au lieu de le montrer. Absent = jamais déterminé.
     */
    usesGamepad?: boolean;
}

/** Réglages LOCAUX d'un pack installé. Ne touchent jamais le manifeste signé. */
export interface PackOverlay {
    /** Ids d'interactions désactivées par le joueur. */
    disabled?: string[];
    /** Override de cooldown, par id d'interaction. */
    cooldownMs?: Record<string, number>;
    /** Configuration de commandes choisie (id d'un `manifest.profiles`) : clavier, manette… */
    profile?: string;
    /**
     * REMAPPAGE par le joueur : quelle touche / quel bouton déclenche chaque interaction.
     *
     * Le site promet « tu glisses des cadeaux sur des actions » depuis le début, mais rien
     * de tel n'existait : le calque ne portait que `disabled` et `cooldownMs`, et les touches
     * étaient figées dans le manifeste signé. Un pack écrit pour un clavier AZERTY, ou pour
     * une configuration de touches qui n'est pas celle du joueur, était donc inutilisable.
     *
     * ⚠️ FRONTIÈRE DE SÉCURITÉ, à ne jamais franchir : on ne remplace QUE la touche ou le
     * bouton, JAMAIS le type d'effet. Un joueur ne doit pas pouvoir transformer une action
     * clavier en appel HTTP ou en commande RCON : ce serait détourner un pack signé.
     */
    keyBindings?: Record<string, { keys?: string; button?: string }>;
    /**
     * EFFECTIF de ce pack : qui joue, sous quel nom, et dans quel ordre.
     *
     * ⚠️ C'est une propriété du PACK, pas de la machine. Un streamer joue à Tomb
     * Raider à deux avec toujours les mêmes personnes, puis fait un Mario Kart à
     * quatre le lendemain avec d'autres. La CAPACITÉ (combien de manettes la
     * machine sait fournir, et de quel type) reste globale, dans les Réglages :
     * elle décrit le matériel. L'effectif, lui, se mémorise ici et revient tel
     * quel quand le pack est relancé.
     *
     * Absent = jamais configuré (on proposera la capacité). Tableau vide = le
     * diffuseur a explicitement dit « personne » : aucun choix de cible chez le
     * spectateur. Les deux ne se lisent pas pareil.
     */
    players?: Array<{ id: number; label?: string }>;
    /**
     * MÉMOIRE DES NOMS, indépendante de l'effectif actif.
     *
     * Sans elle, réduire l'effectif de 4 à 2 (ce soir ils ne sont que deux)
     * EFFACERAIT définitivement le nom des joueurs 3 et 4 : le diffuseur devrait
     * les ressaisir à chaque partie complète. Une perte de données silencieuse,
     * pour un geste qui a l'air anodin.
     *
     * `players` dit QUI joue (et c'est ça qu'on publie) ; ceci dit COMMENT chaque
     * manette s'appelle sur ce pack, jouante ou non.
     */
    playerLabels?: Record<string, string>;
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
    focusTarget?: { exe?: string; title?: string; dir?: string }; // jeu du pack ACTIF (focus-guard)
    // Jeu piloté PAR PACK (le jeu appartient au pack, pas au connecteur : la manette sert à
    // tous les jeux). Demandé UNE fois au 1er démarrage du pack, puis automatique.
    gameByPack?: Record<string, { exe: string; dir: string }>;
    // CAPACITÉ manettes de la MACHINE (globale, Réglages) : combien de manettes
    // virtuelles le poste sait fournir, et de quel type. L'effectif qui joue
    // réellement se décide PAR PACK (`packOverlays[slug].players`).
    padCapacity?: number;
    padKind?: string; // 'x360' | 'ds4'
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
    packOverlays?: Record<string, PackOverlay>;
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

    // ── Jeu piloté PAR PACK ──
    // Le jeu appartient au PACK, pas au connecteur manette (la manette sert à tous les jeux).
    // Demandé une fois à l'installation du pack ; au démarrage c'est automatique.
    private allGames(): Record<string, { exe: string; dir: string }> {
        return this.store.get('gameByPack', {} as Record<string, { exe: string; dir: string }>);
    }
    getGameForPack(slug: string): { exe: string; dir: string } | null {
        return this.allGames()[slug] || null;
    }
    setGameForPack(slug: string, g: { exe: string; dir: string }) {
        const all = this.allGames();
        all[slug] = g;
        this.store.set('gameByPack', all);
    }
    removeGameForPack(slug: string) {
        const all = this.allGames();
        delete all[slug];
        this.store.set('gameByPack', all);
    }
    getLinkedGames(): Record<string, { exe: string; dir: string }> {
        return this.allGames();
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
    getPackOverlay(slug: string): {
        disabled: string[];
        cooldownMs: Record<string, number>;
        profile?: string;
        keyBindings: Record<string, { keys?: string; button?: string }>;
        players?: Array<{ id: number; label?: string }>;
    } {
        const all = this.store.get('packOverlays', {} as Record<string, PackOverlay>);
        const o = all[slug] || {};
        const out = {
            disabled: o.disabled || [],
            cooldownMs: o.cooldownMs || {},
            keyBindings: o.keyBindings || {},
        } as { disabled: string[]; cooldownMs: Record<string, number>; profile?: string; keyBindings: Record<string, { keys?: string; button?: string }>; players?: Array<{ id: number; label?: string }> };
        if (o.profile) out.profile = o.profile;
        if (o.players) out.players = o.players;
        return out;
    }
    setPackOverlay(slug: string, overlay: PackOverlay): void {
        const all = this.store.get('packOverlays', {} as Record<string, PackOverlay>);
        const prev = all[slug] || {};
        // `profile` (configuration de commandes choisie) n'est PAS toujours transmis : la
        // modale de personnalisation peut n'envoyer que disabled/cooldownMs. On le conserve
        // au lieu de l'effacer, sinon le joueur repasserait en clavier sans rien demander.
        const next: PackOverlay = { disabled: overlay.disabled || [], cooldownMs: overlay.cooldownMs || {} };
        const profile = overlay.profile !== undefined ? overlay.profile : prev.profile;
        if (profile) next.profile = profile;
        // Même raisonnement que pour `profile` : un appelant qui n'envoie pas les remappages
        // ne doit pas les EFFACER. Le joueur perdrait ses touches sans avoir rien demandé.
        const kb = overlay.keyBindings !== undefined ? overlay.keyBindings : prev.keyBindings;
        if (kb && Object.keys(kb).length) next.keyBindings = kb;
        // MÊME PIÈGE que `profile` et `keyBindings`, et il coûterait encore plus cher :
        // la modale de personnalisation n'envoie que disabled/cooldownMs. Sans cette
        // ligne, ouvrir puis enregistrer la personnalisation EFFACERAIT l'effectif du
        // pack, et le diffuseur perdrait les noms de ses joueurs sans rien avoir
        // demandé — en plein direct, sans aucun message.
        const pl = overlay.players !== undefined ? overlay.players : prev.players;
        if (pl) next.players = pl;
        const nl = overlay.playerLabels !== undefined ? overlay.playerLabels : prev.playerLabels;
        if (nl && Object.keys(nl).length) next.playerLabels = nl;
        all[slug] = next;
        this.store.set('packOverlays', all);
    }

    /**
     * EFFECTIF d'un pack, borné par la CAPACITÉ de la machine.
     *
     * Le bornage se fait à la LECTURE, pas seulement à l'écriture : le diffuseur
     * peut avoir configuré quatre joueurs sur son PC de salon puis ouvert l'app sur
     * un poste qui n'en fournit que deux. Publier quatre cibles là ferait payer un
     * cadeau qui n'agirait nulle part.
     *
     * `null` = jamais configuré pour ce pack (l'appelant proposera un défaut) ;
     * `[]` = le diffuseur a dit « personne ».
     */
    getPackPlayers(slug: string): Array<{ id: number; label?: string }> | null {
        const o = this.store.get('packOverlays', {} as Record<string, PackOverlay>)[slug];
        if (!o || o.players === undefined) return null;
        const cap = this.getPadCapacity().count;
        const noms = o.playerLabels || {};
        return (o.players || [])
            .filter((p) => Number.isInteger(p?.id) && p.id >= 1 && p.id <= Math.min(cap, MAX_JOUEURS))
            .map((p) => {
                const label = p.label || noms[String(p.id)] || '';
                return label ? { id: p.id, label } : { id: p.id };
            })
            .sort((a, b) => a.id - b.id);
    }

    /** Noms mémorisés pour ce pack, manettes non jouantes comprises. */
    getPackPlayerLabels(slug: string): Record<string, string> {
        const o = this.store.get('packOverlays', {} as Record<string, PackOverlay>)[slug];
        return { ...(o?.playerLabels || {}) };
    }

    /** Écrit l'effectif d'un pack SANS toucher au reste de son calque. */
    setPackPlayers(slug: string, players: Array<{ id: number; label?: string }>): void {
        const all = this.store.get('packOverlays', {} as Record<string, PackOverlay>);
        const prev = all[slug] || {};
        const vus = new Set<number>();
        const propres: Array<{ id: number; label?: string }> = [];
        for (const p of Array.isArray(players) ? players : []) {
            const id = Number(p?.id);
            if (!Number.isInteger(id) || id < 1 || id > MAX_JOUEURS || vus.has(id)) continue;
            vus.add(id);
            // Le libellé est renvoyé tel quel au serveur, qui le renettoie de son
            // côté : on borne déjà ici pour que le champ affiche ce qui sera vu.
            const label = typeof p?.label === 'string' ? p.label.trim().slice(0, 24) : '';
            propres.push(label ? { id, label } : { id });
        }
        // Les noms sont MUSÉES : on fusionne au lieu de remplacer, pour qu'une
        // manette retirée de l'effectif retrouve son nom si elle y revient.
        const noms = { ...(prev.playerLabels || {}) };
        for (const p of propres) {
            if (p.label) noms[String(p.id)] = p.label;
        }
        all[slug] = {
            ...prev,
            players: propres.sort((a, b) => a.id - b.id),
            playerLabels: noms,
        };
        this.store.set('packOverlays', all);
    }

    /**
     * CAPACITÉ manettes de la machine : combien de manettes virtuelles ce poste sait
     * fournir, et de quel type. Propriété du MATÉRIEL, donc globale.
     *
     * Au-delà de deux joueurs le type DOIT être 'ds4' : Windows n'a que quatre
     * emplacements XInput, partagés avec les manettes physiques, donc les Xbox 360
     * virtuelles suivantes sont acceptées par ViGEm tout en restant INVISIBLES du
     * jeu. On corrige à la lecture plutôt que de servir une capacité qui ne peut
     * pas exister.
     */
    getPadCapacity(): { count: number; kind: string } {
        const n = Number(this.store.get('padCapacity', 0));
        const count = Number.isInteger(n) ? Math.max(0, Math.min(MAX_JOUEURS, n)) : 0;
        let kind = this.store.get('padKind', 'x360');
        if (kind !== 'x360' && kind !== 'ds4') kind = 'x360';
        if (count > 2) kind = 'ds4';
        return { count, kind };
    }
    setPadCapacity(count: number, kind?: string): { count: number; kind: string } {
        const n = Number(count);
        this.store.set('padCapacity', Number.isInteger(n) ? Math.max(0, Math.min(MAX_JOUEURS, n)) : 0);
        if (kind === 'x360' || kind === 'ds4') this.store.set('padKind', kind);
        return this.getPadCapacity();
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
