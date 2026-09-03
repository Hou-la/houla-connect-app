#!/usr/bin/env python3
"""Briques COMMUNES aux trois backends du sidecar (Windows / Linux / macOS).

Ce module est chargé sur TOUTES les plateformes : il ne doit donc importer QUE la
bibliothèque standard, et rien qui touche un pilote. Tout ce qui parle à un pilote vit
dans backends/win32.py, backends/linux.py ou backends/darwin.py, et ces trois-là ne
sont jamais importés hors de leur plateforme (voir backends/__init__.py).

On y met ce qui DOIT être identique partout : le découpage d'une key-spec et les
bornages. Si Linux lisait « space:400 » autrement que Windows, un pack testé sur PC
marcherait et le même pack échouerait sur la machine du voisin, sans message d'erreur.
"""

# Tokens manette acceptés par le helper `vigem-gamepad`, identiques sur toutes les
# plateformes : c'est le CONTRAT avec les bundles (donnée inerte, écrite une fois pour
# tous les systèmes). Chaque backend traduit ces tokens vers son propre pilote.
#   - boutons numériques : A B X Y LB RB UP DOWN LEFT RIGHT START BACK LS RS
#   - gâchettes ANALOGIQUES (pas des boutons) : LT RT
BUTTON_TOKENS = (
    "A", "B", "X", "Y", "LB", "RB", "UP", "DOWN", "LEFT", "RIGHT",
    "START", "BACK", "LS", "RS",
)
TRIGGER_TOKENS = ("LT", "RT")

# Noms de touches que les TROIS backends doivent accepter. C'est le socle du contrat :
# un pack écrit sous Windows tourne tel quel sous Linux et macOS tant qu'il s'en tient
# à cette liste. Elle est vérifiée par selftest_sidecar.py, qui compare les tables de
# backends/linux.py et backends/darwin.py à celle-ci.
#
# Ce socle est plus ÉTROIT que ce qu'accepte interception-python sous Windows : les
# touches héritées de Windows (IME kana/hanja, browserback, launchapp1, sleep…) et les
# fonctions f21 à f24 n'ont pas d'équivalent partout. Elles restent utilisables sous
# Windows ; ailleurs elles produisent « touche inconnue: <nom> », qui nomme la touche
# fautive au lieu de laisser le pack ne rien faire en silence.
PORTABLE_KEY_NAMES = frozenset(
    list("abcdefghijklmnopqrstuvwxyz")
    + [str(d) for d in range(10)]
    + ["f%d" % i for i in range(1, 13)]
    + ["num%d" % i for i in range(10)]
    + [
        "space", "enter", "return", "tab", "esc", "escape", "backspace", "del", "delete",
        "shift", "shiftleft", "shiftright", "ctrl", "ctrlleft", "ctrlright",
        "alt", "altleft", "altright", "win", "winleft", "winright", "super",
        "command", "option", "optionleft", "optionright",
        "up", "down", "left", "right", "home", "end", "insert",
        "pgup", "pageup", "pgdn", "pagedown", "capslock",
        "-", "=", "[", "]", "\\", ";", "'", ".", "/", "`",
        "multiply", "add", "subtract", "decimal", "divide",
    ]
)


def clamp_ms(v, hi):
    """Borne une durée en millisecondes dans [0, hi]. Toute valeur illisible vaut 0
    (un bundle malformé ne doit jamais figer un maintien de touche)."""
    try:
        return max(0, min(int(v), hi))
    except (TypeError, ValueError):
        return 0


def clamp_axis(v):
    """Borne un axe analogique dans [-1.0, 1.0]. Convention retenue partout :
    +1.0 = HAUT / DROITE. Attention, ce n'est PAS la convention du noyau Linux
    (evdev : le haut est NÉGATIF) : la conversion se fait dans backends/linux.py."""
    try:
        return max(-1.0, min(float(v), 1.0))
    except (TypeError, ValueError):
        return 0.0


def parse_key_spec(spec):
    """Découpe une key-spec en étapes : 'space' | 'shift+c' | 'c,c,c' | 'space:400'.

    Renvoie [(['shift', 'c'], '400'), ...] : la liste des touches d'un accord, et le
    maintien en millisecondes SOUS SA FORME BRUTE (chaîne, éventuellement vide).

    ⚠️ Le maintien n'est volontairement PAS converti ici. La boucle Windows d'origine
    faisait `min(int(hold), 2000)` au moment d'exécuter l'étape : sur « a,b:xx » elle
    appuyait donc 'a' PUIS levait ValueError sur 'b'. Convertir à l'analyse changerait
    ce comportement (échec avant tout appui). Le chemin Windows est en production : on
    garde son comportement au bit près, et les autres backends font pareil.

    Re-vérifier : `python resources/sidecar/selftest_sidecar.py` compare la sortie de
    cette fonction aux specs réellement utilisées par les bundles."""
    steps = []
    for raw_step in str(spec).split(","):
        combo, _, hold = raw_step.partition(":")
        keys = [k.strip().lower() for k in combo.split("+") if k.strip()]
        steps.append((keys, hold))
    return steps
