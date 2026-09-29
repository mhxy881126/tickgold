// 统一数字 / 金额 / 百分比格式化（收口各卡片重复实现）。
// 空值（null/undefined/NaN）统一输出 "--"。

export function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

// 价格：默认两位小数
export function fmtPrice(v: unknown, decimals = 2): string {
  if (!isNum(v)) return "--";
  return v.toFixed(decimals);
}

// 百分比：正数带 +，默认两位小数，追加 %
export function fmtPct(v: unknown, decimals = 2): string {
  if (!isNum(v)) return "--";
  return (v > 0 ? "+" : "") + v.toFixed(decimals) + "%";
}

// 成交额 / 量（非负语义）：自适应 万、亿
export function fmtAmount(v: unknown): string {
  if (!isNum(v)) return "--";
  if (Math.abs(v) >= 1e8) return (v / 1e8).toFixed(2) + "亿";
  if (Math.abs(v) >= 1e4) return (v / 1e4).toFixed(0) + "万";
  return v.toFixed(0);
}

// 净流入等带正负语义的金额：符号前缀 + 自适应 万、亿
export function fmtMoney(v: unknown): string {
  if (!isNum(v)) return "--";
  const s = v > 0 ? "+" : v < 0 ? "-" : "";
  return s + fmtAmount(Math.abs(v));
}

// 成交量：手 / 股自适应万手、亿手（保留入口，暂用万、亿）
export function fmtVolume(v: unknown): string {
  return fmtAmount(v);
}
