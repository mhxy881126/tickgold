# P1-b 设计：触发条件行内编辑 + 触发后一键下单 + 模拟盘自动开关

> 状态：设计待评审　|　日期：2026-10-19　|　基线：P1-a 已合并 `7905284`
> 上游：[P1-a 设计](2026-10-19-plan-execution-p1a-design.md)　|　本次只做 P1-b

## 一、目标

在 P1-a「计划 → 条件单 → 状态回显」的基础上补执行闭环：

1. **行内编辑**：作战台每条指令可直接改触发条件（价格/涨幅/量比/换手/成交额/涨速）、数量、方向、模拟自动开关；保存后条件单立即取消并重建。
2. **触发后一键下单**：条件单触发时已生成 `signal_ticket`，行内出现「确认下单」，一次确认后调用 `bridge::confirm` + `submit_with_sig`，不新建第二张票。
3. **模拟盘自动可按条关**：默认 `autoConfirm=true`（mock 自动成交）；关闭后 mock 也留 pending 等人工确认；实盘永远人工确认。

**非目标（P1-c）**：盘后 15:05 自动流水线、8:45 提醒、命中率统计。

## 二、复用与新增

| 能力 | 位置 |
|---|---|
| 条件单触发 / 建票 | `alert::run_co_engine` → `handle_co_triggered`（P1-a） |
| 票据确认 | `ai::bridge::confirm(conn, ticket_pk, ConfirmOpts)` |
| 唯一提交入口 | `broker::submit_with_sig(app, sig_id)` |
| 条件单取消 | `conditional::cancel`（会放弃指令，P1-a） |
| 物化 | `instruction::materialize_plan` / `materialize_today`（P1-a） |

**新增**

1. `instruction::update_trigger(conn, instr_id, rule) -> Result<()>`
   - 合并允许键到 `plan_instruction.alert_rule`，取消关联 active 条件单，清空 `co_id`，再按计划日/confirmed 规则重新物化。
   - 校验：至少一个可映射触发条件；`side` ∈ BUY/SELL；`vol` 为正且 100 整数倍。
2. `conditional::insert` 的 `auto_confirm` 改由 `alert_rule.autoConfirm` 决定（缺省 true）。
3. `broker_confirm_submit(ticket_id, price?, vol?) -> BrokerOrderInfo`
   - ticket 为 `pending` → `bridge::confirm`；`confirmed` → 直接提交；其他状态报中文错误。
   - 提交走 `submit_with_sig`，不绕过任何闸门。
4. `list_instructions` 增字段：`ticketId`、`ticketStatus`、`side`、`vol`、`price`、`autoConfirm`。
5. 前端 `InstructionEditor.vue`（行内展开面板）、`InstructionList` 增加「编辑 / 确认下单」按钮；store 增 `saveInstructionTrigger`、`confirmSubmitInstruction`。

## 三、编辑字段与存储

`alert_rule` 只接受以下键（其余忽略）：

| 字段 | 键 | 说明 |
|---|---|---|
| 价格≥ | `upPrice` | >0 |
| 价格≤ | `downPrice` | >0 |
| 涨幅≥ | `upPct` | >0 |
| 跌幅≤ | `downPct` | <0 |
| 量比≥ | `minVolumeRatio` | >0 |
| 换手≥ | `minTurnover` | >0 |
| 成交额≥ | `minAmount` | >0（亿） |
| 涨速≥ | `riseSpeed` + `speedWindowSec` | >0 |
| 跌速≥ | `downSpeed` | >0 |
| 封涨停/跌停/炸板 | `sealLimitUp/Down`、`brokenLimit` | 1/0 |
| 数量 | `vol` | 100 整数倍，默认 100 |
| 方向 | `side` | BUY/SELL，默认 BUY |
| 模拟自动 | `autoConfirm` | bool，默认 true |

方向互斥规则沿用 P1-a：突破优先（upPrice → upPct），其次回踩（downPrice → downPct）；编辑时若同时填上下，只物化突破侧，并在 UI 提示。

## 四、一键下单流程

```
CO 触发 → handle_co_triggered 建 signal_ticket(pending)
  ├─ mock + autoConfirm=true → 自动 confirm + submit（P1-a 已实现）
  └─ 其他 → 作战台行内「确认下单」
        → 一次确认弹窗
        → broker_confirm_submit(ticketId)
             ├─ pending → bridge::confirm（价格/数量取票面，可覆盖）
             └─ confirmed → 跳过
             → submit_with_sig（kill switch/连接/风控/白名单/限价/新鲜度全量）
        → 返回 BrokerOrderInfo，行内显示「已下单」
```

- 按钮只在 `ticketStatus === "pending"` 且 `state === "triggered"` 时出现；`filled/done` 显示「已成交」，`rejected` 显示「已拒绝」。
- 实盘未启用时按钮置灰并提示去设置（复用 P0 的入口）。

## 五、前端交互

- `InstructionList` 行尾增加两个按钮：`编辑`、`确认下单`（按状态显示）。
- 编辑面板（行内展开，不弹窗）：
  - 6 个数值输入 + 方向下拉 + 数量 + 「模拟盘自动执行」开关；
  - `保存` → `workflow_instruction_trigger_set` → 刷新列表，状态回「待触发」；
  - `取消` 收起，不发请求；
  - 保存失败显示中文错误（如「至少设置一个触发条件」）。
- 空态/只读保持 P1-a 行为。

## 六、测试与验收

**Rust 单测**
- `update_trigger`：合并键、清空 co_id、取消旧条件单、重建一张新条件单；非法（无触发条件/负数量/错误方向）报中文错误。
- `confirm_submit`：pending → confirmed + 提交（mock）；confirmed → 直接提交；rejected/done → 中文错误；kill switch 下提交被拒。
- `autoConfirm=false` 物化的 CO `auto_confirm=0`；缺省为 1。

**前端单测**
- 编辑表单模型：数值 → alertRule 映射、方向互斥提示、非法输入禁用保存。

**e2e**
- 行内编辑：改价格 → 保存 → 断言 fake 收到 `upPrice` 且列表状态回「待触发」。
- 一键下单：fake 行 `state=triggered/ticketStatus=pending` → 点击 → 确认 → 断言 `broker_confirm_submit` 调用参数与成功提示。
- 自动开关：关闭后保存，断言 `autoConfirm=false` 透传。

**验收清单**
1. 作战台可直接改任一触发条件并立即生效（旧单取消、新单建立）。
2. 触发后一次确认即可提交，且只有一张票、走 `submit_with_sig`。
3. 模拟自动可逐条关闭；关闭后 mock 也需人工确认。
4. 实盘仍强制人工确认，未启用实盘时按钮/提示正确。
5. 不改变风控与下单唯一入口；e2e 8 → 11 条全绿。

## 七、风险与回退

- 编辑会取消旧条件单：若旧单已触发/已有票，禁止编辑（返回「已触发，不能改条件」），避免误撤已成交路径。
- `update_trigger` 只改 `alert_rule`，不动历史票/委托。
- 回退：前端隐藏编辑入口即可；后端命令保留但无调用方。
