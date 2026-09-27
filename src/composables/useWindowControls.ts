// 自绘标题栏窗口控制（Windows；macOS 用原生红绿灯）
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { onBeforeUnmount, ref } from "vue";

export function useWindowControls() {
  const curVersion = ref("");
  const isMac = ref(false);
  const isWin = ref(false);
  const isMax = ref(false);
  const inTauri = typeof window !== "undefined" && "__TAURI__" in window;
  const appWin = inTauri ? getCurrentWindow() : null;
  let unlistenResize: (() => void) | null = null;

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

  // 平台、版本与窗口最大化状态初始化（集中容错）
  async function initPlatform() {
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
      if (appWin) {
        unlistenResize = await appWin.onResized(() => {
          syncMax();
        });
      }
    } catch {
      /* ignore */
    }
  }

  onBeforeUnmount(() => {
    unlistenResize?.();
  });

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
