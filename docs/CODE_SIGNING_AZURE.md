# Signature de code Windows — Azure Trusted Signing

Objectif : signer `Houla-Connect-x.y.z.exe` pour que **Windows SmartScreen ne montre plus
l'avertissement « éditeur inconnu »**. Solution retenue : **Azure Trusted Signing** (~10 $/mois,
la moins chère ; pas de certificat physique/HSM à acheter).

Le CI (`.github/workflows/release.yml`) signe **automatiquement** le build Windows **dès que les
6 secrets GitHub ci-dessous sont renseignés**. Tant qu'ils sont absents, le build reste non signé
(téléchargeable, mais SmartScreen alerte). **Aucune modification de code n'est nécessaire de ton
côté** : juste la configuration Azure + les secrets.

## Prérequis
- Une **entreprise de 3 ans ou plus** (identité « Public Trust ») — c'est notre cas (SIREN inchangé).
- Un compte **Azure** avec une souscription (carte bancaire ; la souscription elle-même est gratuite,
  seule la signature est facturée ~10 $/mois).

## Étapes (portail Azure — https://portal.azure.com)

### 1. Créer le compte Trusted Signing
1. Cherche **« Trusted Signing accounts »** → **Create**.
2. Choisis la souscription, un **groupe de ressources** (crée-en un, ex. `houla-signing`), un **nom**
   de compte (ex. `houla-trusted-signing`) et une **région**.
3. Note la région : l'**endpoint** en dépend. Ex. :
   - West Europe → `https://weu.codesigning.azure.net/`
   - North Europe → `https://neu.codesigning.azure.net/`
   - East US → `https://eus.codesigning.azure.net/`

### 2. Valider l'identité de l'organisation
1. Dans le compte Trusted Signing → **Identity validations** → **New identity validation** → type
   **Public** (Public Trust).
2. Renseigne les infos légales de l'entreprise (dénomination, SIREN/immatriculation, adresse).
3. **Validation par Microsoft : quelques jours ouvrés.** (Il existe un type « Test » qui signe
   immédiatement mais n'est PAS reconnu par SmartScreen — utile juste pour vérifier la mécanique.)

### 3. Créer le profil de certificat
1. Une fois l'identité **validée** → **Certificate profiles** → **Create**.
2. Type **Public Trust**, associe l'identité validée. **Note le nom du profil** (ex. `houla-public`).

### 4. Créer le service principal (pour le CI)
1. **Microsoft Entra ID** → **App registrations** → **New registration** (ex. `houla-connect-ci`).
2. Note le **Application (client) ID** et le **Directory (tenant) ID**.
3. **Certificates & secrets** → **New client secret** → **note la valeur** (elle ne se réaffiche plus).
4. Donne les droits de signature au service principal : sur le **compte Trusted Signing** →
   **Access control (IAM)** → **Add role assignment** → rôle **« Trusted Signing Certificate Profile
   Signer »** → membre = l'app registration créée.

### 5. Renseigner les 6 secrets GitHub
Dépôt **`Hou-la/houla-connect-app`** → **Settings → Secrets and variables → Actions → New repository
secret**, crée :

| Secret | Valeur |
|---|---|
| `AZURE_TENANT_ID` | Directory (tenant) ID (étape 4.2) |
| `AZURE_CLIENT_ID` | Application (client) ID (étape 4.2) |
| `AZURE_CLIENT_SECRET` | la valeur du client secret (étape 4.3) |
| `AZURE_SIGN_ENDPOINT` | l'endpoint de région (étape 1.3) |
| `AZURE_SIGN_ACCOUNT` | le nom du compte Trusted Signing (étape 1.2) |
| `AZURE_SIGN_PROFILE` | le nom du profil de certificat (étape 3.2) |

### 6. Déclencher une release
Pousse un commit sur `main` (ou relance le workflow **Auto Bump & Release**). Le job Windows détecte
`AZURE_CLIENT_ID` et **signe** l'exe. Vérifie : clic droit sur l'exe téléchargé → **Propriétés →
Signatures numériques** doit montrer l'entreprise, et l'installation ne déclenche plus
l'avertissement « éditeur inconnu ».

## macOS (plus tard)
Compte **Apple Developer** déjà possédé. La signature/notarisation mac se branchera séparément
(secrets `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, certificat `Developer ID
Application`). À faire dans un second temps.

## Notes
- La réputation SmartScreen se construit avec le **volume de téléchargements** : même signé, un tout
  nouvel éditeur peut voir un avertissement quelques temps, qui disparaît à mesure des installations.
- Trusted Signing facture à l'usage sous un abonnement ~10 $/mois ; pas de matériel, pas de
  renouvellement manuel de certificat (Microsoft gère la rotation).
