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

> ### ⚠️ DÈS QUE **N'IMPORTE QUEL** FICHIER DE `resources/sidecar/` CHANGE.
>
> Cette section disait « seulement si `houla_sidecar.py` change ». **C'était faux
> depuis le découpage multiplateforme** : le vrai code des pilotes vit dans
> `resources/sidecar/backends/*.py`, et `houla_sidecar.py` n'est plus qu'un
> aiguillage. Corrigé le 2026-09-09.
>
> Ce que ça a failli coûter : le passage du sidecar à **8 manettes** touchait
> `backends/win32.py`, pas `houla_sidecar.py`. En suivant cette phrase, on
> publiait une app dont l'interface appelle `vigem-pads` sur un exécutable qui
> ne connaît pas ce helper. Le symptôme aurait été un « Appliquer et publier »
> qui échoue chez l'utilisateur, pour une fonctionnalité annoncée comme livrée.
>
> **La CI ne reconstruit RIEN** : `release.yml` télécharge l'exe pré-construit
> depuis la release `sidecar-bin-v1`. Un `.py` modifié et non re-figé ne part
> donc jamais, et rien ne le signale.

Reprends les étapes, puis :
```powershell
gh release upload sidecar-bin-v1 dist/houla-sidecar.exe --clobber
```

### Vérifier que le nouvel exe est bien le bon
Ne cherche PAS une chaîne dans le binaire : PyInstaller compresse son archive,
et un `grep` sur `vigem-gamepad` répond « absent » alors que le helper existe.
Le seul contrôle qui vaut est de **l'interroger** :

```powershell
'{"id":1,"method":"vigem-pads","params":{}}' | .\dist\houla-sidecar.exe
# attendu : {"id": 1, "result": {"pads": [], "max": 8, ...}}
# si tu lis  {"id": 1, "error": "helper non vérifié: vigem-pads"}  -> c'est l'ANCIEN exe.
```
