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

// 2) 聚焦放大（focus overlay）为已下线的「自由布局」专属能力，玻璃浮岛下不存在，跳过
test.skip("聚焦：放大卡片并可还原（自由布局已下线）", async () => {});

// 3) 场景切换：一键切换「极简看盘」，chart 成为玻璃浮岛主卡
test("场景切换：应用极简看盘模板", async ({ page }) => {
  await boot(page);
  const chip = page.locator(".scene-pill", { hasText: "极简看盘" });

  await chip.click();

  await expect(chip).toHaveClass(/\bon\b/);
  // 玻璃浮岛只渲染当前主卡，极简场景首卡为 chart
  await expect(page.locator('[data-card-id="chart"].card-shell')).toBeVisible();
  // watch 在该场景已开（导航项不带 closed）
  await expect(
    page.locator('.glass-edge .ge-item[data-nav-id="watch"]:not(.closed)')
  ).toHaveCount(1);
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
