// v3.14 P0-5「急停三口径统一」：共享急停确认文案 + 确认入口 + 成功反馈文案。
// 复用既有全局 confirmDialog（App.vue 挂 AppDialog 宿主），不新造对话框组件 / 颜色样式。
// 三条底层路径保持不变：Cockpit 走 workflow store（mock-aware），RiskDashboard / Island 直调 brokerEmergencyHalt()。
import { confirmDialog } from "./useDialog";
import type { EmergencyHaltResult } from "../broker/api";

// ===== 统一文案常量（Cockpit / RiskDashboard / Island / SettingsDialog 共用同一口径）=====
export const EMERGENCY_HALT_DIALOG = {
  title: "一键急停",
  confirmText: "立即急停",
  cancelText: "取消",
  danger: true,
  // 四条后果要点 + 不可撤销说明：恢复需手动解除 → 重连 → 重启自动执行。
  message:
    "将立即执行：① 封死全部新委托 ② 停止自动执行（含条件单物化）③ 撤销全部条件单 ④ 撤销全部在途委托并断开券商通道。\n\n该操作不可撤销，恢复需手动解除 → 重连 → 重启自动执行。确认继续？",
} as const;

// ===== 弹窗宿主挂载标记 =====
// AppDialog 在本 Webview 挂载时置位（见 AppDialog.vue onMounted）。
// 灵动岛是独立 Webview（main.ts：label==="island" 直接挂 Island，无 App.vue / AppDialog 宿主），
// 此时 confirmDialog 的 Promise 无人 resolve，必须回退原生 confirm，避免点击后永久挂起。
let dialogHostMounted = false;
export function markDialogHostMounted(flag = true): void {
  dialogHostMounted = flag;
}

/**
 * 统一急停确认：返回 true=用户确认，false=取消（调用方取消即 return，不动作）。
 * 有 AppDialog 宿主 → 走全局 confirmDialog（danger 红）；无宿主窗口（灵动岛）→ 回退原生 confirm，文案完全一致。
 * 本函数不调用任何底层急停接口，底层调用由各入口各自保留。
 */
export function confirmEmergencyHalt(): Promise<boolean> {
  if (dialogHostMounted) {
    return confirmDialog({ ...EMERGENCY_HALT_DIALOG });
  }
  // 无宿主 Webview 兜底：原生 confirm（无法渲染 danger 红，属岛窗现状约束，见改动说明）。
  if (typeof window !== "undefined" && typeof window.confirm === "function") {
    return Promise.resolve(
      window.confirm(`${EMERGENCY_HALT_DIALOG.title}：${EMERGENCY_HALT_DIALOG.message}`),
    );
  }
  return Promise.resolve(false);
}

// ===== 统一成功反馈文案：复用 EmergencyHaltResult 的 coCount / orderCount =====
export function formatEmergencyHaltResult(r: EmergencyHaltResult): string {
  return `已急停：撤销条件单 ${r.coCount} 个、在途委托 ${r.orderCount} 笔`;
}
