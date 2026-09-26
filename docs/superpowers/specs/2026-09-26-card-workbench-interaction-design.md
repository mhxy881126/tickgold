# 卡片化工作台交互优化设计 · 鎏金专业版（版本 A）

- 日期：2026-09-26
- 范围：前端（Vue 3 + TS），**不改 Rust / 行情接口 / 数据库 schema**
- 目标：在现有「鎏金奢华」视觉语言上做专业级进化——更强的可视化卡片自定义、更顺滑的拖拽/缩放/聚焦手感、实时四向重排与自由摆放双模式可切换，老用户零学习成本。
- 决策前提（已与用户确认）：
  - 自定义与动效**平衡推进**；
  - 自定义深度 = **可视化参数调节，零代码**（不开放自定义 CSS）；
  - 布局 = **双模式可切换**：默认实时重排，可选完全自由摆放；
  - 方向选定 = **A 鎏金专业版**（B 灵动物理 / C 极简高效 / D 空间编排不在本期范围）。

## 一、现状分析

当前卡片工作台由以下部分组成：

- `src/components/CardShell.vue`：卡片外壳（左色条、标题栏、hover 浮现的折叠/聚焦/设置/关闭按钮、右下角 resize 手柄、单卡设置弹层）。
- `src/composables/useWorkbench.ts`：全部状态与布局算法，包括
  - `openCards`、`cardCustom`、`zoneOverride`、`freeMode`、`freeRects`、`focusId`；
  - 网格模式：`gridLayout`（CSS Grid 12 列 × 6 逻辑行，first-fit / `packZone` 完全装箱）；
  - 自由模式：绝对定位 + `settleFreeRects`（碰撞后只向下推，容易产生竖向空洞）；
  - 序列化：`serialize()` → SQLite `meta(workbench_current)` 400ms 防抖自动保存；`applySnapshot()` 对缺失字段宽容。
- `src/App.vue`：渲染网格/自由画布、transition-group FLIP（`.card-move` / `.card-enter` / `.card-enter` / `.card-out`）、FLIP 聚焦（主从分屏）。

现有单卡自定义（`CardCustom`）：`span / rspan / collapsed / color / refresh`，其中 `color` 只有 5 个固定色板，`refresh` 只能跟随全局或固定档位。

### 现存痛点

1. 自由拖拽只向下避让，拖几次后下方出现空洞、布局松散。
2. 强调色仅 5 色，无渐变/透明度/圆角/边框/标题样式等外观自定义。
3. 头部工具按钮完全 hover 才出现，发现性弱；无卡片右键菜单。
4. 无锁定/置顶/标签；误关卡片无法撤销。
5. 动效固定单一曲线，拖拽/缩放缺少回弹跟手感。

## 二、总体方案

仅扩展前端三个层次：

1. **数据模型扩展**：在 `CardCustom` 上新增外观与行为字段（全部可选、向后兼容）。
2. **布局引擎扩展**：新增「实时重排模式」（拖拽 ghost + 插入点 + 四向流动）作为默认；现有自由模式增加对齐辅助线、边缘磁吸、一键整理；两种模式可切换并随布局持久化。
3. **交互组件拆分**：单卡设置弹层从 CardShell 拆为独立的 `CardSettingsPopover.vue`（外观/行为两页签）；新增 `CardContextMenu.vue`。
4. **动画与撤销**：三处关键交互加轻微回弹曲线 + 60ms 错峰 FLIP + reduced-motion 守卫；会话内结构操作撤销栈。

不引入新的前端依赖（不引入物理动画库、UI 库）；不做真正的「卡片多实例」（见「非目标」）。

## 三、数据模型：扩展 CardCustom

在 `src/composables/useWorkbench.ts`：

```ts
export interface CardCustom {
  // —— 现有（保持不变）——
  span?: number;        // 列跨度 1..12
  rspan?: number;       // 行跨度 1..12
  collapsed?: boolean;  // 折叠为标题栏
  color?: string;       // 强调色覆盖（主色）
  refresh?: number;     // 刷新秒数，0=跟随全局
  // —— 新增·外观 ——
  gradientTo?: string;  // 渐变第二色；空字符串/缺省 = 纯色
  gradAngle?: number;   // 渐变角度 0..360，缺省 135
  opacity?: number;     // 卡片底色不透明度 0.6..1，缺省 1
  radius?: number;      // 圆角 px 6..18，缺省 10
  borderWidth?: number; // 边框宽度 px 0..2，缺省 1
  headStyle?: 1 | 2 | 3 | 4 | 5;
  // —— 新增·行为 ——
  pinned?: boolean;     // 置顶
  locked?: boolean;     // 锁定（拦截拖拽 + resize）
  tag?: string;         // 标题栏标签，最长 4 个字符，空 = 不显示
}
```

约束与处理：

- 所有新字段可选，**旧快照无需迁移**；`applySnapshot` 已对缺失字段宽容，读取时统一走 getter 补默认值。
- 数值在写入前 clamp：角度 0–360、不透明度 0.6–1、圆角 6–18、边框 0–2；`tag` 写入前 `slice(0,4)`。
- 强调色/渐变只作用于「左色条、hover 边框、标题栏色条、设置/右键的选中态」，**不影响内部数据图表**的涨跌红绿，保证行情判读不受装饰色干扰。
- `pinned` 在网格模式下使该卡在其分区排序中稳定靠前；`locked` 时 CardShell 不 emit `grab/pdrag/resize`，标题栏显示小锁图标。
- `setCardColor` / `setCardRefresh` 等保留；新增批量复制样式能力（见 6.2）。

### 3.1 默认值 getter

新增集中的默认值解析（替代散落的 `??` ）：

```ts
function cardLook(id: CardId): Required<Pick<CardCustom,
  "color"|"gradientTo"|"gradAngle"|"opacity"|"radius"|"borderWidth"|
  "headStyle"|"pinned"|"locked"|"tag">> { /* 合并 CARD_META 兜底 */ }
```

模板中通过该函数生成卡片根元素的 CSS 变量：`--card-accent / --card-accent2 / --card-grad / --card-opacity / --card-radius / --card-border`。

## 四、双布局模式

### 4.1 实时重排模式（新默认，live-reflow）

交互流程：

1. 用户在网格模式（`!freeMode`）下按住标题栏发起拖拽。
2. 被拖卡片半透明（沿用 `.dragging`），其网格单元内渲染一个**虚线边框 ghost 占位块**，标记当前插入位置。
2. pointermove（rAF 节流，沿用现有模式）：
   - 把指针位置映射到「分区 + 网格行」；
   - 根据指针是否越过同行其他卡片的中线，计算新的线性插入索引（主干区 `mainCards` / 侧栏区 `sideCards` 各自独立；越过分区边界则把卡移到另一分区的对应位置）；
   - 实时更新 `openCards` 顺序与 `zoneOverride` → `gridLayout` 重算 → 其他卡通过 `.card-move` FLIP 四向流动。
3. pointerup：提交最终顺序与分区；`Esc` 按下则放弃，恢复拖拽开始时的顺序快照。
4. 整个过程其他卡始终铺满、不重叠、无空洞（继承现有网格完全装箱）。

实现要点：

- 复用现有 CSS Grid + Vue `<TransitionGroup>` 的 move-class，**不改布局坐标计算本身**，只在拖拽中临时改 `openCards` 顺序。
- 拖拽开始记录 `{ order: [...openCards], zone: {...zoneOverride} }` 快照；取消时写回。
- 被拖卡 emit 的事件从现有 `pdrag` 进入新的 live-reflow 处理函数 `startLiveDrag(e, id)`；自由模式仍走 `grab → startFreeDrag`。
- 跨区移动更新 `zoneOverride[id]`；resize 手柄继续通过 `resizeCard` 改跨度，其余卡由 grid 重排。

### 4.2 自由摆放模式（现有模式增强）

保留绝对定位 + 碰撞避让，并增加：

- **对齐辅助线**：拖拽中若被拖卡边缘与任一其他卡边缘（或画布中线）距离 ≤ 6px，显示品红/主题色参考线并把坐标吸附对齐。
- **边缘磁吸**：同一阈值内吸附到其他卡边缘或画布边。
- **一键整理**：工具条按钮调用 `tidyFree()`，对当前 `freeRects` 重新做规整装箱（复用 `packFree` 的 shelf 逻辑 + 边界约束），过渡走 CSS transition 平滑归位。
- **模式状态**：模式切换随布局持久化。为避免与旧快照冲突，**布局恢复一律以快照是否含 `rect` 为准**（沿用现有判定：含 rect → 自由模式，否则 → 网格实时重排），不另存模式开关。

### 4.3 模式切换 UI

- 「布局」菜单与自由模式工具条都提供开关：**实时重排 ⇄ 自由摆放**。
- 从实时重排切到自由：对当前卡片调用 `packFree` 生成初始 rect；从自由切回：丢弃 rect 回到网格。
- 切换动作进入撤销栈（见第七节）。

## 5. 动画与动效

| 场景 | 处理 |
|---|---|
| 拖拽落定 / resize / 聚焦往返 | 用轻微回弹曲线 `cubic-bezier(.34,1.25,.5,1)`，纯 CSS |
| 批量开卡 / 关卡 | transition-group 已有出入场；新增 **60ms × index 错峰**（封顶 ~6 个），用 CSS custom `--i` 控制 animation-delay |
| 被拖元素本身 | 关闭过渡（`transition:none`）保证跟手，其余卡 FLIP |
| 系统减弱动态 | `@media (prefers-reduced-motion: reduce)` 下所有动画改瞬切（duration≈0） |
| 对齐辅助线 | 参考线 opacity 0→1 120ms，不做位移动画 |

不使用 JS 物理库；弹性仅为视觉曲线。所有动画属性限定在 `transform / opacity`，避免触发 layout 的属性做持续动画（grid 重排由浏览器原生 FLIP 处理）。

## 六、卡片操作与菜单

### 6.1 标题栏

- 工具按钮改为**常驻半透明 0.45、hover/focus-visible 全显**（当前是 opacity:0，发现性差）。
- 若 `locked`：不响应头部拖拽，resize 手柄隐藏，标题栏显示小锁图标。
- 若 `tag` 非空：标题后以小胶囊角标显示（半透明强调色底）。
- `pinned` 卡：标题栏显示图钉图标。

### 6.2 右键菜单 `CardContextMenu.vue`

纯受控组件：props `{ x, y, cardId }`，emits 对应动作；支持 ↑↓ 选择、Enter 执行、Esc 关闭；靠右/靠下边缘自动翻转定位。菜单项：

1. 聚焦放大（聚焦中为「还原布局」）
2. 折叠 / 展开
3. 置顶 / 取消置顶
4. 锁定 / 解锁
5. 复制样式 / 粘贴样式
6. 改色 → 二级色板（8 预设 + 「自定义…」触发取色器）

**「复制样式」语义明确**：复制该卡的**外观字段子集**（color/gradientTo/gradAngle/opacity/radius/borderWidth/headStyle），暂存内存（不写剪贴板）；「粘贴样式」把该子集 `patchCustom` 到目标卡。**不是**复制一个新的卡片实例。

### 6.3 单卡设置弹层 `CardSettingsPopover.vue`

从 CardShell 拆出（CardShell 仅控制开关与定位），分两页签：

- **外观**：8 预设色板 + `<input type="color">`；第二色取色 + 启用渐变 checkbox + 角度滑块；不透明度、圆角、边框滑块；标题栏样式 5 选 1 分段控件。每项**实时预览**。
- **行为**：刷新频率 select（跟随全局/3/5/10/30 秒，沿用现有）、标签输入（maxlength=4）、置顶开关、锁定开关、「恢复该卡片默认设置」（删该 id 在 `cardCustom` 中的外观/行为覆盖，但保留尺寸）。

定位沿用现有 `.card-cfg`，新增「空间不足时向左/向上翻转」逻辑；点击外部关闭。

## 七、撤销栈

- 类型：会话内环形栈，容量 20，**不持久化**（重启清空）。
- 捕获的结构操作：打开卡片、关闭卡片、拖拽改序/跨区（live-reflow）、自由模式一键整理、重置布局、切换模式、切换场景/模式预设。
- 每步保存操作发生前的**结构化快照**（最简：保存前 `serialize()` 的 JSON 字符串），撤销 = 对栈顶 JSON `applySnapshot`。
- 外观微调（颜色/圆角等）不进撤销栈（实时调节的体验是即时反馈，否则会打断调节）。
- `Ctrl/⌘+Z` 在非输入态触发；关闭卡片时底部 toast「卡片已关闭 · 撤销」5 秒可点（与快捷键共用同一弹出栈逻辑）。
- 注意：`applySnapshot` 会清聚焦并重建状态，撤销时若正处于聚焦态，先 `clearSlotInline()`（该函数已存在）。

## 八、持久化与兼容

- 新字段随现有 `serialize()`/`applySnapshot()` 自动包含在 `meta(workbench_current)` JSON 中，**不需要新的 SQLite migration**。
- 命名布局、场景模板（`layout` 表）中的旧 JSON 缺少新字段时，按默认值渲染，不报错。
- 双模式标记：不新增表/列；恢复时「含 rect → 自由模式」的现有判定保持不变。用户在网格模式的实时重排只是改变 `openCards` 顺序与 `zoneOverride`，这些已经被序列化。
- 样式复制暂存仅在内存（模块级变量或 composable 内部 ref），不入库。

## 九、非目标（本期不做）

- 真正的「卡片多实例 / 可开多个同类型卡片」：当前卡片按 `CardId` 全局单例，多实例需重构全部组件的数据订阅、持久化与菜单，风险大，留待后续版本；本期用「复制样式」满足快速统一外观的诉求。
- 自定义 CSS / 自定义动效曲线编辑（用户已选「可视化调节」）。
- B 版弹簧物理引擎、毛玻璃材质、发光强度；C 版密度档位与完整键盘布局操作；D 版分区编排与悬浮迷你窗。
- 改动任何 Rust 命令、行情逻辑、数据库 schema、自动更新流程。

## 十、验证与验收标准

### 10.1 构建与静态检查

- `pnpm build`（`vue-tsc --noEmit && vite build`）通过，无新增 TS 错误。
- 新增组件遵循现有 `<script setup lang="ts">` + scoped style 模式；不引入新依赖。

### 10.2 人工验证矩阵（dev 模式）

| # | 验证点 | 预期 |
|---|---|---|
| 1 | 网格模式拖卡同区重排 | ghost 跟随、其他卡四向流动、松手定型、无空洞不重叠 |
| 2 | 拖卡跨主干/侧栏 | 卡进入另一区并参与该区排序 |
| 3 | 拖拽中按 Esc | 回到拖拽前顺序与分区 |
| 4 | 自由模式对齐磁吸 + 一键整理 | 辅助线在 ±6px 出现并吸附；整理后整齐装箱且平滑过渡 |
| 5 | 外观各滑块/取色 | 实时预览；色条/边框响应，内部图表红绿不变 |
| 6 | 渐变第二色 + 角度 | 左色条/标题色条按角度渐变；清空第二色回到纯色 |
| 7 | 标题栏 5 样式 | 逐一切换渲染正确，9 套主题下文字均可读 |
| 8 | 右键菜单全部项 | 聚焦/折叠/置顶/锁定/复制粘贴样式/改色/标签/关闭均生效；键盘 ↑↓ Enter Esc 可用 |
| 9 | 锁定卡 | 不能拖、不能 resize，显示锁标，仍可右键解锁 |
| 10 | 标签超 4 字 | 自动截断为 4 字 |
| 11 | 关闭卡片 + Ctrl+Z | toast 可撤销；快捷键也能恢复；栈满 20 自动丢弃最旧 |
| 12 | 模式双向切换 | 网格↔自由，位置合理、状态持久化 |
| 13 | 刷新保持 | F5 / 重启应用后卡片集、顺序、外观、模式全部恢复 |
| 14 | 旧快照恢复 | 用旧版 `workbench_current` JSON（无新字段）启动，正常渲染默认外观 |
| 15 | reduced-motion | 系统开启减弱动效后，所有卡片动画为瞬切，功能不受影响 |
| 16 | 弹层边缘翻转 | 卡片在最右/最下时设置弹层与右键菜单向内侧展开，不被裁切 |

## 十一、实施顺序建议（供 writing-plans 细化）

1. `CardCustom` 扩展 + `cardLook` 默认值解析 + CSS 变量注入（不改变外观默认渲染）。
2. `CardSettingsPopover` 拆分 + 外观/行为两页签；CardShell 接入并改为常驻弱化按钮。
3. 网格 live-reflow 拖拽（ghost + 插入点 + Esc 取消）；自由模式辅助线/磁吸/一键整理。
4. 右键菜单 + 置顶/锁定/标签渲染 + 复制粘贴样式。
5. 撤销栈 + Ctrl+Z + 关闭 toast。
6. 回弹曲线、错峰 FLIP、reduced-motion。
7. 全量人工验证矩阵 + `pnpm build`；整理未提交改动后再决定提交。
