#!/usr/bin/env python3
"""Hou.la Connect - sidecar de pilotage bas niveau (Windows, Linux, macOS).

Expose des helpers vérifiés, appelés par le process MAIN de l'app via un JSON-RPC
minimal sur stdio (une requête JSON par ligne sur stdin, une réponse par ligne sur
stdout). AUCUN eval, AUCUN chemin de script : les bundles restent de la donnée
inerte, seul ce binaire (fourni par l'app, figé PyInstaller) fait l'I/O driver.

  capabilities      : ce que CETTE machine sait vraiment faire. À appeler AVANT de
                      proposer une interaction, pour ne pas promettre puis échouer.
  interception-keys : envoie des touches au niveau DRIVER (jeux qui ignorent
                      l'input synthétique de haut niveau). key-spec :
                        'space' | 'shift+c' | 'c,c,c' | 'space:400'
  vigem-gamepad     : manette virtuelle Xbox : press/hold/release.
  vigem-passthrough : mode « une seule manette ». Recopie EN CONTINU la manette
                      PHYSIQUE du joueur dans la manette virtuelle, et y superpose
                      les combos des cadeaux. Ainsi l'émulateur/jeu n'a qu'à lire la
                      manette virtuelle : le joueur conduit NORMALEMENT et les cadeaux
                      ajoutent leurs effets. Résout le piège « le jeu lit la physique,
                      pas la virtuelle ».
  release-pad       : débranche la manette virtuelle (un test ne doit rien laisser).
  foreground        : exe de la fenêtre active, pour le focus-guard de l'app.
  shutdown          : arrêt gracieux (débranche la manette avant la fermeture).

CE FICHIER NE CONTIENT PLUS AUCUN CODE DE PILOTE. Il ne fait que le protocole et
l'aiguillage vers backends/<plateforme>.py :
  Windows : Interception (clavier) + ViGEmBus (manette)   -> backends/win32.py
  Linux   : uinput pour les DEUX                          -> backends/linux.py
  macOS   : Quartz (clavier). Manette NON SUPPORTÉE       -> backends/darwin.py

Les NOMS DES HELPERS ne changent pas d'une plateforme à l'autre, « interception-keys »
et « vigem-* » compris, alors qu'ils nomment des pilotes Windows. C'est volontaire :
l'app Electron n'a aucune raison de savoir sur quel système elle tourne, et renommer
casserait les bundles déjà publiés, qui sont de la donnée inerte jamais migrée.

Dépendances : voir requirements.txt (elles portent des marqueurs de plateforme, chaque
système n'installe que les siennes).
"""
import os
import sys
import json

# Le paquet `backends` est le dossier voisin. Python met déjà le dossier du script en
# tête de sys.path quand on lance `python resources/sidecar/houla_sidecar.py`, et
# PyInstaller embarque le paquet dans l'exe figé. On le remet quand même explicitement :
# ça ne coûte rien et ça couvre les lancements indirects (exec depuis un autre dossier,
# import par un self-test), où un ImportError ici tuerait le sidecar au démarrage sans
# la moindre trace côté app.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import backends  # noqa: E402

# Backend de CETTE machine, choisi une fois au démarrage. L'import du module de la
# plateforme a lieu ici et nulle part ailleurs : sur Linux, `import vgamepad` n'est pas
# rattrapé, il n'a tout simplement pas lieu (voir backends/__init__.py).
_B = backends.get()


def helper_capabilities(args):
    """Inventaire de ce que la machine sait faire, pour que l'app n'affiche que les
    interactions qui marcheront vraiment. Réponse :
        {"platform": "linux", "keyboard": true, "gamepad": true, "reason": "…"}
    plus quelques clés indicatives (keyboardBackend, gamepadBackend, probed).

    `params.probe = true` demande un test RÉEL (création puis retrait du périphérique
    virtuel) au lieu d'un simple constat de présence. Le défaut reste le constat, parce
    qu'un test a des effets de bord et que ce helper est fait pour être appelé au
    démarrage de l'app. `reason` est toujours rempli, y compris en cas de succès."""
    return _B.capabilities(args)


def helper_interception_keys(args):
    return _B.keys(args)


def helper_vigem_gamepad(args):
    return _B.gamepad(args)


def helper_vigem_passthrough(args):
    return _B.passthrough(args)


def helper_release_pad(args):
    return _B.release_pad(args)


def helper_foreground(args):
    return _B.foreground(args)


def helper_shutdown(args):
    return _B.shutdown(args)


HELPERS = {
    "capabilities": helper_capabilities,
    "interception-keys": helper_interception_keys,
    "vigem-gamepad": helper_vigem_gamepad,
    "vigem-passthrough": helper_vigem_passthrough,
    "release-pad": helper_release_pad,
    "foreground": helper_foreground,
    "shutdown": helper_shutdown,
}


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        # `req` est remis à None à chaque tour : si json.loads échoue, on doit répondre
        # avec un id nul, pas avec l'id de la requête PRÉCÉDENTE (l'app associerait la
        # réponse au mauvais appel et le vrai appel expirerait sans explication).
        req = None
        try:
            req = json.loads(line)
            rid = req.get("id")
            method = req.get("method")
            params = req.get("params", {}) or {}
            fn = HELPERS.get(method)
            if not fn:
                raise ValueError(f"helper non vérifié: {method}")
            result = fn(params)
            sys.stdout.write(json.dumps({"id": rid, "result": result}) + "\n")
        except Exception as e:  # noqa: BLE001
            rid = req.get("id") if isinstance(req, dict) else None
            sys.stdout.write(json.dumps({"id": rid, "error": str(e)}) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
