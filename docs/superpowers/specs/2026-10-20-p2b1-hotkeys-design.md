# P2-b1 设计：B/S/C/W/D 快捷键 + 信号优先级 + 灵动岛高优脉冲

> 状态：设计待评审　|　日期：2026-10-20　|　基线：P2-a 已合并 `99bb8f2`
> 范围：只做「手速」；菜单 4 场景组（48 卡重分类）另起 P2-b2。

## 一、目标

1. **全局快捷键**（输入框内不触发）：
   | 键 | 动作 |
   |---|---|
   | B | 打开今日作战流，下单条切「买入」并聚焦代码框 |
   | S | 打开今日作战流，下单条切「卖出」并聚焦代码框 |
   | C | 撤销全部活动条件单（一次确认） |
   | W | 打开「自选股」卡片 |
   | D | 打开「K线图」卡片 |
2. **信号优先级**：信号桥默认排序改为「待确认优先 → 置信度降序 → 时间降序」，每行加高/中/低徽标（≥80/≥60/其余）。
3. **灵动岛高优脉冲**：待确认信号中最高置信度 ≥80 时，灵动岛折叠态加红色脉冲环；新信号到达且高优时自动展开到「信号」页。

## 二、实现

1. `src/stores/quickAction.ts`（新）：`pendingOrderSide` + `requestOrder(side)` / `consumeOrderSide()`，解决「卡片未挂载时事件丢失」。
2. `App.vue`：注册 5 个 action（`useActions`），`defaultKeys` = B/S/C/W/D，`editingSafe:false`：
   - B/S：`bench.open("cockpit")`（必要时 `setGlassActive`）+ `requestOrder(...)`；
   - C：`confirmDialog("撤销全部活动条件单？")` → `coCancelAll()` → toast；
   - W/D：`bench.open("watch"/"chart")`。
3. `OrderDock.vue`：`defineExpose({ setCode, focusSide })`；`focusSide(side)` 设置方向并聚焦代码输入。
4. `BattleStation.vue`：挂载时 `consumeOrderSide()`，若存在调用 `dock.focusSide(side)`。
5. `SignalBridge.vue`：`filtered` 排序 + `priorityOf(confidence)` 徽标（`高/中/低`），testid `signal-priority`。
6. `Island.vue`：`SignalEvent` 加 `confidence`；`strongSignal = max(confidence) >= 0.8`；根节点 class `strong`，CSS 红色脉冲；`signal:updated`/轮询刷新时保持；高优新信号自动展开到 signal tab（限制：折叠态才自动展开一次/30s，避免刷屏）。

## 三、验收

- B/S 在任意卡片下打开作战台并切到对应方向，输入框聚焦；输入框内按 B 不触发。
- C 弹一次确认后撤销全部条件单，成功/失败中文提示。
- W/D 打开对应卡片。
- 信号桥按优先级排序、徽标正确。
- 高优信号使灵动岛出现脉冲；折叠态自动展开一次。
- 单测：priority 排序/徽标纯函数、quickAction 消费一次；e2e：快捷键 B 打开作战台 + 信号排序/徽标。

## 四、风险

- 单字母快捷键与浏览器/输入法冲突：仅非输入态触发，且可在快捷键速查里改绑。
- C 会撤销全部条件单：必须有确认弹窗，文案写明影响。
- 灵动岛自动展开限流，避免盘中反复弹开。
