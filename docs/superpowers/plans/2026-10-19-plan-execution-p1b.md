# P1-b 实施计划：触发条件行内编辑 + 触发后一键下单 + 模拟盘自动开关

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** 作战台行内改触发条件并立即重建条件单；触发后一次确认提交已有信号票；模拟自动可按条关闭。

**Architecture:** 后端新增 `instruction::update_trigger` 与 `broker::broker_confirm_submit`，复用 `bridge::confirm` + `submit_with_sig`；前端新增行内编辑面板与两枚动作按钮；`alert_rule.autoConfirm` 控制 CO 的 `auto_confirm`。

**Tech Stack:** Rust + rusqlite + Tauri；Vue 3 + TS + Pinia；Vitest(node)；Playwright。

## Global Constraints

- 唯一提交入口 `submit_with_sig`，不得直连 sidecar 或绕过风控。
- 实盘永远人工确认；`autoConfirm` 只影响 mock。
- 已触发（有票/委托）的指令禁止改条件，返回中文错误。
- 编辑后旧条件单必须取消，`co_id` 清空并重新物化；幂等/唯一约束沿用 P1-a（note active 唯一）。
- 迁移不新增（`autoConfirm` 存在 `alert_rule` JSON）。
- 前端轮询不得调用会驱动同花顺 GUI 的命令。
- 单测 node-only；e2e 用 fake 后端；UTF-8 无 BOM；clippy `-D warnings`、`pnpm build` 通过。
- 提交前缀 `feat(ai):` / `feat(ui):` / `test(e2e):`。

## File Structure

| 文件 | 职责 |
|---|---|
| `src-tauri/src/ai/instruction.rs` | `update_trigger`、`autoConfirm` 读取、list 新字段 |
| `src-tauri/src/broker/mod.rs` | `broker_confirm_submit` |
| `src-tauri/src/lib.rs` | 注册两个命令 |
| `src/components/battle/instructionModel.ts` | 表单模型（rule ↔ 表单、校验、方向提示） |
| `src/components/battle/InstructionEditor.vue` | 行内编辑面板 |
| `src/components/battle/InstructionList.vue` | 编辑/确认下单按钮、状态展示 |
| `src/stores/workflow.ts` | `saveInstructionTrigger`、`confirmSubmitInstruction` |
| `src/components/battle/BattleStation.vue` | 透传事件、刷新 |
| `tests/unit/instruction-model.test.ts` | 表单模型单测 |
| `tests/e2e/support/backend.ts` | fake 两个新命令 |
| `tests/e2e/battle-station.spec.ts` | 编辑/一键/自动开关 e2e |

---

### Task 1: 后端（编辑 + 确认提交 + autoConfirm）

**Files:** `ai/instruction.rs`、`broker/mod.rs`、`lib.rs`

**Interfaces**
- `pub fn update_trigger(conn: &Connection, instr_id: i64, rule: &Value) -> Result<(), String>`
- `#[tauri::command] pub async fn workflow_instruction_trigger_set(ai: State<AiState>, instr_id: i64, rule: Value) -> Result<Value, String>`（返回该计划的 `list_instructions`）
- `#[tauri::command] pub async fn broker_confirm_submit(app: AppHandle, ticket_id: i64, price: Option<f64>, vol: Option<i64>) -> Result<protocol::BrokerOrderInfo, String>`
- `list_instructions` 增 `ticketId/ticketStatus/side/vol/price/autoConfirm`

- [ ] 步骤 1：写失败测试（`instruction.rs` tests）
  - `update_trigger_rebuilds_conditional_order`：物化一张 → 改 `upPrice` → 旧 CO cancelled、新 CO active、`co_id` 变化、状态 pending。
  - `update_trigger_rejects_triggered_instruction`：CO 置 triggered → `update_trigger` 返回中文错误。
  - `update_trigger_validation`：空规则/负数量/错方向 → 中文错误。
  - `materialize_auto_confirm_flag`：`autoConfirm:false` → CO `auto_confirm=0`；缺省 `=1`。
  - `confirm_submit_*`：pending → 提交成功（mock）；rejected → 中文错误；kill switch → 拒绝（如易测）。
- [ ] 步骤 2：跑测试确认失败
- [ ] 步骤 3：实现 `update_trigger`
  - 读 `plan_id, co_id, status`；`status` 有票（`ticket_id<>''`）或 CO `triggered/submitted` → 报错「已触发，不能修改触发条件」。
  - 合并允许键（spec §三），`side` 校验、`vol` 100 倍数；`leaves_from_alert_rule` 为空 → 报错。
  - 取消 active 关联 CO（`conditional::cancel` 会 dropped，注意：编辑场景应**不**置 dropped；直接 `UPDATE conditional_order SET status='cancelled'`），清 `co_id`。
  - 更新 `alert_rule`；若今天是计划日且 plan confirmed → `materialize_plan`。
- [ ] 步骤 4：`materialize_plan` 用 `rule["autoConfirm"].as_bool().unwrap_or(true)` 填 `auto_confirm`。
- [ ] 步骤 5：`broker_confirm_submit`
  - 读票；`pending` → `bridge::confirm`（price/vol 覆盖可选）；`confirmed` → 跳过；其他 → 中文错误。
  - drop conn → `submit_with_sig(&app, &sig_id)` → 返回 `BrokerOrderInfo`。
- [ ] 步骤 6：`list_instructions` SQL 增 `t.id,t.status,c.side,c.vol,c.limit_price,t.price`，JSON 输出对应字段；`autoConfirm` 从 `alert_rule` 解析。
- [ ] 步骤 7：注册命令；`cargo test instruction`、`cargo test --lib`、clippy 全绿；提交 `feat(ai): 指令触发条件行内编辑与确认提交（P1-b）`

### Task 2: 前端（编辑面板 + 动作按钮）

**Files:** `instructionModel.ts`、`InstructionEditor.vue`、`InstructionList.vue`、`workflow.ts`、`BattleStation.vue`、`tests/unit/instruction-model.test.ts`

- [ ] 步骤 1：写失败单测（node）
  - `formToRule`：数值/方向/autoConfirm → alertRule；空值省略；负数量/错方向报错。
  - `ruleToForm`：从 `alertRule` 回填。
  - `directionHint`：同时填上下 → 提示「突破优先，回撤侧不会触发」。
- [ ] 步骤 2：实现 `instructionModel.ts` 表单模型（`TriggerForm`、`formToRule`、`ruleToForm`、`validateForm`、`directionHint`）。
- [ ] 步骤 3：`InstructionEditor.vue`
  - 输入：价格≥、涨幅≥、量比≥、换手≥、成交额≥、涨速≥、方向、数量、「模拟盘自动执行」；
  - `保存` 触发 `save` 事件，`取消` 关闭；错误内联显示；
  - testid：`instr-edit`、`instr-save`、`instr-cancel`、字段 `instr-up-price` 等。
- [ ] 步骤 4：`InstructionList.vue`
  - 行尾按钮：`编辑`（status open/alerted）、`确认下单`（state=triggered 且 ticketStatus=pending）；
  - `确认下单` 先弹一次确认（复用 `confirmDialog` 或本地弹窗），确认后 emit `submit(ticketId)`；
  - 已成交/已拒绝显示文案，不显示按钮。
- [ ] 步骤 5：store 方法 `saveInstructionTrigger(instrId, rule)`、`confirmSubmitInstruction(ticketId)`，成功后 `refreshInstructions()`。
- [ ] 步骤 6：`BattleStation` 接事件，`pnpm test`、`pnpm build`；提交 `feat(ui): 作战台指令行内编辑与触发后确认下单（P1-b）`

### Task 3: e2e + 全量验证

**Files:** `tests/e2e/support/backend.ts`、`tests/e2e/battle-station.spec.ts`

- [ ] 步骤 1：fake handlers
  - `workflow_instruction_trigger_set`：记录 `__FAKE_LAST_TRIGGER`，返回更新后的 instructions（价格改成新值、state=pending）。
  - `broker_confirm_submit`：记录 `__FAKE_LAST_SUBMIT`，返回 `BrokerOrderInfo`。
  - instructions fake 增加 `ticketId/ticketStatus/side/vol/price/autoConfirm`。
- [ ] 步骤 2：三条 e2e
  - 编辑：点编辑 → 改价格 → 保存 → 断言 `__FAKE_LAST_TRIGGER.rule.upPrice` 与列表「待触发」。
  - 一键：seed 触发态行（ticketStatus=pending）→ 点确认下单 → 确认 → 断言 `__FAKE_LAST_SUBMIT.ticketId` 与成功提示。
  - 自动开关：关闭 checkbox → 保存 → 断言 `autoConfirm=false`。
- [ ] 步骤 3：全量验证
  - `pnpm test`、`pnpm build`、`pnpm exec playwright test tests/e2e/battle-station.spec.ts`（11 条）、全量 e2e；
  - `cargo test instruction`、`cargo test --lib`、clippy。
- [ ] 步骤 4：提交 `test(e2e): 指令编辑/一键下单/自动开关验收（P1-b）`

## Self-Review

- spec §二~§六 均有对应任务；无 TBD；接口签名在任务间一致；编辑禁用条件（已触发/有票）在 Task 1 实现、Task 2 只按 status 显示按钮。
- 风险：编辑取消旧 CO 不走 `conditional::cancel`（避免 dropped），需直接 UPDATE；Task 1 明确。
