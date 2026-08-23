import { Executor, BundleRule, BundleEffect, FireContext, ExecutorType } from './types';
import { PythonSidecar } from './python-sidecar';
import { KeyboardExecutor } from './executors/keyboard.executor';
import { GamepadExecutor } from './executors/gamepad.executor';
import { RconExecutor, RconConfig } from './executors/rcon.executor';
import { ObsExecutor, ObsConfig } from './executors/obs.executor';
import { HttpExecutor } from './executors/http.executor';
import { PythonExecutor } from './executors/python.executor';
import { MqttExecutor, MqttConfig } from './executors/mqtt.executor';
import { OscExecutor } from './executors/osc.executor';
import { WsExecutor } from './executors/ws.executor';

export interface AuditEntry {
    ts: number;
    ruleId: string;
    trigger: string;
    sender: string;
    /** Nom du cadeau déclencheur (pour un journal lisible). */
    giftName?: string;
    /** Quantité du combo (un envoi ×N). */
    quantity?: number;
    /** Nombre d'exécutions réellement jouées (honore la quantité, plafonné). */
    fired?: number;
    executor: ExecutorType;
    allowed: boolean;
    reason?: string;
}

export interface EngineDeps {
    /** Capacités accordées par l'utilisateur (allowKeyboard, allowHttp, ...). */
    getCapabilities: () => Set<string>;
    /** Variables locales (secrets par nom : {rconHost}, {ha_base}, {player}, ...). */
    getVars: () => Record<string, string | number>;
    getHostAllowlist: () => string[];
    getRconConfig: () => RconConfig | null;
    getObsConfig: () => ObsConfig | null;
    getMqttConfig: () => MqttConfig | null;
    /** Résout le connecteur lié à un effet (endpoint + identifiants), ou null. */
    resolveConnector: (effect: BundleEffect, bundleSlug?: string) => { type: string; config: Record<string, string> } | null;
    /** true si un connecteur LOCAL activé de ce type existe (clavier/manette/pilote). */
    hasEnabledConnector: (type: string) => boolean;
    sidecar: () => PythonSidecar;
    /** Fenêtre cible au premier plan ? (focus-guard clavier/manette). */
    isTargetFocused: () => boolean;
    audit: (entry: AuditEntry) => void;
}

// Le MOTEUR : le seul endroit qui transforme un effet déclaratif en I/O. Pipeline :
// capacité -> focus-guard (clavier/manette) -> dedup -> cooldown -> token-bucket
// global -> executor.validate -> executor.fire -> audit.
export class Engine {
    private readonly executors: Map<ExecutorType, Executor>;
    private readonly seen = new Set<string>();
    private readonly lastFired = new Map<string, number>();
    private readonly validated = new WeakSet<object>();
    private bucket = 0;
    private bucketResetAt = 0;
    private readonly MAX_PER_SEC = 20;
    /** Plafond d'exécutions pour UN combo (un cadeau ×N) : « 3 cadeaux = 3 effets »,
     *  mais un combo géant ne fait pas spawn 1000 entités. */
    private static readonly MAX_REPS = 20;

    constructor(private readonly deps: EngineDeps) {
        this.executors = new Map<ExecutorType, Executor>([
            ['keyboard', new KeyboardExecutor(deps.sidecar)],
            ['gamepad', new GamepadExecutor(deps.sidecar)],
            ['rcon', new RconExecutor(deps.getRconConfig)],
            ['obs', new ObsExecutor(deps.getObsConfig)],
            ['http', new HttpExecutor(deps.getHostAllowlist)],
            ['python', new PythonExecutor(deps.sidecar)],
            ['mqtt', new MqttExecutor(deps.getMqttConfig)],
            ['osc', new OscExecutor()],
            ['ws', new WsExecutor(deps.getHostAllowlist)],
        ]);
    }

    private now(): number {
        return Date.now();
    }

    /** Fusionne la config NON secrète du connecteur dans les variables ({player}, {host}…). */
    private applyConnectorVars(ctx: FireContext): void {
        if (!ctx.connector) return;
        const extra: Record<string, string> = {};
        for (const [k, v] of Object.entries(ctx.connector.config)) {
            if (k !== 'password') extra[k] = v; // jamais de secret dans les substitutions
        }
        ctx.vars = { ...ctx.vars, ...extra };
    }

    private tokenOk(): boolean {
        const t = this.now();
        if (t >= this.bucketResetAt) {
            this.bucket = 0;
            this.bucketResetAt = t + 1000;
        }
        if (this.bucket >= this.MAX_PER_SEC) return false;
        this.bucket++;
        return true;
    }

    async dispatch(rule: BundleRule, ctx: FireContext, transactionId?: string | null): Promise<void> {
        const effect = rule.effect;
        const executor = this.executors.get(effect.type);
        const audit = (allowed: boolean, reason?: string, fired?: number) =>
            this.deps.audit({
                ts: this.now(),
                ruleId: rule.id,
                trigger: rule.on.type,
                sender: ctx.senderName,
                // Le nom de la règle (ex. « Diamant ») prime sur le nom générique du
                // slot de base (« Interactive 09 ») pour un journal lisible.
                giftName: rule.label || ctx.giftName || undefined,
                quantity: ctx.quantity || 1,
                fired,
                executor: effect.type,
                allowed,
                reason,
            });

        if (!executor) return audit(false, 'exécuteur inconnu');

        // 1. Dedup (le même cadeau peut arriver 2x sur reconnexion) — silencieux :
        //    c'est un VRAI doublon de livraison, pas un cadeau distinct.
        if (transactionId) {
            if (this.seen.has(transactionId)) return;
            this.seen.add(transactionId);
            if (this.seen.size > 5000) this.seen.clear();
        }
        // 2. Gating rôles.
        if (rule.followersOnly && !ctx.isFollower) return audit(false, 'abonnés uniquement');
        if (rule.moderatorsOnly && !ctx.isModerator) return audit(false, 'modérateurs uniquement');
        // 3. Injection locale : gardée par un connecteur LOCAL activé (clavier/manette/
        //    pilote). Le réseau est gardé par la résolution d'un connecteur (étape 6).
        if (executor.requiresCapability && !this.deps.hasEnabledConnector(executor.localConnectorType || ''))
            return audit(false, `connecteur « ${executor.localConnectorType} » désactivé`);
        // 4. Focus-guard clavier/manette (default-deny si focus inconnu/mauvais).
        if ((effect.type === 'keyboard' || effect.type === 'gamepad') && !this.deps.isTargetFocused())
            return audit(false, 'fenêtre cible pas au premier plan');
        // 5. Cooldown par règle (OPT-IN, défaut 0) — VISIBLE quand il throttle, pour ne
        //    pas donner l'impression que « rien ne se passe ». Ne collapse PAS des
        //    cadeaux distincts par défaut : chaque cadeau payé compte.
        const cd = (effect as any).cooldownMs ?? 0;
        if (cd > 0) {
            const last = this.lastFired.get(rule.id) ?? 0;
            if (this.now() - last < cd) return audit(false, `cooldown ${cd} ms`);
        }

        // 6. Valider (une fois) + résoudre le connecteur + exécuter QUANTITÉ fois.
        //    Un combo de N cadeaux -> N effets (« 3 cadeaux = 3 zombies »), plafonné
        //    par MAX_REPS et par le token-bucket global anti-flood.
        try {
            if (!this.validated.has(effect as object)) {
                executor.validate(effect as BundleEffect);
                this.validated.add(effect as object);
            }
            ctx.connector = this.deps.resolveConnector(effect as BundleEffect);
            this.applyConnectorVars(ctx);
            // repeat:'once' -> l'effet ne joue qu'une fois quelle que soit la quantité
            //   (idéal pour une annonce chat « [pseudo] a offert X », qui utilise
            //   {quantity} pour afficher le nombre sans se répéter). Défaut = par quantité.
            const reps =
                (effect as any).repeat === 'once'
                    ? 1
                    : Math.max(1, Math.min(Number(ctx.quantity) || 1, Engine.MAX_REPS));
            let fired = 0;
            for (let i = 0; i < reps; i++) {
                if (!this.tokenOk()) break; // anti-flood global atteint
                await executor.fire(effect as BundleEffect, ctx);
                fired++;
            }
            this.lastFired.set(rule.id, this.now());
            if (fired === 0) return audit(false, 'rate-limit global');
            audit(true, fired < reps ? `rate-limit (${fired}/${reps})` : undefined, fired);
        } catch (err: any) {
            audit(false, err?.message || 'échec exécuteur', undefined);
        }
    }

    /**
     * TEST MANUEL d'une règle depuis le Lab. Passe par le MÊME pipeline de sécurité
     * (capacité accordée -> focus-guard clavier/manette -> executor.validate ->
     * fire), mais sans dedup ni cooldown (déclenchement volontaire). L'effet reste
     * de la DONNÉE déclarative sur un exécuteur INTÉGRÉ : main ne joue rien que
     * l'exécuteur n'ait validé. Renvoie un verdict lisible pour l'UI.
     */
    async testFire(rule: BundleRule, bundleSlug?: string): Promise<{ ok: boolean; reason?: string }> {
        const effect = rule?.effect;
        const executor = effect && this.executors.get(effect.type);
        if (!executor) return { ok: false, reason: 'exécuteur inconnu' };
        if (executor.requiresCapability && !this.deps.hasEnabledConnector(executor.localConnectorType || ''))
            return { ok: false, reason: `connecteur « ${executor.localConnectorType} » désactivé — active-le dans Connecteurs` };
        if ((effect.type === 'keyboard' || effect.type === 'gamepad') && !this.deps.isTargetFocused())
            return { ok: false, reason: 'fenêtre cible pas au premier plan (focus le jeu avant de tester)' };
        const ctx: FireContext = {
            ruleId: rule.id || 'test',
            senderName: 'Test',
            isFollower: true,
            isModerator: true,
            quantity: 1,
            coins: 0,
            giftName: 'Test',
            vars: this.deps.getVars(),
            connector: this.deps.resolveConnector(effect as BundleEffect, bundleSlug),
        };
        this.applyConnectorVars(ctx);
        try {
            executor.validate(effect as BundleEffect);
            await executor.fire(effect as BundleEffect, ctx);
            return { ok: true };
        } catch (err: any) {
            return { ok: false, reason: err?.message || 'échec exécuteur' };
        }
    }

    /** PANIC : relâche toute touche/bouton tenu sur tous les exécuteurs. */
    async panic(): Promise<void> {
        for (const ex of this.executors.values()) {
            try {
                await ex.releaseAll?.();
            } catch {
                /* noop */
            }
        }
    }

    async dispose(): Promise<void> {
        for (const ex of this.executors.values()) {
            try {
                await ex.dispose?.();
            } catch {
                /* noop */
            }
        }
    }
}
