// Types du manifeste v2 (miroir du plan exécutable côté API). DONNÉE PURE :
// des règles trigger -> effet interprétées par les exécuteurs INTÉGRÉS de l'app.

export type ExecutorType = 'keyboard' | 'gamepad' | 'rcon' | 'obs' | 'http' | 'python';

export interface KeyboardEffect {
    type: 'keyboard';
    backend?: 'auto' | 'nut' | 'interception';
    keys: string; // 'space' | 'shift+c' | 'c,c,c' | 'space:400'
    cooldownMs?: number;
}
export interface GamepadEffect {
    type: 'gamepad';
    button: string;
    holdMs?: number;
    cooldownMs?: number;
}
export interface RconEffect {
    type: 'rcon';
    command: string;
    cooldownMs?: number;
}
export interface ObsEffect {
    type: 'obs';
    request: string;
    params?: Record<string, unknown>;
    cooldownMs?: number;
}
export interface HttpEffect {
    type: 'http';
    method: 'GET' | 'POST' | 'PUT';
    url: string;
    json?: Record<string, unknown>;
    cooldownMs?: number;
}
export interface PythonEffect {
    type: 'python';
    helper: 'interception-keys' | 'vigem-gamepad';
    args?: Record<string, unknown>;
    cooldownMs?: number;
}
export type BundleEffect =
    | KeyboardEffect
    | GamepadEffect
    | RconEffect
    | ObsEffect
    | HttpEffect
    | PythonEffect;

export interface BundleTrigger {
    type: 'gift' | 'follow' | 'comment' | 'share' | 'hearts';
    slot?: string;
    contains?: string;
    milestone?: number;
}
export interface BundleRule {
    id: string;
    on: BundleTrigger;
    effect: BundleEffect;
    label?: string;
    followersOnly?: boolean;
    moderatorsOnly?: boolean;
}
export interface BundleManifest {
    schema: 2;
    slug: string;
    game?: string;
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
}

/** Un exécuteur transforme un effet déclaratif en I/O réelle (dans le process MAIN). */
export interface Executor {
    readonly type: ExecutorType;
    /** La capacité que l'utilisateur doit avoir accordée pour que fire() tourne. */
    readonly capability: string;
    /** Valide + encode l'effet (encodage PROPRE à l'exécuteur), lève si invalide. */
    validate(effect: BundleEffect): void;
    fire(effect: BundleEffect, ctx: FireContext): Promise<void>;
    /** Panic : relâche toute touche/bouton maintenu. */
    releaseAll?(): Promise<void> | void;
    dispose?(): Promise<void> | void;
}
