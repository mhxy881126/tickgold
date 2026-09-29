import { test, expect } from "@playwright/test";
import { boot } from "./support/helpers";

test("chart 卡：默认经典 StockChart，编排微件后可一键还原", async ({ page }) => {
  await boot(page);
  // 极简看盘场景：chart 卡现在默认渲染经典完整 StockChart
  await page.locator(".scene-chip", { hasText: "极简看盘" }).click();
  const chartCard = page.locator('[data-card-id="chart"]');
  await expect(chartCard).toBeVisible();
  await expect(chartCard.locator(".sc-tabs")).toBeVisible();
  await expect(chartCard.locator(".wc-wrap")).toHaveCount(0);
  await expect(chartCard.locator(".sc-tab", { hasText: "日K" })).toHaveCount(1);
  await expect(chartCard.locator(".chart-host canvas").first()).toBeVisible({ timeout: 10000 });

  // 进入编排 → chart 无出厂模板，画布初始为空；手动添加一个微件
  await chartCard.locator(".head-btn[title='编排卡内微件']").click();
  await expect(chartCard.locator(".we-root")).toBeVisible();
  await expect(chartCard.locator(".wc-empty")).toBeVisible();
  await chartCard.locator(".wt-btn", { hasText: "分时图" }).first().click();
  await expect(chartCard.locator(".widget-cell")).toHaveCount(1);

  // 经典视图：移除微件，还原 StockChart
  await chartCard.locator(".we-reset", { hasText: "经典视图" }).click();
  await expect(chartCard.locator(".sc-tabs")).toBeVisible();
  await expect(chartCard.locator(".wc-wrap")).toHaveCount(0);
  await expect(chartCard.locator(".chart-host canvas").first()).toBeVisible({ timeout: 10000 });
});
