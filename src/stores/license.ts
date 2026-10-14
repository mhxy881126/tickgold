// Pro 授权全局状态（Pinia）。
import { defineStore } from "pinia";
import {
  licenseStatus,
  licenseActivate,
  licenseDeactivate,
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
