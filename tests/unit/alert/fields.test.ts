import { describe, it, expect } from "vitest";
import {
  FIELD_SPECS,
  fieldSpec,
  CATEGORY_LABELS,
} from "../../../src/alert/fields";

describe("fields 元数据", () => {
  it("每个字段都能查到且字段唯一", () => {
    const keys = FIELD_SPECS.map((s) => s.field);
    expect(new Set(keys).size).toBe(keys.length);
    for (const s of FIELD_SPECS) {
      expect(fieldSpec(s.field)).toBe(s);
      expect(s.label).toBeTruthy();
      expect(s.ops.length).toBeGreaterThan(0);
    }
  });

  it("未知字段返回 undefined", () => {
    expect(fieldSpec("nope")).toBeUndefined();
  });

  it("事件字段仅支持 >=", () => {
    expect(fieldSpec("evt.sealUp")?.ops).toEqual([">="]);
  });

  it("指标字段带周期参数", () => {
    const rsi = fieldSpec("ind.rsi");
    expect(rsi?.params?.[0]).toMatchObject({ key: "period", default: 14 });
  });

  it("涨速字段带窗口参数", () => {
    expect(fieldSpec("speedPct")?.params?.[0]).toMatchObject({
      key: "windowSec",
      default: 300,
    });
  });

  it("六大分类标签齐全", () => {
    expect(Object.keys(CATEGORY_LABELS).sort()).toEqual(
      ["auction", "book", "event", "indicator", "quote", "speed"].sort()
    );
  });
});
