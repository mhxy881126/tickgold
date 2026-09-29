import { describe, it, expect } from "vitest";
import {
  SKIN_SCHEMA,
  mergeTokens,
  resolveTokens,
  tokensFromCustom,
  parseSkinSpec,
  skinCssVars,
} from "../../src/lib/skin";
import { GOLD_SKIN, BUILTIN_SKINS } from "../../src/lib/skin-presets";

describe("skin preset validity", () => {
  it("all builtin skins parse (seed is valid & idempotent)", () => {
    for (const s of BUILTIN_SKINS) {
      expect(parseSkinSpec(JSON.parse(JSON.stringify(s))).id).toBe(s.id);
    }
  });
  it("gold skin carries key tokens", () => {
    expect(GOLD_SKIN.tokens.leftBar?.from).toBeTruthy();
    expect(GOLD_SKIN.tokens.glow?.breathe).toBe(true);
  });
});

describe("mergeTokens three-level priority", () => {
  it("scene overrides global; custom overrides scene, field by field", () => {
    const out = mergeTokens([
      { surface: { bg: "#111111", radius: 10 }, glow: { accent: "#aaaaaa" } },
      { surface: { bg: "#222222" } },
      { glow: { accent: "#333333" } },
    ]);
    expect(out.surface?.bg).toBe("#222222"); // 场景覆盖
    expect(out.surface?.radius).toBe(10); // 未覆盖字段保留全局
    expect(out.glow?.accent).toBe("#333333"); // 单卡最高
  });

  it("deep-merges glow.rest / glow.focus", () => {
    const out = mergeTokens([
      { glow: { rest: { color: "#111111", strength: 0.2 } } },
      { glow: { rest: { strength: 0.8 } } },
    ]);
    expect(out.glow?.rest?.color).toBe("#111111");
    expect(out.glow?.rest?.strength).toBe(0.8);
  });
});

describe("tokensFromCustom (per-card always wins)", () => {
  it("maps color/opacity/radius/border", () => {
    const t = tokensFromCustom({
      color: "#ff0000", opacity: 0.7, radius: 14, borderWidth: 2,
    });
    expect(t.glow?.accent).toBe("#ff0000");
    expect(t.surface?.opacity).toBe(0.7);
    expect(t.surface?.radius).toBe(14);
    expect(t.border?.width).toBe(2);
  });
  it("glow:false zeroes rest strength; barGlow:false disables bar glow", () => {
    const t = tokensFromCustom({ glow: false, barGlow: false });
    expect(t.glow?.rest?.strength).toBe(0);
    expect(t.leftBar?.glow).toBe(false);
  });
  it("custom wins over global in resolveTokens", () => {
    const out = resolveTokens({
      global: { ...GOLD_SKIN, tokens: { glow: { accent: "#000000" } } },
      custom: { color: "#ffffff" },
    });
    expect(out.glow?.accent).toBe("#ffffff");
  });
});

describe("no skin → equivalent to current", () => {
  it("empty resolve produces no css vars", () => {
    expect(skinCssVars(resolveTokens({}))).toEqual({});
  });
});

describe("parseSkinSpec validation", () => {
  const valid = {
    schema: SKIN_SCHEMA,
    id: "my-skin",
    name: "我的皮肤",
    version: 1,
    tokens: { surface: { bg: "#101418", radius: 12 } },
  };
  it("accepts a valid spec", () => {
    const s = parseSkinSpec(valid);
    expect(s.id).toBe("my-skin");
    expect(s.tokens.surface?.bg).toBe("#101418");
  });
  it("rejects wrong schema", () => {
    expect(() => parseSkinSpec({ ...valid, schema: "x" })).toThrow(/schema/);
  });
  it("rejects bad id", () => {
    expect(() => parseSkinSpec({ ...valid, id: "Bad Id!" })).toThrow(/id/);
  });
  it("rejects invalid color", () => {
    expect(() =>
      parseSkinSpec({ ...valid, tokens: { surface: { bg: "red" } } })
    ).toThrow(/颜色/);
  });
  it("rejects out-of-range number", () => {
    expect(() =>
      parseSkinSpec({ ...valid, tokens: { surface: { opacity: 2 } } })
    ).toThrow(/0\.\.1/);
  });
  it("rejects non-whitelist field", () => {
    expect(() =>
      parseSkinSpec({ ...valid, tokens: { surface: { evil: 1 } } })
    ).toThrow(/白名单/);
  });
  it("defaults missing version to 1", () => {
    const { version, ...rest } = valid;
    void version;
    expect(parseSkinSpec(rest).version).toBe(1);
  });
});

describe("skinCssVars", () => {
  it("emits only present fields with correct names", () => {
    const v = skinCssVars({
      surface: { bg: "#121212", innerShine: true },
      leftBar: { from: "#f3dd9e", to: "#b98f3e", glow: true },
      glow: { breathe: true, breatheSec: 4, rest: { strength: 0.3 } },
    });
    expect(v["--card-bg"]).toBe("#121212");
    expect(v["--inner-shine"]).toBe("1");
    expect(v["--bar-from"]).toBe("#f3dd9e");
    expect(v["--bar-glow"]).toBe("1");
    expect(v["--card-breathe-name"]).toBe("breatheGlow");
    expect(v["--card-breathe-sec"]).toBe("4");
    expect(v["--card-glow-strength"]).toBe("0.3");
  });
});
