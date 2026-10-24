<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, inject, ref } from "vue";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  startRadar,
  fetchRadarSnapshot,
  fetchIndexQuotes,
} from "../api/market";
import type { RadarData } from "../api/market";
import type { Quote } from "../api/types";
import { DOCK_GROUPS, ALL } from "../lib/dock";
import type { CardId } from "../composables/useWorkbench";

const bench = inject<any>("workbench");

// 常用功能：6 个最高频入口（横向磁贴，与方案 C mock 一致）
const PICKS: CardId[] = [
  "watch",    // 自选
  "radar",    // 涨停雷达
  "spider",   // 短线精灵
  "news",     // 快讯
  "alert",    // 预警
  "ai",       // AI 问数
];
const pickItems = computed(() => PICKS.map((id) => ALL[id]));

// 全部功能：按分组流式文字链接
const groups = DOCK_GROUPS;

function open(id: CardId) {
  bench?.open(id);
}

// ===== 情绪 Hero：radar 数据流（复用 LimitRadar 的订阅模式） =====
const radar = ref<RadarData | null>(null);
let un: UnlistenFn[] = [];

const sentiment = computed(() => radar.value?.sentiment ?? null);
const limitUp = computed(() => radar.value?.limitUp ?? 0);
const broken = computed(() => radar.value?.broken ?? 0);

// 情绪标签：<20 过冷 / 20-40 偏冷 / 40-60 中性 / 60-80 偏暖 / >80 过热
const moodLabel = computed(() => {
  const s = sentiment.value;
  if (s == null) return "—";
  if (s < 20) return "情绪冰点";
  if (s < 40) return "情绪偏冷";
  if (s < 60) return "情绪中性";
  if (s < 80) return "情绪偏暖";
  return "情绪过热";
});
// gauge 颜色：冷绿 → 暖金 → 热红
const gaugeColor = computed(() => {
  const s = sentiment.value ?? 50;
  if (s < 40) return "#4ecb8d";
  if (s < 80) return "#e8c878";
  return "#e5534b";
});
// 半圆 gauge：半径 65，弧长 = π × r
const GAUGE_R = 65;
const GAUGE_LEN = Math.PI * GAUGE_R;
const gaugeDash = computed(() => {
  const s = sentiment.value ?? 0;
  const f = Math.max(0, Math.min(1, s / 100));
  return `${(GAUGE_LEN * f).toFixed(1)} ${GAUGE_LEN.toFixed(1)}`;
});
// 指针端点（沿弧旋转）：SVG 坐标 (10,85) 为左端点，圆心 (75,85)，半径 65
const gaugeDot = computed(() => {
  const s = sentiment.value ?? 0;
  const f = Math.max(0, Math.min(1, s / 100));
  // 从左端点（180°）顺时针扫到右端点（0°）
  const angle = Math.PI * (1 - f); // 弧度，π→0
  const cx = 75, cy = 85, r = 65;
  return {
    x: cx + r * Math.cos(angle),
    y: cy - r * Math.sin(angle),
  };
});

// ===== 三大指数 =====
const indices = ref<Quote[]>([]);
let idxTimer: number | null = null;
async function refreshIndices() {
  try {
    const data = await fetchIndexQuotes();
    if (data.length) indices.value = data.slice(0, 3);
  } catch { /* 静默 */ }
}

onMounted(async () => {
  // 情绪：先快照，再订阅推流
  try {
    const snap = await fetchRadarSnapshot();
    if (snap) radar.value = snap;
  } catch { /* 静默 */ }
  try {
    un.push(await listen<RadarData>("radar:data", (e) => {
      radar.value = e.payload;
    }));
  } catch { /* 静默 */ }
  try { await startRadar(); } catch { /* 静默 */ }

  // 指数：3s 轮询
  await refreshIndices();
  idxTimer = window.setInterval(refreshIndices, 3000);
});

onBeforeUnmount(() => {
  un.forEach((fn) => { try { fn(); } catch { /* 静默 */ } });
  un = [];
  if (idxTimer != null) clearInterval(idxTimer);
});
</script>

<template>
  <div class="wb-root">
    <div class="wb-mask"></div>

    <!-- ===== 情绪 Hero ===== -->
    <section class="hero">
      <div class="gauge">
        <svg viewBox="0 0 150 90">
          <!-- 底弧 -->
          <path
            d="M10 85 A65 65 0 0 1 140 85"
            fill="none" stroke="#2a2414" stroke-width="10" stroke-linecap="round"
          />
          <!-- 数值弧 -->
          <path
            d="M10 85 A65 65 0 0 1 140 85"
            fill="none" :stroke="gaugeColor" stroke-width="10" stroke-linecap="round"
            :stroke-dasharray="gaugeDash"
            style="transition: stroke-dasharray .6s ease, stroke .4s ease"
          />
          <!-- 指针端点 -->
          <circle
            :cx="gaugeDot.x" :cy="gaugeDot.y" r="6"
            :fill="gaugeColor"
            style="transition: cx .6s ease, cy .6s ease, fill .4s ease"
          />
        </svg>
      </div>

      <div class="hero-txt">
        <div class="mood">
          <span class="mood-num">{{ sentiment ?? "—" }}</span>
          <span class="mood-tag">{{ moodLabel }}</span>
        </div>
        <div class="mood-sub">
          涨停 <b>{{ limitUp }}</b> 家 · 炸板 <b>{{ broken }}</b> 家
        </div>
        <div class="mood-desc">
          市场情绪实时采样自涨停雷达。开盘 30 分钟为情绪确认窗口；
          情绪过热（&gt;80）或过冷（&lt;20）时自动提示风险。
        </div>
      </div>

      <div class="hero-idx">
        <div v-for="q in indices" :key="q.code" class="idx" :class="q.pct > 0.001 ? 'up' : q.pct < -0.001 ? 'down' : 'flat'">
          <div class="idx-n">{{ q.name }}</div>
          <div class="idx-v">
            {{ q.price.toFixed(2) }}
            <span class="idx-pct">{{ q.pct > 0 ? "+" : "" }}{{ q.pct.toFixed(2) }}%</span>
          </div>
        </div>
      </div>
    </section>

    <!-- ===== 常用功能 · 横向磁贴 ===== -->
    <div class="sec-label">常用功能</div>
    <section class="picks">
      <button
        v-for="it in pickItems"
        :key="it.id"
        type="button"
        class="pick"
        :class="{ active: bench?.isOpen(it.id) }"
        @click="open(it.id)"
      >
        <span class="pick-ic">
          <svg viewBox="0 0 24 24"><path fill="currentColor" :d="it.icon" /></svg>
        </span>
        <span class="pick-lb">{{ it.label }}</span>
        <span class="pick-ds">{{ it.desc }}</span>
      </button>
    </section>

    <!-- ===== 全部功能 · 文字链接组 ===== -->
    <div class="sec-label">全部功能</div>
    <section class="groups">
      <div v-for="g in groups" :key="g.name" class="grow">
        <div class="gn">{{ g.name }}</div>
        <div class="glinks">
          <button
            v-for="it in g.items"
            :key="it.id"
            type="button"
            class="glink"
            :class="{ opened: bench?.isOpen(it.id) }"
            @click="open(it.id)"
          >
            {{ it.label }}<i v-if="it.star" class="gstar">★</i>
          </button>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.wb-root {
  position: absolute;
  inset: 0;
  z-index: 0;
  display: flex;
  flex-direction: column;
  padding: 24px 36px 28px;
  overflow: hidden;
  color: var(--text);
  background:
    radial-gradient(ellipse at top, rgba(232, 200, 120, .06), transparent 60%),
    var(--bg);
}
.wb-mask {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.wb-root > * { position: relative; z-index: 2; }

/* ============ 情绪 Hero ============ */
.hero {
  flex: none;
  display: flex;
  align-items: center;
  gap: 36px;
  padding: 18px 28px;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 14px;
}
.gauge {
  width: 150px;
  height: 90px;
  flex: none;
}
.gauge svg { width: 100%; height: 100%; display: block; }

.hero-txt { flex: 1; min-width: 0; }
.mood {
  display: flex;
  align-items: baseline;
  gap: 10px;
}
.mood-num {
  font-size: 32px;
  font-weight: 700;
  color: var(--gold);
  line-height: 1;
  font-variant-numeric: tabular-nums;
}
.mood-tag {
  font-size: 13px;
  color: var(--text-dim);
  font-weight: 500;
  letter-spacing: 1px;
}
.mood-sub {
  margin-top: 6px;
  font-size: 12px;
  color: var(--text-dim);
}
.mood-sub b {
  color: var(--text);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.mood-desc {
  margin-top: 8px;
  font-size: 11.5px;
  color: var(--text-dim);
  line-height: 1.6;
  max-width: 520px;
}

.hero-idx {
  display: flex;
  gap: 24px;
  flex: none;
}
.idx { text-align: right; }
.idx-n {
  font-size: 11px;
  color: var(--text-dim);
}
.idx-v {
  font-size: 15px;
  font-weight: 600;
  margin-top: 2px;
  font-variant-numeric: tabular-nums;
}
.idx-pct {
  font-size: 11px;
  margin-left: 4px;
  opacity: .95;
}
.idx.up .idx-v { color: var(--red); }
.idx.down .idx-v { color: var(--green); }
.idx.flat .idx-v { color: var(--text); }

/* ============ 小节标题 ============ */
.sec-label {
  margin: 20px 0 10px;
  font-size: 10px;
  color: var(--gold);
  letter-spacing: 2px;
  font-weight: 600;
  flex: none;
}

/* ============ 常用功能 · 横向磁贴 ============ */
.picks {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 10px;
  flex: none;
}
.pick {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  padding: 14px 14px 12px;
  border-radius: 10px;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  cursor: pointer;
  text-align: left;
  transition: transform .15s, border-color .15s, background .15s;
  color: var(--text);
  font: inherit;
}
.pick:hover {
  border-color: var(--gold);
  background: rgba(232, 200, 120, .05);
  transform: translateY(-2px);
}
.pick.active {
  border-color: var(--gold);
  background: rgba(232, 200, 120, .08);
}
.pick-ic {
  width: 22px;
  height: 22px;
  color: var(--gold);
  display: flex;
}
.pick-ic svg { width: 22px; height: 22px; }
.pick-lb {
  font-size: 13px;
  font-weight: 500;
}
.pick-ds {
  font-size: 10.5px;
  color: var(--text-dim);
  line-height: 1.4;
}

/* ============ 全部功能 · 文字链接组 ============ */
.groups {
  flex: 1;
  overflow-y: auto;
  margin-top: 4px;
  padding-right: 4px;
}
.grow {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  padding: 10px 4px;
  border-bottom: 1px dashed var(--border);
}
.gn {
  font-size: 11px;
  color: var(--gold);
  font-weight: 600;
  letter-spacing: 1px;
  width: 90px;
  flex: none;
  padding-top: 2px;
}
.glinks {
  flex: 1;
  display: flex;
  flex-wrap: wrap;
  gap: 4px 20px;
}
.glink {
  background: transparent;
  border: 0;
  padding: 3px 0;
  font: inherit;
  font-size: 12.5px;
  color: var(--text);
  cursor: pointer;
  text-align: left;
  transition: color .12s;
}
.glink:hover { color: var(--gold); }
.glink.opened { color: var(--gold); }
.gstar {
  font-style: normal;
  color: var(--gold);
  font-size: 9px;
  margin-left: 3px;
}

/* 窄屏适配 */
@media (max-width: 1100px) {
  .picks { grid-template-columns: repeat(3, 1fr); }
  .hero-idx { gap: 16px; }
}
@media (max-width: 780px) {
  .wb-root { padding: 16px 16px 20px; }
  .hero { flex-wrap: wrap; gap: 18px; padding: 14px 16px; }
  .hero-idx { width: 100%; justify-content: space-between; }
  .picks { grid-template-columns: repeat(2, 1fr); }
  .grow { flex-direction: column; gap: 6px; }
  .gn { width: auto; }
}
</style>
