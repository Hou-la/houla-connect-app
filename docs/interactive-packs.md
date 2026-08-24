# Hou.la Connect — Packs interactifs (référence)

> État au **2026-08-24**. Doc de référence de la fonctionnalité « Pack Bundle interactif » :
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

## 9. Bordures colorées des cadeaux (décision, à implémenter)
**Ne PAS cuire la bordure dans l'icône** (le badge ⚡ se superpose, icônes à refaire). **Couleur en
métadonnée** (`accentColor?` sur le slot visuel), **halo/dégradé rendu par le client**. Défaut **automatique
par rareté** (palier de prix : commun→légendaire) + **override optionnel** par cadeau (color-picker Lab).
Part app : schéma + picker Lab. Part client : rendu du halo (Flutter/Angular).

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
1. **Analytics par pack** : coins + étoiles générés par pack et par créateur. `gift.sent` porte le montant
   + le pack actif → attribuer + agréger via **queue Bull** (règle haute-fréquence), agrégat `bundle_earnings`.
   Sert : motivation créateur, classement store, base de la commission.
   - **UI (validé 2026-08-24)** : sur la carte « Mes bundles », afficher les **coins gagnés** ; + un bouton
     **« Voir les stats »** ouvrant un écran avec **graphes** (installations dans le temps, revenus en
     **étoiles**). Endpoint créateur `GET /api/manager/bundles/:slug/stats` (existe déjà, à enrichir).
2. **Commission créateur** : une part des **étoiles** du cadeau va au créateur, **prélevée sur ce que gagne
   le broadcaster** (viewer paie pareil). Taux **plafonné** (0 à ~10 %) fixé par le créateur, **transparent
   à l'installation**, broadcaster consent. En étoiles (cashables). Garde-fous : plafond + affichage + modération.
   Chantier : schéma taux par pack + registre de reversement, split dans `gift.sent`, intégration cashout.
3. **Bordures colorées** (§9) : schéma `accentColor` + picker Lab + rendu client.
4. **Signature de code** Windows (Azure Trusted Signing) — voir `docs/CODE_SIGNING_AZURE.md`.

## 12. État du dépôt (2026-08-24)
Commits **locaux non poussés** (dev d'abord, prod après validation) :
- `houla-connect-app` : env-scoping, bouton Capture, quantité/journal, dédup par règle, éditeur+prix,
  pack actif→bundle, perso locale, éditeur refait, affichages riches, upload bannière.
- `api` (master) : `visualBundleId` dans le manifeste, nom/art d'animation, version/changelog/créateur dans
  les listes.
Rappel : **push = déploiement**. Ne pousser que sur autorisation explicite, après validation en dev.
