import { describe, expect, it } from "vitest";
import {
  PIP_MAX_H,
  PIP_MAX_W,
  PIP_MIN_H,
  PIP_MIN_W,
  parsePipLabel,
  pipLabel,
  resolveGeometry,
  upsertGeometry,
  widgetWindowSize,
} from "../../src/lib/pip";

describe("pipLabel / parsePipLabel", () => {
  it("整卡 label 往返", () => {
    const t = { kind: "card", cardId: "chart" } as const;
    const label = pipLabel(t);
    expect(label).toBe("pip-card-chart");
    expect(parsePipLabel(label)).toEqual(t);
  });

  it("单微件 label 往返（widgetId 含下划线/数字）", () => {
    const t = {
      kind: "widget",
      cardId: "chart",
      widgetId: "w_minute-chart_lq1a_3",
    } as const;
    const label = pipLabel(t);
    expect(label).toBe("pip-widget-chart-w_minute-chart_lq1a_3");
    expect(parsePipLabel(label)).toEqual(t);
  });

  it("非 pip label 与非法结构返回 null", () => {
    expect(parsePipLabel("main")).toBeNull();
    expect(parsePipLabel("pip-unknown-x")).toBeNull();
    expect(parsePipLabel("pip-card-")).toBeNull();
    expect(parsePipLabel("pip-widget-chart")).toBeNull(); // 缺 widgetId
    expect(parsePipLabel("pip-widget--w1")).toBeNull(); // 缺 cardId
  });
});

describe("widgetWindowSize 跨度换算与 clamp", () => {
  it("常规跨度按列/行像素换算", () => {
    expect(widgetWindowSize({ w: 8, h: 5 })).toEqual({ w: 320, h: 180 });
  });

  it("小跨度不小于窗口下限", () => {
    const s = widgetWindowSize({ w: 2, h: 1 });
    expect(s.w).toBe(PIP_MIN_W);
    expect(s.h).toBe(PIP_MIN_H);
  });

  it("满跨度：宽 12*40=480；高 60*36 被封顶到上限", () => {
    const s = widgetWindowSize({ w: 12, h: 60 });
    expect(s.w).toBe(480);
    expect(s.h).toBe(PIP_MAX_H);
    expect(widgetWindowSize({ w: 12, h: 60 }).w).toBeLessThanOrEqual(PIP_MAX_W);
  });
});

describe("resolveGeometry 三兜底", () => {
  const card = { kind: "card", cardId: "chart" } as const;

  it("无 raw 回落默认", () => {
    const g = resolveGeometry(null, card);
    expect(g).toEqual({ w: 480, h: 360, x: 120, y: 120 });
    expect(resolveGeometry(undefined, card)).toEqual(g);
  });

  it("坏 JSON 回落默认", () => {
    expect(resolveGeometry("{not json", card)).toEqual({
      w: 480, h: 360, x: 120, y: 120,
    });
  });

  it("记录存在但缺该 label 回落默认", () => {
    const raw = JSON.stringify({ "pip-card-other": { x: 1, y: 2, w: 300, h: 200 } });
    expect(resolveGeometry(raw, card)).toEqual({ w: 480, h: 360, x: 120, y: 120 });
  });

  it("尺寸低于下限回落默认", () => {
    const raw = JSON.stringify({
      "pip-card-chart": { x: 0, y: 0, w: 100, h: 100 },
    });
    expect(resolveGeometry(raw, card)).toEqual({ w: 480, h: 360, x: 120, y: 120 });
  });

  it("字段类型非法回落默认", () => {
    const raw = JSON.stringify({
      "pip-card-chart": { x: "0", y: 0, w: 300, h: 200 },
    });
    expect(resolveGeometry(raw, card)).toEqual({ w: 480, h: 360, x: 120, y: 120 });
  });

  it("合法记录原样返回（取整、封顶）", () => {
    const raw = JSON.stringify({
      "pip-card-chart": { x: 50.4, y: 60.6, w: 500, h: 400 },
    });
    expect(resolveGeometry(raw, card)).toEqual({ x: 50, y: 61, w: 500, h: 400 });
  });

  it("单微件默认尺寸来自实例跨度", () => {
    const t = { kind: "widget", cardId: "chart", widgetId: "w1" } as const;
    const g = resolveGeometry(null, t, { w: 8, h: 5 } as never);
    expect(g).toMatchObject({ w: 320, h: 180 });
  });
});

describe("upsertGeometry", () => {
  it("在已有 map 上合并更新", () => {
    const raw = JSON.stringify({ a: { x: 1, y: 1, w: 300, h: 200 } });
    const next = upsertGeometry(raw, "b", { x: 2, y: 2, w: 320, h: 240 });
    const map = JSON.parse(next);
    expect(map.a).toEqual({ x: 1, y: 1, w: 300, h: 200 });
    expect(map.b).toEqual({ x: 2, y: 2, w: 320, h: 240 });
  });

  it("覆盖同 label 旧值", () => {
    const raw = JSON.stringify({ a: { x: 1, y: 1, w: 300, h: 200 } });
    const next = JSON.parse(
      upsertGeometry(raw, "a", { x: 9, y: 9, w: 400, h: 300 })
    );
    expect(next.a).toEqual({ x: 9, y: 9, w: 400, h: 300 });
  });

  it("坏 JSON / 空值从空 map 开始", () => {
    const next = JSON.parse(
      upsertGeometry("oops", "a", { x: 1, y: 1, w: 300, h: 200 })
    );
    expect(next.a).toEqual({ x: 1, y: 1, w: 300, h: 200 });
  });
});
