# P1-c 设计：盘后自动流水线 + 8:45 确认提醒 + 命中率

> 状态：设计待评审　|　日期：2026-10-19　|　基线：P1-b 已合并 `a178c6a`
> 上游：[P1-b 设计](2026-10-19-plan-execution-p1b-design.md)

## 一、目标

1. **盘后自动流水线**：交易日 15:05 后自动跑「采集 → 分析 → 计划」，生成下一交易日作战卡（draft，不自动确认）。
2. **8:45 确认提醒**：交易日 8:45 若今日作战卡未确认（或未生成），应用内顶部横幅提醒，点击直达驾驶舱确认。
3. **命中率**：作战台显示近 20 个交易日「触发率 / 执行率 / 胜率」，胜率按**成交后现价浮盈**口径（BUY 现价 > 成交均价，SELL 相反）。

**非目标**：节假日日历、系统通知（本期只做应用内横幅）、历史回填超过 20 日。

## 二、调度器

新增 `ai/daily_schedule.rs`，setup 启动一次（AtomicBool 幂等），30s tick：

| 时段（Beijing，周一至五） | 动作 | 幂等键（meta 表） |
|---|---|---|
| 15:05–23:59 | 若下一交易日无计划 → 依次 `workflow_collect` → `workflow_analyze` → `workflow_plan` | `auto_after_close:{today}` |
| 08:45–09:30 | 今日计划未确认（或不存在）→ emit `battle:reminder` | `morning_reminder:{today}` |

- 计划已存在（任意状态）时盘后流水线**跳过**，避免覆盖用户手工生成/编辑的作战卡。
- 任一步失败：记日志、不写幂等键，下个 tick 重试；连续失败 3 次后写 `{key}:failed` 并 emit `battle:after-close-failed`。
- 启动补偿：应用在 15:05 后启动仍会补跑；8:45–9:30 之间启动仍会补提醒。
- 时间来源统一用 `market::spider::beijing()`（UTC+8）。

## 三、8:45 提醒

事件载荷：

```json
{ "kind": "plan-confirm", "planId": 0, "planDate": "2026-10-20", "status": "draft|missing", "text": "今日作战卡待确认（3 条指令）" }
```

前端 `ReminderBanner.vue`（App 级）监听 `battle:reminder`，顶部横幅显示文本 + 「去确认」+「稍后」：

- 「去确认」→ 打开驾驶舱 ③ 作战卡（复用现有卡片切换）；
- 「稍后」→ 关闭，本次运行不再弹（meta 已记，重启也不再弹）。

## 四、命中率

命令 `workflow_hit_rate(ai, days: Option<i64>) -> Value`（`days` 默认 20）：

- 取最近 N 个有计划的 `plan_date`（≤ 今天）。
- 指令范围：`tier IN ('candidate','trigger')`。
- 触发率 = 有关联条件单且 `status != 'active'`（或已有 `ticket_id`）的指令 / 总指令。
- 执行率 = 有 `signal_ticket.confirmed/done` 或 `broker_order` 的指令 / 已触发指令。
- 胜率 = `broker_order.status='filled'` 的成交里，按 `side` 与最新价比较为盈利的比例（BUY: 现价 > filled_avg_price；SELL: 现价 < filled_avg_price）。
- 输出：`{days, plans, instructions, triggered, triggeredPct, executed, executedPct, wins, winPct, samples}`；无样本时百分比为 `null`。
- 行情：`tencent::quotes` 批量取当前价（仅命令触发，不轮询）。

作战台头部展示：`近20日 触发 62% · 执行 45% · 胜率 58%`；样本 <3 显示「样本不足」。

## 五、测试与验收

**Rust 单测**
- 时段判定纯函数：15:04 不跑、15:05 跑、8:44 不提醒、8:45 提醒、周末不跑。
- 幂等键：同一天第二次调用不重复执行（meta）。
- 命中率：构造 5 条指令（2 触发、1 执行、1 盈利、1 亏损）→ 百分比正确；无样本 → null。

**前端单测**
- 百分比格式化（`null` → 「样本不足」，0/100 边界）。
- 提醒文案（draft vs missing）。

**e2e**
- fake `workflow_hit_rate` → 作战台头部显示三个百分比；
- 提醒横幅：通过 fake 事件总线（若 tauri fake 支持 `emit`）触发 `battle:reminder`，断言横幅与「去确认」按钮；不支持则在 fake 中注入 `window.__FAKE_EMIT` 辅助。

**验收**
1. 15:05 后自动生成下一交易日 draft 作战卡（已有计划则跳过）。
2. 8:45 横幅提醒，点击去确认；同一天不重复。
3. 作战台显示近 20 日触发/执行/胜率；样本不足有提示。
4. 不改变下单/风控路径；盘后流水线失败不影响已有计划。

## 六、风险

- 15:05 自动采集/分析依赖网络与数据源，失败只重试 3 次并告警，不写入半成品计划。
- 调度器与「按今日计划」逻辑共用 `next_trade_date`（仅跳周末）；节假日仍按工作日处理（与 P1-a 一致，后续补日历）。
- 胜率为浮盈口径，未实现卖出收益；UI 标注「浮盈胜率」避免误解。
