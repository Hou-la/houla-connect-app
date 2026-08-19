# Hou.la Connect

App de bureau (Electron) qui transforme les événements d'un live Hou.la (cadeaux,
chat, follows, likes, partages) en **actions réelles** : touches clavier, manette
virtuelle, RCON (Minecraft…), OBS, HTTP/domotique. L'utilisateur se connecte à son
compte Hou.la, installe un « Pack Bundle » et joue.

## Architecture

- **Process MAIN** (`src/main`) : le seul à faire de l'I/O. Connexion temps réel
  (`@houla/live-connector`), moteur d'exécution (`src/main/engine`) avec 6 exécuteurs
  (keyboard / gamepad / rcon / obs / http / python), pipeline dedup + cooldown +
  focus-guard + rate-limit + audit, PANIC global.
- **Preload** (`src/preload`) : bridge `contextBridge` à surface FIXE. Le renderer
  n'envoie que du **déclaratif** (slug, capacité, nom de secret, toggle) ; il ne peut
  jamais exécuter d'action.
- **Renderer** (`src/renderer`) : UI dark, fenêtre **sans bordure** (titlebar custom).
  Vanilla aujourd'hui ; migration Angular prévue (l'archi est agnostique du framework).
- **Sidecar Python** (`resources/sidecar`) : pilotage bas niveau (Interception /
  ViGEm) pour les jeux qui ignorent l'input synthétique (ex. Meccha). Helpers
  **vérifiés** uniquement, JSON-RPC sur stdio. Figé en `.exe` (PyInstaller).

## Sécurité

Les bundles communautaires sont de la **donnée déclarative** (jamais de code d'auteur).
Le manifeste est validé + **signé Ed25519** côté API ; l'app **vérifie la signature**
avant de charger les effets. Capacités par exécuteur **toutes OFF par défaut**, garde
SSRF sur HTTP, secrets locaux (safeStorage), PANIC.

## Dev

```
npm install
npm run build          # main (tsc) + renderer (copie)
npm start              # lance Electron
```

En dev, pointer l'API/app locales : `HOULA_CONNECT_DEV=1`.

## Distribution

`npm run dist:win|mac|linux` (electron-builder) → GitHub Releases `Hou-la/houla-connect-app`.
Nécessite un certificat de signature de code (Windows) + notarisation (macOS).
