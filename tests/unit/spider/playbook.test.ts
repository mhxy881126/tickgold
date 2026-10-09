import { describe, expect, it } from "vitest";
import { planPlaybook, type OpStep } from "../../../src/components/spider/playbook";
import type { UiElement } from "../../../src/components/spider/uiGraph";

function mkEl(p: Partial<UiElement> & { id: string }): UiElement {
  return {
    cardId: "rank",
    kind: "button",
    el: {} as HTMLElement,
    x: 0, y: 0, width: 40, height: 20, cx: 20, cy: 10,
    text: "",
    disabled: false,
    active: false,
    semantic: "unknown",
    ...p,
  } as UiElement;
}

function tab(id: string, active = false): UiElement {
  return mkEl({ id, cardId: "rank", kind: "tab", text: id, active });
}
function row(id: string, pct: number, code = id): UiElement {
  return mkEl({ id, cardId: "rank", kind: "row", pct, code, name: id });
}
function scrollEl(id: string, canDown = true): UiElement {
  return mkEl({
    id, cardId: "rank", kind: "scroll",
    scroll: {
      scrollTop: 0, scrollHeight: 400, clientHeight: 100,
      atTop: true, atBottom: !canDown, canDown, canUp: false,
    },
  });
}

describe("planPlaybook 操作剧本", () => {
  it("按 切标签→滚动→点个股 顺序生成，且遵守数量上限", () => {
    const ui = [
      tab("t0"), tab("t1"), tab("t2"),
      scrollEl("s"),
      row("r0", 1), row("r1", 5), row("r2", 3), row("r3", 2), row("r4", 0),
    ];
    const steps = planPlaybook(ui);
    // 2 tabs + 1 scroll + 2 rows = 5
    expect(steps).toHaveLength(5);
    expect(steps[0]!.rescan).toBe("tab");
    expect(steps[1]!.rescan).toBe("tab");
    expect(steps[2]!.type).toBe("scroll-down");
    expect(steps[2]!.rescan).toBe("scroll");
    expect(steps[3]!.rescan).toBe("none");
    expect(steps[4]!.rescan).toBe("none");
  });

  it("不选择已激活 / 已操作过的标签", () => {
    const ui = [tab("t0", true), tab("t1")];
    const steps = planPlaybook(ui, { doneIds: new Set(["t1"]) });
    expect(steps.find((s) => s.ui.id === "t0")).toBeUndefined();
    expect(steps.find((s) => s.ui.id === "t1")).toBeUndefined();
  });

  it("滚动次数达到上限后不再生成滚动步骤", () => {
    const ui = [scrollEl("s", true)];
    const steps = planPlaybook(ui, { scrollRounds: 2, maxScrollRounds: 2 });
    expect(steps.some((s) => s.type === "scroll-down")).toBe(false);
  });

  it("已到底的滚动容器不再滚动", () => {
    const ui = [scrollEl("s", false)];
    const steps = planPlaybook(ui);
    expect(steps.some((s) => s.type === "scroll-down")).toBe(false);
  });

  it("点个股时 focusCode 优先，否则按涨幅排序", () => {
    const ui = [row("low", 1, "LOW"), row("high", 9, "HIGH")];
    const byPct = planPlaybook(ui);
    expect((byPct[0] as OpStep).ui.code).toBe("HIGH");

    const byFocus = planPlaybook(ui, { focusCode: "LOW" });
    expect((byFocus[0] as OpStep).ui.code).toBe("LOW");
  });

  it("每个步骤的 arriveId 唯一", () => {
    const ui = [tab("t0"), tab("t1"), scrollEl("s"), row("r0", 1), row("r1", 2)];
    const ids = planPlaybook(ui).map((s) => s.arriveId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
