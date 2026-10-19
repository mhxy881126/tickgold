import { test, expect } from "@playwright/test";

// 回归：新手模式曾把 data-novice 写在 <html> 上，而 SideDock 的
// `:global([data-novice]) .dpi-d` 被 Vue 编译成裸的 `[data-novice]`，
// 命中 <html> 把整窗 opacity 压到 .68，透出 WebView2 白色默认底 → 整窗灰蒙蒙。
test.describe("新手模式：只影响底座文案，不影响整窗透明度", () => {
  test("开启/关闭 data-novice 时 html 的 opacity 保持 1，且主窗口不透底", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");

    const read = () =>
      page.evaluate(() => ({
        opacity: getComputedStyle(document.documentElement).opacity,
        bg: getComputedStyle(document.documentElement).backgroundColor,
        doc: getComputedStyle(document.documentElement).opacity,
      }));

    const before = await read();
    expect(before.opacity).toBe("1");
    // 主窗口不得透明：透明会让 WebView2 的白底透出来
    expect(before.bg).not.toBe("rgba(0, 0, 0, 0)");

    await page.evaluate(() => document.documentElement.setAttribute("data-novice", "true"));
    const on = await read();
    expect(on.opacity).toBe("1");

    await page.evaluate(() => document.documentElement.removeAttribute("data-novice"));
    const off = await read();
    expect(off.opacity).toBe("1");
  });

  test("新手模式下底座一句话说明可见，关闭后隐藏", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");

    await page.locator(".dock-btn").first().click();
    const hint = page.locator(".dpi-d").first();
    await expect(hint).toHaveCSS("display", "none");

    await page.evaluate(() => document.documentElement.setAttribute("data-novice", "true"));
    await expect(hint).toHaveCSS("display", "block");

    await page.evaluate(() => document.documentElement.removeAttribute("data-novice"));
    await expect(hint).toHaveCSS("display", "none");
  });
});
