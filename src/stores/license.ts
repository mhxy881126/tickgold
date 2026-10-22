// Pro 授权全局状态（Pinia）。
import { defineStore } from "pinia";
import {
  licenseStatus,
  licenseActivate,
  licenseDeactivate,
  licenseRelocate,
  type LicenseStatus,
} from "../lib/license";

export const useLicenseStore = defineStore("license", {
  state: () => ({
    status: null as LicenseStatus | null,
    loading: false,
    error: "",
  }),
  getters: {
    /** Pro 是否生效（未过期且未检测到时间回拨）。 */
    isPro: (s) => !!s.status?.active,
    daysLeft: (s) => (s.status?.days_left != null ? s.status.days_left : null),
    expiresAt: (s) => s.status?.expires_at ?? null,
    plan: (s) => s.status?.plan ?? null,
    message: (s) => s.status?.message ?? "",
    /** 是否因换机被锁定（需换机授权）。 */
    needRelocate: (s) => !!s.status?.need_relocate,
    /** 换机申请码（发给卖家换取授权码）。 */
    relocateRequest: (s) => s.status?.relocate_request ?? "",
    /** 剩余 AI 总次数包（null 表示无次数包，走每日配额）。 */
    aiBalance: (s) => (s.status?.ai_balance != null ? s.status.ai_balance : null),
    /** 当前 plan 每日 AI 配额 */
    dailyQuota: (s) => s.status?.daily_quota ?? 0,
    /** 今日已用 AI 次数 */
    todayUsed: (s) => s.status?.today_used ?? 0,
  },
  actions: {
    async load() {
      this.loading = true;
      this.error = "";
      try {
        this.status = await licenseStatus();
      } catch (e) {
        this.error = String(e);
      } finally {
        this.loading = false;
      }
    },
    async activate(code: string): Promise<boolean> {
      this.loading = true;
      this.error = "";
      try {
        this.status = await licenseActivate(code);
        return !!this.status?.active;
      } catch (e) {
        this.error = String(e);
        return false;
      } finally {
        this.loading = false;
      }
    },
    async relocate(authCode: string): Promise<boolean> {
      this.loading = true;
      this.error = "";
      try {
        this.status = await licenseRelocate(authCode);
        return !!this.status?.active;
      } catch (e) {
        this.error = String(e);
        return false;
      } finally {
        this.loading = false;
      }
    },
    async deactivate() {
      this.loading = true;
      this.error = "";
      try {
        this.status = await licenseDeactivate();
      } catch (e) {
        this.error = String(e);
      } finally {
        this.loading = false;
      }
    },
  },
});
