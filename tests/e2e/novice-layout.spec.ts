import { test, expect } from "@playwright/test";

// 回归：新手模式曾把 data-novice 写在 <html> 上，而 SideDock 的
// `:global([data-novice]) .dpi-d` 被 Vue 编译成裸的 `[data-novice]`，
// 命中 <html> 把整窗 opacity 压到 .68，透出 WebView2 白色默认底 → 整窗灰蒙蒙。
test.describe("新手模式：不影响整窗透明度", () => {
  test("开启/关闭 data-novice 时 html 的 opacity 保持 1，且主窗口不透底", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");

    const read = () =>
      page.evaluate(() => ({
        opacity: getComputedStyle(document.documentElement).opacity,
        bg: getComputedStyle(document.documentElement).backgroundColor,
      }));

    const before = await read();
    expect(before.opacity).toBe("1");
    // 主窗口不得透明：透明会让 WebView2 的白底透出来
    expect(before.bg).not.toBe("rgba(0, 0, 0, 0)");

    await page.evaluate(() => document.documentElement.setAttribute("data-novice", "true"));
    expect((await read()).opacity).toBe("1");

    await page.evaluate(() => document.documentElement.removeAttribute("data-novice"));
    expect((await read()).opacity).toBe("1");
  });
});

// 底座面板只保留「图标 + 名称」，一句话用途走悬停 title，
// 避免面板被说明文字塞满（曾出现说明被排进 24px 图标列、逐字换行）。
test.describe("底座面板：精简为图标 + 名称", () => {
  test("面板里没有说明节点，面板宽度保持 250px，用途挂在 title 上", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    await page.locator(".dock-btn").first().click();

    const panel = page.locator(".dock-panel");
    await expect(panel).toBeVisible();
    await expect(panel.locator(".dpi-d")).toHaveCount(0);

    const width = await panel.evaluate((el) => el.getBoundingClientRect().width);
    expect(Math.round(width)).toBe(250);

    const title = await page.locator(".dp-item .dpi-t").first().getAttribute("title");
    expect((title ?? "").length).toBeGreaterThan(0);
  });
});
