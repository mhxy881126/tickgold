import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";

// 测试配置：默认 node 环境（纯函数 / 工具），组件测试可在文件顶部用
// `// @vitest-environment jsdom` 切换。E2E 见 tests/e2e（后续接入）。
export default defineConfig({
  plugins: [vue()],
  test: {
    environment: "node",
    globals: false,
    include: ["tests/unit/**/*.test.ts", "src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      // v0.69.0 覆盖率口径：核心 TS 模块（数据解析/指标/布局/状态/API/工具）。
      // SFC（.vue）UI 由 E2E 与视觉回归覆盖，不计入单测覆盖率门槛。
      include: [
        "src/alert/**/*.ts",
        "src/lib/**/*.ts",
        "src/stores/**/*.ts",
        "src/api/**/*.ts",
        "src/utils/**/*.ts",
      ],
      exclude: ["src/**/*.d.ts"],
      thresholds: {
        statements: 60,
        branches: 60,
        functions: 60,
        lines: 60,
      },
    },
  },
});
