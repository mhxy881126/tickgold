// 顶部功能导航：6 大功能域静态目录（Mega 菜单 + 命令面板共用）
import type { CardId } from "./cards";

export interface DockItem {
  id: CardId;
  label: string;
  icon: string;
  desc: string;
  star?: boolean;
}
export interface DockGroup {
  name: string;
  icon: string;
  items: DockItem[];
}
export interface PaletteRow extends DockItem {
  cat: string;
}

export const DOCK_GROUPS: DockGroup[] = [
  {
    name: "大盘总览",
    icon: "M3 3h7v7H3zm11 0h7v7h-7zM3 14h7v7H3zm11 0h7v7h-7z",
    items: [
      { id: "watch", label: "自选", icon: "M12 17.27 18.18 21l-1.64-7.03L22 9.24l7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z", desc: "我的股票分组实时行情", star: true },
      { id: "rank", label: "榜单", icon: "M3 5h18v2H3zm0 4h18v2H3zm0 4h12v2H3zm0 4h12v2H3z", desc: "全市场涨幅/跌幅/成交额排名", star: true },
      { id: "dist", label: "涨跌分布", icon: "M3 21h2v-7H3zm4 0h2V9H7zm4 0h2V5h-2zm4 0h2v-9h-2zm4 0h2V11h-2z", desc: "涨跌幅十档家数分布" },
    ],
  },
  {
    name: "盯盘模式",
    icon: "M12 2A10 10 0 1 0 22 12h-2A8 8 0 1 1 12 4zM12 6v6l5 2-1 1.7L11 13V6z",
    items: [
      { id: "radarsweep", label: "雷达扫盘", icon: "M12 2A10 10 0 1 0 22 12h-2A8 8 0 1 1 12 4zM12 6v6l5 2-1 1.7L11 13V6z", desc: "圆形雷达三栏全屏扫盘", star: true },
      { id: "reviewtimeline", label: "复盘时间线", icon: "M12 3a2 2 0 100 4 2 2 0 000-4zm0 7a2 2 0 100 4 2 2 0 000-4zm0 7a2 2 0 100 4 2 2 0 000-4z", desc: "全天异动时间线 + 当日总结" },
      { id: "dragon", label: "龙虎榜", icon: "M4 4h16v6H4zm0 10h16v6H4z", desc: "每日龙虎榜个股 + 买卖前五席位/游资", star: true },
      { id: "multigrid", label: "多股同列", icon: "M3 3h5v5H3zm6.5 0h5v5h-5zM16 3h5v5h-5zM3 9.5h5v5H3zm6.5 0h5v5h-5zM16 9.5h5v5h-5zM3 16h5v5H3zm6.5 0h5v5h-5zM16 16h5v5h-5z", desc: "自选 9 只 分时/K线/盘口同屏" },
      { id: "heatmatrix", label: "热力矩阵", icon: "M3 4h7v4H3zm9 0h9v4h-9zM3 10h9v4H3zm11 0h7v4h-7zM3 16h7v4H3zm9 0h9v4h-9z", desc: "全市场板块热力矩阵" },
      { id: "telegraph", label: "电报墙", icon: "M4 11a8 8 0 0116 0M7 11a5 5 0 0110 0M10 11a2 2 0 014 0M12 13v8", desc: "三列异动电报实时滚动" },
    ],
  },
  {
    name: "情绪异动",
    icon: "M13 2 3 14h7l-1 8 10-12h-7l1-8z",
    items: [
      { id: "auction", label: "集合竞价", icon: "M3 17h2l3-8 4 14 3-10 2 4h4", desc: "全市场高开抢筹/低开出逃排名", star: true },
      { id: "limitpool", label: "涨停池明细", icon: "M4 4h16v6H4zm0 10h16v6H4z", desc: "涨停/炸板池封单额/封板时间/题材", star: true },
      { id: "radar", label: "涨停雷达", icon: "M12 2a10 10 0 100 20 10 10 0 000-20zm0 4a6 6 0 100 12 6 6 0 000-12zm0 3a3 3 0 100 6 3 3 0 000-6z", desc: "涨停/炸板/连板/情绪统计", star: true },
      { id: "spider", label: "短线精灵", icon: "M13 2 3 14h7l-1 8 10-12h-7l1-8z", desc: "活跃股盘中实时异动" },
      { id: "alert", label: "预警", icon: "M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C8.63 5.36 7 7.92 7 11v5l-2 2v1h14v-1l-2-2z", desc: "价格/涨跌幅触发推送" },
      { id: "news", label: "快讯", icon: "M5 3h14a2 2 0 012 2v11a2 2 0 01-2 2H8l-4 3V5a2 2 0 011-2z", desc: "7x24 全球财经直播" },
    ],
  },
  {
    name: "板块题材",
    icon: "M12 2a10 10 0 100 20 10 10 0 000-20zm-1 2.06V11H4.06A8 8 0 0111 4.06zM4 13h7v6.94A8 8 0 014 13zm9 6.94V13h6.94A8 8 0 0113 19.94zM19.94 11H13V4.06A8 8 0 0119.94 11z",
    items: [
      { id: "sector", label: "板块行情", icon: "M12 2a10 10 0 100 20 10 10 0 000-20zm-1 2.06V11H4.06A8 8 0 0111 4.06zM4 13h7v6.94A8 8 0 014 13zm9 6.94V13h6.94A8 8 0 0113 19.94zM19.94 11H13V4.06A8 8 0 0119.94 11z", desc: "行业/概念板块排名" },
      { id: "sectorheat", label: "板块热力图", icon: "M3 3h7v7H3zm11 0h7v7h-7zM3 14h7v7H3zm11 0h7v7h-7z", desc: "板块 treemap 缩放平移" },
      { id: "sectorevent", label: "板块异动", icon: "M3 12h4l3-8 4 16 3-8h4", desc: "板块拉升/跳水捕捉" },
      { id: "themelib", label: "题材库", icon: "M4 19.5A2.5 2.5 0 0 1 6.5 17H20", desc: "题材生命周期/成分角色/催化剂时间线", star: true },
    ],
  },
  {
    name: "个股行情",
    icon: "M6 3h2v4H6zm0 14h2v4H6zM5 8h4v8H5zm11-9h2v3h-2zm0 12h2v5h-2zm-1-7h4v7h-4z",
    items: [
      { id: "chart", label: "K线/分时", icon: "M6 3h2v4H6zm0 14h2v4H6zM5 8h4v8H5zm11-9h2v3h-2zm0 12h2v5h-2zm-1-7h4v7h-4z", desc: "日周月 K + 当日分时", star: true },
      { id: "order", label: "盘口", icon: "M5 3h14v18H5zm2 4h10v2H7zm0 4h10v2H7zm0 4h7v2H7z", desc: "动态档数买卖盘 + 今日概览" },
      { id: "trades", label: "逐笔成交", icon: "M4 6h16M4 10h16M4 14h16M4 18h12", desc: "逐笔实时滚动 + 主动买卖着色", star: true },
      { id: "fundflow", label: "资金流向", icon: "M12 3c-4 0-7 1.3-7 3v12c0 1.7 3 3 7 3s7-1.3 7-3V6c0-1.7-3-3-7-3zm0 2c3.3 0 5 .9 5 1s-1.7 1-5 1-5-.9-5-1 1.7-1 5-1zm-5 4.5c1.2.8 3 1.3 5 1.3s3.8-.5 5-1.3V12c0 .1-1.7 1-5 1s-5-.9-5-1zm0 4c1.2.8 3 1.3 5 1.3s3.8-.5 5-1.3V16c0 .1-1.7 1-5 1s-5-.9-5-1z", desc: "主力/散户 四档资金" },
      { id: "f10", label: "F10资料", icon: "M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6zm0 2l4 4h-4V4zM8 13h8v1.5H8zm0 4h8v1.5H8zm0-8h5v1.5H8z", desc: "公司/财务/筹码分布" },
    ],
  },
  {
    name: "交易工具",
    icon: "M5 3h14a1 1 0 011 1v16a1 1 0 01-1 1H5a1 1 0 01-1-1V4a1 1 0 011-1z",
    items: [
      { id: "screener", label: "条件选股", icon: "M4 5h3v14H4zm6.5 5h3v9h-3zM17 9h3v10h-3z", desc: "技术/基本面智能选股" },
      { id: "trade", label: "模拟交易", icon: "M12 2a10 10 0 100 20 10 10 0 000-20zm1 5v1.1c1.7.3 3 1.4 3 3.1 0 1.9-1.5 2.8-3.4 2.8-1.2 0-2.1-.4-2.6-1l1.2-1c.3.4.8.7 1.5.7.8 0 1.3-.3 1.3-.8s-.4-.8-1.5-1c-1.6-.4-3.2-1-3.2-2.9 0-1.6 1.3-2.7 3-3V5h2zm-1 11h2v2h-2z", desc: "虚拟资金 T+1 练盘" },
      { id: "journal", label: "盯盘日记", icon: "M5 3h14a1 1 0 011 1v16a1 1 0 01-1 1H5a1 1 0 01-1-1V4a1 1 0 011-1zm3 5h8v1.5H8zm0 4h8v1.5H8zm0 4h5v1.5H8z", desc: "交易复盘记录" },
      { id: "calendar", label: "财经日历", icon: "M7 2v2H5a2 2 0 00-2 2v13a2 2 0 002 2h14a2 2 0 002-2V6a2 2 0 002-2h-2V2h-2v2H9V2H7zm-2 7h14v10H5V9zm2 2v3h3v-3H7zm5 0v3h3v-3z", desc: "休市安排/事件提醒" },
      { id: "ipo", label: "新股解禁", icon: "M12 2l2.9 6.3 6.8.7-5 4.6 1.4 6.7L12 17l-6.1 3.3 1.4-6.7-5-4.6 6.8-.7z", desc: "新股/解禁日历" },
      { id: "calc", label: "投资计算器", icon: "M7 2h10a2 2 0 012 2v16a2 2 0 01-2 2H7a2 2 0 01-2 2V4a2 2 0 012-2zm2 4h6v2H9V6zm0 4h2v2H9v-2zm4 0h2v2h-2v-2zm-4 4h2v2H9v-2zm4 0h2v2h-2v-2z", desc: "盈亏/仓位/风报比/黄金分割" },
      { id: "export", label: "数据导出", icon: "M12 3a1 1 0 011 1v8.6l3.3-3.3 1.4 1.4L12 17l-5.7-6.3 1.4-1.4L11 12.6V4a1 1 0 011-1zM5 19h14v2H5v-2z", desc: "CSV/JSON 导出自选/行情/交易" },
    ],
  },
];
