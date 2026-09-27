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

export function pushToast(p: AlertToastPayload): void {
  alertToasts.value.unshift(p);
  if (alertToasts.value.length > 5) alertToasts.value.length = 5;
}

export function dismissToast(key: string): void {
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
