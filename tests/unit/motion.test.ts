import { describe, it, expect } from "vitest";
import {
  effectiveTier,
  TIER_DURATION,
  EASE,
  FOCUS_MS,
  easeOutCubic,
  type MotionTier,
} from "../../src/composables/useMotion";

describe("effectiveTier 档位合并", () => {
  it("用户显式选择优先（即使系统 reduce）", () => {
    expect(effectiveTier(true, "full", true)).toBe("full");
    expect(effectiveTier(true, "balanced", false)).toBe("balanced");
    expect(effectiveTier(true, "power", false)).toBe("power");
  });
  it("未显式选择：系统 reduce → power", () => {
    expect(effectiveTier(false, "balanced", true)).toBe("power");
  });
  it("未显式选择：普通系统 → balanced", () => {
    expect(effectiveTier(false, "balanced", false)).toBe("balanced");
  });
});

describe("TIER_DURATION", () => {
  it("时长递减，power 为 0", () => {
    expect(TIER_DURATION.full).toBeGreaterThan(TIER_DURATION.balanced);
    expect(TIER_DURATION.balanced).toBeGreaterThan(TIER_DURATION.power);
    expect(TIER_DURATION.power).toBe(0);
  });
  it("三档键齐全", () => {
    (["full", "balanced", "power"] as MotionTier[]).forEach((k) =>
      expect(typeof TIER_DURATION[k]).toBe("number")
    );
  });
});

describe("共享缓动常量", () => {
  it("EASE 含 cubic-bezier", () => {
    Object.values(EASE).forEach((v) => expect(v).toMatch(/cubic-bezier/));
  });
  it("FOCUS_MS 约 460", () => {
    expect(FOCUS_MS).toBe(460);
  });
});

describe("easeOutCubic", () => {
  it("端点 0/1", () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
  });
  it("单调递增且前段快速", () => {
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
    const a = easeOutCubic(0.25);
    const b = easeOutCubic(0.5);
    expect(b).toBeGreaterThan(a);
  });
});
