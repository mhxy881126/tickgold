// 作战台 P0 端到端验收：开盘时段高亮 / 倒计时、下单一次确认、熔断置灰、模拟/实盘徽标、
// 实盘未启用前端拦截、新旧作战台切换，P1-a 指令列表的状态徽标与触发提示，
// 以及 P1-b 行内编辑触发条件 / 触发后一键下单 / 模拟盘自动开关，
// P2-a 对账 chip（正常 / 冲突可跳转）与下单耗时展示，
// P2-b1 B 快捷键（打开作战台 + 切买入方向 + 聚焦代码框）。
//
// 熔断状态注入（重要）：`tests/e2e/support/backend.ts` 会被 Vite 的 e2e alias 打进浏览器 bundle，
// 与 Node 侧的 Playwright 测试进程是两份模块实例——在 spec 里 import 任何 setter 都改不到页面状态。
// 因此统一用 page.addInitScript 预置 `window.__FAKE_BROKER_STATUS`，由 backend.ts 初始化时合并。
import { test, expect, type Page } from "@playwright/test";
import { boot } from "./support/helpers";

// 2026-10-19 是周一；09:31（Asia/Shanghai）处于「开盘」段，距盘中还有 29 分钟。
const OPEN_AT = new Date("2026-10-19T09:31:00+08:00");
// 时钟推进到 09:32 后距盘中应为 28:00：倒计时若冻结在挂载时刻会停在 29:00，可据此证明它是活的。
const ADVANCED_AT = new Date("2026-10-19T09:32:00+08:00");

type FakeBrokerStatusPatch = Record<string, unknown>;

/** 页面加载前注入券商状态 patch（仅影响本用例的浏览器上下文）。 */
async function seedBrokerStatus(page: Page, patch: FakeBrokerStatusPatch): Promise<void> {
  await page.addInitScript((p) => {
    (window as unknown as { __FAKE_BROKER_STATUS?: Record<string, unknown> }).__FAKE_BROKER_STATUS = p;
  }, patch);
}

/** 页面加载前标记「今日计划已确认」：缺省 products 分支据此返回 confirmed（盯盘入口用）。 */
async function seedPlanConfirmed(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { __FAKE_PLAN_CONFIRMED?: boolean }).__FAKE_PLAN_CONFIRMED = true;
  });
}

/** 页面加载前标记后端对账冲突：fake `broker_recon_status` 据此返回未匹配报告（chip 变「账实不符」）。 */
async function seedReconConflict(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { __FAKE_RECON_CONFLICT?: boolean }).__FAKE_RECON_CONFLICT = true;
  });
}

/** 时钟锁定到开盘时段后再进页面，避免用例受真实时间/时区影响。 */
async function installOpenClock(page: Page): Promise<void> {
  await page.clock.install({ time: OPEN_AT });
}

async function openCockpit(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForLoadState("domcontentloaded");
  await expect(page.locator(".dock-btn").first()).toBeVisible();

  // P2-b2 起出厂分组为 4 组，「交易·执行」是第 3 个；按钮只显示组名前两字，故按「交易」定位。
  const tradeGroup = page.locator(".dock-btn").filter({ hasText: "交易" });
  const groupBtn = (await tradeGroup.count()) > 0 ? tradeGroup.first() : page.locator(".dock-btn").nth(2);
  await groupBtn.click();

  const panel = page.locator(".dock-panel").first();
  await expect(panel).toBeVisible();
  await expect(panel.locator(".dp-head h3")).toHaveText("交易·执行");
  await panel.locator(".dp-item").filter({ hasText: "今日作战流" }).click();

  // 浮出面板固定在主卡左侧（left:68 / width:250）会盖住卡片，点空白解除 Dock 锁定并收起。
  await page.evaluate(() => document.body.click());
  await expect(page.locator(".dock-panel")).toHaveCount(0);

  await expect(page.getByTestId("battle-station")).toBeVisible();
  await expect(page.getByTestId("order-mode")).not.toHaveText("未连接");
}

test("开盘时段高亮，倒计时随时钟推进刷新到 28:00", async ({ page }) => {
  await installOpenClock(page);
  await openCockpit(page);

  // 页面加载期间假时钟按真实时间推进；这里把时间从 09:31 钉到 09:32 再显式跑 1s，
  // 让组件内 1s 时钟刷新一次 now。若倒计时只算了一次（冻结），文案会仍是 29:00。
  await page.clock.setFixedTime(ADVANCED_AT);
  await page.clock.runFor(1000);

  await expect(page.locator(".btl-seg.on")).toContainText("开盘");
  await expect(page.getByTestId("battle-countdown")).toContainText("距盘中");
  await expect(page.getByTestId("battle-countdown")).toContainText("28:00");
});

test("模拟盘下单：一次确认提交且参数正确", async ({ page }) => {
  await installOpenClock(page);
  await openCockpit(page);

  await page.getByTestId("order-code").fill("600519");
  await page.getByTestId("order-code").blur();
  // 等盘口把价格回填（价格仍为 0 时「确认下单」会被 canSubmitQuickOrder 拦住而不可点）
  await expect(page.getByTestId("order-dock").locator(".od-num").first()).toHaveValue("1680");

  await page.getByTestId("order-buy").click();
  await expect(page.getByTestId("order-confirm")).toBeVisible();
  await expect(page.getByTestId("order-confirm")).toContainText("贵州茅台");
  // 点下确认前没有任何提交结果：证明只弹一个确认框、没有提前下单。
  await expect(page.getByTestId("order-msg")).toHaveCount(0);

  await page.getByTestId("order-confirm-ok").click();
  await expect(page.getByTestId("order-msg")).toContainText("QK1");

  // 假后端在真正处理 broker_quick_order 时记录参数：确认只提交了一次，且方向/价格/数量正确。
  const lastOrder = await page.evaluate(
    () => (window as unknown as { __FAKE_LAST_ORDER?: unknown }).__FAKE_LAST_ORDER,
  );
  expect(lastOrder).toEqual({ code: "600519", side: "BUY", price: 1680, vol: 100 });
});

test("熔断时下单条置灰且徽标显示已熔断", async ({ page }) => {
  await seedBrokerStatus(page, { killSwitch: true });
  await installOpenClock(page);
  await openCockpit(page);

  await expect(page.getByTestId("order-buy")).toBeDisabled();
  await expect(page.getByTestId("order-sell")).toBeDisabled();
  await expect(page.getByTestId("order-mode")).toContainText("已熔断");
});

test("默认 mock 通道徽标为模拟且可下单", async ({ page }) => {
  // 不注入 patch：默认 kind=mock / liveEnabled=false / connected=true / killSwitch=false。
  await installOpenClock(page);
  await openCockpit(page);

  await expect(page.getByTestId("order-mode")).toHaveText("模拟");
  await expect(page.getByTestId("order-buy")).toBeEnabled();
});

test("客户端模拟通道（clientSim）徽标为模拟、可下单且无实盘提示", async ({ page }) => {
  // 出货默认是 kind=client + clientSim=true：必须按「模拟」展示，不能当成实盘。
  await seedBrokerStatus(page, {
    kind: "client",
    clientSim: true,
    liveEnabled: false,
    connected: true,
  });
  await installOpenClock(page);
  await openCockpit(page);

  await expect(page.getByTestId("order-mode")).toHaveText("模拟");
  await expect(page.getByTestId("order-buy")).toBeEnabled();
  await expect(page.getByTestId("order-live-hint")).toHaveCount(0);
});

test("实盘未启用：红字徽标 + 买卖拦截 + 设置入口", async ({ page }) => {
  // fake 默认 windowSim=true（模拟窗口）；真实盘用例需显式标注真实窗口，否则会按模拟通道处理。
  await seedBrokerStatus(page, {
    kind: "client",
    clientSim: false,
    windowSim: false,
    liveEnabled: false,
    connected: true,
  });
  await installOpenClock(page);
  await openCockpit(page);

  await expect(page.getByTestId("order-mode")).toHaveText("实盘未启用");
  await expect(page.getByTestId("order-buy")).toBeDisabled();
  await expect(page.getByTestId("order-sell")).toBeDisabled();

  const hint = page.getByTestId("order-live-hint");
  await expect(hint).toBeVisible();
  await expect(hint).toContainText("实盘未启用：请先到「设置 → 券商」开启实盘开关并配置白名单");
  await expect(hint.getByRole("button", { name: "打开设置" })).toBeVisible();
});

test("旧版六步 / 新版作战台可切换，旧版渲染完整驾驶舱", async ({ page }) => {
  await installOpenClock(page);
  await openCockpit(page);

  await page.locator(".battle-switch").click();
  await expect(page.getByTestId("battle-station")).toHaveCount(0);
  // 不只是作战台消失：旧版 Cockpit 必须真的渲染出来（一键智驾面板可见）。
  await expect(page.locator(".pilot-panel")).toBeVisible();
  await expect(page.locator(".battle-switch")).toHaveText("新版作战台");

  await page.locator(".battle-switch").click();
  await expect(page.getByTestId("battle-station")).toBeVisible();
  await expect(page.locator(".battle-switch")).toHaveText("旧版六步");
});

test("指令列表展示状态与触发提示", async ({ page }) => {
  await installOpenClock(page);
  await openCockpit(page);

  const list = page.getByTestId("instruction-list");
  await expect(list).toBeVisible();
  await expect(list.locator(".il-row")).toHaveCount(3);
  await expect(list).toContainText("贵州茅台");
  await expect(list).toContainText("待触发");
  await expect(list).toContainText("已触发");
  await expect(list).toContainText("已成交");
  await expect(list).toContainText("≥1680.00");
});

// —— P1-b 执行闭环验收：行内编辑 / 触发后一键下单 / 模拟盘自动开关 ——

test("行内编辑触发条件：改价格保存后条件单重建并回到待触发", async ({ page }) => {
  await installOpenClock(page);
  await openCockpit(page);

  const list = page.getByTestId("instruction-list");
  await expect(list.locator(".il-row")).toHaveCount(3);
  // 只有待触发的第一行可编辑；已触发行只给「确认下单」，已成交行不给动作。
  await expect(page.getByTestId("instr-edit")).toHaveCount(1);

  await page.getByTestId("instr-edit").click();
  const panel = page.getByTestId("instr-edit-panel");
  await expect(panel).toBeVisible();
  // 行上没有原始 alert_rule 时，面板由物化叶子（triggerJson）回填当前条件。
  await expect(page.getByTestId("instr-up-price")).toHaveValue("1680");

  await page.getByTestId("instr-up-price").fill("1690");
  await page.getByTestId("instr-save").click();

  // 保存成功：面板收起，列表按新规则回到「待触发」并显示新触发价。
  await expect(panel).toHaveCount(0);
  await expect(list.locator(".il-row").first()).toContainText("待触发");
  await expect(list.locator(".il-row").first()).toContainText("≥1690.00");
  await expect(page.getByTestId("instr-action-msg")).toContainText("触发条件已保存");

  // fake 后端记录的是 { instrId, rule }：方向/数量按行回填，价格是用户改的新值。
  const lastTrigger = await page.evaluate(
    () => (window as unknown as { __FAKE_LAST_TRIGGER?: unknown }).__FAKE_LAST_TRIGGER,
  );
  expect(lastTrigger).toMatchObject({
    instrId: 1,
    rule: { upPrice: 1690, side: "BUY", vol: 100, autoConfirm: true },
  });
});

test("触发后一键确认下单：一次确认提交已有信号票", async ({ page }) => {
  await installOpenClock(page);
  await openCockpit(page);

  // 只有「已触发 + 票 pending」的第二行出现「确认下单」；按钮要等券商状态轮询完成才可点。
  const submitBtn = page.getByTestId("instr-submit");
  await expect(submitBtn).toHaveCount(1);
  await expect(submitBtn).toBeEnabled();
  await submitBtn.click();

  // 一次确认：先弹 AppDialog，确认按钮文案「确认提交」与行内「确认下单」区分。
  const dialog = page.getByRole("dialog", { name: "确认下单" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("宁德时代");
  await expect(dialog).toContainText("不会新建第二张票");
  await dialog.getByRole("button", { name: "确认提交" }).click();

  // 提交成功：行内结果提示（沿用触发时生成的票，ticketId=2）。
  await expect(page.getByTestId("instr-action-msg")).toContainText("已提交");
  await expect(page.getByTestId("instr-action-msg")).toContainText("300750");

  const lastSubmit = await page.evaluate(
    () => (window as unknown as { __FAKE_LAST_SUBMIT?: unknown }).__FAKE_LAST_SUBMIT,
  );
  expect(lastSubmit).toMatchObject({ ticketId: 2, price: null, vol: null });
});

test("模拟盘自动执行可逐条关闭：autoConfirm=false 透传", async ({ page }) => {
  await installOpenClock(page);
  await openCockpit(page);

  await page.getByTestId("instr-edit").click();
  const panel = page.getByTestId("instr-edit-panel");
  await expect(panel).toBeVisible();

  // 行 1 缺省开启自动执行；取消勾选后保存必须把 false 透传给后端（只影响模拟盘）。
  const auto = page.getByTestId("instr-auto-confirm");
  await expect(auto).toBeChecked();
  await auto.uncheck();
  await page.getByTestId("instr-save").click();

  await expect(panel).toHaveCount(0);
  const lastTrigger = await page.evaluate(
    () => (window as unknown as { __FAKE_LAST_TRIGGER?: unknown }).__FAKE_LAST_TRIGGER,
  );
  expect(lastTrigger).toMatchObject({ instrId: 1, rule: { autoConfirm: false } });
});

// —— P1-c 命中率 / 8:45 盘前确认提醒验收 ——

test("命中率：作战台头部显示近20日触发/执行/胜率", async ({ page }) => {
  await installOpenClock(page);
  await openCockpit(page);

  // fake 返回有价样本 12 笔（≥3），头部必须出三个百分比而不是「样本不足」。
  const hit = page.getByTestId("hit-rate");
  await expect(hit).toBeVisible();
  await expect(hit).toContainText("62%");
  await expect(hit).toContainText("45%");
  await expect(hit).toContainText("58%");
});

test("8:45 提醒横幅：显示待确认文案，点「去确认」打开今日作战流", async ({ page }) => {
  await installOpenClock(page);
  await openCockpit(page);

  // 横幅是 App 级：通过 fake 事件总线模拟后端 battle:reminder（与 listen 同一个总线实例）。
  await page.evaluate(() =>
    (window as any).__fakeEmit("battle:reminder", {
      kind: "plan-confirm",
      planId: 1,
      planDate: "2026-10-20",
      status: "draft",
      text: "今日作战卡待确认（3 条指令）",
    }),
  );

  const banner = page.getByTestId("reminder-banner");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("今日作战卡待确认（3 条指令）");

  await page.getByTestId("reminder-open").click();
  await expect(banner).toHaveCount(0);
  // 「去确认」走 island:open-card → cockpit：今日作战流卡片内容可见。
  await expect(page.getByTestId("battle-station")).toBeVisible();
});

test("8:45 提醒横幅：点「稍后」仅关闭横幅", async ({ page }) => {
  await installOpenClock(page);
  await openCockpit(page);

  await page.evaluate(() =>
    (window as any).__fakeEmit("battle:reminder", {
      kind: "plan-confirm",
      planId: 1,
      planDate: "2026-10-20",
      status: "draft",
      text: "今日作战卡待确认（3 条指令）",
    }),
  );

  const banner = page.getByTestId("reminder-banner");
  await expect(banner).toBeVisible();
  await page.getByTestId("reminder-dismiss").click();
  await expect(banner).toHaveCount(0);
});

test("作战台确认今日作战卡：弹窗确认后记录 planDate 并显示已确认", async ({ page }) => {
  await installOpenClock(page);
  await openCockpit(page);

  // 缺省 products 分支返回今日 draft（fakeTodayPlan）：作战台直接给出确认入口。
  const confirmBtn = page.getByTestId("confirm-plan");
  await expect(confirmBtn).toBeVisible();
  await expect(confirmBtn).toHaveText("确认今日作战卡");
  await confirmBtn.click();

  const dialog = page.getByRole("dialog", { name: "确认今日作战卡" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("今日作战卡");
  await dialog.getByRole("button", { name: "确认", exact: true }).click();

  // fake 记录 planConfirm 的参数：必须按 battlePlan.planDate（今天）确认一次。
  const today = await page.evaluate(() => {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  });
  const lastConfirm = await page.evaluate(
    () => (window as unknown as { __FAKE_LAST_PLAN_CONFIRM?: unknown }).__FAKE_LAST_PLAN_CONFIRM,
  );
  expect(lastConfirm).toMatchObject({ planDate: today });

  // 成功后确认按钮消失，头部显示「已确认」chip。
  await expect(page.getByTestId("confirm-plan")).toHaveCount(0);
  await expect(page.getByTestId("plan-confirmed")).toHaveText("已确认");
});

test("确认后可启动盯盘：watch-start 调用后端并显示已启动", async ({ page }) => {
  // 缺省 products 模拟「今日计划已确认」：不再出确认按钮，改出「开始盯盘」。
  await seedPlanConfirmed(page);
  await installOpenClock(page);
  await openCockpit(page);

  await expect(page.getByTestId("confirm-plan")).toHaveCount(0);
  await expect(page.getByTestId("plan-confirmed")).toHaveText("已确认");

  const startWatch = page.getByTestId("watch-start");
  await expect(startWatch).toBeVisible();
  await expect(startWatch).toHaveText("开始盯盘");
  await startWatch.click();

  const lastStart = await page.evaluate(
    () => (window as unknown as { __FAKE_LAST_WATCH_START?: unknown }).__FAKE_LAST_WATCH_START,
  );
  expect(lastStart).toMatchObject({ tradeDate: expect.any(String) });

  await expect(page.getByTestId("watch-start")).toHaveCount(0);
  await expect(page.getByTestId("watch-started")).toHaveText("盯盘已启动");
});

// —— P2-a 对账状态常驻 / 下单耗时验收 ——

test("对账 chip 常驻显示对账正常", async ({ page }) => {
  await installOpenClock(page);
  await openCockpit(page);

  // 假后端 `broker_recon_status` 默认返回 matched 报告：chip 必须常驻并给出「正常」结论。
  const chip = page.getByTestId("recon-chip");
  await expect(chip).toBeVisible();
  await expect(chip).toContainText("对账正常");
});

test("对账冲突：chip 显示账实不符，点击打开券商控制台", async ({ page }) => {
  await seedReconConflict(page);
  await installOpenClock(page);
  await openCockpit(page);

  const chip = page.getByTestId("recon-chip");
  await expect(chip).toBeVisible();
  await expect(chip).toContainText("账实不符");

  // chip 走 island:open-card → brokerconsole（与 ConnectionGuard 同路径）：卡片须被打开。
  await chip.click();
  const consoleCard = page.locator('.card-shell[data-card-id="brokerconsole"]');
  await expect(consoleCard).toBeVisible();
  await expect(consoleCard.locator(".card-title")).toHaveText("同花顺控制台");
});

// —— P2-b1 快捷键验收 ——

test("B 快捷键：未开作战台时打开卡片、切买入方向并聚焦代码框", async ({ page }) => {
  await installOpenClock(page);
  await boot(page);

  // 初始恢复的布局（watch/rank/news）不含作战流：确保 B 是从「未挂载」状态打开卡片。
  await expect(page.getByTestId("battle-station")).toHaveCount(0);

  // 非输入态单字母快捷键：B → 打开今日作战流 + 下单条切买入 + 聚焦代码框。
  await page.keyboard.press("b");

  await expect(page.getByTestId("battle-station")).toBeVisible();
  // OrderDock 给当前方向按钮加 .active：买入按钮必须处于选中态。
  await expect(page.getByTestId("order-buy")).toHaveClass(/active/);
  await expect(page.getByTestId("order-sell")).not.toHaveClass(/active/);
  // 聚焦证明 BattleStation 挂载时消费了 pendingOrderSide 并调用 dock.focusSide。
  await expect(page.getByTestId("order-code")).toBeFocused();
});

test("下单耗时：确认下单成功后头部显示最近下单", async ({ page }) => {
  await installOpenClock(page);
  await openCockpit(page);

  // 无耗时记录时头部不渲染（localStorage 按浏览器上下文隔离，本用例从空开始）。
  await expect(page.getByTestId("order-timing")).toHaveCount(0);

  // 复用既有「代码 → 买入 → 确认」三击下单链路，等盘口回填价格后再下单。
  await page.getByTestId("order-code").fill("600519");
  await page.getByTestId("order-code").blur();
  await expect(page.getByTestId("order-dock").locator(".od-num").first()).toHaveValue("1680");
  await page.getByTestId("order-buy").click();
  await expect(page.getByTestId("order-confirm")).toBeVisible();
  await page.getByTestId("order-confirm-ok").click();
  await expect(page.getByTestId("order-msg")).toContainText("QK1");

  // 只有 broker 成功返回才记录耗时；作战台 5s 轮询刷新头部，文本为「最近下单 … · 2 击」。
  const timing = page.getByTestId("order-timing");
  await expect(timing).toBeVisible({ timeout: 10_000 });
  await expect(timing).toContainText("最近下单");
  await expect(timing).toContainText("2 击");
});
