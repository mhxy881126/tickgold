<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { alertDialog } from "../composables/useDialog";
import { useAlertV2Store } from "../stores/alertV2";
import { useWatchlistStore } from "../stores/watchlist";
import type { AlertRuleV2 } from "../alert/types";
import { scopeText, countLeaves, treeSummary } from "../alert/describe";
import { navOpenScreener } from "../alert/bus";
import { ALERT_TEMPLATES } from "../lib/alertTemplates";
import AlertRuleDialog from "./alert/AlertRuleDialog.vue";

const store = useAlertV2Store();
const wl = useWatchlistStore();
const tab = ref<"rules" | "history">("rules");
const dialogOpen = ref(false);
const editing = ref<AlertRuleV2 | null>(null);

const soundOn = ref(true);
try {
  soundOn.value = localStorage.getItem("tickgold_alert_sound") !== "0";
} catch { /* ignore */ }
function toggleSound() {
  soundOn.value = !soundOn.value;
  try {
    localStorage.setItem("tickgold_alert_sound", soundOn.value ? "1" : "0");
  } catch { /* ignore */ }
}

function startNew() {
  editing.value = null;
  dialogOpen.value = true;
}
function startEdit(r: AlertRuleV2) {
  editing.value = r;
  dialogOpen.value = true;
}
async function onSave(r: AlertRuleV2) {
  await store.save(r);
}
async function applyTemplate(key: string) {
  const t = ALERT_TEMPLATES.find((x) => x.key === key);
  if (t) await store.save(t.build());
}
async function remove(r: AlertRuleV2) {
  await store.remove(r.id);
}
async function switchTab(t: "rules" | "history") {
  tab.value = t;
  if (t === "history" && !store.historyLoaded) await store.loadHistory();
}
async function clearHistory() {
  await store.clearHistory();
}

function groupName(id: number): string {
  return wl.groups.find((g) => g.id === id)?.name ?? `分组#${id}`;
}
function toScreener() {
  navOpenScreener();
}
async function toOrder() {
  // 本地条件单在 v1.4.0 提供，本版占位
  await alertDialog("本地条件单将在 v1.4.0 提供，当前可先转「条件选股」。");
}

const enabledCount = computed(() =>
  store.rules.filter((r) => r.enabled).length
);

function fmtTime(t?: number): string {
  if (!t) return "—";
  return new Date(t).toLocaleString("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}
function fmtFull(t?: number | null): string {
  if (!t) return "—";
  return new Date(t).toLocaleString("zh-CN", {
    month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

onMounted(async () => {
  if (!store.loaded) await store.load();
});
</script>

<template>
  <div class="alert-center">
    <div class="toolbar">
      <div class="tabs">
        <button class="tab" :class="{ on: tab === 'rules' }" @click="switchTab('rules')">预警规则</button>
        <button class="tab" :class="{ on: tab === 'history' }" @click="switchTab('history')">触发历史</button>
      </div>
      <template v-if="tab === 'rules'">
        <button class="btn-new" @click="startNew">＋ 新建预警</button>
        <span class="stat">启用 {{ enabledCount }} / 共 {{ store.rules.length }}</span>
      </template>
      <template v-else>
        <button class="btn-new ghost" @click="clearHistory">清空历史</button>
        <span class="stat">共 {{ store.history.length }} 条</span>
      </template>
      <label class="sound-lab" title="触发时播放提示音">
        <input type="checkbox" :checked="soundOn" @change="toggleSound" /> 提示音
      </label>
    </div>

    <!-- ===== 规则视图 ===== -->
    <template v-if="tab === 'rules'">
      <div class="tpl-bar">
        <span class="tpl-lab">模板：</span>
        <button
          v-for="t in ALERT_TEMPLATES"
          :key="t.key"
          class="tpl-btn"
          :title="t.desc"
          @click="applyTemplate(t.key)"
        >{{ t.name }}</button>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th style="width:22%">名称</th>
              <th style="width:13%">作用范围</th>
              <th style="width:37%">触发条件</th>
              <th style="width:12%">最近触发</th>
              <th style="width:7%">状态</th>
              <th style="width:9%">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in store.rules" :key="r.id" :class="{ off: !r.enabled }">
              <td class="nm-cell">
                <div class="stk-nm">{{ r.name }}</div>
                <div class="leaf-cnt">{{ countLeaves(r.tree) }} 个条件</div>
              </td>
              <td class="scope">{{ scopeText(r.scope, groupName) }}</td>
              <td class="cond">{{ treeSummary(r.tree) }}</td>
              <td class="time">{{ fmtTime(r.lastFiredAt) }}</td>
              <td>
                <button class="sw" :class="{ on: r.enabled }" @click="store.toggle(r)">
                  {{ r.enabled ? "开" : "关" }}
                </button>
              </td>
              <td>
                <div class="ops">
                  <button class="op-btn" title="编辑" @click="startEdit(r)">✎</button>
                  <button class="op-btn del" title="删除" @click="remove(r)">×</button>
                </div>
              </td>
            </tr>
            <tr v-if="store.rules.length === 0">
              <td colspan="6" class="empty">暂无预警，点击「新建预警」添加</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <!-- ===== 历史视图 ===== -->
    <template v-else>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th style="width:17%">时间</th>
              <th style="width:15%">股票</th>
              <th style="width:13%">规则</th>
              <th style="width:37%">内容</th>
              <th style="width:18%">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="h in store.history" :key="h.id" :class="['tone-' + h.tone]">
              <td class="time">{{ fmtFull(h.triggeredAt) }}</td>
              <td class="stk">
                <div class="stk-nm">{{ h.name }}</div>
                <div class="stk-cd">{{ h.code }}</div>
              </td>
              <td class="kind">{{ h.label }}</td>
              <td class="msg">{{ h.message }}</td>
              <td>
                <div class="h-ops">
                  <button class="mini-btn" @click="toScreener">转选股</button>
                  <button class="mini-btn ghost" @click="toOrder">条件单</button>
                </div>
              </td>
            </tr>
            <tr v-if="store.history.length === 0">
              <td colspan="5" class="empty">暂无触发记录</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <AlertRuleDialog v-model:open="dialogOpen" :rule="editing" @save="onSave" />
  </div>
</template>

<style scoped>
.alert-center {
  display: flex;
  flex-direction: column;
  height: 100%;
  font-size: 12px;
  color: var(--text);
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  flex: none;
}
.tabs { display: flex; gap: 4px; }
.tab {
  border: 1px solid var(--border); background: transparent; color: var(--text-dim);
  border-radius: 8px; padding: 5px 14px; font-size: 12px; cursor: pointer;
}
.tab.on {
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
  color: #14110a; border-color: transparent; font-weight: 700;
}
.btn-new {
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
  color: #14110a; border: none; font-weight: 700; font-size: 12px;
  padding: 6px 14px; border-radius: 8px; cursor: pointer;
}
.btn-new.ghost {
  background: transparent; color: var(--text-dim);
  border: 1px solid var(--border);
}
.btn-new:hover { filter: brightness(1.08); }
.stat { color: var(--text-dim); font-size: 11px; }
.sound-lab {
  margin-left: auto; display: flex; align-items: center; gap: 5px;
  color: var(--text-dim); font-size: 11px; cursor: pointer;
}

.tpl-bar {
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  padding: 2px 12px 8px; flex: none;
}
.tpl-lab { font-size: 11px; color: var(--text-dim); }
.tpl-btn {
  background: transparent; color: var(--text-dim);
  border: 1px solid var(--border); border-radius: 14px;
  font-size: 11px; padding: 3px 11px; cursor: pointer;
}
.tpl-btn:hover { color: var(--accent-2); border-color: var(--accent); }

.table-wrap { flex: 1; overflow-y: auto; padding: 0 8px 8px; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; }
th {
  text-align: left; color: var(--text-dim); font-weight: 500; font-size: 11px;
  padding: 7px 8px; border-bottom: 1px solid var(--border);
  position: sticky; top: 0; background: var(--bg-panel); z-index: 2;
}
td { padding: 7px 8px; border-bottom: 1px solid var(--border); vertical-align: middle; }
tr.off { opacity: 0.5; }
.stk-nm {
  font-weight: 600; color: var(--text); overflow: hidden;
  white-space: nowrap; text-overflow: ellipsis;
}
.stk-cd { color: var(--text-dim); font-size: 10px; font-variant-numeric: tabular-nums; }
.leaf-cnt { color: var(--text-dim); font-size: 10px; margin-top: 2px; }
.scope { color: var(--text-dim); font-size: 11px; }
.cond { color: var(--text); font-size: 10.5px; line-height: 1.5; }
.time { color: var(--text-dim); font-size: 10.5px; white-space: nowrap; }
.kind { font-size: 11px; font-weight: 600; }
.msg { color: var(--text); font-size: 11px; line-height: 1.45; }

tr.tone-up .kind { color: var(--up, #ff3232); }
tr.tone-down .kind { color: var(--down-g, #1dbe7d); }

.sw {
  border: 1px solid var(--border); background: transparent; color: var(--text-dim);
  border-radius: 6px; padding: 2px 8px; font-size: 10px; cursor: pointer;
}
.sw.on {
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
  color: #14110a; border-color: transparent; font-weight: 700;
}
.ops { display: flex; gap: 4px; }
.op-btn {
  background: transparent; border: 1px solid var(--border); color: var(--text-dim);
  border-radius: 6px; width: 22px; height: 22px; cursor: pointer;
  font-size: 11px; line-height: 1; padding: 0;
}
.op-btn:hover { color: var(--accent-2); border-color: var(--accent); }
.op-btn.del:hover { color: #ff7a86; border-color: #ff7a86; }
.h-ops { display: flex; gap: 5px; }
.mini-btn {
  background: var(--accent); color: #14110a; border: none;
  border-radius: 6px; font-size: 10.5px; padding: 3px 8px; cursor: pointer;
}
.mini-btn.ghost {
  background: transparent; color: var(--text-dim);
  border: 1px solid var(--border);
}
.empty { text-align: center; color: var(--text-dim); padding: 24px 0; }
</style>
