// osc-min ne fournit pas de types. On n'en utilise que toBuffer({address, args}).
declare module 'osc-min' {
    export function toBuffer(packet: {
        address: string;
        args?: Array<string | number | boolean | { type: string; value: unknown }>;
    }): Buffer;
    export function fromBuffer(buf: Buffer): unknown;
}
