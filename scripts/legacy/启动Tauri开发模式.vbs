' TickGold 股票盯盘系统 - Tauri 开发模式启动脚本
' 双击即可运行

Set WshShell = CreateObject("WScript.Shell")
Set objFSO = CreateObject("Scripting.FileSystemObject")

' 获取脚本所在目录
strScriptDir = objFSO.GetParentFolderName(WScript.ScriptFullName)

' 创建启动提示
intAnswer = MsgBox("即将启动 TickGold 股票盯盘系统（开发模式）" & vbCrLf & vbCrLf & _
    "首次启动需要编译 Rust，约 5-15 分钟" & vbCrLf & _
    "是否继续？", vbYesNo + vbQuestion, "TickGold 启动")

If intAnswer = vbNo Then
    WScript.Quit
End If

' 运行命令
strCommand = "cmd /k cd /d """ & strScriptDir & """ && pnpm run app:dev"

WshShell.Run strCommand, 1, False

' 提示
MsgBox "Tauri 开发模式已启动！" & vbCrLf & vbCrLf & _
    "请等待编译完成，应用窗口会自动弹出。" & vbCrLf & _
    "首次启动约需 5-15 分钟。", vbInformation, "TickGold 启动中"
