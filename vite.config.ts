import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// Tauri 期望前端固定端口，且打包时用环境变量区分 dev/build
export default defineConfig({
  plugins: [vue()],
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
});
