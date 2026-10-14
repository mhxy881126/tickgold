<template>
  <div class="bt">
    <!-- 左：参数面板 -->
    <div class="bt-side">
      <div class="bt-side-title">回测参数</div>
      <label class="bt-f">
        <span>标的代码</span>
        <textarea v-model="codesText" rows="3" placeholder="逗号/换行分隔，如 600000,000001"></textarea>
      </label>
      <div class="bt-frow">
        <label class="bt-f">
          <span>开始</span>
          <input v-model="form.start" type="date" />
        </label>
        <label class="bt-f">
          <span>结束</span>
          <input v-model="form.end" type="date" />
        </label>
      </div>
      <label class="bt-f">
        <span>基准指数</span>
        <input v-model="form.benchmark" placeholder="000300（可空）" />
      </label>
      <div class="bt-frow">
        <label class="bt-f">
          <span>买入门槛</span>
          <input v-model.number="form.buyThreshold" type="number" step="0.05" min="0" max="1" />
        </label>
        <label class="bt-f">
          <span>卖出门槛</span>
          <input v-model.number="form.sellThreshold" type="number" step="0.05" min="0" max="1" />
        </label>
      </div>
      <div class="bt-frow">
        <label class="bt-f">
          <span>最大持仓</span>
          <input v-model.number="form.maxPositions" type="number" min="1" max="20" />
        </label>
        <label class="bt-f">
          <span>单票仓位%</span>
          <input v-model.number="form.maxSinglePct" type="number" step="5" min="5" max="100" />
        </label>
      </div>
      <div class="bt-frow">
        <label class="bt-f">
          <span>参与率%</span>
          <input v-model.number="form.participationPct" type="number" step="1" min="1" max="100" />
        </label>
        <label class="bt-f">
          <span>滑点%</span>
          <input v-model.number="form.slippagePct" type="number" step="0.02" min="0" max="1" />
        </label>
      </div>
      <label class="bt-f">
        <span>初始资金</span>
        <input v-model.number="form.initCash" type="number" step="100000" min="10000" />
      </label>
      <label class="bt-f">
        <span>方案名称</span>
        <input v-model="form.name" placeholder="可选，便于归档" />
      </label>
      <button class="bt-run" :disabled="running" @click="run">
        {{ running ? "回测中…" : "运行回测" }}
      </button>
      <div v-if="err" class="bt-err">{{ err }}</div>
      <div class="bt-note">
        T 日收盘信号 → T+1 开盘成交；T+1 交收、涨跌停拦截、成交量参与率约束。
      </div>
    </div>

    <!-- 右：结果区 -->
    <div class="bt-main">
      <div class="bt-tabs">
        <button
          v-for="t in TABS"
          :key="t.k"
          :class="{ on: tab === t.k }"
          @click="switchTab(t.k)"
        >{{ t.label }}</button>
      </div>

      <!-- 绩效 + 图表 -->
      <div v-if="tab === 'result'" class="bt-pane">
        <template v-if="result">
          <div class="bt-stats">
            <div class="bt-stat" :class="pnlCls(result.stats.totalReturnPct)">
              <b>{{ pct(result.stats.totalReturnPct) }}</b><span>总收益</span>
            </div>
            <div class="bt-stat">
              <b>{{ pct(result.stats.annualReturnPct) }}</b><span>年化</span>
            </div>
            <div class="bt-stat" :class="pnlCls(result.stats.excessReturnPct)">
              <b>{{ pct(result.stats.excessReturnPct) }}</b><span>超额</span>
            </div>
            <div class="bt-stat down">
              <b>{{ pct(-result.stats.maxDrawdownPct) }}</b><span>最大回撤</span>
            </div>
            <div class="bt-stat">
              <b>{{ result.stats.sharpe.toFixed(2) }}</b><span>夏普</span>
            </div>
            <div class="bt-stat">
              <b>{{ pct(result.stats.winRatePct) }}</b><span>胜率</span>
            </div>
            <div class="bt-stat">
              <b>{{ result.stats.profitFactor.toFixed(2) }}</b><span>盈亏比</span>
            </div>
            <div class="bt-stat">
              <b>{{ result.stats.tradeCount }}</b><span>成交笔数</span>
            </div>
          </div>
          <div class="bt-chart">
            <div ref="chartEl" class="bt-canvas"></div>
          </div>
          <div class="bt-chartseg">
            <button
              v-for="c in CHARTS"
              :key="c.k"
              :class="{ on: chart === c.k }"
              @click="chart = c.k"
            >{{ c.label }}</button>
            <button class="bt-save" @click="save">保存结果</button>
            <button class="bt-csv" @click="exportCsv">导出CSV</button>
          </div>
        </template>
        <div v-else class="bt-empty">配置参数后运行回测；需已回填历史K线（多年历史K线库）</div>
      </div>

      <!-- 交易明细 -->
      <div v-else-if="tab === 'trades'" class="bt-pane">
        <div v-if="!result" class="bt-empty">尚无回测结果</div>
        <div v-else class="bt-tablewrap">
          <table class="bt-table">
            <thead>
              <tr>
                <th>日期</th><th>代码</th><th>名称</th><th>方向</th>
                <th class="r">价格</th><th class="r">数量</th><th class="r">金额</th>
                <th class="r">费用</th><th class="r">盈亏</th><th class="r">持仓天</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(t, i) in result.trades" :key="i">
                <td>{{ t.date }}</td>
                <td>{{ t.code }}</td>
                <td class="ellipsis">{{ t.name }}</td>
                <td :class="t.side === 'buy' ? 'buy' : 'sell'">
                  {{ t.side === "buy" ? "买入" : "卖出" }}
                </td>
                <td class="r">{{ t.price.toFixed(2) }}</td>
                <td class="r">{{ t.vol }}</td>
                <td class="r">{{ money(t.amount) }}</td>
                <td class="r">{{ money(t.fee) }}</td>
                <td class="r" :class="pnlCls(t.pnl)">{{ t.pnl ? signed(t.pnl) : "--" }}</td>
                <td class="r">{{ t.holdingDays || "--" }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- 存档与多方案对比 -->
      <div v-else-if="tab === 'saved'" class="bt-pane">
        <div class="bt-savedbar">
          <button class="bt-mini" @click="loadSaved">刷新列表</button>
          <span class="bt-hint">勾选至多 4 个方案叠加对比净值（归一为 1）</span>
        </div>
        <div class="bt-savedbody">
          <div class="bt-savedlist">
            <div
              v-for="m in saved"
              :key="m.id"
              class="bt-savedrow"
              :class="{ on: compareIds.includes(m.id) }"
              @click="toggleCompare(m.id)"
            >
              <input
                type="checkbox"
                :checked="compareIds.includes(m.id)"
                @click.stop="toggleCompare(m.id)"
              />
              <div class="bt-savedmeta">
                <div class="bt-savedname">{{ m.name || `方案#${m.id}` }}</div>
                <div class="bt-savedsub">{{ m.start }} → {{ m.end }}</div>
              </div>
              <div class="bt-savedpct" :class="pnlCls(m.totalReturnPct)">
                {{ pct(m.totalReturnPct) }}
              </div>
              <button class="bt-del" title="删除" @click.stop="remove(m.id)">×</button>
            </div>
            <div v-if="!saved.length" class="bt-empty">暂无存档</div>
          </div>
          <div class="bt-compare">
            <div ref="cmpEl" class="bt-canvas"></div>
          </div>
        </div>
      </div>

      <!-- Walk-forward 寻优 -->
      <div v-else-if="tab === 'optimize'" class="bt-pane">
        <div class="bt-optcfg">
          <label>
            训练窗
            <input v-model.number="opt.trainDays" type="number" min="60" step="10" />
          </label>
          <label>
            测试窗
            <input v-model.number="opt.testDays" type="number" min="20" step="10" />
          </label>
          <label class="grow">
            买入门槛网格
            <input v-model="thGridText" placeholder="0.5,0.6,0.7" />
          </label>
          <label class="grow">
            单因子权重网格（因子:值）
            <input v-model="wGridText" placeholder="rsi14:0.5,0.7; macdHist:0.6,1.0" />
          </label>
          <button class="bt-run sm" :disabled="opting" @click="optimize">
            {{ opting ? "寻优中…" : "Walk-forward" }}
          </button>
        </div>
        <div v-if="optErr" class="bt-err">{{ optErr }}</div>
        <template v-if="report">
          <div class="bt-stats">
            <div class="bt-stat">
              <b>{{ report.avgIsSharpe.toFixed(2) }}</b><span>样本内夏普</span>
            </div>
            <div class="bt-stat">
              <b>{{ report.avgOosSharpe.toFixed(2) }}</b><span>样本外夏普</span>
            </div>
            <div class="bt-stat" :class="pnlCls(report.oosCompoundPct)">
              <b>{{ pct(report.oosCompoundPct) }}</b><span>样本外累计</span>
            </div>
            <div class="bt-stat">
              <b>{{ report.comboCount }}</b><span>参数组合</span>
            </div>
          </div>
          <div class="bt-tablewrap opt-table">
            <table class="bt-table">
              <thead>
                <tr>
                  <th>训练区间</th><th>测试区间</th><th>选中门槛</th><th>选中权重</th>
                  <th class="r">训练夏普</th><th class="r">测试夏普</th><th class="r">测试收益</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(w, i) in report.windows" :key="i">
                  <td>{{ w.trainStart }} → {{ w.trainEnd }}</td>
                  <td>{{ w.testStart }} → {{ w.testEnd }}</td>
                  <td>{{ w.bestBuyThreshold.toFixed(2) }}</td>
                  <td>
                    {{ w.bestWeightFactor ? `${w.bestWeightFactor}=${w.bestWeightValue}` : "基线" }}
                  </td>
                  <td class="r">{{ w.trainSharpe.toFixed(2) }}</td>
                  <td class="r">{{ w.testSharpe.toFixed(2) }}</td>
                  <td class="r" :class="pnlCls(w.testReturnPct)">{{ pct(w.testReturnPct) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="bt-note">
            结论仅作调参参考，参数变更需人工确认后方可应用到实盘策略（进化回灌护栏）。
          </div>
          <div class="bt-propose">
            <label class="grow">
              调参权重 JSON（可手工编辑）
              <input v-model="proposeWeightsText" placeholder='{"rsi14":0.5}' />
            </label>
            <button class="bt-run sm" @click="createProposal">生成调参提案</button>
          </div>
        </template>
        <div v-else-if="!opting" class="bt-empty">
          滚动训练/测试窗分离，训练窗选夏普最优参数并在测试窗验证，防止过拟合。
        </div>
      </div>

      <!-- 调参审批 -->
      <div v-else-if="tab === 'approval'" class="bt-pane">
        <div class="bt-savedbar">
          <button class="bt-mini" @click="loadProposals">刷新</button>
          <span class="bt-hint">回测结论只生成待批提案；批准是权重写入实盘配置的唯一路径，可回滚</span>
        </div>
        <div class="bt-tablewrap">
          <table class="bt-table">
            <thead>
              <tr>
                <th>#</th><th>状态</th><th>权重</th><th>理由</th>
                <th>基线</th><th>创建时间</th><th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="p in proposals" :key="p.id">
                <td>{{ p.id }}</td>
                <td>
                  <span class="bt-status" :class="statusCls(p.status)">{{ statusLabel(p.status) }}</span>
                </td>
                <td class="ellipsis" style="max-width:220px">{{ weightsText(p.payload.weights) }}</td>
                <td class="ellipsis" style="max-width:160px">{{ p.payload.note || "--" }}</td>
                <td class="ellipsis" style="max-width:140px">{{ weightsText(p.baseline) || "空（内置权重）" }}</td>
                <td>{{ fmtTime(p.createdAt) }}</td>
                <td>
                  <button
                    v-if="p.status === 'pending'"
                    class="bt-mini ok"
                    @click="approveProposal(p.id)"
                  >批准</button>
                  <button
                    v-if="p.status === 'pending'"
                    class="bt-mini no"
                    @click="rejectProposal(p.id)"
                  >拒绝</button>
                  <button
                    v-if="p.status === 'approved'"
                    class="bt-mini"
                    @click="revertProposal(p.id)"
                  >回滚</button>
                </td>
              </tr>
            </tbody>
          </table>
          <div v-if="!proposals.length" class="bt-empty">暂无调参提案</div>
        </div>
      </div>
    </div>
  </div>
<ComplianceFooter />
</template>

<script setup lang="ts">
import ComplianceFooter from "../ComplianceFooter.vue";
import { nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import * as echarts from "echarts";
import {
  runBacktest,
  saveBacktest,
  listBacktests,
  loadBacktest,
  deleteBacktest,
  optimizeBacktest,
  createTuningProposal,
  listTuningProposals,
  approveTuningProposal,
  rejectTuningProposal,
  revertTuningProposal,
  type BacktestReq,
  type BacktestResult,
  type RunMeta,
  type OptimizeReport,
  type ProposalView,
} from "../../api/backtest";

type Tab = "result" | "trades" | "saved" | "optimize" | "approval";
type ChartKind = "equity" | "drawdown" | "monthly";

const TABS: { k: Tab; label: string }[] = [
  { k: "result", label: "绩效" },
  { k: "trades", label: "交易明细" },
  { k: "saved", label: "存档对比" },
  { k: "optimize", label: "参数寻优" },
  { k: "approval", label: "调参审批" },
];
const CHARTS: { k: ChartKind; label: string }[] = [
  { k: "equity", label: "净值/基准" },
  { k: "drawdown", label: "回撤" },
  { k: "monthly", label: "月度收益" },
];

const codesText = ref("600000");
const form = reactive({
  start: "2025-01-01",
  end: "2025-12-31",
  benchmark: "000300",
  buyThreshold: 0.6,
  sellThreshold: 0.6,
  maxPositions: 5,
  maxSinglePct: 20,
  participationPct: 10,
  slippagePct: 0,
  initCash: 1_000_000,
  name: "",
});

const tab = ref<Tab>("result");
const chart = ref<ChartKind>("equity");
const running = ref(false);
const err = ref("");
const result = ref<BacktestResult | null>(null);

let mainChart: echarts.ECharts | null = null;
let cmpChart: echarts.ECharts | null = null;
const chartEl = ref<HTMLElement | null>(null);
const cmpEl = ref<HTMLElement | null>(null);
let ro: ResizeObserver | null = null;

function parseCodes(): string[] {
  return codesText.value
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function run() {
  err.value = "";
  const codes = parseCodes();
  if (!codes.length) {
    err.value = "请至少填写一个标的代码";
    return;
  }
  if (!form.start || !form.end) {
    err.value = "请选择回测区间";
    return;
  }
  running.value = true;
  const req: BacktestReq = {
    codes,
    start: form.start,
    end: form.end,
    benchmark: form.benchmark.trim(),
    buyThreshold: form.buyThreshold,
    sellThreshold: form.sellThreshold,
    maxPositions: form.maxPositions,
    maxSinglePct: form.maxSinglePct,
    participationPct: form.participationPct,
    slippagePct: form.slippagePct,
    initCash: form.initCash,
    name: form.name.trim(),
  };
  try {
    result.value = await runBacktest(req);
    tab.value = "result";
    await nextTick();
    renderChart();
  } catch (e) {
    err.value = String((e as Error)?.message ?? e);
  } finally {
    running.value = false;
  }
}

async function save() {
  if (!result.value) return;
  try {
    const id = await saveBacktest(result.value);
    result.value.id = id;
    await loadSaved();
  } catch (e) {
    err.value = String((e as Error)?.message ?? e);
  }
}

function exportCsv() {
  if (!result.value) return;
  const rows = [
    "date,code,name,side,price,vol,amount,fee,pnl,holdingDays,confidence",
    ...result.value.trades.map((t) =>
      [
        t.date, t.code, t.name, t.side, t.price, t.vol, t.amount,
        t.fee, t.pnl, t.holdingDays, t.confidence,
      ].join(","),
    ),
  ];
  const blob = new Blob(["﻿", rows.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `backtest_${result.value.start}_${result.value.end}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ==================== 图表 ====================

function renderChart() {
  if (tab.value !== "result" || !result.value || !chartEl.value) return;
  if (!mainChart) mainChart = echarts.init(chartEl.value);
  const r = result.value;
  let option: echarts.EChartsOption;
  if (chart.value === "equity") {
    const base = r.equityCurve[0]?.equity ?? 1;
    option = {
      animation: false,
      tooltip: { trigger: "axis" },
      legend: { data: ["策略净值", "基准"], top: 0, textStyle: { fontSize: 10 } },
      grid: { left: 46, right: 14, top: 28, bottom: 24 },
      xAxis: {
        type: "category",
        data: r.equityCurve.map((p) => p.date),
        axisLabel: { fontSize: 10 },
      },
      yAxis: { type: "value", scale: true, axisLabel: { fontSize: 10 } },
      series: [
        {
          name: "策略净值", type: "line", showSymbol: false,
          data: r.equityCurve.map((p) => round3(p.equity / base)),
          lineStyle: { width: 1.8, color: "#1dbe7d" },
        },
        {
          name: "基准", type: "line", showSymbol: false,
          data: r.equityCurve.map((p) => round3(p.benchmark)),
          lineStyle: { width: 1.2, color: "#8a93a5", type: "dashed" },
        },
      ],
    };
  } else if (chart.value === "drawdown") {
    option = {
      animation: false,
      tooltip: { trigger: "axis", valueFormatter: (v) => `${v}%` },
      grid: { left: 46, right: 14, top: 16, bottom: 24 },
      xAxis: { type: "category", data: r.equityCurve.map((p) => p.date), axisLabel: { fontSize: 10 } },
      yAxis: { type: "value", axisLabel: { fontSize: 10, formatter: "{value}%" } },
      series: [
        {
          name: "回撤", type: "line", showSymbol: false,
          data: r.equityCurve.map((p) => round2(-p.drawdown)),
          lineStyle: { width: 1.4, color: "#ff5f57" },
          areaStyle: { color: "rgba(255,95,87,0.25)" },
        },
      ],
    };
  } else {
    option = {
      animation: false,
      tooltip: { trigger: "axis", valueFormatter: (v) => `${v}%` },
      grid: { left: 46, right: 14, top: 16, bottom: 40 },
      xAxis: {
        type: "category", data: r.monthly.map((m) => m.month),
        axisLabel: { fontSize: 10, rotate: 40 },
      },
      yAxis: { type: "value", axisLabel: { fontSize: 10, formatter: "{value}%" } },
      series: [
        {
          name: "月度收益", type: "bar",
          data: r.monthly.map((m) => ({
            value: round2(m.returnPct),
            itemStyle: { color: m.returnPct >= 0 ? "#ef5f6b" : "#08db94" },
          })),
        },
      ],
    };
  }
  mainChart.setOption(option, true);
}

watch(chart, () => renderChart());

// ==================== 存档对比 ====================

const saved = ref<RunMeta[]>([]);
const compareIds = ref<number[]>([]);
const compareCache = new Map<number, BacktestResult>();

async function loadSaved() {
  try {
    saved.value = await listBacktests();
  } catch (e) {
    err.value = String((e as Error)?.message ?? e);
  }
}

async function toggleCompare(id: number) {
  const i = compareIds.value.indexOf(id);
  if (i >= 0) {
    compareIds.value.splice(i, 1);
  } else {
    if (compareIds.value.length >= 4) return;
    compareIds.value.push(id);
    if (!compareCache.has(id)) {
      try {
        compareCache.set(id, await loadBacktest(id));
      } catch (e) {
        err.value = String((e as Error)?.message ?? e);
        compareIds.value.splice(compareIds.value.indexOf(id), 1);
        return;
      }
    }
  }
  await nextTick();
  renderCompare();
}

async function remove(id: number) {
  try {
    await deleteBacktest(id);
    compareCache.delete(id);
    const i = compareIds.value.indexOf(id);
    if (i >= 0) compareIds.value.splice(i, 1);
    await loadSaved();
    renderCompare();
  } catch (e) {
    err.value = String((e as Error)?.message ?? e);
  }
}

const CMP_COLORS = ["#1dbe7d", "#4ea1ff", "#ffb13d", "#b07cff"];

function renderCompare() {
  if (tab.value !== "saved" || !cmpEl.value) return;
  if (!cmpChart) cmpChart = echarts.init(cmpEl.value);
  if (!compareIds.value.length) {
    cmpChart.clear();
    return;
  }
  const series: echarts.SeriesOption[] = compareIds.value.map((id, ci) => {
    const r = compareCache.get(id)!;
    const base = r.equityCurve[0]?.equity ?? 1;
    return {
      name: r.name || `方案#${id}`,
      type: "line",
      showSymbol: false,
      data: r.equityCurve.map((p) => [p.date, round3(p.equity / base)]),
      lineStyle: { width: 1.6, color: CMP_COLORS[ci] },
    };
  });
  cmpChart.setOption(
    {
      animation: false,
      tooltip: { trigger: "axis" },
      legend: { top: 0, textStyle: { fontSize: 10 } },
      grid: { left: 46, right: 14, top: 28, bottom: 24 },
      xAxis: { type: "time", axisLabel: { fontSize: 10 } },
      yAxis: { type: "value", scale: true, axisLabel: { fontSize: 10 } },
      series,
    },
    true,
  );
}

// ==================== Walk-forward 寻优 ====================

const opt = reactive({ trainDays: 250, testDays: 60 });
const thGridText = ref("0.5,0.6,0.7");
const wGridText = ref("");
const opting = ref(false);
const optErr = ref("");
const report = ref<OptimizeReport | null>(null);

async function optimize() {
  optErr.value = "";
  const codes = parseCodes();
  if (!codes.length) {
    optErr.value = "请至少填写一个标的代码";
    return;
  }
  const buyThresholdGrid = thGridText.value
    .split(/[,，\s]+/)
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  const weightGrids: Record<string, number[]> = {};
  for (const part of wGridText.value.split(";")) {
    const [factor, vals] = part.split(":");
    const f = factor?.trim();
    const nums = vals
      ?.split(/[,，\s]+/)
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n));
    if (f && nums?.length) weightGrids[f] = nums;
  }
  opting.value = true;
  try {
    report.value = await optimizeBacktest({
      base: {
        codes,
        start: form.start,
        end: form.end,
        benchmark: form.benchmark.trim(),
        sellThreshold: form.sellThreshold,
        maxPositions: form.maxPositions,
        maxSinglePct: form.maxSinglePct,
        participationPct: form.participationPct,
        slippagePct: form.slippagePct,
        initCash: form.initCash,
        name: form.name.trim(),
      },
      trainDays: opt.trainDays,
      testDays: opt.testDays,
      buyThresholdGrid,
      weightGrids,
      maxCombos: 48,
    });
  } catch (e) {
    optErr.value = String((e as Error)?.message ?? e);
  } finally {
    opting.value = false;
  }
}

// ==================== 调参提案审批 ====================

const proposeWeightsText = ref("");
const proposals = ref<ProposalView[]>([]);

async function createProposal() {
  optErr.value = "";
  let weights: Record<string, number>;
  try {
    weights = JSON.parse(proposeWeightsText.value || "{}");
  } catch {
    optErr.value = "权重 JSON 解析失败";
    return;
  }
  if (!weights || typeof weights !== "object" || !Object.keys(weights).length) {
    optErr.value = "请填写至少一个因子权重";
    return;
  }
  const note = report.value
    ? `walk-forward: 样本内夏普 ${report.value.avgIsSharpe} → 样本外 ${report.value.avgOosSharpe}`
    : "";
  try {
    await createTuningProposal(result.value?.id ?? null, { weights, note });
    await loadProposals();
    tab.value = "approval";
  } catch (e) {
    optErr.value = String((e as Error)?.message ?? e);
  }
}

async function loadProposals() {
  try {
    proposals.value = await listTuningProposals();
  } catch (e) {
    err.value = String((e as Error)?.message ?? e);
  }
}

async function approveProposal(id: number) {
  try {
    await approveTuningProposal(id);
    await loadProposals();
  } catch (e) {
    err.value = String((e as Error)?.message ?? e);
  }
}
async function rejectProposal(id: number) {
  try {
    await rejectTuningProposal(id);
    await loadProposals();
  } catch (e) {
    err.value = String((e as Error)?.message ?? e);
  }
}
async function revertProposal(id: number) {
  try {
    await revertTuningProposal(id);
    await loadProposals();
  } catch (e) {
    err.value = String((e as Error)?.message ?? e);
  }
}

function weightsText(w: Record<string, number>): string {
  return Object.entries(w)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
}
function statusLabel(s: string): string {
  return { pending: "待批", approved: "已批准", rejected: "已拒绝", reverted: "已回滚" }[s] ?? s;
}
function statusCls(s: string): string {
  return { pending: "pending", approved: "approved", rejected: "rejected", reverted: "reverted" }[s] ?? "";
}
function fmtTime(ms: number): string {
  return ms ? new Date(ms).toLocaleString("zh-CN", { hour12: false }) : "--";
}

// ==================== 标签切换 / 生命周期 ====================

async function switchTab(t: Tab) {
  tab.value = t;
  await nextTick();
  if (t === "result") renderChart();
  if (t === "saved") {
    if (!saved.value.length) await loadSaved();
    renderCompare();
  }
  if (t === "approval" && !proposals.value.length) await loadProposals();
}

function pct(v?: number | null): string {
  if (v === undefined || v === null || Number.isNaN(v)) return "--";
  return `${v >= 0 ? "" : ""}${v.toFixed(2)}%`;
}
function signed(v: number): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}`;
}
function money(v: number): string {
  return v.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}
function pnlCls(v?: number | null): string {
  if (!v) return "";
  return v > 0 ? "up" : "down";
}
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

onMounted(() => {
  ro = new ResizeObserver(() => {
    mainChart?.resize();
    cmpChart?.resize();
  });
  if (chartEl.value) ro.observe(chartEl.value);
  if (cmpEl.value) ro.observe(cmpEl.value);
  loadSaved();
});

watch(tab, async () => {
  await nextTick();
  if (tab.value === "result" && chartEl.value) {
    mainChart ??= echarts.init(chartEl.value);
    renderChart();
  }
  if (tab.value === "saved" && cmpEl.value) {
    cmpChart ??= echarts.init(cmpEl.value);
    renderCompare();
  }
});

onBeforeUnmount(() => {
  ro?.disconnect();
  mainChart?.dispose();
  cmpChart?.dispose();
  mainChart = null;
  cmpChart = null;
});
</script>

<style scoped>
.bt {
  flex: 1;
  min-height: 0;
  display: flex;
  font-size: 12px;
}

/* 左侧参数 */
.bt-side {
  width: 236px;
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 10px;
  overflow: auto;
  border-right: 1px solid var(--border, #232a3a);
}
.bt-side-title { font-weight: 700; font-size: 13px; margin-bottom: 2px; }
.bt-f { display: flex; flex-direction: column; gap: 3px; flex: 1; }
.bt-f > span { color: var(--text-dim, #8892a8); font-size: 11px; }
.bt-f input,
.bt-f textarea {
  width: 100%;
  padding: 4px 6px;
  border-radius: 6px;
  border: 1px solid var(--border, #2a3344);
  background: rgba(255, 255, 255, 0.04);
  color: var(--text, #e6ecf5);
  font-size: 11px;
  resize: vertical;
}
.bt-f textarea { font-family: inherit; }
.bt-frow { display: flex; gap: 8px; }
.bt-run {
  margin-top: 4px;
  padding: 7px;
  border-radius: 8px;
  border: 1px solid rgba(29, 190, 125, 0.4);
  background: rgba(29, 190, 125, 0.16);
  color: #2fe6a4;
  font-weight: 700;
  cursor: pointer;
}
.bt-run.sm { margin: 0; padding: 6px 14px; }
.bt-run:disabled { opacity: 0.5; cursor: default; }
.bt-err { color: #ff6b78; font-size: 11px; word-break: break-all; }
.bt-note { font-size: 10px; color: var(--text-dim, #5a647c); line-height: 1.5; }

/* 右侧 */
.bt-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.bt-tabs {
  display: flex;
  gap: 4px;
  padding: 8px 10px 0;
  border-bottom: 1px solid var(--border, #232a3a);
}
.bt-tabs button {
  padding: 5px 14px;
  background: transparent;
  border: none;
  color: var(--text-dim, #8892a8);
  cursor: pointer;
  font-size: 12px;
  border-bottom: 2px solid transparent;
}
.bt-tabs button.on { color: #2fe6a4; border-bottom-color: #1dbe7d; }
.bt-pane { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 10px; gap: 8px; }
.bt-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-dim, #667088);
  text-align: center;
  padding: 20px;
}

/* 绩效读数 */
.bt-stats {
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  gap: 6px;
  flex: none;
}
.bt-stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 8px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.03);
}
.bt-stat b { font-size: 14px; font-variant-numeric: tabular-nums; }
.bt-stat span { font-size: 10px; color: var(--text-dim, #8892a8); }
.bt-stat.up b { color: #ff6b78; }
.bt-stat.down b { color: #26d07c; }

/* 图表 */
.bt-chart { flex: 1; min-height: 160px; position: relative; }
.bt-canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
.bt-chartseg { display: flex; gap: 6px; align-items: center; flex: none; }
.bt-chartseg button {
  padding: 3px 10px;
  border-radius: 6px;
  border: 1px solid var(--border, #2a3344);
  background: transparent;
  color: var(--text-dim, #8892a8);
  cursor: pointer;
  font-size: 11px;
}
.bt-chartseg button.on { background: rgba(29, 190, 125, 0.16); color: #2fe6a4; border-color: rgba(29,190,125,0.4); }
.bt-save { margin-left: auto; }
.bt-save,
.bt-csv { color: var(--text, #cbd3e2) !important; }

/* 表格 */
.bt-tablewrap { flex: 1; min-height: 0; overflow: auto; }
.bt-table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
.bt-table th {
  position: sticky;
  top: 0;
  padding: 5px 8px;
  font-size: 10px;
  color: var(--text-dim, #8892a8);
  text-align: left;
  background: var(--bg-card, #15181f);
  white-space: nowrap;
}
.bt-table td { padding: 4px 8px; font-size: 11px; white-space: nowrap; }
.bt-table tbody tr:hover { background: rgba(255, 255, 255, 0.03); }
.r { text-align: right; }
.ellipsis { max-width: 140px; overflow: hidden; text-overflow: ellipsis; }
.buy { color: #ff6b78; }
.sell { color: #26d07c; }
.up { color: #ff6b78; }
.down { color: #26d07c; }

/* 存档对比 */
.bt-savedbar { display: flex; gap: 10px; align-items: center; flex: none; }
.bt-mini {
  padding: 4px 12px;
  border-radius: 6px;
  border: 1px solid var(--border, #2a3344);
  background: rgba(255, 255, 255, 0.05);
  color: var(--text, #cbd3e2);
  cursor: pointer;
  font-size: 11px;
}
.bt-hint { color: var(--text-dim, #8892a8); font-size: 11px; }
.bt-savedbody { flex: 1; min-height: 0; display: flex; gap: 10px; }
.bt-savedlist { width: 280px; flex: none; overflow: auto; display: flex; flex-direction: column; gap: 4px; }
.bt-savedrow {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.03);
  cursor: pointer;
}
.bt-savedrow.on { outline: 1px solid rgba(29, 190, 125, 0.5); }
.bt-savedmeta { flex: 1; min-width: 0; }
.bt-savedname { font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bt-savedsub { font-size: 10px; color: var(--text-dim, #8892a8); }
.bt-savedpct { font-size: 11px; font-variant-numeric: tabular-nums; }
.bt-del {
  width: 20px; height: 20px;
  border: none; background: transparent;
  color: var(--text-dim, #8892a8);
  cursor: pointer; font-size: 14px; line-height: 1;
}
.bt-del:hover { color: #ff6b78; }
.bt-compare { flex: 1; min-width: 0; position: relative; }

/* 寻优 */
.bt-optcfg {
  display: flex;
  align-items: flex-end;
  gap: 10px;
  flex-wrap: wrap;
  flex: none;
}
.bt-optcfg label {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 11px;
  color: var(--text-dim, #8892a8);
}
.bt-optcfg label.grow { flex: 1; min-width: 200px; }
.bt-optcfg input {
  padding: 5px 8px;
  border-radius: 6px;
  border: 1px solid var(--border, #2a3344);
  background: rgba(255, 255, 255, 0.04);
  color: var(--text, #e6ecf5);
  font-size: 11px;
}
.opt-table { flex: none; max-height: 46%; }

/* 提案审批 */
.bt-propose { display: flex; align-items: flex-end; gap: 10px; flex: none; }
.bt-status {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 10px;
  font-size: 10px;
}
.bt-status.pending { background: rgba(255, 177, 61, 0.18); color: #ffb13d; }
.bt-status.approved { background: rgba(29, 190, 125, 0.18); color: #2fe6a4; }
.bt-status.rejected,
.bt-status.reverted { background: rgba(107, 115, 134, 0.2); color: #9aa3b6; }
.bt-mini.ok { color: #2fe6a4; border-color: rgba(29, 190, 125, 0.4); }
.bt-mini.no { color: #ff6b78; border-color: rgba(255, 107, 120, 0.4); }
</style>
