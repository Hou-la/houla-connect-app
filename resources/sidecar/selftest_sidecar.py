#!/usr/bin/env python3
"""Auto-test MULTIPLATEFORME du sidecar : il démarre, il parle JSON-RPC, et il annonce
des capacités qui correspondent à CETTE machine.

Ce que ce test prouve, sur n'importe quel système :
  1. le sidecar démarre et répond, une réponse par requête, avec le BON id ;
  2. un helper inconnu est REFUSÉ (contre-témoin : sans lui, un sidecar qui répondrait
     « ok » à tout passerait le test 1 sans rien piloter) ;
  3. `capabilities` renvoie un verdict complet et non vide pour cette machine ;
  4. les helpers indisponibles ici échouent avec un CODE STABLE (VIGEMBUS_MISSING,
     UINPUT_PERMISSION_DENIED, GAMEPAD_UNSUPPORTED_DARWIN...), pas avec une trace brute ;
  5. le découpage des key-specs est identique sur les trois plateformes, sur les specs
     réellement utilisées par les bundles publiés.

Ce que ce test NE prouve PAS, et ne peut pas prouver sans intervention humaine : qu'une
touche arrive vraiment dans un jeu, ni qu'une manette virtuelle est vue par SDL. Ça se
constate sur l'écran du jeu, pas dans un process fils. Le point 4 est là pour qu'un
échec de pilote se lise comme un message actionnable et non comme un plantage.

Usage :
    python resources/sidecar/selftest_sidecar.py            # sans effet de bord
    python resources/sidecar/selftest_sidecar.py --probe    # crée VRAIMENT les
                                                            # périphériques virtuels,
                                                            # puis les retire
Sortie : 0 = tout bon, 2 = au moins un échec.
"""
import os
import sys
import json
import time
import queue
import threading
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from backends import common  # noqa: E402
from backends.common import parse_key_spec  # noqa: E402

SIDECAR = os.path.join(HERE, "houla_sidecar.py")


class Client:
    """Client JSON-RPC minimal : exactement ce que fait src/main/engine/python-sidecar.ts
    (une requête JSON par ligne sur stdin, une réponse par ligne sur stdout). On relit la
    sortie dans un thread pour pouvoir imposer un délai : un sidecar MUET doit être un
    échec net, pas un test qui pend indéfiniment."""

    def __init__(self):
        self.proc = subprocess.Popen(
            [sys.executable, SIDECAR],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        self.lines = queue.Queue()
        self.stderr = []
        threading.Thread(target=self._pump, args=(self.proc.stdout, self.lines), daemon=True).start()
        threading.Thread(target=self._drain, args=(self.proc.stderr,), daemon=True).start()
        self.next_id = 1

    @staticmethod
    def _pump(stream, out):
        for raw in stream:
            out.put(raw.decode("utf-8", "replace").strip())

    def _drain(self, stream):
        for raw in stream:
            self.stderr.append(raw.decode("utf-8", "replace").rstrip())

    def call(self, method, params=None, timeout=20.0):
        rid = self.next_id
        self.next_id += 1
        self.proc.stdin.write((json.dumps({"id": rid, "method": method, "params": params or {}}) + "\n").encode())
        self.proc.stdin.flush()
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                line = self.lines.get(timeout=max(0.05, deadline - time.time()))
            except queue.Empty:
                break
            if not line:
                continue
            try:
                msg = json.loads(line)
            except ValueError:
                continue    # ligne de log libre : le protocole autorise, on l'ignore
            if msg.get("id") != rid:
                return {"error": "id de reponse inattendu: %r (attendu %r)" % (msg.get("id"), rid)}
            return msg
        return {"error": "aucune reponse en %.0f s" % timeout}

    def close(self):
        try:
            self.proc.stdin.close()
        except Exception:  # noqa: BLE001
            pass
        try:
            self.proc.wait(timeout=5)
        except Exception:  # noqa: BLE001
            self.proc.kill()


CHECKS = []


def check(label, ok, detail=""):
    CHECKS.append((label, bool(ok), detail))


def test_key_spec_parsing():
    """Le découpage des key-specs vit dans backends/common.py et sert aux TROIS
    backends. On le fige ici sur les specs réellement présentes dans bundles/ plus les
    trois formes documentées, pour qu'un pack ne puisse pas se comporter autrement
    selon le système du spectateur."""
    cases = {
        "space": [(["space"], "")],
        "1": [(["1"], "")],
        "shift": [(["shift"], "")],
        "shift,space,1": [(["shift"], ""), (["space"], ""), (["1"], "")],
        "shift+c": [(["shift", "c"], "")],
        "c,c,c": [(["c"], ""), (["c"], ""), (["c"], "")],
        "space:400": [(["space"], "400")],
    }
    bad = []
    for spec, expected in cases.items():
        got = parse_key_spec(spec)
        if got != expected:
            bad.append("%r -> %r (attendu %r)" % (spec, got, expected))
    check("découpage des key-specs identique sur les 3 plateformes (%d formes)" % len(cases),
          not bad, " ; ".join(bad))


def test_cross_platform_contract():
    """Le contrat que les TROIS backends doivent tenir, vérifiable depuis n'importe
    quel système.

    C'est possible parce que backends/linux.py et backends/darwin.py n'importent leur
    pilote qu'à l'INTÉRIEUR de leurs fonctions : leurs tables de correspondance sont
    donc lisibles depuis Windows, et ce test tourne partout. C'est aussi le contre-
    témoin de cette conception : si quelqu'un remontait un jour `import evdev` en tête
    de backends/linux.py, cet import échouerait ici et le test le dirait tout de suite,
    au lieu de laisser la panne se découvrir sur la machine d'un utilisateur."""
    from backends import win32, linux, darwin  # noqa: E402

    # 1) Tokens manette : Windows et Linux doivent accepter exactement les mêmes.
    wt = set(win32._BUTTONS) | set(win32._TRIGGERS)
    lt = set(linux._PAD_BTN) | set(linux._PAD_HAT) | set(linux._PAD_TRIG)
    ct = set(common.BUTTON_TOKENS) | set(common.TRIGGER_TOKENS)
    check("tokens manette identiques Windows / Linux (%d)" % len(ct), wt == lt == ct,
          "win32-linux=%s linux-win32=%s common-win32=%s" % (sorted(wt - lt), sorted(lt - wt), sorted(ct ^ wt)))

    # 2) Noms de touches du socle portable : Linux et macOS doivent tous les connaître.
    ml = sorted(n for n in common.PORTABLE_KEY_NAMES if n not in linux._KEY_ALIASES)
    md = sorted(n for n in common.PORTABLE_KEY_NAMES if n not in darwin._VK)
    check("Linux connait les %d noms de touches du socle portable" % len(common.PORTABLE_KEY_NAMES),
          not ml, "manquants: %s" % ml)
    check("macOS connait les %d noms de touches du socle portable" % len(common.PORTABLE_KEY_NAMES),
          not md, "manquants: %s" % md)

    # 3) Windows : la référence, c'est interception-python lui-même. On n'échoue pas si
    # la bibliothèque n'est pas installée (la CI n'a pas les pilotes), on le dit.
    try:
        from interception import _keycodes as kc
        known = set(k for k in kc._MAPPING if isinstance(k, str))
        mw = sorted(n for n in common.PORTABLE_KEY_NAMES if n not in known)
        check("Windows (interception-python) connait le socle portable", not mw, "manquants: %s" % mw)
    except Exception as e:  # noqa: BLE001
        print("  info: interception-python non inspectable ici (%s), socle Windows non verifie." % e)

    # 4) Les symboles Maj sont couverts des deux côtés, avec la MÊME table.
    check("tables des symboles Maj identiques Linux / macOS (%d)" % len(linux._SHIFTED),
          linux._SHIFTED == darwin._SHIFTED,
          "linux=%s macos=%s" % (sorted(linux._SHIFTED), sorted(darwin._SHIFTED)))


def main():
    probe = "--probe" in sys.argv
    print("Plateforme : %s | Python %s" % (sys.platform, sys.version.split()[0]))
    print("Sidecar    : %s" % SIDECAR)
    print("Sonde reelle (--probe) : %s" % ("OUI, les peripheriques virtuels seront crees puis retires" if probe else "non"))
    print("")

    test_key_spec_parsing()
    test_cross_platform_contract()

    c = Client()
    try:
        # 1) Aller-retour JSON-RPC. `foreground` est le helper le plus inoffensif : il
        # ne touche aucun pilote et existe sur les trois plateformes.
        r = c.call("foreground")
        check("le sidecar demarre et repond au JSON-RPC (foreground)",
              "result" in r and isinstance(r["result"], dict) and "exe" in r["result"],
              json.dumps(r, ensure_ascii=False)[:200])
        fg = (r.get("result") or {}).get("exe")
        print("  info: fenetre au premier plan = %s" % (fg if fg else "INCONNU (l'app doit rester permissive)"))

        # 2) CONTRE-TÉMOIN. Sans ce test, un sidecar qui répondrait « ok » à n'importe
        # quoi passerait le test 1 en ne pilotant rien du tout.
        r = c.call("helper-qui-nexiste-pas")
        check("un helper inconnu est REFUSE (contre-temoin)",
              "error" in r and "helper" in str(r.get("error", "")).lower(),
              json.dumps(r, ensure_ascii=False)[:200])

        # 3) capabilities : le verdict de la machine.
        r = c.call("capabilities", {"probe": probe}, timeout=60.0)
        caps = r.get("result") or {}
        ok_shape = (
            isinstance(caps.get("keyboard"), bool)
            and isinstance(caps.get("gamepad"), bool)
            and isinstance(caps.get("platform"), str)
            and isinstance(caps.get("reason"), str) and caps.get("reason").strip() != ""
        )
        check("capabilities renvoie keyboard/gamepad/platform/reason, reason non vide",
              ok_shape, json.dumps(r, ensure_ascii=False)[:300])
        check("capabilities annonce la bonne plateforme",
              caps.get("platform") == sys.platform,
              "annonce %r, reel %r" % (caps.get("platform"), sys.platform))
        print("  CAPACITES DE CETTE MACHINE")
        print("    plateforme : %s" % caps.get("platform"))
        print("    clavier    : %s (%s)" % (caps.get("keyboard"), caps.get("keyboardBackend")))
        print("    manette    : %s (%s)" % (caps.get("gamepad"), caps.get("gamepadBackend")))
        for ligne in str(caps.get("reason", "")).splitlines():
            print("    raison     | %s" % ligne)

        # 4) Cohérence : un helper annoncé INDISPONIBLE doit échouer avec un code stable
        # et lisible, jamais avec une trace brute. On ne teste QUE ce qui est annoncé
        # indisponible : déclencher un vrai effet manette sur une machine qui en a une
        # presserait des boutons dans le jeu du propriétaire.
        codes = ("VIGEMBUS_MISSING", "UINPUT_MISSING", "UINPUT_PERMISSION_DENIED",
                 "EVDEV_MISSING", "UINPUT_PAD_FAILED", "GAMEPAD_UNSUPPORTED_DARWIN",
                 "PLATFORM_UNSUPPORTED")
        if caps.get("gamepad") is False:
            r = c.call("vigem-gamepad", {"button": "A", "holdMs": 1})
            err = str(r.get("error", ""))
            check("manette indisponible : l'erreur porte un code stable",
                  any(k in err for k in codes), err[:300] or json.dumps(r)[:300])
        else:
            print("  info: manette annoncee DISPONIBLE, aucun appui envoye "
                  "(un vrai effet presserait un bouton dans le jeu en cours).")

        if caps.get("keyboard") is False:
            r = c.call("interception-keys", {"keys": "space"})
            err = str(r.get("error", ""))
            check("clavier indisponible : l'erreur porte un code stable",
                  any(k in err for k in codes + ("QUARTZ_MISSING", "ACCESSIBILITY_DENIED",
                                                 "UINPUT_KB_FAILED")),
                  err[:300] or json.dumps(r)[:300])
        else:
            print("  info: clavier annonce DISPONIBLE, aucune touche envoyee "
                  "(elle partirait dans la fenetre active).")

        # 5) Nettoyage : release-pad puis shutdown doivent répondre, toujours.
        r = c.call("release-pad")
        check("release-pad repond", (r.get("result") or {}).get("released") is True,
              json.dumps(r, ensure_ascii=False)[:200])
        r = c.call("shutdown")
        check("shutdown repond", (r.get("result") or {}).get("shutdown") is True,
              json.dumps(r, ensure_ascii=False)[:200])
    finally:
        c.close()
        if c.stderr:
            print("\n  stderr du sidecar :")
            for l in c.stderr[-20:]:
                print("    | %s" % l)

    print("")
    ok = True
    for label, passed, detail in CHECKS:
        print(("  OK " if passed else "  KO ") + label)
        if not passed and detail:
            print("       %s" % detail)
        ok = ok and passed
    print("VERDICT:", "TOUT OK" if ok else "ECHEC")
    return 0 if ok else 2


if __name__ == "__main__":
    sys.exit(main())
