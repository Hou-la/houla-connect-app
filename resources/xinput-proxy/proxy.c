/*
 * Hou.la Connect - proxy XInput.
 *
 * Depose dans le dossier d'un jeu sous le nom xinput1_4.dll (ou 1_3 / 9_1_0), il est
 * charge par le jeu AVANT celui de System32 (ordre de recherche des DLL). Il transfere
 * chaque appel au VRAI XInput de System32, SAUF qu'il REMAPPE l'index utilisateur : le
 * jeu, quand il lit le "Joueur 1" (index 0), lit en realite NOTRE manette virtuelle ; les
 * autres index sont masques. Ainsi un jeu qui ne lit que l'index 0 (ex. Meccha) recoit la
 * virtuelle (gestes recopies + cadeaux) sans qu'on touche aux slots XInput du systeme.
 *
 * L'index REEL de la virtuelle est ecrit par le sidecar dans
 *   %LOCALAPPDATA%\HoulaConnect\xinput_proxy.cfg   (un entier ; -1 = pas de remap).
 * Relu a chaud (toutes les ~400 ms) : sans pack actif -> transfert transparent.
 */
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>

typedef struct { WORD wButtons; BYTE bLeftTrigger; BYTE bRightTrigger; SHORT sThumbLX; SHORT sThumbLY; SHORT sThumbRX; SHORT sThumbRY; } XI_GAMEPAD;
typedef struct { DWORD dwPacketNumber; XI_GAMEPAD Gamepad; } XI_STATE;
typedef struct { WORD wLeftMotorSpeed; WORD wRightMotorSpeed; } XI_VIBRATION;
typedef struct { BYTE Type; BYTE SubType; WORD Flags; XI_GAMEPAD Gamepad; XI_VIBRATION Vibration; } XI_CAPS;
typedef struct { BYTE BatteryType; BYTE BatteryLevel; } XI_BATTERY;
typedef struct { WORD VirtualKey; WCHAR Unicode; WORD Flags; BYTE UserIndex; BYTE HidCode; } XI_KEYSTROKE;

#ifndef ERROR_DEVICE_NOT_CONNECTED
#define ERROR_DEVICE_NOT_CONNECTED 1167
#endif

typedef DWORD (WINAPI *fnGetState)(DWORD, XI_STATE*);
typedef DWORD (WINAPI *fnSetState)(DWORD, XI_VIBRATION*);
typedef DWORD (WINAPI *fnGetCaps)(DWORD, DWORD, XI_CAPS*);
typedef void  (WINAPI *fnEnable)(BOOL);
typedef DWORD (WINAPI *fnGetBatt)(DWORD, BYTE, XI_BATTERY*);
typedef DWORD (WINAPI *fnGetKey)(DWORD, DWORD, XI_KEYSTROKE*);
typedef DWORD (WINAPI *fnGetAudio)(DWORD, LPWSTR, UINT*, LPWSTR, UINT*);

static HMODULE gReal = NULL;
static fnGetState rGetState = NULL;
static fnGetState rGetStateEx = NULL; /* ordinal 100 */
static fnSetState rSetState = NULL;
static fnGetCaps  rGetCaps = NULL;
static fnEnable   rEnable = NULL;
static fnGetBatt  rGetBatt = NULL;
static fnGetKey   rGetKey = NULL;
static fnGetAudio rGetAudio = NULL;

static char gCfgPath[MAX_PATH] = {0};
static int  gVIdx = -1;
static DWORD gLastCfg = 0;
static char gSelfExe[MAX_PATH] = {0};  /* nom de NOTRE exe (minuscules), calcule une fois */
static char gTarget[MAX_PATH] = {0};   /* jeu vise par le pack actif (minuscules), "" = tous */

static void lowerStr(char* s) { for (; *s; ++s) if (*s >= 'A' && *s <= 'Z') *s += 32; }

static void initReal(void) {
    if (gReal) return;
    char path[MAX_PATH];
    UINT n = GetSystemDirectoryA(path, MAX_PATH);
    /* On charge TOUJOURS xinput1_4 (present sur Win10+, surensemble compatible), meme si
       ce proxy s'appelle xinput1_3/9_1_0 -> evite de se recharger soi-meme. */
    strcpy(path + n, "\\xinput1_4.dll");
    gReal = LoadLibraryA(path);
    if (!gReal) return;
    rGetState   = (fnGetState)GetProcAddress(gReal, "XInputGetState");
    rGetStateEx = (fnGetState)GetProcAddress(gReal, (LPCSTR)(ULONG_PTR)100);
    rSetState   = (fnSetState)GetProcAddress(gReal, "XInputSetState");
    rGetCaps    = (fnGetCaps) GetProcAddress(gReal, "XInputGetCapabilities");
    rEnable     = (fnEnable)  GetProcAddress(gReal, "XInputEnable");
    rGetBatt    = (fnGetBatt) GetProcAddress(gReal, "XInputGetBatteryInformation");
    rGetKey     = (fnGetKey)  GetProcAddress(gReal, "XInputGetKeystroke");
    rGetAudio   = (fnGetAudio)GetProcAddress(gReal, "XInputGetAudioDeviceIds");
    char* la = getenv("LOCALAPPDATA");
    if (la) snprintf(gCfgPath, MAX_PATH, "%s\\HoulaConnect\\xinput_proxy.cfg", la);
    /* Nom de l'exe qui nous a chargees : sert a ne remapper QUE le jeu vise. */
    char full[MAX_PATH];
    if (GetModuleFileNameA(NULL, full, MAX_PATH)) {
        char* base = strrchr(full, '\\');
        strncpy(gSelfExe, base ? base + 1 : full, MAX_PATH - 1);
        gSelfExe[MAX_PATH - 1] = 0;
        lowerStr(gSelfExe);
    }
}

/* Config ecrite par Hou.la Connect :
 *   ligne 1 : index XInput REEL de la manette virtuelle, ou -1 (= ne rien remapper)
 *   ligne 2 : nom de l'exe du jeu vise (optionnel ; vide = tout jeu)
 * Relue a chaud (~400 ms) : quand le pack s'arrete, elle repasse a -1 et la DLL
 * redevient un simple passe-plat -> le joueur joue normalement, aucun verrou. */
static void refreshCfg(void) {
    DWORD now = GetTickCount();
    if (now - gLastCfg < 400 && gLastCfg != 0) return;
    gLastCfg = now;
    gVIdx = -1;
    gTarget[0] = 0;
    if (!gCfgPath[0]) return;
    FILE* f = fopen(gCfgPath, "r");
    if (!f) return;
    int v = -1;
    if (fscanf(f, "%d", &v) == 1) gVIdx = v;
    if (fscanf(f, "%259s", gTarget) == 1) lowerStr(gTarget); else gTarget[0] = 0;
    fclose(f);
}

/* Retourne 1 si l'index de jeu est connecte (et pose *realIdx), 0 pour le masquer. */
static int mapIdx(DWORD gameIdx, DWORD* realIdx) {
    refreshCfg();
    if (gVIdx < 0) { *realIdx = gameIdx; return 1; } /* pas de pack actif -> transparent */
    /* Un pack tourne, mais pour UN jeu precis : tout autre jeu reste transparent. Ainsi
       plusieurs jeux peuvent avoir la DLL sans jamais se gener. */
    if (gTarget[0] && gSelfExe[0] && strcmp(gTarget, gSelfExe) != 0) { *realIdx = gameIdx; return 1; }
    if (gameIdx == 0) { *realIdx = (DWORD)gVIdx; return 1; } /* Joueur 1 = virtuelle */
    /* ⚠️ On NE MASQUE PLUS les autres emplacements (corrige le 2026-09-03).
       Avant : `return 0` pour tout index != 0, ce qui declarait « aucune manette » sur les
       emplacements 1 a 3. Consequence non voulue : la manette PHYSIQUE du joueur, et toute
       manette supplementaire, DISPARAISSAIENT de la liste du jeu vise. Pour un jeu qui lit
       betement le slot 0 c'etait sans effet visible ; pour un logiciel qui presente une LISTE
       (emulateurs, jeux SDL), c'est destructeur : le joueur ne trouve plus sa propre manette.
       On laisse donc passer, en masquant UNIQUEMENT l'emplacement reel de la virtuelle, sans
       quoi elle apparaitrait deux fois (une fois en Joueur 1, une fois a sa vraie place). */
    if (gameIdx == (DWORD)gVIdx) return 0;
    *realIdx = gameIdx;
    return 1;
}

DWORD WINAPI XInputGetState(DWORD idx, XI_STATE* st) {
    initReal();
    DWORD ri; if (!mapIdx(idx, &ri)) return ERROR_DEVICE_NOT_CONNECTED;
    return rGetState ? rGetState(ri, st) : ERROR_DEVICE_NOT_CONNECTED;
}
DWORD WINAPI XInputGetStateEx(DWORD idx, XI_STATE* st) {
    initReal();
    DWORD ri; if (!mapIdx(idx, &ri)) return ERROR_DEVICE_NOT_CONNECTED;
    if (rGetStateEx) return rGetStateEx(ri, st);
    return rGetState ? rGetState(ri, st) : ERROR_DEVICE_NOT_CONNECTED;
}
DWORD WINAPI XInputSetState(DWORD idx, XI_VIBRATION* v) {
    initReal();
    DWORD ri; if (!mapIdx(idx, &ri)) return ERROR_DEVICE_NOT_CONNECTED;
    return rSetState ? rSetState(ri, v) : ERROR_DEVICE_NOT_CONNECTED;
}
DWORD WINAPI XInputGetCapabilities(DWORD idx, DWORD flags, XI_CAPS* c) {
    initReal();
    DWORD ri; if (!mapIdx(idx, &ri)) return ERROR_DEVICE_NOT_CONNECTED;
    return rGetCaps ? rGetCaps(ri, flags, c) : ERROR_DEVICE_NOT_CONNECTED;
}
void WINAPI XInputEnable(BOOL e) { initReal(); if (rEnable) rEnable(e); }
DWORD WINAPI XInputGetBatteryInformation(DWORD idx, BYTE devType, XI_BATTERY* b) {
    initReal();
    DWORD ri; if (!mapIdx(idx, &ri)) return ERROR_DEVICE_NOT_CONNECTED;
    return rGetBatt ? rGetBatt(ri, devType, b) : ERROR_DEVICE_NOT_CONNECTED;
}
DWORD WINAPI XInputGetKeystroke(DWORD idx, DWORD res, XI_KEYSTROKE* k) {
    initReal();
    DWORD ri; if (idx != 0xFFFFFFFF) { if (!mapIdx(idx, &ri)) return ERROR_DEVICE_NOT_CONNECTED; } else ri = idx;
    return rGetKey ? rGetKey(ri, res, k) : ERROR_DEVICE_NOT_CONNECTED;
}
DWORD WINAPI XInputGetAudioDeviceIds(DWORD idx, LPWSTR r, UINT* rc, LPWSTR c, UINT* cc) {
    initReal();
    DWORD ri; if (!mapIdx(idx, &ri)) return ERROR_DEVICE_NOT_CONNECTED;
    return rGetAudio ? rGetAudio(ri, r, rc, c, cc) : ERROR_DEVICE_NOT_CONNECTED;
}

/* ── Ordinaux SANS NOM du vrai xinput1_4.dll ────────────────────────────────────
   Le vrai DLL exporte 100, 101, 102, 103, 104, 108 et 109 sans nom. Ne pas les exposer
   n'est PAS neutre : GetProcAddress renverrait NULL la ou Windows renvoie une fonction,
   et l'appelant se comporterait differemment selon qu'il charge notre DLL ou la vraie.

   @108 = XInputGetCapabilitiesEx. C'est LE point critique : SDL2 et SDL3 le resolvent par
   ordinal et s'en servent pour lire le VID/PID d'une manette, qui compose son GUID -- donc
   son identite, donc les affectations de touches enregistrees par le joueur. Sa signature
   est etablie par l'usage qu'en fait SDL : (a1, userIndex, flags, capsEx), l'index etant le
   DEUXIEME argument et non le premier. On y applique donc le meme remappage qu'ailleurs,
   sans quoi le jeu lirait l'identite d'une manette et les entrees d'une autre. */
typedef DWORD (WINAPI *fnGetCapsEx)(DWORD, DWORD, DWORD, void*);
DWORD WINAPI XInputGetCapabilitiesEx(DWORD a1, DWORD idx, DWORD flags, void* capsEx) {
    initReal();
    static fnGetCapsEx rCapsEx = NULL;
    if (!rCapsEx && gReal) rCapsEx = (fnGetCapsEx)GetProcAddress(gReal, (LPCSTR)(ULONG_PTR)108);
    DWORD ri; if (!mapIdx(idx, &ri)) return ERROR_DEVICE_NOT_CONNECTED;
    return rCapsEx ? rCapsEx(a1, ri, flags, capsEx) : ERROR_DEVICE_NOT_CONNECTED;
}

/* 101 a 104 et 109 : non documentes, signatures inconnues. On les relaie TELS QUELS, sans
   remappage (on ignore lequel de leurs arguments serait un index de manette : deviner
   ferait pire que ne rien faire). Huit arguments de la taille d'un pointeur suffisent a
   couvrir n'importe quelle signature raisonnable : dans la convention d'appel x64 de
   Microsoft, les quatre premiers passent par registre et les suivants par la pile, c'est
   l'APPELANT qui nettoie, donc transmettre des arguments en trop est sans consequence. */
typedef DWORD_PTR (WINAPI *fnAny8)(DWORD_PTR, DWORD_PTR, DWORD_PTR, DWORD_PTR,
                                   DWORD_PTR, DWORD_PTR, DWORD_PTR, DWORD_PTR);
static DWORD_PTR relaisOrdinal(int ord, DWORD_PTR a, DWORD_PTR b, DWORD_PTR c, DWORD_PTR d,
                               DWORD_PTR e, DWORD_PTR f, DWORD_PTR g, DWORD_PTR h) {
    initReal();
    if (!gReal) return (DWORD_PTR)ERROR_DEVICE_NOT_CONNECTED;
    fnAny8 fn = (fnAny8)GetProcAddress(gReal, (LPCSTR)(ULONG_PTR)ord);
    return fn ? fn(a, b, c, d, e, f, g, h) : (DWORD_PTR)ERROR_DEVICE_NOT_CONNECTED;
}
#define RELAIS(nom, ord) \
    DWORD_PTR WINAPI nom(DWORD_PTR a, DWORD_PTR b, DWORD_PTR c, DWORD_PTR d, \
                         DWORD_PTR e, DWORD_PTR f, DWORD_PTR g, DWORD_PTR h) { \
        return relaisOrdinal((ord), a, b, c, d, e, f, g, h); }
RELAIS(XInputProxyOrd101, 101)
RELAIS(XInputProxyOrd102, 102)
RELAIS(XInputProxyOrd103, 103)
RELAIS(XInputProxyOrd104, 104)
RELAIS(XInputProxyOrd109, 109)

/* Marqueur : permet a Hou.la Connect de reconnaitre SES propres DLL (y compris une version
   anterieure, lors d'une mise a jour) et de les remplacer, sans jamais toucher a une DLL
   xinput TIERCE livree par un jeu. Reference dans DllMain pour ne pas etre optimise out. */
static const char kHoulaProxyMarker[] = "HoulaConnectXInputProxy/1";

BOOL WINAPI DllMain(HINSTANCE h, DWORD reason, LPVOID r) {
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(h);
        if (kHoulaProxyMarker[0] == 0) return FALSE; /* garde le marqueur dans le binaire */
    }
    return TRUE;
}
