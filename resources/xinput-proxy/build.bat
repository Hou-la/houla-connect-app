@echo off
call "C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul
cd /d "%~dp0"
cl /nologo /D_CRT_SECURE_NO_WARNINGS /O2 /LD proxy.c /Fe:xinput1_4.dll /link /DEF:proxy.def /NOLOGO
if errorlevel 1 exit /b 1
copy /Y xinput1_4.dll xinput1_3.dll >nul
copy /Y xinput1_4.dll xinput9_1_0.dll >nul
echo BUILD_OK
