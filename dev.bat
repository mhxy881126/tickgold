@echo off
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
set PATH=C:\Users\Administrator\.cargo\bin;%PATH%
cd /d D:\Doubao-pek\股票盯盘系统·灵动岛版
npm run app:dev
