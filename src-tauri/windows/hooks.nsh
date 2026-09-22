; TickGold NSIS 安装钩子
; 安装 / 卸载前强制关闭正在运行的 TickGold（主进程 + WebView2 渲染/GPU 子进程，
; 它们都叫 tickgold.exe），避免 exe 被占用导致覆盖后文件丢失。
;
; 注意：不能用 `taskkill /T`（结束进程树）——在 WebView2 多进程 / 孤儿进程场景下
; 会返回 255 且杀不干净；这里改为「多次 taskkill（不带 /T）+ PowerShell Stop-Process
; 兜底」，并 Sleep 等待文件句柄释放，实现干净的覆盖安装。

!macro NSIS_HOOK_PREINSTALL
  ; 第一轮常规结束
  nsExec::Exec 'taskkill /F /IM tickgold.exe'
  Pop $0
  Sleep 300
  ; 第二轮兜底，处理延迟退出的进程
  nsExec::Exec 'taskkill /F /IM tickgold.exe'
  Pop $0
  Sleep 300
  ; PowerShell 按名强制结束全部 tickgold 进程（对 taskkill 失败的进程有效）
  nsExec::Exec 'powershell -NoProfile -ExecutionPolicy Bypass -Command "Stop-Process -Name tickgold -Force -ErrorAction SilentlyContinue"'
  Pop $0
  Sleep 600
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::Exec 'taskkill /F /IM tickgold.exe'
  Pop $0
  Sleep 300
  nsExec::Exec 'powershell -NoProfile -ExecutionPolicy Bypass -Command "Stop-Process -Name tickgold -Force -ErrorAction SilentlyContinue"'
  Pop $0
  Sleep 400
!macroend
