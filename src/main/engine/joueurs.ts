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

/** Les deux types de manette virtuelle. */
export const TYPE_X360 = 'x360';
export const TYPE_DS4 = 'ds4';

/**
 * Type de manette à créer pour N joueurs, à partir de la PRÉFÉRENCE du joueur.
 *
 * ⚠️ LE NOMBRE QUI DÉCIDE EST L'EFFECTIF, PAS LA CAPACITÉ. La contrainte est
 * physique : Windows n'a que QUATRE emplacements XInput, partagés avec les
 * manettes physiques, donc au-delà de deux manettes virtuelles les Xbox 360
 * sont acceptées par ViGEm tout en restant INVISIBLES du jeu. Une DualShock 4
 * n'occupe aucun emplacement, d'où la bascule.
 *
 * Mais forcer le type sur la CAPACITÉ était un bug : une machine déclarée à
 * quatre manettes, utilisée un soir à DEUX sur un jeu PC qui ne lit que XInput,
 * créait le joueur 2 en DualShock 4. Le jeu ne le voyait pas, et pourtant il
 * était publié comme cible : le spectateur payait dans le vide.
 *
 * La capacité dit ce que la machine PEUT fournir ; c'est l'effectif du soir qui
 * décide du type.
 */
export function typeManettes(nbJoueurs: number, preference?: string): string {
    const pref = preference === TYPE_DS4 || preference === TYPE_X360 ? preference : TYPE_X360;
    return nbJoueurs > 2 ? TYPE_DS4 : pref;
}
