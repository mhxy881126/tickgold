import { describe, it, expect } from "vitest";
import { legacyToV2 } from "../../../src/alert/repo";

describe("legacyToV2 旧规则迁移", () => {
  it("上穿价/涨幅/量比 → AND 树对应叶子", () => {
    const r = legacyToV2({
      id: "old1",
      code: "600519",
      name: "贵州茅台",
      up_price: 1800,
      down_price: null,
      up_pct: 5,
      down_pct: null,
      min_volume_ratio: 2,
      rise_speed: null,
      down_speed: null,
      speed_window_sec: null,
      min_turnover: null,
      min_amount: null,
      seal_limit_up: null,
      seal_limit_down: null,
      broken_limit: null,
      cooldown_sec: 300,
      enabled: 1,
    });
    expect(r).not.toBeNull();
    expect(r!.scope).toEqual({ kind: "code", code: "600519" });
    expect(r!.tree.op).toBe("AND");
    const fields = r!.tree.children.map((c) => (c as { field: string }).field);
    expect(fields).toEqual(["price", "pct", "volumeRatio"]);
    const priceLeaf = r!.tree.children[0] as { op: string; value: number };
    expect(priceLeaf.op).toBe("crossUp");
    expect(priceLeaf.value).toBe(1800);
  });

  it("封板/炸板 → 事件叶子", () => {
    const r = legacyToV2({
      id: "x", code: "000001", name: "",
      up_price: null, down_price: null, up_pct: null, down_pct: null,
      min_volume_ratio: null, rise_speed: null, down_speed: null,
      speed_window_sec: null, min_turnover: null, min_amount: null,
      seal_limit_up: 1, seal_limit_down: null, broken_limit: 1,
      cooldown_sec: null, enabled: null,
    });
    const fields = r!.tree.children.map((c) => (c as { field: string }).field);
    expect(fields).toEqual(["evt.sealUp", "evt.broken"]);
  });

  it("无条件 → null", () => {
    expect(
      legacyToV2({
        id: "y", code: "000001", name: "",
        up_price: null, down_price: null, up_pct: null, down_pct: null,
        min_volume_ratio: null, rise_speed: null, down_speed: null,
        speed_window_sec: null, min_turnover: null, min_amount: null,
        seal_limit_up: null, seal_limit_down: null, broken_limit: null,
        cooldown_sec: null, enabled: null,
      })
    ).toBeNull();
  });
});
