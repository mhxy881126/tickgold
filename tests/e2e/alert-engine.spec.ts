// 预警引擎 E2E：可视化建规则 → 注入跨过阈值的行情 → 弹窗/历史；模板一键建规则。
import { test, expect, type Page } from "@playwright/test";
import { boot, ensureCardOpen } from "./support/helpers";

async function openAlertCenter(page: Page): Promise<void> {
  await ensureCardOpen(page, "情绪异动", "预警", "alert");
}

// 1) 新建规则 → 注入 pct=6 的假行情 → 出现弹窗 & 触发历史
test("可视化建预警：涨跌幅≥5% 触发弹窗并写入历史", async ({ page }) => {
  await boot(page);
  await openAlertCenter(page);
  const card = page.locator('[data-card-id="alert"]');

  // 打开新建对话框
  await card.locator("button", { hasText: "新建预警" }).click();
  const dlg = page.locator(".dialog");
  await dlg.waitFor();

  // 名称
  await dlg.locator("input.inp").first().fill("E2E大涨预警");

  // 条件行：字段选「涨跌幅」(value=pct)，阈值填 5（运算符默认 ≥）
  const leafRow = dlg.locator(".leaf-row").first();
  await leafRow.locator("select.sel").first().selectOption("pct");
  await leafRow.locator("input.num").first().fill("5");

  // 勾选「弹窗」动作（默认未启用）
  await dlg.locator("label.chk", { hasText: "弹窗" }).locator("input").check();

  // 保存
  await dlg.locator("button.primary").click();
  await expect(dlg).toHaveCount(0);

  // 列表中出现新规则
  await expect(card.locator("tbody tr", { hasText: "E2E大涨预警" })).toBeVisible();

  // 注入跨过阈值的假行情（下一次 quotes 轮询 ≤2s 生效）
  await page.evaluate((pct) => {
    const w = window as unknown as {
      __e2e: { setQuoteOverride: (c: string, q: unknown) => void };
    };
    w.__e2e.setQuoteOverride("600519", { pct, price: 106, name: "贵州茅台" });
  }, 6);

  // 弹窗出现（toast-stack teleport 到 body）
  const toast = page.locator(".toast-stack .toast", { hasText: "E2E大涨预警" });
  await expect(toast).toBeVisible({ timeout: 10000 });

  // 触发历史落库
  await card.locator(".tab", { hasText: "触发历史" }).click();
  await expect(
    card.locator("tbody tr", { hasText: "E2E大涨预警" })
  ).toBeVisible({ timeout: 5000 });
});

// 2) 未跨阈值不触发
test("行情未过阈值：不弹窗", async ({ page }) => {
  await boot(page);
  await openAlertCenter(page);
  const card = page.locator('[data-card-id="alert"]');

  await card.locator("button", { hasText: "新建预警" }).click();
  const dlg = page.locator(".dialog");
  await dlg.locator("input.inp").first().fill("E2E不触发");
  const leafRow = dlg.locator(".leaf-row").first();
  await leafRow.locator("select.sel").first().selectOption("pct");
  await leafRow.locator("input.num").first().fill("5");
  await dlg.locator("label.chk", { hasText: "弹窗" }).locator("input").check();
  await dlg.locator("button.primary").click();

  await page.evaluate((pct) => {
    const w = window as unknown as {
      __e2e: { setQuoteOverride: (c: string, q: unknown) => void };
    };
    w.__e2e.setQuoteOverride("600519", { pct, price: 103, name: "贵州茅台" });
  }, 3);

  // 等 3 个轮询周期确认无弹窗
  await page.waitForTimeout(6000);
  await expect(
    page.locator(".toast-stack .toast", { hasText: "E2E不触发" })
  ).toHaveCount(0);
});

// 3) 模板一键建规则
test("模板库：点击「放量异动」一键生成规则", async ({ page }) => {
  await boot(page);
  await openAlertCenter(page);
  const card = page.locator('[data-card-id="alert"]');

  await card.locator(".tpl-btn", { hasText: "放量异动" }).click();

  await expect(card.locator("tbody tr", { hasText: "放量异动" })).toBeVisible({
    timeout: 5000,
  });
});
