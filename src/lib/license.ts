// Pro 订阅授权（v3.4）：面包多卡密 → 本地离线验签 + 设备指纹绑定。
import { invoke } from "@tauri-apps/api/core";

export interface LicenseStatus {
  active: boolean;
  plan?: string | null;
  expires_at?: string | null;
  days_left?: number | null;
  rollback_detected?: boolean;
  message?: string | null;
  // ===== v3.4 设备绑定 =====
  device_locked?: boolean;
  need_relocate?: boolean;
  relocate_request?: string | null;
  machine_id?: string | null;
  ai_balance?: number | null;
  // ===== v3.14 分档日配额 =====
  daily_quota?: number | null;
  today_used?: number | null;
}

/** plan → 中文名 */
export function planLabel(plan?: string | null): string {
  switch (plan) {
    case "trial": return "免费试用";
    case "monthly": return "月卡";
    case "quarterly": return "季卡";
    case "annual":
    case "pro-annual": return "年卡";
    case "ai-topup": return "AI 次数包";
    default: return plan || "免费版";
  }
}

/** 查询授权状态（启动时调用）。 */
export function licenseStatus(): Promise<LicenseStatus> {
  return invoke<LicenseStatus>("license_status");
}

/** 粘贴卡密激活 Pro / 兑付 AI 次数卡。 */
export function licenseActivate(code: string): Promise<LicenseStatus> {
  return invoke<LicenseStatus>("license_activate", { code });
}

/** 退出 Pro（清除本地授权）。 */
export function licenseDeactivate(): Promise<LicenseStatus> {
  return invoke<LicenseStatus>("license_deactivate");
}

/** 换机授权：粘贴卖家签发的授权码，把激活码重绑到本机。 */
export function licenseRelocate(authCode: string): Promise<LicenseStatus> {
  return invoke<LicenseStatus>("license_relocate", { authCode });
}
