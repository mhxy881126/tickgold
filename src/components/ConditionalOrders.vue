<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted } from "vue";
import { listen } from "@tauri-apps/api/event";
import {
  coList, coCreate, coUpdate, coCancel, coCancelAll,
  CO_FIELDS, CO_OP_LABEL, CO_FIELD_LABEL, CO_STATUS_LABEL,
  type ConditionalOrder, type CoTriggerLeaf,
} from "../broker/co";
import { CO_PLANS, getCoPlan } from "../lib/playbooks";

// ===== 列表 / 筛选 =====
const orders = ref<ConditionalOrder[]>([]);
const filter = ref<"all" | "active" | "triggered" | "closed">("active");
const loading = ref(false);
const formError = ref("");

const CLOSED = ["expired", "cancelled", "done"];
const filtered = computed(() => {
  if (filter.value === "all") return orders.value;
  if (filter.value === "closed")
    return orders.value.filter((o) => CLOSED.includes(o.status));
  return orders.value.filter((o) => o.status === filter.value);
});
const activeCount = computed(
  () => orders.value.filter((o) => o.status === "active").length
);

async function refresh() {
  loading.value = true;
  try {
    orders.value = await coList(null, 300);
  } catch (e) {
    console.error("条件单加载失败", e);
  } finally {
    loading.value = false;
  }
}

// ===== 新建 / 编辑表单 =====
const showForm = ref(false);
const mode = ref<"create" | "edit">("create");
const editingId = ref(0);

interface Draft {
  code: string;
  name: string;
  side: string;
  vol: number;
  priceMode: string;
  limitPrice: number;
  ttl: string;
  expireDate: string;
  autoConfirm: boolean;
  note: string;
}
const draft = reactive<Draft>({
  code: "", name: "", side: "BUY", vol: 100,
  priceMode: "trigger", limitPrice: 0,
  ttl: "day", expireDate: "", autoConfirm: false, note: "",
});
const leaves = ref<CoTriggerLeaf[]>([
  { field: "price", op: "crossAbove", value: 0 },
]);

function resetDraft() {
  draft.code = ""; draft.name = ""; draft.side = "BUY"; draft.vol = 100;
  draft.priceMode = "trigger"; draft.limitPrice = 0;
  draft.ttl = "day"; draft.expireDate = ""; draft.autoConfirm = false; draft.note = "";
  leaves.value = [{ field: "price", op: "crossAbove", value: 0 }];
}
function openCreate() {
  resetDraft();
  mode.value = "create";
  showForm.value = true;
  formError.value = "";
}
function openEdit(o: ConditionalOrder) {
  mode.value = "edit";
  editingId.value = o.id;
  draft.code = o.code; draft.name = o.name; draft.side = o.side;
  draft.vol = o.vol; draft.priceMode = o.priceMode; draft.limitPrice = o.limitPrice;
  draft.ttl = o.ttl;
  draft.expireDate = o.expireAt
    ? new Date(o.expireAt).toISOString().slice(0, 10)
    : "";
  draft.autoConfirm = o.autoConfirm; draft.note = o.note;
  showForm.value = true;
  formError.value = "";
}

function opsFor(field: string): string[] {
  return CO_FIELDS.find((f) => f.value === field)?.ops ?? [];
}
function fieldNeedsValue(field: string): boolean {
  return CO_FIELDS.find((f) => f.value === field)?.needsValue ?? true;
}
function onFieldChange(i: number) {
  const f = leaves.value[i].field;
  leaves.value[i].op = opsFor(f)[0];
}
function applyPlan(id: string) {
  const p = getCoPlan(id);
  if (!p) return;
  const built = p.build();
  draft.side = p.side;
  draft.priceMode = p.priceMode;
  draft.ttl = p.ttl;
  draft.note = built.note;
  leaves.value = built.trigger.map((l) => ({ ...l }));
}
function addLeaf() {
  leaves.value.push({ field: "pct", op: "gte", value: 0 });
}
function removeLeaf(i: number) {
  leaves.value.splice(i, 1);
}

function expireDateToMs(): number {
  if (draft.ttl !== "date" || !draft.expireDate) return 0;
  const t = new Date(`${draft.expireDate}T23:59:59+08:00`).getTime();
  return Number.isFinite(t) ? t : 0;
}

async function submit() {
  formError.value = "";
  try {
    if (mode.value === "create") {
      if (!draft.code.trim()) throw new Error("请填写股票代码");
      if (leaves.value.length === 0) throw new Error("请至少添加一个触发条件");
      const trigger = leaves.value.map((l) => ({
        field: l.field,
        op: l.op,
        value: fieldNeedsValue(l.field) ? Number(l.value) : 1,
        params: l.params ?? null,
      }));
      await coCreate({
        code: draft.code.trim(),
        name: draft.name.trim(),
        side: draft.side,
        trigger,
        vol: Number(draft.vol),
        priceMode: draft.priceMode,
        limitPrice: draft.priceMode === "limit" ? Number(draft.limitPrice) : 0,
        ttl: draft.ttl,
        expireAt: expireDateToMs(),
        autoConfirm: draft.autoConfirm,
        note: draft.note,
      });
    } else {
      await coUpdate({
        id: editingId.value,
        vol: Number(draft.vol),
        limitPrice: draft.priceMode === "limit" ? Number(draft.limitPrice) : undefined,
        ttl: draft.ttl,
        expireAt: expireDateToMs(),
        autoConfirm: draft.autoConfirm,
        note: draft.note,
      });
    }
    showForm.value = false;
    await refresh();
  } catch (e) {
    formError.value = e instanceof Error ? e.message : String(e);
  }
}

async function cancelOne(o: ConditionalOrder) {
  try {
    await coCancel(o.id);
    await refresh();
  } catch (e) {
    formError.value = String(e);
  }
}
async function cancelAll() {
  try {
    await coCancelAll();
    await refresh();
  } catch (e) {
    formError.value = String(e);
  }
}

// ===== 展示辅助 =====
function triggerText(o: ConditionalOrder): string {
  return o.trigger
    .map((l) => {
      const fl = CO_FIELD_LABEL[l.field] ?? l.field;
      const op = CO_OP_LABEL[l.op] ?? l.op;
      return fieldNeedsValue(l.field) ? `${fl}${op}${l.value}` : `${fl}${op}`;
    })
    .join(" 且 ");
}
function priceModeText(m: string): string {
  return m === "limit" ? "限价" : m === "market" ? "市价" : "触发价";
}
function ttlText(o: ConditionalOrder): string {
  if (o.ttl === "gtc") return "长期有效";
  if (o.ttl === "date")
    return o.expireAt ? new Date(o.expireAt).toLocaleDateString("zh-CN") : "指定日期";
  return "当日有效";
}
function fmtTime(t?: number): string {
  if (!t) return "—";
  return new Date(t).toLocaleString("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

// ===== 事件监听：触发 / 异常 / 信号 / 委托变化即刷新 =====
const unlisteners: Array<() => void> = [];
onMounted(async () => {
  await refresh();
  unlisteners.push(await listen("co:triggered", refresh));
  unlisteners.push(await listen("co:error", refresh));
  unlisteners.push(await listen("signal:updated", refresh));
  unlisteners.push(await listen("broker:event", refresh));
});
onUnmounted(() => unlisteners.forEach((fn) => fn()));
</script>

<template>
  <div class="co-center">
    <div class="toolbar">
      <div class="tabs">
        <button class="tab" :class="{ on: filter === 'active' }" @click="filter = 'active'">进行中</button>
        <button class="tab" :class="{ on: filter === 'triggered' }" @click="filter = 'triggered'">已触发</button>
        <button class="tab" :class="{ on: filter === 'closed' }" @click="filter = 'closed'">已结束</button>
        <button class="tab" :class="{ on: filter === 'all' }" @click="filter = 'all'">全部</button>
      </div>
      <button class="btn-new" @click="openCreate">＋ 新建条件单</button>
      <button class="btn-new ghost" :disabled="activeCount === 0" @click="cancelAll">全部撤销</button>
      <span class="stat">进行中 {{ activeCount }}</span>
    </div>

    <!-- ===== 新建 / 编辑表单 ===== -->
    <div v-if="showForm" class="form-panel">
      <div class="form-title">{{ mode === "create" ? "新建条件单" : "修改条件单" }}</div>
      <div v-if="mode === 'create'" class="plan-bar">
        <span class="tpl-lab">打法方案：</span>
        <button
          v-for="p in CO_PLANS" :key="p.id" class="tpl-btn" :title="p.desc"
          @click="applyPlan(p.id)"
        >{{ p.label }}</button>
      </div>
      <div class="form-row">
        <label>代码
          <input v-model="draft.code" class="inp" :disabled="mode === 'edit'" placeholder="如 600519" />
        </label>
        <label>名称
          <input v-model="draft.name" class="inp" :disabled="mode === 'edit'" placeholder="可留空" />
        </label>
        <label>方向
          <select v-model="draft.side" class="inp" :disabled="mode === 'edit'">
            <option value="BUY">买入</option>
            <option value="SELL">卖出</option>
          </select>
        </label>
        <label>数量(股)
          <input v-model.number="draft.vol" type="number" step="100" min="100" class="inp" />
        </label>
      </div>

      <!-- 触发条件（仅新建可改） -->
      <template v-if="mode === 'create'">
        <div class="leaves-head">
          <span>触发条件（同时满足）</span>
          <button class="leaf-add" @click="addLeaf">＋ 添加条件</button>
        </div>
        <div v-for="(l, i) in leaves" :key="i" class="leaf-row">
          <select v-model="l.field" class="inp" @change="onFieldChange(i)">
            <option v-for="f in CO_FIELDS" :key="f.value" :value="f.value">{{ f.label }}</option>
          </select>
          <select v-model="l.op" class="inp op">
            <option v-for="op in opsFor(l.field)" :key="op" :value="op">
              {{ CO_OP_LABEL[op] ?? op }}
            </option>
          </select>
          <input
            v-if="fieldNeedsValue(l.field)"
            v-model.number="l.value" type="number" step="0.01" class="inp val"
          />
          <button class="leaf-del" @click="removeLeaf(i)">×</button>
        </div>
      </template>

      <div class="form-row">
        <label>委托价方式
          <select v-model="draft.priceMode" class="inp">
            <option value="trigger">触发价</option>
            <option value="limit">限价</option>
            <option value="market">市价</option>
          </select>
        </label>
        <label v-if="draft.priceMode === 'limit'">限价
          <input v-model.number="draft.limitPrice" type="number" step="0.01" class="inp" />
        </label>
        <label>有效期
          <select v-model="draft.ttl" class="inp">
            <option value="day">当日有效</option>
            <option value="gtc">撤销前有效</option>
            <option value="date">指定日期</option>
          </select>
        </label>
        <label v-if="draft.ttl === 'date'">到期日
          <input v-model="draft.expireDate" type="date" class="inp" />
        </label>
        <label class="check-lab" title="仅模拟盘生效，实盘始终需人工确认">
          <input v-model="draft.autoConfirm" type="checkbox" /> 模拟盘自动确认
        </label>
      </div>
      <div class="form-row">
        <label class="note-lab">备注
          <input v-model="draft.note" class="inp" placeholder="可选" />
        </label>
      </div>
      <div v-if="formError" class="form-error">{{ formError }}</div>
      <div class="form-actions">
        <button class="btn-new" @click="submit">提交</button>
        <button class="btn-new ghost" @click="showForm = false">取消</button>
      </div>
      <div class="compliance-note">合规说明：实盘仅生成待确认信号，需人工在信号桥确认，不会自动下单；可随时使用紧急停止。</div>
    </div>

    <!-- ===== 列表 ===== -->
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th style="width:14%">标的</th>
            <th style="width:8%">方向</th>
            <th style="width:30%">触发条件</th>
            <th style="width:18%">委托</th>
            <th style="width:12%">有效期</th>
            <th style="width:9%">状态</th>
            <th style="width:9%">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="o in filtered" :key="o.id">
            <td>
              <div class="stk-nm">{{ o.name || o.code }}</div>
              <div class="stk-cd">{{ o.code }}</div>
            </td>
            <td>
              <span class="side-badge" :class="o.side === 'BUY' ? 'buy' : 'sell'">
                {{ o.side === "BUY" ? "买入" : "卖出" }}
              </span>
            </td>
            <td class="cond">{{ triggerText(o) }}</td>
            <td class="ord-cell">
              <div>{{ priceModeText(o.priceMode) }} · {{ o.vol }}股</div>
              <div v-if="o.priceMode === 'limit'" class="stk-cd">限价 {{ o.limitPrice }}</div>
            </td>
            <td class="stk-cd">{{ ttlText(o) }}</td>
            <td>
              <span class="status-badge" :class="'st-' + o.status">
                {{ CO_STATUS_LABEL[o.status] ?? o.status }}
              </span>
              <div v-if="o.triggeredAt" class="stk-cd">{{ fmtTime(o.triggeredAt) }}</div>
            </td>
            <td>
              <div class="ops">
                <button
                  v-if="o.status === 'active'" class="op-btn" title="修改" @click="openEdit(o)"
                >✎</button>
                <button
                  v-if="o.status === 'active'" class="op-btn del" title="撤销" @click="cancelOne(o)"
                >×</button>
                <span v-if="o.status !== 'active'" class="stk-cd">—</span>
              </div>
            </td>
          </tr>
          <tr v-if="filtered.length === 0">
            <td colspan="7" class="empty">
              {{ loading ? "加载中…" : "暂无条件单，点击「新建条件单」添加" }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.co-center {
  display: flex; flex-direction: column; height: 100%;
  font-size: 12px; color: var(--text);
}
.toolbar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; flex: none; }
.tabs { display: flex; gap: 4px; }
.tab {
  border: 1px solid var(--border); background: transparent; color: var(--text-dim);
  border-radius: 8px; padding: 5px 12px; font-size: 12px; cursor: pointer;
}
.tab.on {
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
  color: #14110a; border-color: transparent; font-weight: 700;
}
.btn-new {
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
  color: #14110a; border: none; font-weight: 700; font-size: 12px;
  padding: 6px 13px; border-radius: 8px; cursor: pointer;
}
.btn-new.ghost {
  background: transparent; color: var(--text-dim); border: 1px solid var(--border);
}
.btn-new:disabled { opacity: 0.45; cursor: not-allowed; }
.btn-new:hover:not(:disabled) { filter: brightness(1.08); }
.stat { color: var(--text-dim); font-size: 11px; margin-left: auto; }

/* 表单 */
.form-panel {
  flex: none; margin: 0 12px 8px; padding: 10px 12px;
  border: 1px solid var(--border); border-radius: 10px;
  background: var(--bg-panel);
}
.form-title { font-weight: 700; font-size: 12px; margin-bottom: 8px; color: var(--text); }
.plan-bar { display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:8px; }
.tpl-lab { font-size:10.5px;color:var(--text-dim); }
.tpl-btn { background:transparent;color:var(--text-dim);border:1px solid var(--border);
  border-radius:13px;font-size:10.5px;padding:2px 10px;cursor:pointer; }
.tpl-btn:hover { color:var(--accent-2);border-color:var(--accent); }
.form-row {
  display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 8px; align-items: center;
}
.form-row label {
  display: flex; flex-direction: column; gap: 3px;
  font-size: 10.5px; color: var(--text-dim);
}
.inp {
  background: var(--bg-input, transparent); border: 1px solid var(--border);
  color: var(--text); border-radius: 7px; padding: 5px 8px; font-size: 12px; min-width: 92px;
}
.inp:disabled { opacity: 0.55; }
.inp.op { min-width: 72px; }
.inp.val { min-width: 80px; width: 96px; }
.check-lab { flex-direction: row !important; align-items: center; gap: 5px !important; cursor: pointer; }
.note-lab { flex: 1; }
.note-lab .inp { width: 100%; }
.leaves-head {
  display: flex; align-items: center; justify-content: space-between;
  font-size: 10.5px; color: var(--text-dim); margin-bottom: 6px;
}
.leaf-add {
  background: transparent; border: 1px solid var(--border); color: var(--text-dim);
  border-radius: 12px; font-size: 10.5px; padding: 2px 10px; cursor: pointer;
}
.leaf-row { display: flex; gap: 8px; align-items: center; margin-bottom: 6px; }
.leaf-del {
  background: transparent; border: 1px solid var(--border); color: var(--text-dim);
  border-radius: 6px; width: 24px; height: 26px; cursor: pointer; font-size: 13px;
}
.leaf-del:hover { color: #ff7a86; border-color: #ff7a86; }
.form-error { color: #ff7a86; font-size: 11px; margin-bottom: 6px; }
.form-actions { display: flex; gap: 8px; }
.compliance-note { margin-top: 8px; font-size: 10px; color: var(--text-dim); line-height: 1.5; }

/* 表格 */
.table-wrap { flex: 1; overflow-y: auto; padding: 0 8px 8px; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; }
th {
  text-align: left; color: var(--text-dim); font-weight: 500; font-size: 11px;
  padding: 7px 8px; border-bottom: 1px solid var(--border);
  position: sticky; top: 0; background: var(--bg-panel); z-index: 2;
}
td { padding: 7px 8px; border-bottom: 1px solid var(--border); vertical-align: middle; }
.stk-nm {
  font-weight: 600; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
}
.stk-cd { color: var(--text-dim); font-size: 10px; font-variant-numeric: tabular-nums; }
.cond { font-size: 10.5px; line-height: 1.5; }
.ord-cell { font-size: 10.5px; line-height: 1.5; }
.side-badge {
  border-radius: 6px; padding: 2px 7px; font-size: 10.5px; font-weight: 700;
}
.side-badge.buy { color: var(--up, #ff3232); background: rgba(255, 50, 50, 0.1); }
.side-badge.sell { color: var(--down-g, #1dbe7d); background: rgba(29, 190, 125, 0.1); }
.status-badge {
  border-radius: 6px; padding: 2px 7px; font-size: 10px; font-weight: 600;
  border: 1px solid var(--border); color: var(--text-dim);
}
.status-badge.st-active { color: var(--up, #ff3232); border-color: rgba(255, 50, 50, 0.4); }
.status-badge.st-triggered { color: var(--accent-2, #ffb13d); border-color: var(--accent); }
.status-badge.st-done { color: var(--down-g, #1dbe7d); }
.ops { display: flex; gap: 4px; }
.op-btn {
  background: transparent; border: 1px solid var(--border); color: var(--text-dim);
  border-radius: 6px; width: 22px; height: 22px; cursor: pointer;
  font-size: 11px; line-height: 1; padding: 0;
}
.op-btn:hover { color: var(--accent-2); border-color: var(--accent); }
.op-btn.del:hover { color: #ff7a86; border-color: #ff7a86; }
.empty { text-align: center; color: var(--text-dim); padding: 24px 0; }
</style>
