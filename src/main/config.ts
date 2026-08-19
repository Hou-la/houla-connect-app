// Endpoints. En dev, override par variables d'env HOULA_API_URL / HOULA_APP_URL.
const dev = process.env.HOULA_CONNECT_DEV === '1';

export const CONFIG = {
    apiUrl: process.env.HOULA_API_URL || (dev ? 'http://localhost:53001' : 'https://hou.la'),
    appUrl: process.env.HOULA_APP_URL || (dev ? 'https://localhost:59223' : 'https://app.hou.la'),
    clientId: 'houla-connect-desktop',
    protocol: 'houla-connect',
    redirectUri: 'houla-connect://callback',
    scopes: ['workspaces', 'live-events', 'bundles'],
};
