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
    return 0; /* les autres index sont caches au jeu vise */
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
