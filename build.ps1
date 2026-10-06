# 加载 MSVC 环境
$vsdevcmd = 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\VsDevCmd.bat'
$envOutput = cmd /c ""$vsdevcmd" -arch=amd64 && set" 2>&1
foreach ($line in $envOutput) {
    if ($line -match '^([^=]+)=(.*)$') {
        $name = $matches[1]
        $value = $matches[2]
        [Environment]::SetEnvironmentVariable($name, $value, 'Process')
    }
}
# 设置 cargo PATH
$env:PATH = 'C:\Users\Administrator\.cargo\bin;' + $env:PATH

# 开始编译
Set-Location 'D:\Doubao-pek\股票盯盘系统·灵动岛版\src-tauri'
Write-Output '=== cargo build started ==='
cargo build 2>&1
Write-Output '=== cargo build done, exit code:' $LASTEXITCODE
