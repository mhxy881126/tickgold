// P6 一键智驾模式：前端 Pinia store。
// 展示与触发后端 ai::pilot 排程；非 Tauri 环境（浏览器 dev）自动降级本地 mock，保证驾驶舱可独立走查。
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import {
  pilotConfigSet,
  pilotPause,
  pilotStart,
  pilotStatus,
  pilotStop,
  type PilotConfigPatch,
  type PilotStatus,
} from "../ai/pilot";

export const usePilotStore = defineStore("pilot", () => {
  const status = ref<PilotStatus | null>(null);
  const loading = ref(false);
  const busy = ref(false);
  const error = ref("");
  const mockMode = ref(false);

  const running = computed(() => status.value?.running ?? false);
  const mode = computed(() => status.value?.mode ?? "off");
  const riskProfile = computed(() => status.value?.riskProfile ?? "steady");

  let pollTimer: ReturnType<typeof setInterval> | null = null;

  /** 本地 mock 状态（浏览器 dev / 后端未就绪时使用） */
  function applyMock(base: Partial<PilotStatus> = {}): PilotStatus {
    return {
      mode: "off",
      accountType: "paper",
      virtualCash: 100_000,
      tacticProfileId: 0,
      riskProfile: "steady",
      scheduleEnabled: true,
      todayScanTarget: 15,
      todayScanCount: 0,
      lastScanAt: 0,
      running: false,
      nextScanMinute: 570,
      tradeDate: new Date().toISOString().slice(0, 10),
      updatedAt: Date.now(),
      today: {
        scanCount: 0,
        buyCount: 0,
        sellCount: 0,
        pnlCents: 0,
        assetCents: 10_000_000,
        summary: "演示模式：点击「一键开始自动交易」即可走查智驾闭环。",
      },
      ...base,
    };
  }

  async function refresh() {
    if (mockMode.value) return;
    loading.value = true;
    error.value = "";
    try {
      status.value = await pilotStatus();
    } catch (e) {
      // 非 Tauri / 后端未就绪：降级 mock，保持交互可走查。
      mockMode.value = true;
      status.value = applyMock();
    } finally {
      loading.value = false;
    }
  }

  function syncStatus(s: PilotStatus | null, fallback: Partial<PilotStatus>) {
    status.value = s ?? applyMock(fallback);
  }

  async function start() {
    busy.value = true;
    error.value = "";
    try {
      if (mockMode.value) {
        syncStatus(null, {
          mode: "running",
          running: true,
          todayScanCount: 3,
          today: {
            scanCount: 3,
            buyCount: 1,
            sellCount: 0,
            pnlCents: 0,
            assetCents: 10_000_000,
            summary: "演示：智驾已启动，自动完成盘前采集 → 分析 → 计划 → 盯盘。",
          },
        });
      } else {
        status.value = await pilotStart();
      }
      ensurePolling();
    } catch (e) {
      error.value = String(e);
    } finally {
      busy.value = false;
    }
  }

  async function pause() {
    busy.value = true;
    error.value = "";
    try {
      if (mockMode.value) {
        syncStatus(null, { mode: "paused", running: false });
      } else {
        status.value = await pilotPause();
      }
    } catch (e) {
      error.value = String(e);
    } finally {
      busy.value = false;
    }
  }

  async function stop() {
    busy.value = true;
    error.value = "";
    try {
      if (mockMode.value) {
        syncStatus(null, { mode: "off", running: false });
      } else {
        status.value = await pilotStop();
      }
      stopPolling();
    } catch (e) {
      error.value = String(e);
    } finally {
      busy.value = false;
    }
  }

  async function saveConfig(patch: PilotConfigPatch) {
    busy.value = true;
    error.value = "";
    try {
      if (mockMode.value) {
        syncStatus(null, patch);
      } else {
        status.value = await pilotConfigSet(patch);
      }
    } catch (e) {
      error.value = String(e);
    } finally {
      busy.value = false;
    }
  }

  function ensurePolling() {
    if (pollTimer) return;
    pollTimer = setInterval(async () => {
      if (!running.value) return;
      if (mockMode.value) return;
      try {
        status.value = await pilotStatus();
      } catch {
        // 单次轮询失败不打断（后端瞬时不可用可容忍）。
      }
    }, 3000);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  return {
    status,
    loading,
    busy,
    error,
    mockMode,
    running,
    mode,
    riskProfile,
    refresh,
    start,
    pause,
    stop,
    saveConfig,
    stopPolling,
  };
});
