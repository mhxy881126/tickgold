// v0.71 预警引擎引导：规则加载 → 停用旧 Rust 引擎 → 注册导航 → 启动 TS 条件树引擎。
// 从 App.vue 抽出，控制 App 单文件行数。
import { useAlertV2Store } from "../stores/alertV2";
import { stopAlertEngine } from "../api/market";
import { startAlertEngineV2 } from "../alert/useAlertEngine";
import { registerNav } from "../alert/bus";

export interface AlertNavDeps {
  /** 选中个股（打开 K线 / 盘口共用） */
  pickStock: (code: string) => void;
  /** 打开条件选股卡片 */
  openScreener: () => void;
}

export async function bootstrapAlerts(deps: AlertNavDeps): Promise<void> {
  const store = useAlertV2Store();
  try {
    await store.load();
  } catch (e) {
    console.error("[alert] load v2 rules", e);
  }

  try {
    await stopAlertEngine();
    registerNav({
      pickStock: deps.pickStock,
      openOrderBook: deps.pickStock,
      openScreener: deps.openScreener,
    });
    startAlertEngineV2();
  } catch (e) {
    console.error("[alert] engine v2", e);
  }
}
