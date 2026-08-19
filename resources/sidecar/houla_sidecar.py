#!/usr/bin/env python3
"""
Hou.la Connect - sidecar de pilotage bas niveau (Windows).

Expose UNIQUEMENT deux helpers vérifiés, appelés par le process MAIN de l'app via
un JSON-RPC minimal sur stdio (une requête JSON par ligne sur stdin, une réponse
par ligne sur stdout). AUCUN eval, AUCUN chemin de script : les bundles restent
de la donnée inerte, seul ce binaire (fourni par l'app, figé PyInstaller) fait
l'I/O driver.

  interception-keys : envoie des touches au niveau DRIVER (jeux qui ignorent
                      l'input synthétique SendInput, ex. Meccha). Grammaire de
                      key-spec identique au reste de l'app :
                        'space' | 'shift+c' | 'c,c,c' | 'space:400'
  vigem-gamepad     : manette virtuelle Xbox 360 (ViGEm) : press/hold/release.

Dépendances (voir requirements.txt) : interception-python, vgamepad.
Le driver ViGEmBus / Interception doit être installé (flux guidé dans l'app).
"""
import sys
import json
import time

# Imports paresseux + dégradation propre si un driver/lib manque.
_kb = None
_pad = None


def _get_interception():
    global _kb
    if _kb is None:
        import interception  # interception-python
        interception.auto_capture_devices(keyboard=True, mouse=False)
        _kb = interception
    return _kb


def _get_gamepad():
    global _pad
    if _pad is None:
        import vgamepad as vg
        _pad = vg.VX360Gamepad()
    return _pad


# ── interception-keys ─────────────────────────────────────────────
def helper_interception_keys(args):
    spec = str(args.get("keys", ""))
    ic = _get_interception()
    for raw_step in spec.split(","):
        combo, _, hold = raw_step.partition(":")
        keys = [k.strip().lower() for k in combo.split("+") if k.strip()]
        for k in keys:
            ic.key_down(k)
        if hold:
            time.sleep(min(int(hold), 2000) / 1000.0)
        for k in reversed(keys):
            ic.key_up(k)
        time.sleep(0.04)
    return {"pressed": spec}


# ── vigem-gamepad ─────────────────────────────────────────────────
_BUTTONS = {
    "A": "XUSB_GAMEPAD_A", "B": "XUSB_GAMEPAD_B", "X": "XUSB_GAMEPAD_X", "Y": "XUSB_GAMEPAD_Y",
    "LB": "XUSB_GAMEPAD_LEFT_SHOULDER", "RB": "XUSB_GAMEPAD_RIGHT_SHOULDER",
    "UP": "XUSB_GAMEPAD_DPAD_UP", "DOWN": "XUSB_GAMEPAD_DPAD_DOWN",
    "LEFT": "XUSB_GAMEPAD_DPAD_LEFT", "RIGHT": "XUSB_GAMEPAD_DPAD_RIGHT",
    "START": "XUSB_GAMEPAD_START", "BACK": "XUSB_GAMEPAD_BACK",
    "LS": "XUSB_GAMEPAD_LEFT_THUMB", "RS": "XUSB_GAMEPAD_RIGHT_THUMB",
}


def helper_vigem_gamepad(args):
    import vgamepad as vg
    pad = _get_gamepad()
    if args.get("release"):
        pad.reset()
        pad.update()
        return {"released": True}
    button = str(args.get("button", "")).upper()
    name = _BUTTONS.get(button)
    if not name:
        raise ValueError(f"bouton inconnu: {button}")
    btn = getattr(vg.XUSB_BUTTON, name)
    hold = min(int(args.get("holdMs", 120)), 2000) / 1000.0
    pad.press_button(button=btn)
    pad.update()
    time.sleep(hold)
    pad.release_button(button=btn)
    pad.update()
    return {"pressed": button}


HELPERS = {
    "interception-keys": helper_interception_keys,
    "vigem-gamepad": helper_vigem_gamepad,
}


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
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
            sys.stdout.write(json.dumps({"id": req.get("id") if "req" in dir() else None, "error": str(e)}) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
