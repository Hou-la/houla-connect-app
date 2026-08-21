import { shell } from 'electron';
import { randomBytes, createHash } from 'crypto';
import { CONFIG } from '../config';
import { ApiService } from './api.service';
import { StoreService } from './store.service';

// OAuth 2.0 Authorization Code + PKCE (S256), ouvert dans le navigateur système,
// retour via le protocole custom houla-connect://callback. Même modèle que houla-print.
export class AuthService {
    constructor(
        private readonly api: ApiService,
        private readonly store: StoreService,
    ) {}

    async login(): Promise<void> {
        const codeVerifier = randomBytes(32).toString('base64url');
        // Persisté : si le protocole relance une NOUVELLE instance, elle peut finir l'échange.
        this.store.setPkceVerifier(codeVerifier);
        const challenge = createHash('sha256').update(codeVerifier).digest().toString('base64url');
        const params = new URLSearchParams({
            response_type: 'code',
            client_id: CONFIG.clientId,
            redirect_uri: CONFIG.redirectUri,
            code_challenge: challenge,
            code_challenge_method: 'S256',
            scope: CONFIG.scopes.join(' '),
        });
        // L'autorisation DOIT viser le MÊME environnement que l'échange de code
        // (this.api.base()) — sinon on autorise sur un env et on échange sur un autre.
        await shell.openExternal(`${this.api.base()}/oauth/authorize?${params.toString()}`);
    }

    async handleCallback(url: string): Promise<void> {
        const code = new URL(url).searchParams.get('code');
        const verifier = this.store.getPkceVerifier();
        if (!code || !verifier) throw new Error('callback OAuth invalide (verifier manquant)');
        await this.api.exchangeCode(code, verifier);
        this.store.clearPkceVerifier();
    }

    isAuthenticated(): boolean {
        return !!this.store.getAccessToken();
    }

    logout(): void {
        this.store.clearAuth();
    }
}
