<script setup lang="ts">
// P1-1 / P1-2 多源对账守卫（全局常驻）：
// 券商 UI 实读持仓与本地「快照 + 成交流水」不符时，顶部琥珀横幅列差异，
// 已暂停自动执行（run_loop 跳过）；以券商为唯一事实源，重新校准后恢复。
import { computed, ref, onMounted, onBeforeUnmount } from "vue";
import { listen, emit, type UnlistenFn } from "@tauri-apps/api/event";
import {
  brokerReconRecalibrate,
  brokerReconStatus,
  type ReconReport,
  type ReconStatus,
} from "../broker/api";
import { reconChip } from "../broker/reconChip";

// 冲突横幅只关心未匹配报告；chip 需要完整状态（含正常报告 / 后端冲突标记）。
const report = ref<ReconReport | null>(null);
const status = ref<ReconStatus | null>(null);
const now = ref(Date.now());
const chip = computed(() => reconChip(status.value, now.value));
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
    clearConflict();
  } catch (e) {
    console.error("[recon] recalibrate", e);
  } finally {
    busy.value = false;
  }
}

/** 挂载时拉一次后端状态：chip 常驻需要完整报告与冲突标记，不能只依赖事件。 */
async function loadStatus() {
  try {
    const s = await brokerReconStatus();
    // `conflict` 是后端当前冲突态；人工校准后旧报告仍在内存，未匹配但 conflict=false 视为已校准，
    // 归一成「无报告」等待下一次对账，避免重挂载后误报「账实不符」。
    const rep = s?.report && (s.report.matched || s.conflict) ? s.report : null;
    status.value = s ? { ...s, report: rep } : null;
    // 仅在仍处于冲突态时恢复横幅：已人工校准（conflict=false）的旧报告不再弹横幅。
    report.value = s?.conflict && rep && !rep.matched ? rep : null;
  } catch (e) {
    // 浏览器 dev / 旧后端没有该命令时保持「未对账」，不打断其它横幅。
    console.error("[recon] status", e);
  }
}

/** 人工校准 / 后端通知已解除冲突：横幅收起，chip 回到「未对账」等待下一次报告。 */
function clearConflict() {
  report.value = null;
  status.value = status.value ? { ...status.value, conflict: false, report: null } : null;
}

let un: UnlistenFn[] = [];
let clock = 0;
onMounted(() => {
  void loadStatus();
  clock = window.setInterval(() => { now.value = Date.now(); }, 30_000);
  listen<ReconReport>("broker:recon", (ev) => {
    const r = ev.payload;
    // e2e fake / 旧后端可能推空对象：没有 matched 的报告不参与 chip。
    if (!r || typeof r.matched !== "boolean") return;
    status.value = {
      conflict: !r.matched,
      connected: status.value?.connected ?? false,
      kind: r.kind || status.value?.kind || "",
      report: r,
    };
    report.value = r.matched ? null : r;
  }).then((u) => un.push(u));
  listen("broker:recon_resolved", clearConflict).then((u) => un.push(u));
});
onBeforeUnmount(() => {
  un.forEach((u) => u());
  window.clearInterval(clock);
});
</script>

<template>
  <!-- P2-a 对账状态常驻：正常 / 冲突 / 未对账都可见，点击打开券商控制台。 -->
  <button
    type="button"
    class="rg-chip"
    :class="`tone-${chip.tone}`"
    data-testid="recon-chip"
    title="点击打开同花顺控制台核对对账状态"
    @click="openBrokerConsole"
  >
    <span class="rg-chip-dot"></span>
    {{ chip.label }}
  </button>

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
/* P2-a 常驻 chip：固定右下角，低于添加卡片菜单 / 弹窗层级，不遮挡交互。 */
.rg-chip {
  position: fixed; right: 12px; bottom: 12px; z-index: 60;
  display: inline-flex; align-items: center; gap: 6px;
  padding: 5px 10px; border-radius: 999px;
  font-family: inherit; font-size: 11px; font-weight: 600;
  color: var(--text-dim); background: rgba(12, 15, 21, .88);
  border: 1px solid var(--border); cursor: pointer;
  backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
  box-shadow: 0 6px 18px rgba(0, 0, 0, .35);
}
.rg-chip:hover { filter: brightness(1.15); }
.rg-chip-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; opacity: .9; }
.rg-chip.tone-ok { color: #3dd68a; border-color: rgba(61, 214, 138, .45); }
.rg-chip.tone-bad { color: #ff8a8a; border-color: rgba(255, 90, 106, .6); }
.rg-chip.tone-bad .rg-chip-dot { animation: rg-chip-blink 1s infinite; }
.rg-chip.tone-muted { color: var(--text-dim); }
@keyframes rg-chip-blink { 50% { opacity: .25; } }
</style>
