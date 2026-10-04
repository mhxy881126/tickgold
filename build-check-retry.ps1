# 本机 cargo check 重试脚本：双杀软（360/金山）实时扫描会映射 link.exe 输出文件，
# 间歇触发 LNK1105(1224)。串行(-j 2)+失败重试，已链接产物保留、逐步推进；
# 若出现 Rust 代码错误(error[E...])立即停止，不做无意义重试。
$env:Path = "C:\Users\Administrator\.cargo\bin;" + $env:Path
$vs = "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools"
Import-Module "$vs\Common7\Tools\Microsoft.VisualStudio.DevShell.dll"
Enter-VsDevShell -VsInstallPath $vs -Arch amd64 -HostArch amd64 -SkipAutomaticLocation 2>&1 | Out-Null

Set-Location "D:\Doubao-pek\股票盯盘系统·灵动岛版\src-tauri"
$log = "D:\Doubao-pek\股票盯盘系统·灵动岛版\check-retry.log"
$ok = $false
for ($i = 1; $i -le 30; $i++) {
    cargo check -j 2 --message-format=short 2>&1 | Out-File $log -Encoding utf8
    if ($LASTEXITCODE -eq 0) {
        Write-Output "CHECK_SUCCESS try=$i"
        $ok = $true
        break
    }
    $content = Get-Content $log -Raw
    if ($content -match "error\[E\d") {
        Write-Output "RUST_CODE_ERROR try=$i"
        break
    }
    if ($content -notmatch "link.exe|LNK1105|1105|D8050") {
        Write-Output "OTHER_FAIL try=$i"
        break
    }
    Write-Output "link conflict, retry $i"
    Start-Sleep -Seconds 3
}
Write-Output ("FINISH ok=" + $ok)
