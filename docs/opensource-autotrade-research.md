# 开源 A 股自动交易项目调研（TickGold 借鉴清单）

> 调研时间：2026-10-19　数据来源：GitHub API / 各仓库 README 与源码（星数为调研当时快照）
> 关注点：同花顺客户端自动化、资产/持仓读取、闪电下单、全自动交易闭环、架构与风控

---

## 1. 结论先说

1. **同花顺 UI 自动化这条线，社区已经踩完了坑**：`easytrader` 定下了对外 API 契约，`easyths` 把工程化（队列、看门狗、多账户、验证码）做到了产品级，`THSAutoTrader` 把「闪电下单 + 控件 ID」验证到了控件级。
2. **架构上最值得对标的是 NautilusTrader**：Rust 原生、事件驱动、回测与实盘同一套引擎——和 TickGold 的 Rust + Tauri 技术栈最接近。
3. **合规是这个赛道的硬约束**：`easytrader` 仓库代码已被整体清空（README 仅剩 “Removed according to regulations.”），这是一次明确的行业警示；任何「代客交易 / 破解客户端 / 绕过券商风控」的玩法都不能碰。
4. TickGold 的 `broker/` 已经具备「风控闸门 + 订单状态机 + 多源对账 + sidecar 监管」的骨架，**真正缺的是执行层工程化细节**：单操作硬超时、操作队列、多账户原子切换、表格读取的严格校验、市价策略匹配。

---

## 2. 项目地图（按用途分组）

### A. 券商客户端自动化（与 TickGold 的 THS sidecar 直接对标）

| 项目 | Stars | 语言 | 最近更新 | 一句话 |
|---|---:|---|---|---|
| [shidenggui/easytrader](https://github.com/shidenggui/easytrader) | 10.3k | Python | 2026-10-16 | 同花顺/银河/华泰/国金/雪球/ miniQMT 的统一交易 API，事实标准 |
| [noimank/easyths](https://github.com/noimank/easyths) | 162 | Python | 2026-10-14 | pywinauto + FastAPI，操作队列/看门狗/多账户/验证码/MCP，工程化标杆 |
| [linlb/THSAutoTrader](https://github.com/linlb/THSAutoTrader) | 194 | Python | 2026-10-17 | 同花顺闪电下单 + 控件级操作 + Flask API + 悬浮球 |
| [LeekQuant/leekquant](https://github.com/LeekQuant/leekquant) | 100 | Jupyter | 2023-01-29 | 「韭菜下单」，同花顺自动下单的早期实践（已停更） |
| [tony4248/xiadan-gateway](https://github.com/tony4248/xiadan-gateway) | <10 | Python | 2026-07-31 | 把同花顺 `xiadan.exe` 包成 HTTP 网关，思路可参考 |

### B. QMT / miniQMT（「正规军」通道）

| 项目 | Stars | 语言 | 最近更新 | 一句话 |
|---|---:|---|---|---|
| [litaolemo/xtquant_big_convert](https://github.com/litaolemo/xtquant_big_convert) | 775 | Python | 2026-10-15 | 大 QMT 接口转 miniQMT 兼容层，平滑替换 |
| [zsrl/miniqmt-demo](https://github.com/zsrl/miniqmt-demo) | 240 | Jupyter | 2024-08-01 | 《miniQMT 实盘量化》系列教程代码 |
| [sunnysab/qmt-parser](https://github.com/sunnysab/qmt-parser) | 40 | **Rust** | 2026-04-17 | Rust 解析 QMT 本地行情/财务/分红数据 |
| [eyeglasses/single-stock-autotrading-china](https://github.com/eyeglasses/single-stock-autotrading-china) | 15 | Python | 2025-08-13 | 基于 miniQMT 的单票自动交易最小闭环 |

### C. 交易引擎 / 框架（架构参考）

| 项目 | Stars | 语言 | 最近更新 | 一句话 |
|---|---:|---|---|---|
| [nautechsystems/nautilus_trader](https://github.com/nautechsystems/nautilus_trader) | 30.3k | **Rust** | 2026-10-19 | Rust 原生、确定性事件驱动，回测/实盘同引擎 |
| [vnpy/vnpy](https://github.com/vnpy/vnpy) | 46.0k | Python | 2026-10-06 | VeighNa：Gateway 抽象 + 事件引擎 + OMS/组合/策略 |
| [QUANTAXIS/QUANTAXIS](https://github.com/QUANTAXIS/QUANTAXIS) | 11.3k | Python | 2026-09-18 | 数据/回测/模拟/交易/多账户，纯本地方案 |
| [wondertrader/wondertrader](https://github.com/wondertrader/wondertrader) | 6.4k | C++ | 2026-09-01 | C++ 高性能量化研发交易一站式框架 |
| [ling-0729/KHunter](https://github.com/ling-0729/KHunter) | 636 | Python | 2026-10-07 | A 股全流程：选股/择时/风控/回测/实盘 |

### D. 数据与研究

| 项目 | Stars | 语言 | 最近更新 | 一句话 |
|---|---:|---|---|---|
| [microsoft/qlib](https://github.com/microsoft/qlib) | 49.5k | Python | 2026-10-14 | AI 量化研究平台（因子/模型/RD-Agent） |
| [akfamily/akshare](https://github.com/akfamily/akshare) | 23.0k | Python | 2026-10-14 | 开源财经数据接口库 |
| [panghu11033/thsdk](https://github.com/panghu11033/thsdk) | 339 | Python | 2026-10-19 | 同花顺数据 SDK：行情/问财/自选/板块 |

### E. AI 交易代理

| 项目 | Stars | 语言 | 最近更新 | 一句话 |
|---|---:|---|---|---|
| [TauricResearch/TradingAgents](https://github.com/TauricResearch/TradingAgents) | 111.9k | Python | 2026-10-16 | 多角色 LLM 辩论式交易决策框架 |
| [guge199205-byte/quant-Trader](https://github.com/guge199205-byte/quant-Trader) | 11 | Python | 2026-10-08 | DeepSeek Agent 7×24 盯盘/决策/下单，通达信桥实盘 |
| [zhou343-de/stock-trader-ai](https://github.com/zhou343-de/stock-trader-ai) | 22 | Python | 2026-05-04 | 八层风控 + 37 因子自进化 |
| [Serennity007/awesome-stock-quant-skills](https://github.com/Serennity007/awesome-stock-quant-skills) | 33 | Python | 2026-10-19 | 炒股/量化 AI Skill 索引 |

---

## 3. 重点拆解

### 3.1 easytrader：对外 API 的事实标准

用法（摘自官方文档）：

```python
import easytrader
user = easytrader.use("ths")          # 通用同花顺；另有 yh_client / ht_client / gj_client
user.connect(r"C:\...\xiadan.exe")    # 手动登录到交易窗口后连上
user.balance        # 资金
user.position       # 持仓（当前持仓/可用/成本/市值/盈亏比例…）
user.buy("162411", price=0.55, amount=100)
user.sell(...); user.cancel_entrust(entrust_no)
user.today_trades; user.today_entrusts; user.auto_ipo()
server.run(port=1430)                 # 远端模式：remoteclient 跨进程调用
```

值得借鉴：

- **一套稳定的字段契约**：`balance / position / today_entrusts / today_trades` 的字段名（中文键）与其语义，TickGold 已经接近，但可以补 `auto_ipo`（一键打新）这类高频刚需。
- **远端服务器模式**：把 GUI 自动化进程与策略进程解耦，策略崩了不影响交易端；TickGold 的 sidecar 已经是进程隔离，但还缺一个**受控的本地 API**。
- **follower（跟单）**：跟踪聚宽/米筐模拟盘、雪球组合自动同步调仓——这是「模拟盘→实盘」很好的产品化路径。
- **风险提示**：仓库现已只剩 `README.md`，内容为 “Removed according to regulations.”，代码全部清空。**说明这条技术路线存在真实合规压力，产品必须默认模拟、实盘强确认、全程留痕。**

### 3.2 easyths：工程化做得最好

- **所有 GUI 操作单线程串行**：`OperationQueue` 用一个常驻执行线程消费队列，杜绝并发点击。
- **执行看门狗**：单操作硬超时（默认 10s），界面卡死时该操作以 `TIMEOUT` 收尾，**直接断连并重建执行线程**，后续操作快速失败而不是排队陪葬。
- **优先级队列 + 原子状态迁移**：`QUEUED→RUNNING` 只在消费线程持锁认领；取消只能把 `QUEUED` 迁到终态，避免「已取消却仍执行」。
- **多账户原子切换**：`account_state` 缓存「账户名 + 客户端列表序号」，Alt+序号切换与后续操作在**同一队列槽**完成；重连成功即清空缓存（客户端重启后账户集合不可信）。
- **市价策略按名称匹配**：同花顺「市价委托」下拉框的数量/顺序/中文写法都不固定，必须按关键词内容匹配，**绝不能按索引**（`execution_strategy.py` 里对 6 种策略做了变体词表）。
- **验证码**：本地 CRNN（ONNX）模型，可微调；比 pytesseract 稳。
- **能力覆盖**：限价/市价买卖、条件单（条件买/卖/撤/查）、撤单、持仓/资金/历史委托、国债逆回购、止损止盈。
- **接口层**：FastAPI + API Key + IP 白名单 + 限流中间件 + Web 控制台 + **MCP**（可被 AI 助手直接调用）。

对 TickGold 的映射：TickGold 的 sidecar 已有 `pywinauto/UIA`、`Ctrl+C` 表格读取、闪电下单（21/23）、验证码、截图、`selectors.json`、dry-run，**但缺少 3.2 里的前三项（看门狗 / 队列 / 多账户）**。

### 3.3 THSAutoTrader：控件级「闪电下单」

源码里的真实细节（可直接对照校准）：

- 目标窗口标题：`网上股票交易系统5.0`
- 快捷键：`F1` 买入页、`F3` 撤单/委托页、`F4` 持仓、`F5` 刷新
- 控件 ID：`1047` 表格内容区、`2405` 验证码图片、`30001/30002/30003` 全部撤单/撤买/撤卖
- 读表：点击内容区 → 清空剪贴板 → `Ctrl+C` → 轮询剪贴板（3s 内）→ TSV 解析
- **严格解析**：表头不能为空/重复、必须包含 `证券代码` 等必需列、每行列数必须与表头一致，否则报错
- **错误语义**：读不到剪贴板时明确报「不能据此判断无挂单」，绝不把「读失败」当「没有挂单」
- 窗口守护：5s 轮询，目标窗口最小化自动还原

其中「严格 TSV 解析」TickGold 已经直接移植过来了（`sidecar_client.py` 里的 `parse_tabular_data` 注释写明「移植自 THSAutoTrader」）；**还差的是控件 ID 兜底**（`1047 / 2405 / 30001-30003`）与「5s 窗口巡检」的完整闭环。

### 3.4 NautilusTrader：Rust 事件驱动引擎

- Rust core + Python 控制面；**deterministic event-driven architecture**；
- 同一套代码覆盖研究、确定性回测、实盘执行；
- 分层清晰：Adapter（交易场所接入）/ ExecutionEngine / RiskEngine / Cache / MessageBus。

对 TickGold：刚落地的 `BrokerChannel` trait 本质上就是 Adapter；订单状态机（`protocol.rs`）可以对齐业界 OMS 状态（Submitted/Accepted/PendingUpdate/Canceled/Filled/Rejected）+ 重连对账（已有 P1 多源对账）。**「回测与实盘同口径」**是目前 TickGold 最大的架构缺口。

### 3.5 vnpy / QUANTAXIS / KHunter

- **vnpy**：Gateway 抽象 + EventEngine + OMS/Portfolio + 策略应用，是国内「可插拔交易通道」的最佳范式。
- **QUANTAXIS**：多账户、分布式任务调度、数据/回测/模拟/交易一体化，适合看「多账户资金分账」。
- **KHunter**（A 股实战细节最值得抄）：
  - 实盘/回测**时点口径统一**：都是「信号日当天收盘」，实盘 T 日信号 → T+1 成交，回测硬钉前一根，防前视；
  - **大盘 ADX 仓位档位**（ADX>25 上升 → 100%；ADX<18 且上升且收盘>MA20 → 50%；其他 → 0%）；
  - 回测数据本地化 + 离线可复现 + 数据源无权限自动跳过并留痕。

### 3.6 AI 交易代理

- **TradingAgents**：多角色（多头/空头/风控/交易员）LLM 辩论，适合做「决策解释层」。
- **quant-Trader**：最值得抄的是它的**边界感**——
  - 「风控（确定性）：T+1/额度/涨跌停闸门 + 强平分钟守护 + 动态风险预算，**模型不可绕过**」；
  - 拒单自动延期重放、分钟级哨兵、分账子账户、盘后复盘写 memory、假设库证伪/验证。

对 TickGold 的启发：**AI 只做建议与编排，风控与执行永远是确定性代码**；AI 的每次决策要可回放、可归因。

---

## 4. TickGold 现状 vs 社区做法

| 能力 | TickGold 现状 | 社区最佳实践 | 建议 |
|---|---|---|---|
| THS 读资产/持仓 | `Ctrl+C` 表格 + UIA 读表，已移植严格 TSV 校验（表头唯一/列数/必需列）；失败帧带 `note` 且不覆盖缓存（P12-7） | 协议层把 `ok/err` 显式化，读失败绝不等于空仓 | 基本达标；可选把 `ok` 字段显式化 |
| 操作可靠性 | GUI 互斥锁 30s 超时；`submit` 起独立线程，但**无操作级看门狗**（卡死不断连、不重建） | easyths：单线程队列 + 10s 硬超时 + 卡死断连重建 + 线程退休 | **P0** 加看门狗与断连重建 |
| 闪电下单 | 键盘 21/23 固定数量 | 同花顺原生「闪电下单」+ 控件 ID | P1 补控件 ID 兜底 |
| 市价策略 | 固定闪电价 | 下拉框按名称关键词匹配 | P1 补 6 种市价策略 |
| 多账户 | 单 `--account`，无切换 | 原子切换 + 账户缓存 + 重连清空 | P1 补多账户 |
| 验证码 | pytesseract | 本地 CRNN ONNX + 可微调 | P2 换模型 |
| 条件单 | `conditional.rs`（自研） | 条件单/止损止盈/逆回购模板 | P1 补模板（逆回购=闲钱理财） |
| 对外接口 | 仅 Tauri IPC | REST + SDK + MCP | P2 本地受控 API（127.0.0.1 + token + 只读默认） |
| 订单状态机 | `protocol.rs` 迁移表 | OMS 标准状态 + inflight 对账 | 保持，补重连 inflight |
| 回测/实盘口径 | 回测卡片独立 | 同引擎、同时点口径、防前视 | **P1** 统一口径 |
| 风控 | `risk.rs` 多闸门 | 确定性风控前置、AI 不可绕过 | 保持并强化 |
| 合规 | 模拟优先/二次确认 | 不改客户端、不代客、强审计 | 持续强化 |

---

## 5. 建议落地顺序

**P0（1–2 天，收益最大、风险最低）**

1. sidecar 增加「单操作硬超时 + 卡死断连重建 + 执行线程退休」（对齐 easyths 看门狗，现有 30s 只是互斥锁超时，卡死线程仍会占着）；
2. 失败语义协议显式化：`asset/position/trades/pending` 增加 `ok:false` 分支（现在靠空数组 + `note`，下游容易误判）；
3. 关键操作埋点：操作名/耗时/结果/重试次数，供后续做看板。

**P1（约 1 周）**

4. 多账户原子切换（Alt+序号 + 账户缓存 + 重连清空）；
5. 市价委托策略按名称匹配（对手方最优/本方最优/五档即成剩撤…）；
6. 条件单模板：止损止盈、国债逆回购；
7. 回测与实盘统一「信号日收盘 / T+1 成交」口径，回测硬钉前一根防前视。

**P2（2–4 周）**

8. 本地受控 API（默认只读、下单需显式开启、token + 审计），为策略脚本/ MCP 留口；
9. 验证码换本地 CRNN ONNX；
10. QMT 通道作为「正规军」优先（TickGold 已有 `sidecar_qmt.py`，可参考 `xtquant_big_convert` 做兼容层）。

---

## 6. 合规红线（务必写进产品）

- 不修改、不破解券商/同花顺客户端，只做「用户操作模拟」（THSAutoTrader README 明确强调这一点）；
- 实盘默认关闭，开启需二次确认 + 限额 + 熔断 + 全量审计；
- 不做代客理财、不做收益承诺；
- **参考案例**：easytrader 仓库代码因监管原因被整体清空（README 仅剩 “Removed according to regulations.”），这条线随时可能被收紧。

---

## 7. 链接汇总

- easytrader：<https://github.com/shidenggui/easytrader> ｜ 文档 <https://easytrader.readthedocs.io/zh-cn/stable/usage/>
- easyths：<https://github.com/noimank/easyths> ｜ 文档 <https://noimank.github.io/easyths/>
- THSAutoTrader：<https://github.com/linlb/THSAutoTrader>
- leekquant：<https://github.com/LeekQuant/leekquant>
- xtquant_big_convert：<https://github.com/litaolemo/xtquant_big_convert>
- miniQMT demo：<https://github.com/zsrl/miniqmt-demo>
- qmt-parser (Rust)：<https://github.com/sunnysab/qmt-parser>
- NautilusTrader：<https://github.com/nautechsystems/nautilus_trader>
- vnpy：<https://github.com/vnpy/vnpy>
- QUANTAXIS：<https://github.com/QUANTAXIS/QUANTAXIS>
- WonderTrader：<https://github.com/wondertrader/wondertrader>
- KHunter：<https://github.com/ling-0729/KHunter>
- qlib：<https://github.com/microsoft/qlib>
- AKShare：<https://github.com/akfamily/akshare>
- thsdk：<https://github.com/panghu11033/thsdk>
- TradingAgents：<https://github.com/TauricResearch/TradingAgents>
- quant-Trader：<https://github.com/guge199205-byte/quant-Trader>
- stock-trader-ai：<https://github.com/zhou343-de/stock-trader-ai>
