<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount, nextTick } from "vue";
import { invoke } from "@tauri-apps/api/core";
import type { TradeTick } from "../api/types";

const props = defineProps<{ code: string | null }>();

const tape = ref<TradeTick[]>([]);
const seen = new Set<string>();
const scrollEl = ref<HTMLElement | null>(null);
let autoScroll = true;
let timer: number | null = null;
const errMsg = ref("");

const keyOf = (t: TradeTick) => `${t.time}|${t.price}|${t.vol}|${t.side}`;

// 外盘（主动买）/ 内盘（主动卖）统计
const stats = ref({ buy: 0, sell: 0, net: 0 });
function recalc() {
  let buy = 0,
    sell = 0;
  for (const t of tape.value) {
    if (t.side === "buy") buy += t.vol;
    else if (t.side === "sell") sell += t.vol;
  }
  stats.value = { buy, sell, net: buy - sell };
}

async function load() {
  if (!props.code) {
    tape.value = [];
    seen.clear();
    errMsg.value = "";
    recalc();
    return;
  }
  try {
    const rows = await invoke<TradeTick[]>("get_trades", { code: props.code, n: 80 });
    let added = false;
    for (const r of rows) {
      const k = keyOf(r);
      if (!seen.has(k)) {
        seen.add(k);
        tape.value.push(r);
        added = true;
      }
    }
    // 最多保留 300 条，防止无限增长
    if (tape.value.length > 300) {
      tape.value.splice(0, tape.value.length - 300);
      seen.clear();
      tape.value.forEach((t) => seen.add(keyOf(t)));
    }
    errMsg.value = "";
    if (added) {
      recalc();
      if (autoScroll) {
        await nextTick();
        scrollToBottom();
      }
    }
  } catch (e) {
    errMsg.value = String(e).slice(0, 40);
  }
}

function scrollToBottom() {
  const el = scrollEl.value;
  if (el) el.scrollTop = el.scrollHeight;
}
function onScroll() {
  const el = scrollEl.value;
  if (!el) return;
  autoScroll = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
}

watch(
  () => props.code,
  () => {
    tape.value = [];
    seen.clear();
    autoScroll = true;
    recalc();
    load();
  }
);
onMounted(() => {
  load();
  timer = window.setInterval(load, 4000);
});
onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
});
</script>

<template>
  <div class="tape-wrap">
    <div v-if="code" class="tape-head">
      <div class="st">
        <span class="lab">外盘</span>
        <span class="val up">{{ stats.buy }}手</span>
      </div>
      <div class="st">
        <span class="lab">内盘</span>
        <span class="val down">{{ stats.sell }}手</span>
      </div>
      <div class="st">
        <span class="lab">净量</span>
        <span class="val" :class="stats.net >= 0 ? 'up' : 'down'">
          {{ stats.net >= 0 ? "+" : "" }}{{ stats.net }}
        </span>
      </div>
    </div>

    <div ref="scrollEl" class="tape-list" @scroll="onScroll">
      <div v-if="!code" class="tip">选择一只股票查看逐笔成交</div>
      <div v-else-if="errMsg && !tape.length" class="tip">{{ errMsg }}</div>
      <div v-for="(t, i) in tape" :key="i" class="trow" :class="t.side">
        <span class="tm">{{ t.time }}</span>
        <span class="pr">{{ t.price.toFixed(2) }}</span>
        <span class="vl">{{ t.vol }}</span>
        <span class="sd">
          <span class="arrow">{{ t.side === "buy" ? "B" : t.side === "sell" ? "S" : "—" }}</span>
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tape-wrap {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.tape-head {
  display: flex;
  gap: 6px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
}
.st {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
}
.st .lab {
  font-size: 10px;
  color: var(--text-dim);
}
.st .val {
  font-size: 12px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.tape-list {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}
.tip {
  color: var(--text-dim);
  text-align: center;
  padding: 24px 0;
  font-size: 12px;
}
.trow {
  display: grid;
  grid-template-columns: 1.15fr 1fr 0.75fr 0.5fr;
  align-items: center;
  padding: 1px 10px;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.tm {
  color: var(--text-dim);
}
.pr {
  text-align: right;
}
.vl {
  text-align: right;
  color: var(--text-dim);
}
.sd {
  text-align: center;
}
.arrow {
  display: inline-block;
  width: 16px;
  height: 16px;
  line-height: 16px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 700;
}
.trow.buy {
  background: color-mix(in srgb, var(--up) 5%, transparent);
}
.trow.sell {
  background: color-mix(in srgb, var(--down) 5%, transparent);
}
.trow.buy .pr {
  color: var(--up);
}
.trow.sell .pr {
  color: var(--down);
}
.trow.neutral .pr {
  color: var(--text);
}
.trow.neutral .arrow {
  color: var(--text-dim);
}
.trow.buy .arrow {
  background: color-mix(in srgb, var(--up) 18%, transparent);
  color: var(--up);
}
.trow.sell .arrow {
  background: color-mix(in srgb, var(--down) 18%, transparent);
  color: var(--down);
}
.up {
  color: var(--up);
}
.down {
  color: var(--down);
}
</style>
