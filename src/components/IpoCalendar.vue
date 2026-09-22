<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import {
  fetchIpoList, fetchRestrictedQueue, fetchMarketRestricted,
  type IpoItem, type RestrictedItem, type MarketRestricted,
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
function addMonths(m: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() + m);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ===== Tab =====
const tab = ref<"ipo" | "lift" | "market">("ipo");

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

// ===== 个股限售解禁 =====
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
watch(() => props.code, (c) => { if (tab.value === "lift") loadLift(c); });

// ===== 全市场解禁一览（无限滚动分页）=====
const mktList = ref<MarketRestricted[]>([]);
const mktLoading = ref(false);
const mktError = ref("");
const mktPage = ref(0);
const mktPages = ref(0);
const mktTotal = ref(0);
const mktRange = ref(3); // 月
const mktLoaded = ref(false);
const mktHasMore = computed(() => mktPage.value < mktPages.value);

async function loadMarket(reset = true) {
  if (mktLoading.value) return;
  if (reset) {
    mktList.value = []; mktPage.value = 0; mktPages.value = 0; mktTotal.value = 0;
  }
  mktLoading.value = true; mktError.value = "";
  try {
    const nextPage = mktPage.value + 1;
    const r = await fetchMarketRestricted(todayStr(), addMonths(mktRange.value), nextPage, 50);
    mktPages.value = r.pages;
    mktTotal.value = r.total;
    mktList.value = mktList.value.concat(r.data);
    mktPage.value = nextPage;
    mktLoaded.value = true;
  } catch (e) {
    mktError.value = "全市场解禁加载失败：" + String(e);
  } finally {
    mktLoading.value = false;
  }
}
function onMktScroll(e: Event) {
  const el = e.target as HTMLElement;
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 40 && mktHasMore.value) {
    loadMarket(false);
  }
}
watch(mktRange, () => { if (tab.value === "market") loadMarket(true); });

function typeClass(t: string): string {
  if (t.includes("首发")) return "t-first";
  if (t.includes("股权")) return "t-equity";
  if (t.includes("增发")) return "t-add";
  return "t-other";
}
function wan(v: number): string {
  return v.toLocaleString("zh-CN", { maximumFractionDigits: 0 });
}
function yiFromWan(v: number): string {
  return (v / 10000).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function reload() {
  if (tab.value === "ipo") loadIpo();
  else if (tab.value === "lift") loadLift(props.code);
  else loadMarket(true);
}
function switchTab(t: typeof tab.value) {
  tab.value = t;
  if (t === "market" && !mktLoaded.value) loadMarket(true);
  if (t === "lift") loadLift(props.code);
}

onMounted(() => {
  loadIpo();
  loadLift(props.code);
});
</script>

<template>
  <div class="ic">
    <!-- Tab -->
    <div class="tabs">
      <button :class="{ on: tab === 'ipo' }" @click="switchTab('ipo')">新股发行</button>
      <button :class="{ on: tab === 'lift' }" @click="switchTab('lift')">
        个股解禁<span v-if="props.code" class="tab-code">{{ props.code }}</span>
      </button>
      <button :class="{ on: tab === 'market' }" @click="switchTab('market')">全市场解禁</button>
      <div class="spacer"></div>
      <button class="reload" @click="reload">刷新</button>
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

    <!-- 个股限售解禁 -->
    <div v-else-if="tab === 'lift'" class="pane">
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

    <!-- 全市场解禁一览 -->
    <div v-else class="pane">
      <div class="stat-bar">
        <span class="stat">区间内共 <b class="c-wait">{{ mktTotal }}</b> 笔解禁</span>
        <span class="stat">已加载 <b>{{ mktList.length }}</b></span>
        <div class="spacer"></div>
        <div class="filters">
          <button :class="{ on: mktRange === 1 }" @click="mktRange = 1">近1月</button>
          <button :class="{ on: mktRange === 3 }" @click="mktRange = 3">近3月</button>
          <button :class="{ on: mktRange === 6 }" @click="mktRange = 6">近6月</button>
          <button :class="{ on: mktRange === 12 }" @click="mktRange = 12">近12月</button>
        </div>
      </div>

      <div v-if="mktLoading && !mktList.length" class="hint">加载中…</div>
      <div v-else-if="mktError && !mktList.length" class="hint err">{{ mktError }}</div>
      <div v-else class="table-wrap" @scroll="onMktScroll">
        <table class="t">
          <thead>
            <tr>
              <th class="c-date">解禁日期</th>
              <th class="c-code">代码</th><th class="c-name">简称</th>
              <th>限售类型</th>
              <th class="r">实际解禁(万股)</th>
              <th class="r">解禁市值(亿元)</th>
              <th class="r">占流通(%)</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(it, i) in mktList" :key="it.code + '-' + i" @click="emit('select', it.code)">
              <td class="c-date">{{ it.date }}</td>
              <td class="c-code">{{ it.code }}</td>
              <td class="c-name">{{ it.name }}</td>
              <td><span class="ttag" :class="typeClass(it.typeName)">{{ it.typeName || '--' }}</span></td>
              <td class="r">{{ wan(it.shares) }}</td>
              <td class="r">{{ yiFromWan(it.marketCap) }}</td>
              <td class="r">{{ num(it.freeRatio, 2) }}</td>
            </tr>
          </tbody>
        </table>
        <div class="load-foot">
          <span v-if="mktLoading">正在加载更多…</span>
          <span v-else-if="mktHasMore">向下滚动加载更多</span>
          <span v-else>已加载全部 {{ mktList.length }} / {{ mktTotal }} 笔</span>
        </div>
      </div>
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
.c-date { color: #d7dee7; }
.c-code { color: var(--text-dim); }
.c-name { font-weight: 600; }
.r { text-align: right; }

.stag { font-size: 10px; padding: 1px 8px; border-radius: 9px; }
.stag.apply { color: #f23645; background: #f2364518; }
.stag.wait { color: #ff8a3d; background: #ff8a3d18; }
.stag.done { color: var(--text-dim); background: #2a3242; }

/* 限售类型标签 */
.ttag { font-size: 10px; padding: 1px 7px; border-radius: 4px; white-space: nowrap; }
.ttag.t-first { color: #f2643d; background: rgba(242, 100, 61, 0.12); }
.ttag.t-equity { color: #4ea1ff; background: rgba(78, 161, 255, 0.12); }
.ttag.t-add { color: #b07ce8; background: rgba(176, 124, 232, 0.12); }
.ttag.t-other { color: #9aa4b0; background: rgba(154, 164, 176, 0.12); }

.dcount { color: #ff8a3d; font-size: 10.5px; }
.dcount.today { color: #f23645; font-weight: 600; }
.past { color: var(--text-dim); font-size: 10.5px; }
tr.future { background: #ff8a3d0a; }

.load-foot { text-align: center; font-size: 10.5px; color: var(--text-dim); padding: 8px 0; }
.hint { flex: 1; display: flex; align-items: center; justify-content: center;
  color: var(--text-dim); font-size: 12px; }
.hint.err { color: #f23645; }
</style>
