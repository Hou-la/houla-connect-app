import { isIP } from 'net';
import { FireContext } from './types';

// Substitution de placeholders : {sender} {quantity} {coins} {name} + vars locales
// (secrets par NOM). sanitize() par exécuteur, PAS ici (RCON != corps HTTP != OBS).

export function resolveVars(template: string, ctx: FireContext): string {
    const map: Record<string, string | number> = {
        sender: ctx.senderName,
        quantity: ctx.quantity,
        coins: ctx.coins,
        name: ctx.giftName,
        ...ctx.vars,
    };
    return template.replace(/\{(\w+)\}/g, (m, key) =>
        key in map ? String(map[key]) : m,
    );
}

/** Substitue récursivement dans un objet libre (params/json) - profondeur bornée. */
export function resolveDeep(value: unknown, ctx: FireContext, depth = 0): unknown {
    if (depth > 6) return value;
    if (typeof value === 'string') return resolveVars(value, ctx);
    if (Array.isArray(value)) return value.map((v) => resolveDeep(v, ctx, depth + 1));
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            out[k] = resolveDeep(v, ctx, depth + 1);
        }
        return out;
    }
    return value;
}

// ── Garde SSRF côté app (défense en profondeur, même check que l'API) ──
function v4Blocked(ip: string): boolean {
    const p = ip.split('.').map(Number);
    if (p.length !== 4 || p.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return true;
    const [a, b] = p;
    return (
        a === 0 || a === 127 || a === 10 ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 100 && b >= 64 && b <= 127)
    );
}

/**
 * Vérifie qu'un host est autorisé : dans l'allowlist utilisateur ET pas une IP
 * privée/loopback/metadata (sauf host LAN ajouté explicitement par l'utilisateur).
 */
export function hostAllowed(hostname: string, userAllowlist: string[]): boolean {
    const h = (hostname || '').trim().toLowerCase().replace(/\.$/, '');
    if (!h) return false;
    const inAllowlist = userAllowlist.map((x) => x.toLowerCase()).includes(h);
    // Host LAN explicitement approuvé par l'utilisateur : autorisé même si privé.
    if (inAllowlist) return true;
    // Sinon : refuser les IP privées/loopback/metadata.
    if (isIP(h) === 4 && v4Blocked(h)) return false;
    if (['localhost', 'metadata', 'metadata.google.internal'].includes(h)) return false;
    return true;
}
