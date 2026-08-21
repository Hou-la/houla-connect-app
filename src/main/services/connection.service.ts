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

    constructor(
        private readonly router: TriggerRouter,
        private readonly onState: (s: ConnState) => void,
        // URL de l'API de l'environnement COURANT (prod/staging/dev). La clé event
        // est mintée sur cet env : le socket DOIT viser le même, sinon auth rejetée.
        private readonly baseUrl: () => string,
    ) {}

    connect(eventKey: string): void {
        this.disconnect();
        this.conn = new HoulaLiveConnection({ token: eventKey, url: this.baseUrl() });
        this.conn.on('connected', (info: any) => this.onState({ connected: true, events: info.events }));
        this.conn.on('disconnected', () => this.onState({ connected: false }));
        this.conn.on('error', (e: any) => this.onState({ connected: false, error: e.message }));
        this.conn.on('gift', (g: any) => this.router.onGift(g));
        this.conn.on('follow', (f: any) => this.router.onFollow(f));
        this.conn.on('comment', (c: any) => this.router.onComment(c));
        this.conn.on('viewer', (v: any) => this.router.onShare(v));
        this.conn.on('hearts', (h: any) => this.router.onHearts(h));
        this.conn.connect();
    }

    /** Test hors-ligne : simule un cadeau sur un slot (exerce tout le pipeline). */
    simulateGift(slug: string): void {
        if (this.conn) this.conn.simulateGift({ slug });
    }

    get connected(): boolean {
        return !!this.conn?.connected;
    }

    disconnect(): void {
        try {
            this.conn?.disconnect();
        } catch {
            /* noop */
        }
        this.conn = null;
    }
}
