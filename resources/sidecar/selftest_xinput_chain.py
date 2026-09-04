#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Sonde XInput : ce que Windows (et donc SDL, donc Ryujinx) voit de nos manettes.

POURQUOI CETTE SONDE. On veut prouver la chaine SANS jeu ni ROM : SDL lit XInput, donc si
XInput rapporte l'appui injecte sur le bon emplacement, tout ce qui est en aval (SDL,
Ryujinx) le verra aussi. Ce qui reste a verifier a l'oeil ensuite, c'est uniquement
l'AFFECTATION du peripherique au bon joueur dans les reglages de l'emulateur.

CONTRE-TEMOIN INTEGRE : on lit l'etat AVANT l'injection. Si le bouton etait deja marque
appuye, la mesure ne vaudrait rien (elle mesurerait autre chose que notre injection).
"""
import ctypes, json, os, subprocess, sys, time
from ctypes import wintypes

SIDECAR = r"P:\hou.la\www\houla-connect-app\resources\sidecar\houla-sidecar.exe"

BOUTONS = {0x1000: "A", 0x2000: "B", 0x4000: "X", 0x8000: "Y",
           0x0100: "LB", 0x0200: "RB", 0x0020: "BACK", 0x0010: "START",
           0x0001: "UP", 0x0002: "DOWN", 0x0004: "LEFT", 0x0008: "RIGHT"}


class GAMEPAD(ctypes.Structure):
    _fields_ = [("wButtons", wintypes.WORD), ("bLeftTrigger", ctypes.c_ubyte),
                ("bRightTrigger", ctypes.c_ubyte), ("sThumbLX", ctypes.c_short),
                ("sThumbLY", ctypes.c_short), ("sThumbRX", ctypes.c_short),
                ("sThumbRY", ctypes.c_short)]


class STATE(ctypes.Structure):
    _fields_ = [("dwPacketNumber", wintypes.DWORD), ("Gamepad", GAMEPAD)]


def charger_xinput():
    for nom in ("xinput1_4.dll", "xinput1_3.dll", "xinput9_1_0.dll"):
        try:
            return ctypes.WinDLL(nom), nom
        except OSError:
            continue
    return None, None


def lire(xi, idx):
    st = STATE()
    if xi.XInputGetState(idx, ctypes.byref(st)) != 0:
        return None
    g = st.Gamepad
    return {"paquet": st.dwPacketNumber,
            "boutons": [n for m, n in BOUTONS.items() if g.wButtons & m],
            "LX": g.sThumbLX, "LY": g.sThumbLY, "RX": g.sThumbRX, "RY": g.sThumbRY,
            "LT": g.bLeftTrigger, "RT": g.bRightTrigger}


def rpc(p, method, params=None):
    p.stdin.write(json.dumps({"id": 1, "method": method, "params": params or {}}) + "\n")
    p.stdin.flush()
    return json.loads(p.stdout.readline())


def main():
    xi, nom = charger_xinput()
    if not xi:
        print("ABANDON : aucune DLL XInput chargeable"); return 2
    print(f"XInput charge depuis : {nom}\n")

    print("--- Emplacements AVANT (etat de depart) ---")
    for i in range(4):
        e = lire(xi, i)
        print(f"  slot {i} : {'connecte  ' + json.dumps(e['boutons']) if e else 'vide'}")

    p = subprocess.Popen([SIDECAR], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                         stderr=subprocess.DEVNULL, text=True, encoding="utf-8", bufsize=1)
    pt = rpc(p, "vigem-passthrough", {"enable": True}).get("result", {})
    vidx = pt.get("virtualIndex")
    print(f"\nmanette virtuelle creee -> emplacement {vidx} "
          f"(physique detectee : {pt.get('physicalIndex')})")
    time.sleep(1.5)

    print("\n--- Emplacements APRES creation ---")
    for i in range(4):
        e = lire(xi, i)
        print(f"  slot {i} : {'connecte' if e else 'vide'}")

    if vidx is None or vidx < 0:
        print("\nABANDON : pas d'emplacement virtuel"); p.kill(); return 3

    avant = lire(xi, vidx)
    print(f"\nCONTRE-TEMOIN, avant injection -> slot {vidx} : boutons={avant['boutons']} "
          f"paquet={avant['paquet']}")
    if avant["boutons"]:
        print("  ATTENTION : un bouton est deja marque appuye, la mesure ne vaudrait rien.")

    # Injection dans un THREAD : XInputGetState doit etre lu PENDANT que la touche est tenue.
    import threading
    res = {}
    t = threading.Thread(target=lambda: res.update(
        rpc(p, "vigem-gamepad", {"button": "A", "holdMs": 900})))
    t.start()
    time.sleep(0.35)
    pendant = lire(xi, vidx)
    t.join()
    # La boucle de passthrough publie l'etat toutes les 8 ms : lire IMMEDIATEMENT apres la
    # fin de l'appel peut tomber avant le cycle qui rapporte le relachement. Ce n'etait pas
    # un bug du produit, c'etait une course dans CE test. On laisse passer plusieurs cycles.
    time.sleep(0.25)
    apres = lire(xi, vidx)

    print(f"PENDANT l'injection    -> slot {vidx} : boutons={pendant['boutons']} "
          f"paquet={pendant['paquet']}")
    print(f"APRES relachement      -> slot {vidx} : boutons={apres['boutons']} "
          f"paquet={apres['paquet']}")

    ok = ("A" in pendant["boutons"]) and ("A" not in apres["boutons"]) \
         and pendant["paquet"] != avant["paquet"]
    print(f"\nVERDICT : {'OK, XInput rapporte bien l appui injecte' if ok else '*** ECHEC ***'}")
    print("  (A appuye pendant, relache apres, et le numero de paquet a bouge :")
    print("   les trois sont exiges, sinon on pourrait confondre avec un etat fige.)")

    try: rpc(p, "shutdown")
    except Exception: pass
    p.kill()
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
