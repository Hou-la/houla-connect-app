// Types du manifeste v2 (miroir du plan exécutable côté API). DONNÉE PURE :
// des règles trigger -> effet interprétées par les exécuteurs INTÉGRÉS de l'app.

export type ExecutorType = 'keyboard' | 'gamepad' | 'rcon' | 'obs' | 'http' | 'python' | 'mqtt' | 'osc' | 'ws';

export interface KeyboardEffect {
    type: 'keyboard';
    backend?: 'auto' | 'nut' | 'interception';
    keys: string; // 'space' | 'shift+c' (ensemble) | 'up,up,down,down' (suite) | 'space:400'
    gapMs?: number; // délai (ms) entre chaque touche d'une suite (rythme), défaut ~40
    cooldownMs?: number;
}
export interface GamepadStep {
    buttons?: string[]; // chord (touches EN MÊME TEMPS) de cette étape
    button?: string; // ou une seule touche
    holdMs?: number; // durée d'appui de l'étape
    waitMs?: number; // pause APRÈS l'étape (permet « combo -> attendre 5 s -> stop »)
}
export interface GamepadAnalog {
    lx?: number; ly?: number; // stick gauche, -1..1
    rx?: number; ry?: number; // stick droit, -1..1
    lt?: number; rt?: number; // gâchettes, 0..1
}
export interface GamepadEffect {
    type: 'gamepad';
    button?: string; // bouton unique
    buttons?: string[]; // CHORD : plusieurs touches enfoncées en même temps
    sequence?: string[]; // combo ordonné, joué avant le tirage aléatoire
    randomFrom?: string[]; // un bouton au hasard, joué APRÈS button/sequence
    steps?: GamepadStep[]; // TIMELINE : étapes (chord + hold + attente) enchaînées
    analog?: GamepadAnalog; // stick/gâchette poussé à une intensité, tenu holdMs
    gapMs?: number; // pause entre deux appuis d'une séquence (défaut ~150)
    holdMs?: number;
    repeat?: number; // répéter l'effet X fois (1..20)
    repeatGapMs?: number; // intervalle entre deux répétitions
    cooldownMs?: number;
}
export interface RconEffect {
    type: 'rcon';
    command: string;
    connector?: string;
    cooldownMs?: number;
}
export interface ObsEffect {
    type: 'obs';
    request: string;
    params?: Record<string, unknown>;
    connector?: string;
    cooldownMs?: number;
}
export interface HttpEffect {
    type: 'http';
    method: 'GET' | 'POST' | 'PUT';
    url?: string; // fallback si pas de connecteur
    path?: string; // chemin relatif au baseUrl du connecteur
    json?: Record<string, unknown>;
    connector?: string;
    cooldownMs?: number;
}
export interface PythonEffect {
    type: 'python';
    helper: 'interception-keys' | 'vigem-gamepad';
    args?: Record<string, unknown>;
    cooldownMs?: number;
}
export interface MqttEffect {
    type: 'mqtt';
    topic: string;
    payload: string;
    qos?: 0 | 1 | 2;
    retain?: boolean;
    connector?: string;
    cooldownMs?: number;
}
export interface OscEffect {
    type: 'osc';
    address: string;
    args?: Array<string | number | boolean>;
    host?: string; // fallback si pas de connecteur
    port?: number; // fallback si pas de connecteur
    connector?: string;
    cooldownMs?: number;
}
export interface WsEffect {
    type: 'ws';
    url?: string; // fallback si pas de connecteur
    message: string;
    connector?: string;
    cooldownMs?: number;
}
export type BundleEffect =
    | KeyboardEffect
    | GamepadEffect
    | RconEffect
    | ObsEffect
    | HttpEffect
    | PythonEffect
    | MqttEffect
    | OscEffect
    | WsEffect;

export interface BundleTrigger {
    type: 'gift' | 'follow' | 'comment' | 'share' | 'hearts' | 'viewer';
    /** Pour 'gift' : slug du cadeau déclencheur (générique ou slot réservé). Canonique. */
    giftSlug?: string;
    /** @deprecated alias de giftSlug restreint aux slots réservés (packs déjà signés). */
    slot?: string;
    contains?: string;
    milestone?: number;
    /** « Tous les N » : tranche d'événements (comment/share/viewer) ou de likes cumulés (hearts). */
    every?: number;
}
export interface BundleRule {
    id: string;
    on: BundleTrigger;
    effect: BundleEffect;
    label?: string;
    followersOnly?: boolean;
    moderatorsOnly?: boolean;
    /**
     * Configuration de commandes à laquelle la règle appartient (id d'un `profiles`).
     * **Absent = vaut pour TOUTES les configurations** (effets indépendants du
     * périphérique : OBS, RCON, HTTP…).
     */
    profile?: string;
}
/**
 * Une CONFIGURATION DE COMMANDES : le même pack décrit ses actions une fois au clavier,
 * une fois à la manette. Le joueur choisit la sienne ; sans ça, la moitié des joueurs
 * se retrouve avec un pack inerte, puisque rien n'est remappable de leur côté.
 */
export interface BundleControlProfile {
    id: string;
    label: string;
    default?: boolean;
}
export interface BundleManifest {
    schema: 2;
    slug: string;
    game?: string;
    profiles?: BundleControlProfile[];
    rules: BundleRule[];
}

/** Contexte d'un événement live résolu, passé aux exécuteurs pour la substitution. */
export interface FireContext {
    ruleId: string;
    senderName: string;
    isFollower: boolean;
    isModerator: boolean;
    quantity: number;
    coins: number;
    giftName: string;
    /** Variables locales du streamer (secrets par NOM : {rconHost}, {ha_base}...). */
    vars: Record<string, string | number>;
    /** Connecteur résolu pour CET effet (endpoint + identifiants), si lié. */
    connector?: { type: string; config: Record<string, string> } | null;
}

/** Un exécuteur transforme un effet déclaratif en I/O réelle (dans le process MAIN). */
export interface Executor {
    readonly type: ExecutorType;
    /** La capacité que l'utilisateur doit avoir accordée pour que fire() tourne. */
    readonly capability: string;
    /**
     * true = injection locale invasive (clavier/manette/pilote) -> gardée par un
     * CONNECTEUR LOCAL activé (localConnectorType). false = protocole réseau ->
     * gardé par la présence d'un connecteur réseau lié + activé.
     */
    readonly requiresCapability: boolean;
    /** Pour les exécuteurs locaux : type du connecteur local (keyboard|gamepad|driver). */
    readonly localConnectorType?: string;
    /** Valide + encode l'effet (encodage PROPRE à l'exécuteur), lève si invalide. */
    validate(effect: BundleEffect): void;
    fire(effect: BundleEffect, ctx: FireContext): Promise<void>;
    /** Panic : relâche toute touche/bouton maintenu. */
    releaseAll?(): Promise<void> | void;
    dispose?(): Promise<void> | void;
}
