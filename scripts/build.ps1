# 打包发布：输出 NSIS 安装包到 src-tauri/target/release/bundle/nsis/
# 用法： .\scripts\build.ps1
$ErrorActionPreference = "Stop"

$vc = "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
$root = Split-Path -Parent $PSScriptRoot

Set-Location $root
# 注意：不要在同一 cmd /c 行内写 set PATH=...%PATH%，cmd 解析整行时会提前展开
# %PATH%（vcvars 执行前），反而把 MSVC 工具链路径冲掉导致 link.exe 找不到。
cmd /c "`"$vc`" >nul 2>&1 && pnpm tauri build"
Write-Host ""
Write-Host "安装包位于: src-tauri\target\release\bundle\nsis\" -ForegroundColor Green
