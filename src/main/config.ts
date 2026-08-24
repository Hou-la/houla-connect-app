// Endpoints. En dev, override par variables d'env HOULA_API_URL / HOULA_APP_URL.
const dev = process.env.HOULA_CONNECT_DEV === '1';

// URLs d'API par environnement (sélecteur admin dans les Réglages).
// Dev en 127.0.0.1 (PAS localhost) : l'API dev écoute en IPv4 (app.listen(PORT,
// '0.0.0.0')). Sur Windows, « localhost » résout ::1 (IPv6) en premier ; l'undici
// d'Electron s'y connecte, se prend un ECONNREFUSED et ne bascule pas toujours en
// IPv4 -> l'app croit l'API injoignable alors qu'elle tourne. 127.0.0.1 force l'IPv4.
export const ENV_API_URLS: Record<string, string> = {
    prod: 'https://hou.la',
    staging: 'https://staging-api.hou.la',
    dev: 'http://127.0.0.1:53001',
};

export const CONFIG = {
    apiUrl: process.env.HOULA_API_URL || (dev ? 'http://127.0.0.1:53001' : 'https://hou.la'),
    appUrl: process.env.HOULA_APP_URL || (dev ? 'https://localhost:59223' : 'https://app.hou.la'),
    clientId: 'houla-connect-desktop',
    protocol: 'houla-connect',
    redirectUri: 'houla-connect://callback',
    scopes: ['workspaces', 'live-events', 'bundles'],
};
