<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import MultiCell from "./MultiCell.vue";
import { useWatchlistStore } from "../stores/watchlist";
import { signalList } from "../ai/api";
import { coList } from "../broker/co";

const emit = defineEmits<{ select: [code: string] }>();
const wl = useWatchlistStore();

const view = ref<"m" | "k" | "o">("m");
const layout = ref<2 | 3>(3); // 2×2 / 3×3
const source = ref<"watch" | "signal" | "manual">("watch");
const link = ref(false); // 联动十字
const manualText = ref("");

// 信号 & 条件单相关 code（待确认信号 + 进行中条件单，去重）
const signalCodes = ref<string[]>([]);
async function loadSignalCodes() {
  try {
    const [sigs, cos] = await Promise.all([
      signalList("pending", 30).catch(() => []),
      coList("active", 30).catch(() => []),
    ]);
    const set = new Set<string>();
    for (const s of sigs) if (s.code) set.add(s.code);
    for (const c of cos) if (c.code) set.add(c.code);
    signalCodes.value = [...set];
  } catch {
    /* ignore */
  }
}

const manualCodes = computed(() =>
  manualText.value
    .split(/[\s,，、;；]+/)
    .map((s) => s.trim())
    .filter(Boolean),
);

const codes = computed(() => {
  const n = layout.value * layout.value;
  let base: string[] = [];
  if (source.value === "watch") base = wl.codes;
  else if (source.value === "signal") base = signalCodes.value;
  else base = manualCodes.value;
  return base.slice(0, n);
});

const gridStyle = computed(() => ({
  gridTemplateColumns: `repeat(${layout.value}, 1fr)`,
}));

onMounted(() => {
  void wl.load();
  void loadSignalCodes();
});
watch(source, (s) => {
  if (s === "signal") void loadSignalCodes();
});
</script>

<template>
  <div class="mg">
    <div class="mg-bar">
      <span class="ttl">多股同列</span>
      <div class="seg">
        <button :class="{ on: layout === 2 }" @click="layout = 2">2×2</button>
        <button :class="{ on: layout === 3 }" @click="layout = 3">3×3</button>
      </div>
      <div class="seg">
        <button :class="{ on: source === 'watch' }" @click="source = 'watch'">自选</button>
        <button :class="{ on: source === 'signal' }" @click="source = 'signal'">信号/条件单</button>
        <button :class="{ on: source === 'manual' }" @click="source = 'manual'">手动</button>
      </div>
      <div class="tabs">
        <button :class="{ on: view === 'm' }" @click="view = 'm'">分时</button>
        <button :class="{ on: view === 'k' }" @click="view = 'k'">日K</button>
        <button :class="{ on: view === 'o' }" @click="view = 'o'">五档</button>
      </div>
      <label class="link-lab" title="开启后多格时间轴竖线联动">
        <input v-model="link" type="checkbox" /> 联动
      </label>
    </div>

    <div v-if="source === 'manual'" class="manual-bar">
      <input
        v-model="manualText" class="manual-inp"
        placeholder="输入代码，空格/逗号分隔，如 600519 000001 300750"
      />
    </div>

    <div class="mg-grid" :style="gridStyle">
      <MultiCell
        v-for="c in codes" :key="c" :code="c" :view="view" :link="link"
        @select="(v) => emit('select', v)"
      />
    </div>
    <div v-if="codes.length === 0" class="empty">
      {{
        source === "manual"
          ? "请在上方输入代码"
          : source === "signal"
            ? "暂无待确认信号 / 进行中条件单"
            : "自选股为空，请先添加股票"
      }}
    </div>
  </div>
</template>

<style scoped>
.mg { display:flex;flex-direction:column;height:100%;min-height:0;gap:9px; }
.mg-bar { display:flex;align-items:center;gap:8px;flex-shrink:0;flex-wrap:wrap; }
.ttl { font-size:13px;font-weight:800; }
.seg,.tabs { display:flex;padding:3px;border-radius:10px;background:rgba(0,0,0,.25);border:1px solid var(--border); }
.seg button,.tabs button { font-size:11px;font-weight:600;color:var(--text-dim);padding:5px 11px;border-radius:8px;border:0;background:transparent;cursor:pointer;transition:.16s; }
.seg button:hover,.tabs button:hover { color:var(--text); }
.seg button.on,.tabs button.on { color:#fff;background:linear-gradient(180deg,#36b8e8,#1d8fc0); }
.link-lab { margin-left:auto;display:flex;align-items:center;gap:4px;font-size:10.5px;color:var(--text-dim);cursor:pointer; }
.manual-bar { flex-shrink:0; }
.manual-inp { width:100%;box-sizing:border-box;background:var(--bg-input,transparent);border:1px solid var(--border);color:var(--text);
  border-radius:8px;padding:6px 10px;font-size:11.5px; }
.mg-grid { flex:1;min-height:0;display:grid;grid-auto-rows:1fr;gap:9px; }
.empty { flex:1;display:flex;align-items:center;justify-content:center;color:var(--text-dim);font-size:12px; }
</style>
