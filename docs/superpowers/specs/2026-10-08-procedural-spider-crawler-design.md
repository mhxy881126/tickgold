# 程序化 IK 蜘蛛爬虫覆盖层 — 设计文档

日期：2026-10-08
状态：已与用户确认方案，待写实施计划

## 1. 背景与目标

用户提供参考视频（QQ20261006-191856.mp4），期望将同款「数字蜘蛛在真实页面上爬行扫描」效果
引入 TickGold。现有 `SpiderOverlay.vue` 只是固定假坐标的补间动画，腿抓不到真实元素，与视频差距大。

目标：全屏覆盖层上的程序化蜘蛛，8 条腿以两段式反向运动学（IK）真实抓在自选股行、涨幅榜行等
卡片元素上，按扫描节奏在行间、卡片间行走；扫描时发出光束并高亮目标行；发现买卖信号时抽出
「数据包」磁贴，拖行后飞入信号确认桥卡片。

## 2. 范围

**包含：**

- 全屏 Canvas 2D 覆盖层，程序化 IK 步态蜘蛛
- 从真实 DOM 采集可见股票行锚点（自选、涨幅榜首发；其他卡片兜底标题栏）
- 扫描光束、目标行语义高亮（买入粉红 / 卖出绿 / 普通扫描青）
- 信号数据包磁贴：拖行 → 曲线飞入信号确认桥卡片（兜底飞入爬虫日志面板）
- 跨卡片行走（带中途落脚点，不空中飞行）
- 替换 `SpiderOverlay.vue` 内现有假动画；保留顶栏 / 休市灯 / 日志 / 后端联动
- `prefers-reduced-motion` 降级（关闭发光与拖尾）

**不包含：**

- Rust 后端改动（信号落桥沿用上一轮已实现的 `signal_create_spider`）
- 涨幅榜之外的卡片行逐个适配（板块/雷达等本期以标题栏/通用锚点兜底）
- 蜘蛛音效、鼠标交互操控、多只蜘蛛

## 3. 技术选型

采用 **Canvas 2D 全屏覆盖层**（对比后否决 SVG 逐帧路径更新与第三方动画/物理库）：

- 发光、骨骼、粒子在单 canvas 内绘制性能最好
- 覆盖层 `pointer-events:none`，零 DOM 侵入，不影响点击
- 无现成「IK 蜘蛛爬 DOM」第三方库，纯手写数学约 300 行，可控可测

## 4. 组件结构

| 文件 | 职责 |
|---|---|
| `src/components/spider/ik.ts`（新） | 向量运算、两段式 2 骨 IK 解算、对角步态分组、锚点选择等纯函数 |
| `src/composables/useSpiderAnchors.ts`（新） | 采集当前卡片可见行的视口位置与元数据，处理卡片切换 / 虚拟滚动 / 行消失 |
| `src/components/spider/ProceduralSpider.vue`（新） | canvas 主循环：身体、8 腿步态、光束、高亮、数据包拖行与飞行 |
| `src/components/SpiderOverlay.vue`（改） | 删除旧补间动画代码，挂载新蜘蛛；保留顶栏/休市灯/日志/后端联动 |
| `src/composables/useSpiderBotEngine.ts`（小改） | 扫描每只股票时触发 onTarget 回调（目标 code/卡片/信号语义），驱动光束与数据包 |

## 5. 数据模型

```ts
// 一个可落脚/可扫描的真实元素锚点
interface Anchor {
  id: string;            // 股票代码 或 "card:<id>:title"
  cardId: CardId;
  x: number; y: number;  // 视口坐标（行左缘或行中心）
  edge: "left" | "center";
  code?: string;
  name?: string;
  price?: number;
  pct?: number;
  signal?: "BUY" | "SELL" | null;
}

// 一条腿的 IK 状态
interface LegState {
  hipX: number; hipY: number;   // 相对身体的髋部锚点
  coxa: number; femur: number;  // 两段骨长
  foot: Vec2; target: Vec2;     // 当前脚点 / 期望脚点
  lifting: boolean; liftT: number; // 抬腿动画进度
  liftFrom: Vec2; liftTo: Vec2;
  group: 0 | 1;                 // 对角步态分组
}

// 拖行/飞行中的数据包
interface DataPacket {
  code: string; name: string; side: "BUY" | "SELL";
  price: number; pct: number;
  state: "trailing" | "flying";
  pos: Vec2; trail: Vec2[];
  flyT: number;                 // 贝塞尔飞行进度
  from: Vec2; ctrl: Vec2; to: Vec2;
}
```

## 6. 关键算法

### 6.1 两段式 IK

输入髋部 H、脚点 F、骨长 L1/L2：

1. `d = clamp(|F−H|, ε, L1+L2−ε)`
2. 余弦定理求膝关节角：`a = acos((L1² + d² − L2²)/(2·L1·d))`
3. 基础方向 `dir = (F−H)/d`，膝关节 = H + dir 旋转 ±a 乘 L1（左右腿取不同弯曲方向）
4. 端点即 F。腿部两段折线一次解算，无迭代。

### 6.2 步态调度

- 每只脚有「舒适环」：身体坐标下半径 [rMin, rMax] 的环带
- 触发迈步：脚超出环带，或落脚元素从 DOM 消失/滚动位移超过阈值
- 8 腿按对角分两组（仿昆虫三角步态扩展），组内可同时 1–2 腿离地，全局同时离地 ≤ 2
- 迈步轨迹：二次贝塞尔弧线（中点抬高 8–14px），220–320ms 完成；落地后才允许同组下一条腿抬
- 身体静止时做原地微动（呼吸起伏 ±1.5px），不强制迈步

### 6.3 行走路径

- 扫描队列由引擎给出（与现有 watch→rank→sector→radar 轮次一致）
- 同一卡片内：依次走向可见行锚点；行多于 N 个时取可见区前若干个 + 当前扫描目标
- 跨卡片：在旧锚点与新锚点之间按屏幕方向插入 2–3 个中途落脚点（卡片边框/面板间隙），
  避免长距离空中飞行
- 目标卡片无可见行：落到该卡片标题栏锚点原地踏步
- 卡片未打开：跳过该卡片（与现有 switchCard 尊重用户关闭意图一致）

### 6.4 扫描、光束与高亮

- 蜘蛛到达目标锚点后停 500–900ms：从头点向行中心画锥形光束（线宽渐变 + 沿线脉冲方块）
- 目标行加 canvas 描边框，颜色：BUY `#ff4d8d`（视频粉+红涨语义）、SELL `#17c964`、普通 `#2fd4e1`
- 信号结果由引擎 onTarget 回调给出；普通扫描仅高亮，不抽数据包

### 6.5 数据包拖行与飞行

- BUY/SELL：从行位置生成磁贴（股名/代码/价/涨幅，信号色描边），粉色牵引线连向身体后方
- trailing 状态约 1s，记录轨迹点做摆动跟随
- 随后转 flying：二次贝塞尔曲线（控制点取起点上方 120–180px 偏向屏幕中线）飞向信号确认桥卡片中心
  （`[data-card-id="signalbridge"]` 的视口矩形）；桥卡片未打开时飞向爬虫日志面板标题
- 到达后淡出，触发桥自身的 `signal:new` 刷新（信号数据此前已由引擎写入后端，动画仅表现）

## 7. DOM 锚点采集

- 自选股：`[data-card-id="watch"] table.list tbody tr`（行内含 `.nm`、`.cd`、价格列）
- 涨幅榜：`[data-card-id="rank"] .vrow`（虚拟滚动：只采集当前在视口内渲染的行）
- 通用兜底：`[data-card-id="<id>"]` 卡片标题栏中心
- 每帧（或 scroll/resize/卡片切换时 rAF 节流）`getBoundingClientRect`，过滤宽高为 0 / 超出视口的行
- 代码与行情从 `useQuotesStore()` / watchlist store 直接读，不从 DOM 文本解析

## 8. 生命周期与性能

- `requestAnimationFrame` 单循环；覆盖层 v-if 销毁时取消帧、清空所有定时器
- DPR 适配（上限 2）；窗口 resize / scroll 用 passive 监听重算
- 常态每帧绘制元素 < 100 个；无数据包时光束以外不产生粒子
- 模块沿用现有 HMR dispose 停定时器的约定

## 9. 降级与异常

- `prefers-reduced-motion: reduce`：保留蜘蛛静态站立+瞬时换脚，关发光/拖尾/数据包曲线（直飞）
- 目标卡片/行消失：放弃当前路径，重新规划到最近的有效锚点
- 所有锚点为空：蜘蛛停在屏幕左下角「等待数据」，不报错
- canvas 初始化失败：覆盖层不渲染蜘蛛，但顶栏/日志/后端扫描照常工作

## 10. 验证

- `src/components/spider/__tests__/ik.test.ts`：IK 解算边界（距离 0、超长）、
  骨长守恒、步态分组互斥、锚点选择纯函数，用 vitest
- `cargo check` 无需（本次不改 Rust）；`vue-tsc --noEmit` 类型通过；`vitest run` 单测通过
- 人工核对（tauri dev）：视频四要素——IK 步态真实抓行、光束高亮、数据包拖行飞桥、跨卡行走；
  休市灯与既有后端联动不回退
