# 离线部署 Tauri 打包所需的 NSIS 工具集
# 适用场景：360/杀毒软件拦截 tauri 自动下载解压、企业内网、GitHub 访问不稳定。
# 用法：
#   1) 自动从 GitHub 下载：  pwsh -File scripts/setup-nsis-offline.ps1
#   2) 使用本地资源：        pwsh -File scripts/setup-nsis-offline.ps1 -NsisZip .\nsis-3.11.zip -NsisUtilsDll .\nsis_tauri_utils.dll
param(
  [string]$NsisZip = "",
  [string]$NsisUtilsDll = "",
  [string]$NsisVersion = "3.11",
  [string]$NsisUtilsVersion = "v0.5.3"
)

$ErrorActionPreference = "Stop"
$cache = Join-Path $env:LOCALAPPDATA "tauri"
$nsisDir = Join-Path $cache "NSIS"
$tmpZip = Join-Path $env:TEMP "nsis-$NsisVersion.zip"
$tmpDll = Join-Path $env:TEMP "nsis_tauri_utils.dll"

$nsisUrl = "https://github.com/tauri-apps/binary-releases/releases/download/nsis-$NsisVersion/nsis-$NsisVersion.zip"
$dllUrl  = "https://github.com/tauri-apps/nsis-tauri-utils/releases/download/nsis_tauri_utils-$NsisUtilsVersion/nsis_tauri_utils.dll"

Write-Host "==> Tauri 缓存目录: $cache"
New-Item -ItemType Directory -Force -Path $cache | Out-Null

# 1. 准备 nsis zip
if ($NsisZip -ne "" -and (Test-Path $NsisZip)) { Copy-Item $NsisZip $tmpZip -Force }
if (-not (Test-Path $tmpZip)) {
  Write-Host "==> 下载 NSIS $NsisVersion ..."
  Invoke-WebRequest $nsisUrl -OutFile $tmpZip -UseBasicParsing
}

# 2. 准备插件 dll
if ($NsisUtilsDll -ne "" -and (Test-Path $NsisUtilsDll)) { Copy-Item $NsisUtilsDll $tmpDll -Force }
if (-not (Test-Path $tmpDll)) {
  Write-Host "==> 下载 nsis_tauri_utils $NsisUtilsVersion ..."
  Invoke-WebRequest $dllUrl -OutFile $tmpDll -UseBasicParsing
}

# 3. 清理并解压（顶层目录名必须是大写 NSIS）
if (Test-Path $nsisDir) { Remove-Item $nsisDir -Recurse -Force }
$staging = Join-Path $cache "_nsis_extract"
if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
Expand-Archive -Path $tmpZip -DestinationPath $staging -Force
$top = Get-ChildItem $staging -Directory | Select-Object -First 1
Move-Item $top.FullName $nsisDir
Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue

# 4. 放置 Tauri 插件
$add = Join-Path $nsisDir "Plugins\x86-unicode\additional"
New-Item -ItemType Directory -Force -Path $add | Out-Null
Copy-Item $tmpDll (Join-Path $add "nsis_tauri_utils.dll") -Force

# 5. 校验必需文件
$required = @(
  "makensis.exe","Bin\makensis.exe","Stubs\lzma-x86-unicode","Stubs\lzma_solid-x86-unicode",
  "Plugins\x86-unicode\additional\nsis_tauri_utils.dll","Include\MUI2.nsh","Include\FileFunc.nsh",
  "Include\x64.nsh","Include\nsDialogs.nsh","Include\WinMessages.nsh","Include\Win\COM.nsh",
  "Include\Win\Propkey.nsh","Include\Win\RestartManager.nsh"
)
$missing = @()
foreach ($r in $required) { if (-not (Test-Path (Join-Path $nsisDir $r))) { $missing += $r } }
if ($missing.Count -gt 0) {
  Write-Warning ("缺失文件: " + ($missing -join ", "))
  exit 1
}

Write-Host "==> NSIS 离线部署完成: $nsisDir" -ForegroundColor Green
& (Join-Path $nsisDir "makensis.exe") /VERSION
Write-Host "现在可以运行: pnpm tauri build"
