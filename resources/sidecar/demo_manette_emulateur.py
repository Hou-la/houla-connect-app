#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Banc d'essai manette pour un EMULATEUR (Ryujinx, Dolphin, RetroArch...), SANS aucun jeu.

POURQUOI CE SCRIPT. Le seul maillon qu'on ne peut pas prouver en ligne de commande, c'est
l'AFFECTATION du peripherique au bon joueur dans l'emulateur : elle se fait dans SON
interface. Tout le reste est deja verifie par selftest_xinput_chain.py (l'appui injecte est
bien rapporte par XInput, donc par SDL, donc par l'emulateur).

Ce script cree la manette virtuelle et la GARDE branchee, en envoyant un appui visible a
intervalle regulier. Il ne reste plus qu'a regarder l'ecran d'entree de l'emulateur.

MARCHE A SUIVRE
  1. Lancer ce script. Laisser la fenetre ouverte.
  2. Ouvrir l'emulateur, aller dans ses reglages de manette
     (Ryujinx : Options > Input, puis l'onglet Player 1).
  3. Choisir « Xbox 360 Controller » pour le Joueur 1.
     ⚠️ Si la manette PHYSIQUE est aussi assignee au Joueur 1, la retirer : Hou.la la
     recopie deja, et les cadeaux s'ajoutent par-dessus. Deux sources sur un meme joueur
     se marchent dessus.
  4. Regarder l'affichage des touches : le bouton annonce doit s'allumer tout seul,
     toutes les 3 secondes.

CE QUI SIGNE UN ECHEC, et qu'il faut savoir distinguer :
  - rien ne s'allume ET la manette n'apparait pas dans la liste -> elle n'est pas vue ;
  - elle apparait mais rien ne s'allume -> elle est vue, mais assignee au mauvais joueur
    (c'est le cas le plus frequent : l'emulateur la met en Joueur 2, derriere la physique) ;
  - le bouton reste allume -> le relachement ne passe pas (a signaler, c'est un vrai bug).
"""
import json, os, subprocess, sys, time

# La console Windows tourne en cp1252 : le moindre caractere accentue ou pictogramme dans un
# print() fait PLANTER le script chez l'utilisateur (UnicodeEncodeError), et il ne voit qu'une
# trace Python. On force donc UTF-8 en sortie, avec repli sur '?' plutot qu'une exception :
# un message legerement abime vaut infiniment mieux qu'un outil qui meurt a la 3e ligne.
for flux in (sys.stdout, sys.stderr):
    try:
        flux.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001  (Python < 3.7, ou flux redirige)
        pass

SIDECAR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "houla-sidecar.exe")
CYCLE = ["A", "B", "X", "Y", "UP", "DOWN", "LEFT", "RIGHT"]


def rpc(p, method, params=None):
    p.stdin.write(json.dumps({"id": 1, "method": method, "params": params or {}}) + "\n")
    p.stdin.flush()
    return json.loads(p.stdout.readline())


def main():
    if not os.path.exists(SIDECAR):
        print(f"ABANDON : sidecar introuvable ({SIDECAR})")
        print("Construis-le d'abord, ou lance ce script depuis une installation complete.")
        return 2

    p = subprocess.Popen([SIDECAR], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                         stderr=subprocess.DEVNULL, text=True, encoding="utf-8", bufsize=1)
    cap = rpc(p, "capabilities").get("result", {})
    if not cap.get("gamepad"):
        print("ABANDON : cette machine ne sait pas creer de manette virtuelle.")
        print("  raison :", cap.get("reason", "inconnue"))
        p.kill(); return 3

    pt = rpc(p, "vigem-passthrough", {"enable": True}).get("result", {})
    vidx, pidx = pt.get("virtualIndex"), pt.get("physicalIndex")
    print("=" * 68)
    print(f"  Manette virtuelle BRANCHEE  ->  emplacement XInput {vidx}")
    print(f"  Manette physique detectee   ->  emplacement {pidx if pidx is not None else 'aucune'}")
    if pidx is not None and vidx is not None and vidx > pidx:
        print()
        print("  ⚠️  La virtuelle arrive APRES la physique : la plupart des emulateurs")
        print("      l'assigneront au Joueur 2. Il faut la mettre en Joueur 1 A LA MAIN,")
        print("      et retirer la physique de ce joueur (elle est deja recopiee).")
    print("=" * 68)
    print("\n  Ouvre maintenant les reglages de manette de ton emulateur.")
    print("  Ctrl+C pour arreter.\n")

    i = 0
    try:
        while True:
            tok = CYCLE[i % len(CYCLE)]
            print(f"  -> appui sur {tok:<6} (doit s'allumer dans l'emulateur)", flush=True)
            rpc(p, "vigem-gamepad", {"button": tok, "holdMs": 400})
            i += 1
            time.sleep(2.6)
    except KeyboardInterrupt:
        print("\n  Arret demande.")
    finally:
        try: rpc(p, "shutdown")
        except Exception: pass
        p.kill()
        print("  Manette virtuelle debranchee.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
