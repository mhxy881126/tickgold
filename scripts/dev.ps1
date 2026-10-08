# 一键启动开发模式（自动加载 MSVC 环境）
# 双击或在 PowerShell 中运行： .\dev.ps1
$ErrorActionPreference = "Stop"

$vc = "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
$root = Split-Path -Parent $PSScriptRoot

Set-Location $root
# 注意：不要在同一 cmd /c 行内写 set PATH=...%PATH%，cmd 解析整行时会提前展开
# %PATH%（vcvars 执行前），反而把 MSVC 工具链路径冲掉导致 link.exe 找不到。
cmd /c "`"$vc`" >nul 2>&1 && pnpm tauri dev"
