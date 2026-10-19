# P1-a 设计：计划指令状态机 + 物化 + 只读列表

> 状态：设计待评审　|　日期：2026-10-19　|　基线：TickGold v3.11.1（作战台 P0 已合并 `cbb0f25`）
> 上游：[作战台 2.0 · P0](2026-10-19-battle-station-p0-design.md)　|　本次只做 P1-a，P1-b/c 另行设计

## 一、背景与目标

P0 的作战台只展示「计划股 + 实时涨幅」，计划与执行之间仍然断链：确认作战卡只会生成预警（`confirm_plan_alerts`），不会生成可执行对象；用户盘中仍要手动判断、手动开条件单。

P1-a 把「作战卡指令」接进已有的条件单触发引擎，并让作战台看到每条指令的实时状态。

**目标**

1. 确认作战卡后，`candidate` / `trigger` 指令自动物化为条件单（结构化触发）。
2. 重复确认、重新生成计划都不会产生重复/孤儿条件单。
3. 作战台显示指令状态：仅观察 / 待触发 / 已触发 / 已下单 / 已成交 / 已取消 / 已过期。
4. 状态在 10s 内可见（触发事件 + 本地轮询）。

**非目标（P1-b/c）**

- 触发条件在 UI 上编辑、触发后一键下单按钮
- 盘后 15:05 自动流水线与 8:45 提醒
- 命中率/胜率统计
- 实盘自动下单（仍保持人工确认）

## 二、复用与新增

### 复用（不改语义）

| 能力 | 位置 |
|---|---|
| 触发引擎（行情轮询 → 叶子判定 → `co:triggered`） | `src-tauri/src/market/alert.rs` |
| 触发后建票 / 模拟盘自动确认 / 实盘留人工 | `broker::handle_co_triggered` |
| 条件单 CRUD 与状态 | `broker/conditional.rs`（active/triggered/cancelled/expired/done） |
| 计划与指令 | `ai/plan.rs`（`plan_instruction.alert_rule` 已存结构化 JSON） |
| 下单唯一入口 | `broker::submit_with_sig` |

### 新增

1. **列**（`plan_instruction`，`ALTER TABLE` 幂等补列）：`co_id TEXT DEFAULT ''`、`trigger_json TEXT DEFAULT ''`、`synced_at INTEGER DEFAULT 0`。
2. **物化器** `ai/instruction.rs::materialize_plan`：把 `alert_rule` 映射为 `CoTrigger` 叶子，建条件单并回填 `co_id`。
3. **状态推导** `derive_state(co_status, ticket_status, order_status)`：读取时计算，**不落库**，避免双写漂移。
4. **读取命令** `workflow_instructions(trade_date)`：返回指令 + 链接对象状态。
5. **前端** `InstructionList.vue` + workflow store `instructions`；作战台每 5s 刷新（只读本地库）。

## 三、触发映射（alertRule → CoTrigger）

`alert_rule` 是 `plan_instruction` 已有的 JSON 字段，规则计划会写入（LLM 计划则可能为空）。映射表：

| alertRule 键 | CoTrigger.field | op | 说明 |
|---|---|---|---|
| `upPrice` | `price` | `gte` | 触发价 |
| `downPrice` | `price` | `lte` | 止损价 |
| `upPct` | `pct` | `gte` | 涨幅 |
| `downPct` | `pct` | `lte` | 跌幅 |
| `minVolumeRatio` | `volumeRatio` | `gte` | 量比 |
| `minTurnover` | `turnover` | `gte` | 换手率 |
| `minAmount` | `amount` | `gte` | 成交额（亿） |
| `riseSpeed` | `riseSpeed` | `gte` | 涨速，`params.windowSec` |
| `downSpeed` | `downSpeed` | `gte` | 跌速 |
| `sealLimitUp` | `sealUp` | `gte` | 封涨停 |
| `sealLimitDown` | `sealDown` | `gte` | 封跌停 |
| `brokenLimit` | `broken` | `gte` | 炸板 |

- 一个 `alert_rule` 可产出多个叶子，数组内 AND。
- 没有任何可映射叶子 → 该指令保持「仅观察」，不建条件单。
- 数量 `vol` 取 `alert_rule.vol`（默认 100，且必须为 100 整数倍；非法则跳过并记 `note`）。
- `side` 取 `alert_rule.side`（默认 `BUY`）。
- `price_mode="trigger"`、`ttl="day"`、`expire_at=now+24h`、`auto_confirm=true`。
  - `auto_confirm=true` 只影响模拟盘：`handle_co_triggered` 内部仍要求 `cfg.kind=="mock"` 才自动推进，实盘保持人工确认。
- `note = "plan:{plan_id}:{instr_id}"`。

## 四、状态机（读取时推导）

输入：`co_status`（无 / active / triggered / cancelled / expired / done）、`ticket_status`（无 / pending / confirmed / rejected / done）、`order_status`（无 / submitting / submitted / part_filled / filled / rejected / cancelled）。

| 条件 | 状态 | 展示 |
|---|---|---|
| 无 `co_id` | `watch` | 仅观察 |
| `co_status=active` | `pending` | 待触发 |
| `co_status=triggered` 且无票 | `triggered` | 已触发 |
| 票 `pending` | `triggered` | 已触发（待确认） |
| 票 `confirmed` + 委托 submitting/submitted/part_filled | `submitted` | 已下单 |
| 委托 `filled` 或票 `done` | `filled` | 已成交 |
| `co_status=cancelled` 或票 `rejected` | `cancelled` | 已取消 |
| `co_status=expired` | `expired` | 已过期 |

推导为纯函数，Rust 单测覆盖所有分支；前端只做文案/配色映射。

## 五、物化时机、幂等与清理

- **时机**：`workflow_plan_confirm` 在 `confirm_plan_alerts` 之后调用 `materialize_plan`；返回新建条数写入 mission snapshot。
- **幂等**：指令 `co_id` 已存在且对应条件单存在 → 跳过；条件单被取消/过期后不自动重建（用户需重新确认计划）。
- **重新生成计划**：`plan::save_plan` 重建指令前，先按旧指令的 `co_id` 取消仍 active 的条件单，避免孤儿单继续触发。
- **失败隔离**：单条指令物化失败只跳过该条（写 `synced_at` 与日志），不阻断计划确认。

## 六、读取 API

```rust
#[tauri::command]
pub fn workflow_instructions(ai: State<AiState>, trade_date: Option<String>) -> Result<Value, String>
```

- 取 `plan_date = next_trade_date(trade_date)` 对应计划；
- 单条 SQL 左联 `conditional_order` → `signal_ticket` → `broker_order`；
- 返回：`id/tier/code/name/condition/action/positionHint/coId/triggerJson/state/triggeredAt/filledVol/filledAvgPrice`；
- 计划不存在 → `{ plan: null, instructions: [] }`。

## 七、前端

- `src/components/battle/instructionModel.ts`：`state → { label, tone }` 映射（node 单测）。
- `src/components/battle/InstructionList.vue`：
  - 最多 5 条，按 `sort`；
  - 每行：`代码 名称` + `tier` 徽标 + 状态徽标 + 触发价/涨幅提示（从 `triggerJson` 解析出展示串）；
  - 点击行 → 复用 `pick(code)` 把代码送进下单条（P1-a 仅预填，不自动下单）；
  - 空态：「今日无计划指令，确认作战卡后自动生成」。
- `workflow` store 增加 `instructions` 与 `refreshInstructions()`；`BattleStation` 的 5s `refresh()` 里调用（只查本地 SQLite，不触发 GUI）。
- `PhasePanel` 保留现有计划 chips 不动，`InstructionList` 放在其下方。

## 八、测试与验收

**Rust 单测**
- `derive_state` 全分支（watch/pending/triggered/submitted/filled/cancelled/expired）。
- `leaves_from_alert_rule`：单键、多键 AND、无可用键、非法 vol。
- `materialize_plan`：内存库两次调用只建一张条件单；重新生成计划会取消旧条件单。

**前端单测**
- `instructionModel` 状态文案/色调映射。

**e2e**
- fake `workflow_instructions` 返回 3 条（pending/triggered/filled），作战台展示对应徽标与触发提示；空计划显示空态。

**验收清单**
1. 确认作战卡 → candidate/trigger 指令出现 `co_id`，条件单列表可见。
2. 再次确认 → 条件单数量不变。
3. 手动把条件单置 triggered（或真实触发）→ 作战台 10s 内显示「已触发」。
4. 重新生成计划 → 旧条件单变 cancelled，新指令重新物化。
5. 不改变任何下单路径；实盘仍需人工确认。
6. 作战台轮询仍只查本地库，不触发同花顺 GUI。

## 九、风险与回退

- 条件单引擎已承载真实触发，P1-a 只新增「计划 → 条件单」的写入方；风控/下单路径零改动。
- 物化失败只影响展示，不影响计划确认与预警。
- 回退：新增列可空，不读不写即可；物化器入口可加开关 `plan_auto_materialize`（默认开）用于快速关闭。
