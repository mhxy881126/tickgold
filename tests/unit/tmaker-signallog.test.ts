import { describe, expect, it, beforeEach } from "vitest";
import {
  recordSignal, loadSignalLog, clearSignalLog,
  evaluateEntry, evaluateLog,
} from "../../src/composables/tmaker/signalLog";
import type { SignalLogEntry } from "../../src/composables/tmaker/signalLog";

// vitest node 环境无 localStorage：手动注入内存版
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k: string) => m.get(k) ?? null,
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => { m.delete(k); },
    setItem: (k: string, v: string) => { m.set(k, v); },
  };
}
beforeEach(() => {
  (globalThis as Record<string, unknown>).localStorage = memoryStorage();
  clearSignalLog();
});

function entry(over: Partial<SignalLogEntry> = {}): SignalLogEntry {
  const at = new Date(2026, 9, 20, 10, 0, 0).getTime();
  return {
    code: "600000", date: "20261020", time: "10:00", dir: "long",
    score: 78, regime: "range", bias: -0.8, biasZ: -1.2,
    price: 10.0, stop: 9.9, target: 10.15, at,
    ...over,
  };
}

/** 构造 10:00 起 30 根分钟 bar：10.00 起步，向上爬（long 有利走势） */
function barsUp(): { timestamp: number; high: number; low: number }[] {
  const start = new Date(2026, 9, 20, 10, 0, 0).getTime();
  return Array.from({ length: 30 }, (_, i) => {
    const c = 10.0 + i * 0.01;
    return { timestamp: start + i * 60000, high: c + 0.01, low: c - 0.01 };
  });
}

describe("recordSignal / loadSignalLog", () => {
  it("记录与读取往返", () => {
    recordSignal(entry());
    const log = loadSignalLog();
    expect(log).toHaveLength(1);
    expect(log[0].code).toBe("600000");
    expect(log[0].dir).toBe("long");
  });

  it("同日同时同码同方向 60s 内去重", () => {
    recordSignal(entry());
    recordSignal(entry({ score: 80 }));
    expect(loadSignalLog()).toHaveLength(1);
    // 不同时间（+2min）允许记录
    recordSignal(entry({ at: new Date(2026, 9, 20, 10, 2, 0).getTime(), time: "10:02" }));
    expect(loadSignalLog()).toHaveLength(2);
  });

  it("clear 后为空", () => {
    recordSignal(entry());
    clearSignalLog();
    expect(loadSignalLog()).toHaveLength(0);
  });
});

describe("evaluateEntry MFE/MAE", () => {
  it("long 上涨走势：MFE 为正且递增，MAE 为负，30min 达 target 命中", () => {
    const e = entry();
    const bars = barsUp();
    const r = evaluateEntry(e, bars);
    expect(r).not.toBeNull();
    expect(r!.mfe5).toBeGreaterThan(0);
    expect(r!.mfe15).toBeGreaterThan(r!.mfe5);
    expect(r!.mfe30).toBeGreaterThan(r!.mfe15);
    expect(r!.mae5).toBeLessThan(0);
    expect(r!.hit).toBe(true);   // 30 分钟最高 ≈ 10.30 > target 10.15
    expect(r!.stopped).toBe(false);
    expect(r!.barsUsed).toBe(30);
  });

  it("long 下跌走势：MAE 触及止损 → stopped", () => {
    const start = new Date(2026, 9, 20, 10, 0, 0).getTime();
    const bars = Array.from({ length: 30 }, (_, i) => {
      const c = 10.0 - i * 0.01;
      return { timestamp: start + i * 60000, high: c + 0.01, low: c - 0.01 };
    });
    const r = evaluateEntry(entry({ stop: 9.9, target: 10.15 }), bars);
    expect(r!.stopped).toBe(true); // 30min 最低 ≈ 9.71 < 9.9
    expect(r!.hit).toBe(false);
    expect(r!.mae30).toBeLessThan(0);
  });

  it("short 方向：MFE 用窗口最低", () => {
    const start = new Date(2026, 9, 20, 10, 0, 0).getTime();
    const bars = Array.from({ length: 15 }, (_, i) => {
      const c = 10.0 - i * 0.02;
      return { timestamp: start + i * 60000, high: c + 0.01, low: c - 0.01 };
    });
    const e = entry({ dir: "short", price: 10.0, stop: 10.1, target: 9.85 });
    const r = evaluateEntry(e, bars);
    expect(r).not.toBeNull();
    expect(r!.mfe15).toBeGreaterThan(0);
    expect(r!.mae15).toBeGreaterThanOrEqual(-0.2);
    expect(r!.hit).toBe(true); // 15min 最低 ≈ 9.73 < 9.85
  });

  it("信号时刻之前的 bar 不参与（防未来函数）", () => {
    const start = new Date(2026, 9, 20, 10, 0, 0).getTime();
    const bars = [
      { timestamp: start - 3 * 60000, high: 11, low: 9 }, // 信号前的暴涨暴跌不应计入
      ...barsUp(),
    ];
    const r = evaluateEntry(entry(), bars);
    // 若错误回看信号前 bar，mfe30 会 ≈10%（high 11）；正确应 ≈3%
    expect(r!.mfe30).toBeLessThan(5);
  });

  it("无后续数据返回 null（尾部样本）", () => {
    const e = entry({ at: new Date(2026, 9, 20, 14, 59, 0).getTime() });
    const r = evaluateEntry(e, barsUp());
    expect(r).toBeNull();
  });
});

describe("evaluateLog 汇总", () => {
  it("命中率 / 止损率 / 分组 / 分数段统计口径自洽", () => {
    const dayBars = new Map<string, { timestamp: number; high: number; low: number }[]>();
    dayBars.set("20261020", barsUp());
    const log = [
      entry(),                                                        // long 10:00 → hit
      entry({ dir: "short", at: new Date(2026, 9, 20, 10, 1, 0).getTime(), time: "10:01", score: 88, target: 9.85, stop: 10.1 }), // short 用同一上涨走势 → 不命中
      entry({ dir: "long", at: new Date(2026, 9, 20, 10, 2, 0).getTime(), time: "10:02", score: 76 }), // long → hit
      { ...entry(), code: "000001", date: "20261019" },               // 无该日数据 → 不计入
    ];
    const s = evaluateLog(log, dayBars);
    expect(s.count).toBe(4);
    expect(s.evaluated).toBe(3);
    expect(s.long.count).toBe(3);
    expect(s.short.count).toBe(1);
    // 两个 long 用上涨走势都命中 → 100%；short 不命中 → 0%
    expect(s.long.hitRate).toBe(100);
    expect(s.short.hitRate).toBe(0);
    const top = s.byScore.find((b) => b.band === "85+");
    expect(top!.count).toBe(1);
    expect(s.recent.length).toBeGreaterThanOrEqual(4);
  });

  it("空日志安全返回", () => {
    const s = evaluateLog([], new Map());
    expect(s.count).toBe(0);
    expect(s.hitRate).toBe(0);
  });
});
