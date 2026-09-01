#!/usr/bin/env python3
"""
Hou.la Connect - sidecar de pilotage bas niveau (Windows).

Expose des helpers vérifiés, appelés par le process MAIN de l'app via un JSON-RPC
minimal sur stdio (une requête JSON par ligne sur stdin, une réponse par ligne sur
stdout). AUCUN eval, AUCUN chemin de script : les bundles restent de la donnée
inerte, seul ce binaire (fourni par l'app, figé PyInstaller) fait l'I/O driver.

  interception-keys : envoie des touches au niveau DRIVER (jeux qui ignorent
                      l'input synthétique SendInput). key-spec :
                        'space' | 'shift+c' | 'c,c,c' | 'space:400'
  vigem-gamepad     : manette virtuelle Xbox 360 (ViGEm) : press/hold/release.
  vigem-passthrough : mode « une seule manette ». Recopie EN CONTINU la manette
                      PHYSIQUE du joueur (XInput) dans la manette virtuelle, et y
                      superpose les combos des cadeaux. Ainsi l'émulateur/jeu n'a
                      qu'à lire la manette virtuelle (Joueur 1) : le joueur conduit
                      NORMALEMENT et les cadeaux ajoutent leurs effets. Résout le
                      piège « le jeu lit la physique, pas la virtuelle ».

Dépendances (voir requirements.txt) : interception-python, vgamepad.
Le driver ViGEmBus / Interception doit être installé (flux guidé dans l'app).
"""
import sys
import json
import time
import ctypes
import threading
import atexit
import gc

# Imports paresseux + dégradation propre si un driver/lib manque.
_kb = None
_pad = None
_vg = None


def _get_interception():
    global _kb
    if _kb is None:
        import interception  # interception-python
        interception.auto_capture_devices(keyboard=True, mouse=False)
        _kb = interception
    return _kb


def _get_gamepad():
    global _pad, _vg
    if _pad is None:
        try:
            # ATTENTION : vgamepad se connecte au bus ViGEmBus dès l'IMPORT (VBUS = VBus()
            # dans son __init__). Sans le driver, l'IMPORT LUI-MÊME lève
            # (VIGEM_ERROR_BUS_NOT_FOUND) — pas seulement VX360Gamepad(). L'import est donc
            # DANS le try, pour que TOUT échec (import + alloc) soit taggé VIGEMBUS_MISSING
            # et que l'app propose l'installation guidée du pilote (MSI fourni).
            import vgamepad as vg
            _vg = vg
            _pad = vg.VX360Gamepad()
        except Exception as e:  # noqa: BLE001
            raise RuntimeError("VIGEMBUS_MISSING: " + str(e))
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


# ── vigem-gamepad : tokens de boutons/gâchettes ────────────────────
# Boutons numériques (press/release). Les GÂCHETTES LT/RT sont des AXES XInput,
# pas des boutons : gérées à part (left_trigger/right_trigger).
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


def _clamp_axis(v):
    try:
        return max(-1.0, min(float(v), 1.0))
    except (TypeError, ValueError):
        return 0.0


# ── XInput : LECTURE de la manette physique (pour le passthrough) ───
_xinput = None


def _load_xinput():
    global _xinput
    if _xinput is None:
        for dll in ("xinput1_4", "xinput1_3", "xinput9_1_0"):
            try:
                _xinput = ctypes.windll.LoadLibrary(dll)
                break
            except Exception:  # noqa: BLE001
                pass
    return _xinput


class _XGamepad(ctypes.Structure):
    _fields_ = [
        ("wButtons", ctypes.c_ushort), ("bLeftTrigger", ctypes.c_ubyte),
        ("bRightTrigger", ctypes.c_ubyte), ("sThumbLX", ctypes.c_short),
        ("sThumbLY", ctypes.c_short), ("sThumbRX", ctypes.c_short), ("sThumbRY", ctypes.c_short),
    ]


class _XState(ctypes.Structure):
    _fields_ = [("dwPacketNumber", ctypes.c_uint), ("Gamepad", _XGamepad)]


def _xinput_read(index):
    """État de la manette XInput #index, ou None si non connectée / index None."""
    xi = _load_xinput()
    if xi is None or index is None:
        return None
    st = _XState()
    return st.Gamepad if xi.XInputGetState(index, ctypes.byref(st)) == 0 else None


# Masques boutons XInput -> nos tokens.
_XI_BUTTONS = [
    (0x0001, "UP"), (0x0002, "DOWN"), (0x0004, "LEFT"), (0x0008, "RIGHT"),
    (0x0010, "START"), (0x0020, "BACK"), (0x0040, "LS"), (0x0080, "RS"),
    (0x0100, "LB"), (0x0200, "RB"), (0x1000, "A"), (0x2000, "B"), (0x4000, "X"), (0x8000, "Y"),
]


# ── Passthrough : physique recopiée dans la virtuelle + overlays cadeaux ──
_pt_running = False
_pt_thread = None
_pt_index = None          # index XInput de la PHYSIQUE à recopier (None = juste les cadeaux)
_virtual_index = None     # index XInput de NOTRE pad virtuel (identifié par signature)
_pt_lock = threading.Lock()
_ov_buttons = set()       # boutons/gâchettes forcés par les cadeaux (tokens majuscules)
_ov_analog = None         # override sticks {lx,ly,rx,ry} en float, ou None


def _identify_virtual_index(pad, vg):
    """Index XInput RÉEL de notre pad virtuel.

    ⚠️ `pad.get_index()` renvoie l'ordre ViGEm (ordre de branchement au bus), qui n'est
    PAS l'index utilisateur XInput assigné par Windows. Se fier à `get_index()-1` fait lire
    la MAUVAISE manette (bug réel : la physique n'était jamais recopiée). On imprime donc une
    SIGNATURE inédite (LB+RB + 2 gâchettes à fond) sur le pad virtuel et on regarde quel slot
    XInput la reflète : ce slot EST le nôtre. Combo volontairement improbable au repos d'une
    vraie manette -> quasi zéro faux positif. Sonde ~50 ms puis on relâche."""
    try:
        for _ in range(8):  # le pad ViGEm peut mettre un instant à apparaître dans XInput
            pad.reset()
            pad.press_button(button=getattr(vg.XUSB_BUTTON, "XUSB_GAMEPAD_LEFT_SHOULDER"))
            pad.press_button(button=getattr(vg.XUSB_BUTTON, "XUSB_GAMEPAD_RIGHT_SHOULDER"))
            pad.left_trigger(value=255)
            pad.right_trigger(value=255)
            pad.update()
            time.sleep(0.05)
            for i in range(4):
                gp = _xinput_read(i)
                if gp is None:
                    continue
                if (gp.wButtons & 0x0300) == 0x0300 and gp.bLeftTrigger > 200 and gp.bRightTrigger > 200:
                    pad.reset(); pad.update()
                    return i
        pad.reset(); pad.update()
    except Exception:  # noqa: BLE001
        try:
            pad.reset(); pad.update()
        except Exception:  # noqa: BLE001
            pass
    return None


def _find_physical_index(virtual_pad):
    """Index XInput de la manette PHYSIQUE : la 1re manette connectée qui n'est PAS la nôtre.
    `_virtual_index` est identifié une fois (par signature) à l'activation du passthrough."""
    for i in range(4):
        if i == _virtual_index:
            continue
        if _xinput_read(i) is not None:
            return i
    return None


def _passthrough_loop(pad, vg):
    """~125 Hz : état virtuel = physique (si présente) + overlays des cadeaux.
    RE-DÉTECTE la manette physique en continu : une manette Xbox sans fil DORT au repos
    (disparaît de XInput) et se réveille au 1er appui ; un branchement à chaud arrive aussi.
    Sans re-scan, une physique absente au démarrage ne serait JAMAIS reprise."""
    global _pt_index
    miss = 0
    ticks = 0
    while _pt_running:
        try:
            if _pt_index is None and ticks % 30 == 0:  # ~0.25 s : cherche une physique (réveil/hot-plug)
                _pt_index = _find_physical_index(pad)
            ticks += 1
            gp = _xinput_read(_pt_index) if _pt_index is not None else None
            if _pt_index is not None and gp is None:
                miss += 1
                if miss > 60:  # ~0.5 s sans réponse -> débranchée/endormie : on re-détecte
                    _pt_index = None
                    miss = 0
            else:
                miss = 0
            pad.reset()
            lt = gp.bLeftTrigger if gp else 0
            rt = gp.bRightTrigger if gp else 0
            if gp:
                for mask, tok in _XI_BUTTONS:
                    if gp.wButtons & mask:
                        pad.press_button(button=getattr(vg.XUSB_BUTTON, _BUTTONS[tok]))
            with _pt_lock:
                ob = list(_ov_buttons)
                oa = dict(_ov_analog) if _ov_analog is not None else None
            for tok in ob:
                if tok in _BUTTONS:
                    pad.press_button(button=getattr(vg.XUSB_BUTTON, _BUTTONS[tok]))
                elif tok == "LT":
                    lt = 255
                elif tok == "RT":
                    rt = 255
            if lt:
                pad.left_trigger(value=lt)
            if rt:
                pad.right_trigger(value=rt)
            if oa is not None:  # un cadeau force les sticks -> override
                pad.left_joystick_float(x_value_float=oa.get("lx", 0.0), y_value_float=oa.get("ly", 0.0))
                pad.right_joystick_float(x_value_float=oa.get("rx", 0.0), y_value_float=oa.get("ry", 0.0))
            elif gp:  # sinon on recopie les sticks physiques
                pad.left_joystick(x_value=gp.sThumbLX, y_value=gp.sThumbLY)
                pad.right_joystick(x_value=gp.sThumbRX, y_value=gp.sThumbRY)
            pad.update()
        except Exception:  # noqa: BLE001
            pass
        time.sleep(0.008)


def helper_vigem_passthrough(args):
    """Démarre/arrête le mode « une seule manette » (mirroring physique -> virtuelle)."""
    global _pt_running, _pt_thread, _pt_index, _virtual_index
    pad = _get_gamepad()
    vg = _vg
    if bool(args.get("enable")):
        _virtual_index = _identify_virtual_index(pad, vg)  # notre slot XInput (fiable, pas get_index)
        _pt_index = _find_physical_index(pad)  # (re)détecte la physique (branchement à chaud)
        if not _pt_running:
            _pt_running = True
            _pt_thread = threading.Thread(target=_passthrough_loop, args=(pad, vg), daemon=True)
            _pt_thread.start()
        return {"passthrough": True, "physicalIndex": _pt_index, "virtualIndex": _virtual_index}
    # Désactivation : on stoppe le loop, on vide les overlays, on relâche le pad.
    _pt_running = False
    with _pt_lock:
        _ov_buttons.clear()
    globals()["_ov_analog"] = None
    try:
        pad.reset()
        pad.update()
    except Exception:  # noqa: BLE001
        pass
    return {"passthrough": False}


# ── Exécution des effets manette (direct HORS passthrough, overlay PENDANT) ──
def _set_tokens(pad, vg, tokens, down):
    """Direct (hors passthrough) : presse/relâche un CHORD sur le pad virtuel.
    Tous les tokens sont VALIDÉS avant toute mutation (un token inconnu au milieu
    ne doit pas laisser un bit à moitié pressé)."""
    norm = [str(t).upper() for t in tokens]
    for t in norm:
        if t not in _BUTTONS and t not in _TRIGGERS:
            raise ValueError(f"bouton inconnu: {t}")
    for t in norm:
        if t in _BUTTONS:
            btn = getattr(vg.XUSB_BUTTON, _BUTTONS[t])
            (pad.press_button if down else pad.release_button)(button=btn)
        else:
            getattr(pad, _TRIGGERS[t])(value=255 if down else 0)
    pad.update()


def _fire_tokens(pad, vg, tokens, hold_ms):
    if not tokens:
        return
    norm = [str(t).upper() for t in tokens]
    for t in norm:  # valide dans les DEUX modes (rejette un token inconnu)
        if t not in _BUTTONS and t not in _TRIGGERS:
            raise ValueError(f"bouton inconnu: {t}")
    hold = _clamp_ms(hold_ms, 10000) / 1000.0
    if _pt_running:
        # PASSTHROUGH : on superpose ces tokens à la physique (le loop les applique),
        # on les tient hold_ms, puis on les retire. On ne touche PAS le pad directement.
        with _pt_lock:
            _ov_buttons.update(norm)
        time.sleep(hold)
        with _pt_lock:
            _ov_buttons.difference_update(norm)
    else:
        _set_tokens(pad, vg, norm, True)
        time.sleep(hold)
        _set_tokens(pad, vg, norm, False)


def helper_vigem_gamepad(args):
    pad = _get_gamepad()  # importe vgamepad de façon TAGGÉE (VIGEMBUS_MISSING si pilote absent)
    vg = _vg
    if args.get("release"):
        if not _pt_running:
            pad.reset()
            pad.update()
        else:  # en passthrough, « release » = vider les overlays, garder le mirroring
            with _pt_lock:
                _ov_buttons.clear()
            globals()["_ov_analog"] = None
        return {"released": True}

    # Toute erreur en cours de route doit RELÂCHER les overlays / le pad (pas de touche coincée).
    try:
        # 1) Timeline d'ÉTAPES : [{buttons:[...],holdMs} | {waitMs}].
        steps = args.get("steps")
        if isinstance(steps, list) and steps:
            for st in steps:
                toks = st.get("buttons") or ([st["button"]] if st.get("button") else [])
                if toks:
                    _fire_tokens(pad, vg, toks, st.get("holdMs", 120))
                wait = st.get("waitMs")
                if wait is not None:
                    time.sleep(_clamp_ms(wait, 30000) / 1000.0)
            if not _pt_running:
                pad.reset()
                pad.update()
            return {"steps": len(steps)}

        # 2) ANALOGIQUE : pousser stick(s)/gâchette(s), tenir, relâcher.
        analog = args.get("analog")
        if isinstance(analog, dict):
            hold = _clamp_ms(args.get("holdMs", 300), 10000) / 1000.0
            if _pt_running:
                a = {"lx": _clamp_axis(analog.get("lx", 0)), "ly": _clamp_axis(analog.get("ly", 0)),
                     "rx": _clamp_axis(analog.get("rx", 0)), "ry": _clamp_axis(analog.get("ry", 0))}
                trg = set()
                if analog.get("lt"):
                    trg.add("LT")
                if analog.get("rt"):
                    trg.add("RT")
                with _pt_lock:
                    globals()["_ov_analog"] = a
                    _ov_buttons.update(trg)
                time.sleep(hold)
                with _pt_lock:
                    globals()["_ov_analog"] = None
                    _ov_buttons.difference_update(trg)
                return {"analog": True}
            if "lx" in analog or "ly" in analog:
                pad.left_joystick_float(x_value_float=_clamp_axis(analog.get("lx", 0)), y_value_float=_clamp_axis(analog.get("ly", 0)))
            if "rx" in analog or "ry" in analog:
                pad.right_joystick_float(x_value_float=_clamp_axis(analog.get("rx", 0)), y_value_float=_clamp_axis(analog.get("ry", 0)))
            if "lt" in analog:
                pad.left_trigger_float(value_float=max(0.0, _clamp_axis(analog.get("lt", 0))))
            if "rt" in analog:
                pad.right_trigger_float(value_float=max(0.0, _clamp_axis(analog.get("rt", 0))))
            pad.update()
            time.sleep(hold)
            pad.reset()
            pad.update()
            return {"analog": True}

        # 3) CHORD ou bouton simple.
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
            with _pt_lock:
                _ov_buttons.clear()
            globals()["_ov_analog"] = None
            if not _pt_running:
                pad.reset()
                pad.update()
        except Exception:  # noqa: BLE001
            pass
        raise


def _cleanup_pad():
    """Débranche PROPREMENT la manette virtuelle ViGEm à la sortie du sidecar.

    Sans ça, chaque arrêt laisse une CIBLE ZOMBIE (« Contrôleur XBOX 360 » fantôme) :
    accumulées, elles finissent par COINCER le bus ViGEmBus (écritures gelées, plus
    aucun incrément de paquet XInput) jusqu'au REDÉMARRAGE de la machine. vgamepad ne
    retire la cible que dans son __del__, qui ne tourne pas de façon fiable à la sortie
    de l'interpréteur -> on le déclenche explicitement ici (couvre la fermeture normale
    du sidecar quand l'app ferme stdin). Un kill Windows brutal (TerminateProcess) ne
    l'exécutera pas : l'app doit d'abord fermer stdin pour laisser CE nettoyage tourner."""
    global _pad, _pt_running
    _pt_running = False
    p = _pad
    _pad = None
    if p is None:
        return
    try:
        p.reset(); p.update()
    except Exception:  # noqa: BLE001
        pass
    try:
        del p
        gc.collect()  # refcount 0 -> __del__ vgamepad = vigem_target_remove + free
    except Exception:  # noqa: BLE001
        pass


atexit.register(_cleanup_pad)


def helper_shutdown(args):
    """Arrêt GRACIEUX demandé par l'app : débranche la manette AVANT que l'app ne ferme
    stdin / ne tue le process (sinon la cible ViGEm fuit en zombie)."""
    _cleanup_pad()
    return {"shutdown": True}


HELPERS = {
    "interception-keys": helper_interception_keys,
    "vigem-gamepad": helper_vigem_gamepad,
    "vigem-passthrough": helper_vigem_passthrough,
    "shutdown": helper_shutdown,
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
