import { HoulaLiveConnection } from '@houla/live-connector';
import { TriggerRouter } from '../engine/trigger-router';

export interface ConnState {
    connected: boolean;
    events?: string[];
    error?: string;
}

// Ouvre la connexion temps réel (clé hle_) et route chaque événement vers le
// TriggerRouter. reactsTo = les slugs de cadeaux du manifeste (badge côté viewer).
export class ConnectionService {
    private conn: HoulaLiveConnection | null = null;
    private workspaceId: string | null = null;
    private lastEventAt = 0;
    private pollTimer: ReturnType<typeof setInterval> | null = null;
    private seedTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(
        private readonly router: TriggerRouter,
        private readonly onState: (s: ConnState) => void,
        // URL de l'API de l'environnement COURANT (prod/staging/dev). La clé event
        // est mintée sur cet env : le socket DOIT viser le même, sinon auth rejetée.
        private readonly baseUrl: () => string,
    ) {}

    connect(eventKey: string, workspaceId?: string): void {
        this.disconnect();
        this.workspaceId = workspaceId || null;
        this.lastEventAt = Date.now();
        this.conn = new HoulaLiveConnection({ token: eventKey, url: this.baseUrl() });
        this.conn.on('connected', (info: any) => this.onState({ connected: true, events: info.events }));
        this.conn.on('disconnected', () => this.onState({ connected: false }));
        this.conn.on('error', (e: any) => this.onState({ connected: false, error: e.message }));
        this.conn.on('gift', (g: any) => this.router.onGift(g));
        this.conn.on('follow', (f: any) => this.router.onFollow(f));
        this.conn.on('comment', (c: any) => this.router.onComment(c));
        // 'viewer' : seul 'share' déclenche une règle ; la présence vient de la metadata.
        this.conn.on('viewer', (v: any) => this.router.onViewer(v));
        this.conn.on('hearts', (h: any) => this.router.onHearts(h));
        // Enveloppe BRUTE : porte la metadata `viewers` (compte de présence). On la lit
        // et on note l'instant du dernier event (pour armer le poll de fallback).
        this.conn.on('event', (env: any) => {
            this.lastEventAt = Date.now();
            if (env && typeof env.viewers === 'number') this.router.updateViewers(env.viewers);
        });
        this.conn.connect();
        this.startViewerPoll();
    }

    // ── Poll de fallback du compte de viewers ──────────────────────────────
    // La metadata `viewers` n'arrive qu'avec un event. Pendant un creux (aucun
    // cadeau/message), le compte se fige : toutes les 60 s SANS event, on va le
    // chercher sur l'endpoint public (lecture DB indexée, hors hot path serveur).
    private startViewerPoll(): void {
        this.stopViewerPoll();
        if (!this.workspaceId) return;
        // Amorce rapide (baseline) peu après la connexion, puis tick régulier.
        // Le handle est tracké et annulé au disconnect (sinon il tirerait contre une
        // reconnexion rapide).
        this.seedTimer = setTimeout(() => { this.seedTimer = null; void this.pollViewers(true); }, 3000);
        this.pollTimer = setInterval(() => {
            if (Date.now() - this.lastEventAt >= 60000) void this.pollViewers(false);
        }, 60000);
    }
    private stopViewerPoll(): void {
        if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
        if (this.seedTimer) { clearTimeout(this.seedTimer); this.seedTimer = null; }
    }
    private async pollViewers(seed: boolean): Promise<void> {
        if (!this.workspaceId || !this.connected) return;
        try {
            const res = await fetch(`${this.baseUrl()}/api/live/interactive/${encodeURIComponent(this.workspaceId)}/viewers`);
            if (!res.ok) return;
            const d: any = await res.json();
            if (d && d.live && typeof d.viewers === 'number') this.router.updateViewers(d.viewers);
        } catch {
            /* réseau indisponible : on réessaiera au prochain tick */
        }
    }

    /** Test hors-ligne : simule un cadeau sur un slot (exerce tout le pipeline). */
    simulateGift(slug: string): void {
        if (this.conn) this.conn.simulateGift({ slug });
    }

    get connected(): boolean {
        return !!this.conn?.connected;
    }

    disconnect(): void {
        this.stopViewerPoll();
        this.workspaceId = null;
        try {
            this.conn?.disconnect();
        } catch {
            /* noop */
        }
        this.conn = null;
    }
}
