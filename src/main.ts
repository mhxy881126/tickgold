import { createApp } from "vue";
import { createPinia } from "pinia";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App.vue";
import Island from "./components/Island.vue";
import "./styles/global.css";

// 未捕获错误打印到控制台（web 预览环境便于排查）
window.addEventListener("error", (e) => console.error("[error]", e.message));
window.addEventListener("unhandledrejection", (e) =>
  console.error("[unhandledrejection]", e.reason)
);

// 安全获取窗口 label（web 预览环境下 getCurrentWindow 会抛错）
let label = "main";
try {
  label = getCurrentWindow().label;
} catch {
  /* ignore */
}

const pinia = createPinia();
if (label === "island") {
  createApp(Island).use(pinia).mount("#app");
} else {
  createApp(App).use(pinia).mount("#app");
  // 请求通知权限
  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission().catch(() => {});
  }
}
