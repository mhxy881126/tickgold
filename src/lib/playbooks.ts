// 打法条件单快捷方案：不含 code（条件单必须绑定具体个股），
// 用户在条件单卡片选定标的后一键填充表单。trigger 复用 CoTriggerLeaf 结构。
import type { CoTriggerLeaf } from "../broker/co";

export interface CoPlan {
  id: string;
  label: string;
  desc: string;
  side: "BUY" | "SELL";
  priceMode: "trigger" | "limit" | "market";
  ttl: "day" | "gtc" | "date";
  build: () => { trigger: CoTriggerLeaf[]; note: string };
}

export const CO_PLANS: CoPlan[] = [
  {
    id: "daban-seal-buy",
    label: "封板买入",
    desc: "涨停封板瞬间买入（高风险接力，仅熟练者 / 模拟盘）",
    side: "BUY", priceMode: "trigger", ttl: "day",
    build: () => ({
      trigger: [{ field: "sealUp", op: "happened", value: 1 }],
      note: "打板·封板接力买入",
    }),
  },
  {
    id: "daban-broken-exit",
    label: "炸板卖出",
    desc: "涨停炸板立即卖出，保住接力利润",
    side: "SELL", priceMode: "market", ttl: "day",
    build: () => ({
      trigger: [{ field: "broken", op: "happened", value: 1 }],
      note: "打板接力·炸板止损",
    }),
  },
  {
    id: "dixi-buy-pullback",
    label: "企稳转强买入",
    desc: "窗口内快速拉升（转强）时买入，阈值按标的调整",
    side: "BUY", priceMode: "trigger", ttl: "day",
    build: () => ({
      trigger: [
        { field: "riseSpeed", op: "gte", value: 1, params: { windowSec: 300 } },
      ],
      note: "低吸·企稳转强买入",
    }),
  },
  {
    id: "dixi-stoploss",
    label: "回撤止损",
    desc: "跌破止损价卖出（提交后请把阈值改为你的成本/止损价）",
    side: "SELL", priceMode: "trigger", ttl: "day",
    build: () => ({
      trigger: [{ field: "price", op: "crossBelow", value: 0 }],
      note: "低吸·回撤止损（请改为止损价）",
    }),
  },
  {
    id: "qushi-break-exit",
    label: "破位卖出",
    desc: "跌破关键支撑（均线 / 平台）卖出，阈值按支撑位填",
    side: "SELL", priceMode: "trigger", ttl: "gtc",
    build: () => ({
      trigger: [{ field: "price", op: "crossBelow", value: 0 }],
      note: "趋势·破位离场（请改为支撑价）",
    }),
  },
];

export function getCoPlan(id: string): CoPlan | undefined {
  return CO_PLANS.find((p) => p.id === id);
}
