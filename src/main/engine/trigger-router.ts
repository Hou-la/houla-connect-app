import { Engine } from './engine';
import { BundleManifest, BundleRule, FireContext } from './types';

// Route les événements live (SDK @houla/live-connector) vers les règles du
// manifeste, construit le FireContext, et délègue au moteur. Réutilise le même
// pipeline dedup/cooldown/gate pour TOUS les triggers (pas seulement les cadeaux).
export class TriggerRouter {
    private manifest: BundleManifest | null = null;
    private lastHearts = 0;

    constructor(
        private readonly engine: Engine,
        private readonly getVars: () => Record<string, string | number>,
    ) {}

    setManifest(m: BundleManifest | null): void {
        this.manifest = m;
        this.lastHearts = 0;
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
        if (!text) return;
        for (const r of this.rules(
            (x) => x.on.type === 'comment' && !!x.on.contains && text.includes(x.on.contains.toLowerCase()),
        )) {
            this.engine.dispatch(r, {
                ...this.baseCtx(r.id),
                senderName: comment.author?.name || 'Quelqu\'un',
                isFollower: !!comment.author?.isFollower,
                isModerator: !!comment.author?.isModerator,
            });
        }
    }

    onShare(viewer: any): void {
        if (viewer?.kind !== 'share') return;
        for (const r of this.rules((x) => x.on.type === 'share')) {
            this.engine.dispatch(r, {
                ...this.baseCtx(r.id),
                senderName: viewer.viewer?.name || 'Quelqu\'un',
                isFollower: !!viewer.viewer?.isFollower,
                isModerator: !!viewer.viewer?.isModerator,
            });
        }
    }

    onHearts(hearts: any): void {
        const total = Number(hearts?.totalHearts ?? 0);
        const prev = this.lastHearts;
        this.lastHearts = total;
        if (total <= prev) return;
        for (const r of this.rules(
            (x) =>
                x.on.type === 'hearts' &&
                typeof x.on.milestone === 'number' &&
                x.on.milestone > prev &&
                x.on.milestone <= total,
        )) {
            // dedup par palier atteint (une seule fois).
            this.engine.dispatch(r, this.baseCtx(r.id), `hearts:${r.id}:${r.on.milestone}`);
        }
    }
}
