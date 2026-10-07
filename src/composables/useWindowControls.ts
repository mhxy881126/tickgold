// 自绘标题栏窗口控制（Windows；macOS 用原生红绿灯）
// 模块级单例：curVersion 等状态全局共享——关于页等所有消费方拿到同一份已初始化的版本号，
// 避免各实例独立 ref 导致 curVersion 永远为空（曾使关于页一直显示兜底旧版本）。
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ref } from "vue";

const curVersion = ref("");
const isMac = ref(false);
const isWin = ref(false);
const isMax = ref(false);
let inited = false;
let unlistenResize: (() => void) | null = null;

export function useWindowControls() {
  const inTauri = typeof window !== "undefined" && "__TAURI__" in window;
  const appWin = inTauri ? getCurrentWindow() : null;

  async function syncMax() {
    try {
      isMax.value = await invoke<boolean>("win_is_maximized");
      return;
    } catch {
      /* fall through to JS API */
    }
    if (!appWin) return;
    try {
      isMax.value = await appWin.isMaximized();
    } catch {
      /* ignore */
    }
  }
  async function winMinimize() {
    try {
      await invoke("win_minimize");
    } catch {
      appWin?.minimize().catch(() => {});
    }
  }
  async function winToggleMax() {
    try {
      isMax.value = await invoke<boolean>("win_toggle_maximize");
    } catch {
      appWin?.toggleMaximize().then(syncMax).catch(() => {});
    }
  }
  async function winClose() {
    try {
      await invoke("win_close");
    } catch {
      appWin?.close().catch(() => {});
    }
  }

  // 平台、版本与窗口最大化状态初始化（集中容错；全应用只执行一次）
  async function initPlatform() {
    if (inited) return;
    inited = true;
    try {
      const pf = (navigator.platform || navigator.userAgent || "").toLowerCase();
      isMac.value = pf.includes("mac");
      isWin.value = pf.includes("win");
      curVersion.value = await getVersion();
    } catch (e) {
      console.error("[app] platform/version", e);
    }
    try {
      await syncMax();
      if (appWin && !unlistenResize) {
        // 模块级单例：监听随应用生命周期，无需按组件卸载清理
        unlistenResize = await appWin.onResized(() => {
          syncMax();
        });
      }
    } catch {
      /* ignore */
    }
  }

  return {
    curVersion,
    isMac,
    isWin,
    isMax,
    initPlatform,
    syncMax,
    winMinimize,
    winToggleMax,
    winClose,
  };
}
