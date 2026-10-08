// E2E 辅助：工作台启动、卡片计数、Mega 菜单开卡、关卡等通用操作。
import type { Page } from "@playwright/test";

// 玻璃浮岛模式只渲染一张主卡 DOM，「已开卡数」以左侧导航中未标 .closed 的项为准
export async function cardCount(page: Page): Promise<number> {
  return page.locator(".glass-edge .ge-item:not(.closed)").count();
}
export async function isCardOpen(page: Page, id: string): Promise<boolean> {
  const cls =
    (await page
      .locator(`.glass-edge .ge-item[data-nav-id="${id}"]`)
      .first()
      .getAttribute("class")) ?? "";
  return !!cls && !/\bclosed\b/.test(cls);
}

// 启动并等工作台完成初始渲染（卡片数量稳定），不依赖具体初始卡片集合。
export async function boot(page: Page): Promise<void> {
  await page.goto("/");
  // v2.12 起导航为左侧分组侧栏（.glass-edge），旧版顶部 Mega 菜单（.mega-nav）已移除
  await page.waitForSelector(".glass-edge");
  await page.waitForSelector(".ws-body");
  let prev = -1;
  let cur = await cardCount(page);
  for (let k = 0; k < 25 && cur !== prev; k++) {
    await page.waitForTimeout(200);
    prev = cur;
    cur = await cardCount(page);
  }
}

// 通过左侧分组侧栏打开一张卡片。侧栏按钮带 data-nav-id（卡片 id 稳定），
// groupName/itemLabel 仅为与旧用例签名兼容而保留，不再用于定位。
export async function openViaMega(
  page: Page,
  _groupName: string,
  _itemLabel: string,
  cardId?: string
): Promise<void> {
  const id = cardId ?? inferCardId(_itemLabel);
  const item = page.locator(`.glass-edge .ge-item[data-nav-id="${id}"]`).first();
  // 先展开所属分组（折叠时子项不可见）
  const group = page
    .locator(`.glass-edge .ge-group:has(.ge-item[data-nav-id="${id}"])`)
    .first();
  if (await group.count()) {
    if (!(await group.evaluate((el) => el.classList.contains("open")))) {
      await group.locator(".ge-group-head").click();
    }
  }
  await item.waitFor({ state: "visible" });
  await item.click();
}

// 旧 label → 卡片 id（仅给未显式传 id 的历史调用兜底）
const LABEL_TO_ID: Record<string, string> = {
  "K线/分时": "chart",
  "预警": "alert",
};
function inferCardId(label: string): string {
  return LABEL_TO_ID[label] ?? label;
}

export async function closeCard(page: Page, id: string): Promise<void> {
  await page.locator(`[data-card-id="${id}"] .head-btn[title="关闭卡片"]`).click();
}

//确保卡片已打开（幂等），并等其挂载为玻璃浮岛主卡。
export async function ensureCardOpen(
  page: Page,
  groupName: string,
  itemLabel: string,
  id: string
): Promise<void> {
  if (!(await isCardOpen(page, id))) {
    await openViaMega(page, groupName, itemLabel, id);
  } else {
    // 已开但不是当前主卡：点导航切到它
    const active = page.locator(`.glass-edge .ge-item[data-nav-id="${id}"].on`);
    if (!(await active.count())) {
      await page.locator(`.glass-edge .ge-item[data-nav-id="${id}"]`).first().click();
    }
  }
  // CardShell 根节点同时带 data-card-id 与 .card-shell
  const shell = page.locator(`[data-card-id="${id}"].card-shell`);
  await shell.waitFor({ state: "visible", timeout: 10000 });
}

// 打开全部卡片：逐个展开左侧分组，点击未开项（.closed），直到无未开项。
export async function openAllCards(page: Page): Promise<void> {
  for (let round = 0; round < 80; round++) {
    let opened = false;
    const closed = page.locator(".glass-edge .ge-item.closed");
    if (!(await closed.count())) break;
    const navId = (await closed.first().getAttribute("data-nav-id")) ?? "";
    const group = page
      .locator(`.glass-edge .ge-group:has(.ge-item[data-nav-id="${navId}"])`)
      .first();
    if (await group.count()) {
      if (!(await group.evaluate((el) => el.classList.contains("open")))) {
        await group.locator(".ge-group-head").click();
      }
    }
    await closed.first().click();
    opened = true;
    if (!opened) break;
  }
}

// 玻璃浮岛同一时刻只挂载主卡：逐一点击已开导航项，确保每张卡都完成过一次真实挂载。
export async function mountAll(page: Page): Promise<void> {
  const items = page.locator(".glass-edge .ge-item:not(.closed)");
  const n = await items.count();
  for (let i = 0; i < n; i++) {
    const item = items.nth(i);
    const id = (await item.getAttribute("data-nav-id"))!;
    const group = page
      .locator(`.glass-edge .ge-group:has(.ge-item[data-nav-id="${id}"])`)
      .first();
    if (await group.count()) {
      if (!(await group.evaluate((el) => el.classList.contains("open")))) {
        await group.locator(".ge-group-head").click();
      }
    }
    await item.click();
    await page
      .locator(`[data-card-id="${id}"].card-shell`)
      .waitFor({ state: "visible", timeout: 10000 });
  }
}
