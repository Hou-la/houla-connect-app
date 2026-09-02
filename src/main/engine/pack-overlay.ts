import { BundleManifest } from './types';

/** Reglages LOCAUX d'un pack, appliques au runtime. Ne touchent jamais le manifeste signe. */
export interface PackOverlayInput {
    disabled: string[];
    cooldownMs: Record<string, number>;
    profile?: string;
    keyBindings?: Record<string, { keys?: string; button?: string }>;
}

/**
 * Configuration de commandes ACTIVE d'un pack : celle que le joueur a choisie, sinon
 * celle marquée par défaut, sinon la première. Renvoie `null` si le pack n'en déclare
 * aucune (packs à configuration unique : tout s'applique, comportement historique).
 */
export function resolveActiveProfile(manifest: BundleManifest, chosen?: string | null): string | null {
    const profiles = manifest?.profiles || [];
    if (!profiles.length) return null;
    if (chosen && profiles.some((p) => p.id === chosen)) return chosen;
    return (profiles.find((p) => p.default) || profiles[0]).id;
}

/** Applique le calque de perso locale à un manifeste (copie, ne mute rien) :
 *  ne garde que la configuration de commandes choisie par le joueur, retire les
 *  interactions désactivées, override les cooldowns. Le manifeste SIGNÉ reste intact ;
 *  c'est un réglage runtime propre au streamer, qui survit aux MAJ. */
export function applyPackOverlay(
    manifest: BundleManifest,
    overlay: PackOverlayInput,
): BundleManifest {
    const disabled = new Set(overlay.disabled);
    const active = resolveActiveProfile(manifest, overlay.profile);
    const binds = overlay.keyBindings || {};
    const rules = (manifest.rules || [])
        // une règle SANS `profile` vaut pour toutes les configurations (OBS, RCON, HTTP…)
        .filter((r) => !r.profile || r.profile === active)
        .filter((r) => !disabled.has(r.id))
        .map((r) => {
            let effect = r.effect as unknown as Record<string, unknown>;
            // ── REMAPPAGE joueur ──
            // ⚠️ FRONTIÈRE : on ne remplace QUE la touche/le bouton, et UNIQUEMENT si le type
            // d'effet correspond. Le type reste celui du manifeste SIGNÉ : un joueur ne peut
            // pas transformer une action clavier en appel réseau. Toute autre clé du calque
            // est ignorée, y compris si le fichier de config a été édité à la main.
            const b = binds[r.id];
            if (b) {
                if (effect.type === 'keyboard' && typeof b.keys === 'string' && b.keys.trim()) {
                    effect = { ...effect, keys: b.keys.trim() };
                } else if (effect.type === 'gamepad' && typeof b.button === 'string' && b.button.trim()) {
                    // Un bouton simple remplace l'action : on retire les formes avancées
                    // (chord/séquence/analogique) qui deviendraient contradictoires.
                    const { buttons, sequence, randomFrom, steps, analog, ...rest } = effect as any;
                    effect = { ...rest, button: b.button.trim() };
                }
            }
            const cd = overlay.cooldownMs[r.id];
            if (cd != null) effect = { ...effect, cooldownMs: cd };
            // `effect` est reconstruit par étalement depuis un effet VALIDE du manifeste signé,
            // et son `type` n'est jamais touché : la forme reste celle d'un BundleEffect.
            return effect === (r.effect as unknown) ? r : { ...r, effect: effect as unknown as typeof r.effect };
        });
    return { ...manifest, rules };
}
