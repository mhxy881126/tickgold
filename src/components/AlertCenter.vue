<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { searchStocks } from "../api/market";
import { useAlertStore, newAlertId } from "../stores/alert";
import type { AlertRule, StockItem } from "../api/types";

const store = useAlertStore();

const editing = ref(false);
const form = ref<AlertRule>(blank());
const err = ref("");

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
    cooldownSec: 300,
    enabled: true,
  };
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
  // 跌幅回填为正数
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
  const payload: AlertRule = {
    ...form.value,
    // 跌幅存负值
    downPct:
      form.value.downPct != null && form.value.downPct !== 0
        ? -Math.abs(form.value.downPct)
        : undefined,
    upPct:
      form.value.upPct != null && form.value.upPct !== 0
        ? Math.abs(form.value.upPct)
        : undefined,
  };
  const hasCond =
    payload.upPrice != null ||
    payload.downPrice != null ||
    payload.upPct != null ||
    payload.downPct != null;
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
  const parts: string[] = [];
  if (r.upPrice != null) parts.push(`上穿 ${r.upPrice.toFixed(2)}`);
  if (r.downPrice != null) parts.push(`跌破 ${r.downPrice.toFixed(2)}`);
  if (r.upPct != null) parts.push(`涨≥${r.upPct.toFixed(1)}%`);
  if (r.downPct != null) parts.push(`跌≥${Math.abs(r.downPct).toFixed(1)}%`);
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

const enabledCount = computed(() => store.rules.filter((r) => r.enabled).length);

onMounted(async () => {
  if (!store.loaded) await store.load();
});
</script>

<template>
  <div class="alert-center">
    <!-- 操作条 -->
    <div class="toolbar">
      <button class="btn-new" @click="startNew">＋ 新建预警</button>
      <span class="stat">启用 {{ enabledCount }} / 共 {{ store.rules.length }}</span>
    </div>

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

      <!-- 触发条件 -->
      <div class="f-row">
        <label>价格上穿</label>
        <input v-model.number="form.upPrice" class="inp sm" type="number" step="0.01" placeholder="留空不启用" />
      </div>
      <div class="f-row">
        <label>价格跌破</label>
        <input v-model.number="form.downPrice" class="inp sm" type="number" step="0.01" placeholder="留空不启用" />
      </div>
      <div class="f-row">
        <label>涨幅 ≥</label>
        <input v-model.number="form.upPct" class="inp sm" type="number" step="0.1" placeholder="%" />
        <span class="unit">%</span>
      </div>
      <div class="f-row">
        <label>跌幅 ≥</label>
        <input v-model.number="form.downPct" class="inp sm" type="number" step="0.1" placeholder="%" />
        <span class="unit">%</span>
      </div>

      <div class="f-row">
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
            <th style="width:26%">股票</th>
            <th style="width:34%">触发条件</th>
            <th style="width:18%">最近触发</th>
            <th style="width:10%">状态</th>
            <th style="width:12%">操作</th>
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
              <button
                class="sw"
                :class="{ on: r.enabled }"
                @click="store.toggle(r)"
              >
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
  </div>
</template>

<style scoped>
.alert-center {
  display: flex;
  flex-direction: column;
  height: 100%;
  font-size: 12px;
  color: #c9d1d9;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
}
.btn-new {
  background: linear-gradient(135deg, #ffd700, #ffaa00);
  color: #1a1500;
  border: none;
  font-weight: 700;
  font-size: 12px;
  padding: 6px 14px;
  border-radius: 8px;
  cursor: pointer;
}
.btn-new:hover { filter: brightness(1.08); }
.stat { color: #8b98a5; font-size: 11px; }

/* 表单 */
.form {
  margin: 4px 12px 10px;
  padding: 12px;
  background: rgba(255, 215, 0, 0.05);
  border: 1px solid rgba(255, 215, 0, 0.25);
  border-radius: 12px;
}
.f-title { color: #ffd700; font-weight: 700; font-size: 12px; margin-bottom: 8px; }
.f-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 7px;
  position: relative;
}
.f-row label { width: 64px; color: #8b98a5; font-size: 11px; flex-shrink: 0; }
.inp {
  flex: 1;
  background: #0d1117;
  border: 1px solid #30363d;
  color: #e6edf3;
  border-radius: 7px;
  padding: 6px 9px;
  font-size: 12px;
  outline: none;
}
.inp:focus { border-color: #ffd700; }
.inp.sm { flex: 0 0 150px; }
.unit { color: #8b98a5; font-size: 11px; }
.en-lab {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 5px;
  color: #8b98a5;
  font-size: 11px;
}

/* 搜索结果 */
.search-box { flex: 1; position: relative; }
.sresults {
  position: absolute;
  top: calc(100% + 3px);
  left: 0; right: 0;
  background: #161b22;
  border: 1px solid #30363d;
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
.sitem:hover { background: rgba(255, 215, 0, 0.1); }
.sic { color: #ffd700; font-variant-numeric: tabular-nums; width: 60px; }
.sin { flex: 1; }
.sim { color: #586069; font-size: 10px; }

.ferr { color: #ff8a98; font-size: 11px; margin: 4px 0; }
.f-actions { display: flex; gap: 8px; margin-top: 8px; }
.btn-save {
  background: linear-gradient(135deg, #ffd700, #ffaa00);
  color: #1a1500; border: none; font-weight: 700;
  padding: 6px 18px; border-radius: 8px; cursor: pointer;
}
.btn-cancel {
  background: transparent; color: #8b98a5;
  border: 1px solid #30363d; padding: 6px 18px; border-radius: 8px; cursor: pointer;
}

/* 表格 */
.table-wrap { flex: 1; overflow-y: auto; padding: 0 8px 8px; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; }
th {
  text-align: left; color: #8b98a5; font-weight: 500; font-size: 11px;
  padding: 7px 8px; border-bottom: 1px solid #21262d;
  position: sticky; top: 0; background: #0d1117; z-index: 2;
}
td { padding: 7px 8px; border-bottom: 1px solid #161b22; vertical-align: middle; }
tr.off { opacity: 0.5; }
.stk-nm { font-weight: 600; color: #e6edf3; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.stk-cd { color: #586069; font-size: 10px; font-variant-numeric: tabular-nums; }
.cond { color: #c9d1d9; font-size: 11px; line-height: 1.5; }
.time { color: #8b98a5; font-size: 10px; }

.sw {
  border: 1px solid #30363d; background: transparent; color: #8b98a5;
  border-radius: 6px; padding: 2px 8px; font-size: 10px; cursor: pointer;
}
.sw.on {
  background: linear-gradient(135deg, #ffd700, #ffaa00);
  color: #1a1500; border-color: transparent; font-weight: 700;
}
.ops { display: flex; gap: 4px; }
.op-btn {
  background: transparent; border: 1px solid #30363d; color: #8b98a5;
  border-radius: 6px; width: 22px; height: 22px; cursor: pointer; font-size: 11px;
  line-height: 1; padding: 0;
}
.op-btn:hover { color: #ffd700; border-color: #ffd700; }
.op-btn.del:hover { color: #ff8a98; border-color: #ff8a98; }
.empty { text-align: center; color: #586069; padding: 24px 0; }
</style>
