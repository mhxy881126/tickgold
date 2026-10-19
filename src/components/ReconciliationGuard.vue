<script setup lang="ts">
// P1-1 / P1-2 多源对账守卫（全局常驻）：
// 券商 UI 实读持仓与本地「快照 + 成交流水」不符时，顶部琥珀横幅列差异，
// 已暂停自动执行（run_loop 跳过）；以券商为唯一事实源，重新校准后恢复。
import { ref, onMounted, onBeforeUnmount } from "vue";
import { listen, emit, type UnlistenFn } from "@tauri-apps/api/event";
import { brokerReconRecalibrate, type ReconReport } from "../broker/api";

const report = ref<ReconReport | null>(null);
const busy = ref(false);
const KIND_LABEL: Record<string, string> = {
  intraday: "即时对账",
  open: "日初对账",
  close: "日终对账",
};

function openBrokerConsole() {
  void emit("island:open-card", "brokerconsole");
}

async function recalibrate() {
  if (busy.value) return;
  busy.value = true;
  try {
    await brokerReconRecalibrate();
    report.value = null;
  } catch (e) {
    console.error("[recon] recalibrate", e);
  } finally {
    busy.value = false;
  }
}

let un: UnlistenFn[] = [];
onMounted(() => {
  listen<ReconReport>("broker:recon", (ev) => {
    const r = ev.payload;
    if (r && !r.matched) report.value = r;
    else if (r && r.matched) report.value = null;
  }).then((u) => un.push(u));
  listen("broker:recon_resolved", () => {
    report.value = null;
  }).then((u) => un.push(u));
});
onBeforeUnmount(() => un.forEach((u) => u()));
</script>

<template>
  <transition name="rg-fade">
    <div v-if="report" class="rg-bar">
      <div class="rg-main">
        <div class="rg-title">
          <span class="rg-dot"></span>
          {{ KIND_LABEL[report.kind] || "对账" }}发现账实不符 · {{ report.diffs.length }} 只股票本地与券商数据冲突，已暂停自动执行
        </div>
        <div class="rg-sub">
          券商为唯一事实源。系统已停止自动下单（人工经确认桥仍可下单），请核对后以券商持仓重新校准。
        </div>
        <div class="rg-list">
          <div v-for="d in report.diffs" :key="d.code" class="rg-row">
            <span class="rg-code">{{ d.code }}</span>
            <span class="rg-fld local">本地预期 <b>{{ d.localVol }}</b> 股</span>
            <span class="rg-arrow">→</span>
            <span class="rg-fld broker">券商实读 <b>{{ d.brokerVol }}</b> 股</span>
            <span class="rg-delta" :class="{ up: d.brokerVol > d.localVol, down: d.brokerVol < d.localVol }">
              差异 {{ d.brokerVol - d.localVol > 0 ? "+" : "" }}{{ d.brokerVol - d.localVol }}
            </span>
          </div>
        </div>
      </div>
      <div class="rg-actions">
        <button type="button" class="rg-btn" @click="openBrokerConsole">打开同花顺控制台核对</button>
        <button type="button" class="rg-btn primary" :disabled="busy" @click="recalibrate">
          {{ busy ? "校准中…" : "以券商为准，重新校准" }}
        </button>
      </div>
    </div>
  </transition>
</template>

<style scoped>
.rg-bar {
  position: fixed; top: 0; left: 0; right: 0; z-index: 1240;
  display: flex; align-items: flex-start; gap: 14px;
  padding: 10px 16px; font-size: 12px;
  background: linear-gradient(135deg, rgba(255,177,61,.18), rgba(255,177,61,.06));
  border-bottom: 1px solid rgba(255,177,61,.6);
  color: #ffe7bd; box-shadow: 0 6px 24px rgba(0,0,0,.4);
}
.rg-main { flex: 1; min-width: 0; }
.rg-title { font-weight: 700; font-size: 13px; display: flex; align-items: center; gap: 8px; }
.rg-dot { width: 9px; height: 9px; border-radius: 50%; background: #ffb13d; flex-shrink: 0; animation: rg-blink 1s infinite; }
@keyframes rg-blink { 50% { opacity: .25; } }
.rg-sub { margin-top: 3px; opacity: .85; }
.rg-list { margin-top: 8px; display: flex; flex-direction: column; gap: 4px; }
.rg-row {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 4px 8px; border-radius: 6px; background: rgba(0,0,0,.18);
}
.rg-code { font-weight: 700; font-variant-numeric: tabular-nums; }
.rg-fld { opacity: .9; font-variant-numeric: tabular-nums; }
.rg-fld b { font-size: 13px; }
.rg-fld.broker b { color: #ffd47a; }
.rg-arrow { opacity: .6; }
.rg-delta { margin-left: auto; font-weight: 700; font-variant-numeric: tabular-nums; }
.rg-delta.up { color: #3dd68a; }
.rg-delta.down { color: #ff8a8a; }
.rg-actions { display: flex; flex-direction: column; gap: 8px; flex-shrink: 0; }
.rg-btn {
  border: 1px solid rgba(255,255,255,.25); background: rgba(255,255,255,.06);
  color: inherit; font-size: 12px; font-weight: 600; border-radius: 7px;
  padding: 7px 12px; cursor: pointer; white-space: nowrap;
}
.rg-btn.primary { background: rgba(255,177,61,.22); border-color: rgba(255,177,61,.5); }
.rg-btn:disabled { opacity: .5; cursor: not-allowed; }
.rg-fade-enter-active, .rg-fade-leave-active { transition: opacity .2s; }
.rg-fade-enter-from, .rg-fade-leave-to { opacity: 0; }
</style>
