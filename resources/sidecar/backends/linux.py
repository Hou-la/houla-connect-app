#!/usr/bin/env python3
"""Backend LINUX du sidecar : manette virtuelle ET clavier bas niveau via `uinput`.

POURQUOI uinput POUR LES DEUX. Sous Windows il faut deux pilotes tiers (Interception
pour le clavier, ViGEmBus pour la manette). Sous Linux, le noyau expose déjà les deux
par le MÊME sous-système : /dev/uinput crée un périphérique d'entrée dont les
événements remontent par le chemin normal du noyau. Un jeu ne peut pas distinguer ces
événements de ceux d'un vrai clavier ou d'une vraie manette : c'est l'équivalent exact
d'Interception, sans rien installer.

POURQUOI python-evdev ET PAS python-uinput. Les deux savent CRÉER un périphérique,
mais un seul sait aussi le LIRE, et le passthrough (recopier la manette physique du
joueur dans la virtuelle) a besoin des deux sens.
  - python-uinput (0.11.2) : extension C autour de libsuinput, plus publiée depuis
    2016, sans roue précompilée (il faut un compilateur et les en-têtes libudev), et
    strictement en ÉCRITURE : aucune API pour énumérer ou lire un périphérique
    existant. Il aurait fallu lui adjoindre une seconde bibliothèque pour la lecture.
  - python-evdev : maintenu, roues manylinux publiées, et une seule dépendance couvre
    `UInput` (création + injection), `list_devices`/`InputDevice` (énumération et
    lecture d'état) et `grab()` (exclusivité). C'est celui-là.

DIFFÉRENCE STRUCTURELLE AVEC WINDOWS, à ne pas perdre de vue : il n'y a PAS d'XInput
sous Linux, donc PAS de « slot 0 », PAS de notion de Joueur 1, et PAS de DLL proxy à
poser dans le dossier du jeu. Les jeux énumèrent les périphériques evdev (via SDL le
plus souvent) et une manette uinput y apparaît comme une vraie manette. Tout le
mécanisme `xinput_proxy.cfg` de backends/win32.py n'a donc aucun équivalent ici et
n'est pas porté. Le problème que ce proxy réglait (« le jeu lit la manette PHYSIQUE,
pas la virtuelle, donc les cadeaux n'arrivent jamais ») existe quand même sous Linux,
et se règle autrement : pendant le passthrough on prend la manette physique en
EXCLUSIVITÉ avec EVIOCGRAB (`dev.grab()`). Le noyau cesse alors de livrer ses
événements à tout autre client, y compris au jeu, qui ne voit plus que la virtuelle.

IDENTITÉ DE LA MANETTE VIRTUELLE. On se présente comme une Xbox 360 filaire
(vendor 0x045e, product 0x028e, nom « Microsoft X-Box 360 pad », axes et boutons du
pilote xpad). Ce n'est pas cosmétique : SDL choisit son mapping manette d'après le
couple vendor/product (sa base intégrée contient déjà cette manette). S'en écarter
obligerait chaque joueur à configurer les boutons à la main dans chaque jeu.

Dépendance (voir requirements.txt) : evdev ; sys_platform == "linux".
"""
import os
import json
import time
import getpass
import threading
import atexit
import subprocess

from .common import clamp_ms as _clamp_ms, clamp_axis as _clamp_axis, parse_key_spec

PLATFORM = "linux"

UINPUT_DEV = "/dev/uinput"

# Messages de friction. Ils sont RENVOYÉS TELS QUELS à l'app, donc ils doivent tenir
# debout seuls : dire ce qui manque, et donner la commande exacte. Pas de couleur, pas
# d'icône : le propriétaire est daltonien, l'information est dans le TEXTE.
ERR_EVDEV_MISSING = (
    "EVDEV_MISSING: le module Python 'evdev' est introuvable dans le sidecar. "
    "Installe-le : pip install -r requirements.txt (paquet 'evdev')."
)
ERR_UINPUT_MISSING = (
    "UINPUT_MISSING: " + UINPUT_DEV + " est absent : le module noyau 'uinput' n'est pas chargé.\n"
    "  sudo modprobe uinput\n"
    "Pour qu'il se charge à chaque démarrage :\n"
    "  echo uinput | sudo tee /etc/modules-load.d/uinput.conf"
)


def _err_uinput_denied():
    """Message de refus d'accès, construit à l'appel pour nommer l'utilisateur réel.

    La règle udev ci-dessous est la convention usuelle (celle que documentent kmonad,
    ydotool et les autres outils uinput). `static_node=uinput` est indispensable : sans
    lui, la règle ne s'applique qu'au moment où le module est chargé, et le nœud créé
    plus tard repart en root-only."""
    try:
        who = getpass.getuser()
    except Exception:  # noqa: BLE001
        who = "ton compte"
    return (
        "UINPUT_PERMISSION_DENIED: " + UINPUT_DEV + " existe mais n'est pas ouvrable en écriture "
        "par l'utilisateur '" + who + "'. Pose la règle udev, puis rejoins le groupe 'input' :\n"
        "  echo 'KERNEL==\"uinput\", GROUP=\"input\", MODE=\"0660\", OPTIONS+=\"static_node=uinput\"' "
        "| sudo tee /etc/udev/rules.d/99-houla-uinput.rules\n"
        "  sudo udevadm control --reload-rules && sudo udevadm trigger\n"
        "  sudo usermod -aG input " + who + "\n"
        "Ferme ensuite ta session et rouvre-la : un changement de groupe ne prend effet "
        "qu'à la connexion suivante."
    )


# ── Chargement paresseux d'evdev + diagnostic PRÉCIS de /dev/uinput ───────────
_ev = None      # module evdev
_ec = None      # evdev.ecodes


def _get_evdev():
    """Importe evdev à la PREMIÈRE utilisation, et jamais au démarrage du sidecar :
    `capabilities` doit pouvoir répondre même sans evdev installé."""
    global _ev, _ec
    if _ev is None:
        try:
            import evdev  # python-evdev
        except ImportError as e:  # noqa: BLE001
            raise RuntimeError(ERR_EVDEV_MISSING + " (" + str(e) + ")")
        _ev = evdev
        _ec = evdev.ecodes
    return _ev


def _check_uinput():
    """Vérifie /dev/uinput AVANT de laisser evdev échouer, pour distinguer les deux
    pannes que l'utilisateur doit traiter différemment : nœud absent (module noyau non
    chargé) contre nœud présent mais interdit (droits). evdev, lui, lève un UInputError
    dont le texte ne dit pas quoi faire."""
    if not os.path.exists(UINPUT_DEV):
        raise RuntimeError(ERR_UINPUT_MISSING)
    if not os.access(UINPUT_DEV, os.W_OK):
        raise RuntimeError(_err_uinput_denied())


# ── Table des touches : noms canoniques -> KEY_* du noyau ────────────────────
# Les noms acceptés sont ceux d'interception-python (le vocabulaire des bundles déjà
# publiés). Un bundle écrit pour Windows doit marcher ici SANS ÊTRE RETOUCHÉ.
# ⚠️ ',' et '+' ne sont pas atteignables : ils séparent les étapes et les accords dans
# une key-spec. C'était déjà le cas sous Windows, ce n'est donc pas une régression.
_KEY_ALIASES = {
    "backspace": "KEY_BACKSPACE", "tab": "KEY_TAB", "enter": "KEY_ENTER", "return": "KEY_ENTER",
    "esc": "KEY_ESC", "escape": "KEY_ESC", "space": "KEY_SPACE",
    "shift": "KEY_LEFTSHIFT", "shiftleft": "KEY_LEFTSHIFT", "shiftright": "KEY_RIGHTSHIFT",
    "ctrl": "KEY_LEFTCTRL", "ctrlleft": "KEY_LEFTCTRL", "ctrlright": "KEY_RIGHTCTRL",
    "alt": "KEY_LEFTALT", "altleft": "KEY_LEFTALT", "altright": "KEY_RIGHTALT",
    "win": "KEY_LEFTMETA", "winleft": "KEY_LEFTMETA", "winright": "KEY_RIGHTMETA",
    "super": "KEY_LEFTMETA", "apps": "KEY_COMPOSE",
    # Vocabulaire « macOS » qu'interception-python accepte aussi : un pack peut l'employer,
    # il doit donc marcher ici. Commande devient la touche Logo, Option devient Alt.
    "command": "KEY_LEFTMETA", "commandleft": "KEY_LEFTMETA", "commandright": "KEY_RIGHTMETA",
    "option": "KEY_LEFTALT", "optionleft": "KEY_LEFTALT", "optionright": "KEY_RIGHTALT",
    "capslock": "KEY_CAPSLOCK", "numlock": "KEY_NUMLOCK", "scrolllock": "KEY_SCROLLLOCK",
    "pause": "KEY_PAUSE", "insert": "KEY_INSERT", "del": "KEY_DELETE", "delete": "KEY_DELETE",
    "home": "KEY_HOME", "end": "KEY_END",
    "pgup": "KEY_PAGEUP", "pageup": "KEY_PAGEUP", "pgdn": "KEY_PAGEDOWN", "pagedown": "KEY_PAGEDOWN",
    "left": "KEY_LEFT", "right": "KEY_RIGHT", "up": "KEY_UP", "down": "KEY_DOWN",
    "print": "KEY_SYSRQ", "prtsc": "KEY_SYSRQ", "prtscr": "KEY_SYSRQ",
    "prntscrn": "KEY_SYSRQ", "printscreen": "KEY_SYSRQ",
    "-": "KEY_MINUS", "=": "KEY_EQUAL", "[": "KEY_LEFTBRACE", "]": "KEY_RIGHTBRACE",
    "\\": "KEY_BACKSLASH", ";": "KEY_SEMICOLON", "'": "KEY_APOSTROPHE",
    ",": "KEY_COMMA", ".": "KEY_DOT", "/": "KEY_SLASH", "`": "KEY_GRAVE",
    "multiply": "KEY_KPASTERISK", "add": "KEY_KPPLUS", "subtract": "KEY_KPMINUS",
    "decimal": "KEY_KPDOT", "divide": "KEY_KPSLASH",
    # Touches multimédia : interception-python les accepte sous Windows, le noyau Linux
    # a les mêmes. Les ajouter coûte une ligne et évite un « touche inconnue » sur un
    # pack qui baisserait le son.
    "volumemute": "KEY_MUTE", "volumedown": "KEY_VOLUMEDOWN", "volumeup": "KEY_VOLUMEUP",
    "nexttrack": "KEY_NEXTSONG", "prevtrack": "KEY_PREVIOUSSONG",
    "playpause": "KEY_PLAYPAUSE", "stop": "KEY_STOPCD",
    "launchmail": "KEY_MAIL", "browserback": "KEY_BACK", "browserforward": "KEY_FORWARD",
    "browserrefresh": "KEY_REFRESH", "browserstop": "KEY_STOP",
    "browsersearch": "KEY_SEARCH", "browserfavorites": "KEY_BOOKMARKS",
    "browserhome": "KEY_HOMEPAGE",
}

# Symboles qui n'ont pas de touche à eux sur un clavier ANSI : ils s'obtiennent avec
# Maj + une autre touche. interception-python le fait pour nous sous Windows ; ici il
# faut l'expliciter, sinon '!' serait refusé alors qu'il marche sous Windows.
# ⚠️ ',' ':' '+' '<' restent inatteignables dans une key-spec, où ils servent de
# séparateurs (étape, maintien, accord). C'était déjà vrai sous Windows.
_SHIFTED = {
    "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7",
    "*": "8", "(": "9", ")": "0", "_": "-", "+": "=", "{": "[", "}": "]",
    "|": "\\", ":": ";", '"': "'", "<": ",", ">": ".", "?": "/", "~": "`",
}
for _i in range(10):
    _KEY_ALIASES[str(_i)] = "KEY_%d" % _i
    _KEY_ALIASES["num%d" % _i] = "KEY_KP%d" % _i
for _c in "abcdefghijklmnopqrstuvwxyz":
    _KEY_ALIASES[_c] = "KEY_" + _c.upper()
for _i in range(1, 25):
    _KEY_ALIASES["f%d" % _i] = "KEY_F%d" % _i

_kb_codes = None   # mémoïsation des codes déclarés (le vocabulaire ne bouge pas)


def _all_key_codes():
    """Toutes les touches que le clavier virtuel doit DÉCLARER à sa création.

    Les capacités d'un périphérique uinput sont figées une fois pour toutes : une
    touche non déclarée à la création ne pourra JAMAIS être envoyée ensuite (le noyau
    jette l'événement en SILENCE, ce qui donnerait un pack « qui ne fait rien » sans la
    moindre erreur). On déclare donc tout le vocabulaire d'un coup."""
    global _kb_codes
    if _kb_codes is None:
        ec = _get_evdev().ecodes
        out = set()
        for ident in _KEY_ALIASES.values():
            code = ec.ecodes.get(ident)
            if code is not None:
                out.add(code)
        _kb_codes = out
    return sorted(_kb_codes)


def _resolve_key(name):
    """(code KEY_* du noyau, faut-il ajouter Maj ?), ou ValueError explicite.

    Le code doit appartenir aux capacités DÉCLARÉES par _all_key_codes(), sinon le
    noyau jetterait l'événement sans rien dire : on préfère une erreur nommant la
    touche fautive à un pack qui ne fait rien sans expliquer pourquoi."""
    ec = _get_evdev().ecodes
    shifted = name in _SHIFTED
    ident = _KEY_ALIASES.get(_SHIFTED[name] if shifted else name)
    code = ec.ecodes.get(ident) if ident else None
    _all_key_codes()   # garantit que _kb_codes est rempli
    if code is None or code not in _kb_codes:
        raise ValueError("touche inconnue: %s" % name)
    return code, shifted


# ── Manette virtuelle : tokens Hou.la -> événements evdev ────────────────────
# Correspondance avec le pilote xpad (manette Xbox 360 filaire), pour que SDL applique
# son mapping intégré. Attention aux noms du noyau : BTN_NORTH VAUT BTN_X (0x133) et
# BTN_WEST VAUT BTN_Y (0x134). Ce sont deux noms du MÊME code, pas deux boutons.
# Chaque token porte PLUSIEURS noms candidats, essayés dans l'ordre : les deux noms
# désignent le même code, mais selon la version des en-têtes du noyau contre lesquels
# python-evdev a été généré, l'un des deux peut manquer de sa table. Chercher un nom
# absent lèverait un KeyError au moment de créer la manette, c'est-à-dire au pire
# moment : en plein live, sur la machine d'un utilisateur. Le repli coûte une ligne.
_PAD_BTN = {
    "A": ("BTN_SOUTH", "BTN_A"), "B": ("BTN_EAST", "BTN_B"),
    "X": ("BTN_NORTH", "BTN_X"), "Y": ("BTN_WEST", "BTN_Y"),
    "LB": ("BTN_TL",), "RB": ("BTN_TR",),
    "BACK": ("BTN_SELECT",), "START": ("BTN_START",),
    "LS": ("BTN_THUMBL",), "RS": ("BTN_THUMBR",),
}


def _btn_code(tok):
    """Code noyau du bouton, par le premier nom candidat qui existe."""
    ec = _get_evdev().ecodes
    for name in _PAD_BTN[tok]:
        code = ec.ecodes.get(name)
        if code is not None:
            return code
    raise RuntimeError("UINPUT_PAD_FAILED: aucun code noyau pour le bouton %s (candidats %s)"
                       % (tok, ", ".join(_PAD_BTN[tok])))
# ⚠️ La croix directionnelle n'est PAS faite de boutons ici. xpad la rapporte en AXES
# (ABS_HAT0X/Y, valeurs -1/0/+1), contrairement à XInput où ce sont 4 bits. Émettre
# BTN_DPAD_* donnerait une manette que SDL ne reconnaîtrait plus comme une Xbox 360.
_PAD_HAT = {
    "UP": ("ABS_HAT0Y", -1), "DOWN": ("ABS_HAT0Y", 1),
    "LEFT": ("ABS_HAT0X", -1), "RIGHT": ("ABS_HAT0X", 1),
}
_PAD_TRIG = {"LT": "ABS_Z", "RT": "ABS_RZ"}

_STICK_MAX = 32767   # plage xpad des sticks : -32768..32767
_TRIG_MAX = 255      # plage xpad des gâchettes : 0..255

_ui_pad = None       # evdev.UInput de la manette virtuelle
_ui_kb = None        # evdev.UInput du clavier virtuel


def _pad_capabilities():
    """Capacités déclarées de la manette virtuelle, calquées sur xpad."""
    ev = _get_evdev()
    ec = ev.ecodes
    AbsInfo = ev.AbsInfo
    stick = AbsInfo(value=0, min=-32768, max=32767, fuzz=16, flat=128, resolution=0)
    trig = AbsInfo(value=0, min=0, max=255, fuzz=0, flat=0, resolution=0)
    hat = AbsInfo(value=0, min=-1, max=1, fuzz=0, flat=0, resolution=0)
    return {
        ec.EV_KEY: [_btn_code(t) for t in _PAD_BTN],
        ec.EV_ABS: [
            (ec.ABS_X, stick), (ec.ABS_Y, stick), (ec.ABS_RX, stick), (ec.ABS_RY, stick),
            (ec.ABS_Z, trig), (ec.ABS_RZ, trig),
            (ec.ABS_HAT0X, hat), (ec.ABS_HAT0Y, hat),
        ],
    }


def _get_pad():
    """Crée (une fois) la manette virtuelle. Le `phys` porte une marque à nous : c'est
    ce qui permet, au passthrough, de ne pas confondre notre propre manette avec celle
    du joueur et de se recopier soi-même en boucle."""
    global _ui_pad
    if _ui_pad is None:
        ev = _get_evdev()
        _check_uinput()
        try:
            _ui_pad = ev.UInput(
                _pad_capabilities(),
                name="Microsoft X-Box 360 pad",
                vendor=0x045E, product=0x028E, version=0x0110,
                bustype=ev.ecodes.BUS_USB,
                phys="houla-connect/virtual-pad",
            )
        except Exception as e:  # noqa: BLE001
            raise RuntimeError("UINPUT_PAD_FAILED: création de la manette virtuelle refusée (" + str(e) + ")")
        # Le périphérique met un instant à être vu par udev, libinput et SDL. Sans cette
        # pause, le premier effet envoyé part dans le vide : le jeu n'a pas encore ouvert
        # la manette. Même raison que l'attente de 400 ms côté app après l'activation.
        time.sleep(0.3)
        _write_pad(*_neutral_report())
    return _ui_pad


def _get_kb():
    """Clavier virtuel uinput, l'équivalent Linux d'Interception."""
    global _ui_kb
    if _ui_kb is None:
        ev = _get_evdev()
        _check_uinput()
        try:
            _ui_kb = ev.UInput(
                {ev.ecodes.EV_KEY: _all_key_codes()},
                name="Hou.la Connect virtual keyboard",
                vendor=0x1209, product=0x0001, version=0x0001,
                bustype=ev.ecodes.BUS_USB,
                phys="houla-connect/virtual-kb",
            )
        except Exception as e:  # noqa: BLE001
            raise RuntimeError("UINPUT_KB_FAILED: création du clavier virtuel refusée (" + str(e) + ")")
        time.sleep(0.3)  # même raison que pour la manette : laisser le serveur d'affichage l'ouvrir
    return _ui_kb


# ── interception-keys (nom du helper conservé, pilote différent) ─────────────
def keys(args):
    """Envoie une key-spec au niveau noyau. Même contrat et mêmes noms de touches que
    le chemin Windows : c'est le même bundle qui tourne des deux côtés."""
    spec = str(args.get("keys", ""))
    gap = _clamp_ms(args.get("gapMs", 40), 5000) / 1000.0
    ui = _get_kb()
    ec = _get_evdev().ecodes
    for names, hold in parse_key_spec(spec):
        # Tout résoudre AVANT d'appuyer quoi que ce soit : une faute de frappe au milieu
        # d'un accord ne doit pas laisser la première touche enfoncée.
        resolved = [_resolve_key(n) for n in names]
        codes = []
        if any(sh for _, sh in resolved):   # un symbole comme '!' se tape Maj + '1'
            codes.append(_resolve_key("shift")[0])
        for code, _ in resolved:
            if code not in codes:          # dédoublonne un 'shift' déjà présent dans l'accord
                codes.append(code)
        for c in codes:
            ui.write(ec.EV_KEY, c, 1)
        ui.syn()
        if hold:
            time.sleep(min(int(hold), 2000) / 1000.0)
        for c in reversed(codes):
            ui.write(ec.EV_KEY, c, 0)
        ui.syn()
        time.sleep(gap)
    return {"pressed": spec}


# ── État de la manette virtuelle : construit puis écrit d'un bloc ────────────
def _neutral_report():
    ec = _get_evdev().ecodes
    btn = {_btn_code(t): 0 for t in _PAD_BTN}
    axes = {ec.ABS_X: 0, ec.ABS_Y: 0, ec.ABS_RX: 0, ec.ABS_RY: 0,
            ec.ABS_Z: 0, ec.ABS_RZ: 0, ec.ABS_HAT0X: 0, ec.ABS_HAT0Y: 0}
    return btn, axes


def _build_report(phys=None, ov_buttons=(), ov_analog=None):
    """Rapport manette = état PHYSIQUE (si passthrough) + surcouche des cadeaux.

    Une seule fonction pour les deux chemins (effet direct hors passthrough, et boucle
    de recopie) : c'est exactement la combinaison que le self-test vérifie sous Windows
    (« le joueur tient A pendant qu'un cadeau envoie Y : les deux doivent sortir »), et
    la dupliquer serait le meilleur moyen de la voir diverger d'une plateforme à
    l'autre."""
    ec = _get_evdev().ecodes
    btn, axes = _neutral_report()
    if phys is not None:
        for tok in phys["buttons"]:
            _apply_token(btn, axes, tok)
        axes[ec.ABS_X] = int(phys["lx"] * _STICK_MAX)
        axes[ec.ABS_Y] = int(-phys["ly"] * _STICK_MAX)   # evdev : le HAUT est négatif
        axes[ec.ABS_RX] = int(phys["rx"] * _STICK_MAX)
        axes[ec.ABS_RY] = int(-phys["ry"] * _STICK_MAX)
        axes[ec.ABS_Z] = phys["lt"]
        axes[ec.ABS_RZ] = phys["rt"]
    for tok in ov_buttons:
        _apply_token(btn, axes, tok)
    if ov_analog is not None:  # un cadeau force les sticks : il écrase la physique
        axes[ec.ABS_X] = int(_clamp_axis(ov_analog.get("lx", 0.0)) * _STICK_MAX)
        axes[ec.ABS_Y] = int(-_clamp_axis(ov_analog.get("ly", 0.0)) * _STICK_MAX)
        axes[ec.ABS_RX] = int(_clamp_axis(ov_analog.get("rx", 0.0)) * _STICK_MAX)
        axes[ec.ABS_RY] = int(-_clamp_axis(ov_analog.get("ry", 0.0)) * _STICK_MAX)
        # Gâchettes PROPORTIONNELLES, comme le fait le chemin Windows direct
        # (left_trigger_float). Une gâchette n'est pas un bouton : « accélérer à moitié »
        # doit rester à moitié, sinon un pack de conduite se comporte autrement ici.
        if "lt" in ov_analog:
            axes[ec.ABS_Z] = int(max(0.0, _clamp_axis(ov_analog["lt"])) * _TRIG_MAX)
        if "rt" in ov_analog:
            axes[ec.ABS_RZ] = int(max(0.0, _clamp_axis(ov_analog["rt"])) * _TRIG_MAX)
    return btn, axes


def _apply_token(btn, axes, tok):
    ec = _get_evdev().ecodes
    if tok in _PAD_BTN:
        btn[_btn_code(tok)] = 1
    elif tok in _PAD_HAT:
        axis, val = _PAD_HAT[tok]
        axes[ec.ecodes[axis]] = val
    elif tok in _PAD_TRIG:
        axes[ec.ecodes[_PAD_TRIG[tok]]] = _TRIG_MAX


def _write_pad(btn, axes):
    """Écrit tout le rapport puis un SYN. On réécrit systématiquement TOUTES les valeurs :
    le cœur du sous-système d'entrée jette de lui-même les valeurs inchangées, donc ça ne
    produit aucun événement en trop, et ça évite d'avoir à suivre l'état précédent."""
    ui = _get_pad()
    ec = _get_evdev().ecodes
    for code, val in btn.items():
        ui.write(ec.EV_KEY, code, val)
    for code, val in axes.items():
        ui.write(ec.EV_ABS, code, int(val))
    ui.syn()


def _validate(tokens):
    norm = [str(t).upper() for t in tokens]
    for t in norm:
        if t not in _PAD_BTN and t not in _PAD_HAT and t not in _PAD_TRIG:
            raise ValueError(f"bouton inconnu: {t}")  # même message que le chemin Windows
    return norm


# ── Passthrough : manette physique prise en exclusivité puis recopiée ────────
_pt_running = False
_pt_thread = None
_pt_dev = None            # evdev.InputDevice de la manette PHYSIQUE (grabbée)
_pt_lock = threading.Lock()
_ov_buttons = set()
_ov_analog = None

# Codes du noyau susceptibles d'arriver d'une manette physique, ramenés à nos tokens.
# On accepte les DEUX conventions de croix directionnelle : axes (xpad, Xbox) et
# boutons BTN_DPAD_* (beaucoup de manettes génériques et hid-sony).
# Les deux noms d'un même code (BTN_SOUTH / BTN_A…) figurent tous les deux : la lecture
# se fait par `.get`, un nom absent de la table du noyau est simplement ignoré, et les
# deux mènent au même token donc le doublon est sans effet.
_PHYS_BTN = {
    "BTN_SOUTH": "A", "BTN_A": "A", "BTN_EAST": "B", "BTN_B": "B",
    "BTN_NORTH": "X", "BTN_X": "X", "BTN_WEST": "Y", "BTN_Y": "Y",
    "BTN_TL": "LB", "BTN_TR": "RB", "BTN_SELECT": "BACK", "BTN_START": "START",
    "BTN_THUMBL": "LS", "BTN_THUMBR": "RS",
    "BTN_DPAD_UP": "UP", "BTN_DPAD_DOWN": "DOWN", "BTN_DPAD_LEFT": "LEFT", "BTN_DPAD_RIGHT": "RIGHT",
    "BTN_TL2": "LT", "BTN_TR2": "RT",  # gâchettes TOUT-OU-RIEN de certaines manettes
}


def _is_gamepad(dev):
    """Vrai si le périphérique ressemble à une manette : au moins un bouton d'action
    ET un axe de stick. Le double critère écarte les claviers (boutons sans axes) et
    les pavés tactiles ou accéléromètres (axes sans boutons d'action)."""
    ec = _get_evdev().ecodes
    caps = dev.capabilities()
    keys_ = set(caps.get(ec.EV_KEY, []))
    axes_ = set(c for c, _ in caps.get(ec.EV_ABS, []))
    action = {_btn_code(t) for t in ("A", "B", "X", "Y")}
    return bool(keys_ & action) and ec.ABS_X in axes_


def _find_physical():
    """Première manette physique branchée qui n'est PAS la nôtre.

    L'exclusion se fait sur le `phys` que l'on a posé à la création : comparer les noms
    ne suffirait pas, puisque notre manette virtuelle s'annonce délibérément « Microsoft
    X-Box 360 pad » et serait donc indiscernable d'une vraie Xbox 360."""
    ev = _get_evdev()
    mine = _ui_pad.device.path if (_ui_pad is not None and _ui_pad.device is not None) else None
    for path in sorted(ev.list_devices()):
        if path == mine:
            continue
        try:
            dev = ev.InputDevice(path)
        except OSError:
            continue  # pas les droits de lecture sur ce nœud : ce n'est pas la nôtre, on passe
        try:
            if (dev.phys or "").startswith("houla-connect/"):
                dev.close()
                continue
            if _is_gamepad(dev):
                return dev
        except Exception:  # noqa: BLE001
            pass
        dev.close()
    return None


def _axis_ranges(dev):
    """Bornes réelles de chaque axe de la manette physique.

    Indispensable : une manette Xbox rapporte ses sticks sur -32768..32767, une
    DualShock sur 0..255, d'autres sur 0..1023. Recopier la valeur BRUTE d'une
    DualShock dans notre manette (plage Xbox) collerait le stick dans un coin en
    permanence. On normalise donc via ces bornes."""
    ec = _get_evdev().ecodes
    out = {}
    for code, info in dev.capabilities().get(ec.EV_ABS, []):
        out[code] = (info.min, info.max)
    return out


def _norm_stick(dev, ranges, code):
    """Axe physique ramené dans [-1, 1], convention Hou.la (+1 = haut / droite).
    Le signe du noyau (haut = négatif) est inversé ici, et ré-inversé à l'écriture par
    _build_report : les deux inversions se compensent, ce qui garde la logique de
    surcouche des cadeaux exprimée dans une seule convention."""
    if code not in ranges:
        return 0.0
    lo, hi = ranges[code]
    if hi <= lo:
        return 0.0
    try:
        raw = dev.absinfo(code).value
    except OSError:
        return 0.0
    frac = (raw - lo) / float(hi - lo)          # 0..1
    return max(-1.0, min(1.0, frac * 2.0 - 1.0))


def _norm_trigger(dev, ranges, code):
    """Gâchette physique ramenée sur 0..255 (plage xpad de notre manette virtuelle)."""
    if code not in ranges:
        return 0
    lo, hi = ranges[code]
    if hi <= lo:
        return 0
    try:
        raw = dev.absinfo(code).value
    except OSError:
        return 0
    return max(0, min(_TRIG_MAX, int((raw - lo) / float(hi - lo) * _TRIG_MAX)))


def _read_physical(dev, ranges):
    """Instantané de la manette physique, dans NOTRE vocabulaire.

    Lecture d'ÉTAT par ioctl (`active_keys`, `absinfo`), pas de lecture d'événements :
    on veut l'état courant à chaque tour de boucle, pas un historique. Effet de bord
    assumé : la file d'événements du périphérique n'est jamais vidée et finit par
    déborder côté noyau (SYN_DROPPED), ce qui est sans conséquence ici puisqu'on ne la
    lit pas."""
    ec = _get_evdev().ecodes
    try:
        active = set(dev.active_keys())
    except OSError:
        return None  # manette débranchée en cours de route
    st = {"buttons": set(), "lx": 0.0, "ly": 0.0, "rx": 0.0, "ry": 0.0, "lt": 0, "rt": 0}
    for name, tok in _PHYS_BTN.items():
        code = ec.ecodes.get(name)
        if code is not None and code in active:
            st["buttons"].add(tok)
    st["lx"] = _norm_stick(dev, ranges, ec.ABS_X)
    st["ly"] = -_norm_stick(dev, ranges, ec.ABS_Y)   # noyau : haut = négatif
    st["rx"] = _norm_stick(dev, ranges, ec.ABS_RX)
    st["ry"] = -_norm_stick(dev, ranges, ec.ABS_RY)
    st["lt"] = _norm_trigger(dev, ranges, ec.ABS_Z)
    st["rt"] = _norm_trigger(dev, ranges, ec.ABS_RZ)
    if "LT" in st["buttons"]:   # manette à gâchettes tout-ou-rien
        st["lt"] = _TRIG_MAX
        st["buttons"].discard("LT")
    if "RT" in st["buttons"]:
        st["rt"] = _TRIG_MAX
        st["buttons"].discard("RT")
    for code, axis_tok in ((ec.ABS_HAT0X, ("LEFT", "RIGHT")), (ec.ABS_HAT0Y, ("UP", "DOWN"))):
        if code in ranges:
            try:
                v = dev.absinfo(code).value
            except OSError:
                v = 0
            if v < 0:
                st["buttons"].add(axis_tok[0])
            elif v > 0:
                st["buttons"].add(axis_tok[1])
    return st


def _passthrough_loop():
    """~125 Hz : manette virtuelle = manette physique + surcouche des cadeaux.

    Comme sous Windows, la physique est RE-CHERCHÉE en continu : une manette sans fil
    s'endort et disparaît, un branchement à chaud arrive aussi. Sans ce re-scan, une
    manette absente au démarrage ne serait jamais reprise."""
    global _pt_dev
    ranges = _axis_ranges(_pt_dev) if _pt_dev is not None else {}
    ticks = 0
    while _pt_running:
        try:
            if _pt_dev is None and ticks % 30 == 0:   # ~0,25 s
                _pt_dev = _grab_physical()
                ranges = _axis_ranges(_pt_dev) if _pt_dev is not None else {}
            ticks += 1
            phys = _read_physical(_pt_dev, ranges) if _pt_dev is not None else None
            if _pt_dev is not None and phys is None:  # débranchée : on relâche et on re-cherche
                _close_physical()
                ranges = {}
            with _pt_lock:
                ob = list(_ov_buttons)
                oa = dict(_ov_analog) if _ov_analog is not None else None
            _write_pad(*_build_report(phys, ob, oa))
        except Exception:  # noqa: BLE001
            pass
        time.sleep(0.008)


def _grab_physical():
    """Ouvre la manette physique et la prend en EXCLUSIVITÉ (EVIOCGRAB).

    C'est le remplaçant Linux de la DLL proxy XInput de Windows : une fois grabbée, le
    noyau ne livre plus ses événements à personne d'autre, donc le jeu ne peut plus lire
    la manette du joueur directement et ne voit que la nôtre, qui la recopie et y ajoute
    les cadeaux. Sans ça, le jeu utiliserait la physique et aucun cadeau n'arriverait.
    Si le grab échoue (déjà pris en exclusivité par un autre programme), on garde quand
    même le miroir : moins efficace, mais jamais bloquant."""
    dev = _find_physical()
    if dev is None:
        return None
    try:
        dev.grab()
    except Exception:  # noqa: BLE001
        pass
    return dev


def _close_physical():
    global _pt_dev
    d = _pt_dev
    _pt_dev = None
    if d is None:
        return
    try:
        d.ungrab()
    except Exception:  # noqa: BLE001
        pass
    try:
        d.close()
    except Exception:  # noqa: BLE001
        pass


def passthrough(args):
    """Démarre/arrête le mode « une seule manette ».

    `targetExe` est accepté et IGNORÉ : il ne sert qu'à la DLL proxy de Windows, qui ne
    doit remapper que dans le jeu visé. Ici l'exclusivité porte sur le périphérique, pas
    sur un jeu, donc il n'y a rien à cibler. Le paramètre reste accepté pour que l'app
    envoie le même appel partout.

    Le retour garde les mêmes CLÉS que sous Windows pour que l'app n'ait pas à savoir sur
    quel système elle tourne. `physicalIndex` vaut le numéro du nœud /dev/input/eventN
    recopié (à titre indicatif), `virtualIndex` vaut toujours None : il n'existe pas de
    slot XInput sous Linux."""
    global _pt_running, _pt_thread, _pt_dev
    if bool(args.get("enable")):
        # Crée la manette virtuelle, ou lève un message actionnable (droits uinput).
        # UNIQUEMENT à l'activation : à la désactivation il n'y a rien à créer, et un
        # nettoyage ne doit pas pouvoir échouer sur un manque de droits.
        _get_pad()
        if _pt_dev is None:
            _pt_dev = _grab_physical()
        if not _pt_running:
            _pt_running = True
            _pt_thread = threading.Thread(target=_passthrough_loop, daemon=True)
            _pt_thread.start()
        idx = None
        if _pt_dev is not None:
            base = os.path.basename(_pt_dev.path)
            idx = int(base[5:]) if base.startswith("event") and base[5:].isdigit() else None
        return {"passthrough": True, "physicalIndex": idx, "virtualIndex": None}
    _pt_running = False
    with _pt_lock:
        _ov_buttons.clear()
    globals()["_ov_analog"] = None
    _release_pad()
    return {"passthrough": False}


# ── vigem-gamepad (nom du helper conservé) ───────────────────────────────────
def _fire_tokens(tokens, hold_ms):
    if not tokens:
        return
    norm = _validate(tokens)
    hold = _clamp_ms(hold_ms, 10000) / 1000.0
    if _pt_running:
        with _pt_lock:
            _ov_buttons.update(norm)
        time.sleep(hold)
        with _pt_lock:
            _ov_buttons.difference_update(norm)
    else:
        _write_pad(*_build_report(None, norm, None))
        time.sleep(hold)
        _write_pad(*_neutral_report())


def gamepad(args):
    _get_pad()
    if args.get("release"):
        if not _pt_running:
            _write_pad(*_neutral_report())
        else:
            with _pt_lock:
                _ov_buttons.clear()
            globals()["_ov_analog"] = None
        return {"released": True}

    # Toute erreur en cours de route doit RELÂCHER la surcouche et la manette : jamais
    # de bouton resté coincé après un pack qui plante.
    try:
        steps = args.get("steps")
        if isinstance(steps, list) and steps:
            for st in steps:
                toks = st.get("buttons") or ([st["button"]] if st.get("button") else [])
                if toks:
                    _fire_tokens(toks, st.get("holdMs", 120))
                wait = st.get("waitMs")
                if wait is not None:
                    time.sleep(_clamp_ms(wait, 30000) / 1000.0)
            if not _pt_running:
                _write_pad(*_neutral_report())
            return {"steps": len(steps)}

        analog = args.get("analog")
        if isinstance(analog, dict):
            hold = _clamp_ms(args.get("holdMs", 300), 10000) / 1000.0
            a = {"lx": _clamp_axis(analog.get("lx", 0)), "ly": _clamp_axis(analog.get("ly", 0)),
                 "rx": _clamp_axis(analog.get("rx", 0)), "ry": _clamp_axis(analog.get("ry", 0))}
            trg = set()
            if analog.get("lt"):
                trg.add("LT")
            if analog.get("rt"):
                trg.add("RT")
            if _pt_running:
                with _pt_lock:
                    globals()["_ov_analog"] = a
                    _ov_buttons.update(trg)
                time.sleep(hold)
                with _pt_lock:
                    globals()["_ov_analog"] = None
                    _ov_buttons.difference_update(trg)
                return {"analog": True}
            # Hors passthrough, les gâchettes passent par leur valeur ANALOGIQUE et non
            # par les tokens LT/RT tout-ou-rien (voir _build_report).
            if "lt" in analog:
                a["lt"] = analog.get("lt", 0)
            if "rt" in analog:
                a["rt"] = analog.get("rt", 0)
            _write_pad(*_build_report(None, (), a))
            time.sleep(hold)
            _write_pad(*_neutral_report())
            return {"analog": True}

        tokens = args.get("buttons")
        if not tokens:
            b = str(args.get("button", "")).upper()
            tokens = [b] if b else []
        if not tokens:
            raise ValueError("aucune touche à presser")
        _fire_tokens(tokens, args.get("holdMs", 120))
        return {"pressed": tokens}
    except Exception:
        try:
            with _pt_lock:
                _ov_buttons.clear()
            globals()["_ov_analog"] = None
            if not _pt_running:
                _write_pad(*_neutral_report())
        except Exception:  # noqa: BLE001
            pass
        raise


def _release_pad():
    """Ferme la manette virtuelle et rend la physique au joueur.

    Le motif Windows (« un pad qui reste squatte un slot XInput ») n'existe pas ici,
    mais il y a l'équivalent : tant que le passthrough tient la manette physique en
    exclusivité, le joueur ne peut plus s'en servir dans AUCUN autre programme. Un
    simple test ne doit donc rien laisser derrière lui."""
    global _ui_pad, _pt_running
    _pt_running = False
    _close_physical()
    p = _ui_pad
    _ui_pad = None
    if p is None:
        return
    try:
        p.close()
    except Exception:  # noqa: BLE001
        pass


def release_pad(args):
    _release_pad()
    return {"released": True}


def _cleanup():
    """Filet de sécurité à la sortie : rendre la manette du joueur et retirer nos
    périphériques virtuels. Un `kill -9` ne l'exécutera pas, mais le noyau détruit de
    toute façon un périphérique uinput dès que le descripteur qui l'a créé se ferme :
    contrairement à ViGEm sous Windows, il n'y a pas de cible zombie possible ici."""
    global _ui_kb
    _release_pad()
    k = _ui_kb
    _ui_kb = None
    if k is not None:
        try:
            k.close()
        except Exception:  # noqa: BLE001
            pass


atexit.register(_cleanup)


def shutdown(args):
    _cleanup()
    return {"shutdown": True}


# ── foreground : fenêtre au premier plan ─────────────────────────────────────
# Contrat : renvoyer {"exe": chemin} ou {"exe": None} = INCONNU. Côté app, un focus
# inconnu doit rester permissif (ne rien bloquer). Mieux vaut avouer l'inconnu que
# renvoyer un chemin faux, qui ferait taire tous les effets sans expliquer pourquoi.
_fg_method = None      # "sway" | "hyprland" | "xdotool" | "xprop" | "none"
_fg_next_probe = 0.0   # on ne re-sonde pas à chaque appel : le focus est interrogé toutes les 350 ms


def _run(cmd, timeout=1.0):
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=timeout)
    except (OSError, subprocess.SubprocessError):
        return None
    return r.stdout.decode("utf-8", "replace") if r.returncode == 0 else None


def _exe_of(pid):
    if not pid:
        return None
    try:
        return os.readlink("/proc/%d/exe" % int(pid))
    except (OSError, ValueError):
        return None


def _fg_sway():
    out = _run(["swaymsg", "-t", "get_tree"])
    if not out:
        return None
    try:
        tree = json.loads(out)
    except ValueError:
        return None
    stack = [tree]
    while stack:
        node = stack.pop()
        if isinstance(node, dict):
            if node.get("focused") and node.get("pid"):
                return node["pid"]
            for key in ("nodes", "floating_nodes"):
                stack.extend(node.get(key) or [])
    return None


def _fg_hyprland():
    out = _run(["hyprctl", "-j", "activewindow"])
    if not out:
        return None
    try:
        return json.loads(out).get("pid")
    except ValueError:
        return None


def _fg_xdotool():
    out = _run(["xdotool", "getactivewindow", "getwindowpid"])
    return int(out.strip()) if out and out.strip().isdigit() else None


def _fg_xprop():
    """Repli X11 sans xdotool : xprop fait partie de x11-utils, souvent déjà là."""
    out = _run(["xprop", "-root", "_NET_ACTIVE_WINDOW"])
    if not out or "0x" not in out:
        return None
    wid = out.rsplit("0x", 1)[-1].split(",")[0].strip()
    out2 = _run(["xprop", "-id", "0x" + wid, "_NET_WM_PID"])
    if not out2 or "=" not in out2:
        return None
    val = out2.split("=")[-1].strip()
    return int(val) if val.isdigit() else None


def foreground(args):
    """Sous Wayland, AUCUNE API standard ne dit quelle fenêtre a le focus à un client
    tiers : c'est un choix de sécurité du protocole, pas un oubli. On n'y arrive donc
    que sur les compositeurs qui exposent leur propre IPC (sway, Hyprland). Ailleurs
    (GNOME, KDE sous Wayland) on renvoie explicitement « inconnu »."""
    global _fg_method, _fg_next_probe
    wayland = os.environ.get("XDG_SESSION_TYPE", "").lower() == "wayland" or bool(os.environ.get("WAYLAND_DISPLAY"))
    order = (("sway", _fg_sway), ("hyprland", _fg_hyprland)) if wayland else (("xdotool", _fg_xdotool), ("xprop", _fg_xprop))
    now = time.time()
    if _fg_method == "none" and now < _fg_next_probe:
        return {"exe": None}   # rien ne marche ici : ne pas relancer 3 process toutes les 350 ms
    if _fg_method and _fg_method != "none":
        for name, fn in order:
            if name == _fg_method:
                exe = _exe_of(fn())
                if exe:
                    return {"exe": exe}
                break
    for name, fn in order:
        exe = _exe_of(fn())
        if exe:
            _fg_method = name
            return {"exe": exe}
    _fg_method = "none"
    _fg_next_probe = now + 30.0   # re-sonder de temps en temps : l'outil peut être installé après coup
    return {"exe": None}


# ── capabilities ─────────────────────────────────────────────────────────────
def capabilities(args):
    """Ce que CETTE machine Linux sait faire, sans rien promettre d'invérifié.

    Le test par défaut est non intrusif (présence du module, existence et droits du
    nœud /dev/uinput) : c'est justement là que se joue toute la friction Linux, donc un
    verdict fiable ne coûte rien. Avec probe=true, on crée réellement les deux
    périphériques virtuels puis on les retire, ce qui prouve le chemin complet."""
    probe = bool(args.get("probe"))
    ok, reason = True, ""
    try:
        _get_evdev()
    except Exception as e:  # noqa: BLE001
        ok, reason = False, str(e)
    if ok:
        try:
            _check_uinput()
        except Exception as e:  # noqa: BLE001
            ok, reason = False, str(e)
    if ok and probe:
        try:
            _get_kb()
            _get_pad()
            _cleanup()   # une SONDE ne laisse rien derrière elle : ni manette, ni clavier virtuel
            reason = "Clavier et manette virtuels créés puis retirés : " + UINPUT_DEV + " répond."
        except Exception as e:  # noqa: BLE001
            ok, reason = False, str(e)
    if ok and not reason:
        reason = ("Le module evdev est présent et " + UINPUT_DEV + " est ouvrable en écriture : "
                  "clavier et manette disponibles.")
    return {
        "platform": PLATFORM,
        "keyboard": ok,
        "gamepad": ok,
        "reason": reason,
        "keyboardBackend": "uinput",
        "gamepadBackend": "uinput",
        "probed": probe,
    }
