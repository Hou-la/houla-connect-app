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
    # Délai (ms) entre chaque touche d'une SUITE (rythme de la saisie). Défaut 40.
    gap = _clamp_ms(args.get("gapMs", 40), 5000) / 1000.0
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
        time.sleep(gap)
    return {"pressed": spec}


# ── vigem-gamepad ─────────────────────────────────────────────────
# Boutons numériques (press/release). Les GÂCHETTES LT/RT sont des AXES XInput,
# pas des boutons : elles sont gérées à part (left_trigger/right_trigger), sinon
# elles « valident » côté serveur mais plantent au runtime (bug historique).
_BUTTONS = {
    "A": "XUSB_GAMEPAD_A", "B": "XUSB_GAMEPAD_B", "X": "XUSB_GAMEPAD_X", "Y": "XUSB_GAMEPAD_Y",
    "LB": "XUSB_GAMEPAD_LEFT_SHOULDER", "RB": "XUSB_GAMEPAD_RIGHT_SHOULDER",
    "UP": "XUSB_GAMEPAD_DPAD_UP", "DOWN": "XUSB_GAMEPAD_DPAD_DOWN",
    "LEFT": "XUSB_GAMEPAD_DPAD_LEFT", "RIGHT": "XUSB_GAMEPAD_DPAD_RIGHT",
    "START": "XUSB_GAMEPAD_START", "BACK": "XUSB_GAMEPAD_BACK",
    "LS": "XUSB_GAMEPAD_LEFT_THUMB", "RS": "XUSB_GAMEPAD_RIGHT_THUMB",
}
_TRIGGERS = {"LT": "left_trigger", "RT": "right_trigger"}


def _clamp_ms(v, hi):
    try:
        return max(0, min(int(v), hi))
    except (TypeError, ValueError):
        return 0


def _set_tokens(pad, vg, tokens, down):
    """Presse (down=True) ou relâche (down=False) un ENSEMBLE de touches EN MÊME
    TEMPS (chord). Boutons via press/release_button, gâchettes via l'axe.

    Les tokens sont TOUS validés AVANT toute mutation de la struct : un token inconnu
    au milieu d'un chord ne doit JAMAIS laisser un bit à moitié pressé dans le report
    persistant du pad virtuel (sinon l'effet suivant le flushe et coince la touche)."""
    norm = [str(t).upper() for t in tokens]
    for t in norm:
        if t not in _BUTTONS and t not in _TRIGGERS:
            raise ValueError(f"bouton inconnu: {t}")
    for t in norm:
        if t in _BUTTONS:
            btn = getattr(vg.XUSB_BUTTON, _BUTTONS[t])
            (pad.press_button if down else pad.release_button)(button=btn)
        else:  # gâchette (axe)
            getattr(pad, _TRIGGERS[t])(value=255 if down else 0)
    pad.update()


def _fire_tokens(pad, vg, tokens, hold_ms):
    if not tokens:
        return
    _set_tokens(pad, vg, tokens, True)
    time.sleep(_clamp_ms(hold_ms, 10000) / 1000.0)
    _set_tokens(pad, vg, tokens, False)


def _clamp_axis(v):
    try:
        return max(-1.0, min(float(v), 1.0))
    except (TypeError, ValueError):
        return 0.0


def helper_vigem_gamepad(args):
    import vgamepad as vg
    pad = _get_gamepad()
    if args.get("release"):
        pad.reset()
        pad.update()
        return {"released": True}

    # Toute erreur en cours de route (token inconnu, exception driver) doit RELÂCHER
    # le pad : sinon un bit resté pressé dans le report persistant est flushé par
    # l'effet suivant et coince la touche en plein live.
    try:
        # 1) Timeline d'ÉTAPES : [{buttons:[...],holdMs} | {waitMs}] — couvre « combo,
        #    puis attendre N s, puis touche stop » et les enchaînements arbitraires.
        steps = args.get("steps")
        if isinstance(steps, list) and steps:
            for st in steps:
                toks = st.get("buttons") or ([st["button"]] if st.get("button") else [])
                if toks:
                    _fire_tokens(pad, vg, toks, st.get("holdMs", 120))
                wait = st.get("waitMs")
                if wait is not None:
                    time.sleep(_clamp_ms(wait, 30000) / 1000.0)
            pad.reset()
            pad.update()
            return {"steps": len(steps)}

        # 2) ANALOGIQUE : pousser stick(s)/gâchette(s) à une intensité, tenir, relâcher.
        analog = args.get("analog")
        if isinstance(analog, dict):
            if "lx" in analog or "ly" in analog:
                pad.left_joystick_float(x_value_float=_clamp_axis(analog.get("lx", 0)), y_value_float=_clamp_axis(analog.get("ly", 0)))
            if "rx" in analog or "ry" in analog:
                pad.right_joystick_float(x_value_float=_clamp_axis(analog.get("rx", 0)), y_value_float=_clamp_axis(analog.get("ry", 0)))
            if "lt" in analog:
                pad.left_trigger_float(value_float=max(0.0, _clamp_axis(analog.get("lt", 0))))
            if "rt" in analog:
                pad.right_trigger_float(value_float=max(0.0, _clamp_axis(analog.get("rt", 0))))
            pad.update()
            time.sleep(_clamp_ms(args.get("holdMs", 300), 10000) / 1000.0)
            pad.reset()
            pad.update()
            return {"analog": True}

        # 3) CHORD ou bouton simple : plusieurs touches ensemble, ou une seule.
        tokens = args.get("buttons")
        if not tokens:
            b = str(args.get("button", "")).upper()
            tokens = [b] if b else []
        if not tokens:
            raise ValueError("aucune touche à presser")
        _fire_tokens(pad, vg, tokens, args.get("holdMs", 120))
        return {"pressed": tokens}
    except Exception:
        try:
            pad.reset()
            pad.update()
        except Exception:  # noqa: BLE001
            pass
        raise


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
