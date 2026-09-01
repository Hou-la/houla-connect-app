#!/usr/bin/env python3
"""Self-test LOCAL de la logique de recopie manette (passthrough).

But : prouver que le loop `_passthrough_loop` COMBINE bien la manette PHYSIQUE du
joueur et l'overlay des cadeaux dans le MÊME rapport manette (boutons ET gâchettes),
et relâche l'overlay proprement. C'est le scénario exact qui avait régressé :
« cadeau pendant que le joueur tient un bouton » -> le bouton ET le cadeau doivent
sortir ensemble sur la manette virtuelle.

Astuce : on n'a PAS besoin d'un bus ViGEm sain (lecture/écriture XInput) pour ce test.
On MOCKE la lecture physique (`_xinput_read`) et on inspecte `pad.report.wButtons` /
`bLeftTrigger`, qui sont mutés par `press_button`/`left_trigger` AVANT tout `update()`.

Prérequis : lancé sur une VRAIE machine Windows où `import vgamepad` réussit (pilote
ViGEmBus présent). Ne tourne PAS en CI (le pilote noyau ne peut pas y être chargé).
Usage :  python resources/sidecar/selftest_passthrough.py   (exit 0 = OK, 2 = échec)
"""
import os
import sys
import time
import threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import houla_sidecar as hs  # noqa: E402

PHYS_IDX = 7  # index physique fictif renvoyé par notre mock


def _names(b):
    return "+".join(t for m, t in hs._XI_BUTTONS if b & m) or "(rien)"


def run():
    fake = hs._XGamepad()
    fake.wButtons = 0x1000  # A tenu
    orig = hs._xinput_read
    hs._xinput_read = lambda idx: fake if idx == PHYS_IDX else None
    try:
        pad = hs._get_gamepad()
        vg = hs._vg
        hs._virtual_index = 9
        hs._pt_index = PHYS_IDX
        hs._pt_running = True
        th = threading.Thread(target=hs._passthrough_loop, args=(pad, vg), daemon=True)
        th.start()
        time.sleep(0.12)

        checks = []
        r1 = pad.report.wButtons
        checks.append(("physique=[A] -> report=[%s]" % _names(r1), r1 == 0x1000))

        t = threading.Thread(target=lambda: hs.helper_vigem_gamepad({"button": "Y", "holdMs": 400}))
        t.start()
        time.sleep(0.15)
        r2 = pad.report.wButtons
        checks.append(("physique=[A] + cadeau Y -> report=[%s]" % _names(r2), r2 == 0x9000))
        t.join()
        time.sleep(0.12)
        r3 = pad.report.wButtons
        checks.append(("cadeau fini, physique=[A] -> report=[%s]" % _names(r3), r3 == 0x1000))

        fake.wButtons = 0x0
        time.sleep(0.12)
        r4 = pad.report.wButtons
        checks.append(("physique relâchée -> report=[%s]" % _names(r4), r4 == 0x0))

        fake.wButtons = 0x2000  # B
        tt = threading.Thread(target=lambda: hs.helper_vigem_gamepad({"button": "LT", "holdMs": 400}))
        tt.start()
        time.sleep(0.15)
        r5b, r5lt = pad.report.wButtons, pad.report.bLeftTrigger
        checks.append(("physique=[B] + cadeau LT -> boutons=[%s] LT=%d" % (_names(r5b), r5lt),
                       r5b == 0x2000 and r5lt == 255))
        tt.join()

        hs._pt_running = False
        time.sleep(0.05)
        ok = True
        for label, passed in checks:
            print(("  OK " if passed else "  KO ") + label)
            ok = ok and passed
        print("VERDICT:", "TOUT OK" if ok else "ECHEC")
        return 0 if ok else 2
    finally:
        hs._pt_running = False
        hs._xinput_read = orig


if __name__ == "__main__":
    sys.exit(run())
