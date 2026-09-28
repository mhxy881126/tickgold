import { describe, it, expect, vi } from "vitest";
import { installBrowserGlobals } from "./helpers/browser-globals";
installBrowserGlobals();
import { useActions } from "../../src/composables/useActions";
import { useCommandPalette } from "../../src/composables/useCommandPalette";

const { register, unregister } = useActions();

describe("命令面板", () => {
  it("搜索过滤并执行动作、执行后关闭", () => {
    const openChart = vi.fn();
    const openNews = vi.fn();
    register({ id: "cp.chart", title: "K线", category: "个股", keywords: "chart", run: openChart });
    register({ id: "cp.news", title: "快讯", category: "情绪", run: openNews });
    const p = useCommandPalette();
    p.openPalette();
    expect(p.paletteOpen.value).toBe(true);

    p.paletteQuery.value = "k线";
    expect(p.pFiltered.value.length).toBe(1);
    expect(p.pFiltered.value[0].label).toBe("K线");
    p.runPalette();
    expect(openChart).toHaveBeenCalledTimes(1);
    expect(openNews).not.toHaveBeenCalled();
    expect(p.paletteOpen.value).toBe(false);

    unregister("cp.chart");
    unregister("cp.news");
  });

  it("无查询时 应用 / 场景 / 窗口 置顶", () => {
    register({ id: "cp.app", title: "设置", category: "应用", run: () => {} });
    register({ id: "cp.card", title: "自选", category: "大盘总览", run: () => {} });
    register({ id: "cp.scene", title: "盘中", category: "场景模板", run: () => {} });
    const p = useCommandPalette();
    p.openPalette();
    const cats = p.pFiltered.value.map((r) => r.cat);
    expect(cats.indexOf("应用")).toBeLessThan(cats.indexOf("大盘总览"));
    expect(cats.indexOf("场景模板")).toBeLessThan(cats.indexOf("大盘总览"));
    unregister("cp.app");
    unregister("cp.card");
    unregister("cp.scene");
  });
});
