#!/usr/bin/env python3
"""Backend WINDOWS du sidecar : Interception (clavier) + ViGEmBus (manette).

C'est le SEUL chemin actuellement en production, avec de vrais utilisateurs. Le corps
des fonctions vient du fichier historique resources/sidecar/houla_sidecar.py et a été
DÉPLACÉ TEL QUEL lors du passage multiplateforme (2026-09-03) : mêmes retours, même
identification du slot XInput, même débranchement de la manette. Les seules retouches
sont mécaniques : les bornages `_clamp_ms`/`_clamp_axis` et le découpage des key-specs
viennent maintenant de backends/common.py (partagés avec Linux et macOS), et des alias
en fin de fichier donnent aux helpers les noms neutres attendus par l'aiguillage.

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
import os
import time
import ctypes
import threading
import atexit
import gc
import importlib.util

from .common import clamp_ms as _clamp_ms, clamp_axis as _clamp_axis, parse_key_spec

PLATFORM = "win32"

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


# ═══════════════════════════════════════════════════════════════════════════
# UNE MANETTE VIRTUELLE PAR JOUEUR
# ═══════════════════════════════════════════════════════════════════════════
# Jusqu'au 2026-09-08 il n'y en avait qu'UNE (`_pad`, variable de module) et sept
# globales de passthrough au singulier. Les émulateurs se jouent à plusieurs sur
# la même machine : un cadeau doit pouvoir viser un joueur précis.
#
# 🚨 LE PLAFOND DÉPEND DU TYPE DE MANETTE. Mesuré sur cette machine, pas déduit :
#
#   Xbox 360 virtuelle  -> consomme UN emplacement XInput. Windows n'en a que 4
#     (XInputGetState(4) rend ERROR_BAD_ARGUMENTS 160, pas « rien branché »), et
#     ils sont PARTAGÉS avec les manettes physiques. Avec 2 physiques branchées,
#     2 virtuelles saturent : [0,1] -> [0,1,2] -> [0,1,2,3], et les suivantes
#     sont acceptées par ViGEm mais INVISIBLES à XInput.
#     => plafond réel : 2 joueurs.
#
#   DualShock 4 virtuelle -> n'en consomme AUCUN. 8 créées, 8 périphériques de
#     jeu distincts, occupation XInput inchangée à [0,1]. Test discriminant
#     passé : appuyer sur le pad #k ne fait bouger QUE le périphérique #k, jamais
#     un autre. Délai d'énumération ~3 s par manette.
#     => plafond : 8 joueurs (et plus, winmm en annonce 16).
#
# Le prix du DS4 : un jeu qui ne lit QUE XInput ne le voit pas du tout. Les
# émulateurs, eux, le voient (Ryujinx lit en SDL3, vérifié sur le binaire
# installé ici). D'où le choix : Xbox 360 par défaut, compatibilité maximale ;
# DS4 sur demande explicite, quand il faut plus de deux joueurs.
MAX_JOUEURS = 8
TYPE_X360 = "x360"
TYPE_DS4 = "ds4"

# Type utilisé pour les joueurs créés sans type explicite. Le joueur 1 reste
# TOUJOURS en Xbox 360 : c'est lui que la DLL proxy fait passer pour la manette
# du jeu, et le proxy est un mécanisme XInput.
_type_par_defaut = TYPE_X360


class _Joueur:
    """État complet d'UN joueur. Remplace les sept globales au singulier."""

    __slots__ = ("num", "pad", "kind", "virtual_index", "pt_index",
                 "ov_buttons", "ov_analog", "lock", "thread", "running", "dpad")

    def __init__(self, num, pad, kind):
        self.num = num
        self.pad = pad
        self.kind = kind
        self.virtual_index = None   # emplacement XInput (Xbox 360 uniquement)
        self.pt_index = None        # emplacement de la physique recopiée
        self.ov_buttons = set()     # boutons forcés par les cadeaux
        self.ov_analog = None       # override sticks, ou None
        self.lock = threading.Lock()
        self.thread = None
        self.running = False
        # Directions ACTUELLEMENT tenues. Nécessaire uniquement pour le DS4 :
        # sa croix directionnelle est une DIRECTION unique (nord, nord-est…),
        # pas quatre bits indépendants comme sur Xbox 360. « Presser UP » n'y a
        # donc de sens qu'en sachant quelles autres directions sont tenues au
        # même instant, sinon relâcher LEFT effacerait aussi UP.
        self.dpad = set()


_joueurs = {}


def _num_joueur(args):
    """Numéro de joueur d'une requête, borné à 1..MAX_JOUEURS.

    Absent -> 1. Tout appel écrit avant ce changement continue donc de viser
    exactement la même manette qu'avant, sans rien savoir des joueurs."""
    try:
        n = int(args.get("player", 1) or 1)
    except (TypeError, ValueError):
        n = 1
    return max(1, min(MAX_JOUEURS, n))


def _get_joueur(num=1, kind=None):
    """Le joueur `num`, sa manette virtuelle créée à la demande."""
    global _pad, _vg
    j = _joueurs.get(num)
    if j is not None:
        return j
    try:
        # ATTENTION : vgamepad se connecte au bus ViGEmBus dès l'IMPORT (VBUS = VBus()
        # dans son __init__). Sans le driver, l'IMPORT LUI-MÊME lève
        # (VIGEM_ERROR_BUS_NOT_FOUND), pas seulement VX360Gamepad(). L'import est donc
        # DANS le try, pour que TOUT échec (import + alloc) soit taggé VIGEMBUS_MISSING
        # et que l'app propose l'installation guidée du pilote (MSI fourni).
        import vgamepad as vg
        _vg = vg
        # Un type EXPLICITE gagne toujours, joueur 1 compris : une configuration
        # entièrement DS4 est exactement ce qu'il faut pour un émulateur, et la
        # refuser au joueur 1 rendrait le mode 8 joueurs bancal.
        # Sans type explicite, le joueur 1 reste en Xbox 360 : c'est lui que la
        # DLL proxy fait passer pour la manette du jeu, et le proxy est un
        # mécanisme XInput.
        k = kind or (TYPE_X360 if num == 1 else _type_par_defaut)
        pad = vg.VDS4Gamepad() if k == TYPE_DS4 else vg.VX360Gamepad()
    except Exception as e:  # noqa: BLE001
        raise RuntimeError("VIGEMBUS_MISSING: " + str(e))
    j = _Joueur(num, pad, k)
    _joueurs[num] = j
    if num == 1:
        _pad = pad  # le reste du fichier parle encore du joueur 1 par ce nom
    return j


def _get_gamepad(num=1, kind=None):
    """Manette virtuelle du joueur `num` (1 par défaut : comportement d'avant)."""
    return _get_joueur(num, kind).pad


# ── interception-keys ─────────────────────────────────────────────
def helper_interception_keys(args):
    spec = str(args.get("keys", ""))
    # Délai (ms) entre chaque touche d'une SUITE (rythme de la saisie). Défaut 40.
    gap = _clamp_ms(args.get("gapMs", 40), 5000) / 1000.0
    ic = _get_interception()
    for keys, hold in parse_key_spec(spec):
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

# ── Même vocabulaire de tokens sur une manette DualShock 4 ───────────────────
# Les packs sont écrits avec les tokens Xbox (A, B, X, Y, LB…). Un pack ne doit
# PAS cesser de fonctionner parce que le diffuseur est passé à 8 joueurs et que
# ses manettes virtuelles sont devenues des DS4. On traduit donc, au lieu de
# demander au créateur de réécrire quoi que ce soit.
_DS4_BUTTONS = {
    "A": "DS4_BUTTON_CROSS", "B": "DS4_BUTTON_CIRCLE",
    "X": "DS4_BUTTON_SQUARE", "Y": "DS4_BUTTON_TRIANGLE",
    "LB": "DS4_BUTTON_SHOULDER_LEFT", "RB": "DS4_BUTTON_SHOULDER_RIGHT",
    "START": "DS4_BUTTON_OPTIONS", "BACK": "DS4_BUTTON_SHARE",
    "LS": "DS4_BUTTON_THUMB_LEFT", "RS": "DS4_BUTTON_THUMB_RIGHT",
}
_DPAD_TOKENS = ("UP", "DOWN", "LEFT", "RIGHT")
# Direction résultante, croix DS4. Clé = (vertical, horizontal) tenus.
_DS4_DIRECTIONS = {
    ("", ""): "DS4_BUTTON_DPAD_NONE",
    ("UP", ""): "DS4_BUTTON_DPAD_NORTH",
    ("DOWN", ""): "DS4_BUTTON_DPAD_SOUTH",
    ("", "LEFT"): "DS4_BUTTON_DPAD_WEST",
    ("", "RIGHT"): "DS4_BUTTON_DPAD_EAST",
    ("UP", "RIGHT"): "DS4_BUTTON_DPAD_NORTHEAST",
    ("UP", "LEFT"): "DS4_BUTTON_DPAD_NORTHWEST",
    ("DOWN", "RIGHT"): "DS4_BUTTON_DPAD_SOUTHEAST",
    ("DOWN", "LEFT"): "DS4_BUTTON_DPAD_SOUTHWEST",
}


def _ds4_direction_nom(tenus):
    """Nom de la direction DS4 correspondant aux tokens tenus.

    Deux directions OPPOSÉES tenues en même temps (UP et DOWN) s'annulent sur
    cet axe : c'est ce que fait une vraie croix physique, où le doigt ne peut
    pas appuyer des deux côtés à la fois. Les rendre gagnantes à tour de rôle
    produirait un tremblement que personne ne saurait diagnostiquer."""
    v = ("UP" in tenus, "DOWN" in tenus)
    h = ("LEFT" in tenus, "RIGHT" in tenus)
    vert = "UP" if v == (True, False) else ("DOWN" if v == (False, True) else "")
    hori = "LEFT" if h == (True, False) else ("RIGHT" if h == (False, True) else "")
    return _DS4_DIRECTIONS[(vert, hori)]


def _token_connu(tok):
    return tok in _BUTTONS or tok in _TRIGGERS


def _appliquer_token(j, vg, tok, down):
    """Presse ou relâche UN token sur la manette du joueur, quel que soit son type.

    N'appelle PAS `update()` : l'appelant groupe les tokens d'un accord et publie
    une seule fois, sinon un accord partirait en plusieurs images et le jeu
    verrait des appuis décalés au lieu d'un appui simultané."""
    if j.kind != TYPE_DS4:
        # Xbox 360 : chemin historique, inchangé.
        if tok in _BUTTONS:
            btn = getattr(vg.XUSB_BUTTON, _BUTTONS[tok])
            (j.pad.press_button if down else j.pad.release_button)(button=btn)
        else:
            getattr(j.pad, _TRIGGERS[tok])(value=255 if down else 0)
        return
    # DualShock 4.
    if tok in _DPAD_TOKENS:
        j.dpad.add(tok) if down else j.dpad.discard(tok)
        j.pad.directional_pad(
            direction=getattr(vg.DS4_DPAD_DIRECTIONS, _ds4_direction_nom(j.dpad)),
        )
    elif tok in _TRIGGERS:
        getattr(j.pad, _TRIGGERS[tok])(value=255 if down else 0)
    else:
        btn = getattr(vg.DS4_BUTTONS, _DS4_BUTTONS[tok])
        (j.pad.press_button if down else j.pad.release_button)(button=btn)


def _reset_joueur(j):
    """Remet la manette au repos. La croix DS4 est un ÉTAT : l'oublier laisserait
    une direction tenue indéfiniment après un `reset()`."""
    j.dpad.clear()
    j.pad.reset()
    j.pad.update()


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


# ── Proxy XInput : faire lire au JEU la virtuelle comme Joueur 1 ──────
# Le jeu (Meccha…) lit STRICTEMENT le slot XInput 0. La physique y est ; la virtuelle prend
# le slot 1 et est IGNORÉE -> les cadeaux n'arrivent jamais en jeu. Ni HidHide (masque la
# visibilité mais ne libère pas le slot 0) ni pnputil disable/enable (exige un reboot ici) ne
# règlent ça proprement. Solution retenue et VALIDÉE (Meccha, 2026-09-02) : une DLL proxy
# `xinput1_4.dll` posée dans le dossier du jeu (chargée avant System32) remappe game-index 0 ->
# index RÉEL de la virtuelle. On lui communique cet index via un petit fichier de config, relu
# à chaud par la DLL (-1 = transparent). Voir resources/xinput-proxy/proxy.c.
# NB : ce mécanisme est PROPRE À WINDOWS. Sous Linux il n'existe pas d'XInput ni de slots :
# voir backends/linux.py, qui règle le même problème en prenant la manette physique en
# exclusivité (EVIOCGRAB) au lieu de détourner une DLL.
_PROXY_CFG = os.path.join(
    os.environ.get("LOCALAPPDATA", os.path.expanduser(r"~\AppData\Local")),
    "HoulaConnect", "xinput_proxy.cfg",
)


def _write_proxy_config(virtual_index, target_exe=None):
    """Écrit, pour la DLL proxy : l'index réel de la virtuelle (ou -1 = transparent) puis,
    en 2e ligne, le NOM DE L'EXE DU JEU visé par le pack actif.

    Le nom du jeu est essentiel : la DLL ne remappe QUE si elle tourne dans CE jeu. Plusieurs
    jeux peuvent donc avoir la DLL posée sans jamais se gêner, et un jeu sans pack actif reste
    un simple passe-plat (aucun verrou pour le joueur).
    Best-effort : jamais bloquant, jamais fatal (le proxy peut ne pas être posé)."""
    try:
        os.makedirs(os.path.dirname(_PROXY_CFG), exist_ok=True)
        idx = virtual_index if virtual_index is not None else -1
        name = os.path.basename(str(target_exe)) if target_exe else ""
        with open(_PROXY_CFG, "w") as f:
            f.write("%d\n%s\n" % (idx, name))
    except Exception:  # noqa: BLE001
        pass


# ── Passthrough : physique recopiée dans la virtuelle + overlays cadeaux ──
# ⚠️ Ces sept noms étaient les SEPT GLOBALES au singulier qui interdisaient tout
# multi-joueur. Elles vivent désormais dans `_Joueur`. On garde ici des vues du
# JOUEUR 1 uniquement, pour que le reste du fichier (proxy, nettoyage) continue
# de lire ce qu'il lisait. Toute nouvelle logique doit passer par `_Joueur`.
_pt_lock = threading.Lock()   # conservé : verrou de secours pour le joueur 1


def _joueur1():
    """Le joueur 1 s'il existe DÉJÀ. N'en crée jamais : le simple fait de créer
    une manette occupe un emplacement XInput, ce qu'un chemin de lecture ne doit
    jamais provoquer."""
    return _joueurs.get(1)


def _user_index_officiel(pad):
    """Emplacement XInput du pad, demandé au PILOTE plutôt que deviné.

    `vigem_target_x360_get_user_index` est documentée « compatible to the
    dwUserIndex property of the XInput* APIs ». Vérifiée sur cette machine le
    2026-09-08, contre-épreuve à l'appui : deux pads créés alors que les
    emplacements [0,1] étaient pris par des manettes physiques ont répondu 2 et
    3, exactement les emplacements que XInput venait de voir s'occuper, avec le
    code de retour 0x20000000 (succès).

    C'est ce qui remplace la sonde par signature ci-dessous, laquelle ne passe
    PAS à N manettes : sondées ensemble, elles afficheraient toutes le même
    motif et seraient indiscernables.

    Ne vaut QUE pour une manette Xbox 360 : une DS4 n'occupe aucun emplacement
    XInput, donc la question n'a pas de sens pour elle."""
    try:
        from vgamepad.win import vigem_client as vc
        idx = ctypes.c_ulong(0xFFFF)
        err = vc.vigem_target_x360_get_user_index(
            pad._busp, pad._devicep, ctypes.byref(idx),
        )
        # On ne se contente PAS du code de retour : on exige aussi un index
        # dans la plage réelle. Un pilote plus ancien pourrait rendre « succès »
        # avec une valeur non renseignée, et remapper le proxy sur un
        # emplacement inexistant couperait la manette du joueur.
        if err == 0x20000000 and idx.value < 4:
            return int(idx.value)
    except Exception:  # noqa: BLE001
        pass
    return None


def _identify_virtual_index(pad, vg):
    """Index XInput RÉEL de notre pad virtuel.

    On demande d'abord au pilote (API officielle). La sonde par signature
    ci-dessous reste le repli : elle a tourné en production et couvre le cas où
    l'API n'est pas disponible.

    ⚠️ `pad.get_index()` renvoie l'ordre ViGEm (ordre de branchement au bus), qui n'est
    PAS l'index utilisateur XInput assigné par Windows. Se fier à `get_index()-1` fait lire
    la MAUVAISE manette (bug réel : la physique n'était jamais recopiée). On imprime donc une
    SIGNATURE inédite (LB+RB + 2 gâchettes à fond) sur le pad virtuel et on regarde quel slot
    XInput la reflète : ce slot EST le nôtre. Combo volontairement improbable au repos d'une
    vraie manette -> quasi zéro faux positif. Sonde ~50 ms puis on relâche."""
    officiel = _user_index_officiel(pad)
    if officiel is not None:
        return officiel
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


class _JOYINFOEX(ctypes.Structure):
    _fields_ = [
        ("dwSize", ctypes.c_uint), ("dwFlags", ctypes.c_uint),
        ("dwXpos", ctypes.c_uint), ("dwYpos", ctypes.c_uint),
        ("dwZpos", ctypes.c_uint), ("dwRpos", ctypes.c_uint),
        ("dwUpos", ctypes.c_uint), ("dwVpos", ctypes.c_uint),
        ("dwButtons", ctypes.c_uint), ("dwButtonNumber", ctypes.c_uint),
        ("dwPOV", ctypes.c_uint), ("dwReserved1", ctypes.c_uint),
        ("dwReserved2", ctypes.c_uint),
    ]


def _compte_peripheriques_jeu():
    """Nombre de périphériques de jeu VUS PAR WINDOWS (API winmm).

    C'est la même liste que lisent DirectInput et SDL, donc les émulateurs. On
    l'interroge parce qu'une manette DualShock 4 virtuelle n'occupe AUCUN
    emplacement XInput : compter les emplacements XInput ne la verrait jamais."""
    try:
        winmm = ctypes.windll.winmm
        n = 0
        for i in range(winmm.joyGetNumDevs()):
            info = _JOYINFOEX()
            info.dwSize = ctypes.sizeof(_JOYINFOEX)
            info.dwFlags = 0x000000FF  # JOY_RETURNALL
            if winmm.joyGetPosEx(i, ctypes.byref(info)) == 0:
                n += 1
        return n
    except Exception:  # noqa: BLE001
        return 0


def _attendre_peripheriques(cible, timeout_s):
    """Attend que Windows ait publié `cible` périphériques de jeu.

    Rend le compte réellement atteint : l'appelant peut donc DIRE qu'il en
    manque, au lieu de laisser croire que tout est prêt."""
    fin = time.time() + timeout_s
    vu = _compte_peripheriques_jeu()
    while vu < cible and time.time() < fin:
        time.sleep(0.15)
        vu = _compte_peripheriques_jeu()
    return vu


def _attendre_disparition(cible, timeout_s):
    """Attend que le nombre de périphériques de jeu soit redescendu à `cible`."""
    fin = time.time() + timeout_s
    vu = _compte_peripheriques_jeu()
    while vu > cible and time.time() < fin:
        time.sleep(0.15)
        vu = _compte_peripheriques_jeu()
    return vu


def _index_virtuels_occupes():
    """Emplacements XInput tenus par NOS manettes virtuelles, tous joueurs
    confondus. À N joueurs, ignorer seulement « la nôtre » ne suffit plus : le
    passthrough du joueur 1 recopierait la manette virtuelle du joueur 2."""
    return {j.virtual_index for j in _joueurs.values() if j.virtual_index is not None}


def _find_physical_index(j):
    """Index XInput de la manette PHYSIQUE du joueur : la 1re manette connectée
    qui n'est aucune des nôtres, ni déjà attribuée à un autre joueur."""
    prises = _index_virtuels_occupes()
    prises.update(
        a.pt_index for a in _joueurs.values() if a is not j and a.pt_index is not None
    )
    for i in range(4):
        if i in prises:
            continue
        if _xinput_read(i) is not None:
            return i
    return None


def _passthrough_loop(j, vg):
    """~125 Hz : état virtuel = physique (si présente) + overlays des cadeaux.
    RE-DÉTECTE la manette physique en continu : une manette Xbox sans fil DORT au repos
    (disparaît de XInput) et se réveille au 1er appui ; un branchement à chaud arrive aussi.
    Sans re-scan, une physique absente au démarrage ne serait JAMAIS reprise."""
    pad = j.pad
    miss = 0
    ticks = 0
    while j.running:
        try:
            if j.pt_index is None and ticks % 30 == 0:  # ~0.25 s : cherche une physique (réveil/hot-plug)
                j.pt_index = _find_physical_index(j)
            ticks += 1
            gp = _xinput_read(j.pt_index) if j.pt_index is not None else None
            if j.pt_index is not None and gp is None:
                miss += 1
                if miss > 60:  # ~0.5 s sans réponse -> débranchée/endormie : on re-détecte
                    j.pt_index = None
                    miss = 0
            else:
                miss = 0
            # `reset()` remet aussi la croix DS4 au neutre : on repart d'un état
            # propre à chaque image et on ré-applique tout ce qui est tenu.
            pad.reset()
            j.dpad.clear()
            lt = gp.bLeftTrigger if gp else 0
            rt = gp.bRightTrigger if gp else 0
            if gp:
                for mask, tok in _XI_BUTTONS:
                    if gp.wButtons & mask:
                        _appliquer_token(j, vg, tok, True)
            with j.lock:
                ob = list(j.ov_buttons)
                oa = dict(j.ov_analog) if j.ov_analog is not None else None
            for tok in ob:
                if tok in _TRIGGERS:
                    if tok == "LT":
                        lt = 255
                    else:
                        rt = 255
                elif _token_connu(tok):
                    _appliquer_token(j, vg, tok, True)
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
    """Démarre/arrête le mode « une seule manette » (mirroring physique -> virtuelle).

    `player` (1 par défaut) désigne le joueur : chacun recopie SA manette
    physique dans SA manette virtuelle, et reçoit SES cadeaux."""
    j = _get_joueur(_num_joueur(args))
    pad, vg = j.pad, _vg
    if bool(args.get("enable")):
        # Emplacement XInput : demandé au pilote, sinon deviné par signature.
        # Sans objet pour une DS4, qui n'en occupe aucun.
        j.virtual_index = _identify_virtual_index(pad, vg) if j.kind == TYPE_X360 else None
        j.pt_index = _find_physical_index(j)  # (re)détecte la physique (branchement à chaud)
        if not j.running:
            j.running = True
            j.thread = threading.Thread(target=_passthrough_loop, args=(j, vg), daemon=True)
            j.thread.start()
        # Dit à la DLL proxy (posée dans le dossier du jeu) de faire lire la VIRTUELLE comme
        # Joueur 1 (index 0 du jeu -> index réel de la virtuelle), UNIQUEMENT dans le jeu visé
        # par ce pack (targetExe). Le jeu voit ainsi la physique recopiée + les cadeaux, et
        # aucun autre jeu n'est affecté. Best-effort : si le proxy n'est pas posé, sans effet.
        # Seul le JOUEUR 1 pilote la DLL proxy : elle fait passer UNE manette pour
        # celle du jeu (index 0). Laisser un autre joueur l'écraser reviendrait à
        # voler la place du joueur 1 au milieu d'une partie.
        if j.num == 1:
            # Dit à la DLL proxy (posée dans le dossier du jeu) de faire lire la VIRTUELLE comme
            # Joueur 1 (index 0 du jeu -> index réel de la virtuelle), UNIQUEMENT dans le jeu visé
            # par ce pack (targetExe). Le jeu voit ainsi la physique recopiée + les cadeaux, et
            # aucun autre jeu n'est affecté. Best-effort : si le proxy n'est pas posé, sans effet.
            _write_proxy_config(j.virtual_index, args.get("targetExe"))
        return {
            "passthrough": True,
            "player": j.num,
            "kind": j.kind,
            "physicalIndex": j.pt_index,
            "virtualIndex": j.virtual_index,
        }
    # Désactivation : on vide les overlays PUIS on DÉBRANCHE le pad virtuel. Le débrancher est
    # essentiel : un pad qui reste occupe un emplacement XInput, et s'il tient le 0 le jeu lit
    # une manette inerte -> « ma manette ne marche plus ». Proxy remis transparent au passage.
    j.running = False
    with j.lock:
        j.ov_buttons.clear()
        j.ov_analog = None
    _release_pad(j.num)
    return {"passthrough": False, "player": j.num}


# ── Exécution des effets manette (direct HORS passthrough, overlay PENDANT) ──
def _set_tokens(j, vg, tokens, down):
    """Direct (hors passthrough) : presse/relâche un CHORD sur le pad virtuel.
    Tous les tokens sont VALIDÉS avant toute mutation (un token inconnu au milieu
    ne doit pas laisser un bit à moitié pressé)."""
    norm = [str(t).upper() for t in tokens]
    for t in norm:
        if not _token_connu(t):
            raise ValueError(f"bouton inconnu: {t}")
    for t in norm:
        _appliquer_token(j, vg, t, down)
    j.pad.update()


def _fire_tokens(j, vg, tokens, hold_ms):
    if not tokens:
        return
    norm = [str(t).upper() for t in tokens]
    for t in norm:  # valide dans les DEUX modes (rejette un token inconnu)
        if not _token_connu(t):
            raise ValueError(f"bouton inconnu: {t}")
    hold = _clamp_ms(hold_ms, 10000) / 1000.0
    if j.running:
        # PASSTHROUGH : on superpose ces tokens à la physique (le loop les applique),
        # on les tient hold_ms, puis on les retire. On ne touche PAS le pad directement.
        with j.lock:
            j.ov_buttons.update(norm)
        time.sleep(hold)
        with j.lock:
            j.ov_buttons.difference_update(norm)
    else:
        _set_tokens(j, vg, norm, True)
        time.sleep(hold)
        _set_tokens(j, vg, norm, False)


def helper_vigem_gamepad(args):
    # `player` absent -> joueur 1, donc tout appel écrit avant le multi-joueur
    # vise exactement la même manette qu'avant.
    j = _get_joueur(_num_joueur(args))  # importe vgamepad de façon TAGGÉE (VIGEMBUS_MISSING si pilote absent)
    pad, vg = j.pad, _vg
    if args.get("release"):
        if not j.running:
            _reset_joueur(j)
        else:  # en passthrough, « release » = vider les overlays, garder le mirroring
            with j.lock:
                j.ov_buttons.clear()
                j.ov_analog = None
        return {"released": True, "player": j.num}

    # Toute erreur en cours de route doit RELÂCHER les overlays / le pad (pas de touche coincée).
    try:
        # 1) Timeline d'ÉTAPES : [{buttons:[...],holdMs} | {waitMs}].
        steps = args.get("steps")
        if isinstance(steps, list) and steps:
            for st in steps:
                toks = st.get("buttons") or ([st["button"]] if st.get("button") else [])
                if toks:
                    _fire_tokens(j, vg, toks, st.get("holdMs", 120))
                wait = st.get("waitMs")
                if wait is not None:
                    time.sleep(_clamp_ms(wait, 30000) / 1000.0)
            if not j.running:
                _reset_joueur(j)
            return {"steps": len(steps), "player": j.num}

        # 2) ANALOGIQUE : pousser stick(s)/gâchette(s), tenir, relâcher.
        analog = args.get("analog")
        if isinstance(analog, dict):
            hold = _clamp_ms(args.get("holdMs", 300), 10000) / 1000.0
            if j.running:
                a = {"lx": _clamp_axis(analog.get("lx", 0)), "ly": _clamp_axis(analog.get("ly", 0)),
                     "rx": _clamp_axis(analog.get("rx", 0)), "ry": _clamp_axis(analog.get("ry", 0))}
                trg = set()
                if analog.get("lt"):
                    trg.add("LT")
                if analog.get("rt"):
                    trg.add("RT")
                with j.lock:
                    j.ov_analog = a
                    j.ov_buttons.update(trg)
                time.sleep(hold)
                with j.lock:
                    j.ov_analog = None
                    j.ov_buttons.difference_update(trg)
                return {"analog": True, "player": j.num}
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
            _reset_joueur(j)
            return {"analog": True, "player": j.num}

        # 3) CHORD ou bouton simple.
        tokens = args.get("buttons")
        if not tokens:
            b = str(args.get("button", "")).upper()
            tokens = [b] if b else []
        if not tokens:
            raise ValueError("aucune touche à presser")
        _fire_tokens(j, vg, tokens, args.get("holdMs", 120))
        return {"pressed": tokens, "player": j.num}
    except Exception:
        try:
            with j.lock:
                j.ov_buttons.clear()
                j.ov_analog = None
            if not j.running:
                _reset_joueur(j)
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
    # Filet de sécurité : proxy transparent (le jeu relit la manette normalement) même si le
    # sidecar s'arrête en cours de pack.
    try:
        _write_proxy_config(-1)
    except Exception:  # noqa: BLE001
        pass
    # TOUS les joueurs, pas seulement le premier : une seule cible oubliée suffit
    # à laisser un « Contrôleur XBOX 360 » fantôme, et elles finissent par coincer
    # le bus jusqu'au redémarrage de la machine.
    for num in list(_joueurs.keys()):
        _release_pad(num)


atexit.register(_cleanup_pad)


def helper_shutdown(args):
    """Arrêt GRACIEUX demandé par l'app : débranche la manette AVANT que l'app ne ferme
    stdin / ne tue le process (sinon la cible ViGEm fuit en zombie)."""
    _cleanup_pad()
    return {"shutdown": True}


def _release_pad(num=1):
    """DÉBRANCHE la manette virtuelle sans arrêter le sidecar.

    ⚠️ CRUCIAL : tant qu'un pad virtuel existe, il OCCUPE un emplacement XInput. S'il prend
    l'emplacement 0 (celui que les jeux lisent), le jeu lit une manette qui ne bouge pas et
    la manette du joueur semble « ne plus marcher ». Un simple TEST ne doit donc jamais
    laisser de pad derrière lui : on le relâche dès qu'aucun pack ne tourne.

    `num=None` relâche TOUS les joueurs."""
    global _pad
    if num is None:
        for n in list(_joueurs.keys()):
            _release_pad(n)
        return

    j = _joueurs.pop(num, None)
    if num == 1:
        _pad = None
        # Le proxy ne suit QUE le joueur 1 : c'est aussi le seul dont le
        # débranchement doit rendre la manette du jeu au joueur.
        _write_proxy_config(-1)
    if j is None:
        return
    j.running = False
    t = j.thread
    if t is not None and t.is_alive():
        # On attend la fin de la boucle AVANT de retirer la cible : elle écrit
        # sur le pad toutes les 8 ms, et le libérer sous ses pieds provoquerait
        # une écriture sur un objet détruit.
        t.join(timeout=0.5)
    p = j.pad
    try:
        p.reset(); p.update()
    except Exception:  # noqa: BLE001
        pass
    # RETRAIT EXPLICITE de la cible, avant toute histoire de ramasse-miettes.
    # `VGamepad.__del__` appelle bien `vigem_target_remove` (vérifié dans le
    # paquet installé), mais il ne tourne QUE si plus personne ne référence
    # l'objet. Il suffit qu'un appelant, un thread ou une trace d'exception en
    # garde une pour que la manette reste branchée : c'est exactement le mode de
    # panne décrit plus haut, celui qui finit par coincer le bus ViGEm jusqu'au
    # redémarrage. On ne PARIE donc pas sur le refcount, on demande le retrait.
    try:
        from vgamepad.win import vigem_client as _vc
        _vc.vigem_target_remove(p._busp, p._devicep)
    except Exception:  # noqa: BLE001
        pass
    try:
        del p
        del j
        gc.collect()  # libère aussi la structure côté vgamepad
    except Exception:  # noqa: BLE001
        pass


def helper_release_pad(args):
    """Appelé par l'app après un test manette hors pack : libère l'emplacement XInput.

    Sans `player`, relâche TOUT : c'est le sens attendu d'un « arrête tout »
    (panique, arrêt du moteur), et c'était déjà le comportement quand il n'y
    avait qu'une manette."""
    if "player" in args and args.get("player") is not None:
        _release_pad(_num_joueur(args))
        return {"released": True, "player": _num_joueur(args)}
    cible = max(0, _compte_peripheriques_jeu() - len(_joueurs))
    _release_pad(None)
    # Le RETRAIT aussi est asynchrone : Windows dépublie le périphérique après
    # coup. Sans cette attente, un « arrête tout » rendrait la main alors que
    # les manettes sont encore visibles du jeu, et la manette du joueur
    # semblerait toujours détournée.
    _attendre_disparition(cible, 4.0)
    return {"released": True}


def helper_vigem_pads(args):
    """Déclare / inventorie les manettes virtuelles, une par joueur.

    args:
      count : nombre de joueurs voulus (1..8). Absent -> simple inventaire.
      kind  : 'x360' ou 'ds4' pour les joueurs 2 et suivants.

    🚨 Au-delà de DEUX joueurs, le type DOIT être 'ds4'. Mesuré : Windows n'a que
    quatre emplacements XInput, partagés avec les manettes physiques, donc les
    manettes Xbox 360 virtuelles saturent immédiatement et les suivantes sont
    acceptées par ViGEm tout en restant INVISIBLES au jeu. On refuse plutôt que
    de créer des manettes fantômes : un échec silencieux ressemblerait ici à une
    réussite, et le diffuseur chercherait le bug dans son pack."""
    global _type_par_defaut
    kind = str(args.get("kind") or "").lower() or None
    if kind not in (None, TYPE_X360, TYPE_DS4):
        raise ValueError("kind doit valoir 'x360' ou 'ds4'")

    count = args.get("count")
    if count is not None:
        try:
            n = int(count)
        except (TypeError, ValueError):
            raise ValueError("count invalide")
        n = max(1, min(MAX_JOUEURS, n))
        if n > 2 and (kind or _type_par_defaut) != TYPE_DS4:
            raise ValueError(
                "XINPUT_SLOTS_EXHAUSTED: au-dela de 2 joueurs il faut kind='ds4' "
                "(Windows n'a que 4 emplacements XInput, partages avec les manettes physiques)",
            )
        if kind:
            _type_par_defaut = kind
        # On crée en montant, et on relâche ce qui dépasse.
        avant = _compte_peripheriques_jeu()
        crees = 0
        for num in range(1, n + 1):
            if num not in _joueurs:
                crees += 1
            _get_joueur(num, kind)
        for num in [x for x in _joueurs if x > n]:
            _release_pad(num)
        # ⚠️ ATTENDRE l'ÉNUMÉRATION. Une manette virtuelle existe côté ViGEm bien
        # avant que Windows ne l'ait publiée comme périphérique de jeu : mesuré à
        # ~3 s par DualShock 4. Rendre la main tout de suite ferait annoncer
        # « 4 manettes prêtes » alors que le jeu n'en voit encore que 2, et le
        # diffuseur chercherait le bug dans son pack.
        if crees:
            _attendre_peripheriques(avant + crees, 6.0)

    pads = []
    for num in sorted(_joueurs):
        j = _joueurs[num]
        pads.append({
            "player": num,
            "kind": j.kind,
            # L'emplacement XInput n'existe que pour une Xbox 360. Pour une DS4
            # c'est `null`, et c'est la bonne réponse : elle n'en occupe aucun.
            "xinputIndex": _user_index_officiel(j.pad) if j.kind == TYPE_X360 else None,
            "passthrough": bool(j.running),
            "physicalIndex": j.pt_index,
        })
    # `devices` dit combien de périphériques de jeu Windows publie RÉELLEMENT.
    # L'app doit pouvoir constater un écart avec le nombre de manettes déclarées
    # plutôt que de l'apprendre par un cadeau qui n'arrive nulle part.
    return {
        "pads": pads,
        "max": MAX_JOUEURS,
        "defaultKind": _type_par_defaut,
        "devices": _compte_peripheriques_jeu(),
    }


def helper_foreground(args):
    """Chemin de l'exe de la fenêtre au PREMIER PLAN (pour le focus-guard de l'app : ne
    déclencher les effets manette/clavier que si le JEU cible est actif). Windows only."""
    try:
        u = ctypes.windll.user32
        k = ctypes.windll.kernel32
        u.GetForegroundWindow.restype = ctypes.c_void_p
        k.OpenProcess.restype = ctypes.c_void_p
        k.OpenProcess.argtypes = [ctypes.c_uint, ctypes.c_int, ctypes.c_uint]
        hwnd = u.GetForegroundWindow()
        if not hwnd:
            return {"exe": None}
        pid = ctypes.c_uint(0)
        u.GetWindowThreadProcessId(ctypes.c_void_p(hwnd), ctypes.byref(pid))
        if not pid.value:
            return {"exe": None}
        h = k.OpenProcess(0x1000, False, pid.value)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not h:
            return {"exe": None}
        try:
            buf = ctypes.create_unicode_buffer(1024)
            size = ctypes.c_uint(1024)
            if k.QueryFullProcessImageNameW(ctypes.c_void_p(h), 0, buf, ctypes.byref(size)):
                return {"exe": buf.value}
        finally:
            k.CloseHandle(ctypes.c_void_p(h))
    except Exception:  # noqa: BLE001
        pass
    return {"exe": None}


# ── capabilities : ce que CETTE machine Windows sait vraiment faire ───────────
def helper_capabilities(args):
    """Inventaire honnête des capacités, pour que l'app n'affiche que ce qui marche.

    Deux modes, parce qu'un vrai test a un coût :
      - défaut (probe absent/false) : on regarde seulement si les MODULES sont là
        (importlib.util.find_spec, aucun effet de bord). On n'importe PAS vgamepad :
        son import ouvre une connexion au bus ViGEmBus, et le faire au démarrage de
        l'app changerait le comportement d'un chemin en production. La présence du
        pilote NOYAU reste donc « probable », pas prouvée.
      - probe=true : on fait le vrai test (création de la manette virtuelle, puis
        DÉBRANCHEMENT immédiat via _release_pad). C'est exactement ce que fait déjà le
        bouton « tester » de l'app, donc rien de nouveau côté effets de bord.
    Dans les deux cas `reason` est rempli et lisible : jamais de chaîne vide."""
    probe = bool(args.get("probe"))
    kb_mod = importlib.util.find_spec("interception") is not None
    pad_mod = importlib.util.find_spec("vgamepad") is not None
    keyboard, gamepad = kb_mod, pad_mod
    notes = []
    if not kb_mod:
        notes.append("Le module interception-python est absent du sidecar : les interactions Clavier ne partiront pas.")
    if not pad_mod:
        notes.append("Le module vgamepad est absent du sidecar : les interactions Manette ne partiront pas.")
    if probe and pad_mod:
        try:
            _get_gamepad()
            _release_pad(None)  # ne JAMAIS laisser un pad derrière un simple test : il squatterait un slot XInput
            notes.append("Manette virtuelle créée puis débranchée : le pilote ViGEmBus répond.")
        except Exception as e:  # noqa: BLE001
            gamepad = False
            notes.append(str(e))
    elif pad_mod:
        notes.append("Pilote ViGEmBus non testé (probe=false) : un pilote absent se signalera par VIGEMBUS_MISSING au premier effet manette.")
    if keyboard and gamepad and not notes:
        notes.append("Clavier (Interception) et manette (ViGEmBus) disponibles.")
    return {
        "platform": PLATFORM,
        "keyboard": keyboard,
        "gamepad": gamepad,
        "reason": " ".join(notes),
        "keyboardBackend": "interception",
        "gamepadBackend": "vigem",
        "probed": probe,
    }


# ── Interface commune attendue par backends/__init__.py ───────────────────────
# Alias de noms uniquement : le corps des helpers Windows reste celui qui tourne en
# production. Ne rien réécrire ici sans preuve sur une vraie machine Windows.
capabilities = helper_capabilities
keys = helper_interception_keys
gamepad = helper_vigem_gamepad
passthrough = helper_vigem_passthrough
pads = helper_vigem_pads
release_pad = helper_release_pad
foreground = helper_foreground
shutdown = helper_shutdown
