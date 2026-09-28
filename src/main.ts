import { createApp } from "vue";
import { createPinia } from "pinia";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App.vue";
import Island from "./components/Island.vue";
import CardWindow from "./components/CardWindow.vue";
import type { CardId } from "./lib/cards";
import { logger } from "./utils/logger";
import "./styles/global.css";

// 全局未捕获错误 / Promise 拒绝：归集到分级日志（不再只打印控制台）
window.addEventListener("error", (e) => {
  logger.error(e.message || (e.error ? String(e.error) : "unknown error"), "window.error", {
    filename: e.filename,
    lineno: e.lineno,
    colno: e.colno,
    stack: e.error instanceof Error ? e.error.stack : undefined,
  });
});
window.addEventListener("unhandledrejection", (e) => {
  const reason = e.reason;
  logger.error(
    reason instanceof Error ? reason.message : String(reason),
    "unhandledrejection",
    reason instanceof Error ? { stack: reason.stack } : { reason }
  );
});

// Vue 组件内未捕获错误：归集日志，避免静默失败
function vueErrorHandler(err: unknown, _instance: unknown, info: string) {
  const e = err instanceof Error ? err : new Error(String(err));
  logger.error(e.message, "vue", { info, stack: e.stack });
}

// 安全获取窗口 label（web 预览环境下 getCurrentWindow 会抛错）
let label = "main";
try {
  label = getCurrentWindow().label;
} catch {
  /* ignore */
}
// web 预览：?card=xxx 直接以独立卡片窗模式渲染（便于调试多窗）
const cardParam = new URLSearchParams(location.search).get("card");

const pinia = createPinia();
if (label === "island") {
  const app = createApp(Island);
  app.config.errorHandler = vueErrorHandler;
  app.use(pinia).mount("#app");
} else if (cardParam || label.startsWith("card-")) {
  const cardId = (cardParam ?? label.slice(5)) as CardId;
  try {
    const app = createApp(CardWindow, { cardId });
    app.config.errorHandler = vueErrorHandler;
    app.use(pinia).mount("#app");
  } catch (err) {
    // 挂载前/挂载期致命错误（错误边界捕获不到）：显式渲染，避免整窗白屏无从排查
    const e = err instanceof Error ? err : new Error(String(err));
    logger.error(e.message, "card-window:mount", { cardId, stack: e.stack });
    const root = document.getElementById("app");
    if (root) {
      root.style.cssText =
        "background:#1a0d0d;color:#ff9aa8;padding:16px;font:12px/1.6 system-ui;overflow:auto;";
      root.textContent = `卡片窗口挂载失败 [${cardId}]\n${e.message}\n${e.stack ?? ""}`;
      root.style.whiteSpace = "pre-wrap";
    }
  }
} else {
  const app = createApp(App);
  app.config.errorHandler = vueErrorHandler;
  app.use(pinia).mount("#app");
  // 请求通知权限
  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission().catch(() => {});
  }
}
