@echo off
chcp 65001 >nul
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
set PATH=C:\Users\Administrator\.cargo\bin;%PATH%
cd /d "%~dp0"
echo [dev.bat] ¹¤×÷Ä¿Â¼: %CD%
npm run tauri dev
pause