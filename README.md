# 灵动盯盘（Stock Dock）

> 一个为「盯盘」而生的轻量跨平台 A 股桌面终端。Tauri 2.0 + Vue 3 + KLineChart。

## 当前进度（v0.1.0）



* ✅ 自选股实时行情（东财源，2s 轮询，红涨绿跌）

* ✅ 个股 K 线（日 / 周 / 月 / 分钟，新浪源）+ MA/VOL/MACD

* ✅ 股票搜索添加（东财搜索接口）

* ✅ 价格 / 涨跌幅预警引擎（系统通知 + 冷却去抖 + 陈旧行情不触发）

* ✅ 系统托盘常驻（显示主窗口 / 灵动岛 / 退出）

* ✅ **灵动岛悬浮窗**（无边框置顶毛玻璃，右上角，自动轮播，点击展开自选列表）

* ✅ **老板键 Alt+\`**（一键隐藏 / 恢复全部窗口）

* ✅ 灵动岛点股联动主窗口

* ✅ 本地持久化升级为 **SQLite**（tauri-plugin-sql，内置迁移，自动从旧 localStorage 迁移）

* ✅ **自选股分组**（新建 / 重命名 / 删除分组、分组内排序、跨分组移动）

* ✅ **行情多数据源容灾**：实时 东财→新浪→腾讯、K 线 新浪→腾讯、搜索 东财→腾讯；单源超时 / 空 / 异常自动切换，连续失败熔断 30s

* ✅ NSIS 图形化安装包（静默安装 / 卸载闭环已验证）

* ✅ **自动更新**（Tauri updater，minisign 签名产物 `.exe.sig`；顶栏 "检查更新"→下载→安装→自动重启）

* ⬜ Windows Authenticode 代码签名（消除首次启动 SmartScreen 提示）

## 发布与自动更新



1. 版本号在 `src-tauri/tauri.conf.json` 的 `version` 与 `package.json` 同步递增。

2. 打包时需提供签名私钥（已生成在 `src-tauri/keys/`，**切勿提交**）：



```
\$env:TAURI\_SIGNING\_PRIVATE\_KEY = Get-Content -Raw src-tauri\keys\stockdock.key

\$env:TAURI\_SIGNING\_PRIVATE\_KEY\_PASSWORD = "<你的私钥密码>"

.\scripts\build.ps1
```

产物：`灵动盯盘_<版本>_x64-setup.exe` 与同名 `.exe.sig`。



1. 把 `tauri.conf.json` → `plugins.updater.endpoints` 里的 `REPLACE_OWNER/REPLACE_REPO` 改成你的 GitHub 仓库。

2. 发版时：上传 `.exe` 与 `.exe.sig` 到 GitHub Release，并在 Release 中附 `latest.json`（格式见 Tauri updater 文档），客户端即能通过顶栏 "检查更新" 升级。

## macOS 支持与跨平台 CI

本仓库已配置为跨平台：`bundle.targets = "all"`，Windows 出 NSIS 安装包，macOS 自动出 `.dmg` + `.app`（图标用 `icons/icon.icns`，最低 macOS 10.15）。

**本机是 Windows，无法直接构建 macOS 包。** 推荐用仓库内置的 GitHub Actions 一键发版（`.github/workflows/release.yml`）：



1. 把代码推到 GitHub 仓库，在 Settings → Secrets 配 `TAURI_SIGNING_PRIVATE_KEY`（私钥完整内容）和 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。

2. 打标签推送：`git tag v0.1.2 && git push origin v0.1.2`。

3. Actions 会并行在 `windows-latest` 和 `macos-latest` 上打包、签名，产物自动汇总到同一个草稿 Release，发布即生效。

**macOS 首次运行 Gatekeeper**：未做 Apple 代码签名时，用户需右键 app →「打开」一次绕过；若有 Apple Developer 证书，按 workflow 里注释打开证书导入段并配置对应 secret 即可自动签名 + 公证。

## 开发启动（Windows）

已配好脚本，直接运行：



```
.\scripts\dev.ps1
```

> 脚本会自动加载 MSVC 编译环境并启动 Tauri dev（含 Vite 热更新）。

首次运行需：已安装 Node 22+、pnpm、Rust、VS Build Tools（C++ 桌面开发）。

## 打包安装包（Windows）



```
.\scripts\build.ps1
```

产物：`src-tauri\target\release\bundle\nsis\灵动盯盘_0.1.0_x64-setup.exe`（约 2 MB，复用系统 WebView2）。

**打包卡在&#x20;**`extracting NSIS`**&#x20;/&#x20;**`PermissionDenied 拒绝访问`**？**

多为 360 等杀毒软件拦截 tauri 自动「下载 NSIS 并解压出 makensis.exe」。先运行离线部署脚本，再重新打包：



```
.\scripts\setup-nsis-offline.ps1          # 自动下载并部署到 %LOCALAPPDATA%\tauri\NSIS

.\scripts\build.ps1
```

也可传入本地资源：`.\scripts\setup-nsis-offline.ps1 -NsisZip .\nsis-3.11.zip -NsisUtilsDll .\nsis_tauri_utils.dll`。

## 安装与验证



* **图形化安装**：双击 `灵动盯盘_0.1.0_x64-setup.exe`，按向导完成（默认安装到 `%LOCALAPPDATA%\灵动盯盘`，创建开始菜单快捷方式）。

* **静默安装**：`灵动盯盘_0.1.0_x64-setup.exe /S`

* **静默卸载**：安装目录下 `uninstall.exe /S`

* 已验证：静默安装 → 程序正常启动 → 静默卸载，文件、快捷方式、注册表项均正确释放与清除。

## 技术栈



* 壳：Tauri 2.0（Rust）

* 前端：Vue 3 + TypeScript + Vite + Pinia

* 图表：KLineChart

* 数据：实时行情 = 东财 / 新浪 / 腾讯（自动容灾）；K 线 = 新浪 / 腾讯；搜索 = 东财 / 腾讯

* 持久化：SQLite（Rust 端迁移建表，前端经 @tauri-apps/plugin-sql 读写）

## 目录



```
src/              前端（Vue）

\&#x20; api/            行情调用封装 + 类型

\&#x20; stores/         Pinia：自选股/行情/预警

\&#x20; components/     WatchList / StockChart

src-tauri/        Rust 后端

\&#x20; src/market/     行情源：mod(调度+熔断) / eastmoney / sina / tencent

\&#x20; src/lib.rs      命令注册 + SQLite 迁移 + 系统托盘 + 灵动岛窗口

scripts/          dev.ps1 / build.ps1
```

## 免责声明

行情数据来自公开接口，仅供学习与个人盯盘参考，不保证实时性与准确性，不构成投资建议。

## License

MIT