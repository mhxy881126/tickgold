<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import {
  fetchLhbList,
  fetchLhbDetail,
  fetchSeatBack,
  fetchSeatTrades,
  type LhbStock,
  type LhbDetail,
  type SeatBack,
  type SeatTrades,
} from "../api/market";

const emit = defineEmits<{ (e: "select", code: string): void }>();

const curDate = ref("");
const stocks = ref<LhbStock[]>([]);
const selCode = ref<string | null>(null);
const detail = ref<LhbDetail | null>(null);
const loading = ref(false);
const sortMode = ref<"net" | "pct">("net");

// ===== 席位跟庄统计 =====
const view = ref<"seat" | "dept">("seat");
const seatBack = ref<SeatBack | null>(null);
const seatTrades = ref<SeatTrades | null>(null);
const seatTag = ref("");
const seatLoading = ref(false);
const seatPage = ref(1);
const horizons = ["d1", "d2", "d3", "d5", "d10"] as const;
const horizonLabels = ["1日", "2日", "3日", "5日", "10日"];

// ===== 日期工具（跳过周末；节假日手动多点一次）=====
function fmt(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function shiftTrade(date: string, dir: number): string {
  const d = new Date(date + "T00:00:00");
  do {
    d.setDate(d.getDate() + dir);
  } while (d.getDay() === 0 || d.getDay() === 6);
  return fmt(d);
}
function today(): string {
  return fmt(new Date());
}

// ===== 金额格式化 =====
function money(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e8) return (n / 1e8).toFixed(2) + "亿";
  if (a >= 1e4) return (n / 1e4).toFixed(0) + "万";
  return n.toFixed(0);
}

// ===== 当日统计 =====
const stat = computed(() => {
  const net = stocks.value.reduce((s, x) => s + x.netAmt, 0);
  const buyers = stocks.value.filter((x) => x.netAmt > 0).length;
  return {
    total: stocks.value.length,
    net,
    buyers,
    sellers: stocks.value.length - buyers,
  };
});

// ===== 列表排序 =====
const sortedStocks = computed(() => {
  const a = [...stocks.value];
  a.sort((x, y) =>
    sortMode.value === "net" ? y.netAmt - x.netAmt : y.pct - x.pct
  );
  return a;
});

// ===== 加载某日 =====
async function loadDate(date: string) {
  loading.value = true;
  try {
    const list = await fetchLhbList(date);
    curDate.value = list.date;
    stocks.value = list.stocks;
    if (stocks.value.length) {
      await pick(stocks.value[0].code, false);
    } else {
      detail.value = null;
      selCode.value = null;
    }
  } catch (e) {
    console.error("lhb list", e);
  } finally {
    loading.value = false;
  }
}

// ===== 选中个股 → 席位明细 =====
async function pick(code: string, link = true) {
  selCode.value = code;
  view.value = "seat";
  if (link) emit("select", code);
  try {
    detail.value = await fetchLhbDetail(code, curDate.value);
  } catch (e) {
    console.error("lhb detail", e);
    detail.value = null;
  }
}

// ===== 点击营业部名 → 该席位跟庄统计 =====
async function openSeat(s: { code: string; name: string; tag: string }) {
  if (!s.code) return;
  seatLoading.value = true;
  seatTag.value = s.tag;
  seatPage.value = 1;
  try {
    const [b, t] = await Promise.all([
      fetchSeatBack(s.code),
      fetchSeatTrades(s.code, 50, 1),
    ]);
    seatBack.value = b;
    seatTrades.value = t;
    view.value = "dept";
  } catch (e) {
    console.error("seat stat", e);
  } finally {
    seatLoading.value = false;
  }
}

// 历史上榜明细加载更多（翻页）
async function moreSeat() {
  if (!seatTrades.value) return;
  const code = seatTrades.value.code;
  seatPage.value++;
  try {
    const t = await fetchSeatTrades(code, 50, seatPage.value);
    seatTrades.value.trades.push(...t.trades);
  } catch (e) {
    console.error("seat more", e);
    seatPage.value--;
  }
}

function backToSeat() {
  view.value = "seat";
}

// 点历史上榜股票 → 联动 K 线
function selectStock(code: string) {
  emit("select", code);
}

function prevDay() {
  if (curDate.value) loadDate(shiftTrade(curDate.value, -1));
}
function nextDay() {
  if (!curDate.value) return;
  const n = shiftTrade(curDate.value, 1);
  if (n <= today()) loadDate(n);
}

function tagClass(tag: string): string {
  if (!tag) return "";
  if (tag === "机构") return "t-org";
  if (tag === "北向") return "t-north";
  if (tag.includes("量化")) return "t-quant";
  if (tag.includes("拉萨")) return "t-lasa";
  return "t-hot";
}
function pctCls(n: number | null): string {
  return n != null && n > 0 ? "up" : n != null && n < 0 ? "down" : "";
}

onMounted(() => loadDate(""));
</script>

<template>
  <div class="dt">
    <!-- 工具栏 -->
    <div class="dt-bar">
      <button class="nav-btn" title="上一交易日" @click="prevDay">‹</button>
      <span class="dt-date">{{ curDate || "----" }}</span>
      <button class="nav-btn" title="下一交易日" @click="nextDay">›</button>
      <button class="refresh" title="刷新" @click="loadDate(curDate)">↻</button>
      <div class="sort-switch">
        <button :class="{ on: sortMode === 'net' }" @click="sortMode = 'net'">净买入</button>
        <button :class="{ on: sortMode === 'pct' }" @click="sortMode = 'pct'">涨跌幅</button>
      </div>
    </div>

    <!-- 当日统计 -->
    <div class="dt-stat">
      <span class="st">上榜 <b>{{ stat.total }}</b> 只</span>
      <span class="st">净买入合计 <b :class="pctCls(stat.net)">{{ money(stat.net) }}</b></span>
      <span class="st">净买 <b class="up">{{ stat.buyers }}</b></span>
      <span class="st">净卖 <b class="down">{{ stat.sellers }}</b></span>
    </div>

    <div class="dt-body">
      <!-- 左侧个股列表 -->
      <div class="dt-left">
        <div class="loading" v-if="loading">加载中…</div>
        <div
          v-for="s in sortedStocks"
          :key="s.code"
          class="stock-row"
          :class="{ active: selCode === s.code }"
          @click="pick(s.code)"
        >
          <div class="sr-top">
            <span class="sr-code">{{ s.code }}</span>
            <span class="sr-name">{{ s.name }}</span>
            <span class="sr-pct" :class="pctCls(s.pct)">{{ s.pct > 0 ? "+" : "" }}{{ s.pct.toFixed(2) }}%</span>
          </div>
          <div class="sr-mid">
            <span class="sr-net" :class="pctCls(s.netAmt)">净 {{ money(s.netAmt) }}</span>
            <span class="sr-deal">额 {{ money(s.dealAmt) }}</span>
          </div>
          <div class="sr-reasons">
            <i v-for="(r, i) in s.reasons" :key="i">{{ r }}</i>
          </div>
        </div>
        <div v-if="!loading && !stocks.length" class="empty">当日无龙虎榜数据</div>
      </div>

      <!-- 右侧席位明细 / 席位跟庄统计 -->
      <div class="dt-right">
        <div v-if="seatLoading" class="loading seat-loading">席位统计加载中…</div>
        <template v-else>
        <!-- 跟庄统计视图 -->
        <div v-if="view === 'dept'" class="dept-wrap">
          <button class="back-btn" @click="backToSeat">‹ 返回个股席位</button>
          <div class="dept-head">
            <b class="dept-name" :title="seatBack?.name">{{ seatBack?.name || seatTrades?.name }}</b>
            <em v-if="seatTag" class="tag" :class="tagClass(seatTag)">{{ seatTag }}</em>
          </div>

          <!-- 回测概况：胜率矩阵 -->
          <div class="sec-title">上榜后表现回测</div>
          <div class="back-table">
            <div class="bt-row bt-head">
              <span class="bt-cycle">周期</span>
              <span v-for="(h, i) in horizonLabels" :key="i" class="bt-cell">{{ h }}</span>
            </div>
            <div v-for="r in seatBack?.rows" :key="r.cycle" class="bt-row">
              <span class="bt-cycle">{{ r.cycle }}</span>
              <span v-for="hk in horizons" :key="hk" class="bt-cell">
                <template v-if="r[hk].times > 0">
                  <b :class="pctCls(r[hk].avg)">{{ r[hk].avg > 0 ? "+" : "" }}{{ r[hk].avg.toFixed(2) }}%</b>
                  <i class="prob">胜率 {{ r[hk].prob.toFixed(0) }}%</i>
                  <i class="times">{{ r[hk].times }} 次</i>
                </template>
                <i v-else class="no">—</i>
              </span>
            </div>
          </div>
          <div v-if="!seatBack?.rows.length" class="mini-empty">该席位暂无回测数据</div>

          <!-- 历史上榜明细 -->
          <div class="sec-title">
            历史上榜明细
            <span class="sec-sub" v-if="seatTrades">共 {{ seatTrades.total }} 次</span>
          </div>
          <div class="tr-table">
            <div class="tr-row tr-head">
              <span class="c-date">日期</span>
              <span class="c-stock">股票</span>
              <span class="c-pct">当日</span>
              <span class="c-net">净额</span>
              <span class="c-d">后1日</span>
              <span class="c-d">后2日</span>
              <span class="c-d">后3日</span>
              <span class="c-d">后5日</span>
            </div>
            <div v-for="(t, i) in seatTrades?.trades" :key="i" class="tr-row">
              <span class="c-date">{{ t.date.slice(5) }}</span>
              <span class="c-stock">
                <span class="stock-link" @click="selectStock(t.code)">{{ t.name }}</span>
                <i class="c-code">{{ t.code }}</i>
              </span>
              <span class="c-pct" :class="pctCls(t.pct)">{{ t.pct > 0 ? "+" : "" }}{{ t.pct.toFixed(1) }}</span>
              <span class="c-net" :class="pctCls(t.net)">{{ money(t.net) }}</span>
              <span class="c-d" :class="pctCls(t.d1)">{{ t.d1 == null ? "—" : (t.d1 > 0 ? "+" : "") + t.d1.toFixed(1) }}</span>
              <span class="c-d" :class="pctCls(t.d2)">{{ t.d2 == null ? "—" : (t.d2 > 0 ? "+" : "") + t.d2.toFixed(1) }}</span>
              <span class="c-d" :class="pctCls(t.d3)">{{ t.d3 == null ? "—" : (t.d3 > 0 ? "+" : "") + t.d3.toFixed(1) }}</span>
              <span class="c-d" :class="pctCls(t.d5)">{{ t.d5 == null ? "—" : (t.d5 > 0 ? "+" : "") + t.d5.toFixed(1) }}</span>
            </div>
          </div>
          <div v-if="seatTrades && seatTrades.trades.length < seatTrades.total" class="more-wrap">
            <button class="more-btn" @click="moreSeat">
              加载更多（已显示 {{ seatTrades.trades.length }} / {{ seatTrades.total }}）
            </button>
          </div>
        </div>

        <!-- 席位明细视图 -->
        <div v-else-if="detail" class="detail-wrap">
          <div class="d-head">
            <b class="d-name">{{ detail.name }}</b>
            <span class="d-code">{{ detail.code }}</span>
            <span class="d-pct" :class="pctCls(detail.pct)">
              {{ detail.pct > 0 ? "+" : "" }}{{ detail.pct.toFixed(2) }}%
            </span>
            <span class="d-date">{{ detail.date }}</span>
          </div>

          <div v-for="(g, gi) in detail.groups" :key="gi" class="grp">
            <div class="grp-title">{{ g.reason }}</div>
            <div class="seat-grid head">
              <span>营业部</span><span>买入额</span><span>卖出额</span><span>净额</span>
            </div>
            <div
              v-for="(s, i) in g.buyers"
              :key="'b' + i"
              class="seat-grid"
              :class="{ first: i === 0 }"
            >
              <span class="sn">
                <i class="rank buy-rank">买{{ i + 1 }}</i>
                <span class="sn-name seat-link" :title="s.name + '（点击查看该席位上榜后表现）'" @click.stop="openSeat(s)">{{ s.name }}</span>
                <em v-if="s.tag" class="tag" :class="tagClass(s.tag)">{{ s.tag }}</em>
              </span>
              <span class="amt up">{{ money(s.buy) }}</span>
              <span class="amt dim">{{ money(s.sell) }}</span>
              <span class="amt" :class="pctCls(s.net)">{{ money(s.net) }}</span>
            </div>
            <div
              v-for="(s, i) in g.sellers"
              :key="'s' + i"
              class="seat-grid"
              :class="{ first: i === 0 }"
            >
              <span class="sn">
                <i class="rank sell-rank">卖{{ i + 1 }}</i>
                <span class="sn-name seat-link" :title="s.name + '（点击查看该席位上榜后表现）'" @click.stop="openSeat(s)">{{ s.name }}</span>
                <em v-if="s.tag" class="tag" :class="tagClass(s.tag)">{{ s.tag }}</em>
              </span>
              <span class="amt dim">{{ money(s.buy) }}</span>
              <span class="amt down">{{ money(s.sell) }}</span>
              <span class="amt" :class="pctCls(s.net)">{{ money(s.net) }}</span>
            </div>
          </div>
        </div>
        <div v-else class="empty">点击左侧个股查看买卖席位</div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dt {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-dim);
  font-size: 12px;
}
.loading {
  padding: 12px;
  text-align: center;
  color: var(--text-dim);
  font-size: 12px;
}

/* 工具栏 */
.dt-bar {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 7px 10px;
  border-bottom: 1px solid var(--border);
}
.nav-btn {
  width: 24px;
  height: 22px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: transparent;
  color: var(--text);
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
}
.nav-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.dt-date {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  min-width: 92px;
  text-align: center;
}
.refresh {
  width: 24px;
  height: 22px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
}
.refresh:hover {
  color: var(--accent);
  border-color: var(--accent);
}
.sort-switch {
  margin-left: auto;
  display: flex;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
}
.sort-switch button {
  border: 0;
  background: transparent;
  color: var(--text-dim);
  font-size: 11px;
  padding: 3px 9px;
  cursor: pointer;
}
.sort-switch button.on {
  background: color-mix(in srgb, var(--accent) 18%, transparent);
  color: var(--accent);
}

/* 统计条 */
.dt-stat {
  display: flex;
  gap: 16px;
  padding: 6px 12px;
  font-size: 11px;
  color: var(--text-dim);
  border-bottom: 1px solid var(--border);
}
.dt-stat b {
  font-size: 12px;
  color: var(--text);
}

/* 主体 */
.dt-body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 40% 60%;
}
.dt-left {
  border-right: 1px solid var(--border);
  overflow-y: auto;
}
.dt-right {
  overflow-y: auto;
}

/* 个股行 */
.stock-row {
  padding: 7px 10px;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
  transition: background 0.13s;
}
.stock-row:hover {
  background: var(--bg-hover);
}
.stock-row.active {
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  box-shadow: inset 3px 0 0 var(--accent);
}
.sr-top {
  display: flex;
  align-items: center;
  gap: 7px;
}
.sr-code {
  font-size: 11px;
  color: var(--text-dim);
}
.sr-name {
  font-size: 13px;
  font-weight: 700;
}
.sr-pct {
  margin-left: auto;
  font-size: 12px;
  font-weight: 600;
}
.sr-mid {
  display: flex;
  gap: 14px;
  margin-top: 2px;
  font-size: 11px;
}
.sr-net {
  font-weight: 600;
}
.sr-deal {
  color: var(--text-dim);
}
.sr-reasons {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
}
.sr-reasons i {
  font-style: normal;
  font-size: 9.5px;
  color: var(--text-dim);
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 1px 5px;
}

/* 右侧详情 */
.detail-wrap {
  padding: 8px 10px 14px;
}
.d-head {
  display: flex;
  align-items: center;
  gap: 9px;
  padding-bottom: 7px;
  border-bottom: 1px solid var(--border);
}
.d-name {
  font-size: 15px;
}
.d-code {
  font-size: 11px;
  color: var(--text-dim);
}
.d-pct {
  font-size: 13px;
  font-weight: 600;
}
.d-date {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-dim);
}

.grp {
  margin-top: 10px;
}
.grp-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 9%, transparent);
  border-radius: 6px;
  padding: 4px 8px;
  margin-bottom: 4px;
}
.seat-grid {
  display: grid;
  grid-template-columns: 1fr 62px 62px 62px;
  align-items: center;
  gap: 4px;
  padding: 4px 6px;
  border-radius: 5px;
  font-size: 11px;
}
.seat-grid.head {
  color: var(--text-dim);
  font-size: 10px;
}
.seat-grid.first {
  background: color-mix(in srgb, var(--accent) 6%, transparent);
}
.sn {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
}
.rank {
  font-style: normal;
  font-size: 9.5px;
  border-radius: 4px;
  padding: 1px 4px;
  flex: none;
}
.buy-rank {
  color: #ff6b6b;
  background: rgba(255, 50, 50, 0.12);
}
.sell-rank {
  color: #2fd6a0;
  background: rgba(29, 190, 125, 0.12);
}
.sn-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.amt {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.amt.dim {
  color: var(--text-dim);
}

/* 席位标签 */
.tag {
  font-style: normal;
  font-size: 9px;
  border-radius: 4px;
  padding: 1px 5px;
  flex: none;
}
.t-hot { color: #e8c878; background: rgba(232,200,120,.14); }
.t-org { color: #6aa6e8; background: rgba(106,166,232,.14); }
.t-north { color: #b48de8; background: rgba(180,141,232,.15); }
.t-quant { color: #54d2d2; background: rgba(84,210,210,.13); }
.t-lasa { color: #e8a45a; background: rgba(232,164,90,.14); }

/* 席位名可点击 */
.seat-link {
  cursor: pointer;
}
.seat-link:hover {
  color: var(--accent);
  text-decoration: underline;
  text-underline-offset: 2px;
}
.seat-loading {
  padding-top: 48px;
}

/* 跟庄统计面板 */
.dept-wrap {
  padding: 8px 10px 16px;
}
.back-btn {
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-dim);
  border-radius: 6px;
  font-size: 11px;
  padding: 3px 10px;
  cursor: pointer;
  margin-bottom: 8px;
}
.back-btn:hover {
  color: var(--accent);
  border-color: var(--accent);
}
.dept-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border);
}
.dept-name {
  font-size: 13px;
  line-height: 1.3;
}
.sec-title {
  margin-top: 12px;
  font-size: 11px;
  font-weight: 700;
  color: var(--text);
  display: flex;
  align-items: center;
  gap: 7px;
}
.sec-title::before {
  content: "";
  width: 3px;
  height: 11px;
  border-radius: 2px;
  background: var(--accent);
}
.sec-sub {
  font-size: 10px;
  font-weight: 400;
  color: var(--text-dim);
}

/* 回测胜率矩阵 */
.back-table {
  margin-top: 6px;
  border: 1px solid var(--border);
  border-radius: 7px;
  overflow: hidden;
}
.bt-row {
  display: grid;
  grid-template-columns: 50px repeat(5, 1fr);
}
.bt-row + .bt-row {
  border-top: 1px solid var(--border);
}
.bt-head {
  background: var(--bg-card);
}
.bt-head span {
  font-size: 9.5px;
  color: var(--text-dim);
}
.bt-cycle {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  color: var(--text-dim);
  padding: 5px 4px;
}
.bt-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
  padding: 5px 3px;
  border-left: 1px solid var(--border);
}
.bt-cell b {
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.bt-cell .prob {
  font-style: normal;
  font-size: 9px;
  color: var(--text);
  font-variant-numeric: tabular-nums;
}
.bt-cell .times {
  font-style: normal;
  font-size: 8.5px;
  color: var(--text-dim);
}
.bt-cell .no {
  font-style: normal;
  color: var(--text-dim);
}
.mini-empty {
  margin-top: 8px;
  font-size: 10.5px;
  color: var(--text-dim);
  text-align: center;
}

/* 历史上榜明细表 */
.tr-table {
  margin-top: 6px;
  border: 1px solid var(--border);
  border-radius: 7px;
  overflow: hidden;
}
.tr-row {
  display: grid;
  grid-template-columns: 38px minmax(64px, 1fr) 42px 44px repeat(4, 39px);
  align-items: center;
}
.tr-row + .tr-row {
  border-top: 1px solid var(--border);
}
.tr-row:hover {
  background: var(--bg-hover);
}
.tr-row > span,
.tr-row > i {
  padding: 3.5px 3px;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}
.c-date {
  text-align: center;
  color: var(--text-dim);
}
.c-stock {
  display: flex;
  flex-direction: column;
  text-align: left;
  line-height: 1.25;
}
.stock-link {
  cursor: pointer;
  font-weight: 600;
  font-size: 10.5px;
  color: var(--text);
  width: fit-content;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.stock-link:hover {
  color: var(--accent);
}
.c-code {
  font-style: normal;
  font-size: 8.5px;
  color: var(--text-dim);
}
.c-pct,
.c-net,
.c-d {
  text-align: right;
  font-weight: 500;
}
.tr-head .c-date {
  text-align: center;
}
.tr-head .c-stock {
  text-align: left;
}
.more-wrap {
  margin-top: 8px;
  text-align: center;
}
.more-btn {
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-dim);
  border-radius: 6px;
  font-size: 10.5px;
  padding: 5px 14px;
  cursor: pointer;
}
.more-btn:hover {
  color: var(--accent);
  border-color: var(--accent);
}

.up { color: var(--up); }
.down { color: var(--down); }
</style>
