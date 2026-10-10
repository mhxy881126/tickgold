# TickGold Tauri 启动指南

## ⚠️ 先做这一步：确认 C++ 编译环境

根据你之前的截图，报错是 `cl.exe not found`，说明缺少 MSVC 编译工具。

### 快速安装（推荐，约 5 分钟）

按下 `Win + X` → 选择「终端(管理员)」，粘贴执行：

```powershell
winget install Microsoft.VisualStudio.2022.BuildTools --override "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended --passive --wait"
```

等待安装完成（约 2-5GB），然后**重启终端**。

---

## 🚀 启动 Tauri 开发模式

### 方式一：双击启动（最简单）

双击项目根目录下的 **`启动Tauri开发模式.vbs`** 或 **`启动开发模式.bat`**

### 方式二：命令行启动

在项目目录打开终端，执行：

```bash
pnpm run app:dev
```

---

## ⏱️ 启动时长说明

| 阶段 | 耗时 | 说明 |
|------|------|------|
| 首次启动 | 5-15 分钟 | 编译所有 Rust 依赖包 |
| 代码修改后重启 | 30秒-2分钟 | 增量编译 |
| 纯前端修改 | 热更新 | 秒级刷新 |

首次启动慢是正常的，耐心等待即可！

---

## 🌐 纯前端预览（不需要 Rust 没装好也能先看界面）

如果暂时不想装 C++ 工具，可以先启动前端预览：

```bash
pnpm run dev
```

然后浏览器打开 `http://localhost:5173`

---

## ✅ 启动成功标志

看到类似输出：

```
    Finished dev [unoptimized + debuginfo] target(s) in 5m 32s

app:dev:
app:dev:  > Tauri 开发服务器已启动
app:dev:  > 正在加载: 窗口已打开
```

然后会弹出一个桌面应用窗口，就是成功了！

---

## 🔧 常见问题

### Q: 还是报 "cl.exe not found
A: 安装 Visual Studio Build Tools，见上方说明

### Q: 报 "WebView2" 错误
A: 下载安装：https://developer.microsoft.com/microsoft-edge/webview2/

### Q: pnpm 命令找不到
A: 先执行：`npm install -g pnpm`

### Q: Rust 没装过还是报错
A: 执行：
```bash
rustup default stable-msvc
rustup update
```

### Q: 编译特别慢
A: 配置国内源：
在 `src-tauri/.cargo/config.toml` 添加：
```toml
[source.crates-io]
replace-with = 'rsproxy'
[source.rsproxy]
registry = "https://rsproxy.cn/crates.io-index"
```
