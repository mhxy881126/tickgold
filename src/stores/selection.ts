// 全局选中股票（P3-b 盘口/分时联动）。
// 模块级单例而非 Pinia：与 quickAction 同款，跨卡片共享「当前标的」，
// 不依赖 pinia 实例生命周期，纯 TS 单测可直接 import 断言。
import { ref } from "vue";

/** 当前全局选中的股票代码；null = 未选中。 */
export const selectedCode = ref<string | null>(null);

/**
 * 选中一只股票（App / 盘口 / 分时点击统一入口）。
 * 空值或纯空白视为清空；返回最终生效的代码，便于调用方复用。
 */
export function selectCode(code: string | null | undefined): string | null {
  const next = typeof code === "string" ? code.trim() : "";
  selectedCode.value = next || null;
  return selectedCode.value;
}

/** 清空选中（开盘前 / 自选清空等场景）。 */
export function clearSelectedCode(): void {
  selectedCode.value = null;
}
