import type { CatalystKind } from "./types";

// 半衰期（天）：政策影响最久，盘中事件最短。
const HALF_LIFE: Record<CatalystKind, number> = {
  policy: 7,
  industry: 5,
  company: 3,
  order: 3,
  earnings: 3,
  price: 1,
  event: 1,
};

export function halfLifeDays(kind: CatalystKind): number {
  return HALF_LIFE[kind] ?? 3;
}

/** 新鲜度：age 0 → 1；每过一个半衰期减半；负年龄（时钟偏差）视为 1。 */
export function freshness(kind: CatalystKind, ageDays: number): number {
  if (ageDays <= 0) return 1;
  return Math.pow(0.5, ageDays / halfLifeDays(kind));
}
