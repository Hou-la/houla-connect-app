/**
 * Joueurs ciblables : la SEULE définition du plafond, et le seul filtre.
 *
 * Module feuille exprès (aucun import) : le stockage, le routeur d'événements et
 * les exécuteurs en ont tous besoin, et faire dépendre `store.service` du moteur
 * créerait un cycle au démarrage.
 */

/** Nombre maximal de joueurs ciblables. Miroir de `MAX_JOUEURS` du sidecar. */
export const MAX_JOUEURS = 8;

/**
 * Numéro de joueur exploitable, ou `undefined`.
 *
 * Le serveur a déjà validé la cible (elle existe, sa manette répond), mais ce
 * nombre finit en INDEX DE MANETTE : une valeur hors plage vaut mieux ignorée
 * (l'effet part au joueur par défaut, comportement d'avant) que devinée.
 */
export function joueurVise(v: unknown): number | undefined {
    const n = Number(v);
    return Number.isInteger(n) && n >= 1 && n <= MAX_JOUEURS ? n : undefined;
}
