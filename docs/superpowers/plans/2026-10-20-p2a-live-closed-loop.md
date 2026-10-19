# P2-a 实施计划：实盘闭环（对账状态 + 自动对账 + 耗时 + 错误可解释）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** 对账状态常驻可跳转；live 重连自动对账；下单耗时/点击埋点；下单失败中文可解释。

**Architecture:** 新增 `broker/errors.rs`（错误映射）与 `broker_recon_status` 命令；`BrokerManager` 加 `recon_auto_pending`，持仓回填后自动 reconcile；前端 Guard 增正常态 chip，新增 `broker/timing.ts` 环形统计并在作战台展示。

## Global Constraints

- 仅包装错误文案，不改 `submit_with_sig` 逻辑；唯一提交入口不变。
- 自动对账只在 `cfg.kind != "mock"` 且缓存非空时执行；失败仅日志，不影响行情/持仓。
- 不新增迁移；对账报告沿用内存 + `broker:recon` 事件。
- 耗时统计纯前端 localStorage，环形 20 条；不阻塞/不影响下单。
- Node-only 单测；e2e 用 fake；UTF-8 无 BOM；clippy `-D warnings`、`pnpm build` 通过。

## File Structure

| 文件 | 职责 |
|---|---|
| `src-tauri/src/broker/errors.rs`（新） | `friendly(&str) -> String` + 测试 |
| `src-tauri/src/broker/mod.rs` | `recon_auto_pending`、自动 reconcile、`broker_recon_status`、错误包装 |
| `src-tauri/src/lib.rs` | 注册 `broker_recon_status` |
| `src/broker/timing.ts`（新） | 环形耗时统计 + 格式化 |
| `src/components/ReconciliationGuard.vue` | 正常/冲突 chip + `brokerReconStatus` 初始化 |
| `src/components/battle/BattleStation.vue` | `order-timing` 展示 |
| `src/components/battle/InstructionList.vue` / `OrderDock.vue` | 提交成功后记录耗时 |
| `tests/unit/order-timing.test.ts`（新） | timing 单测 |
| `tests/e2e/support/backend.ts` | fake `broker_recon_status` |
| `tests/e2e/battle-station.spec.ts` | 对账 chip + 耗时 e2e |

---

### Task 1: 后端（错误映射 + 对账状态 + 自动对账）

- [ ] 步骤 1：写失败测试
  - `errors::friendly`：UNIQUE、no rows、SQLITE_BUSY、timeout、not connected、未知原文。
- [ ] 步骤 2：实现 `errors.rs`；在 `broker_confirm_submit`/`broker_submit`/`broker_quick_order` 的 `Err` 出口套 `friendly`（保留「下单失败：」前缀语义）。
- [ ] 步骤 3：`BrokerManager` 加 `recon_auto_pending: AtomicBool`（初始 false）；`connected` 事件置 true。
- [ ] 步骤 4：`query_position` 响应更新缓存后：
```rust
if m.recon_auto_pending.swap(false, Ordering::SeqCst) {
    let cfg = m.config.lock().unwrap().clone();
    if cfg.kind != "mock" {
        let positions = m.position_cache.lock().unwrap().clone();
        if !positions.is_empty() {
            let app2 = app.clone();
            tauri::async_runtime::spawn(async move {
                // open db, reconcile("intraday"), update recon_report/conflict, emit broker:recon
            });
        }
    }
}
```
（注：`app`/`m` 在该作用域需 clone 出可用句柄；写库用 `maindb::open_readwrite`。）
- [ ] 步骤 5：`broker_recon_status(app) -> { conflict, connected, kind, report }`，lib.rs 注册。
- [ ] 步骤 6：单测 + `cargo test --lib` + clippy；提交 `feat(broker): 对账状态与断线自动对账、下单错误中文化（P2-a）`

### Task 2: 前端（对账 chip + 耗时埋点）

- [ ] 步骤 1：`timing.ts` + 单测（环形 20、中位数、空态、格式化）。
- [ ] 步骤 2：`ReconciliationGuard.vue`
  - 挂载调 `brokerReconStatus()`；监听 `broker:recon`；
  - `reconChip(report, now)` 纯函数（可单测）：无报告/超过 30 分钟 → 「未对账」muted；matched → 「对账正常 · N 分钟前」green；未匹配 → 「账实不符」red；
  - `data-testid="recon-chip"`，点击 `emit("island:open-card","brokerconsole")`。
- [ ] 步骤 3：`InstructionList` 确认下单、`OrderDock` 提交成功后 `recordOrderTiming`（`performance.now()` 从点击到返回，clicks=2）。
- [ ] 步骤 4：`BattleStation` 头部 `data-testid="order-timing"`，显示 `orderTimingSummary()`（最近/中位/击数），无记录不显示；每 5s 刷新时更新。
- [ ] 步骤 5：`pnpm test`、`pnpm build`；提交 `feat(ui): 对账状态常驻与下单耗时展示（P2-a）`

### Task 3: e2e + 全量验证

- [ ] 步骤 1：fake `broker_recon_status`（默认 matched，`__FAKE_RECON` 可切冲突）；`broker_confirm_submit` 已存在。
- [ ] 步骤 2：e2e
  - `recon-chip` 可见「对账正常」；切冲突后 chip 变「账实不符」且点击打开券商控制台卡片；
  - 提交一笔后 `order-timing` 可见（文本含「最近」）。
- [ ] 步骤 3：全量 `pnpm test`、`pnpm build`、battle e2e、全量 e2e、`cargo test --lib`、clippy。
- [ ] 步骤 4：提交 `test(e2e): 对账状态与下单耗时验收（P2-a）`

## Self-Review

- spec §二/§三/§四 均有任务；错误映射只包装出口；自动对账有 mock 跳过与空缓存跳过；耗时纯前端不影响下单。
- 风险：自动对账在 `query_position` 回调里 spawn，需避免持有锁跨 await（先 clone，再 spawn）。
