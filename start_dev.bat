@echo off
set PATH=C:\Users\Administrator\.cargo\bin;C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC\14.44.35207\bin\Hostx64\x64;%PATH%
set INCLUDE=C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC\14.44.35207\include;D:\Windows Kits\10\Include\10.0.22621.0\um;D:\Windows Kits\10\Include\10.0.22621.0\ucrt;D:\Windows Kits\10\Include\10.0.22621.0\shared
set LIB=C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC\14.44.35207\lib\x64;D:\Windows Kits\10\Lib\10.0.22621.0\um\x64;D:\Windows Kits\10\Lib\10.0.22621.0\ucrt\x64
cd /d D:\Doubao-pek\???????????
npm run tauri dev > tauri_dev.log 2>&1
