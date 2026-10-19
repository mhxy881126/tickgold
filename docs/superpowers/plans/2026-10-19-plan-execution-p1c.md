# P1-c 实施计划：盘后自动流水线 + 8:45 提醒 + 命中率

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** 15:05 自动生成次日作战卡（draft）；8:45 应用内横幅提醒确认；作战台显示近 20 日触发/执行/胜率。

**Architecture:** 新增 `ai/daily_schedule.rs`，setup 启动 30s tick，复用 `workflow_collect/analyze/plan` 与 `meta` 幂等键；新增 `workflow_hit_rate` 异步命令（复用 `tencent::quotes`）；前端新增 `ReminderBanner.vue` 与头部命中率。

## Global Constraints

- 只读/只生成 draft，不自动确认计划；已有计划（任意状态）时盘后流水线跳过。
- 通知仅应用内横幅（不新增系统通知插件）。
- 胜率口径：`broker_order.status='filled'`，BUY 现价 > `filled_avg_price`，SELL 相反；无样本返回 `null`。
- 调度时间统一 `market::spider::beijing()`；周一至周五；节假日暂不处理。
- 幂等：`meta` 键 `auto_after_close:{date}`、`morning_reminder:{date}`；失败重试最多 3 次再记 `:failed`。
- 不改变下单/风控路径；不新增迁移。
- Rust clippy `-D warnings`、`pnpm build`、单测与 e2e 全绿；UTF-8 无 BOM。

## File Structure

| 文件 | 职责 |
|---|---|
| `src-tauri/src/ai/daily_schedule.rs`（新） | 时段判定、盘后流水线、8:45 提醒、meta 幂等 |
| `src-tauri/src/ai/mod.rs` | 注册模块 |
| `src-tauri/src/setup.rs` | 启动 `ensure_daily_schedule` |
| `src-tauri/src/ai/hitrate.rs`（新） | 命中率查询与纯计算 |
| `src-tauri/src/ai/workflow_p1.rs` / `lib.rs` | 注册 `workflow_hit_rate` |
| `src/components/ReminderBanner.vue`（新） | 顶部提醒横幅 |
| `src/App.vue` | 监听 `battle:reminder` + 打开驾驶舱 |
| `src/components/battle/BattleStation.vue` | 头部命中率 |
| `src/stores/workflow.ts` | `hitRate` + `loadHitRate()` |
| `src/components/battle/hitRateModel.ts`（新） | 百分比/文案格式化（node 单测） |
| `tests/unit/hit-rate.test.ts`（新） | 格式化单测 |
| `tests/e2e/support/backend.ts` | fake `workflow_hit_rate`；事件总线辅助 |
| `tests/e2e/battle-station.spec.ts` | 命中率 + 提醒横幅 e2e |

---

### Task 1: 调度器（盘后流水线 + 8:45 提醒）

- [ ] 步骤 1：先写测试（`daily_schedule.rs`）
  - `should_run_after_close`: 周一 15:04 false，15:05 true，15:30 true，周六十点 false。
  - `should_remind`: 8:44 false，8:45 true，9:29 true，9:30 false，周日 false。
  - `meta_once`: 相同 key 第二次 `claim_meta` 返回 false。
- [ ] 步骤 2：实现纯函数 + `claim_meta(conn,key) -> bool`（`INSERT OR IGNORE INTO meta` 影响行数）。
- [ ] 步骤 3：`after_close(app)`：
  - 计算 `next = plan::next_trade_date(today)`；若 `plan::find_plan_id_by_date(dir,next)` 已存在 → `claim_meta` 后返回。
  - 依次 `workflow_p1::workflow_collect(app.state::<AiState>(), None, None).await`、`workflow_analyze(...)`、`workflow_plan(...)`；成功 `claim_meta` + `emit("battle:after-close", {nextDate})`。
  - 失败：读/写 `meta` 重试计数 `auto_after_close_attempts:{today}`，≥3 时 `claim_meta` 失败键并发 `battle:after-close-failed`。
- [ ] 步骤 4：`morning_reminder(app)`：
  - 今日计划：`resolve_plan` 或直接查 `plan_date=today`；`status != 'confirmed'` 或不存在 → `emit("battle:reminder", payload)`；`claim_meta`。
- [ ] 步骤 5：`run_loop` 30s + `ensure_daily_schedule`（AtomicBool），setup 启动。
- [ ] 步骤 6：`cargo test daily`、`cargo test --lib`、clippy；提交 `feat(ai): 盘后自动流水线与盘前确认提醒（P1-c）`

### Task 2: 命中率（后端 + 头部展示）

- [ ] 步骤 1：写失败测试（`hitrate.rs`）
  - 构造 5 条指令：2 触发、1 执行、1 盈利、1 亏损 → `triggeredPct=40`、`executedPct=50`、`winPct=50`。
  - 无样本 → 全 `null`。
- [ ] 步骤 2：`hitrate::compute(rows, prices) -> Value` 纯函数；`workflow_hit_rate(ai, days)` 异步：查询 + `tencent::quotes` 当前价，返回 `{days,plans,instructions,triggered,triggeredPct,executed,executedPct,wins,winPct,samples}`。
- [ ] 步骤 3：注册命令；`hitRateModel.ts` 格式化（`null`/`<3` → 样本不足）；`workflow` store `hitRate` + `loadHitRate()`（mount + 5 分钟）。
- [ ] 步骤 4：`BattleStation` 头部显示 `近20日 触发 x% · 执行 y% · 胜率 z%`（`data-testid="hit-rate"`）。
- [ ] 步骤 5：`pnpm test`、`pnpm build`、`cargo test`、clippy；提交 `feat(ui): 作战台命中率展示（P1-c）`

### Task 3: 提醒横幅 + e2e + 全量验证

- [ ] 步骤 1：`ReminderBanner.vue`
  - 监听 `battle:reminder`；顶部固定横幅，文本 + 「去确认」（`emit("island:open-card","cockpit")`）+「稍后」；
  - testid `reminder-banner` / `reminder-open` / `reminder-dismiss`；
  - App.vue 挂载。
- [ ] 步骤 2：fake 事件总线
  - `tests/e2e/support/` 的 tauri event fake 支持 `listen` 并暴露 `window.__fakeEmit(event, payload)`；若当前为 no-op，补最小实现。
  - fake `workflow_hit_rate` 返回固定 `{triggeredPct:62,executedPct:45,winPct:58,samples:12}`。
- [ ] 步骤 3：e2e
  - 命中率：`hit-rate` 文本包含 `62%`/`45%`/`58%`。
  - 提醒：`page.evaluate(() => window.__fakeEmit("battle:reminder", {...}))` → 横幅可见 → 点「去确认」→ 驾驶舱可见 / 点「稍后」→ 横幅消失。
- [ ] 步骤 4：全量验证（`pnpm test`、`pnpm build`、battle e2e、全量 e2e、`cargo test --lib`、clippy）。
- [ ] 步骤 5：提交 `test(e2e): 命中率与盘前提醒验收（P1-c）`

## Self-Review

- spec §二/§三/§四/§五 均有任务覆盖；无 TBD。
- 时段函数、meta 幂等、命中率纯函数均可单测；e2e 覆盖头部与横幅。
- 风险：`workflow_collect/analyze` 为 `async` 且带网络，调度器需 `tokio::spawn` 单飞，避免 tick 重入（AtomicBool `RUNNING`）。
