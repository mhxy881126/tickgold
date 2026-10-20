# ===== 手动设置 MSVC + Windows SDK 环境 =====
$msvc = "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC\14.44.35207"
$sdk = "D:\Windows Kits\10"
$sdkVer = "10.0.22621.0"

# PATH
$env:PATH = "$msvc\bin\Hostx64\x64;C:\Users\Administrator\.cargo\bin;$env:PATH"

# INCLUDE
$env:INCLUDE = "$msvc\include;$sdk\Include\$sdkVer\um;$sdk\Include\$sdkVer\ucrt;$sdk\Include\$sdkVer\shared"

# LIB
$env:LIB = "$msvc\lib\x64;$sdk\Lib\$sdkVer\um\x64;$sdk\Lib\$sdkVer\ucrt\x64"

# 验证
Write-Output "cl.exe: $(Get-Command cl.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source)"
Write-Output "cargo: $(Get-Command cargo.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source)"
Write-Output "INCLUDE length: $($env:INCLUDE.Length)"
Write-Output "LIB length: $($env:LIB.Length)"

# 编译
Set-Location "D:\Doubao-pek\股票盯盘系统·灵动岛版\src-tauri"
Write-Output "`n=== cargo build started ==="
cargo build 2>&1
Write-Output "`n=== cargo build done, exit: $LASTEXITCODE ==="
