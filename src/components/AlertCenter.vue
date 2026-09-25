<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { searchStocks } from "../api/market";
import { useAlertStore, newAlertId } from "../stores/alert";
import type { AlertRule, StockItem } from "../api/types";

const store = useAlertStore();

const tab = ref<"rules" | "history">("rules");
const editing = ref(false);
const form = ref<AlertRule>(blank());
const err = ref("");

// 提示音开关（全局，localStorage）
const soundOn = ref(localStorage.getItem("tickgold_alert_sound") !== "0");
function toggleSound() {
  soundOn.value = !soundOn.value;
  localStorage.setItem("tickgold_alert_sound", soundOn.value ? "1" : "0");
}

// 股票搜索
const kw = ref("");
const results = ref<StockItem[]>([]);
const showResults = ref(false);
let searchTimer: number | null = null;

function blank(): AlertRule {
  return {
    id: newAlertId(),
    code: "",
    name: "",
    upPrice: undefined,
    downPrice: undefined,
    upPct: undefined,
    downPct: undefined,
    minVolumeRatio: undefined,
    riseSpeed: undefined,
    downSpeed: undefined,
    speedWindowSec: 300,
    minTurnover: undefined,
    minAmount: undefined,
    sealLimitUp: false,
    sealLimitDown: false,
    brokenLimit: false,
    cooldownSec: 300,
    enabled: true,
  };
}

// 涨速 / 跳水窗口（分钟，与秒互转）
const speedMin = computed(() =>
  Math.max(1, Math.round((form.value.speedWindowSec ?? 300) / 60))
);
function onSpeedWin(e: Event) {
  const v = Number((e.target as HTMLInputElement).value);
  if (v > 0) form.value.speedWindowSec = Math.round(v * 60);
}

function onSearchInput() {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = window.setTimeout(async () => {
    if (!kw.value.trim()) {
      results.value = [];
      showResults.value = false;
      return;
    }
    results.value = await searchStocks(kw.value);
    showResults.value = true;
  }, 250);
}

function pickStock(s: StockItem) {
  form.value.code = s.code;
  form.value.name = s.name;
  kw.value = `${s.code} ${s.name}`;
  showResults.value = false;
}

function startNew() {
  form.value = blank();
  kw.value = "";
  results.value = [];
  err.value = "";
  editing.value = true;
}

function startEdit(r: AlertRule) {
  form.value = { ...r };
  kw.value = `${r.code} ${r.name}`;
  err.value = "";
  if (form.value.downPct != null)
    form.value.downPct = Math.abs(form.value.downPct);
  editing.value = true;
}

function cancel() {
  editing.value = false;
}

async function save() {
  err.value = "";
  if (!form.value.code) {
    err.value = "请选择一只股票";
    return;
  }
  const pos = (v: number | undefined) =>
    v != null && v > 0 ? Math.abs(v) : undefined;
  const payload: AlertRule = {
    ...form.value,
    downPct:
      form.value.downPct != null && form.value.downPct !== 0
        ? -Math.abs(form.value.downPct)
        : undefined,
    upPct: pos(form.value.upPct),
    minVolumeRatio: pos(form.value.minVolumeRatio),
    riseSpeed: pos(form.value.riseSpeed),
    downSpeed: pos(form.value.downSpeed),
    speedWindowSec: form.value.speedWindowSec ?? 300,
    minTurnover: pos(form.value.minTurnover),
    minAmount: pos(form.value.minAmount),
    sealLimitUp: form.value.sealLimitUp || undefined,
    sealLimitDown: form.value.sealLimitDown || undefined,
    brokenLimit: form.value.brokenLimit || undefined,
  };
  const hasCond =
    payload.upPrice != null ||
    payload.downPrice != null ||
    payload.upPct != null ||
    payload.downPct != null ||
    payload.minVolumeRatio != null ||
    payload.riseSpeed != null ||
    payload.downSpeed != null ||
    payload.minTurnover != null ||
    payload.minAmount != null ||
    payload.sealLimitUp === true ||
    payload.sealLimitDown === true ||
    payload.brokenLimit === true;
  if (!hasCond) {
    err.value = "请至少设置一个触发条件";
    return;
  }
  await store.save(payload);
  editing.value = false;
}

async function remove(r: AlertRule) {
  await store.remove(r.id);
}

function condText(r: AlertRule): string {
  const win = Math.round((r.speedWindowSec ?? 300) / 60);
  const parts: string[] = [];
  if (r.upPrice != null) parts.push(`上穿 ${r.upPrice.toFixed(2)}`);
  if (r.downPrice != null) parts.push(`跌破 ${r.downPrice.toFixed(2)}`);
  if (r.upPct != null) parts.push(`涨≥${r.upPct.toFixed(1)}%`);
  if (r.downPct != null) parts.push(`跌≥${Math.abs(r.downPct).toFixed(1)}%`);
  if (r.minVolumeRatio != null) parts.push(`量比≥${r.minVolumeRatio.toFixed(1)}`);
  if (r.minTurnover != null) parts.push(`换手≥${r.minTurnover.toFixed(1)}%`);
  if (r.minAmount != null) parts.push(`成交额≥${r.minAmount.toFixed(1)}亿`);
  if (r.riseSpeed != null) parts.push(`涨速≥${r.riseSpeed.toFixed(1)}%/${win}分`);
  if (r.downSpeed != null) parts.push(`跳水≥${r.downSpeed.toFixed(1)}%/${win}分`);
  if (r.sealLimitUp) parts.push("涨停封板");
  if (r.sealLimitDown) parts.push("跌停封板");
  if (r.brokenLimit) parts.push("炸板");
  return parts.join(" · ") || "无条件";
}

function fmtTime(t?: number): string {
  if (!t) return "—";
  return new Date(t).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
function fmtFull(t?: number | null): string {
  if (!t) return "—";
  return new Date(t).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

const enabledCount = computed(() => store.rules.filter((r) => r.enabled).length);

async function switchTab(t: "rules" | "history") {
  tab.value = t;
  if (t === "history") await store.loadHistory();
}

async function clearHistory() {
  await store.clearHistory();
}

onMounted(async () => {
  if (!store.loaded) await store.load();
});
</script>

<template>
  <div class="alert-center">
    <!-- 操作条 -->
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

    <!-- ============ 规则视图 ============ -->
    <template v-if="tab === 'rules'">
      <!-- 表单 -->
      <div v-if="editing" class="form">
        <div class="f-title">预警设置</div>

        <!-- 选股票 -->
        <div class="f-row">
          <label>股票</label>
          <div class="search-box">
            <input
              v-model="kw"
              class="inp"
              placeholder="代码 / 名称 / 拼音"
              @input="onSearchInput"
              @focus="onSearchInput"
            />
            <div v-if="showResults && results.length" class="sresults">
              <div
                v-for="s in results"
                :key="s.market + s.code"
                class="sitem"
                @mousedown.prevent="pickStock(s)"
              >
                <span class="sic">{{ s.code }}</span>
                <span class="sin">{{ s.name }}</span>
                <span class="sim">{{ s.market }}</span>
              </div>
            </div>
          </div>
        </div>

        <div class="grp">价格 / 涨跌幅</div>
        <div class="f-row">
          <label>价格上穿</label>
          <input v-model.number="form.upPrice" class="inp sm" type="number" step="0.01" placeholder="留空不启用" />
          <label class="lab2">价格跌破</label>
          <input v-model.number="form.downPrice" class="inp sm" type="number" step="0.01" placeholder="留空" />
        </div>
        <div class="f-row">
          <label>涨幅 ≥</label>
          <input v-model.number="form.upPct" class="inp sm" type="number" step="0.1" placeholder="%" />
          <span class="unit">%</span>
          <label class="lab2">跌幅 ≥</label>
          <input v-model.number="form.downPct" class="inp sm" type="number" step="0.1" placeholder="%" />
          <span class="unit">%</span>
        </div>

        <div class="grp">量能</div>
        <div class="f-row">
          <label>量比 ≥</label>
          <input v-model.number="form.minVolumeRatio" class="inp sm" type="number" step="0.1" placeholder="倍" />
          <span class="unit">倍</span>
          <label class="lab2">换手率 ≥</label>
          <input v-model.number="form.minTurnover" class="inp sm" type="number" step="0.1" placeholder="%" />
          <span class="unit">%</span>
        </div>
        <div class="f-row">
          <label>成交额 ≥</label>
          <input v-model.number="form.minAmount" class="inp sm" type="number" step="0.1" placeholder="亿元" />
          <span class="unit">亿元</span>
        </div>

        <div class="grp">盘中异动（涨速 / 跳水）</div>
        <div class="f-row">
          <label>涨速 ≥</label>
          <input v-model.number="form.riseSpeed" class="inp sm" type="number" step="0.1" placeholder="%" />
          <span class="unit">%</span>
          <label class="lab2">跳水 ≥</label>
          <input v-model.number="form.downSpeed" class="inp sm" type="number" step="0.1" placeholder="%" />
          <span class="unit">%</span>
        </div>
        <div class="f-row">
          <label>统计窗口</label>
          <input :value="speedMin" class="inp sm" type="number" min="1" step="1" @input="onSpeedWin" />
          <span class="unit">分钟（涨速 / 跳水共用）</span>
        </div>

        <div class="grp">涨跌停（封板 / 炸板）</div>
        <div class="f-row checks">
          <label class="chk"><input type="checkbox" v-model="form.sealLimitUp" /> 涨停封板</label>
          <label class="chk"><input type="checkbox" v-model="form.sealLimitDown" /> 跌停封板</label>
          <label class="chk"><input type="checkbox" v-model="form.brokenLimit" /> 涨停炸板</label>
        </div>

        <div class="f-row last">
          <label>冷却</label>
          <input v-model.number="form.cooldownSec" class="inp sm" type="number" min="10" step="10" />
          <span class="unit">秒</span>
          <label class="en-lab">
            <input v-model="form.enabled" type="checkbox" /> 启用
          </label>
        </div>

        <div v-if="err" class="ferr">{{ err }}</div>
        <div class="f-actions">
          <button class="btn-save" @click="save">保存</button>
          <button class="btn-cancel" @click="cancel">取消</button>
        </div>
      </div>

      <!-- 规则表格 -->
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th style="width:24%">股票</th>
              <th style="width:38%">触发条件</th>
              <th style="width:16%">最近触发</th>
              <th style="width:9%">状态</th>
              <th style="width:13%">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in store.rules" :key="r.id" :class="{ off: !r.enabled }">
              <td class="stk">
                <div class="stk-nm">{{ r.name }}</div>
                <div class="stk-cd">{{ r.code }}</div>
              </td>
              <td class="cond">{{ condText(r) }}</td>
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
              <td colspan="5" class="empty">暂无预警，点击「新建预警」添加</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <!-- ============ 历史视图 ============ -->
    <template v-else>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th style="width:18%">时间</th>
              <th style="width:20%">股票</th>
              <th style="width:14%">类型</th>
              <th style="width:48%">内容</th>
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
            </tr>
            <tr v-if="store.history.length === 0">
              <td colspan="4" class="empty">暂无触发记录</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
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
  color: #14110a;
  border: none;
  font-weight: 700;
  font-size: 12px;
  padding: 6px 14px;
  border-radius: 8px;
  cursor: pointer;
}
.btn-new.ghost { background: transparent; color: var(--text-dim); border: 1px solid var(--border); }
.btn-new:hover { filter: brightness(1.08); }
.stat { color: var(--text-dim); font-size: 11px; }
.sound-lab {
  margin-left: auto; display: flex; align-items: center; gap: 5px;
  color: var(--text-dim); font-size: 11px; cursor: pointer;
}

/* 表单 */
.form {
  margin: 4px 12px 10px;
  padding: 12px;
  background: color-mix(in srgb, var(--accent) 6%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent) 28%, transparent);
  border-radius: 12px;
}
.f-title { color: var(--accent-2); font-weight: 700; font-size: 12px; margin-bottom: 8px; }
.grp {
  color: var(--accent-2); font-size: 10.5px; font-weight: 700;
  margin: 9px 0 6px; padding-bottom: 3px;
  border-bottom: 1px dashed color-mix(in srgb, var(--accent) 25%, transparent);
}
.f-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 7px;
  position: relative;
}
.f-row.last { margin-top: 9px; }
.f-row label { width: 60px; color: var(--text-dim); font-size: 11px; flex-shrink: 0; }
.f-row label.lab2 { width: auto; margin-left: 6px; }
.inp {
  flex: 1;
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--text);
  border-radius: 7px;
  padding: 6px 9px;
  font-size: 12px;
  outline: none;
}
.inp:focus { border-color: var(--accent); }
.inp.sm { flex: 0 0 118px; }
.unit { color: var(--text-dim); font-size: 10.5px; }
.en-lab {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--text-dim);
  font-size: 11px;
}
.f-row.checks { gap: 22px; }
.chk { display: flex; align-items: center; gap: 6px; color: var(--text-dim); font-size: 11.5px; cursor: pointer; }

/* 搜索结果 */
.search-box { flex: 1; position: relative; }
.sresults {
  position: absolute;
  top: calc(100% + 3px);
  left: 0; right: 0;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  max-height: 200px;
  overflow-y: auto;
  z-index: 30;
}
.sitem {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  cursor: pointer;
}
.sitem:hover { background: color-mix(in srgb, var(--accent) 12%, transparent); }
.sic { color: var(--accent-2); font-variant-numeric: tabular-nums; width: 60px; }
.sin { flex: 1; }
.sim { color: var(--text-dim); font-size: 10px; }

.ferr { color: #ff7a86; font-size: 11px; margin: 4px 0; }
.f-actions { display: flex; gap: 8px; margin-top: 8px; }
.btn-save {
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
  color: #14110a; border: none; font-weight: 700;
  padding: 6px 18px; border-radius: 8px; cursor: pointer;
}
.btn-cancel {
  background: transparent; color: var(--text-dim);
  border: 1px solid var(--border); padding: 6px 18px; border-radius: 8px; cursor: pointer;
}

/* 表格 */
.table-wrap { flex: 1; overflow-y: auto; padding: 0 8px 8px; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; }
th {
  text-align: left; color: var(--text-dim); font-weight: 500; font-size: 11px;
  padding: 7px 8px; border-bottom: 1px solid var(--border);
  position: sticky; top: 0; background: var(--bg-panel); z-index: 2;
}
td { padding: 7px 8px; border-bottom: 1px solid var(--border); vertical-align: middle; }
tr.off { opacity: 0.5; }
.stk-nm { font-weight: 600; color: var(--text); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.stk-cd { color: var(--text-dim); font-size: 10px; font-variant-numeric: tabular-nums; }
.cond { color: var(--text); font-size: 10.5px; line-height: 1.55; }
.time { color: var(--text-dim); font-size: 10.5px; white-space: nowrap; }
.kind { font-size: 11px; font-weight: 600; }
.msg { color: var(--text); font-size: 11px; line-height: 1.45; }

/* 历史 tone 着色 */
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
  border-radius: 6px; width: 22px; height: 22px; cursor: pointer; font-size: 11px;
  line-height: 1; padding: 0;
}
.op-btn:hover { color: var(--accent-2); border-color: var(--accent); }
.op-btn.del:hover { color: #ff7a86; border-color: #ff7a86; }
.empty { text-align: center; color: var(--text-dim); padding: 24px 0; }
</style>
