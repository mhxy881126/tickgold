<script setup lang="ts">
import { ref, reactive } from "vue";
import { fetchScreener } from "../api/market";
import type { ScreenFilter, ScreenResult } from "../api/types";

const emit = defineEmits<{ (e: "select", code: string): void }>();

// ===== 条件状态 =====
type RangeKey = "price" | "pct" | "turnover" | "vr" | "amp" | "pe" | "pb" | "mcap";
const ranges = reactive<Record<RangeKey, [string, string]>>({
  price: ["", ""],
  pct: ["", ""],
  turnover: ["", ""],
  vr: ["", ""],
  amp: ["", ""],
  pe: ["", ""],
  pb: ["", ""],
  mcap: ["", ""],
});
const tech = reactive({
  maBull: false,
  macdGolden: false,
  volumeUp: false,
  breakout: false,
  aboveMa20: false,
});

const RANGE_FIELDS: { key: RangeKey; label: string }[] = [
  { key: "price", label: "最新价" },
  { key: "pct", label: "涨跌幅 %" },
  { key: "turnover", label: "换手率 %" },
  { key: "vr", label: "量比" },
  { key: "amp", label: "振幅 %" },
  { key: "pe", label: "市盈率" },
  { key: "pb", label: "市净率" },
  { key: "mcap", label: "流通市值 亿" },
];
const TECH_FIELDS: { key: keyof typeof tech; label: string }[] = [
  { key: "maBull", label: "均线多头排列" },
  { key: "macdGolden", label: "MACD 金叉" },
  { key: "volumeUp", label: "放量上涨" },
  { key: "breakout", label: "突破新高" },
  { key: "aboveMa20", label: "站上20日线" },
];

// ===== 预设方案 =====
function clearAll() {
  (Object.keys(ranges) as RangeKey[]).forEach((k) => {
    ranges[k] = ["", ""];
  });
  (Object.keys(tech) as (keyof typeof tech)[]).forEach((k) => (tech[k] = false));
}
function setRange(k: RangeKey, lo: string | number, hi: string | number = "") {
  ranges[k] = [String(lo), String(hi)];
}
const PRESETS: { name: string; apply: () => void }[] = [
  {
    name: "均线多头",
    apply: () => {
      clearAll();
      tech.maBull = true;
      tech.aboveMa20 = true;
    },
  },
  {
    name: "MACD金叉",
    apply: () => {
      clearAll();
      tech.macdGolden = true;
    },
  },
  {
    name: "放量突破",
    apply: () => {
      clearAll();
      tech.volumeUp = true;
      tech.breakout = true;
    },
  },
  {
    name: "当日强势",
    apply: () => {
      clearAll();
      setRange("pct", 3);
      setRange("turnover", 3);
      setRange("vr", 1.5);
    },
  },
  {
    name: "低估值",
    apply: () => {
      clearAll();
      setRange("pe", 0, 20);
      setRange("pb", 0, 3);
    },
  },
  {
    name: "大盘蓝筹",
    apply: () => {
      clearAll();
      setRange("mcap", 500);
      setRange("pe", 0, 30);
    },
  },
];

// ===== 构建过滤器并执行 =====
function num(s: string): number | null {
  if (s.trim() === "") return null;
  const v = parseFloat(s);
  return isNaN(v) ? null : v;
}
function pair(k: RangeKey): [number | null, number | null] {
  return [num(ranges[k][0]), num(ranges[k][1])];
}
function buildFilter(): ScreenFilter {
  const [priceMin, priceMax] = pair("price");
  const [pctMin, pctMax] = pair("pct");
  const [turnoverMin, turnoverMax] = pair("turnover");
  const [vrMin, vrMax] = pair("vr");
  const [ampMin, ampMax] = pair("amp");
  const [peMin, peMax] = pair("pe");
  const [pbMin, pbMax] = pair("pb");
  const [mcapMin, mcapMax] = pair("mcap");
  return {
    priceMin, priceMax, pctMin, pctMax, turnoverMin, turnoverMax,
    vrMin, vrMax, ampMin, ampMax, peMin, peMax, pbMin, pbMax,
    mcapMin, mcapMax,
    maBull: tech.maBull,
    macdGolden: tech.macdGolden,
    volumeUp: tech.volumeUp,
    breakout: tech.breakout,
    aboveMa20: tech.aboveMa20,
    limit: 80,
  };
}

const loading = ref(false);
const error = ref("");
const results = ref<ScreenResult[]>([]);

async function run() {
  loading.value = true;
  error.value = "";
  results.value = [];
  try {
    results.value = await fetchScreener(buildFilter());
  } catch (e) {
    error.value = String(e);
  } finally {
    loading.value = false;
  }
}

function pctText(n: number): string {
  return (n > 0 ? "+" : "") + n.toFixed(2);
}
</script>

<template>
  <div class="screener">
    <!-- 预设方案 -->
    <div class="presets">
      <button v-for="p in PRESETS" :key="p.name" @click="p.apply">{{ p.name }}</button>
      <button class="reset" @click="clearAll">重置</button>
    </div>

    <div class="body">
      <!-- 条件面板 -->
      <aside class="panel">
        <div class="group-title">技术形态</div>
        <label v-for="t in TECH_FIELDS" :key="t.key" class="check">
          <input type="checkbox" v-model="tech[t.key]" />
          <span class="box"></span>
          <span>{{ t.label }}</span>
        </label>

        <div class="group-title">行情 / 基本面区间</div>
        <div v-for="f in RANGE_FIELDS" :key="f.key" class="range">
          <span class="r-label">{{ f.label }}</span>
          <input type="number" v-model="ranges[f.key][0]" placeholder="最小" />
          <span class="dash">~</span>
          <input type="number" v-model="ranges[f.key][1]" placeholder="最大" />
        </div>
      </aside>

      <!-- 结果区 -->
      <section class="result">
        <div class="result-bar">
          <button class="run-btn" :disabled="loading" @click="run">
            {{ loading ? "筛选中…" : "开始选股" }}
          </button>
          <span v-if="results.length" class="count">共 {{ results.length }} 只</span>
        </div>

        <div class="thead">
          <div class="c-name">名称</div>
          <div class="c-price">最新价</div>
          <div class="c-pct">涨跌幅</div>
          <div class="c-turn">换手</div>
          <div class="c-vr">量比</div>
          <div class="c-mv">流通亿</div>
          <div class="c-sig">信号</div>
        </div>
        <div class="tbody">
          <div v-if="loading" class="hint">
            <span class="spin"></span> 正在拉取行情并做技术分析，请稍候…
          </div>
          <div v-else-if="error" class="hint err">{{ error }}</div>
          <div v-else-if="results.length === 0" class="hint">设置条件后点击「开始选股」</div>
          <div
            v-for="r in results"
            :key="r.code"
            class="trow"
            @click="emit('select', r.code)"
          >
            <div class="c-name">
              <span class="nm">{{ r.name }}</span>
              <span class="cd">{{ r.code }}</span>
            </div>
            <div class="c-price">{{ r.price.toFixed(2) }}</div>
            <div class="c-pct" :class="r.pct > 0 ? 'up' : r.pct < 0 ? 'down' : ''">
              {{ pctText(r.pct) }}%
            </div>
            <div class="c-turn">{{ r.turnover.toFixed(1) }}</div>
            <div class="c-vr">{{ r.volumeRatio.toFixed(2) }}</div>
            <div class="c-mv">{{ r.circMv.toFixed(0) }}</div>
            <div class="c-sig">
              <span v-for="s in r.signals" :key="s" class="tag">{{ s }}</span>
            </div>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.screener {
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 8px 10px 10px;
  overflow: hidden;
}

/* 预设 */
.presets {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-bottom: 8px;
}
.presets button {
  background: transparent;
  border: 1px solid #2a323d;
  color: var(--text-dim);
  font-size: 11px;
  padding: 3px 10px;
  border-radius: 5px;
  cursor: pointer;
}
.presets button:hover {
  border-color: #d4af37;
  color: #e6c860;
}
.presets .reset {
  margin-left: auto;
}

.body {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 10px;
}

/* 条件面板 */
.panel {
  width: 188px;
  flex-shrink: 0;
  overflow-y: auto;
  border-right: 1px solid #232b34;
  padding-right: 8px;
}
.group-title {
  font-size: 10px;
  color: var(--text-dim);
  margin: 8px 0 5px;
  letter-spacing: 1px;
}
.group-title:first-child {
  margin-top: 0;
}
.check {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 11.5px;
  padding: 3px 0;
  cursor: pointer;
}
.check input {
  display: none;
}
.box {
  width: 13px;
  height: 13px;
  border: 1px solid #3a4450;
  border-radius: 3px;
  position: relative;
  flex-shrink: 0;
}
.check input:checked + .box {
  background: #d4af37;
  border-color: #d4af37;
}
.check input:checked + .box::after {
  content: "";
  position: absolute;
  left: 3.5px;
  top: 1px;
  width: 4px;
  height: 7px;
  border: solid #1a1408;
  border-width: 0 2px 2px 0;
  transform: rotate(45deg);
}
.range {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 4px;
}
.r-label {
  font-size: 10.5px;
  color: var(--text-dim);
  width: 60px;
  flex-shrink: 0;
}
.range input {
  width: 46px;
  background: #141a21;
  border: 1px solid #2a323d;
  border-radius: 4px;
  color: var(--text);
  font-size: 10.5px;
  padding: 3px 4px;
}
.dash {
  color: #555;
  font-size: 10px;
}

/* 结果区 */
.result {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.result-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 7px;
}
.run-btn {
  background: linear-gradient(135deg, #d4af37, #b8941f);
  color: #1a1408;
  border: none;
  font-size: 12px;
  font-weight: 700;
  padding: 5px 20px;
  border-radius: 6px;
  cursor: pointer;
}
.run-btn:disabled {
  opacity: 0.6;
  cursor: default;
}
.count {
  font-size: 11px;
  color: var(--text-dim);
}

.thead,
.trow {
  display: grid;
  grid-template-columns: 24% 12% 13% 10% 10% 11% 20%;
  align-items: center;
}
.thead {
  font-size: 10px;
  color: var(--text-dim);
  padding: 4px 6px;
  border-bottom: 1px solid #232b34;
}
.tbody {
  flex: 1;
  overflow-y: auto;
}
.trow {
  font-size: 11px;
  padding: 4px 6px;
  border-bottom: 1px solid #1b222a;
  cursor: pointer;
}
.trow:hover {
  background: rgba(212, 175, 55, 0.06);
}
.c-name {
  display: flex;
  flex-direction: column;
}
.nm {
  font-size: 11.5px;
}
.cd {
  font-size: 9.5px;
  color: var(--text-dim);
}
.c-price,
.c-pct,
.c-turn,
.c-vr,
.c-mv {
  font-variant-numeric: tabular-nums;
}
.c-pct {
  font-weight: 600;
}
.c-sig {
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
}
.tag {
  font-size: 9px;
  color: #e6c860;
  background: rgba(212, 175, 55, 0.12);
  border: 1px solid rgba(212, 175, 55, 0.3);
  border-radius: 3px;
  padding: 1px 4px;
  white-space: nowrap;
}

.hint {
  padding: 40px 10px;
  text-align: center;
  color: var(--text-dim);
  font-size: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}
.hint.err {
  color: #e0556b;
}
.spin {
  width: 14px;
  height: 14px;
  border: 2px solid #333;
  border-top-color: #d4af37;
  border-radius: 50%;
  animation: rot 0.8s linear infinite;
}
@keyframes rot {
  to {
    transform: rotate(360deg);
  }
}
.up {
  color: #ef5350;
}
.down {
  color: #26a69a;
}
</style>
