import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import { logger } from "../../../src/utils/logger";

describe("logger", () => {
  beforeEach(() => {
    logger.clear();
    logger.setLevel("info");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("records messages at or above the current level", () => {
    logger.debug("skip");
    logger.info("hello", "market");
    logger.warn("careful");
    logger.error("boom");

    const entries = logger.entries();
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.level)).toEqual(["info", "warn", "error"]);
    expect(entries[0]).toMatchObject({ level: "info", source: "market", message: "hello" });
    expect(entries[0].t).toEqual(expect.any(Number));
  });

  it("includes optional data and filters by minimum level", () => {
    logger.info("with-data", "app", { a: 1 });
    logger.warn("warn-data", "app", new Error("x"));

    expect(logger.entries("warn")).toHaveLength(1);
    expect(logger.entries("warn")[0].message).toBe("warn-data");
    const infoEntry = logger.entries("info")[0];
    expect(infoEntry.data).toEqual({ a: 1 });
  });

  it("changes and reports the level", () => {
    expect(logger.getLevel()).toBe("info");
    logger.setLevel("debug");
    logger.debug("now-visible");
    expect(logger.entries()).toHaveLength(1);
  });

  it("caps the ring buffer at 500 entries", () => {
    logger.setLevel("error");
    for (let i = 0; i < 505; i++) logger.error(`m${i}`);
    const entries = logger.entries();
    expect(entries).toHaveLength(500);
    expect(entries[0].message).toBe("m5");
    expect(entries[499].message).toBe("m504");
  });

  it("exports JSON with a header and selected entries", () => {
    logger.info("json");
    const parsed = JSON.parse(logger.toJSON("info"));
    expect(parsed.app).toBe("TickGold");
    expect(parsed.generatedAt).toEqual(expect.any(String));
    expect(parsed.logs).toHaveLength(1);
    expect(logger.toJSON("error")).toContain('"logs": []');
  });

  it("exports formatted text including serialized data", () => {
    logger.info("text", "src", { ok: true });
    const text = logger.toText();
    expect(text).toContain("# TickGold 前端日志");
    expect(text).toContain("[INFO ]");
    expect(text).toContain("[src] text");
    expect(text).toContain('"ok": true');
  });

  it("mirrors entries to the matching console method", () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    logger.setLevel("debug");
    logger.debug("d");
    logger.info("i", "app", { n: 1 });
    logger.warn("w");
    logger.error("e");

    expect(debug).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledOnce();
    expect(info.mock.calls[0]).toHaveLength(4);
  });
});
