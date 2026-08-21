import { createSocket } from 'dgram';
import { Executor, BundleEffect, OscEffect, FireContext } from '../types';
import { resolveVars } from '../substitute';

// Exécuteur OSC (VRChat, TouchDesigner, Resolume…). Host/port viennent du CONNECTEUR
// si lié, sinon de l'effet (défaut 127.0.0.1:9000 = VRChat). UDP, pas de garde SSRF
// (cible locale/LAN). L'adresse doit commencer par '/'.
export class OscExecutor implements Executor {
    readonly type = 'osc' as const;
    readonly capability = 'allowOsc';
    readonly requiresCapability = false;

    validate(effect: BundleEffect): void {
        const e = effect as OscEffect;
        if (!e.address || !e.address.startsWith('/')) throw new Error('osc.address doit commencer par /');
    }

    async fire(effect: BundleEffect, ctx: FireContext): Promise<void> {
        const e = effect as OscEffect;
        const c = ctx.connector?.type === 'osc' ? ctx.connector.config : null;
        const host = c?.host || e.host || '127.0.0.1';
        const port = Number(c?.port) || e.port || 9000;
        const oscMin: any = await import('osc-min');
        const address = resolveVars(e.address, ctx);
        const args = (e.args || []).map((a) => (typeof a === 'string' ? resolveVars(a, ctx) : a));
        const buf: Buffer = oscMin.toBuffer({ address, args });
        await new Promise<void>((res, rej) => {
            const sock = createSocket('udp4');
            sock.send(buf, port, host, (err) => {
                try {
                    sock.close();
                } catch {
                    /* noop */
                }
                err ? rej(err) : res();
            });
        });
    }
}
