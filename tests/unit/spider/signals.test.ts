import { describe, it, expect } from "vitest";
import { resolveSignal } from "../../../src/components/spider/signals";

describe("resolveSignal 到达帧信号解析", () => {
  it("code 为 undefined 时用建点 fallback", () => {
    const map = new Map<string, "BUY" | "SELL" | null>();
    expect(resolveSignal(map, undefined, "BUY")).toBe("BUY");
  });

  it("code 在 map 中为 BUY 时返回 BUY", () => {
    const map = new Map<string, "BUY" | "SELL" | null>([["600248", "BUY"]]);
    expect(resolveSignal(map, "600248", null)).toBe("BUY");
  });

  it("map 中显式 null 必须保留 null（staleness guard，不得回退 BUY）", () => {
    const map = new Map<string, "BUY" | "SELL" | null>([["600248", null]]);
    expect(resolveSignal(map, "600248", "BUY")).toBeNull();
  });

  it("code 不在 map 中时用 fallback", () => {
    const map = new Map<string, "BUY" | "SELL" | null>([["600000", "SELL"]]);
    expect(resolveSignal(map, "600248", "BUY")).toBe("BUY");
  });
});
