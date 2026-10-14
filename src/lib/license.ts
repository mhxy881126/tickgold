// Pro 订阅授权（v3.0.2）：面包多卡密 → 本地离线验签。
import { invoke } from "@tauri-apps/api/core";

export interface LicenseStatus {
  active: boolean;
  plan?: string | null;
  expires_at?: string | null;
  days_left?: number | null;
  rollback_detected?: boolean;
  message?: string | null;
}

/** 查询授权状态（启动时调用）。 */
export function licenseStatus(): Promise<LicenseStatus> {
  return invoke<LicenseStatus>("license_status");
}

/** 粘贴卡密激活 Pro。 */
export function licenseActivate(code: string): Promise<LicenseStatus> {
  return invoke<LicenseStatus>("license_activate", { code });
}

/** 退出 Pro（清除本地授权）。 */
export function licenseDeactivate(): Promise<LicenseStatus> {
  return invoke<LicenseStatus>("license_deactivate");
}
