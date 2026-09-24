<script setup lang="ts">
import { ref, reactive } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { fetchRankPage, fetchKLine } from "../api/market";
import { useWatchlistStore } from "../stores/watchlist";
import { usePaperStore } from "../stores/paper";
import { db, ensureDb } from "../db/database";

const props = defineProps<{ code: string | null }>();

const wl = useWatchlistStore();
const paper = usePaperStore();

const sel = reactive({
  watch: true,
  rank: false,
  kline: false,
  pos: false,
  orders: false,
  journal: false,
  alert: false,
});
const items = [
  { key: "watch", label: "自选股列表", desc: "全部分组与股票" },
  { key: "rank", label: "涨幅榜 TOP100", desc: "实时行情榜单" },
  { key: "kline", label: "当前股票日K", desc: props.code ? props.code : "需先选中股票" },
  { key: "pos", label: "模拟持仓", desc: "当前持仓明细" },
  { key: "orders", label: "成交流水", desc: "全部委托成交记录" },
  { key: "journal", label: "盯盘日记", desc: "复盘日记" },
  { key: "alert", label: "预警列表", desc: "价格/涨跌幅预警" },
] as const;

const fmt = ref<"csv" | "json">("csv");
const busy = ref(false);
const msg = ref("");
const ok = ref(false);

const pad2 = (n: number) => String(n).padStart(2, "0");
function stamp() {
  const d = new Date();
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}`;
}

// ---- CSV 工具 ----
function cell(v: any): string {
  if (v == null) return "";
  let s = String(v);
  if (/[",\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function toCSV(rows: any[]): string {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  const out = [cols.join(",")];
  for (const r of rows) out.push(cols.map((c) => cell(r[c])).join(","));
  return out.join("\r\n");
}
function klineDate(ts: number) {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

// ---- 汇总各数据源 ----
async function gather(): Promise<{ title: string; rows: any[] }[]> {
  const sec: { title: string; rows: any[] }[] = [];

  if (sel.watch) {
    sec.push({
      title: "自选股",
      rows: wl.stocks.map((s) => ({
        代码: s.code,
        名称: s.name,
        所属分组: wl.groups.find((g) => g.id === s.groupId)?.name ?? "",
        组内排序: s.sortOrder,
      })),
    });
  }

  if (sel.rank) {
    const list = await fetchRankPage("gainers", 1, 100);
    sec.push({
      title: "涨幅榜TOP100",
      rows: list.map((q) => ({
        代码: q.code, 名称: q.name, 现价: q.price, 涨跌幅: q.pct,
        涨跌额: q.change, 成交额: q.amount, 成交量: q.volume, 换手率: q.turnover,
      })),
    });
  }

  if (sel.kline && props.code) {
    const bars = await fetchKLine(props.code, 101, 500);
    sec.push({
      title: `${props.code}日K`,
      rows: bars.map((b) => ({
        日期: klineDate(b.timestamp), 开盘: b.open, 最高: b.high,
        最低: b.low, 收盘: b.close, 成交量: b.volume,
      })),
    });
  }

  if (sel.pos) {
    sec.push({
      title: "模拟持仓",
      rows: paper.positions.map((p) => ({
        代码: p.code, 名称: p.name, 持仓股数: p.vol, 可用股数: p.availVol,
        成本额: p.costAmount, 成本价: p.vol ? p.costAmount / p.vol : 0,
      })),
    });
  }

  if (sel.orders) {
    sec.push({
      title: "成交流水",
      rows: paper.orders.map((o) => ({
        日期: o.tradeDate, 流水号: o.id, 代码: o.code, 名称: o.name,
        方向: o.side === "buy" ? "买入" : "卖出", 价格: o.price, 数量: o.vol,
        金额: o.amount, 费用: o.fee, 状态: o.status,
      })),
    });
  }

  if (sel.journal) {
    try {
      await ensureDb();
      const rows = await db().select<any[]>(
        "SELECT date,title,content,mood,tags,code FROM journal ORDER BY created_at DESC"
      );
      sec.push({ title: "盯盘日记", rows });
    } catch {
      sec.push({ title: "盯盘日记", rows: [] });
    }
  }

  if (sel.alert) {
    try {
      await ensureDb();
      const rows = await db().select<any[]>(
        "SELECT id,code,name,up_price,down_price,up_pct,down_pct,cooldown_sec,enabled FROM alerts"
      );
      sec.push({ title: "预警列表", rows });
    } catch {
      sec.push({ title: "预警列表", rows: [] });
    }
  }

  return sec;
}

async function doExport() {
  if (!Object.values(sel).some(Boolean)) {
    ok.value = false; msg.value = "请至少选择一项导出内容";
    return;
  }
  busy.value = true; ok.value = false; msg.value = "正在汇总数据…";
  try {
    const sections = (await gather()).filter((s) => s.rows.length);
    if (!sections.length) {
      msg.value = "所选内容暂无数据";
      busy.value = false;
      return;
    }
    const t = stamp();
    if (fmt.value === "json") {
      const payload = {
        app: "TickGold",
        exportedAt: new Date().toISOString(),
        sections: sections.map((s) => ({ title: s.title, count: s.rows.length, data: s.rows })),
      };
      await invoke("save_export_file", {
        defaultName: `tickgold_${t}.json`,
        content: JSON.stringify(payload, null, 2),
      });
    } else {
      let content = "";
      for (const s of sections) {
        content += `# ${s.title}（${s.rows.length} 条）\r\n`;
        content += toCSV(s.rows) + "\r\n\r\n";
      }
      content = "\uFEFF" + content; // BOM，让 Excel 正确识别 UTF-8 中文
      await invoke("save_export_file", {
        defaultName: `tickgold_${t}.csv`,
        content,
      });
    }
    ok.value = true;
    msg.value = `已保存 ${sections.reduce((a, s) => a + s.rows.length, 0)} 条记录`;
  } catch (e: any) {
    const m = e?.message || String(e);
    ok.value = false;
    msg.value = m.includes("取消") ? "已取消保存" : "导出失败：" + m;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="de">
    <div class="de-sec-title">选择导出内容</div>
    <div class="opt-list">
      <label v-for="it in items" :key="it.key" class="opt" :class="{ off: it.key === 'kline' && !code }">
        <input v-model="sel[it.key]" type="checkbox" :disabled="it.key === 'kline' && !code" />
        <span class="opt-label">{{ it.label }}</span>
        <span class="opt-desc">{{ it.desc }}</span>
      </label>
    </div>

    <div class="de-sec-title">导出格式</div>
    <div class="fmt-row">
      <button class="fmt-btn" :class="{ on: fmt === 'csv' }" @click="fmt = 'csv'">
        <b>CSV</b><span>表格 / Excel</span>
      </button>
      <button class="fmt-btn" :class="{ on: fmt === 'json' }" @click="fmt = 'json'">
        <b>JSON</b><span>结构化数据</span>
      </button>
    </div>

    <button class="export-btn" :disabled="busy" @click="doExport">
      {{ busy ? "处理中…" : "选择位置并导出" }}
    </button>
    <div v-if="msg" class="msg" :class="{ good: ok, bad: !ok }">{{ msg }}</div>
    <div class="tip">点击后弹出系统保存框，可自由选择保存位置与文件名。</div>
  </div>
</template>

<style scoped>
.de {
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 12px;
  overflow-y: auto;
  background: var(--bg-card);
  color: var(--text);
  font-size: 12px;
  gap: 6px;
}
.de-sec-title {
  font-size: 11px;
  color: var(--text-dim);
  margin: 8px 0 2px;
}
.opt-list { display: flex; flex-direction: column; gap: 2px; }
.opt {
  display: grid;
  grid-template-columns: 18px 1fr auto;
  align-items: center;
  gap: 8px;
  padding: 7px 8px;
  border-radius: 7px;
  cursor: pointer;
}
.opt:hover { background: var(--bg-hover); }
.opt.off { opacity: .45; }
.opt input { accent-color: var(--accent); cursor: pointer; }
.opt-label { color: var(--text); }
.opt-desc { font-size: 10px; color: var(--text-dim); }

.fmt-row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.fmt-btn {
  display: flex;
  flex-direction: column;
  gap: 2px;
  align-items: flex-start;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-card2);
  padding: 9px 12px;
  cursor: pointer;
  color: var(--text-dim);
}
.fmt-btn b { font-size: 14px; color: var(--text); }
.fmt-btn span { font-size: 10px; }
.fmt-btn.on { border-color: var(--accent); }
.fmt-btn.on b { color: var(--accent); }

.export-btn {
  margin-top: 12px;
  height: 36px;
  border: none;
  border-radius: 8px;
  background: var(--accent);
  color: #1a1508;
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
}
.export-btn:hover { filter: brightness(1.08); }
.export-btn:disabled { opacity: .6; cursor: default; }

.msg { font-size: 11px; margin-top: 4px; }
.msg.good { color: var(--down); }
.msg.bad { color: var(--up); }
.tip { font-size: 10px; color: var(--text-dim); margin-top: 2px; }
</style>
