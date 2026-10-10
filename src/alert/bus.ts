// 预警引擎 → UI 的内部总线：弹窗队列 与 K线/盘口导航
import { ref } from "vue";

export interface AlertToastPayload {
  key: string;
  title: string;
  body: string;
  code: string;
  tone: string;
  at: number;
}

/** 待显示弹窗（最多保留 5 条） */
export const alertToasts = ref<AlertToastPayload[]>([]);

/** 应用内预警弹窗自动消失时长（ms），与全局 Toast 一致自动消失，仅给更长阅读时间 */
const ALERT_TOAST_TTL = 6000;
/** 每条弹窗的自动关闭定时器（key -> timer） */
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function clearTimer(key: string): void {
  const t = timers.get(key);
  if (t) {
    clearTimeout(t);
    timers.delete(key);
  }
}

export function pushToast(p: AlertToastPayload): void {
  // 同 key 先清旧定时器，避免重复计时
  clearTimer(p.key);
  const next = [p, ...alertToasts.value.filter((t) => t.key !== p.key)];
  // 超出上限被裁剪掉的弹窗，其定时器一并清理
  for (const dropped of next.slice(5)) clearTimer(dropped.key);
  alertToasts.value = next.slice(0, 5);
  // 到点自动消失，无需手动关闭（不产生任何系统级电脑弹窗）
  timers.set(
    p.key,
    setTimeout(() => dismissToast(p.key), ALERT_TOAST_TTL)
  );
}

export function dismissToast(key: string): void {
  clearTimer(key);
  alertToasts.value = alertToasts.value.filter((t) => t.key !== key);
}

/** 灵动岛数据：最新触发（保留 20 条，最新在前） */
export interface IslandAlert {
  id: string;
  code: string;
  name: string;
  label: string;
  message: string;
  price: number;
  pct: number;
  tone: string;
  at: number;
}
export const islandAlerts = ref<IslandAlert[]>([]);

export function pushIsland(p: IslandAlert): void {
  islandAlerts.value.unshift(p);
  if (islandAlerts.value.length > 20) islandAlerts.value.length = 20;
}

/** 导航回调（由 App 注册：选中个股 / 打开盘口） */
interface NavHandler {
  pickStock: (code: string) => void;
  openOrderBook: (code: string) => void;
  openScreener: () => void;
}
const nav: Partial<NavHandler> = {};

export function registerNav(h: NavHandler): void {
  Object.assign(nav, h);
}

export function navPickStock(code: string): void {
  nav.pickStock?.(code);
}
export function navOpenOrderBook(code: string): void {
  nav.openOrderBook?.(code);
}
export function navOpenScreener(): void {
  nav.openScreener?.();
}
