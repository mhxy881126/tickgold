import { createApp } from "vue";
import { createPinia } from "pinia";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App.vue";
import Island from "./components/Island.vue";
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

const pinia = createPinia();
if (label === "island") {
  const app = createApp(Island);
  app.config.errorHandler = vueErrorHandler;
  app.use(pinia).mount("#app");
} else {
  const app = createApp(App);
  app.config.errorHandler = vueErrorHandler;
  app.use(pinia).mount("#app");
  // 请求通知权限
  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission().catch(() => {});
  }
}
