// 左侧 Dock 交互回归：hover/点击分组按钮浮出功能面板。
// 关键回归点（v3.1.0 方案 A + v3.1.1 修复）：浮出面板 Teleport 到 body，
// 必须完整落在视口内，不被侧栏层叠上下文、右栏 overflow 或玻璃卡片裁剪。
import { test, expect } from "@playwright/test";
import { boot } from "./support/helpers";

test("左侧 Dock：hover 分组按钮浮出功能面板，且完整在视口内不被裁剪", async ({ page }) => {
  await boot(page);

  const btn = page.locator(".side-dock .dock-scroll .dock-btn").first();
  await btn.hover();

  const panel = page.locator(".dock-panel").first();
  await panel.waitFor({ state: "visible", timeout: 5000 });
  await expect(panel.locator(".dp-head h3")).toHaveText("行情·选股");

  // 等待 dpop 进入动画（translateX(-8px)→0）结束，再取静止后的位置
  await page.waitForTimeout(220);
  const box = await panel.boundingBox();
  expect(box).not.toBeNull();
  const vp = page.viewportSize()!;
  // 面板从 Dock 右侧浮出（left:68），不应被 Dock 盖住
  expect(box!.x).toBeGreaterThanOrEqual(67);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  // 右/下边界完整落在视口内（不被裁剪、不溢出屏幕）
  expect(box!.x + box!.width).toBeLessThanOrEqual(vp.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(vp.height);
  expect(await panel.locator(".dp-item").count()).toBeGreaterThan(0);
});

test("左侧 Dock：hover 切换分组，点击锁定后面板保持可见", async ({ page }) => {
  await boot(page);

  const btns = page.locator(".side-dock .dock-scroll .dock-btn");
  await btns.nth(1).hover();
  const panel = page.locator(".dock-panel").first();
  await panel.waitFor({ state: "visible", timeout: 5000 });
  await expect(panel.locator(".dp-head h3")).toHaveText("盯盘·复盘");

  // 点击按钮锁定面板（真实 WebView2 下 hover 时序易使面板一闪即关，点击后须保持）
  await btns.nth(1).click();
  await expect(panel).toBeVisible();

  // hover 第三个分组时面板切换到对应分组
  await btns.nth(2).hover();
  await expect(panel.locator(".dp-head h3")).toHaveText("交易·执行");
});
