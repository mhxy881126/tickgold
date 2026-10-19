// 作战台 P0 端到端验收：开盘时段高亮 / 倒计时、下单一次确认、熔断置灰、模拟/实盘徽标、
// 实盘未启用前端拦截、新旧作战台切换，以及 P1-a 指令列表的状态徽标与触发提示。
//
// 熔断状态注入（重要）：`tests/e2e/support/backend.ts` 会被 Vite 的 e2e alias 打进浏览器 bundle，
// 与 Node 侧的 Playwright 测试进程是两份模块实例——在 spec 里 import 任何 setter 都改不到页面状态。
// 因此统一用 page.addInitScript 预置 `window.__FAKE_BROKER_STATUS`，由 backend.ts 初始化时合并。
import { test, expect, type Page } from "@playwright/test";

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

/** 时钟锁定到开盘时段后再进页面，避免用例受真实时间/时区影响。 */
async function installOpenClock(page: Page): Promise<void> {
  await page.clock.install({ time: OPEN_AT });
}

async function openCockpit(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForLoadState("domcontentloaded");
  await expect(page.locator(".dock-btn").first()).toBeVisible();

  // 出厂分组里「交易工具」是第 6 个（nth(5)）；这里优先按文本定位，分组顺序被自定义调整时不会点错。
  const tradeGroup = page.locator(".dock-btn").filter({ hasText: "交易" });
  const groupBtn = (await tradeGroup.count()) > 0 ? tradeGroup.first() : page.locator(".dock-btn").nth(5);
  await groupBtn.click();

  const panel = page.locator(".dock-panel").first();
  await expect(panel).toBeVisible();
  await expect(panel.locator(".dp-head h3")).toHaveText("交易工具");
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
