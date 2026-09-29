// 动效引擎：档位（full/balanced/power）+ 中央 Ticker + 共享缓动常量。
// 档位持久化到 SQLite meta 表（key=app_motion）；未显式选择时跟随系统 reduced-motion。
import { ref } from "vue";
import { ensureDb, db } from "../db/database";

export type MotionTier = "full" | "balanced" | "power";

const KEY = "app_motion";

// 各档补间时长（ms）与特性门控
export const TIER_DURATION: Record<MotionTier, number> = {
  full: 480,
  balanced: 320,
  power: 0,
};

// 共享缓动 / 时长（入场、FLIP、聚焦），供 app.css 变量与 useCardFocus 复用
export const EASE = {
  // 回弹入场（与现有 .card-enter 手感接近）
  enter: "cubic-bezier(0.22, 1.2, 0.36, 1)",
  move: "cubic-bezier(0.32, 0.72, 0, 1)",
  focus: "cubic-bezier(0.32, 0.9, 0.2, 1)",
  spring: "cubic-bezier(0.34, 1.56, 0.64, 1)",
};
export const FOCUS_MS = 460;

// ===== 中央 Ticker：一个 rAF 多订阅；无订阅/页面隐藏时不运转 =====
export type TickCb = (dt: number) => void;

class Ticker {
  private cbs = new Set<TickCb>();
  private raf = 0;
  private last = 0;
  private running = false;

  subscribe(cb: TickCb): () => void {
    this.cbs.add(cb);
    this.ensure();
    return () => {
      this.cbs.delete(cb);
      if (this.cbs.size === 0) this.stop();
    };
  }

  private ensure() {
    if (this.running) return;
    if (typeof requestAnimationFrame !== "function") return;
    this.running = true;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.loop);
  }

  private stop() {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private loop = (t: number) => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(64, t - this.last); // 钳制大间隔（切回标签页）
    this.last = t;
    if (typeof document !== "undefined" && document.hidden) return;
    this.cbs.forEach((cb) => cb(dt));
  };
}

export const ticker = new Ticker();

// easeOutCubic：数值补间默认曲线
export function easeOutCubic(p: number): number {
  return 1 - Math.pow(1 - p, 3);
}

// ===== 档位状态 =====
export const tier = ref<MotionTier>("balanced");
let userChosen = false;

function systemPrefersReduced(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function apply(t: MotionTier) {
  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("data-motion", t);
  }
}

// 档位合并纯函数：用户显式选择优先；未选择时系统 reduce → power，否则 balanced
export function effectiveTier(
  chosen: boolean,
  t: MotionTier,
  reduced: boolean
): MotionTier {
  if (chosen) return t;
  return reduced ? "power" : "balanced";
}

function resolveTier(): MotionTier {
  return effectiveTier(userChosen, tier.value, systemPrefersReduced());
}

/** 启动读取已保存档位；无记录时跟随系统偏好 */
async function load() {
  let saved: MotionTier | null = null;
  try {
    await ensureDb();
    const rows = await db().select<{ value: string }[]>(
      "SELECT value FROM meta WHERE key=?",
      [KEY]
    );
    const v = rows[0]?.value as MotionTier;
    if (v === "full" || v === "balanced" || v === "power") saved = v;
  } catch {
    /* web 预览 / DB 不可用 */
  }
  if (saved) {
    userChosen = true;
    tier.value = saved;
  } else {
    tier.value = systemPrefersReduced() ? "power" : "balanced";
  }
  apply(tier.value);
}

/** 显式切换档位并持久化 */
function setTier(t: MotionTier) {
  userChosen = true;
  tier.value = t;
  apply(t);
  try {
    db()
      .execute("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)", [KEY, t])
      .catch(() => {});
  } catch {
    /* ignore */
  }
}

export const MOTION_TIERS: { id: MotionTier; name: string; desc: string }[] = [
  { id: "full", name: "全开", desc: "辉光 / 模糊 / 抬升全启用" },
  { id: "balanced", name: "均衡", desc: "流畅动效，关闭昂贵模糊（推荐）" },
  { id: "power", name: "省电", desc: "瞬时到位，仅保留语义色" },
];

export function useMotion() {
  return { tier, load, setTier, MOTION_TIERS, ticker, EASE, FOCUS_MS };
}
