#!/usr/bin/env python3
"""Backend de repli pour une plateforme non portée (BSD, Solaris, autre).

Il existe pour une seule raison : un sidecar qui refuse de DÉMARRER ne dit rien à
personne. Le process meurt, l'app affiche « moteur de pilotage indisponible », et rien
n'indique que la vraie cause est « ce système n'est pas géré ». Ici le sidecar démarre
normalement, répond au JSON-RPC, et `capabilities` annonce franchement qu'il ne sait
rien faire, avec la raison. Chaque helper échoue ensuite avec le même message.
"""
import sys

PLATFORM = sys.platform

ERR = (
    "PLATFORM_UNSUPPORTED: le pilotage bas niveau n'est pas porté sur '" + sys.platform + "'. "
    "Hou.la Connect pilote clavier et manette sur Windows (Interception + ViGEmBus) et sur "
    "Linux (uinput), et le clavier seul sur macOS (Quartz)."
)


def capabilities(args):
    return {
        "platform": PLATFORM,
        "keyboard": False,
        "gamepad": False,
        "reason": ERR,
        "keyboardBackend": None,
        "gamepadBackend": None,
        "probed": bool(args.get("probe")),
    }


def keys(args):
    raise RuntimeError(ERR)


def gamepad(args):
    raise RuntimeError(ERR)


def passthrough(args):
    raise RuntimeError(ERR)


def release_pad(args):
    # Nettoyage : il n'y a rien à libérer, et faire échouer un nettoyage n'apprend rien.
    return {"released": True}


def shutdown(args):
    return {"shutdown": True}


def foreground(args):
    return {"exe": None}   # inconnu : côté app, un focus inconnu doit rester permissif
