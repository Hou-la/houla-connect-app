# Signature de code des apps desktop Hou.la (Windows / macOS / Linux)

Doc de RÉFÉRENCE (remplace l'ancienne `CODE_SIGNING_AZURE.md`, Windows seul). Vaut pour **Hou.la
Connect** et est **réutilisable telle quelle pour Hou.la Print** (et la 3ᵉ app) : mêmes certificats
d'organisation, seule la config par dépôt change.

## Principe
Le CI (`.github/workflows/release.yml`) signe **automatiquement**, mais **seulement si les secrets
sont présents**. Tant qu'ils sont absents, le build reste **non signé mais téléchargeable**
(SmartScreen / Gatekeeper alertent). **Aucune modif de code à faire** une fois les secrets posés.

| Plateforme | Mécanisme | Sans signature, l'utilisateur voit… |
|---|---|---|
| **Windows** | Azure Trusted Signing (~10 $/mois, org) | SmartScreen « éditeur inconnu » |
| **macOS** | Developer ID Application + notarisation (compte Apple déjà possédé) | Gatekeeper « app endommagée / développeur non identifié » (quasi bloquant) |
| **Linux** | AppImage : **pas** de signature de code desktop | rien (l'AppImage se lance) |

Le câblage electron-builder est déjà en place : `build/entitlements.mac.plist` (hardened runtime),
`mac.hardenedRuntime/gatekeeperAssess/entitlements` dans `package.json`, et les 3 branches
(Windows / macOS / Linux) dans `release.yml`.

---

## 1. Windows — Azure Trusted Signing
Prérequis : **entreprise ≥ 3 ans** (identité « Public Trust ») — c'est notre cas (SIREN inchangé).

Portail https://portal.azure.com :
1. **Trusted Signing accounts** (⚠️ PAS « IoT Hub Device Provisioning ») → **Create** : souscription,
   groupe de ressources (`houla-signing`), nom (`houla-trusted-signing`), région. Note la région,
   l'**endpoint** en dépend : West Europe → `https://weu.codesigning.azure.net/`, North Europe →
   `https://neu.codesigning.azure.net/`, East US → `https://eus.codesigning.azure.net/`.
2. **Identity validations** → **New** → **Public** → infos légales (dénomination, SIREN, adresse).
   Validation Microsoft : **quelques jours ouvrés**. (Le type « Test » signe tout de suite mais N'EST
   PAS reconnu par SmartScreen — juste pour tester la mécanique.)
3. Identité validée → **Certificate profiles** → **Create** → **Public Trust** → note le **nom du
   profil** (ex. `houla-public`).
4. **Microsoft Entra ID → App registrations → New** (`houla-ci`) : note **client ID** + **tenant ID** ;
   **Certificates & secrets → New client secret** (note la valeur, elle ne se réaffiche plus). Puis sur
   le compte Trusted Signing → **Access control (IAM) → Add role assignment** → rôle **« Trusted
   Signing Certificate Profile Signer »** → membre = cette app registration.
5. Secrets GitHub (repo → Settings → Secrets and variables → Actions) :
   `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_SIGN_ENDPOINT`,
   `AZURE_SIGN_ACCOUNT` (nom du compte), `AZURE_SIGN_PROFILE` (nom du profil).

Vérif : clic droit sur l'exe téléchargé → **Propriétés → Signatures numériques** = l'entreprise.

---

## 2. macOS — Developer ID + notarisation
**Compte Apple Developer déjà possédé** (via l'app mobile) → rien à racheter. Mais il faut un
certificat **Developer ID Application** (distribution HORS Mac App Store), différent du cert iOS.

1. **Créer le certificat Developer ID Application** (Account Holder/Admin requis) :
   developer.apple.com → Certificates → **+** → **Developer ID Application** (via un CSR de Trousseau
   d'accès, ou plus simple : Xcode → Settings → Accounts → Manage Certificates → **+ Developer ID
   Application**). Limite ~2 par compte.
2. **Exporter en .p12** : Trousseau d'accès → le certificat + sa clé privée → Exporter → `.p12` avec un
   mot de passe. Puis `base64 -i cert.p12 | pbcopy` (macOS) pour la valeur du secret.
3. **Notarisation** — le plus simple : **mot de passe app-specific** : appleid.apple.com → Connexion et
   sécurité → **Mots de passe pour app** → générer. Récupère aussi le **Team ID** (developer.apple.com →
   Membership) et ton **Apple ID** (email).
4. Secrets GitHub :
   `APPLE_CSC_LINK` (le .p12 en **base64**), `APPLE_CSC_KEY_PASSWORD` (mot de passe du .p12),
   `APPLE_ID` (email Apple), `APPLE_APP_SPECIFIC_PASSWORD` (étape 3), `APPLE_TEAM_ID`.

Dès que `APPLE_CSC_LINK` est présent, le job mac **signe (Developer ID) + notarise** (`-c.mac.notarize=true`).
Vérif : `spctl -a -vvv Houla-Connect.app` doit dire « accepted / Notarized Developer ID ».

> Note auto-update mac (optionnel, hors périmètre signature) : pour que l'auto-updater fonctionne sur
> mac, ajouter la cible `"zip"` à `build.mac.target` (à côté de `"dmg"`). Le `.dmg` seul ne sert PAS
> aux mises à jour.

---

## 3. Linux
`AppImage` **ne se signe pas** comme Windows/macOS (pas de Gatekeeper/SmartScreen). Rien à faire :
l'AppImage publié est directement exécutable. (Option cosmétique : signer la release GPG pour un
checksum vérifiable — non requis pour lancer l'app.)

---

## 4. Réutilisation pour Hou.la Print (et la 3ᵉ app)
Les **certificats sont au niveau ORGANISATION**, donc **partagés** entre toutes les apps :
- **Windows** : le MÊME compte + profil Trusted Signing + service principal. Il suffit de recoller les
  6 secrets `AZURE_*` dans le dépôt de l'autre app (ou de partager via un secret d'org GitHub).
- **macOS** : le MÊME certificat Developer ID + le MÊME Team → recoller les 5 secrets `APPLE_*`.
- Par app, ne changent que : `build.appId` (ex. `com.houla.print`), `productName`, l'`icon`, et le
  `protocols.schemes`. Copier tel quel : `build/entitlements.mac.plist`, le bloc `build.mac`
  (hardenedRuntime/gatekeeperAssess/entitlements), et les 3 branches du `run:` de `release.yml`.

---

## 5. Icônes : différencier les 3 apps (⚠️ contrainte daltonien)
2 apps Windows aujourd'hui, bientôt 3, avec une icône quasi identique → confusion réelle (barre des
tâches, tray, alt-tab, installeurs). **Ne PAS différencier par la seule COULEUR** : le propriétaire est
daltonien, et à 16 px dans le tray une différence de teinte se perd de toute façon.

Différencier par la **FORME / le GLYPHE**, chaque app gardant la base de marque Hou.la commune (pour
lire comme une famille) mais avec un **symbole distinct et reconnaissable même en niveaux de gris** :
- **Print** → glyphe imprimante / étiquette.
- **Connect** → glyphe prise / manette / éclair (il relie les events live à des actions).
- **3ᵉ app** → son propre glyphe métier.

La couleur peut venir en **renfort secondaire** (un accent différent par app), jamais comme seul signal.
C'est un travail de DA (côté design/Meccha) ; ce doc ne fait que fixer la règle.
