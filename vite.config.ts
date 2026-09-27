import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath, URL } from "node:url";

// Tauri 期望前端固定端口，且打包时用环境变量区分 dev/build
// E2E：以 `vite --mode e2e` 启动时，把 @tauri-apps/* 裸模块 alias 到假实现，
// 让纯前端（不启动 Rust / WebView）即可跑通关键交互。
export default defineConfig(({ mode }) => {
  const fakeApi = fileURLToPath(new URL("./tests/e2e/support/tauri-api-fake.ts", import.meta.url));
  const fakePlugins = fileURLToPath(new URL("./tests/e2e/support/tauri-plugins-fake.ts", import.meta.url));
  const exact = (name: string, replacement: string) => ({
    find: new RegExp("^" + name.replace(/\//g, "\\/") + "$"),
    replacement,
  });

  const alias: { find: RegExp; replacement: string }[] = [];
  if (mode === "e2e") {
    ["core", "event", "window", "app", "dpi", "webviewWindow"].forEach((s) =>
      alias.push(exact("@tauri-apps/api/" + s, fakeApi)));
    ["plugin-sql", "plugin-process", "plugin-autostart", "plugin-updater", "plugin-opener"].forEach((s) =>
      alias.push(exact("@tauri-apps/" + s, fakePlugins)));
  }

  return {
    plugins: [vue()],
    resolve: { alias },
    clearScreen: false,
    server: {
      port: 1420,
      strictPort: true,
      host: "127.0.0.1",
      watch: {
        // 不监听 src-tauri，避免改动 Rust 触发整页刷新
        ignored: ["**/src-tauri/**"],
      },
    },
    envPrefix: ["VITE_", "TAURI_ENV_*"],
    build: {
      target: "es2021",
      minify: "esbuild",
      sourcemap: false,
    },
  };
});
