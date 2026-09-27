// E2E 辅助：工作台启动、卡片计数、Mega 菜单开卡、关卡等通用操作。
import type { Page } from "@playwright/test";

export async function cardCount(page: Page): Promise<number> {
  return page.locator("[data-card-id]").count();
}
export async function isCardOpen(page: Page, id: string): Promise<boolean> {
  return (await page.locator(`[data-card-id="${id}"]`).count()) > 0;
}

// 启动并等工作台完成初始渲染（卡片数量稳定），不依赖具体初始卡片集合。
export async function boot(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForSelector(".mega-nav");
  await page.waitForSelector(".ws-body");
  let prev = -1;
  let cur = await cardCount(page);
  for (let k = 0; k < 25 && cur !== prev; k++) {
    await page.waitForTimeout(200);
    prev = cur;
    cur = await cardCount(page);
  }
}

// 通过顶部 Mega 菜单打开一张卡片（hover 分类 → 点击功能项）。
export async function openViaMega(
  page: Page,
  groupName: string,
  itemLabel: string
): Promise<void> {
  const tab = page.locator(".mega-tab", { hasText: groupName }).first();
  await tab.hover();
  const item = page.locator(".mega-panel .mp-item", { hasText: itemLabel }).first();
  await item.waitFor({ state: "visible" });
  await item.click();
}

export async function closeCard(page: Page, id: string): Promise<void> {
  await page.locator(`[data-card-id="${id}"] .head-btn[title="关闭卡片"]`).click();
}

//确保卡片已打开（幂等），并等其挂载。
export async function ensureCardOpen(
  page: Page,
  groupName: string,
  itemLabel: string,
  id: string
): Promise<void> {
  const slot = page.locator(`[data-card-id="${id}"]`);
  if (!(await isCardOpen(page, id))) {
    await openViaMega(page, groupName, itemLabel);
    await slot.waitFor();
  }
  // 按需挂载：卡片可能在视口外，需滚入可视区触发 IntersectionObserver，
  // 再等 CardShell 真正挂载（内部图表/按钮才会存在）。
  await slot.scrollIntoViewIfNeeded();
  await slot.locator(".card-shell").waitFor({ state: "visible", timeout: 10000 });
}

// 打开全部卡片：反复扫描 Mega 菜单，hover 分类后按组名确认面板渲染，再开未开项。
export async function openAllCards(page: Page): Promise<void> {
  const groupCount = await page.locator(".mega-tab").count();
  for (let round = 0; round < 40; round++) {
    let opened = false;
    for (let t = 0; t < groupCount && !opened; t++) {
      const tab = page.locator(".mega-tab").nth(t);
      const groupName = (await tab.innerText()).trim();
      await tab.hover();
      // 等当前组面板出现（Transition 期间可能新旧并存，按 h3 组名定位）
      await page.waitForFunction(
        (name) => [...document.querySelectorAll(".mega-panel .mp-head h3")].some((x) => x.textContent === name),
        groupName
      );
      const panel = page.locator(".mega-panel", {
        has: page.locator(".mp-head h3", { hasText: groupName }),
      });
      const items = panel.locator(".mp-item");
      const m = await items.count();
      for (let i = 0; i < m; i++) {
        const cls = (await items.nth(i).getAttribute("class")) ?? "";
        if (!/\bon\b/.test(cls)) {
          await items.nth(i).click(); // 打开后 panel 关闭，需重新 hover
          opened = true;
          break;
        }
      }
    }
    if (!opened) break;
  }
}

// 逐个滚动到每个 slot，触发按需挂载，最终全部 CardShell 挂载（挂载后保持）。
export async function mountAll(page: Page): Promise<void> {
  const n = await page.locator("[data-card-id]").count();
  for (let i = 0; i < n; i++) {
    const s = page.locator("[data-card-id]").nth(i);
    const id = (await s.getAttribute("data-card-id"))!;
    await s.scrollIntoViewIfNeeded();
    await page.locator(`[data-card-id="${id}"] .card-shell`).waitFor({ state: "visible", timeout: 8000 });
  }
}
