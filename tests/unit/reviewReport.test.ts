import { describe, it, expect } from "vitest";
import {
  renderHtml,
  renderMarkdown,
  escapeHtml,
  prettyDate,
  money,
  pct,
  clock,
  type ReviewReportData,
} from "../../src/utils/reviewReport";

function sample(over: Partial<ReviewReportData> = {}): ReviewReportData {
  return {
    date: "20261013",
    generatedAt: new Date("2026-10-13T15:30:00+08:00").getTime(),
    market: {
      total: 5400,
      upCount: 3100,
      downCount: 2100,
      flatCount: 200,
      limitUp: 68,
      limitDown: 2,
      broken: 9,
      brokenRate: 11.7,
      maxBoards: 5,
      avgBoards: 1.8,
      firstBoardCount: 50,
      multiBoardCount: 18,
      sealFundTotal: 1820000000,
      sentiment: 52.3,
    },
    marketTrend: [
      { day: "20261009", limitUp: 40, broken: 6, sentiment: 41.2 },
      { day: "20261013", limitUp: 68, broken: 9, sentiment: 52.3 },
    ],
    indices: [
      { code: "000001", name: "上证指数", price: 3100.5, pct: 0.82, amount: 420000000000 },
    ],
    topIndustryUp: [
      { code: "BK01", name: "半导体", changePct: 3.2, netAmount: null, leadName: "甲", leadPct: 10.0 },
    ],
    topConceptUp: [{ code: "BK02", name: "机器人", changePct: 2.8, netAmount: null }],
    topSectorFund: [{ code: "BK03", name: "电子", changePct: 1.1, netAmount: 520000000 }],
    activeThemes: [
      {
        id: 1, name: "机器人", level: "分支", stage: "发酵", members: 12,
        leaders: [{ code: "300001", name: "甲", role: "龙一" }],
        recentCatalyst: "政策利好",
      },
    ],
    recentCatalysts: [
      { kind: "order", title: "甲签订大单", direction: "利好", code: "300001", theme: "机器人", ts: 1728800000000 },
    ],
    multiBoardStocks: [
      { code: "300001", name: "甲", boards: 3, firstSeal: 1728760000000, sealFund: 230000000, broken: 0, industry: "机械" },
    ],
    positions: [{ code: "300001", name: "甲", vol: 1000, availVol: 1000, costAmount: 120000 }],
    watchCount: 36,
    todayPlan: {
      exists: true, title: "计划", marketView: "情绪回暖",
      instructions: [{ tier: "核心", code: "300001", name: "甲", condition: "高开<3%", action: "关注" }],
    },
    todayDecisionLogs: [
      { code: "300001", name: "甲", label: "弱转强", confidence: 0.78, mode: "fast", action: "WATCH", features: "" },
    ],
    todayOrders: [
      {
        code: "300001", name: "甲", side: "sell", price: 13.5, vol: 1000, amount: 13500,
        fee: 5, status: "filled", sigId: "s1", realizedPnl: 1500, createdAt: 1728770000000,
      },
    ],
    todayAlertEvents: [
      {
        ruleId: "r1", code: "300001", name: "甲", kind: "price", label: "突破",
        message: "价格突破", price: 13.5, pct: 5.2, tone: "up", triggeredAt: 1728765000000,
      },
    ],
    aiReviews: [
      {
        id: 1, scope: "market", subject: "盘面", title: "情绪修复", summary: "涨停增多",
        content: "今日涨停 68 家，连板高度回升。", model: "doubao", createdAt: 1728780000000,
      },
    ],
    performance: {
      initCash: 100000, cash: 80000, holdingCost: 120000, costBasisEquity: 200000,
      dayRealizedPnl: 1500, daySells: 1, dayWins: 1, dayWinRate: 100,
      positions: [{ code: "300001", name: "甲", vol: 1000, availVol: 1000, costAmount: 120000 }],
      valuationNote: "成本口径，未计浮动盈亏",
    },
    disclaimer: "本报告仅为个人盯盘记录与数据复盘，不构成任何投资建议。",
    ...over,
  };
}

describe("格式化工具", () => {
  it("prettyDate 兼容两种写法", () => {
    expect(prettyDate("20261013")).toBe("2026-10-13");
    expect(prettyDate("2026-10-13")).toBe("2026-10-13");
  });
  it("money 亿/万换算", () => {
    expect(money(1820000000)).toContain("亿");
    expect(money(52000000)).toContain("万");
    expect(money(null)).toBe("—");
  });
  it("pct 与 clock", () => {
    expect(pct(1.5)).toBe("1.50%");
    expect(clock(0)).toBe("—");
  });
  it("escapeHtml 转义特殊字符", () => {
    expect(escapeHtml("<a>&\"'")).toBe("&lt;a&gt;&amp;&quot;&#39;");
  });
});

describe("renderHtml", () => {
  it("输出完整单文件 HTML 且含关键字段", () => {
    const html = renderHtml(sample());
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("盯盘复盘报告");
    expect(html).toContain("2026-10-13");
    expect(html).toContain("上证指数");
    expect(html).toContain("半导体");
    expect(html).toContain("机器人");
    expect(html).toContain("盯盘复盘报告");
  });

  it("固定附免责声明且无荐股措辞", () => {
    const html = renderHtml(sample());
    expect(html).toContain("不构成任何投资建议");
    // 不应出现荐股/保证类词汇
    expect(html).not.toMatch(/推荐买入|建议买入|包赚|稳赚|必涨/);
  });

  it("空数据各段安全降级不抛错", () => {
    const empty = sample({
      indices: [], topIndustryUp: [], topConceptUp: [], topSectorFund: [],
      activeThemes: [], recentCatalysts: [], multiBoardStocks: [],
      todayOrders: [], todayAlertEvents: [], aiReviews: [], todayDecisionLogs: [],
      todayPlan: { exists: false, instructions: [] },
    });
    const html = renderHtml(empty);
    expect(html).toContain("当日无指数快照");
    expect(html).toContain("当日无成交流水");
    expect(html).toContain("当日未建立作战计划");
  });
});

describe("renderMarkdown", () => {
  it("输出含标题/声明/表格的 Markdown", () => {
    const md = renderMarkdown(sample());
    expect(md.startsWith("# TickGold 盯盘复盘报告")).toBe(true);
    expect(md).toContain("不构成任何投资建议");
    expect(md).toContain("| 指数 | 点位 | 涨跌幅 | 成交额 |");
    expect(md).toContain("上证指数");
    expect(md).toContain("## 六、我的交易与绩效");
  });

  it("表格单元格内管道符被转义", () => {
    const md = renderMarkdown(
      sample({ todayDecisionLogs: [{
        code: "300001", name: "a|b", label: "x", confidence: 0.5,
        mode: "fast", action: "WATCH", features: "",
      }] }),
    );
    expect(md).toContain("a\\|b");
  });
});
