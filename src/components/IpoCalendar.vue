<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import {
  fetchIpoList, fetchRestrictedQueue,
  type IpoItem, type RestrictedItem,
} from "../api/market";

const props = defineProps<{ code: string | null }>();
const emit = defineEmits<{ (e: "select", code: string): void }>();

function pad(n: number) { return String(n).padStart(2, "0"); }
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function daysBetween(date: string): number {
  const a = new Date(date + "T00:00").getTime();
  const b = new Date(todayStr() + "T00:00").getTime();
  return Math.round((a - b) / 86400000);
}

// ===== Tab =====
const tab = ref<"ipo" | "lift">("ipo");

// ===== 新股发行 =====
const ipoList = ref<IpoItem[]>([]);
const ipoLoading = ref(false);
const ipoError = ref("");
const ipoFilter = ref<"all" | "apply" | "wait">("all");

function ipoStatus(it: IpoItem): { k: string; lb: string } {
  const t = todayStr();
  if (it.applyDate && it.applyDate >= t) return { k: "apply", lb: "待申购" };
  if (!it.listDate || it.listDate >= t) return { k: "wait", lb: "待上市" };
  return { k: "done", lb: "已上市" };
}
const filteredIpo = computed(() => {
  if (ipoFilter.value === "all") return ipoList.value;
  return ipoList.value.filter((it) => {
    const s = ipoStatus(it).k;
    if (ipoFilter.value === "apply") return s === "apply";
    return s === "wait";
  });
});
const countApply = computed(
  () => ipoList.value.filter((it) => ipoStatus(it).k === "apply").length
);
const countWait = computed(
  () => ipoList.value.filter((it) => ipoStatus(it).k === "wait").length
);

async function loadIpo() {
  ipoLoading.value = true; ipoError.value = "";
  try {
    ipoList.value = await fetchIpoList();
  } catch (e) {
    ipoError.value = "新股数据加载失败：" + String(e);
  } finally {
    ipoLoading.value = false;
  }
}

function pctLot(v: number | null): string {
  if (v == null) return "--";
  return (v * 100).toFixed(3) + "%";
}
function num(v: number | null, d = 2): string {
  if (v == null) return "--";
  return v.toLocaleString("zh-CN", { minimumFractionDigits: d, maximumFractionDigits: d });
}

// ===== 限售解禁 =====
const liftList = ref<RestrictedItem[]>([]);
const liftLoading = ref(false);
const liftError = ref("");
const liftOnlyFuture = ref(true);

const futureLift = computed(() =>
  liftList.value.filter((it) => it.liftDate && daysBetween(it.liftDate) >= 0)
);
const shownLift = computed(() =>
  liftOnlyFuture.value ? futureLift.value : liftList.value
);

async function loadLift(code: string | null) {
  if (!code) { liftList.value = []; liftError.value = ""; return; }
  liftLoading.value = true; liftError.value = "";
  try {
    liftList.value = await fetchRestrictedQueue(code);
  } catch (e) {
    liftError.value = "解禁数据加载失败：" + String(e);
  } finally {
    liftLoading.value = false;
  }
}
watch(() => props.code, (c) => loadLift(c));

onMounted(() => {
  loadIpo();
  loadLift(props.code);
});
</script>

<template>
  <div class="ic">
    <!-- Tab -->
    <div class="tabs">
      <button :class="{ on: tab === 'ipo' }" @click="tab = 'ipo'">新股发行</button>
      <button :class="{ on: tab === 'lift' }" @click="tab = 'lift'">
        限售解禁<span v-if="props.code" class="tab-code">{{ props.code }}</span>
      </button>
      <div class="spacer"></div>
      <button class="reload" @click="tab === 'ipo' ? loadIpo() : loadLift(props.code)">刷新</button>
    </div>

    <!-- 新股发行 -->
    <div v-if="tab === 'ipo'" class="pane">
      <div class="stat-bar">
        <span class="stat">待申购 <b class="c-apply">{{ countApply }}</b></span>
        <span class="stat">待上市 <b class="c-wait">{{ countWait }}</b></span>
        <span class="stat">近一年共 <b>{{ ipoList.length }}</b> 只</span>
        <div class="spacer"></div>
        <div class="filters">
          <button :class="{ on: ipoFilter === 'all' }" @click="ipoFilter = 'all'">全部</button>
          <button :class="{ on: ipoFilter === 'apply' }" @click="ipoFilter = 'apply'">待申购</button>
          <button :class="{ on: ipoFilter === 'wait' }" @click="ipoFilter = 'wait'">待上市</button>
        </div>
      </div>

      <div v-if="ipoLoading" class="hint">加载中…</div>
      <div v-else-if="ipoError" class="hint err">{{ ipoError }}</div>
      <div v-else class="table-wrap">
        <table class="t">
          <thead>
            <tr>
              <th class="c-code">代码</th><th class="c-name">简称</th>
              <th>状态</th><th>申购日</th><th>上市日</th>
              <th class="r">发行价</th><th class="r">市盈率</th>
              <th class="r">中签率</th><th class="r">申购上限(万股)</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="it in filteredIpo" :key="it.code" @click="emit('select', it.code)">
              <td class="c-code">{{ it.code }}</td>
              <td class="c-name">{{ it.name }}</td>
              <td>
                <span class="stag" :class="ipoStatus(it).k">{{ ipoStatus(it).lb }}</span>
              </td>
              <td>{{ it.applyDate || '--' }}</td>
              <td>{{ it.listDate || '--' }}</td>
              <td class="r">{{ num(it.issuePrice) }}</td>
              <td class="r">{{ num(it.pe, 1) }}</td>
              <td class="r">{{ pctLot(it.lotRate) }}</td>
              <td class="r">{{ num(it.applyLimit, 2) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 限售解禁 -->
    <div v-else class="pane">
      <div v-if="!props.code" class="hint">从自选或榜单选择一只股票，查看其限售解禁安排</div>
      <template v-else>
        <div class="stat-bar">
          <span class="stat">未来解禁 <b class="c-wait">{{ futureLift.length }}</b> 次</span>
          <div class="spacer"></div>
          <label class="ck"><input type="checkbox" v-model="liftOnlyFuture" /> 仅看未来</label>
        </div>
        <div v-if="liftLoading" class="hint">加载中…</div>
        <div v-else-if="liftError" class="hint err">{{ liftError }}</div>
        <div v-else-if="!shownLift.length" class="hint">没有解禁记录（可能已全流通）</div>
        <div v-else class="table-wrap">
          <table class="t">
            <thead>
              <tr>
                <th>解禁日期</th><th>倒计时</th>
                <th class="r">解禁数量(万股)</th><th class="r">解禁市值(亿元)</th>
                <th class="r">批次</th><th>公告日</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(it, i) in shownLift" :key="i"
                :class="{ future: daysBetween(it.liftDate) >= 0 }">
                <td>{{ it.liftDate }}</td>
                <td>
                  <span v-if="daysBetween(it.liftDate) > 0" class="dcount">
                    {{ daysBetween(it.liftDate) }} 天
                  </span>
                  <span v-else-if="daysBetween(it.liftDate) === 0" class="dcount today">今日</span>
                  <span class="past">已解禁</span>
                </td>
                <td class="r">{{ num(it.liftQty, 0) }}</td>
                <td class="r">{{ num(it.liftValue, 2) }}</td>
                <td class="r">{{ it.batch ?? '--' }}</td>
                <td>{{ it.noticeDate || '--' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.ic { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.tabs { display: flex; gap: 4px; margin-bottom: 8px; flex-shrink: 0; }
.tabs button { font-size: 11.5px; padding: 4px 14px; background: transparent;
  color: var(--text-dim); border: 1px solid var(--border); border-radius: 6px; cursor: pointer; }
.tabs button.on { color: #fff; background: #2a3c5e; border-color: #3d5680; }
.tab-code { font-size: 10px; opacity: .7; margin-left: 4px; }
.spacer { flex: 1; }
.reload { font-size: 10.5px !important; }

.pane { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.stat-bar { display: flex; align-items: center; gap: 16px; margin-bottom: 8px; flex-shrink: 0; }
.stat { font-size: 11px; color: var(--text-dim); }
.stat b { font-size: 13px; color: var(--text); margin-left: 4px; }
.c-apply { color: #f23645 !important; }
.c-wait { color: #ff8a3d !important; }
.filters { display: flex; gap: 4px; }
.filters button { font-size: 10.5px; padding: 2px 11px; background: transparent;
  color: var(--text-dim); border: 1px solid var(--border); border-radius: 11px; cursor: pointer; }
.filters button.on { color: #4ea1ff; border-color: #4ea1ff; }
.ck { font-size: 11px; color: var(--text-dim); cursor: pointer; }

.table-wrap { flex: 1; min-height: 0; overflow: auto; border: 1px solid var(--border); border-radius: 7px; }
.t { width: 100%; border-collapse: collapse; font-size: 11.5px; white-space: nowrap; }
.t thead th { position: sticky; top: 0; background: #111722; color: var(--text-dim);
  font-weight: 500; text-align: left; padding: 6px 9px; border-bottom: 1px solid var(--border); z-index: 1; }
.t tbody td { padding: 5px 9px; border-bottom: 1px solid #1a2230; }
.t tbody tr { cursor: pointer; }
.t tbody tr:hover { background: #15202f; }
.c-code { color: var(--text-dim); }
.c-name { font-weight: 600; }
.r { text-align: right; }
.stag { font-size: 10px; padding: 1px 8px; border-radius: 9px; }
.stag.apply { color: #f23645; background: #f2364518; }
.stag.wait { color: #ff8a3d; background: #ff8a3d18; }
.stag.done { color: var(--text-dim); background: #2a3242; }
.dcount { color: #ff8a3d; font-size: 10.5px; }
.dcount.today { color: #f23645; font-weight: 600; }
.past { color: var(--text-dim); font-size: 10.5px; }
tr.future { background: #ff8a3d0a; }
.hint { flex: 1; display: flex; align-items: center; justify-content: center;
  color: var(--text-dim); font-size: 12px; }
.hint.err { color: #f23645; }
</style>
