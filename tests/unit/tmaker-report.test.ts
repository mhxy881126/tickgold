import { describe, expect, it } from "vitest";
import { buildTmakerReportHtml, buildTmakerReportMarkdown } from "../../src/utils/tmakerReport";
import type { TReportRecord } from "../../src/utils/tmakerReport";
import type { SignalLogStats } from "../../src/composables/tmaker/signalLog";

function rec(over: Partial<TReportRecord> = {}): TReportRecord {
  return {
    tradeDate: "2026-10-23", code: "600000", name: "浦发银行", type: "long",
    vol: 1000, openPrice: 10.0, closePrice: 10.12, pnl: (12000 - 2600) / 100,
    fee: 26, openTime: 10 * 60 + 5, closeTime: 10 * 60 + 40,
    ...over,
  };
}

describe("buildTmakerReportHtml 做T日报", () => {
  it("空台账：HTML 含当日无成交提示与概览零值", () => {
    const html = buildTmakerReportHtml({ date: "20261023", records: [], signalStats: null, bt: null, optHint: null });
    expect(html).toContain("当日无做T成交");
    expect(html).toContain("0");
    expect(html).toContain("做T日报");
    expect(html.startsWith("<!doctype html>")).toBe(true);
  });

  it("有成交：逐笔回放表含价格/费用/盈亏，正倒T分组与强平数正确", () => {
    const records = [
      rec(),
      rec({ type: "short", openPrice: 10.2, closePrice: 10.05, pnl: 150, closeTime: 890 }), // 强平（14:50）
    ];
    const html = buildTmakerReportHtml({ date: "20261023", records, signalStats: null, bt: null, optHint: null });
    expect(html).toContain("正T");
    expect(html).toContain("倒T");
    expect(html).toContain("强平");
    expect(html).toContain("10.00 → 10.12");
    expect(html).toContain("浦发银行");
  });

  it("信号质量与回测对照区块按有/无数据正确切换", () => {
    const stats: SignalLogStats = {
      count: 3, evaluated: 3, hitRate: 66.7, stoppedRate: 0,
      avgMfe15: 0.8, avgMae15: -0.3,
      long: { count: 2, hitRate: 100 }, short: { count: 1, hitRate: 0 },
      byScore: [], recent: [],
    };
    const html = buildTmakerReportHtml({
      date: "20261023", records: [], signalStats: stats,
      bt: { count: 12, winRate: 71, breakEven: 67, avgPnl: 18, profitFactor: 1.6, maxDrawdown: 220 },
      optHint: "开75 止1.0% 倍1.5 日2",
    });
    expect(html).toContain("30min 命中率");
    expect(html).toContain("71%");
    expect(html).toContain("67%");
    expect(html).toContain("✅");
    expect(html).toContain("次日参数建议");
    expect(html).toContain("开75 止1.0%");
    // 未过成本线场景
    const bad = buildTmakerReportHtml({
      date: "20261023", records: [], signalStats: null,
      bt: { count: 12, winRate: 60, breakEven: 67, avgPnl: -3, profitFactor: 0.8, maxDrawdown: 300 },
      optHint: null,
    });
    expect(bad).toContain("⚠️ 未过成本线");
    expect(bad).toContain("暂无当日信号评估样本");
  });

  it("真实 ms 时间戳口径：14:50 平仓判为强平，10:40 平仓不判强平", () => {
    // 真实台账 closeTime = Date.now()（ms）
    const at = (h: number, m: number) => new Date(2026, 9, 23, h, m, 0).getTime();
    const records = [
      rec({ closeTime: at(10, 40) }),               // 计划内平仓
      rec({ type: "short", openTime: at(14, 0), closeTime: at(14, 50), pnl: 150 }), // 14:50 强平
    ];
    const html = buildTmakerReportHtml({ date: "20261023", records, signalStats: null, bt: null, optHint: null });
    expect(html).toContain("强平");
    expect(html).toContain("10:40");
    expect(html).toContain("14:50");
    // 强平计数 = 1（14:50 那笔）
    const md = buildTmakerReportMarkdown({ date: "20261023", records, signalStats: null, bt: null, optHint: null });
    expect(md).toContain("强平：1 笔");
  });

  it("Markdown 版核心指标齐全", () => {
    const md = buildTmakerReportMarkdown({
      date: "20261023",
      records: [rec()],
      signalStats: { count: 1, evaluated: 1, hitRate: 100, stoppedRate: 0, avgMfe15: 0.5, avgMae15: -0.2, long: { count: 1, hitRate: 100 }, short: { count: 0, hitRate: 0 }, byScore: [], recent: [] },
      bt: { count: 5, winRate: 70, breakEven: 67, avgPnl: 10, profitFactor: 1.5, maxDrawdown: 100 },
      optHint: null,
    });
    expect(md).toContain("# 做T日报");
    expect(md).toContain("笔数：1");
    expect(md).toContain("70% vs 保本需 67%");
  });
});
