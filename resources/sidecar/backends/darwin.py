#!/usr/bin/env python3
"""Backend macOS du sidecar : clavier via Quartz. Manette NON SUPPORTÉE, et assumée.

CLAVIER. macOS n'a pas d'équivalent d'Interception accessible sans pilote signé, mais
il n'en a pas besoin : `CGEventPost(kCGHIDEventTap, …)` injecte l'événement au niveau
du tap HID, c'est-à-dire AVANT la distribution aux applications. Un jeu ne peut pas
distinguer cet événement d'une frappe réelle. Le prix à payer est une AUTORISATION :
l'app hôte doit figurer dans Réglages Système > Confidentialité et sécurité >
Accessibilité. Sans elle, `CGEventPost` ne lève rien du tout et l'événement part dans
le vide : on détecte donc l'autorisation AVANT d'envoyer, sinon la panne serait
totalement muette (le cas classique « le pack ne fait rien et n'affiche aucune
erreur »).

MANETTE : HORS PÉRIMÈTRE, et ce n'est pas un oubli. Créer une manette virtuelle sous
macOS demande une extension système DriverKit, signée avec un droit (entitlement) que
seul Apple accorde après examen. Rien de tout ça n'est embarqué dans Hou.la Connect.
Le sidecar refuse donc les helpers manette avec un CODE STABLE
(GAMEPAD_UNSUPPORTED_DARWIN) plutôt que de lever une exception brute ou, pire, de
répondre OK sans rien faire. L'app peut ainsi masquer les interactions Manette sur Mac
au lieu de les proposer puis d'échouer.

Dépendances (voir requirements.txt) : pyobjc-framework-Quartz, pyobjc-framework-Cocoa ;
sys_platform == "darwin".
"""
import time

from .common import clamp_ms as _clamp_ms, parse_key_spec

PLATFORM = "darwin"

ERR_GAMEPAD = (
    "GAMEPAD_UNSUPPORTED_DARWIN: la manette virtuelle n'existe pas sur macOS. La créer "
    "demanderait une extension système DriverKit signée et approuvée par Apple, que "
    "Hou.la Connect n'embarque pas. Les interactions Clavier fonctionnent normalement ; "
    "pour les interactions Manette, il faut un PC Windows ou Linux."
)
ERR_QUARTZ = (
    "QUARTZ_MISSING: le module Quartz (pyobjc) est introuvable dans le sidecar. "
    "Installe les dépendances : pip install -r requirements.txt "
    "(paquets pyobjc-framework-Quartz et pyobjc-framework-Cocoa)."
)
ERR_ACCESSIBILITY = (
    "ACCESSIBILITY_DENIED: macOS refuse l'envoi de touches tant que l'application n'y "
    "est pas autorisée.\n"
    "  1. Ouvre Réglages Système > Confidentialité et sécurité > Accessibilité.\n"
    "  2. Active « Hou.la Connect » dans la liste (bouton +, puis choisis l'app si elle "
    "n'y figure pas).\n"
    "  3. Quitte complètement Hou.la Connect et relance-le : l'autorisation n'est lue "
    "qu'au démarrage."
)


# ── Chargement paresseux de pyobjc ───────────────────────────────────────────
_quartz = None
_appkit = None


def _get_quartz():
    """Importe Quartz à la première utilisation. Jamais au démarrage : `capabilities`
    doit pouvoir répondre « clavier indisponible, voici pourquoi » même sans pyobjc."""
    global _quartz
    if _quartz is None:
        try:
            import Quartz  # pyobjc-framework-Quartz
        except ImportError as e:  # noqa: BLE001
            raise RuntimeError(ERR_QUARTZ + " (" + str(e) + ")")
        _quartz = Quartz
    return _quartz


def _get_appkit():
    """AppKit sert UNIQUEMENT au premier plan, et son absence ne doit pas empêcher le
    clavier de marcher : d'où un import séparé de celui de Quartz."""
    global _appkit
    if _appkit is None:
        try:
            import AppKit  # pyobjc-framework-Cocoa
        except ImportError:  # noqa: BLE001
            return None
        _appkit = AppKit
    return _appkit


def _has_post_access():
    """L'app a-t-elle le droit d'injecter des événements ?

    `CGPreflightPostEventAccess` est la question exacte à poser (macOS 10.15+), et elle
    ne déclenche AUCUNE fenêtre de demande. On la cherche par getattr : selon la version
    de pyobjc et de macOS elle peut manquer, et dans ce cas on ne prétend pas savoir. On
    retourne alors None (= indéterminé) plutôt que False, pour ne pas bloquer un clavier
    qui marcherait très bien."""
    q = _get_quartz()
    fn = getattr(q, "CGPreflightPostEventAccess", None)
    if fn is None:
        return None
    try:
        return bool(fn())
    except Exception:  # noqa: BLE001
        return None


# ── Table des touches : noms canoniques -> codes virtuels macOS ──────────────
# Les noms acceptés sont ceux d'interception-python (le vocabulaire des bundles déjà
# publiés) : un pack écrit pour Windows doit tourner ici SANS ÊTRE RETOUCHÉ.
# ⚠️ Ces codes désignent une POSITION sur un clavier ANSI américain, pas un caractère.
# Sur un clavier AZERTY, le code 0x00 reste la touche située là où l'ANSI a « A », donc
# la touche « Q ». C'est le comportement voulu pour un jeu (les touches ZQSD/WASD sont
# des positions), mais ça surprend si on croit envoyer une lettre.
# ⚠️ ',' et '+' ne sont pas atteignables : ils séparent les étapes et les accords dans
# une key-spec. C'était déjà le cas sous Windows, ce n'est donc pas une régression.
_VK = {
    "a": 0x00, "s": 0x01, "d": 0x02, "f": 0x03, "h": 0x04, "g": 0x05, "z": 0x06,
    "x": 0x07, "c": 0x08, "v": 0x09, "b": 0x0B, "q": 0x0C, "w": 0x0D, "e": 0x0E,
    "r": 0x0F, "y": 0x10, "t": 0x11, "o": 0x1F, "u": 0x20, "i": 0x22, "p": 0x23,
    "l": 0x25, "j": 0x26, "k": 0x28, "n": 0x2D, "m": 0x2E,
    "1": 0x12, "2": 0x13, "3": 0x14, "4": 0x15, "6": 0x16, "5": 0x17,
    "9": 0x19, "7": 0x1A, "8": 0x1C, "0": 0x1D,
    "=": 0x18, "-": 0x1B, "]": 0x1E, "[": 0x21, "'": 0x27, ";": 0x29,
    "\\": 0x2A, ",": 0x2B, "/": 0x2C, ".": 0x2F, "`": 0x32,
    "enter": 0x24, "return": 0x24, "tab": 0x30, "space": 0x31,
    "backspace": 0x33, "del": 0x75, "delete": 0x75, "esc": 0x35, "escape": 0x35,
    "capslock": 0x39,
    "shift": 0x38, "shiftleft": 0x38, "shiftright": 0x3C,
    "ctrl": 0x3B, "ctrlleft": 0x3B, "ctrlright": 0x3E,
    "alt": 0x3A, "altleft": 0x3A, "altright": 0x3D,
    # Sur un Mac, la touche Logo EST la touche Commande : « win » et « command » sont
    # deux noms du même geste. Idem « alt » et « option ». Un pack écrit avec l'un ou
    # l'autre vocabulaire doit marcher.
    "win": 0x37, "winleft": 0x37, "super": 0x37,
    "command": 0x37, "commandleft": 0x37,
    "winright": 0x36, "commandright": 0x36,
    "option": 0x3A, "optionleft": 0x3A, "optionright": 0x3D,
    # macOS n'a ni Inser ni Verr.num : les touches qui occupent CES POSITIONS sur un
    # clavier Apple sont Aide (0x72) et Effacement du pavé (0x47). C'est le meilleur
    # équivalent possible, pas une correspondance exacte.
    "insert": 0x72, "help": 0x72, "numlock": 0x47,
    "home": 0x73, "end": 0x77, "pgup": 0x74, "pageup": 0x74,
    "pgdn": 0x79, "pagedown": 0x79,
    "left": 0x7B, "right": 0x7C, "down": 0x7D, "up": 0x7E,
    "num0": 0x52, "num1": 0x53, "num2": 0x54, "num3": 0x55, "num4": 0x56,
    "num5": 0x57, "num6": 0x58, "num7": 0x59, "num8": 0x5B, "num9": 0x5C,
    "multiply": 0x43, "add": 0x45, "subtract": 0x4E, "decimal": 0x41, "divide": 0x4B,
    "f1": 0x7A, "f2": 0x78, "f3": 0x63, "f4": 0x76, "f5": 0x60, "f6": 0x61,
    "f7": 0x62, "f8": 0x64, "f9": 0x65, "f10": 0x6D, "f11": 0x67, "f12": 0x6F,
    "f13": 0x69, "f14": 0x6B, "f15": 0x71, "f16": 0x6A, "f17": 0x40, "f18": 0x4F,
    "f19": 0x50, "f20": 0x5A,
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

# Modificateurs : sous macOS il ne suffit PAS d'envoyer la touche Maj puis la touche
# visée. Beaucoup d'applications ne lisent pas l'état du clavier mais le champ « flags »
# porté par CHAQUE événement. On fait donc les deux : on envoie bien l'événement du
# modificateur (pour les jeux qui lisent l'état brut) ET on marque le flag sur les
# touches de l'accord (pour tous les autres). Sans le flag, « shift+c » produit un « c ».
_MOD_FLAG_NAMES = {
    "shift": "kCGEventFlagMaskShift", "shiftleft": "kCGEventFlagMaskShift",
    "shiftright": "kCGEventFlagMaskShift",
    "ctrl": "kCGEventFlagMaskControl", "ctrlleft": "kCGEventFlagMaskControl",
    "ctrlright": "kCGEventFlagMaskControl",
    "alt": "kCGEventFlagMaskAlternate", "altleft": "kCGEventFlagMaskAlternate",
    "altright": "kCGEventFlagMaskAlternate",
    "win": "kCGEventFlagMaskCommand", "winleft": "kCGEventFlagMaskCommand",
    "super": "kCGEventFlagMaskCommand",
}


def _vk(name):
    """(code virtuel macOS, faut-il ajouter Maj ?), ou ValueError nommant la touche."""
    shifted = name in _SHIFTED
    code = _VK.get(_SHIFTED[name] if shifted else name)
    if code is None:
        raise ValueError("touche inconnue: %s" % name)
    return code, shifted


def _post(code, down, flags):
    q = _get_quartz()
    ev = q.CGEventCreateKeyboardEvent(None, code, bool(down))
    if ev is None:
        raise RuntimeError("CGEventCreateKeyboardEvent a échoué (code %d)" % code)
    if flags:
        q.CGEventSetFlags(ev, flags)
    q.CGEventPost(q.kCGHIDEventTap, ev)


# ── interception-keys (nom du helper conservé, pilote différent) ─────────────
def keys(args):
    """Envoie une key-spec. Même contrat et mêmes noms de touches que le chemin
    Windows : c'est le même bundle qui tourne des deux côtés."""
    q = _get_quartz()
    if _has_post_access() is False:
        raise RuntimeError(ERR_ACCESSIBILITY)
    spec = str(args.get("keys", ""))
    gap = _clamp_ms(args.get("gapMs", 40), 5000) / 1000.0
    shift_vk = _VK["shift"]
    for names, hold in parse_key_spec(spec):
        # Tout résoudre AVANT d'appuyer quoi que ce soit : une faute de frappe au milieu
        # d'un accord ne doit pas laisser la première touche enfoncée.
        resolved = [_vk(n) for n in names]
        flags = 0
        for n in names:
            flag_name = _MOD_FLAG_NAMES.get(n)
            if flag_name:
                flags |= getattr(q, flag_name, 0)
        # Un symbole comme '!' se tape Maj + '1' : le flag Maj doit accompagner la touche,
        # et la touche Maj elle-même doit être envoyée pour les jeux qui lisent l'état brut.
        seq = []   # (code, est_un_modificateur)
        if any(sh for _, sh in resolved):
            flags |= getattr(q, "kCGEventFlagMaskShift", 0)
            seq.append((shift_vk, True))
        for (code, _), n in zip(resolved, names):
            if any(code == c for c, _ in seq):
                continue   # dédoublonne un 'shift' déjà présent dans l'accord
            seq.append((code, n in _MOD_FLAG_NAMES))
        for code, is_mod in seq:
            # Le modificateur lui-même ne porte pas son propre flag : macOS le pose au
            # moment où l'événement est distribué.
            _post(code, True, 0 if is_mod else flags)
        if hold:
            time.sleep(min(int(hold), 2000) / 1000.0)
        for code, is_mod in reversed(seq):
            _post(code, False, 0 if is_mod else flags)
        time.sleep(gap)
    return {"pressed": spec}


# ── Helpers manette : refus NET, jamais d'exception brute ────────────────────
def gamepad(args):
    raise RuntimeError(ERR_GAMEPAD)


def passthrough(args):
    raise RuntimeError(ERR_GAMEPAD)


def release_pad(args):
    """Volontairement PERMISSIF, contrairement aux autres helpers manette.

    L'app appelle `release-pad` en nettoyage, sur un chemin où toute erreur est avalée
    (`catch { }`). Faire échouer un nettoyage qui n'a rien à nettoyer n'apporterait
    aucune information et polluerait les logs : il n'y a jamais eu de manette à libérer
    sur macOS."""
    return {"released": True}


def shutdown(args):
    return {"shutdown": True}


# ── foreground : application au premier plan ─────────────────────────────────
def foreground(args):
    """Chemin de l'exécutable de l'app active, ou None = INCONNU.

    On passe par NSWorkspace plutôt que par CGWindowListCopyWindowInfo : la liste des
    fenêtres exige l'autorisation « Enregistrement de l'écran » depuis macOS 10.15 pour
    donner les titres, alors que `frontmostApplication` ne demande aucune autorisation
    et renvoie directement le chemin de l'exécutable, qui est exactement ce que le
    focus-guard compare. En cas d'échec on renvoie None plutôt qu'une valeur douteuse :
    côté app, un focus inconnu doit rester permissif."""
    ak = _get_appkit()
    if ak is None:
        return {"exe": None}
    try:
        app = ak.NSWorkspace.sharedWorkspace().frontmostApplication()
        if app is None:
            return {"exe": None}
        url = app.executableURL()
        if url is not None and url.path():
            return {"exe": str(url.path())}
        burl = app.bundleURL()   # repli : le .app, quand l'exécutable n'est pas exposé
        if burl is not None and burl.path():
            return {"exe": str(burl.path())}
    except Exception:  # noqa: BLE001
        pass
    return {"exe": None}


# ── capabilities ─────────────────────────────────────────────────────────────
def capabilities(args):
    """Ce que CETTE machine macOS sait faire. La manette est toujours False, avec sa
    raison : c'est justement l'information dont l'app a besoin pour ne pas proposer une
    interaction qui échouerait ensuite."""
    probe = bool(args.get("probe"))
    keyboard = True
    notes = []
    try:
        _get_quartz()
    except Exception as e:  # noqa: BLE001
        keyboard = False
        notes.append(str(e))
    if keyboard:
        access = _has_post_access()
        if access is False:
            keyboard = False
            notes.append(ERR_ACCESSIBILITY)
        elif access is None:
            notes.append(
                "Autorisation d'Accessibilité non vérifiable sur cette version de macOS : "
                "si aucune touche n'arrive dans le jeu, c'est presque toujours elle qui "
                "manque (Réglages Système > Confidentialité et sécurité > Accessibilité)."
            )
        else:
            notes.append("Clavier disponible : l'autorisation d'Accessibilité est accordée.")
    notes.append(ERR_GAMEPAD)
    return {
        "platform": PLATFORM,
        "keyboard": keyboard,
        "gamepad": False,
        "reason": " ".join(notes),
        "keyboardBackend": "quartz",
        "gamepadBackend": None,
        "probed": probe,
    }
