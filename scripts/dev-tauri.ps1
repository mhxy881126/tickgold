# TickGold Tauri dev launcher (MSVC x64 toolchain, robust to unregistered VS).
#
# Why this exists: cargo C crates (ring, libsqlite3-sys, rquickjs-sys, vswhom-sys)
# need cl.exe on PATH plus INCLUDE/LIB. A plain `pnpm tauri dev` in an ordinary
# PowerShell has none of these and fails with "failed to find tool cl.exe".
#
# Usage:
#   .\scripts\dev-tauri.ps1            # init toolchain and run `tauri dev`
#   .\scripts\dev-tauri.ps1 -Check     # only verify toolchain, do not launch
#
# ASCII-only on purpose: Windows PowerShell 5.1 parses .ps1 as GBK otherwise.

param(
    [switch]$Check
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# --- 1. Candidate MSVC toolchain locations (prefer vcvars, fall back to paths) ---
$vcvarsCandidates = @(
    'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat',
    'C:\Program Files\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat',
    'C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat',
    'C:\Program Files\Microsoft Visual Studio\2022\Enterprise\VC\Auxiliary\Build\vcvars64.bat'
)
$vcvars = $vcvarsCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1

# Import vcvars environment into this session when available.
if ($vcvars) {
    Write-Host "[dev] importing $vcvars"
    $out = cmd /c ('"{0}" >nul 2>&1 && set' -f $vcvars)
    foreach ($line in $out) {
        if ($line -match '^([^=]+)=(.*)$') {
            Set-Item -Path "Env:$($matches[1])" -Value $matches[2]
        }
    }
}

# --- 2. Resolve cl.exe: PATH first, then known BuildTools layout ---
$cl = Get-Command cl.exe -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source
if (-not $cl) {
    $toolRoots = @(
        'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC',
        'C:\Program Files\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC',
        'C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Tools\MSVC'
    )
    foreach ($tr in $toolRoots) {
        if (Test-Path $tr) {
            $ver = Get-ChildItem $tr -Directory | Sort-Object Name -Descending | Select-Object -First 1
            $candidate = Join-Path $ver.FullName 'bin\Hostx64\x64\cl.exe'
            if (Test-Path $candidate) { $cl = $candidate; break }
        }
    }
}
if (-not $cl -or -not (Test-Path $cl)) {
    throw 'cl.exe not found. Install the C++ desktop workload (MSVC v143) via Visual Studio Installer.'
}

$msvcBin = Split-Path $cl
$msvcVerDir = Split-Path (Split-Path (Split-Path (Split-Path $msvcBin)))
$msvcInclude = Join-Path $msvcVerDir 'include'
$msvcLib = Join-Path $msvcVerDir 'lib\x64'

# --- 3. Explicit compiler env (cc-rs uses CC/CXX directly; no PATH detection) ---
$env:CC = $cl
$env:CXX = $cl
$env:VCINSTALLDIR = Split-Path (Split-Path (Split-Path $msvcVerDir))
$env:VCToolsVersion = Split-Path -Leaf $msvcVerDir
$env:PATH = "$msvcBin;$env:PATH"

# --- 4. INCLUDE / LIB: keep vcvars values, append MSVC + Windows SDK fallbacks ---
$sdkRoots = @(
    'D:\Windows Kits\10',
    'C:\Program Files (x86)\Windows Kits\10'
)
$sdk = $sdkRoots | Where-Object { Test-Path $_ } | Select-Object -First 1
$sdkVer = $null
if ($sdk) {
    $incBase = Join-Path $sdk 'include'
    if (Test-Path $incBase) {
        $sdkVer = Get-ChildItem $incBase -Directory | Sort-Object Name -Descending | Select-Object -First 1 -ExpandProperty Name
    }
}

function Merge-PathVar($name, $extra) {
    $cur = [Environment]::GetEnvironmentVariable($name, 'Process')
    $parts = @()
    if ($cur) { $parts += $cur -split ';' | Where-Object { $_ } }
    foreach ($p in $extra) { if ($p -and (Test-Path $p) -and ($parts -notcontains $p)) { $parts += $p } }
    [Environment]::SetEnvironmentVariable($name, ($parts -join ';'), 'Process')
}

$incExtra = @($msvcInclude)
$libExtra = @($msvcLib)
if ($sdkVer) {
    $incExtra += (Join-Path $sdk "include\$sdkVer\ucrt")
    $incExtra += (Join-Path $sdk "include\$sdkVer\um")
    $incExtra += (Join-Path $sdk "include\$sdkVer\shared")
    $libExtra += (Join-Path $sdk "lib\$sdkVer\ucrt\x64")
    $libExtra += (Join-Path $sdk "lib\$sdkVer\um\x64")
}
Merge-PathVar 'INCLUDE' $incExtra
Merge-PathVar 'LIB' $libExtra

Write-Host "[dev] cl.exe      : $cl"
Write-Host "[dev] CC          : $env:CC"
Write-Host "[dev] SDK         : $sdkVer"
Write-Host "[dev] INCLUDE entries: $(([Environment]::GetEnvironmentVariable('INCLUDE','Process') -split ';').Count)"
Write-Host "[dev] LIB entries    : $(([Environment]::GetEnvironmentVariable('LIB','Process') -split ';').Count)"

if ($Check) {
    Write-Host '[dev] toolchain OK (check mode, not launching).' -ForegroundColor Green
    return
}

# --- 5. Launch tauri dev via the bundled CLI (bypasses pnpm pre-run checks) ---
Write-Host '[dev] starting tauri dev ...'
$tauriCli = Join-Path $root 'node_modules\@tauri-apps\cli\tauri.js'
if (Test-Path $tauriCli) {
    & 'C:\Program Files\nodejs\node.exe' $tauriCli dev @args
} else {
    pnpm tauri dev @args
}
exit $LASTEXITCODE
