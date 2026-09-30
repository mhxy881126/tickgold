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
  await page.locator(".scene-chip", { hasText: "极简看盘" }).click();
  const chartSlot = page.locator('[data-card-id="chart"]');
  // chart 已恢复经典 StockChart（klinecharts canvas）
  await chartSlot.locator(".chart-host canvas").first().waitFor();
  await page.waitForTimeout(400); // 入场动画 + ResizeObserver settle
  return chartSlot;
}

test("自动布局：图表填满卡片、卡片互不重叠", async ({ page }) => {
  await boot(page);
  const chartSlot = await openMini(page);

  const shell = await rect(chartSlot.locator(".card-shell"));
  const chartArea = await rect(chartSlot.locator(".sc-chart"));

  // 图表区底部接近卡片底部（底部留白 < 24px，防大片空白）
  expect(chartArea.bottom).toBeGreaterThan(shell.bottom - 24);
  // 极简场景下图表占满整行宽度、高度充足
  expect(chartArea.width).toBeGreaterThan(shell.width * 0.7);
  expect(chartArea.height).toBeGreaterThan(180);

  // watch 在 chart 下方，垂直不重叠
  const watch = await rect(page.locator('[data-card-id="watch"] .card-shell'));
  const vOverlap = Math.min(shell.bottom, watch.bottom) - Math.max(shell.y, watch.y);
  expect(vOverlap).toBeLessThan(4);

  await page.screenshot({ path: "screenshots/01-auto-layout.png" });
});

test("聚焦：卡片放大到主区、canvas 放大、切换栏可见，退出后复位", async ({ page }) => {
  await boot(page);
  const chartSlot = await openMini(page);
  const beforeCanvas = await rect(chartSlot.locator(".chart-host canvas").first());

  await chartSlot.locator(".head-btn[title^='聚焦']").click();
  await page.locator(".focus-rail").waitFor();
  await page.waitForTimeout(800); // FLIP .46s + canvas resize

  const vp = page.viewportSize()!;
  const target = await rect(page.locator(".focus-target")); // visibility:hidden 但有 rect
  const slot = await rect(chartSlot);

  // 聚焦卡片精确放大到目标区（位置 / 尺寸吻合，容差 8px）
  expect(Math.abs(slot.x - target.x)).toBeLessThan(8);
  expect(Math.abs(slot.y - target.y)).toBeLessThan(8);
  expect(Math.abs(slot.width - target.width)).toBeLessThan(8);
  expect(Math.abs(slot.height - target.height)).toBeLessThan(8);
  // 主区占视口主体
  expect(slot.width).toBeGreaterThan(vp.width * 0.78);
  expect(slot.height).toBeGreaterThan(vp.height * 0.82);

  // canvas 较聚焦前明显放大
  const afterCanvas = await rect(chartSlot.locator(".chart-host canvas").first());
  expect(afterCanvas.width).toBeGreaterThan(beforeCanvas.width);
  expect(afterCanvas.height).toBeGreaterThan(beforeCanvas.height + 80);

  await page.screenshot({ path: "screenshots/02-focus.png" });

  // 切换栏在右侧、可见、高度充足
  const rail = page.locator(".focus-rail");
  await expect(rail).toBeVisible();
  const rb = await rect(rail);
  expect(rb.x).toBeGreaterThan(vp.width * 0.8);
  expect(rb.height).toBeGreaterThan(vp.height * 0.8);

  // 退出聚焦，overlay 消失
  await page.locator(".focus-backdrop").dispatchEvent("click");
  await expect(page.locator(".focus-backdrop")).toBeHidden();
  await expect(page.locator(".focus-rail")).toBeHidden();
});
