# v2.5.0 券商对接设计（QMT / xtquant 首适配）

> 日期：2026-10-03
> 状态：设计待评审（关键决策见文末「十三、待确认决策」）
> 归属版本：**v2.5.0**（路线图：券商对接，合规，后移）
> 前置：v2.3–v2.4 信号人工确认桥（signal_ticket / signal_audit / 指令模板 / 唤起券商）
> 技术依据：迅投 miniQMT + xtquant（XtQuantTrader）；Ptrade 外部对接非标准，本版不做

---

## 一、目标与边界

### 目标
把「人工已确认」的信号单，通过本地券商通道（首个适配 **QMT / xtquant**）真实委托下单，并把委托、成交、撤单、错误回报完整回灌到终端与审计链。

### 硬性边界（合规与安全，不可协商）
1. **只处理 `confirmed` 单据**：任何信号必须先经信号人工确认桥，不绕过人工确认。
2. **实盘默认关闭**：模式默认 `mock`（内置模拟）/ `disabled`；切到 `live` 需显式开关 + 风险二次确认。
3. **下单前风控二次校验**（Rust 侧，与 sidecar 无关）：交易时段、数量合法性、涨跌停、资金/持仓、仓位上限——任一不过即拒绝并审计。
4. **紧急停止（Kill Switch）**：一键断开 sidecar；可选一键全撤；立即生效，任何模型/流程不得拦截。
5. **全量审计**：broker_order 记录与 signal_audit 双写，状态流转全部可追溯。
6. 本项目不做投顾、不代客理财；AI 信号仅供参考，**不构成投资建议**。

---

## 二、总体架构

```
SignalBridge.vue                （confirmed 单据）
      │  broker_submit(sig_id)
      ▼
broker/mod.rs  BrokerManager    （模式开关 · 状态机 · 审计 · 事件）
      │  ① risk.rs 二次风控（纯函数）
      │  ② 写 broker_order（submitting）
      ▼
broker/sidecar.rs               子进程托管 + NDJSON(JSON-RPC over stdio)
      │  spawn: python.exe sidecar_qmt.py --qmt <userdata_mini> --account <账号>
      ▼
resources/broker/sidecar_qmt.py （xtquant 封装）
      │  XtQuantTrader(path, session).start/connect/subscribe
      ▼
miniQMT 客户端（极简模式登录）── 柜台
      │  回调 on_stock_order / on_stock_trade / on_stock_asset / on_stock_position
      ▼
sidecar 输出 NDJSON 回报 → sidecar.rs 解析
      │  更新 broker_order + signal_audit + emit("broker:event")
      ▼
SignalBridge / 灵动岛 / 委托视图即时刷新
```

### 关键取舍：stdio JSON-RPC，而非 HTTP（Laya 模式）
| 维度 | stdio JSON-RPC（选用） | HTTP sidecar（Laya 模式） |
| --- | --- | --- |
| 生命周期 | Tauri 启动/监控/退出，确定 | 需独立守护，易孤儿 |
| 攻击面 | 无端口、本机不可被其他进程访问 | 监听端口，本机进程可调用 |
| 崩溃检测 | 子进程退出即时感知 | 靠健康检查，滞后 |
| 远程部署 | 不支持（QMT 要求本机，无此需求） | 支持 |

> 协议采用 NDJSON（每行一个 JSON 帧）：请求带 `id`，回报/事件带 `event`；附心跳（见 §六）。

---

## 三、Python 环境策略（配置化，不硬绑定）

- 配置项：`python_path`（用户 Python，已 `pip install xtquant`）、`qmt_path`（QMT 客户端 `userdata_mini` 绝对路径）、`account_id`。
- sidecar 脚本随应用分发：`src-tauri/resources/broker/sidecar_qmt.py`，通过 Tauri resources 打包。
- 启动命令：
  `python_path sidecar_qmt.py --qmt qmt_path --account account_id [--mock]`
- 不内置/不强制安装 Python；未配置时引导，不白屏。
- xtquant 与 QMT 客户端版本需匹配（以 QMT 目录自带 xtquant 为准，可把 `python_path` 指向 QMT 内置 Python，或设置 `PYTHONPATH` 到 QMT 的 site-packages）。

---

## 四、数据模型（迁移 v46）

### broker_order（券商委托映射，sig_id 唯一）
```sql
CREATE TABLE IF NOT EXISTS broker_order (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sig_id TEXT NOT NULL UNIQUE,
  broker_kind TEXT DEFAULT 'mock',      -- qmt / mock
  broker_account TEXT DEFAULT '',
  broker_order_id TEXT DEFAULT '',      -- xtquant seq / 柜台委托号
  code TEXT NOT NULL,
  side TEXT DEFAULT '',                 -- BUY / SELL
  price REAL DEFAULT 0,
  vol INTEGER DEFAULT 0,
  status TEXT DEFAULT 'submitting',     -- 见状态机
  filled_vol INTEGER DEFAULT 0,
  filled_avg_price REAL DEFAULT 0,
  error_msg TEXT DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_broker_status ON broker_order(status);
CREATE INDEX IF NOT EXISTS idx_broker_code ON broker_order(code);
```

### 状态机
```
submitting ──► submitted ──► part_filled ──► filled
     │             │              │
     │             └──► cancelled ◄┘
     └──► error / rejected
```
- 每次流转：更新 broker_order + 写 signal_audit（action: `broker_submitted / broker_part_filled / broker_filled / broker_cancelled / broker_error`）+ `emit("broker:event")` + `wal_checkpoint(PASSIVE)`。
- signal_ticket 侧：broker_order 进入终态（filled）时联动 ticket 可标 `done`；cancelled/error 不自动改 ticket，由人工处理。

---

## 五、Rust 模块设计：`src-tauri/src/broker/`

| 文件 | 职责 |
| --- | --- |
| `mod.rs` | BrokerManager（配置、模式、状态机、命令注册、审计、事件） |
| `sidecar.rs` | 子进程 spawn/kill、stdin 写请求、stdout/stderr 读 NDJSON、心跳与超时、崩溃检测与重连 |
| `risk.rs` | 二次风控纯函数（输入订单+账户+时段，输出通过/拒绝原因），全部可单测 |
| `protocol.rs` | JSON-RPC 消息类型（submit/cancel/query 请求；order/trade/asset/position/heartbeat 回报） |
| `mock.rs` | 内置模拟适配器：无需 Python/QMT，按脚本产出部分成交→filled/可注入撤单与错误 |
| `config.rs` | broker 配置读写（app data 目录 `broker_config.json`），不硬编码 |

### Tauri 命令
- `broker_get_status`：模式、连接状态、sidecar 存活、账户、版本
- `broker_set_config`：python_path / qmt_path / account_id / kind
- `broker_enable_live`：实盘开关（带风险确认标记，前端二次弹窗）
- `broker_connect` / `broker_disconnect`
- `broker_submit(sig_id)`：读 confirmed ticket → risk 校验 → 写 broker_order → 发 sidecar
- `broker_cancel(broker_order_id)`
- `broker_list_orders(status?)`
- `broker_query_asset` / `broker_query_position`
- `broker_kill_switch(cancel_all: bool)`

### 风控（risk.rs）规则
1. 交易时段：9:30–11:30 / 13:00–15:00（卖出/撤单可放宽，按可配置）；14:55 后禁买入。
2. 数量 >0 且为 100 整数倍；价格 >0。
3. 不得涨跌停反向（买入时涨停拒、卖出时跌停拒，可配置覆盖）。
4. 买入：金额 ≤ 可用资金（留费用余量）；卖出：vol ≤ 可用持仓。
5. 单票/总仓位上限（复用配置）。
> 风控为**强制层**，sidecar/柜台错误不替代本地风控；拒绝即写 `broker_error` + signal_audit。

---

## 六、sidecar JSON-RPC 协议（NDJSON）

请求（Rust → sidecar）：
```json
{"id":"r1","method":"connect","params":{"qmt":"D:\\qmt\\userdata_mini","account":"12345678"}}
{"id":"r2","method":"submit","params":{"client_order_id":"SG...","code":"600519.SH","side":"BUY","price":1499.50,"vol":200}}
{"id":"r3","method":"cancel","params":{"broker_order_id":"..."}}
{"id":"r4","method":"query_asset"}
{"id":"r5","method":"query_position"}
{"id":"r6","method":"heartbeat"}
```
回报（sidecar → Rust）：
```json
{"event":"connected","account":"...","version":"..."}
{"event":"order","client_order_id":"SG...","broker_order_id":"...","status":"submitted"}
{"event":"order","client_order_id":"SG...","status":"part_filled","filled_vol":100,"filled_avg_price":1499.50}
{"event":"order","client_order_id":"SG...","status":"filled","filled_vol":200,"filled_avg_price":1499.50}
{"event":"order","client_order_id":"SG...","status":"cancelled"}
{"event":"error","client_order_id":"SG...","message":"..."}
{"event":"asset","cash":...,"market_value":...}
{"event":"position","code":"...","vol":...,"can_use_vol":...,"cost":...}
{"event":"heartbeat"}
```
- 心跳：每 5s；10s 无心跳判定 sidecar 失活 → 状态置 error、提示重连。
- sidecar 单实例、同步顺序处理；xtquant 回调线程把回报写入 stdout（加锁保证 NDJSON 不交错）。

---

## 七、sidecar_qmt.py 关键逻辑（要点）

1. `XtQuantTrader(qmt_path, session_id)` → `register_callback(Callback)` → `start()` → `connect()`（返回 0 成功）。
2. `subscribe(StockAccount(account_id))`。
3. `order_stock(account, code_with_suffix, order_type, vol, price_type, price)`：
   - A 股代码加后缀：沪 `.SH` / 深 `.SZ`；order_type：买入 23 / 卖出 24；price_type：限价 `xtconstant.FIX_PRICE`。
   - 返回 seq（非最终委托号），委托号以回调 `on_stock_order` 的 `order_id` 为准。
4. 回调：`on_stock_order(order)` / `on_stock_trade(trader_id, trade)` / `on_stock_asset` / `on_stock_position` → 转 NDJSON 输出。
5. `cancel_order_stock(account, order_id)`。
6. stdin 读命令循环；stdout 仅输出协议帧，日志走 stderr（落盘到 app data `broker_sidecar.log`）。
7. 连接失败/客户端未极简登录：输出 `error` 事件并以非零退出（Rust 感知）。

---

## 八、前端改动

1. **SignalBridge.vue（confirmed 视图）**
   - 新增「实盘发送 / 已委托」区域：显示 broker_order 状态、已成交数量/均价、撤单按钮。
   - 动作流：确认 →（按模式）复制/唤起/实盘发送；live 模式发送前弹风险确认。
2. **设置对话框 → 新增「券商交易」区**
   - 适配器：模拟（默认）/ QMT；python_path、qmt_path、account_id；连接测试（延迟/版本）。
   - 实盘开关（红色，二次确认文案）；Kill Switch 按钮（常驻可见）。
3. **灵动岛**：confirmed 后展示委托/成交胶囊（submitted 蓝、part_filled 橙、filled 绿、error 红）。
4. 委托视图默认**并入信号桥** confirmed/all；是否独立「券商委托」卡片作为可选项（见决策 4）。
5. API 层 `src/ai/api`（或新 `src/broker/api.ts`）封装命令与 `broker:event` 监听。

---

## 九、测试与验收

### 必过
- `vue-tsc --noEmit`、`vitest run`（含新增 broker 用例）、E2E（含 28 卡 fps≥50 基线）。
- `cargo test`（risk 各拦截路径 + 状态机 + mock 全链路）、`cargo clippy`。
### 场景验收
1. **mock 离线全链路**：submit → submitted → part_filled → filled，broker_order + signal_audit 完整，事件即时刷新。
2. 风控拦截：非交易时段 / 零股 / 涨跌停 / 资金不足 / 持仓不足 / 超仓位，均拒绝并审计。
3. 实盘默认关闭；切 live 有二次确认；Kill Switch 立即断开（+可选全撤）。
4. sidecar 崩溃/无心跳：状态置 error、不发新单、可重连。
5. **QMT 真实联调（环境就绪后）**：connect / query_asset / query_position / submit / cancel / 回报一致；建议先在 QMT 模拟环境验证。

---

## 十、范围与交付节奏

- **第 1 步（休市可做，不依赖 QMT）**：迁移 v46 + broker 框架 + risk + mock 适配器 + 前端配置/发送/回报/灵动岛 + 测试。→ 可在 10/8 前形成可离线验证的 v2.5.0-beta。
- **第 2 步（QMT 环境就绪后）**：sidecar_qmt.py 接入 + 真实连接/查询/下单/撤单联调（先模拟环境后实盘小额）。
- **Ptrade**：外部对接依赖券商 HTTP 外网能力、非标准，单独立项（v2.5.x 或并入 v2.6 插件生态评估）。

---

## 十一、风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 误下真实委托 | 默认 mock；live 二次确认；风控前置；Kill Switch；全程审计 |
| xtquant / QMT 版本不匹配 | 以 QMT 自带 xtquant 为准，配置化路径，连接时校验版本 |
| sidecar 与客户端连接失败（未极简登录/权限） | 明确引导极简模式；建议 QMT 装 D 盘；连接测试给出原因 |
| 回报丢失/状态不一致 | 心跳+超时；定时 query 对账；状态机只允许合法迁移 |
| 安全软件拦截未签名 sidecar/python | 文档说明；后续 Authenticode 签名（Backlog 高优） |

---

## 十二、合规声明

券商对接仅面向用户本人授权账户，须遵守券商与监管规定；TickGold 不提供投资顾问、不代客理财、不保证行情/信号准确；所有交易决策与后果由用户自行承担。

---

## 十三、待确认决策（开工前）

1. **QMT 开通/安装情况**：已开通并装本机 / 在其他机器 / 尚未开通？（决定本轮是否能真实联调，还是先交付 mock + 框架 beta）
2. **首个适配器确认 QMT（xtquant）**，Ptrade 后移——是否认可？
3. **sidecar 形态**：stdio JSON-RPC + 用户配置 Python（不内置 Python）——是否认可？
4. **券商委托 UI**：并入信号桥 confirmed 视图（推荐，改动集中）vs 新增独立「券商委托」卡片？
5. v2.5.0 是否按「先 mock beta（休市可交付）→ 再 QMT 真实联调」两步走？
