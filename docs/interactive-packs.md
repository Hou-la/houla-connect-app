# Hou.la Connect — Packs interactifs (référence)

> État au **2026-08-28** (manette v2 + Instructions + test hors live : voir §13). Doc de référence de la fonctionnalité « Pack Bundle interactif » :
> un viewer envoie un cadeau pendant un live → l'app Hou.la Connect déclenche une action
> réelle dans le jeu du streamer (RCON, clavier, manette, OBS, HTTP…).
> Repos : `houla-connect-app` (app Electron) + `MikhaelGerbet/hou.la-api` (back, module `bundle-store` + `coin`).
> ⚠️ Repartir des fichiers réels avant toute modif (règle d'or CLAUDE.md). Ce doc date ; le code fait foi.

## 1. Invariant de sécurité
Le process **MAIN** de l'app est le seul qui transforme une donnée en I/O. Le renderer n'envoie que
du déclaratif. Les manifestes exécutables sont **signés Ed25519** côté API et vérifiés avant exécution
(en dev, non signés → l'app tourne quand même, la signature est sautée si absente).

## 2. Les DEUX plans (à ne jamais confondre)
| Plan | Table | Rôle | Lu par |
|---|---|---|---|
| **Exécutable** | `store_bundle` + `store_bundle_version` (`manifest_json`) | quelle interaction (slug de cadeau) → quelle **commande** | l'app (main), signé |
| **Visuel** | `gift_bundle` (`slots[] = {slug,name,imageUrl}`) | ce que le **viewer voit** (nom + art + prix) | Flutter/Angular |

Les deux sont reliés par **le même slug de cadeau** (`ix_slot_01..30`) et par **le même slug de pack**.
À l'approbation d'une version, `bundle-visual-sync.service.ts` génère le `gift_bundle` depuis le manifeste.

## 3. Cadeaux interactifs & prix (économie)
- Les cadeaux interactifs sont **30 slots réservés** `ix_slot_01..30` (table `gifts`, `is_interactive_slot=1`),
  cachés du catalogue public normal (`/api/gifts` les exclut).
- **Le prix est fixé par le NUMÉRO de slot** (échelle plateforme FIXE) : `5,10,15,20,30,45,60,80,100,125,
  155,190,230,280,340,410,490,580,680,790,900,1010,1120,1230,1340,1440,1530,1600,1660,1700` coins.
  1 coin ≈ **1,2–1,4 centime** (packs IAP `coin.service.ts` `COIN_PACKS` : 70=0,99 € … 8500=99,99 €).
- **Décision (2026-08-24)** : on **garde l'échelle fixe** (garde-fou anti-abus/arnaque, économie cohérente,
  compta simple). Le **créateur choisit le palier** (dans quel slot il range chaque cadeau) → c'est SON
  levier de prix. Ranger le « fun » en bas de l'échelle = plus d'interaction. Pas de prix libres en euros.
- **Repricing par le streamer** (adaptation à l'audience) : prévu via le calque local (choisir un autre
  palier dans l'échelle), **différé** car il faut refléter le nouveau layout côté viewer (bundle visuel
  par-streamer) — voir Roadmap.

## 4. Les flux
### Créateur (Lab de l'app)
Crée un pack : titre, bannière (**1600×900**, `cover`, webp), interactions (QUAND→ALORS→SI), icônes de
cadeau (**512×512** PNG transparent). Une interaction « Cadeau personnalisé » = un slot interactif + une
icône. Soumettre une version → garde statique + IA `MODERATE_BUNDLE_CODE` + revue admin → approuvée → signée.

### Viewer
Voit le pack « ⚡ Interactif » du live via `getInteractiveBundle(liveRoomId)` / `GET /api/live/interactive`.
Le pack affiché = le `gift_bundle` **attaché à la clé event** du connecteur (voir §5). Envoie un cadeau
(`POST /api/gifts/send`) → l'event `gift.sent` déclenche l'action côté app.

### Streamer (personnalisation LOCALE)
Store → **Personnaliser** un pack installé → calque local (`packOverlays` electron-store) : activer/
désactiver chaque interaction + cooldown. **N'édite JAMAIS le manifeste signé**, survit aux MAJ créateur,
**aucun prompt de version**. Appliqué au `engine:start` (`applyPackOverlay`).

## 5. « Pack actif → pack visuel du viewer » (la boucle, point 3)
Quand l'app démarre un pack, le viewer doit voir CE pack :
1. `GET /api/manager/bundles/:slug/manifest` renvoie `visualBundleId` (le `gift_bundle` du même slug).
2. `engine:start` appelle `setActivePackBundle(visualBundleId)` → `PUT /api/manager/event-key/:id/bundle`
   → pose `bundleId` sur la clé event (⚠️ `keyPrefix` est MASQUÉ « hle_xxxx... » : matcher en strippant les `...`).
3. `setKeyBundle` invalide le cache de validation → à la connexion socket, la passerelle lit le `bundleId`
   frais et **active le bundle sur le live** (`gift-event-listener` `@OnEvent('interactive.connector.changed')`).
4. `engine:stop`/`panic` posent `bundleId=null` → le viewer ne voit plus le pack.

Un pack sans `gift_bundle` (ex. Meccha clavier) → aucun pack visuel affiché (correct).

## 6. Nom/art dans l'animation (item 1, FAIT)
`gift.sent` (`gift.service.sendGift`) : pour un slot interactif avec un pack actif, on remplace le nom+art
génériques (« Interactive 09 ») par ceux du **slot du bundle actif** (copie superficielle, lecture cache).
Aucun changement client : le listener lit déjà `gift.name/thumbnailUrl`.

## 7. Affichages (FAIT)
`attachPublishers` renvoie `version` + `versionDate` + `changelog` + `publisher{name,avatarUrl,slug,isVerified}`.
- **Store** : version/date sur la carte ; détail = version + changelog + date + créateur.
- **Mes bundles** : cartes riches (bannière, version, installs, créateur, badge visibilité).
- **Lab** : historique des versions (numéro + statut modération + date + changelog).
- **Créateur cliquable** partout → `shell:openExternal` borné à `https://…hou.la` → profil `hou.la/@slug`.

## 8. Éditeur d'interactions (UX, FAIT 2026-08-24)
Ligne = QUAND / ALORS / SI. **Poignée de glisser (⠿) tout à DROITE** → déplacer/réordonner. Le sélecteur
de slot montre « Slot N · X coins » (**pas d'euros**). Boutons Tester/Supprimer taille normale (grille pied
5 colonnes). Éditer un pack **préserve `on.iconUrl`** (les icônes ne sont pas perdues).

## 9. Bordures colorées des cadeaux (app FAIT 2026-08-24, rendu client à faire)
**Ne PAS cuire la bordure dans l'icône** (le badge ⚡ se superpose, icônes à refaire). **Couleur en
métadonnée**, **halo/dégradé rendu par le client**. Défaut **automatique par rareté** (palier de prix :
commun→légendaire) + **override optionnel** par cadeau.
- **Schéma** : `on.accentColor` (#RGB/#RRGGBB) sur le trigger `gift` du manifeste (validateur : hex strict,
  refus `INVALID_TRIGGER` sinon) → recopié par `bundle-visual-sync` dans `gift_bundle.slots[].accentColor`.
- **Lab** : sur un « Cadeau personnalisé », case **« bordure »** + sélecteur de couleur. Décochée = **auto
  par rareté** (`slotRarityHex`, paliers gris→vert→bleu→violet→or, variés en clarté ET teinte car PO
  daltonien, doublés par le prix affiché). Cochée = couleur choisie. Aperçu du halo en direct sur la vignette.
- **RESTE (client)** : Flutter/Angular dessinent le halo depuis `slot.accentColor` (sinon dérivent de la
  rareté). Tant que non fait, la couleur est stockée mais **invisible côté viewer**.

## 10. Setup de test DEV (état 2026-08-24)
- API dev sur `localhost:53001`, DB `houla_dev` (`config/env/development.env`), workspace app = **Mika G.**
  (`6a89a9ce-…`, slug `frollonnoir`). Clé event « Hou.la Connect ».
- **`minecraft-survie`** : 30 slots RCON (Charbon…Dragon) + annonce chat `[{sender}] a offert <Nom>`,
  `iconUrl` backfillé sur 60 règles. Serveur Minecraft de test local : `C:\Users\Utilisateur\mc-test-server`
  (26.2, **RCON 127.0.0.1:25575 / mot de passe `hoularcontest`**, mode **facile** + Résistance).
- **`meccha-chameleon`** : 6 slots CLAVIER (space/w/a/s/d/c), icônes **fallback ⚡** (imageUrl vide) — pour
  valider l'intégration clavier sans art.
- Scripts de seed : hors dépôt (scratchpad de session). Reseeder si la base dev est réinitialisée.
- ⚠️ Un vrai combo « 3 cadeaux = 3 effets » : le moteur répète l'effet `quantité` fois (plafonné `MAX_REPS`
  + token-bucket). Dédup **par (transactionId + rule.id)** (sinon 2 règles sur un cadeau → la 2e est mangée).
  `repeat:'once'` sur un effet = joue une seule fois (annonce chat).

## 11. Roadmap (validée 2026-08-24, à faire dans l'ordre)
1. **Analytics par pack** — FAIT (2026-08-24) :
   - `bundle_usage_by_day` a `coins` + `stars` (migration `1848400000000-BundleUsageEarnings`).
   - `gift.sent` émet `bundle.earnings` ; `bundle-store` `@OnEvent` résout le pack exécutable depuis le
     pack visuel et agrège via la **queue Bull** (jamais synchrone).
   - `GET /api/manager/bundles/:slug/stats` → `totalCoins/totalStars/totalEffects` + série journalière (60j).
   - **UI** : carte « Mes bundles » montre `earnedCoins/earnedStars` ; bouton « Voir les stats » → modale
     totaux + **graphe en barres** (hauteur = valeur, lisible daltonien). `listMine` porte les revenus (privé créateur).
   - **Test** : envoyer des cadeaux interactifs pendant un live → les coins/étoiles s'agrègent sur le pack.
2. **Commission créateur** — FAIT (2026-08-24) :
   - `store_bundle.creator_fee_percent` (0-15, migration `1848400000001-BundleCreatorFee`) + DTO create/update
     + champ au **Lab** + transparence au **store détail** (« reverse X % des étoiles au créateur »).
   - `setActiveBundle` met créateur + fee dans l'état interactif caché (1 lecture à l'attache).
   - `sendGift` **split DANS la transaction atomique** : broadcaster reçoit `étoiles - commission`, créateur
     reçoit la commission (si > 0 **et créateur ≠ broadcaster** — on ne se paie pas soi-même). Viewer paie pareil.
   - **Test (créateur ≠ broadcaster)** : en dev, Mika possède le pack ET diffuse → self, PAS de commission.
     Pour tester le split : un pack **possédé par un autre workspace**, utilisé par Mika en live, un viewer
     envoie un cadeau interactif → l'autre workspace reçoit X % des étoiles, Mika le reste.
3. **Bordures colorées** (§9) — app FAIT (schéma `accentColor` + validateur + visual-sync + picker Lab).
   RESTE : rendu du halo côté client (Flutter/Angular).
4. **Nombre de slots** : décision 2026-08-24 — on **garde 30 par pack actif** (le viewer ne parcourt pas
   50 cadeaux ; la richesse d'un jeu passe par des **packs thématisés** — ex. Minecraft Survie / Chaos /
   Build — que le streamer choisit, pas par plus de slots). Pas de gap réel à 50. Réévaluable si la
   demande créateur le montre (les slots réservés sont partagés, monter à ~40 = plus de lignes + paliers).
5. **Signature de code** Windows (Azure Trusted Signing) — voir `docs/CODE_SIGNING_AZURE.md`.

## 13. Manette v2 + Instructions + test hors live (2026-08-28, retours gamer/dev)

Quatre « vagues » livrées suite au retour d'un gamer/dev (pack Mario Kart 8) + besoin PO de **tester sans être en live**.

### Vague 1 — bugs + confort
- **BUG CORRIGÉ (gâchettes LT/RT)** : LT/RT sont des **AXES** XInput, pas des boutons. Le sidecar
  (`resources/sidecar/houla_sidecar.py`) les jouait via `press_button` → `ValueError` au runtime alors que
  le serveur les **validait** (crash invisible). Désormais `_TRIGGERS = {LT:left_trigger, RT:right_trigger}`
  et `_set_tokens` route un token vers l'axe si c'est une gâchette. Un chord peut donc contenir LT/RT.
- **Libellés humains** : `GP_LABEL` (renderer) affiche « LT · ZL (gâchette G) », « R3 (clic stick D) »…
  Le token stocké reste l'énum manette (A/LT/RS…).
- **`holdMs` / `repeat` / `repeatGapMs`** exposés (durée d'appui, répéter ×N tous les X ms).
- **Compteur de caractères** temps réel sous la description (2000) et les instructions (50000).

### Vague 2 — modèle manette v2 (éditeur dédié, modale `#gp-modal`)
Cinq modes (`gamepad.executor.ts` compile tout en une **timeline d'étapes** jouée par le sidecar) :
- **Bouton** simple · **Combo simultané** (`buttons[]`, chord) · **Séquence** (`sequence[]`) ·
  **Chronologie** (`steps[]` = `{buttons|button, holdMs, waitMs}`, couvre « combo → attendre 5 s → touche stop ») ·
  **Analogique** (`analog{lx,ly,rx,ry ∈ -1..1 ; lt,rt ∈ 0..1}`, sticks/gâchettes à une intensité, tenu `holdMs`).
- **Auto-capture** (retour « on appuie, ça se sélectionne ») : lecture SEULE de l'entrée physique du PC —
  **manette** via l'API Gamepad du renderer (`captureGamepadToken`, mapping standard), **clavier** via `keydown`
  (`captureKeyboardSpec`). Aucun pilotage, aucun sidecar : c'est juste de la saisie assistée.
- Validateur API (`bundle-manifest.validator.ts`, case `gamepad`) : bornes strictes sur buttons(1..8),
  steps(1..16, hold 0..10000, wait 0..30000), analog (clés whitelistées + bornes), repeat(1..20), fail-closed
  sur toute clé « smuggling ». Couvert par `bundle-manifest.validator.spec.ts` (describe « manette v2 »).

### Vague 3 — Instructions / prérequis (Markdown)
Champ **`store_bundle.instructions`** (`mediumtext`, migration `1849000000000-BundleInstructionsColumn`,
DTO create/update `@MaxLength(50000)`), distinct de la description courte. Stocké **BRUT** ; rendu **XSS-safe**
côté app (renderer : `mdToSafeHtml` — tout texte échappé AVANT enveloppe, whitelist h/ul/ol/li/p/code/pre/
strong/em/a http(s)|mailto ; blocs de code ``` **copiables** + coloration décorative sur texte brut ré-échappé).
- **Lab** : éditeur avec onglets **Éditer / Aperçu** + compteur (`#lab-instructions`).
- **Rendu** dans : détail du pack (store `#modal-instructions`), pack installé (« Personnaliser »
  `#cx-instructions`), et Lab/Mes bundles (aperçu). Servi par `getManifest`/`getPublic`/`customize:get`.

### Vague 4 — analogique + limites matérielles assumées
- **Intensité D-Pad vs joystick** = le mode **Analogique** (ci-dessus). FAIT.
- **Vibration / Force-Feedback / audio de la manette** : **NON faisable** avec l'architecture actuelle
  (manette virtuelle **ViGEm/vgamepad** = pad Xbox 360 virtuel, canal input SORTANT uniquement). Le rumble et
  la FFB sont des flux que le **jeu** envoie vers un **vrai** périphérique ; un pad virtuel ne les reçoit ni
  ne les relaie, et il n'a pas de sortie audio. Ce serait un tout autre chantier (périphérique HID custom +
  driver). **Ne pas promettre** ces trois-là dans l'UI.

### Durcissements (revue adversariale multi-agents, 2026-08-28)
9 défauts confirmés puis corrigés :
- **Sidecar** : validation de TOUS les tokens d'un chord AVANT toute mutation du pad + reset du pad
  sur erreur → plus de touche « fantôme » coincée si un token est inconnu (`houla_sidecar.py`).
- **Exécuteur manette** : `validate()` rejette désormais les tokens hors set connu (typos, 'L2'/'TRIANGLE')
  au lieu de planter au runtime (`gamepad.executor.ts`).
- **Éditeur (renderer)** : bascule « → Manette » sème un bouton A valide (plus d'effet vide refusé) ;
  l'éditeur avancé **préserve** `randomFrom`/`gapMs` (plus de perte silencieuse) ; le chemin analogique
  honore `repeat`.
- **Validateur API (préexistant, corrigé)** : `hasDangerousKey` descend dans les **tableaux** (proto-pollution
  nichée) ; `rconVerbBlocked` inspecte le 1er token de **chaque** segment (verbe smuggé après `\n`/`;`).
  Régression couverte par la spec.
- **CSS injection (préexistant, corrigé)** : `esc` échappe aussi l'apostrophe (fermait `url('${bannerUrl}')`).
- **Instructions non modérées** : le texte passe à l'IA de modération de code (détection
  phishing/hors-plateforme). ⚠️ **PÉRIMÉ depuis le lot §14 (2026-08-28)** : les instructions sont désormais
  **VERSIONNÉES + gatées par version** (voir §14), le brouillon n'est plus servi au public. La re-revue sur
  édition de contenu public reste active pour titre/description (servis en direct).

### Tester HORS live (PO : « important pour les tests »)
- **Lab** : le bouton ▶ Tester d'une interaction passe déjà par `engine:testRule` → `engine.testFire`
  (pipeline sécurisé, **sans connexion live**). L'éditeur manette a son propre ▶ Tester (même voie).
- **Capture** : le bouton « Tester la 1ʳᵉ interaction » est actif dès qu'un pack est actif — **hors live**
  il rejoue l'effet localement (`engine:testInstalled` → `fetchVerifiedManifest` → `testFire`), **en live** il
  simule un vrai cadeau de bout en bout (`engine:test` → `simulateGift`).
- **Personnaliser** (pack tiers installé) : chaque interaction a un ▶ Tester hors live (`engine:testInstalled`).
- Rappel : le test manette/clavier exige le **connecteur activé** + la **fenêtre cible au premier plan**
  (focus-guard) — sinon le verdict le dit (« connecteur désactivé » / « fenêtre cible pas au premier plan »).

## 14. Triggers « tous les N » + versionnage instructions + mode Aléatoire (2026-08-28)

### Triggers PAR TRANCHE (`every`)
Nouveau champ `on.every` (entier 1..1_000_000) : déclenche à CHAQUE tranche de N.
- **comment** : `contains` (mot-clé) OU `every` (tous les N messages) — exclusif, sélecteur de mode au Lab.
- **hearts** (Likes) : `milestone` (palier atteint 1×) OU `every` (tous les N likes cumulés).
- **share** : `every` optionnel (vide = à chaque partage, comportement historique).
- **viewer** (NOUVEAU type) : `every` REQUIS = tous les N spectateurs. **MAJ (§15)** : basé sur la
  **PRÉSENCE réelle** du live (plus les join). `fireSlices` ne tire qu'à la HAUSSE (baisse puis remontée
  ne re-tire pas, dedup par tranche) ; le 1er compte reçu SEED la base sans tir rétroactif.
- **Moteur** (`trigger-router.ts`) : compteurs de session `commentCount/shareCount/viewerCount` + `lastHearts`
  (cumul serveur), remis à 0 dans `setManifest`. `fireSlices(prev,next,every,fn)` tire une fois par tranche
  franchie (le cumul hearts peut sauter → plusieurs tranches). Dedup via clé `type:ruleId:slice:k`.
- 🚨 **Piège corrigé** : les clés de dedup sont DÉTERMINISTES ; `engine.resetDedup()` est appelé dans
  `setManifest` (start/stop) sinon les tranches/paliers déjà franchis restent bloqués au re-démarrage.
- **Garde-fou Lab** : `incompleteTrigger()` bloque l'enregistrement d'un trigger de comptage sans nombre
  (sinon règle morte, silencieuse). Bascule de mode NON destructive (les deux saisies coexistent, le mode tranche).
- **Test hors live** : le ▶ Tester d'une règle joue l'EFFET (pas le comptage). Il n'existe pas de simulateur
  d'events comment/share/hearts/viewer (seuls `simulateGift`/`simulateFollow` existent) → le comptage/seuil
  ne s'observe qu'en vrai live.

### Instructions VERSIONNÉES (gating par version)
- `store_bundle_version.instructions` (`mediumtext`, migration `1849100000000`) = SNAPSHOT figé à la
  soumission (`submitVersion`), modéré AVEC la version.
- Le **public** ne voit JAMAIS le brouillon : `getPublic` sert le snapshot de la version APPROUVÉE ;
  `getManifest` (pack installé) idem ; `listPublic` **retire** `instructions` (fuite corrigée). Le brouillon
  éditable reste sur `store_bundle.instructions` (Lab, propriétaire uniquement).
- Signature Ed25519 inchangée (instructions = frère de `manifest`, `contentHash` sur `manifestJson` seul).

### Éditeur manette : mode ALÉATOIRE
- Onglet **Aléatoire** = `randomFrom` (un bouton au hasard, min 2) + lead optionnel (`randLead`, DÉCOUPLÉ de
  gp.button pour éviter un appui fantôme). `randomFrom` n'est plus « préservé » sur single/chord/sequence
  (permet la conversion random -> Bouton et évite le tirage dégénéré à 1).

### Revue adversariale (2ᵉ lot) : 8 défauts confirmés puis corrigés
dedup inter-session, trigger vide silencieux, fuite brouillon `listPublic`, lead fantôme, asymétrie
share/viewer, conversion random impossible, perte de saisie au switch de mode, tirage dégénéré. Détail : commits.

### tasks.json + lancement dev
`.vscode/tasks.json` : « Hou.la Connect: Dev (build + lancer) » (npm start), Rebuild renderer, Build.
⚠️ Dans CE sandbox, `ELECTRON_RUN_AS_NODE=1` force Electron en Node (`app` undefined) → lancer avec
`env -u ELECTRON_RUN_AS_NODE npx electron .`. L'env VS Code de l'utilisateur n'a pas ce piège.

## 15. Compte de VIEWERS réel (métadonnée + poll de fallback) + WYSIWYG + Store filtre (2026-08-28)

### Trigger `viewer` sur la PRÉSENCE réelle (plus les join)
Source du compte : **LiveKit** `getViewerCount` → miroir `live_room.viewer_count` → bus `live.viewer_count`.
- **Serveur** : `LiveEventsGateway` met en cache `workspaceId → {count, at}` sur `@OnEvent('live.viewer_count')`
  (in-memory, best-effort, par worker) et **injecte `viewers` dans CHAQUE enveloppe** d'event
  (`emitEvent`, guard de fraîcheur 2 min, zéro lecture Redis/DB dans le hot path).
- **Endpoint de fallback** : `GET /api/live/interactive/:workspaceId/viewers` → `{ live, viewers }` (lecture DB
  `live_room.viewer_count`, indexée, hors hot path, public — le compte n'est pas secret). `LiveRoom` ajouté au
  `forFeature` du module.
- **App** : `connection.service` lit `env.viewers` (canal `event` brut du SDK, non modifié) → `router.updateViewers`.
  Poller : amorce à +3 s (SEED), puis toutes les 60 s **si aucun event depuis 60 s** → poll l'endpoint. Le SEED
  évite tout tir rétroactif (un live déjà à 250 ne déclenche pas les paliers passés).
- ⚠️ Best-effort côté metadata (in-memory/worker) : le **poll est le garant** (fraîcheur pendant les creux et
  entre workers).

### Mini-WYSIWYG Markdown (Lab)
Barre d'outils au-dessus de l'éditeur d'instructions (`applyMdTool`) : Titre (##), **Gras** (Ctrl+B),
*Italique* (Ctrl+I), `code`, bloc de code, liste, lien. Insère au niveau de la sélection du textarea (aucune
lib externe — la CSP bloquerait un CDN).

### Store : recherche + filtre Tous/Installés
Barre du Store : **recherche SERVEUR** (`api.store.list({q})`, sur tous les bundles publics, pas juste la page)
+ segmented **Tous / Installés**. La vue « Installés » part des packs installés (état local), enrichis par
leur aperçu (best-effort). Résout le point bloquant « retrouver son pack à personnaliser parmi des milliers ».

### Curseur de commission
Remplissage NATIF via `accent-color` (pouce + barre toujours alignés ; le dégradé custom se calait sur la
largeur totale et dérivait du pouce).

### Instructions Markdown seedées sur les 7 bundles frogame (DEV)
`minecraft-{equipement,ferme,survie,chaos}` (setup RCON), `meccha-chameleon` (ViGEm), `obs-scenes` (OBS
WebSocket), `websocket-overlay` (WS overlay). Écrit sur le BROUILLON + le snapshot de version approuvée
(visibles tout de suite en dev). Script : scratchpad de session — à rejouer avec creds PROD pour porter.

## 16. Résilience RCON + refonte listes Store/Mes bundles + config survie (2026-08-28)

### RCON : plus de « Connection closed » ni de fuite/double-exécution
`rcon.executor.ts` : (1) évince le client caché sur `'end'` ET `'error'` (un serveur qui redémarre coupe via
`error`) → le prochain fire reconnecte au lieu de réutiliser un socket mort ; (2) cache la **PROMESSE** de
connexion (pas le client résolu) → deux fire concurrents partagent le même handshake au lieu de fuiter un
socket ; (3) retry sur l'**établissement de connexion SEUL**, JAMAIS sur le `send` (Minecraft exécute à la
réception : rejouer un `send` = double give/tp/spawn). Serveur MC local vérifié up (RCON 25575, `hoularcontest`).

### Personnaliser : bouton Tester à droite + nom du cadeau
Ligne réordonnée : switch · info · cooldown · résultat · **bouton Tester (tout à droite, fixe)** ; le résultat
est borné (ellipse) pour ne jamais décaler le bouton. Le pack **minecraft-survie** (DEV) a été nettoyé
(retrait des 2 règles kawaii inutiles) et relabellisé (« Charbon · annonce/cadeau »…) pour que le NOM du
cadeau soit visible — hash recalculé, signature nulle en dev (clé de signature absente → app saute la vérif).

### Store + Mes bundles : header fixe + scroll infini + recherche + états vides
- **Header sticky** (`.list-head`) : recherche/filtre/refresh restent visibles, seule la liste scrolle.
- **Scroll infini** : Store = pages SERVEUR (`limit/offset`, `STORE_PAGE=40`) ; Mes bundles = rendu par
  CHUNKS client (`MINE_PAGE=24`) + recherche client. Les deux s'auto-remplissent si le 1er lot ne crée pas de
  barre. Listener sur `.content`, `maybeLoadMore()`.
- 🚨 **Jeton de génération `storeGen`** : toute continuation async d'un chargement périmé (filtre/recherche
  changés) se voit et n'écrit ni le DOM ni l'offset (corrige 2 races confirmées : mélange de résultats, scroll
  infini mort). Réinitialisé au switch de compte.
- **États vides riches** (`emptyStateHtml`) : icône + titre + sous-texte + CTA (Ouvrir le Lab / Voir tous les
  packs), au lieu du message pauvre précédent.

### Revue adversariale (2 lots) : 7 défauts confirmés puis corrigés
curseur non edge-to-edge (→ curseur custom), pas de refresh au switch de compte, RCON double-send, RCON fuite
concurrente, 2 races du scroll Store, auto-remplissage manquant de Mes bundles.

## 17. Configurations de commandes : clavier / manette dans le MÊME pack (2026-09-02)

**Le trou.** `BundleRule.effect` était un objet UNIQUE, et le calque local du joueur
(`packOverlays`) ne porte que `disabled` / `cooldownMs` : **aucun remapping n'existe côté
joueur**. Conséquence directe : un pack écrit à la manette était purement inerte chez un
joueur au clavier, et l'inverse. Le pack ne servait donc que la moitié des joueurs.

**Le modèle retenu : la CONFIGURATION porte les interactions** (et non l'interaction qui
porterait plusieurs effets) — parce que le jeu d'actions n'est pas forcément le même d'un
matériel à l'autre.

```jsonc
{
  "schema": 2, "slug": "meccha",
  "profiles": [ { "id": "clavier", "label": "Keyboard", "default": true },
                { "id": "manette", "label": "Gamepad" } ],
  "rules": [
    { "id": "r1", "on": {...}, "effect": { "type": "keyboard", "keys": "space" }, "profile": "clavier" },
    { "id": "r2", "on": {...}, "effect": { "type": "gamepad",  "button": "A" },   "profile": "manette" },
    { "id": "r3", "on": {...}, "effect": { "type": "obs", "request": "..." } }   // SANS profile = commune
  ]
}
```

- **Règle sans `profile` = commune à toutes les configurations** (OBS, RCON, HTTP… ne dépendent
  pas du périphérique du joueur).
- **Absence de `profiles` = comportement historique** : pack à configuration unique, tout
  s'applique. Les packs déjà signés ne bougent pas (test de non-régression dédié).

**Gardes serveur** (`bundle-manifest.validator.ts`, fail-closed) : ≤ 6 configurations, ids
`^[a-z0-9][a-z0-9_-]{0,23}$` uniques, une seule `default`, clés inconnues rejetées, `profile`
pendouillant rejeté, et **une configuration sans aucune interaction est REFUSÉE** (le joueur
la choisirait et rien ne se passerait).

**Ce que ça règle côté joueur.** Le jeu piloté n'est demandé QUE si la configuration retenue
utilise vraiment une manette (`store:install` renvoie `gamepadProfiles`) : un joueur au clavier
ne va plus chercher un `.exe` sans raison. `engine:start` applique le calque AVANT de décider,
donc il raisonne sur ce qui va réellement tourner.

**Limite assumée, à dire au créateur.** Le Lab ne propose que **Clavier** et **Manette** :
c'est tout ce que l'app sait émettre (Interception + ViGEm/XInput). Un volant ou des pédales,
c'est du DirectInput — il faudrait embarquer un pilote type vJoy. Le schéma est ouvert à N
configurations, l'implémentation ne l'est pas encore.

**Points vérifiés au passage** : le plan visuel dédoublonne déjà les slots
(`bundle-visual-sync.service.ts`, « un slot au plus une fois ») et la passerelle dédoublonne
`reactsTo` — un même cadeau présent dans deux configurations n'apparaît donc pas en double
côté viewer. Le commentaire périmé de `connection.service.ts` sur `reactsTo` a été corrigé.

**Tests** : 8 cas serveur (`bundle-manifest.validator.spec.ts`, dont le contre-témoin « pack
sans profiles inchangé »), 3 TU (`test/manifest-lib.test.js`), 6 e2e
(`e2e/renderer/control-profiles.spec.js`, dont **le joueur clavier à qui on ne demande jamais
le jeu**, doublé du contre-témoin « le pack est bien installé »).

## 12. État du dépôt (2026-08-24)
Commits **locaux non poussés** (dev d'abord, prod après validation) :
- `houla-connect-app` : env-scoping, bouton Capture, quantité/journal, dédup par règle, éditeur+prix,
  pack actif→bundle, perso locale, éditeur refait, affichages riches, upload bannière.
- `api` (master) : `visualBundleId` dans le manifeste, nom/art d'animation, version/changelog/créateur dans
  les listes.
Rappel : **push = déploiement**. Ne pousser que sur autorisation explicite, après validation en dev.
