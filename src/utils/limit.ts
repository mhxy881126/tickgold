// 涨跌停价计算（移植 Rust spider::limit_prices）
/**
 * 返回 [涨停价, 跌停价]。
 * ST 5%；科创/创业板（688/300/301）20%；北交所（4/8/920 开头）30%；其余 10%。
 */
export function limitPrices(
  code: string,
  name: string,
  prevClose: number
): [number, number] {
  const rate = name.includes("ST")
    ? 0.05
    : code.startsWith("688") || code.startsWith("300") || code.startsWith("301")
      ? 0.2
      : code.startsWith("4") || code.startsWith("8") || code.startsWith("920")
        ? 0.3
        : 0.1;
  const up = Math.round(prevClose * (1 + rate) * 100) / 100;
  const dn = Math.round(prevClose * (1 - rate) * 100) / 100;
  return [up, dn];
}
