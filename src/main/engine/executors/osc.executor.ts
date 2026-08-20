import { createSocket } from 'dgram';
import { Executor, BundleEffect, OscEffect, FireContext } from '../types';
import { resolveVars } from '../substitute';

// Exécuteur OSC (VRChat avatar params, TouchDesigner, Resolume, éclairage…).
// UDP local par défaut (127.0.0.1:9000 = VRChat). L'adresse doit commencer par '/'.
// Pas de garde SSRF : OSC vise la machine locale / le LAN du streamer, jamais le web.
export class OscExecutor implements Executor {
    readonly type = 'osc' as const;
    readonly capability = 'allowOsc';

    validate(effect: BundleEffect): void {
        const e = effect as OscEffect;
        if (!e.address || !e.address.startsWith('/')) throw new Error('osc.address doit commencer par /');
    }

    async fire(effect: BundleEffect, ctx: FireContext): Promise<void> {
        const e = effect as OscEffect;
        const oscMin: any = await import('osc-min');
        const address = resolveVars(e.address, ctx);
        // osc-min infère le type OSC depuis la valeur JS (string/int/float/bool).
        const args = (e.args || []).map((a) => (typeof a === 'string' ? resolveVars(a, ctx) : a));
        const buf: Buffer = oscMin.toBuffer({ address, args });
        await new Promise<void>((res, rej) => {
            const sock = createSocket('udp4');
            sock.send(buf, e.port || 9000, e.host || '127.0.0.1', (err) => {
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
