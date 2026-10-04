# v2.6.0 插件生态设计（Plugin Ecosystem）

- 日期：2026-10-03
- 版本：v2.6.0（继 v2.5.0 券商对接之后）
- 路线依据：`docs/开发路线.md` —— v2.6.0「卡片 / 指标 / 数据源 / 策略插件、签名与沙箱」，前置「稳定 API」；插件市场排在 v3.0。
- 合规红线（延续 v2.5）：**不自动真实下单**；插件产生的任何交易信号一律落 pending 走人工确认 + 风控 + 审计；broker 实盘能力对插件**默认完全不开放**；不做投顾 / 代客理财。

---

## 1. 目标与范围

让第三方 / 自研代码以**受控、可审计、强隔离**的方式扩展 TickGold，而不引入 DOM 直连或 Tauri IPC 直连的攻击面。

### 两步交付
- **第 1 步（本 beta，离线可跑）**
  1. 插件包：文件夹 / `.tgplugin`（zip）+ `plugin.json` manifest。
  2. 双执行位：逻辑在后端 **QuickJS（rquickjs）**，UI 在前端 **`<iframe sandbox>`**。
  3. 统一 host API（实现集中在 Rust，单一权限口径）。
  4. 权限模型 + 安装授权 + 全量审计。
  5. 插件管理面板（发现 / 启停 / 卸载 / 开发者模式）。
  6. 两个内置示例插件（UI 微件、指标 + 数据源逻辑）。
- **第 2 步（后移）**：包签名强制校验、热重载 / 调试控制台、策略与动作扩展点、插件设置 UI 协议。
- **不做（v3.0）**：插件市场 / 在线分发 / 社区账号；Python、WASM 插件语言（单独立项）。

---

## 2. 插件包结构

### 2.1 目录形态
```
my-plugin/
├── plugin.json          # manifest（必需）
├── main.js              # 逻辑入口（QuickJS，可选；纯 UI 插件可无）
├── ui.js                # UI 入口（iframe 内执行，可选）
├── icon.svg / icon.png  # 图标（可选）
└── assets/              # 静态资源（可选，受白名单后缀）
```
`.tgplugin` = 上述内容打成 zip（zip 内允许单层根目录）。安装时解压到
`<app_data_dir>/plugins/<plugin_id>/`。

内置插件随安装包位于 `resources/plugins/<id>/`，运行时按只读加载，**不可卸载、可停用**。

### 2.2 manifest（plugin.json）
```json
{
  "id": "com.example.bias",
  "name": "自定义 BIAS 指标",
  "version": "1.0.0",
  "apiVersion": 1,
  "author": "example",
  "description": "……",
  "permissions": [
    "quotes:read",
    "kline:read",
    "watchlist:read",
    "signal:create",
    "store",
    "http://api.example.com/*"
  ],
  "main": "main.js",
  "ui": "ui.js",
  "widgets": [
    { "id": "bias-box", "title": "BIAS 指标块",
      "minW": 4, "minH": 3, "defaultW": 8, "defaultH": 4,
      "binding": "stock" }
  ]
}
```
字段约束：
- `id`：反向域名 / 点分段，仅 `[a-z0-9.-]`，全局唯一。
- `apiVersion`（int）：宿主据此协商；不兼容则拒绝加载并提示。
- `permissions`：见 §3；缺省为空（零能力）。
- `widgets`：声明 UI 扩展点（卡内微件），尺寸语义对齐 `WidgetDef`（12 列网格）。

---

## 3. 权限模型（最小授权 + 运行时强制）

### 3.1 scopes
| scope | 能力 | 默认 |
|---|---|---|
| `quotes:read` | 读实时行情快照 | 否 |
| `kline:read` | 读 K 线 / 分时 / 历史 | 否 |
| `watchlist:read` | 读自选股列表 | 否 |
| `signal:create` | 创建 **pending** 信号（仍需人工确认） | 否 |
| `store` | 插件私有 KV（隔离命名空间） | 否 |
| `log` | 写应用日志 | 是（始终） |
| `http(s)://<host>/*` | 出站 HTTP，**精确到 host / 路径前缀** | 否 |
| `dev:reload` | 热重载自身（仅开发者模式生效） | 否 |

**不提供**：`broker:*`、文件系统任意访问、执行进程、访问其他插件存储、读取凭据箱。

### 3.2 授权与强制
- 安装 / 启用前，面板列出该插件申请的全部权限（人类可读），用户显式同意才登记。
- host API 每次调用在 Rust 侧按 `(plugin_id, method/url)` 校验 scope；越权直接返回 `E_PERMISSION_DENIED` 并写 `plugin_audit`。
- HTTP：解析 URL，与 manifest 的 host / 前缀逐条匹配；禁止 IP 直连以外的私有网段（拦截 `127/8`、`10/8`、`172.16/12`、`192.168/16`、`169.254/16`、`[::1]`）。
- 运行中改权限 = 先停用再启用（重新授权）。

---

## 4. 运行时架构

```
┌──────────────────────────── 渲染进程（Vue） ───────────────────────────┐
│  widgets/registry.ts（静态 WIDGET_DEFS + 运行时 addWidgetDef）          │
│                                                                       │
│  插件微件 def.component = PluginWidgetHost.vue                        │
│        └─ <iframe sandbox="allow-scripts" srcdoc=…>                   │
│             ui.js + bridge shim（window.tickgold → postMessage）       │
│             ▲ parent→iframe(init/quote/params)  ▼ iframe→parent(rpc)   │
│                          │                                            │
└──────────────────────────┼────────────────────────────────────────────┘
                           │ invoke plugin_rpc(pluginId, method, params)
┌──────────────────────────┴──────────────────── 后端（Rust） ───────────┐
│  PluginManager（状态、目录、dev_mode）                                 │
│   ├─ host.rs  dispatch(plugin_id, method, params)：权限 + 执行（唯一）  │
│   ├─ engine.rs 每个启用插件一个 rquickjs::AsyncRuntime（常驻）          │
│   │     main.js：registerIndicator / registerDataSource / 钩子         │
│   └─ 数据：plugin_registry / plugin_kv / plugin_audit                  │
└───────────────────────────────────────────────────────────────────────┘
```

### 4.1 逻辑宿主：QuickJS（rquickjs）
- 依赖：`rquickjs`（features：`macro`、`loader`、`futures`），QuickJS C 源码由 `rquickjs-sys` 经 cc 编译，**无需系统安装、不依赖 v8**。
- 每个启用插件一个 `AsyncRuntime`（独立上下文、相互隔离）；停用 / 卸载即 `runtime` 销毁。
- host async 函数通过 `rquickjs` 的函数绑定注入，内部统一走 `host::dispatch`。
- **资源与故障控制**
  - `Runtime::set_interrupt_handler`：绑定 kill flag（停用 / 卸载时强制中断死循环）；另设 `set_memory_limit` / `set_max_stack_size`。
  - host 函数必须 **fail-soft**：禁止裸 `unwrap/expect`、锁中毒也要转成 JS `Error`，避免在 `panic=abort` 下拖垮进程。
  - JS 抛异常 / 引擎错误被捕获，标记该插件 `status=error`、发 `plugin:event`，**不影响主程序与其他插件**。
- **逻辑插件全部使用同步纯函数（async 只在 Rust 侧）**，数据由宿主注入，避免在 JS 侧实现 Promise 编排：
  - `tickgold.registerIndicator({id, name, compute(ctx)})`：`ctx`（含 kline 收盘价序列 / quote 快照）由 Rust 在调用前取好并注入；`compute` 同步返回数值。
  - `tickgold.registerDataSource({id, buildRequest(params), parseResponse(resp)})`：`buildRequest` 同步返回 `{url,method,body}`；Rust 做权限校验 + 实际 HTTP；`parseResponse` 同步转换响应。
  - 生命周期钩子 `onLoad()` / `onUnload()`（同步）。
  - 完整 async host API（quotes/kline/watchlist/signal/store/http）供 **UI 插件（iframe）** 经 `plugin_rpc` 使用；逻辑纯函数不直接发起网络 / 信号。

### 4.2 UI 宿主：sandbox iframe
- `PluginWidgetHost.vue` 渲染 `<iframe sandbox="allow-scripts">`（**不给 `allow-same-origin`**）：
  - iframe 无父页 DOM、无 Tauri IPC、无可凭据的同源网络；唯一对外通道是 `postMessage`。
  - `srcdoc` 注入：bridge shim（`window.tickgold.*` → postMessage RPC）+ 插件 `ui.js` + 初始上下文。
- 通信协议（带 request id，Promise 配对）：
  - 父 → iframe：`init`（widgetId、binding、初始 quote、参数）、`update`（quote / 参数变化）。
  - iframe → 父：`rpc`（method、params；宿主转 `plugin_rpc`）、`resize`（内容高度）、`error`。
- iframe 内提供完整独立 DOM 与轻量 `h(tag, attrs, children)` helper；**不打包框架**（插件可用原生 DOM）。
- 绑定股票行情由宿主在 `update` 中推送（宿主侧已有 quote 流），插件无需轮询。

---

## 5. Host API 清单（第 1 步）

命名空间 `tickgold.*`（QuickJS 为原生 async 函数；iframe 经 postMessage→`plugin_rpc`）：

| API | 需要权限 | 后端实现 |
|---|---|---|
| `quotes.get(codes)` | quotes:read | `market::get_quotes` |
| `kline.get(code, period, count)` | kline:read | `market::get_kline` |
| `kline.minute(code)` | kline:read | `market::get_minute` |
| `watchlist.list()` | watchlist:read | 主库 watchlist 表（只读） |
| `signal.create(input)` | signal:create | `ai::bridge::create_ticket`（**pending**），成功后 emit `signal:new` |
| `store.get(key)` / `store.set(key,val)` | store | `plugin_kv`（按 plugin_id 隔离） |
| `http.fetch(url, opts)` | 对应 host 权限 | reqwest（限方法 GET/POST、限大小、超时、私有网段拦截） |
| `log.info/warn/error(msg)` | log | 应用日志 |
| `indicator.compute(id,payload)` / `datasource.fetch(id,params)` | 同插件内部 | engine 回调该插件 main.js 注册的函数 |

返回统一形态：成功即数据；失败 `{ error: { code, message } }`。错误码：`E_PERMISSION_DENIED`、`E_TIMEOUT`、`E_BAD_REQUEST`、`E_NETWORK`、`E_PLUGIN_ERROR`、`E_NOT_FOUND`。

---

## 6. 数据模型（迁移 v47）

```sql
CREATE TABLE IF NOT EXISTS plugin_registry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plugin_id TEXT NOT NULL UNIQUE,
  name TEXT DEFAULT '',
  version TEXT DEFAULT '',
  api_version INTEGER DEFAULT 1,
  builtin INTEGER DEFAULT 0,
  source_path TEXT DEFAULT '',
  enabled INTEGER DEFAULT 0,
  signed INTEGER DEFAULT 0,
  signature TEXT DEFAULT '',
  hash TEXT DEFAULT '',
  permissions TEXT DEFAULT '[]',     -- JSON 数组快照
  status TEXT DEFAULT 'disabled',   -- disabled/ready/error
  error_msg TEXT DEFAULT '',
  installed_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS plugin_kv (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plugin_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT DEFAULT '',
  updated_at INTEGER NOT NULL,
  UNIQUE(plugin_id, key)
);

CREATE TABLE IF NOT EXISTS plugin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plugin_id TEXT NOT NULL,
  action TEXT DEFAULT '',
  method TEXT DEFAULT '',
  detail TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plugin_audit_pid ON plugin_audit(plugin_id);
```

---

## 7. Tauri 命令

| 命令 | 说明 |
|---|---|
| `plugin_list` | 列出已登记插件（含权限 / 状态 / 内置） |
| `plugin_scan` | 扫描用户 plugins 目录 + 内置 resources/plugins，发现未登记项（不启用） |
| `plugin_install(from_path)` | 导入文件夹 / `.tgplugin`：校验 manifest、算哈希、（第2步验签）、拷贝并登记为 disabled |
| `plugin_enable(plugin_id)` | 授权确认后：初始化 QuickJS、执行 main.js、注册微件，置 ready |
| `plugin_disable(plugin_id)` | 销毁 runtime、注销微件 |
| `plugin_uninstall(plugin_id)` | 停用并删除用户插件目录（内置拒绝） |
| `plugin_rpc(plugin_id, method, params)` | async：`host::dispatch`（权限 + 执行），iframe 与逻辑共用 |
| `plugin_get_dev_mode` / `plugin_set_dev_mode(on)` | 开发者模式（全局配置，默认 false；允许未签名 / 热重载） |
| `plugin_reload(plugin_id)` | 仅 dev 模式：重新加载 main.js/ui.js |

事件：`plugin:event`（启用 / 停用 / 错误 / 状态变化）、`signal:new`（插件创建信号时复用既有）。

---

## 8. 签名与完整性（第 1 步预留，第 2 步强制）

- 签名体系复用 updater 的 ed25519 / minisign；安装时记录文件哈希与签名状态。
- beta：**未签名可在开发者模式下加载**（默认关闭，需显式打开并提示风险）；普通模式下未签名插件拒绝启用。
- 第 2 步：内置信任公钥，校验签名链；加载前重算哈希，被篡改 → 拒绝并审计。

---

## 9. 内置示例插件（beta）

1. **`examples.plugin-quote-strip`（UI 微件，iframe）**
   - 一个自定义「报价大字条」：绑定股票，经 `quotes.get` 取数，用原生 DOM 渲染大字价格 / 自定义涨跌色 / 简单标签；演示 UI 扩展与 `update` 推送。
2. **`examples.plugin-bias`（QuickJS 逻辑 + iframe 微件）**
   - `main.js` 用 `registerIndicator` 注册 BIAS（乖离率，基于 `kline.get` 收盘价与均线）；`ui.js` 微件经 `indicator.compute` 取值并渲染数值 / 简单条形；演示逻辑宿主、指标注册与双宿主协作。

---

## 10. 验收标准（beta）

1. 干净源码 `cargo check` / `cargo test`（含 plugin 模块单测：manifest 解析、权限匹配、HTTP host 匹配与私网拦截、KV 隔离、状态）/ `cargo clippy` 无新增阻断。
2. 前端 `vue-tsc --noEmit` 0 错误；`vitest run` 全绿；registry 支持运行时增删且不破坏既有微件。
3. 离线（休市）可：扫描 → 安装 → 查看权限 → 启用两个示例插件 → 卡片中添加其微件并看到渲染 → 停用 / 卸载。
4. 越权调用（未声明 scope / 未授权 host）稳定被拒并写审计；插件 JS 异常 / 超时不崩溃主程序、不影响其他插件。
5. 插件创建的信号为 pending，出现在信号桥待确认，不绕过人工确认 / 风控。
6. release 构建成功，NSIS 包含 `resources/plugins` 与示例；末尾 updater 签名私钥缺失报错不影响安装包。

## 11. 风险与缓解

- **构建**：新增 C（QuickJS）编译 + `lto`/`panic=abort`/杀软/间隔号路径。先加依赖做最小 `cargo check` 验证，再铺开；继续用 `D:\tg-target` 与重试脚本。
- **安全**：iframe 无 same-origin + host 唯一权限口径；私网 / 域名白名单；host fail-soft；全量审计。
- **兼容**：apiVersion 协商；host API 保持向后兼容，废弃需跨版本过渡。
- **范围**：严格只做 beta；签名强制、市场、Python/WASM、策略动作一律后移。
