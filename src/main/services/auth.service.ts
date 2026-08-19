import { shell } from 'electron';
import { randomBytes, createHash } from 'crypto';
import { CONFIG } from '../config';
import { ApiService } from './api.service';
import { StoreService } from './store.service';

// OAuth 2.0 Authorization Code + PKCE (S256), ouvert dans le navigateur système,
// retour via le protocole custom houla-connect://callback. Même modèle que houla-print.
export class AuthService {
    private codeVerifier: string | null = null;

    constructor(
        private readonly api: ApiService,
        private readonly store: StoreService,
    ) {}

    async login(): Promise<void> {
        this.codeVerifier = randomBytes(32).toString('base64url');
        const challenge = createHash('sha256').update(this.codeVerifier).digest().toString('base64url');
        const params = new URLSearchParams({
            response_type: 'code',
            client_id: CONFIG.clientId,
            redirect_uri: CONFIG.redirectUri,
            code_challenge: challenge,
            code_challenge_method: 'S256',
            scope: CONFIG.scopes.join(' '),
        });
        await shell.openExternal(`${CONFIG.appUrl}/oauth/authorize?${params.toString()}`);
    }

    async handleCallback(url: string): Promise<void> {
        const code = new URL(url).searchParams.get('code');
        if (!code || !this.codeVerifier) throw new Error('callback OAuth invalide');
        await this.api.exchangeCode(code, this.codeVerifier);
        this.codeVerifier = null;
    }

    isAuthenticated(): boolean {
        return !!this.store.getAccessToken();
    }

    logout(): void {
        this.store.clearAuth();
    }
}
