import { Engine } from './engine';
import { BundleManifest, BundleRule, FireContext } from './types';

// Route les événements live (SDK @houla/live-connector) vers les règles du
// manifeste, construit le FireContext, et délègue au moteur. Réutilise le même
// pipeline dedup/cooldown/gate pour TOUS les triggers (pas seulement les cadeaux).
export class TriggerRouter {
    private manifest: BundleManifest | null = null;
    private lastHearts = 0;
    // Compteurs cumulés de la SESSION pour les triggers « tous les N » (par tranche).
    // hearts = total cumulé serveur (lastHearts) ; les autres n'ont aucun compteur
    // serveur, on les accumule ici (remis à zéro à chaque démarrage de pack).
    private commentCount = 0;
    private shareCount = 0;
    // Dernier nombre de SPECTATEURS connu (présence réelle du live), alimenté par la
    // metadata des events + le poll de fallback. Sert au trigger « tous les N viewers ».
    private lastViewers = 0;
    // Le PREMIER compte reçu ne fait qu'établir la base (pas de tir rétroactif : un
    // live déjà à 250 ne doit pas déclencher les paliers 100/200 déjà passés).
    private viewersSeeded = false;

    constructor(
        private readonly engine: Engine,
        private readonly getVars: () => Record<string, string | number>,
    ) {}

    setManifest(m: BundleManifest | null): void {
        this.manifest = m;
        this.lastHearts = 0;
        this.commentCount = 0;
        this.shareCount = 0;
        this.lastViewers = 0;
        this.viewersSeeded = false;
        // Nouvelle session : purge le dedup du moteur, sinon les clés déterministes
        // des tranches/paliers déjà franchis bloqueraient ces triggers au re-démarrage.
        this.engine.resetDedup();
    }

    /** Déclenche `dispatchOne(k)` pour chaque tranche de `every` franchie entre prev et next.
     *  k = index de tranche atteint (k*every), sert de clé de dedup stable « une fois par tranche ». */
    private fireSlices(prev: number, next: number, every: number, dispatchOne: (k: number) => void): void {
        if (!(every >= 1) || next <= prev) return;
        const from = Math.floor(prev / every) + 1;
        const to = Math.floor(next / every);
        for (let k = from; k <= to; k++) dispatchOne(k);
    }

    private baseCtx(ruleId: string): FireContext {
        return {
            ruleId,
            senderName: 'Quelqu\'un',
            isFollower: false,
            isModerator: false,
            quantity: 1,
            coins: 0,
            giftName: '',
            vars: this.getVars(),
        };
    }

    private rules(pred: (r: BundleRule) => boolean): BundleRule[] {
        return (this.manifest?.rules ?? []).filter(pred);
    }

    onGift(gift: any): void {
        // L'event porte gift.slug pour N'IMPORTE quel cadeau (générique ou slot réservé).
        // La règle matche via giftSlug (canonique) ou slot (alias déprécié).
        const slug = gift?.gift?.slug;
        if (!slug) return;
        for (const r of this.rules((x) => x.on.type === 'gift' && (x.on.giftSlug ?? x.on.slot) === slug)) {
            this.engine.dispatch(
                r,
                {
                    ...this.baseCtx(r.id),
                    senderName: gift.sender?.name || 'Quelqu\'un',
                    isFollower: !!gift.sender?.isFollower,
                    isModerator: !!gift.sender?.isModerator,
                    quantity: gift.gift?.quantity ?? 1,
                    coins: gift.gift?.totalCoins ?? gift.gift?.coinCost ?? 0,
                    giftName: gift.gift?.name || '',
                },
                gift.transactionId,
            );
        }
    }

    onFollow(follow: any): void {
        for (const r of this.rules((x) => x.on.type === 'follow')) {
            this.engine.dispatch(r, {
                ...this.baseCtx(r.id),
                senderName: follow.follower?.name || 'Un nouvel abonné',
                isFollower: true,
                isModerator: !!follow.follower?.isModerator,
            });
        }
    }

    onComment(comment: any): void {
        const text = String(comment?.comment?.content || '').toLowerCase();
        const ctx: FireContext = {
            ...this.baseCtx(''),
            senderName: comment.author?.name || 'Quelqu\'un',
            isFollower: !!comment.author?.isFollower,
            isModerator: !!comment.author?.isModerator,
        };
        // Compteur de tranche : toute occurrence de message compte.
        const prev = this.commentCount;
        this.commentCount += 1;
        const next = this.commentCount;
        // 1) Règles « contient un mot » (inchangé).
        if (text) {
            for (const r of this.rules(
                (x) => x.on.type === 'comment' && !!x.on.contains && text.includes(x.on.contains.toLowerCase()),
            )) {
                this.engine.dispatch(r, { ...ctx, ruleId: r.id });
            }
        }
        // 2) Règles « tous les N messages ».
        for (const r of this.rules((x) => x.on.type === 'comment' && typeof x.on.every === 'number')) {
            this.fireSlices(prev, next, r.on.every as number, (k) =>
                this.engine.dispatch(r, { ...ctx, ruleId: r.id }, `comment:${r.id}:slice:${k}`),
            );
        }
    }

    /** Event SDK 'viewer' (kind: join | share | shop_view | cart_add) : seul 'share'
     *  déclenche une règle. La PRÉSENCE (nombre de viewers) ne vient PAS des join
     *  individuels mais de la metadata `viewers` des events + du poll (updateViewers). */
    onViewer(viewer: any): void {
        if (viewer?.kind === 'share') this.onShare(viewer);
    }

    /**
     * Nombre de SPECTATEURS courant (présence réelle), reçu via la metadata d'un
     * event ou le poll de fallback. Déclenche les triggers « tous les N spectateurs »
     * à chaque tranche FRANCHIE VERS LE HAUT (fireSlices n'agit que si count monte ;
     * une baisse puis remontée ne re-tire pas, grâce au dedup par tranche).
     */
    updateViewers(count: number): void {
        const n = Number(count);
        if (!Number.isFinite(n) || n < 0) return;
        if (!this.viewersSeeded) { this.lastViewers = n; this.viewersSeeded = true; return; }
        const prev = this.lastViewers;
        if (n > prev) {
            for (const r of this.rules((x) => x.on.type === 'viewer' && typeof x.on.every === 'number')) {
                this.fireSlices(prev, n, r.on.every as number, (k) =>
                    this.engine.dispatch(r, { ...this.baseCtx(r.id), senderName: 'Le live' }, `viewer:${r.id}:slice:${k}`),
                );
            }
        }
        this.lastViewers = n;
    }

    onShare(viewer: any): void {
        const ctx: FireContext = {
            ...this.baseCtx(''),
            senderName: viewer.viewer?.name || 'Quelqu\'un',
            isFollower: !!viewer.viewer?.isFollower,
            isModerator: !!viewer.viewer?.isModerator,
        };
        const prev = this.shareCount;
        this.shareCount += 1;
        const next = this.shareCount;
        for (const r of this.rules((x) => x.on.type === 'share')) {
            if (typeof r.on.every === 'number') {
                // Tous les N partages.
                this.fireSlices(prev, next, r.on.every, (k) =>
                    this.engine.dispatch(r, { ...ctx, ruleId: r.id }, `share:${r.id}:slice:${k}`),
                );
            } else {
                // Défaut : à chaque partage (comportement historique).
                this.engine.dispatch(r, { ...ctx, ruleId: r.id });
            }
        }
    }

    onHearts(hearts: any): void {
        const total = Number(hearts?.totalHearts ?? 0);
        const prev = this.lastHearts;
        this.lastHearts = total;
        if (total <= prev) return;
        // 1) Palier ATTEINT (milestone) : une seule fois quand le cumul le traverse.
        for (const r of this.rules(
            (x) =>
                x.on.type === 'hearts' &&
                typeof x.on.milestone === 'number' &&
                x.on.milestone > prev &&
                x.on.milestone <= total,
        )) {
            this.engine.dispatch(r, this.baseCtx(r.id), `hearts:${r.id}:${r.on.milestone}`);
        }
        // 2) Tous les N likes : une fois par tranche franchie (le cumul peut sauter).
        for (const r of this.rules((x) => x.on.type === 'hearts' && typeof x.on.every === 'number')) {
            this.fireSlices(prev, total, r.on.every as number, (k) =>
                this.engine.dispatch(r, this.baseCtx(r.id), `hearts:${r.id}:slice:${k}`),
            );
        }
    }
}
