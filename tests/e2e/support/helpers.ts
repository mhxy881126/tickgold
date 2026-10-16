// E2E 辅助：工作台启动、卡片计数、添加卡片菜单开卡、关卡、场景切换等通用操作。
// 方案 A（v3.1.0）：左 Dock 管「全部卡片」分组，右栏 .glass-edge 只列「已开卡片」标签
// （.ot-item，带 data-nav-id）；新增卡片走右栏「＋添加卡片」弹出的 .add-menu（.am-item，
// 带 data-card-id，已开项置 .disabled）。
import type { Page } from "@playwright/test";

// 玻璃浮岛模式只渲染一张主卡 DOM，「已开卡数」以右栏「已开卡片」标签项为准
export async function cardCount(page: Page): Promise<number> {
  return page.locator(".glass-edge .ot-item").count();
}
export async function isCardOpen(page: Page, id: string): Promise<boolean> {
  return (await page.locator(`.glass-edge .ot-item[data-nav-id="${id}"]`).count()) > 0;
}

// 启动并等工作台完成初始渲染（已开标签数量稳定），不依赖具体初始卡片集合。
export async function boot(page: Page): Promise<void> {
  await page.goto("/");
  // v3.1.0 右栏为「已开卡片」标签页（.glass-edge），左侧为 Dock 分组侧栏（.side-dock）
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

// 打开「添加卡片」菜单（幂等：已可见则直接复用；按可见性判断，避免与开合 Transition 竞态）
async function openAddMenu(page: Page): Promise<void> {
  const menu = page.locator(".add-menu");
  if (!(await menu.isVisible().catch(() => false))) {
    await page.locator(".ot-add").click();
  }
  await menu.waitFor({ state: "visible", timeout: 10000 });
}

// 通过右栏「添加卡片」菜单打开一张卡片。菜单项带 data-card-id（卡片 id 稳定），
// groupName/itemLabel 仅为与旧用例签名兼容而保留，不再用于定位。
export async function openViaMega(
  page: Page,
  _groupName: string,
  _itemLabel: string,
  cardId?: string
): Promise<void> {
  const id = cardId ?? inferCardId(_itemLabel);
  await openAddMenu(page);
  const item = page.locator(`.add-menu .am-item[data-card-id="${id}"]`).first();
  await item.waitFor({ state: "visible" });
  await item.click(); // 打开后菜单自动关闭
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
  // 优先用右栏已开标签上的 ✕
  const x = page.locator(`.glass-edge .ot-item[data-nav-id="${id}"] .x`);
  if (await x.count()) {
    await x.click();
    return;
  }
  await page.locator(`[data-card-id="${id}"] .head-btn[title="关闭卡片"]`).click();
}

// 确保卡片已打开（幂等），并等其挂载为玻璃浮岛主卡。
export async function ensureCardOpen(
  page: Page,
  groupName: string,
  itemLabel: string,
  id: string
): Promise<void> {
  if (!(await isCardOpen(page, id))) {
    await openViaMega(page, groupName, itemLabel, id);
  } else {
    // 已开但不是当前主卡：点已开标签切到它
    const active = page.locator(`.glass-edge .ot-item[data-nav-id="${id}"].on`);
    if (!(await active.count())) {
      await page.locator(`.glass-edge .ot-item[data-nav-id="${id}"]`).first().click();
    }
  }
  // CardShell 根节点同时带 data-card-id 与 .card-shell
  const shell = page.locator(`[data-card-id="${id}"].card-shell`);
  await shell.waitFor({ state: "visible", timeout: 10000 });
}

// 打开全部卡片：反复打开「添加卡片」菜单，每次按 data-card-id 精确点开第一个未开项，
// 并等待菜单完成收起后再进入下一轮，避免与 Transition 动画竞态导致命中已分离节点。
export async function openAllCards(page: Page): Promise<void> {
  for (let round = 0; round < 80; round++) {
    await openAddMenu(page);
    const candidates = page.locator(".add-menu .am-item:not(.disabled)");
    const n = await candidates.count();
    if (!n) {
      // 全部已开：点菜单外区域关闭菜单
      await page.mouse.click(10, 40);
      await page.locator(".add-menu").waitFor({ state: "hidden" }).catch(() => {});
      break;
    }
    const id = await candidates.first().getAttribute("data-card-id");
    if (!id) break;
    await page.locator(`.add-menu .am-item[data-card-id="${id}"]`).click();
    // 开卡后菜单自动关闭，等其收起完成，下一轮再干净地重开
    await page.locator(".add-menu").waitFor({ state: "hidden", timeout: 10000 });
    await page.waitForTimeout(20);
  }
}

// 玻璃浮岛同一时刻只挂载主卡：逐一点击已开标签项，确保每张卡都完成过一次真实挂载。
export async function mountAll(page: Page): Promise<void> {
  const n = await page.locator(".glass-edge .ot-item").count();
  for (let i = 0; i < n; i++) {
    const item = page.locator(".glass-edge .ot-item").nth(i);
    const id = (await item.getAttribute("data-nav-id"))!;
    await item.click();
    await page
      .locator(`[data-card-id="${id}"].card-shell`)
      .waitFor({ state: "visible", timeout: 10000 });
  }
}

// 方案 A：通过顶部场景切换器（.ss-btn 下拉 → .ss-item）应用一个场景模板。
export async function applyScene(page: Page, label: string): Promise<void> {
  await page.locator(".scene-switcher .ss-btn").click();
  const menuItem = page.locator(".scene-switcher .ss-item", { hasText: label });
  await menuItem.waitFor({ state: "visible", timeout: 10000 });
  await menuItem.click();
}
