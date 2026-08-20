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
    private readonly MAX_PER_SEC = 12;

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
        const audit = (allowed: boolean, reason?: string) =>
            this.deps.audit({
                ts: this.now(),
                ruleId: rule.id,
                trigger: rule.on.type,
                sender: ctx.senderName,
                executor: effect.type,
                allowed,
                reason,
            });

        if (!executor) return audit(false, 'exécuteur inconnu');

        // 1. Dedup (le même cadeau peut arriver 2x sur reconnexion).
        if (transactionId) {
            if (this.seen.has(transactionId)) return; // silencieux
            this.seen.add(transactionId);
            if (this.seen.size > 5000) this.seen.clear();
        }
        // 2. Gating rôles.
        if (rule.followersOnly && !ctx.isFollower) return audit(false, 'abonnés uniquement');
        if (rule.moderatorsOnly && !ctx.isModerator) return audit(false, 'modérateurs uniquement');
        // 3. Capacité accordée ?
        if (!this.deps.getCapabilities().has(executor.capability))
            return audit(false, `capacité non accordée (${executor.capability})`);
        // 4. Focus-guard clavier/manette (default-deny si focus inconnu/mauvais).
        if ((effect.type === 'keyboard' || effect.type === 'gamepad') && !this.deps.isTargetFocused())
            return audit(false, 'fenêtre cible pas au premier plan');
        // 5. Cooldown par règle.
        const cd = (effect as any).cooldownMs ?? 0;
        if (cd > 0) {
            const last = this.lastFired.get(rule.id) ?? 0;
            if (this.now() - last < cd) return; // silencieux
        }
        // 6. Token bucket global (anti-flood).
        if (!this.tokenOk()) return audit(false, 'rate-limit global');

        // 7. Valider (une fois) + exécuter.
        try {
            if (!this.validated.has(effect as object)) {
                executor.validate(effect as BundleEffect);
                this.validated.add(effect as object);
            }
            await executor.fire(effect as BundleEffect, ctx);
            this.lastFired.set(rule.id, this.now());
            audit(true);
        } catch (err: any) {
            audit(false, err?.message || 'échec exécuteur');
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
