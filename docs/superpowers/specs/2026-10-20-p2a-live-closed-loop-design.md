# P2-a 设计：实盘闭环（对账状态 + 自动对账 + 耗时埋点 + 错误可解释）

> 状态：设计待评审　|　日期：2026-10-20　|　基线：P1-c 已合并 `66eda0e`
> 上游：[P0 路线图](../specs/2026-10-19-battle-station-p0-design.md#七后续阶段p0-之后)

## 一、目标

1. **对账状态常驻**：作战台/全局显示「对账正常 / 账实不符 / 未对账」，冲突时一键跳转券商控制台校准。
2. **断线自动对账**：live 通道重连并回填持仓后，自动跑一次 `intraday` 对账；冲突置 `recon_conflict`（已有）+ 横幅。
3. **实盘耗时埋点**：记录「确认下单 → broker 返回」的耗时与点击次数，展示最近一笔与近 20 笔中位数。
4. **失败可解释**：下单/提交路径的原始英文错误统一映射为中文（UNIQUE、no rows、IO、超时等）。

**非目标**：快捷键/菜单重构（P2-b）、系统通知、真实券商通道自动化测试。

## 二、后端

1. `broker_recon_status(app) -> Value`
   - 返回 `{ conflict, connected, kind, report }`；`report` 取内存最近一次（无则 null）。
2. 断线自动对账
   - `BrokerManager` 新增 `recon_auto_pending: AtomicBool`；`connected` 事件置 true。
   - `query_position` 响应更新 `position_cache` 后，若 `recon_auto_pending.swap(false)` 且 `cfg.kind != "mock"`，spawn 一次 `reconciliation::reconcile(dir, positions, "intraday", now)`，写 `recon_report`/`recon_conflict`，emit `broker:recon`。
   - 失败只记日志，不阻塞行情/持仓。
3. `errors::friendly(&str) -> String`（新 `broker/errors.rs`）
   - 规则：`UNIQUE constraint failed` → 「重复提交：同方向票据已存在」；`Query returned no rows` → 「未找到对应记录，请刷新后重试」；`database is locked`/`SQLITE_BUSY` → 「本地库忙，请稍后重试」；`timed out`/`timeout` → 「券商通道超时，请检查连接」；`not connected` → 「券商未连接」；其余原样返回。
   - 应用于 `broker_confirm_submit`、`broker_submit`、`broker_quick_order` 的 `Err` 出口（仅包装，不改逻辑）。
4. 单测：friendly 映射 5 例；`recon_status` 结构（mock）。
5. 不新增迁移。

## 三、前端

1. `ReconciliationGuard.vue`
   - 已有冲突横幅保留；新增**正常态 chip**：`data-testid="recon-chip"`，显示「对账正常 · 3 分钟前」/「未对账」；点击打开券商控制台。
   - 监听 `broker:recon` 更新；挂载时调 `brokerReconStatus()` 初始化。
   - 冲突时 chip 变红「账实不符」。
2. 耗时埋点 `src/broker/timing.ts`（纯函数）
   - `recordOrderTiming({ ms, clicks, ok, at })` 写 localStorage 环形 20 条；
   - `orderTimingSummary()` → `{ lastMs, medianMs, clicks, count }`；
   - `InstructionList` 确认下单与 `OrderDock` 提交成功后调用；展示在作战台头部 `data-testid="order-timing"`（「最近下单 2.1s / 2 击」），无记录不显示。
3. 单测：timing 环形/中位数/空态；格式化毫秒。

## 四、测试与验收

**Rust**：friendly 映射、recon_status、自动对账分支（可注入 positions 的纯函数测试，连接事件难测则记录原因）。
**前端**：timing 单测；Guard chip 逻辑（纯函数 `reconChip(report, now)`）。
**e2e**：
- fake `broker_recon_status` 返回正常 → `recon-chip` 可见「对账正常」；
- fake 返回冲突 → chip 红色「账实不符」，点击打开 `brokerconsole` 卡片；
- fake `broker_confirm_submit` 返回成功 → 操作后 `order-timing` 可见。

**验收**
1. 对账状态常驻且冲突可跳转。
2. live 重连后自动对账一次（代码路径 + 日志；无真机则以单测覆盖分支）。
3. 实盘/模拟下单后显示耗时与点击数；近 20 笔中位数可查。
4. 常见下单失败全部中文（映射测试）。
5. 风控/唯一提交入口不变。

## 五、风险

- 自动对账依赖持仓缓存新鲜度；缓存空时跳过并保持「未对账」。
- 耗时含 IPC 与闸门校验，不拆分子阶段；仅作体验指标。
- 错误映射只做常见模式，未知错误保留原文并加「下单失败：」前缀。
