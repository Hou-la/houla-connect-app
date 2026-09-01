import { spawn, ChildProcess } from 'child_process';
import { createInterface, Interface } from 'readline';

// Client du SIDECAR PYTHON : un exécutable figé (PyInstaller) fourni PAR l'app,
// lancé shell:false, qui parle un JSON-RPC minimal sur stdio. Il expose UNIQUEMENT
// des helpers vérifiés (interception-keys, vigem-gamepad) — jamais du code d'auteur.
// C'est ce qui permet le pilotage bas niveau (Meccha) tout en gardant les bundles
// comme donnée inerte.

export type SidecarHelper = 'interception-keys' | 'vigem-gamepad' | 'vigem-passthrough';

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
        // windowsHide: l'exe figé (PyInstaller) est une app CONSOLE (obligatoire : le mode
        // --windowed casse stdin/stdout, donc le JSON-RPC). Sans windowsHide, une fenêtre
        // console noire clignoterait à chaque effet en live. On la cache.
        this.proc = isPy
            ? spawn(process.platform === 'win32' ? 'python' : 'python3', [this.sidecarPath], { shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
            : spawn(this.sidecarPath, [], { shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        this.proc.on('exit', () => {
            this.proc = null;
            this.rl = null;
            for (const p of this.pending.values()) p.reject(new Error('sidecar arrêté'));
            this.pending.clear();
        });
        // Spawn IMPOSSIBLE (exe figé absent du build, ou `python` non installé en dev) :
        // sans ce handler, l'erreur passait inaperçue et l'appel « expirait » à 8 s. On
        // rejette tout de suite avec un message actionnable (pilote bas niveau manquant).
        this.proc.on('error', (err: NodeJS.ErrnoException) => {
            this.proc = null;
            this.rl = null;
            const msg = err && err.code === 'ENOENT'
                ? 'moteur de pilotage bas niveau introuvable (pilote/sidecar non installé)'
                : `moteur de pilotage indisponible : ${err?.message || 'erreur inconnue'}`;
            for (const p of this.pending.values()) p.reject(new Error(msg));
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

    /**
     * Appelle un helper vérifié du sidecar (méthode = nom du helper).
     * Le sidecar ne répond qu'à la FIN de l'effet (maintiens + attentes inclus) :
     * `timeoutMs` DOIT donc couvrir la durée réelle de l'effet (un maintien de 10 s
     * ou une chronologie « attendre 5 s » ne doit pas « expirer » à tort). L'appelant
     * calcule la durée ; on ajoute une marge plancher.
     */
    call(helper: SidecarHelper, args: Record<string, unknown>, timeoutMs = 8000): Promise<any> {
        const proc = this.ensure();
        const id = this.nextId++;
        const budget = Math.max(8000, Math.min(timeoutMs + 4000, 15 * 60 * 1000));
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            const timeout = setTimeout(() => {
                if (this.pending.delete(id)) reject(new Error(`sidecar timeout (${helper})`));
            }, budget);
            const done = (fn: (v: any) => void) => (v: any) => {
                clearTimeout(timeout);
                fn(v);
            };
            this.pending.set(id, { resolve: done(resolve), reject: done(reject) });
            // stdin peut être absent/fermé si le spawn a échoué : on rejette proprement
            // au lieu de laisser l'appel « expirer ».
            try {
                if (!proc.stdin || !proc.stdin.writable) throw new Error('sidecar non démarré');
                proc.stdin.write(JSON.stringify({ id, method: helper, params: args }) + '\n');
            } catch (e: any) {
                if (this.pending.delete(id)) { clearTimeout(timeout); reject(new Error(e?.message || 'écriture sidecar impossible')); }
            }
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
