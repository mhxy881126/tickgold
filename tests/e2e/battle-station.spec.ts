// 作战台 P0 端到端验收：开盘时段高亮 / 倒计时、下单一次确认、熔断置灰、模拟徽标、新旧作战台切换。
//
// 熔断状态注入（重要）：`tests/e2e/support/backend.ts` 会被 Vite 的 e2e alias 打进浏览器 bundle，
// 与 Node 侧的 Playwright 测试进程是两份模块实例——在 spec 里 import 任何 setter 都改不到页面状态。
// 因此统一用 page.addInitScript 预置 `window.__FAKE_BROKER_STATUS`，由 backend.ts 初始化时合并。
import { test, expect, type Page } from "@playwright/test";

// 2026-10-19 是周一；09:31（Asia/Shanghai）处于「开盘」段，距盘中还有 29 分钟。
const OPEN_AT = new Date("2026-10-19T09:31:00+08:00");

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

test("开盘时段高亮 + 倒计时", async ({ page }) => {
  await installOpenClock(page);
  await openCockpit(page);

  // install 后时钟按真实时间推进，倒计时会从 29:00 往下漂；断言前把时间钉在 09:31:00，
  // 再显式推进 1s，让组件内 1s 时钟刷新一次 now（否则文案仍是上一 tick 的读数）。
  await page.clock.setFixedTime(OPEN_AT);
  await page.clock.runFor(1000);

  await expect(page.locator(".btl-seg.on")).toContainText("开盘");
  await expect(page.getByTestId("battle-countdown")).toContainText("距盘中");
  await expect(page.getByTestId("battle-countdown")).toContainText("29:00");
});

test("模拟盘下单：3 次点击 + 一次确认", async ({ page }) => {
  await installOpenClock(page);
  await openCockpit(page);

  await page.getByTestId("order-code").fill("600519");
  await page.getByTestId("order-code").blur();
  // 等盘口把价格回填（价格仍为 0 时「确认下单」会被 canSubmitQuickOrder 拦住而不可点）
  await expect(page.getByTestId("order-dock").locator(".od-num").first()).toHaveValue("1680");

  await page.getByTestId("order-buy").click();
  await expect(page.getByTestId("order-confirm")).toBeVisible();
  await expect(page.getByTestId("order-confirm")).toContainText("贵州茅台");

  await page.getByTestId("order-confirm-ok").click();
  await expect(page.getByTestId("order-msg")).toContainText("QK1");
});

test("熔断时下单条置灰", async ({ page }) => {
  await seedBrokerStatus(page, { killSwitch: true });
  await installOpenClock(page);
  await openCockpit(page);

  await expect(page.getByTestId("order-buy")).toBeDisabled();
  await expect(page.getByTestId("order-sell")).toBeDisabled();
  await expect(page.getByTestId("order-mode")).toContainText("已熔断");
});

test("默认模拟徽标 + 未启用实盘提示", async ({ page }) => {
  // 不注入 patch：默认 kind=mock / liveEnabled=false / connected=true / killSwitch=false。
  await installOpenClock(page);
  await openCockpit(page);

  await expect(page.getByTestId("order-mode")).toContainText("模拟");
  await expect(page.getByTestId("order-buy")).toBeEnabled();
});

test("旧版六步 / 新版作战台可切换", async ({ page }) => {
  await installOpenClock(page);
  await openCockpit(page);

  await page.locator(".battle-switch").click();
  await expect(page.getByTestId("battle-station")).toHaveCount(0);
  await expect(page.locator(".battle-switch")).toHaveText("新版作战台");

  await page.locator(".battle-switch").click();
  await expect(page.getByTestId("battle-station")).toBeVisible();
  await expect(page.locator(".battle-switch")).toHaveText("旧版六步");
});
