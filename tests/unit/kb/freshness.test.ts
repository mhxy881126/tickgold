import { describe, it, expect } from "vitest";
import { freshness, halfLifeDays } from "../../../src/kb/freshness";

describe("freshness", () => {
  it("exposes the half-life table", () => {
    expect(halfLifeDays("policy")).toBe(7);
    expect(halfLifeDays("event")).toBe(1);
  });
  it("is 1 at age 0 and 0.5 at one half-life", () => {
    expect(freshness("policy", 0)).toBe(1);
    expect(freshness("policy", 7)).toBeCloseTo(0.5, 10);
  });
  it("decays faster for short half-life kinds", () => {
    expect(freshness("event", 1)).toBeCloseTo(0.5, 10);
    expect(freshness("event", 3)).toBeLessThan(0.13);
  });
  it("clamps negative ages to 1", () => {
    expect(freshness("policy", -2)).toBe(1);
  });
});
