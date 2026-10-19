import { describe, expect, it } from "vitest";
import { stateMeta, triggerHint } from "../../src/components/battle/instructionModel";

describe("instructionModel", () => {
  it("状态文案与色调", () => {
    expect(stateMeta("pending").label).toBe("待触发");
    expect(stateMeta("triggered").label).toBe("已触发");
    expect(stateMeta("submitted").label).toBe("已下单");
    expect(stateMeta("filled").label).toBe("已成交");
    expect(stateMeta("cancelled").label).toBe("已取消");
    expect(stateMeta("expired").label).toBe("已过期");
    expect(stateMeta("watch").label).toBe("仅观察");
    expect(stateMeta("unknown").label).toBe("仅观察");
    expect(stateMeta("pending").tone).toBe("info");
    expect(stateMeta("filled").tone).toBe("up");
  });

  it("触发提示解析", () => {
    const json = JSON.stringify([
      { field: "price", op: "gte", value: 10.5 },
      { field: "pct", op: "gte", value: 3 },
      { field: "volumeRatio", op: "gte", value: 2 },
    ]);
    const hint = triggerHint(json);
    expect(hint).toContain("≥10.50");
    expect(hint).toContain("涨幅≥3%");
    expect(hint).toContain("量比≥2");
    expect(triggerHint("")).toBe("");
    expect(triggerHint("not-json")).toBe("");
  });

  it("回踩方向与换手/成交额提示", () => {
    const json = JSON.stringify([
      { field: "price", op: "lte", value: 9.5 },
      { field: "turnover", op: "lte", value: 5.5 },
      { field: "amount", op: "gte", value: 2 },
    ]);
    expect(triggerHint(json)).toBe("≤9.50 · 换手≤5.5% · 成交额≥2");
    // 非数组 / 未知字段 / 非数值：跳过而不是抛错。
    expect(triggerHint('{"field":"price"}')).toBe("");
    expect(triggerHint(JSON.stringify([{ field: "wat", op: "gte", value: 1 }]))).toBe("");
    expect(triggerHint(JSON.stringify([{ field: "price", op: "gte", value: "x" }]))).toBe("");
  });
});
