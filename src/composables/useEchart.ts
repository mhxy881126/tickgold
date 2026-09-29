// echarts 微件共享：挂载时 init，容器尺寸变化（卡内 stride 重算 / 窗口缩放）时 resize，
// 卸载时 dispose。微件挂载早期 stride 可能为 0，必须靠 ResizeObserver 修正首帧。
import { nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import * as echarts from "echarts";

export function useEchart() {
  const el = ref<HTMLElement | null>(null);
  const chart = ref<ReturnType<typeof echarts.init> | null>(null);
  let ro: ResizeObserver | null = null;

  onMounted(async () => {
    await nextTick();
    if (!el.value) return;
    chart.value = echarts.init(el.value);
    ro = new ResizeObserver(() => chart.value?.resize());
    ro.observe(el.value);
  });

  onBeforeUnmount(() => {
    ro?.disconnect();
    chart.value?.dispose();
    chart.value = null;
  });

  return { el, chart };
}
