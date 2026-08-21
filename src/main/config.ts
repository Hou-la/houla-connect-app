// Endpoints. En dev, override par variables d'env HOULA_API_URL / HOULA_APP_URL.
const dev = process.env.HOULA_CONNECT_DEV === '1';

// URLs d'API par environnement (sélecteur admin dans les Réglages).
export const ENV_API_URLS: Record<string, string> = {
    prod: 'https://hou.la',
    staging: 'https://staging-api.hou.la',
    dev: 'http://localhost:53001',
};

export const CONFIG = {
    apiUrl: process.env.HOULA_API_URL || (dev ? 'http://localhost:53001' : 'https://hou.la'),
    appUrl: process.env.HOULA_APP_URL || (dev ? 'https://localhost:59223' : 'https://app.hou.la'),
    clientId: 'houla-connect-desktop',
    protocol: 'houla-connect',
    redirectUri: 'houla-connect://callback',
    scopes: ['workspaces', 'live-events', 'bundles'],
};
