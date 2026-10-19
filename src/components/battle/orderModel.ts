// 下单条的纯计算：涨跌停、仓位档手数、提交校验（node 可测，不依赖 DOM）。
export type PositionPct = 2 | 3 | 4;

export function boardRatio(code: string): number {
  return /^(30|68)/.test(code) ? 1.2 : 1.1;
}

export function limitPrices(code: string, prevClose: number): { up: number; down: number } {
  if (!prevClose) return { up: 0, down: 0 };
  const r = boardRatio(code);
  return { up: +(prevClose * r).toFixed(2), down: +(prevClose * (2 - r)).toFixed(2) };
}

export function positionVolume(cash: number, position: PositionPct, price: number): number {
  if (price <= 0 || cash <= 0) return 0;
  const ratio = position === 2 ? 0.5 : position === 3 ? 1 / 3 : 0.25;
  return Math.floor((cash * ratio) / price / 100) * 100;
}

export function canSubmitQuickOrder(a: {
  code: string;
  price: number;
  vol: number;
  blocked: boolean;
}): boolean {
  return !a.blocked && /^\d{6}$/.test(a.code) && a.price > 0 && a.vol > 0;
}
