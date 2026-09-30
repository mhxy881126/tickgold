import type { StockRole } from "./types";

export interface RoleInput {
  code: string;
  name: string;
  boards: number;
  firstSeal: number; // HHMMSS，如 93505
  sealFund: number;  // 封单金额（元）
}

export interface RoleOutput extends RoleInput {
  roleScore: number;
  role: StockRole;
  uniqueLeader: boolean;
}

/** HHMMSS → 当日分钟数；0 / 异常输入返回尾盘值 690（11:30），避免误得高分。 */
export function sealMinutes(firstSeal: number): number {
  if (firstSeal <= 0) return 690;
  const h = Math.floor(firstSeal / 10000);
  const m = Math.floor(firstSeal / 100) % 100;
  if (h < 9 || h > 15) return 690;
  return h * 60 + m;
}

/**
 * 确定性评分：
 *   板高主导（×1000）＋封单强度（每亿元 50 分，封顶 200）＋时间奖励（11:00 前越早越多）。
 */
export function roleScore(s: RoleInput): number {
  const boardPart = s.boards * 1000;
  const fundPart = Math.min((s.sealFund / 1e8) * 50, 200);
  const minutes = sealMinutes(s.firstSeal);
  const timePart = Math.max(0, (660 - minutes) * 3); // 660 = 11:00
  return boardPart + fundPart + timePart;
}

export function assignRoles(stocks: RoleInput[]): RoleOutput[] {
  const ranked = stocks
    .map((s) => ({ ...s, roleScore: roleScore(s) }))
    .sort((a, b) => b.roleScore - a.roleScore);

  const uniqueLeader = ranked.length >= 2 && ranked[0].boards > ranked[1].boards;

  return ranked.map((r, i): RoleOutput => {
    let role: StockRole;
    if (i === 0) role = "龙一";
    else if (i === 1) role = "龙二";
    else if (i <= 2) role = "助攻";
    else role = "跟风";
    return { ...r, role, uniqueLeader: i === 0 ? uniqueLeader : false };
  });
}
