# Construire le sidecar manette (`houla-sidecar.exe`) — une fois, en local

## Pourquoi pas en CI
Le sidecar embarque **vgamepad** (manette virtuelle ViGEm). Or vgamepad **se connecte au bus
ViGEmBus dès l'`import`** (`VBUS = VBus()` dans son `__init__`). Sans le **pilote NOYAU ViGEmBus
chargé**, `import vgamepad` lève `VIGEM_ERROR_BUS_NOT_FOUND` → PyInstaller ne peut pas le bundler.

Charger un pilote noyau demande un **redémarrage**, impossible sur un runner GitHub Actions
(5 approches de freeze CI essayées, toutes bloquées par ça). On construit donc l'exe **UNE FOIS
sur une vraie machine Windows** et on le publie ; la CI le télécharge (voir `release.yml`, step
« Récupérer le sidecar manette pré-construit »).

## Prérequis (machine Windows)
- Windows 10/11 x64, **Python 3.10+** (`python --version`).
- **`gh`** (GitHub CLI) authentifié sur le dépôt (`gh auth status`).
- Le dépôt `houla-connect-app` cloné, ouvert dans un terminal à sa racine.

## Étapes
```powershell
# 1) Outils. `pip install vgamepad` LANCE l'installeur du pilote ViGEmBus : clique dans la
#    fenêtre qui s'ouvre pour l'installer. Si Windows demande un REDÉMARRAGE, redémarre, puis
#    rouvre ce dossier et REPRENDS à l'étape 2.
pip install pyinstaller vgamepad

# 2) Vérifie que vgamepad s'importe (le pilote doit être chargé) — DOIT afficher OK :
python -c "import vgamepad; print('OK')"

# 3) Construis l'exe figé du sidecar (onefile, autonome) :
pyinstaller --onefile --name houla-sidecar --collect-all vgamepad resources/sidecar/houla_sidecar.py
#    -> produit dist\houla-sidecar.exe

# 4) Récupère l'installeur du pilote (pour le bouton « Installer le pilote » in-app) :
python -c "import vgamepad,os,shutil; d=os.path.dirname(vgamepad.__file__); shutil.copy(os.path.join(d,'win','vigem','install','x64','ViGEmBusSetup_x64.msi'),'ViGEmBusSetup_x64.msi'); print('MSI copie')"

# 5) Publie les deux fichiers dans la release DÉDIÉE que la CI télécharge :
gh release create sidecar-bin-v1 dist/houla-sidecar.exe ViGEmBusSetup_x64.msi ^
  --title "Sidecar manette (binaires)" ^
  --notes "houla-sidecar.exe + ViGEmBusSetup_x64.msi, construits en local. Consommés par release.yml."
#    (Si la release existe déjà : `gh release upload sidecar-bin-v1 dist/houla-sidecar.exe ViGEmBusSetup_x64.msi --clobber`)
```

## Ensuite
La **prochaine release** (n'importe quel push sur `main`) télécharge automatiquement ces binaires
et les empaquette. Le bouton **« Installer le pilote »** (vue Connecteurs) devient fonctionnel, et
les interactions « Manette » pilotent le jeu (après que l'utilisateur a installé le pilote).

## Refaire le build
Seulement si `resources/sidecar/houla_sidecar.py` change, ou pour monter de version vgamepad :
reprends les étapes, puis `gh release upload sidecar-bin-v1 ... --clobber`.
