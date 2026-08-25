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
Prérequis :
- **Entreprise ≥ 3 ans** (identité « Public Trust ») — c'est notre cas (SIREN inchangé).
- **Abonnement Azure PAYANT (Pay-As-You-Go)** : le service **REFUSE** les abonnements
  **gratuit / essai / sponsorisé** (« Artifact Signing is not available for free, trial or sponsored
  subscriptions »). Convertir d'abord : ☰ → **Abonnements** → l'abonnement → **Mettre à niveau** →
  Pay-As-You-Go (le crédit d'essai reste utilisable ; ça n'ajoute pas de débit immédiat).
- **Région** : certaines régions n'acceptent pas de nouveaux clients (West Europe refusé le 2026-08-25,
  « region not accepting new customers ») → prendre **North Europe** ou **East US**. La région n'a pas
  d'impact fonctionnel mais détermine l'endpoint (§ secret `AZURE_SIGN_ENDPOINT`).

Portail https://portal.azure.com. Le service se nomme **« Artifact Signing » / FR « Comptes de signature
d'artefacts »** (ex-« Trusted Signing »). Procédure exacte (doc MS 2026-08) :
0. **Prérequis pièges** (voir la liste « Prérequis » ci-dessus) : abonnement **PAYANT** (pas free/trial), **région**
   qui accepte de nouveaux clients, fournisseur **`Microsoft.CodeSigning`** enregistré (Abonnement →
   Fournisseurs de ressources → Inscrire).
1. **Créer une ressource → Marketplace** (PAS la barre de recherche du haut) → « Comptes de signature
   d'artefacts » → **Créer** : abonnement, RG (`houla-signing`), nom (`houla-trusted-signing`), région,
   SKU **Basic**. La région donne l'**endpoint** : West Europe `https://weu.codesigning.azure.net`,
   North Europe `https://neu.codesigning.azure.net`, East US `https://eus.codesigning.azure.net`
   (table complète dans la doc MS).
2. **Se donner le rôle** (sinon « Nouvelle identité » grisé) : compte → **Contrôle d'accès (IAM)** →
   Ajouter une attribution de rôle → **« Artifact Signing Identity Verifier »** → soi-même.
3. **Validation d'identité** : compte → menu **Objets** → **Validations d'identité** → **Organisation** →
   **Nouvelle identité** → **Public** → nom légal, site web, **email principal + secondaire sur le
   domaine de la société** (pas gmail), **SIREN**, adresse, prénom/nom (comme la pièce d'identité) →
   **Créer**. Statut → *In Progress* → éventuel *Action requise* (Verified ID perso) → **Completed**.
   **Délai 1 à 20 jours ouvrés.** (Le type « Test » signe tout de suite mais N'EST PAS reconnu par
   SmartScreen.)
4. Identité *Completed* → Objets → **Profils de certificat** → **Créer** → **Public Trust** → nom +
   l'identité validée (« Verified CN and O ») → note le **nom du profil**.
5. **Entra ID → App registrations → New** (`houla-ci`) : **client ID** + **tenant ID** ; **Certificates
   & secrets → New client secret** (note la valeur). Puis compte → **IAM → Add role assignment** → rôle
   **« Artifact Signing Certificate Profile Signer »** → membre = cette app.
6. Secrets GitHub (repo → Settings → Secrets and variables → Actions) :
   `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_SIGN_ENDPOINT` (endpoint région),
   `AZURE_SIGN_ACCOUNT` (nom du compte), `AZURE_SIGN_PROFILE` (nom du profil).

Vérif : clic droit sur l'exe téléchargé → **Propriétés → Signatures numériques** = l'entreprise.

---

## 2. macOS — Developer ID + notarisation
**Compte Apple Developer déjà possédé** (via l'app mobile) → rien à racheter. Il faut un certificat
**Developer ID Application** (distribution HORS Mac App Store), différent du cert iOS. Team `QD77PQAUU5`.

⚠️ **La création du cert Developer ID est réservée à l'Account Holder** : l'App Store Connect API la
REFUSE (`403 FORBIDDEN "This operation can only be performed by the Account Holder"`). Donc une étape
humaine au portail est incontournable. Méthode qui évite le trousseau (`security`) et marche sans GUI :

1. **Générer clé privée + CSR** (openssl, pas de trousseau) :
   `openssl genrsa -out key.pem 2048 && openssl req -new -key key.pem -out csr.pem -subj "/CN=Hou.la/O=Hou.la"`.
2. **Faire émettre le cert** (Account Holder, navigateur) : developer.apple.com → Certificates → **+** →
   **Developer ID Application** → sous-CA **G2** → upload `csr.pem` → **Download** `developerID_application.cer`.
3. **Assembler le `.p12` chaîne complète** (openssl, pas de trousseau) :
   `openssl x509 -inform DER -in developerID_application.cer -out leaf.pem` ;
   `curl -fsSL https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer -o i.der && openssl x509 -inform DER -in i.der -out interm.pem` ;
   `cat leaf.pem interm.pem > chain.pem` ;
   `openssl pkcs12 -export -legacy -inkey key.pem -in chain.pem -out devid.p12 -passout pass:<PW>`
   (⚠️ `-legacy` = compat `security import` macOS ; inclure l'intermédiaire = chaîne autonome).
4. **Notarisation par CLÉ API App Store Connect** (pas de mot de passe app-specific) : réutiliser la clé
   `AuthKey_<KEYID>.p8` + son **Key ID** + **Issuer ID**.
5. Secrets GitHub (6) :
   `APPLE_CSC_LINK` (devid.p12 en **base64**), `APPLE_CSC_KEY_PASSWORD` (le PW du .p12),
   `APPLE_API_KEY_B64` (le .p8 en base64), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, `APPLE_TEAM_ID`.

Le job mac décode le .p8, exporte `APPLE_API_KEY`/`_ID`/`_ISSUER`, et **signe + notarise**
(`-c.mac.notarize=true`). Vérif : `spctl -a -vvv Houla-Connect.app` doit dire « accepted / Notarized
Developer ID », et `codesign -dv --verbose=4` la Developer ID.

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
