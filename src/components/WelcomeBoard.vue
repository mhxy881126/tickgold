<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, inject } from "vue";
import { listen } from "@tauri-apps/api/event";
import { startRadar, type RadarData } from "../api/market";
import type { CardId } from "../composables/useWorkbench";

const bench = inject<any>("workbench");
const data = ref<RadarData | null>(null);
let un: (() => void) | null = null;

// 情绪温度：sentiment 口径 2(冰点) ~ 99(狂热)，50 中性
const moodPos = computed(() => {
  const s = data.value ? data.value.sentiment : 50;
  return Math.min(99, Math.max(2, s));
});
const moodText = computed(() => (data.value ? data.value.mood : "--"));

interface Q {
  id: CardId;
  label: string;
  icon: string;
}
const QUICK: Q[] = [
  { id: "radar", label: "涨停雷达", icon: "M12 2a10 10 0 100 20 10 10 0 000-20zm0 4a6 6 0 100 12 6 6 0 000-12zm0 3a3 3 0 100 6 3 3 0 000-6z" },
  { id: "sectorheat", label: "热力图", icon: "M3 3h7v7H3zm11 0h7v7h-7zM3 14h7v7H3zm11 0h7v7h-7z" },
  { id: "chart", label: "K线盘口", icon: "M6 3h2v4H6zm0 14h2v4H6zM5 8h4v8H5zm11-9h2v3h-2zm0 12h2v5h-2zm-1-7h4v7h-4z" },
  { id: "fundflow", label: "资金流向", icon: "M12 3c-4 0-7 1.3-7 3v12c0 1.7 3 3 7 3s7-1.3 7-3V6c0-1.7-3-3-7-3zm0 2c3.3 0 5 .9 5 1s-1.7 1-5 1-5-.9-5-1 1.7-1 5-1zm-5 4.5c1.2.8 3 1.3 5 1.3s3.8-.5 5-1.3V12c0 .1-1.7 1-5 1s-5-.9-5-1-1.7-1 5-1zm0 4c1.2.8 3 1.3 5 1.3s3.8-.5 5-1.3V16c0 .1-1.7 1-5 1s-5-.9-5-1-1.7-1 5-1z" },
  { id: "spider", label: "短线精灵", icon: "M13 2 3 14h7l-1 8 10-12h-7l1-8z" },
  { id: "watch", label: "自选股", icon: "M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" },
  { id: "rank", label: "榜单", icon: "M3 5h18v2H3zm0 4h18v2H3zm0 4h12v2H3zm0 4h12v2H3z" },
  { id: "screener", label: "条件选股", icon: "M4 5h3v14H4zm6.5 5h3v9h-3zM17 9h3v10h-3z" },
];

function open(id: CardId) {
  bench?.open(id);
}

onMounted(async () => {
  un = await listen<RadarData>("radar:data", (e) => {
    data.value = e.payload;
  });
  try {
    await startRadar();
  } catch {
    /* 非 Tauri / 源不可达时静默，显示占位 */
  }
});
onBeforeUnmount(() => un?.());
</script>

<template>
  <div class="wb-root">
    <div class="wb-mask"></div>

    <!-- 顶部：涨跌 / 涨停跌停 + 情绪温度（沉浸铺满，无圆角边界） -->
    <div class="wb-strip">
      <div class="wb-stat">
        <span class="lb">上涨</span>
        <span class="big up">{{ data ? data.upCount : "--" }}</span>
      </div>
      <div class="wb-stat">
        <span class="lb">下跌</span>
        <span class="big down">{{ data ? data.downCount : "--" }}</span>
      </div>
      <div class="wb-stat">
        <span class="lb">涨停</span>
        <span class="big up">{{ data ? data.limitUp : "--" }}</span>
      </div>
      <div class="wb-stat">
        <span class="lb">跌停</span>
        <span class="big down">{{ data ? data.limitDown : "--" }}</span>
      </div>
      <div class="wb-stat mood-card">
        <div class="mood-head">
          <span class="lb">市场情绪 · <b>{{ moodText }}</b></span>
          <span class="mood-num">{{ moodPos }}</span>
        </div>
        <div class="mood-bar">
          <i :style="{ left: moodPos + '%' }"></i>
        </div>
      </div>
    </div>

    <!-- 中部：品牌 -->
    <div class="wb-mid">
      <div class="wb-logo">TG</div>
      <h1>TickGold 盯盘工作台</h1>
      <p>空台也能一眼看全局 · 选择下方快捷入口直接开始盯盘</p>
    </div>

    <!-- 底部：快捷入口 -->
    <div class="wb-quick">
      <button v-for="q in QUICK" :key="q.id" type="button" class="q-btn" @click="open(q.id)">
        <span class="qi">
          <svg viewBox="0 0 24 24"><path fill="currentColor" :d="q.icon" /></svg>
        </span>
        {{ q.label }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.wb-root {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  padding: 16px;
  overflow: hidden;
  color: var(--text);
  background:
    radial-gradient(900px 420px at 50% -18%, color-mix(in srgb, var(--accent) 15%, transparent), transparent 60%),
    radial-gradient(820px 420px at 50% 118%, color-mix(in srgb, var(--blue) 15%, transparent), transparent 60%),
    var(--bg);
}
.wb-mask {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background-image:
    linear-gradient(color-mix(in srgb, var(--text) 4.5%, transparent) 1px, transparent 1px),
    linear-gradient(90deg, color-mix(in srgb, var(--text) 4.5%, transparent) 1px, transparent 1px);
  background-size: 38px 38px;
  -webkit-mask-image: radial-gradient(700px 440px at 50% 50%, #000 22%, transparent 74%);
  mask-image: radial-gradient(700px 440px at 50% 50%, #000 22%, transparent 74%);
}
.wb-root > * {
  position: relative;
  z-index: 2;
}

/* 顶部状态条 */
.wb-strip {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.wb-stat {
  flex: 1;
  min-width: 92px;
  display: flex;
  flex-direction: column;
  gap: 3px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-card);
  padding: 9px 13px;
}
.wb-stat .lb {
  font-size: 10px;
  color: var(--text-dim);
}
.wb-stat .lb b {
  color: var(--text);
}
.wb-stat .big {
  font-size: 20px;
  font-weight: 700;
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
}
.big.up {
  color: var(--up);
}
.big.down {
  color: var(--down);
}
.mood-card {
  flex: 1.7;
  gap: 7px;
}
.mood-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.mood-num {
  font-size: 11px;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}
.mood-bar {
  position: relative;
  height: 8px;
  border-radius: 5px;
  background: linear-gradient(90deg, var(--down), var(--flat) 50%, var(--up));
}
.mood-bar i {
  position: absolute;
  top: -4px;
  width: 4px;
  height: 16px;
  border-radius: 2px;
  background: #fff;
  transform: translateX(-50%);
  box-shadow: 0 0 6px rgba(255, 255, 255, 0.7);
}

/* 中部品牌 */
.wb-mid {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}
.wb-logo {
  width: 66px;
  height: 66px;
  border-radius: 19px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 25px;
  font-weight: 700;
  color: #1a1a1a;
  background: linear-gradient(135deg, #e8c66a, #c8992e);
  box-shadow: 0 10px 30px rgba(212, 175, 55, 0.42);
  margin-bottom: 18px;
}
.wb-mid h1 {
  font-size: 23px;
  font-weight: 700;
  margin: 0 0 8px;
}
.wb-mid p {
  font-size: 13px;
  color: var(--text-dim);
  margin: 0;
}

/* 底部快捷入口 */
.wb-quick {
  flex: none;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(96px, 1fr));
  gap: 10px;
}
.q-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 12px 4px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-card);
  color: var(--text-dim);
  font-size: 11px;
  cursor: pointer;
  transition: transform 0.15s, border-color 0.15s, color 0.15s;
}
.q-btn .qi {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  background: var(--bg-hover);
  display: flex;
  align-items: center;
  justify-content: center;
}
.q-btn .qi svg {
  width: 16px;
  height: 16px;
}
.q-btn:hover {
  border-color: var(--blue);
  color: var(--text);
  transform: translateY(-2px);
}
.q-btn:hover .qi {
  color: var(--blue);
}
</style>
