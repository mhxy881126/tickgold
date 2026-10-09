// 策略进化：依据近期交易标注统计（胜率 / 盈亏比 / 误报 / 卖早），有界地调整决策参数：
// ① 六因子权重 ② BUY 分数门槛 ③ 凯利仓位信心缩放。结果持久化、可追溯、可回滚。纯函数 + localStorage。

export const DEFAULT_WEIGHTS: Record<string, number> = {
  trend: 25, setup: 20, volprice: 15, money: 15, theme: 15, risk: 10,
};
export const DEFAULT_BUY_THRESHOLD = 68;

export interface EvolvedParams {
  weights: Record<string, number>;
  buyThreshold: number;
  confidenceScale: number; // 0.75–1.1
  updatedAt: number;
  samples: number;
  note: string;
}

export interface StatGroup {
  samples: number;
  good: number;
  bad: number;
  winRate: number;        // 百分比 0–100
  profitFactor: number | null;
  expectancy: number;
  falsePositive: number;
  sellTooEarly: number;
}
export interface EvolutionStatsLike {
  groups: StatGroup[];
  totalLabels: number;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

export function defaultParams(): EvolvedParams {
  return {
    weights: { ...DEFAULT_WEIGHTS },
    buyThreshold: DEFAULT_BUY_THRESHOLD,
    confidenceScale: 1,
    updatedAt: 0,
    samples: 0,
    note: "默认参数",
  };
}

/** 由统计推导下一版参数（样本 <8 不动，避免小样本过拟合） */
export function evolveFromStats(stats: EvolutionStatsLike, prev?: EvolvedParams): EvolvedParams {
  const base = prev ?? defaultParams();
  const g = [...stats.groups].sort((a, b) => b.samples - a.samples)[0];
  if (!g || g.samples < 8) {
    return { ...base, samples: g?.samples ?? 0, note: "样本不足 8，维持参数" };
  }

  const win = g.winRate / 100;
  const decided = g.good + g.bad;
  const fpRate = g.samples > 0 ? g.falsePositive / g.samples : 0;
  const changes: string[] = [];

  // ① BUY 门槛
  let thr = DEFAULT_BUY_THRESHOLD;
  if (win >= 0.58) { thr -= 3; changes.push("胜率高→门槛-3"); }
  if (win < 0.45 || fpRate > 0.3) { thr += 5; changes.push("胜率低/误报多→门槛+5"); }
  thr = clamp(thr, 62, 74);

  // ② 凯利仓位缩放
  let scale = 1;
  if (g.expectancy > 0 && (g.profitFactor ?? 0) >= 1.3) { scale = 1.1; changes.push("正期望→仓位×1.1"); }
  else if (g.expectancy < 0 || win < 0.4) { scale = 0.8; changes.push("负期望/低胜率→仓位×0.8"); }
  scale = clamp(scale, 0.75, 1.1);

  // ③ 因子权重再平衡（归一化到 100）
  const w = { ...DEFAULT_WEIGHTS };
  if (fpRate > 0.3) {
    w.setup += 3; w.risk += 3; w.theme -= 3; w.money -= 3;
    changes.push("误报多→加买点/风险权重");
  }
  if (win > 0.6) { w.trend += 3; w.risk -= 3; changes.push("强趋势→加趋势权重"); }
  const sum = Object.values(w).reduce((a, b) => a + b, 0);
  Object.keys(w).forEach((k) => { w[k] = clamp((w[k] / sum) * 100, 4, 40); });

  return {
    weights: w,
    buyThreshold: thr,
    confidenceScale: scale,
    updatedAt: Date.now(),
    samples: g.samples,
    note: changes.join("；") || "表现平稳，维持参数",
  };
}

// ─── 持久化 ───
const STORAGE_KEY = "tickgold-evolved-params";
export function loadEvolvedParams(): EvolvedParams {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultParams();
    const parsed = JSON.parse(raw) as EvolvedParams;
    return { ...defaultParams(), ...parsed };
  } catch {
    return defaultParams();
  }
}
export function saveEvolvedParams(p: EvolvedParams): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(p)); } catch { /* 忽略 */ }
}
export function resetEvolvedParams(): EvolvedParams {
  const d = defaultParams();
  saveEvolvedParams(d);
  return d;
}
