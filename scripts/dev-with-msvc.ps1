# TickGold dev-mode launcher.
# Initializes the MSVC x64 toolchain (cl.exe / INCLUDE / LIB) and then runs
# `tauri dev`. Required because cargo needs these env vars to compile C crates
# (ring, libsqlite3-sys, rquickjs-sys, ...). Use ASCII-only to avoid GBK
# encoding issues under Windows PowerShell 5.1.

$ErrorActionPreference = 'Stop'

# 1. Import MSVC x64 environment
Write-Host "[dev] initializing MSVC x64 toolchain ..."
$vcvars = 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat'
$out = cmd /c ('"{0}" >nul 2>&1 && set' -f $vcvars)
foreach ($line in $out) {
    if ($line -match '^([^=]+)=(.*)$') {
        Set-Item -Path "Env:$($matches[1])" -Value $matches[2]
    }
}
$cl = Get-Command cl.exe -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source
if (-not $cl) { throw 'cl.exe not found; MSVC init failed' }
Write-Host "[dev] MSVC ready: $cl"

# 2. Start tauri dev (call the CLI directly via node to bypass pnpm's
#    pre-run dependency check)
Set-Location (Join-Path $PSScriptRoot '..')
Write-Host "[dev] starting tauri dev ..."
& 'C:\Program Files\nodejs\node.exe' 'node_modules/@tauri-apps/cli/tauri.js' dev
exit $LASTEXITCODE
