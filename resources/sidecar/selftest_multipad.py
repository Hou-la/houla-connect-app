#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Auto-test MULTI-JOUEURS du sidecar Windows.

Ce que ce test doit prouver, et qu'un test naïf ne prouverait PAS :

  1. On crée bien N manettes virtuelles DISTINCTES.
     Compter « N périphériques apparus » ne suffit pas : N manettes qui
     piloteraient toutes le même périphérique donneraient le même compte.
     -> on appuie sur le pad du joueur k et on exige que SEUL le périphérique
        apparié bouge. Un échec ressemblerait sinon exactement à une réussite.

  2. La croix directionnelle DS4 est une DIRECTION, pas quatre bits.
     Relâcher LEFT alors que UP est tenu doit laisser NORD, pas rien.

  3. Le refus au-delà de 2 joueurs en Xbox 360 est EXPLICITE.
     Windows n'a que 4 emplacements XInput, partagés avec les manettes
     physiques : créer des manettes invisibles serait une panne muette.

Usage :  py resources/sidecar/selftest_multipad.py [nb_joueurs]
"""
import ctypes
import os
import sys
import time
from ctypes import wintypes

sys.stdout = __import__("io").TextIOWrapper(
    sys.stdout.buffer, encoding="utf-8", errors="replace",
)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import backends  # noqa: E402

B = backends.get()
if getattr(B, "PLATFORM", "") != "win32":
    print("Ce test est spécifique à Windows.")
    sys.exit(0)


# ── Lecture des périphériques de jeu par l'API winmm (celle que voient
#    DirectInput et SDL, donc les émulateurs) ────────────────────────────────
class JOYINFOEX(ctypes.Structure):
    _fields_ = [
        ("dwSize", wintypes.DWORD), ("dwFlags", wintypes.DWORD),
        ("dwXpos", wintypes.DWORD), ("dwYpos", wintypes.DWORD),
        ("dwZpos", wintypes.DWORD), ("dwRpos", wintypes.DWORD),
        ("dwUpos", wintypes.DWORD), ("dwVpos", wintypes.DWORD),
        ("dwButtons", wintypes.DWORD), ("dwButtonNumber", wintypes.DWORD),
        ("dwPOV", wintypes.DWORD), ("dwReserved1", wintypes.DWORD),
        ("dwReserved2", wintypes.DWORD),
    ]


_winmm = ctypes.WinDLL("winmm.dll")
_MAX_IDS = _winmm.joyGetNumDevs()
JOY_RETURNALL = 0x000000FF


def lire(i):
    info = JOYINFOEX()
    info.dwSize = ctypes.sizeof(JOYINFOEX)
    info.dwFlags = JOY_RETURNALL
    if _winmm.joyGetPosEx(i, ctypes.byref(info)) == 0:
        return (info.dwButtons, info.dwPOV)
    return None


def presents():
    return [i for i in range(_MAX_IDS) if lire(i) is not None]


def echec(msg):
    print("  ECHEC :", msg)
    globals()["_ko"] += 1


_ko = 0
N = int(sys.argv[1]) if len(sys.argv) > 1 else 4
N = max(2, min(8, N))

print("=" * 70)
print("AUTO-TEST MULTI-JOUEURS  (%d joueurs demandés)" % N)
print("=" * 70)

avant = presents()
print("périphériques de jeu AVANT : %s" % avant)

# ── 1. Le refus explicite au-delà de 2 en Xbox 360 ────────────────────────
print("\n[1] au-delà de 2 joueurs en Xbox 360 : refus EXPLICITE attendu")
try:
    B.pads({"count": 3, "kind": "x360"})
    echec("3 manettes Xbox 360 acceptées : elles seraient invisibles au jeu")
except Exception as e:  # noqa: BLE001
    if "XINPUT_SLOTS_EXHAUSTED" in str(e):
        print("  OK : %s" % str(e)[:90])
    else:
        echec("refusé, mais pour une autre raison : %s" % e)

# ── 2. Création de N manettes DS4 ──────────────────────────────────────────
print("\n[2] création de %d manettes DualShock 4" % N)
try:
    r = B.pads({"count": N, "kind": "ds4"})
except Exception as e:  # noqa: BLE001
    print("  ECHEC : %s" % e)
    sys.exit(1)
apres = presents()
nouveaux = [i for i in apres if i not in avant]
print("  pads déclarés   : %d  %s" % (len(r["pads"]), [p["kind"] for p in r["pads"]]))
print("  périphériques   : %s  (%d nouveaux)" % (apres, len(nouveaux)))
print("  emplacements XInput annoncés : %s" % [p["xinputIndex"] for p in r["pads"]])
if len(r["pads"]) != N:
    echec("%d pads déclarés au lieu de %d" % (len(r["pads"]), N))
if len(nouveaux) != N:
    echec("%d périphériques apparus au lieu de %d" % (len(nouveaux), N))

# ── 3. LE test discriminant : un joueur = UN périphérique ─────────────────
print("\n[3] test discriminant : le joueur k ne bouge QUE son périphérique")
# On n'observe QUE les périphériques que nos manettes viennent de créer.
# Les manettes PHYSIQUES déjà branchées changent d'état toutes seules (une
# manette sans fil s'endort et se réveille, un stick dérive) : les inclure
# rendrait le test instable pour une raison qui n'a rien à voir avec ce qu'il
# mesure. Constaté à 8 joueurs : un périphérique physique a « bougé » pendant
# la lecture du joueur 3. Le risque réel, lui, est bien couvert : une collision
# ENTRE nos manettes se verrait toujours.
observes = nouveaux
repos = {i: lire(i) for i in observes}
appariement = {}
for num in range(1, N + 1):
    # ⚠️ PAS `B.gamepad(...)` ici : ce helper presse, TIENT, puis RELÂCHE avant
    # de rendre la main. On lirait donc toujours l'état au repos et le test
    # conclurait « rien ne bouge » quel que soit l'état du code. On presse et on
    # relâche nous-mêmes, par le même chemin que `_fire_tokens` emprunte.
    j = B._get_joueur(num)
    B._set_tokens(j, B._vg, ["A"], True)
    time.sleep(0.15)
    bouges = [i for i in observes if lire(i) is not None and lire(i) != repos[i]]
    B._set_tokens(j, B._vg, ["A"], False)
    time.sleep(0.15)
    revenus = [i for i in observes if lire(i) == repos[i]]
    etat = "OK" if len(bouges) == 1 else ("AUCUN" if not bouges else "COLLISION")
    if len(bouges) == 1:
        appariement[num] = bouges[0]
    print("  joueur %d -> périphérique(s) %-10s  retour au repos : %-5s  [%s]"
          % (num, bouges, bool(bouges) and bouges[0] in revenus, etat))

distincts = len(set(appariement.values()))
print("  appariement : %s" % appariement)
if distincts != N:
    echec("%d périphériques distincts pilotés sur %d joueurs" % (distincts, N))

# ── 4. La croix DS4 est un ÉTAT, pas des bits ─────────────────────────────
print("\n[4] croix directionnelle DS4 : UP+LEFT -> nord-ouest, puis LEFT relâché -> nord")
try:
    j = B._get_joueur(2)
    vg = B._vg
    B._appliquer_token(j, vg, "UP", True)
    B._appliquer_token(j, vg, "LEFT", True)
    diag = B._ds4_direction_nom(j.dpad)
    B._appliquer_token(j, vg, "LEFT", False)
    seul = B._ds4_direction_nom(j.dpad)
    B._appliquer_token(j, vg, "UP", False)
    fin = B._ds4_direction_nom(j.dpad)
    print("  UP+LEFT   -> %s" % diag)
    print("  LEFT relâché -> %s" % seul)
    print("  UP relâché   -> %s" % fin)
    if diag != "DS4_BUTTON_DPAD_NORTHWEST":
        echec("UP+LEFT devrait donner NORTHWEST")
    if seul != "DS4_BUTTON_DPAD_NORTH":
        echec("relâcher LEFT devrait laisser NORTH, pas tout effacer")
    if fin != "DS4_BUTTON_DPAD_NONE":
        echec("tout relâché devrait donner NONE")
    # Contre-témoin : deux directions opposées s'annulent au lieu de trembler.
    B._appliquer_token(j, vg, "UP", True)
    B._appliquer_token(j, vg, "DOWN", True)
    oppose = B._ds4_direction_nom(j.dpad)
    print("  UP+DOWN   -> %s  (doit être NONE)" % oppose)
    if oppose != "DS4_BUTTON_DPAD_NONE":
        echec("UP+DOWN devrait s'annuler")
    j.dpad.clear()
except Exception as e:  # noqa: BLE001
    echec("croix DS4 : %s" % e)

# On lache nos propres references AVANT de tester la liberation : les garder
# empecherait le retrait et ferait echouer l'etape 5 pour une raison qui
# n'existe que dans ce test.
del j

# ── 5. Nettoyage : aucune cible zombie ────────────────────────────────────
print("\n[5] libération : aucun périphérique ne doit rester")
B.release_pad({})   # attend deja la disparition, borne a 4 s
time.sleep(0.5)
reste = [i for i in presents() if i not in avant]
print("  périphériques restants : %s" % reste)
if reste:
    echec("%d périphérique(s) fantôme(s) : ils finiraient par coincer le bus ViGEm" % len(reste))

print("\n" + "=" * 70)
print("VERDICT : %s" % ("OK" if _ko == 0 else "ECHEC (%d)" % _ko))
sys.exit(0 if _ko == 0 else 1)
