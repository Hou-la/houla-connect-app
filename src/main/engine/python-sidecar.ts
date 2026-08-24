import { spawn, ChildProcess } from 'child_process';
import { createInterface, Interface } from 'readline';

// Client du SIDECAR PYTHON : un exécutable figé (PyInstaller) fourni PAR l'app,
// lancé shell:false, qui parle un JSON-RPC minimal sur stdio. Il expose UNIQUEMENT
// des helpers vérifiés (interception-keys, vigem-gamepad) — jamais du code d'auteur.
// C'est ce qui permet le pilotage bas niveau (Meccha) tout en gardant les bundles
// comme donnée inerte.

export type SidecarHelper = 'interception-keys' | 'vigem-gamepad';

interface Pending {
    resolve: (v: any) => void;
    reject: (e: Error) => void;
}

export class PythonSidecar {
    private proc: ChildProcess | null = null;
    private rl: Interface | null = null;
    private nextId = 1;
    private readonly pending = new Map<number, Pending>();

    constructor(private readonly sidecarPath: string) {}

    get running(): boolean {
        return !!this.proc && !this.proc.killed;
    }

    private ensure(): ChildProcess {
        if (this.running) return this.proc!;
        // .py (dev) -> lancé via python ; sinon l'exe figé directement.
        const isPy = this.sidecarPath.toLowerCase().endsWith('.py');
        this.proc = isPy
            ? spawn(process.platform === 'win32' ? 'python' : 'python3', [this.sidecarPath], { shell: false, stdio: ['pipe', 'pipe', 'pipe'] })
            : spawn(this.sidecarPath, [], { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
        this.proc.on('exit', () => {
            this.proc = null;
            this.rl = null;
            for (const p of this.pending.values()) p.reject(new Error('sidecar arrêté'));
            this.pending.clear();
        });
        this.rl = createInterface({ input: this.proc.stdout! });
        this.rl.on('line', (line) => this.onLine(line));
        return this.proc;
    }

    private onLine(line: string): void {
        let msg: any;
        try {
            msg = JSON.parse(line);
        } catch {
            return; // logs libres du sidecar : ignorés
        }
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(String(msg.error)));
        else p.resolve(msg.result);
    }

    /** Appelle un helper vérifié du sidecar (méthode = nom du helper). */
    call(helper: SidecarHelper, args: Record<string, unknown>): Promise<any> {
        const proc = this.ensure();
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            const timeout = setTimeout(() => {
                if (this.pending.delete(id)) reject(new Error(`sidecar timeout (${helper})`));
            }, 4000);
            const done = (fn: (v: any) => void) => (v: any) => {
                clearTimeout(timeout);
                fn(v);
            };
            this.pending.set(id, { resolve: done(resolve), reject: done(reject) });
            proc.stdin!.write(JSON.stringify({ id, method: helper, params: args }) + '\n');
        });
    }

    kill(): void {
        try {
            this.proc?.kill();
        } catch {
            /* noop */
        }
        this.proc = null;
    }
}
