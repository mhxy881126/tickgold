// 关键链路 E2E：开卡 / 聚焦 / 场景切换 / 数据加载。
// 用例不依赖固定的初始卡片集合（启动按当前时段开默认卡），全部采用幂等操作。
import { test, expect } from "@playwright/test";
import { boot, cardCount, isCardOpen, openViaMega, ensureCardOpen } from "./support/helpers";

// 1) 开卡：通过 Mega 菜单新增一张卡片，卡片数 +1
test("开卡：Mega 菜单打开 K线卡片", async ({ page }) => {
  await boot(page);
  const before = await cardCount(page);
  expect(await isCardOpen(page, "chart")).toBe(false);

  await openViaMega(page, "个股行情", "K线/分时");

  await expect(page.locator('[data-card-id="chart"]')).toHaveCount(1);
  expect(await cardCount(page)).toBe(before + 1);
});

// 2) 聚焦：卡片放大到主区，出现遮罩与切换栏；可还原
test("聚焦：放大卡片并可还原", async ({ page }) => {
  await boot(page);
  // 用极简看盘场景：chart 为视口内大卡、天然挂载，无需滚动（避免滚动后遮罩与网格错位）
  await page.locator(".scene-chip", { hasText: "极简看盘" }).click();
  const chartSlot = page.locator('[data-card-id="chart"]');
  await chartSlot.locator(".card-shell").waitFor({ state: "visible" });

  await chartSlot.locator(".head-btn[title^='聚焦']").click();

  await expect(page.locator(".focus-backdrop")).toBeVisible();
  await expect(page.locator(".focus-rail")).toBeVisible();

  // 直接在遮罩元素上派发 click 退出（不依赖命中检测，不受下层卡片影响）
  await page.locator(".focus-backdrop").dispatchEvent("click");
  await expect(page.locator(".focus-backdrop")).toBeHidden();
});

// 3) 场景切换：一键替换为「极简看盘」布局（chart / watch）
test("场景切换：应用极简看盘模板", async ({ page }) => {
  await boot(page);
  const chip = page.locator(".scene-chip", { hasText: "极简看盘" });

  await chip.click();

  await expect(chip).toHaveClass(/\bon\b/);
  await expect(page.locator('[data-card-id="chart"]')).toBeVisible();
  await expect(page.locator('[data-card-id="watch"]')).toBeVisible();
});

// 4) 数据加载：K线 loading 消失、canvas 渲染、头部有名称
test("数据加载：K线渲染且加载遮罩消失", async ({ page }) => {
  await boot(page);
  await ensureCardOpen(page, "个股行情", "K线/分时", "chart");

  const chartCard = page.locator('[data-card-id="chart"]');

  // 首次加载遮罩最终消失（成功后 loading / err 都不渲染）
  await expect(chartCard.locator(".sc-mask")).toHaveCount(0, { timeout: 15000 });
  // klinecharts 渲染出 canvas
  await expect(chartCard.locator(".chart-host canvas").first()).toBeVisible({ timeout: 10000 });
  // 头部股票名非空
  await expect(chartCard.locator(".sc-name")).not.toHaveText("");
});
