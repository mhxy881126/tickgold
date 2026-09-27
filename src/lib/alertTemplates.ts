// 预警模板库：一键生成主流短线场景的预制规则（作用域默认全部自选）
import type { AlertRuleV2, Leaf, TreeNode } from "../alert/types";
import {
  defaultActions,
  newId,
  newRuleId,
} from "../alert/types";

function leaf(
  field: string,
  op: Leaf["op"],
  value: number,
  params?: Record<string, number>
): Leaf {
  return { id: newId("l"), field, op, value, params };
}
function tree(op: "AND" | "OR", children: Leaf[]): TreeNode {
  return { id: newId("n"), op, children };
}

function make(name: string, t: TreeNode): AlertRuleV2 {
  const now = Date.now();
  return {
    id: newRuleId(),
    name,
    scope: { kind: "all" },
    tree: t,
    actions: defaultActions(),
    tone: "auto",
    frequency: "persistent",
    cooldownSec: 300,
    quiet: [],
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
}

export interface AlertTemplate {
  key: string;
  name: string;
  desc: string;
  build: () => AlertRuleV2;
}

export const ALERT_TEMPLATES: AlertTemplate[] = [
  {
    key: "breakout",
    name: "突破前高",
    desc: "放量上穿，价格创区间新高",
    build: () =>
      make(
        "突破前高",
        tree("AND", [
          leaf("price", "crossUp", 0), // 阈值由用户按个股前高填
          leaf("volumeRatio", ">=", 1.5),
        ])
      ),
  },
  {
    key: "pullback-ma",
    name: "回踩均线",
    desc: "回踩 20 日均线企稳（跌幅收窄）",
    build: () =>
      make(
        "回踩均线",
        tree("AND", [
          leaf("pct", ">=", -3), // 跌幅收窄、企稳
          leaf("pct", "<=", 1),
          leaf("ind.rsi", ">=", 40, { period: 14 }), // 脱离超卖
        ])
      ),
  },
  {
    key: "seal-up",
    name: "封涨停板",
    desc: "盘中刚封涨停",
    build: () => make("封涨停板", tree("AND", [leaf("evt.sealUp", ">=", 1)])),
  },
  {
    key: "broken",
    name: "涨停炸板",
    desc: "封涨停后打开，注意风险",
    build: () => make("涨停炸板", tree("AND", [leaf("evt.broken", ">=", 1)])),
  },
  {
    key: "auction-grab",
    name: "竞价抢筹",
    desc: "集合竞价高开且成交额放大",
    build: () =>
      make(
        "竞价抢筹",
        tree("AND", [
          leaf("auction.gap", ">=", 3),
          leaf("auction.amountYi", ">=", 1),
        ])
      ),
  },
  {
    key: "volume-surge",
    name: "放量异动",
    desc: "量比显著放大且上涨",
    build: () =>
      make(
        "放量异动",
        tree("AND", [leaf("volumeRatio", ">=", 3), leaf("pct", ">=", 3)])
      ),
  },
];
