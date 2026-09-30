import { describe, it, expect } from "vitest";
import { fnv1a } from "../../../src/kb/hash";

describe("fnv1a", () => {
  it("is deterministic", () => {
    expect(fnv1a("abc")).toBe(fnv1a("abc"));
  });
  it("returns an 8-char hex string", () => {
    expect(fnv1a("abc")).toMatch(/^[0-9a-f]{8}$/);
  });
  it("has a known fixed vector", () => {
    expect(fnv1a("a")).toBe("e40c292c");
  });
  it("differs for different input", () => {
    expect(fnv1a("ab")).not.toBe(fnv1a("ac"));
  });
  it("handles empty input", () => {
    expect(fnv1a("")).toBe("811c9dc5");
  });
});
