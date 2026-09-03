#!/usr/bin/env python3
"""Aiguillage par plateforme du sidecar Hou.la Connect.

POURQUOI DES MODULES SÉPARÉS, et pas des `if sys.platform` dans un seul fichier :
le sidecar repose sur des pilotes NOYAU incompatibles entre eux. `vgamepad` se connecte
au bus ViGEmBus DÈS L'IMPORT et n'existe que sous Windows ; `evdev` est une extension C
compilée contre les en-têtes du noyau Linux ; `Quartz` vient de pyobjc et n'existe que
sous macOS. Un seul fichier obligerait à écrire ces imports quelque part, et un import
raté « rattrapé » reste un import TENTÉ : trace d'erreur dans les logs, temps de
démarrage perdu, et surtout un `except` qui finit par masquer une VRAIE panne du bon
pilote. Ici, `import vgamepad` n'existe QUE dans backends/win32.py, module qui n'est
jamais chargé ailleurs que sous Windows. Sur Linux, l'import n'est pas rattrapé : il
n'a pas lieu.

Les trois modules exposent exactement la même interface, appelée par houla_sidecar.py :
    PLATFORM                      identifiant sys.platform du backend
    capabilities(args) -> dict    ce que CETTE machine sait faire
    keys(args) -> dict            helper JSON-RPC « interception-keys »
    gamepad(args) -> dict         helper JSON-RPC « vigem-gamepad »
    passthrough(args) -> dict     helper JSON-RPC « vigem-passthrough »
    release_pad(args) -> dict     helper JSON-RPC « release-pad »
    foreground(args) -> dict      helper JSON-RPC « foreground »
    shutdown(args) -> dict        helper JSON-RPC « shutdown »

Les NOMS DES HELPERS JSON-RPC ne changent pas d'une plateforme à l'autre, y compris
« interception-keys » et « vigem-* » qui nomment des pilotes Windows. C'est volontaire :
l'app Electron n'a aucune raison de savoir sur quel système elle tourne, et renommer
casserait les bundles déjà publiés (donnée inerte, jamais migrée).

⚠️ PyInstaller : les trois `from . import ...` ci-dessous sont des imports LITTÉRAUX,
donc vus par l'analyse statique de PyInstaller, qui embarque les trois modules dans
l'exe figé. Ne JAMAIS remplacer ça par un `importlib.import_module("backends." + nom)` :
l'analyse ne le verrait pas et l'exe se retrouverait sans backend. Sur la machine de
build Windows, PyInstaller signalera `evdev` et `Quartz` comme « hidden import not
found » : c'est un AVERTISSEMENT attendu, pas une erreur, ces modules n'étant jamais
atteints sous Windows (ils sont importés paresseusement, à l'intérieur des fonctions).
"""
import sys

if sys.platform == "win32":
    from . import win32 as _impl
elif sys.platform == "linux":
    from . import linux as _impl
elif sys.platform == "darwin":
    from . import darwin as _impl
else:
    from . import unsupported as _impl


def get():
    """Le backend de CETTE machine. Toujours un objet module valide : sur une
    plateforme inconnue (BSD, etc.) c'est `unsupported`, qui répond proprement au
    JSON-RPC au lieu de faire tomber le sidecar au démarrage."""
    return _impl


PLATFORM = getattr(_impl, "PLATFORM", sys.platform)
