; TickGold NSIS 安装钩子
; 安装 / 卸载前强制关闭正在运行的 TickGold（含托盘后台与子进程），
; 避免 tickgold.exe 被占用导致 "Error opening file for writing"，实现干净覆盖安装。

!macro NSIS_HOOK_PREINSTALL
  nsExec::Exec 'taskkill /F /IM tickgold.exe /T'
  Pop $0
  Sleep 600
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::Exec 'taskkill /F /IM tickgold.exe /T'
  Pop $0
  Sleep 400
!macroend
