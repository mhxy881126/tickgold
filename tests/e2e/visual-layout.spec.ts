// 视觉 / 布局回归基线：以确定性的几何断言锁住「图表留白 / 卡片重叠 / 聚焦不填满」
// 一类回归（曾导致 K线只占顶部、底部大片空白）。固定视口，断言用比例 + 容差，跨平台稳定。
// 纯像素快照受字体 / 抗锯齿影响易抖动，故 CI 另对关键视图截图存档（见 ci.yml）供人工复核。
import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdirSync } from "fs";
import { boot } from "./support/helpers";

test.use({ viewport: { width: 1600, height: 900 } });
mkdirSync("screenshots", { recursive: true });

async function rect(loc: Locator) {
  const b = await loc.boundingBox();
  if (!b) throw new Error("no bounding box for " + loc);
  return { x: b.x, y: b.y, width: b.width, height: b.height, right: b.x + b.width, bottom: b.y + b.height };
}

async function openMini(page: Page) {
  await page.locator(".scene-pill", { hasText: "极简看盘" }).click();
  const chartSlot = page.locator('[data-card-id="chart"]');
  // chart 已恢复经典 StockChart（klinecharts canvas）
  await chartSlot.locator(".chart-host canvas").first().waitFor();
  await page.waitForTimeout(400); // 入场动画 + ResizeObserver settle
  return chartSlot;
}

test("玻璃浮岛：极简场景主卡图表填满主区", async ({ page }) => {
  await boot(page);
  const chartSlot = await openMini(page);

  // data-card-id 直接挂在 CardShell 根节点，chartSlot 本身就是 .card-shell
  const shell = await rect(chartSlot);
  const chartArea = await rect(chartSlot.locator(".sc-chart"));

  // 图表区底部接近卡片底部（底部留白 < 24px，防大片空白）
  expect(chartArea.bottom).toBeGreaterThan(shell.bottom - 24);
  // 主卡占满主区宽度、高度充足
  expect(chartArea.width).toBeGreaterThan(shell.width * 0.7);
  expect(chartArea.height).toBeGreaterThan(180);

  await page.screenshot({ path: "screenshots/01-auto-layout.png" });
});

// 聚焦放大（focus overlay）为已下线的「自由布局」专属能力，玻璃浮岛下不存在，跳过
test.skip("聚焦：卡片放大到主区（自由布局已下线）", async () => {});
