<script setup lang="ts">
// v2.32 盯盘复盘报告导出：拉取后端聚合数据包，前端渲染单文件 HTML / Markdown，
// 通过原生保存框落盘。报告只如实记录，不出现荐股措辞，固定附免责声明。
import { ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { buildReviewReport } from "../ai/api";
import { renderHtml, renderMarkdown } from "../utils/reviewReport";

const busy = ref(false);
const msg = ref("");
const ok = ref(false);

function pad2(n: number) {
  return String(n).padStart(2, "0");
}
function stamp() {
  const d = new Date();
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}`;
}

async function exportAs(kind: "html" | "md") {
  busy.value = true;
  ok.value = false;
  msg.value = "正在汇总当日盯盘数据…";
  try {
    const data = await buildReviewReport();
    const day = data.date;
    if (kind === "html") {
      const content = renderHtml(data);
      await invoke("save_export_file", {
        defaultName: `盯盘复盘报告_${day}_${stamp()}.html`,
        content,
      });
    } else {
      const content = renderMarkdown(data);
      await invoke("save_export_file", {
        defaultName: `盯盘复盘报告_${day}_${stamp()}.md`,
        content: "\uFEFF" + content,
      });
    }
    ok.value = true;
    msg.value = `已生成 ${day} 复盘报告（${kind.toUpperCase()}）`;
  } catch (e: any) {
    const m = e?.message || String(e);
    ok.value = false;
    msg.value = m.includes("取消") ? "已取消保存" : "生成失败：" + m;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="rr">
    <div class="rr-head">
      <div class="rr-title">当日盯盘复盘报告</div>
      <div class="rr-sub">汇总市场情绪、指数板块、我的信号 / 成交、AI 复盘与绩效快照</div>
    </div>

    <div class="rr-btns">
      <button class="rr-btn html" :disabled="busy" @click="exportAs('html')">
        <b>导出 HTML</b>
        <span>排版精美的单文件网页</span>
      </button>
      <button class="rr-btn md" :disabled="busy" @click="exportAs('md')">
        <b>导出 Markdown</b>
        <span>纯文本，便于二次编辑</span>
      </button>
    </div>

    <div v-if="busy" class="rr-busy">正在生成…</div>
    <div v-if="msg" class="rr-msg" :class="{ good: ok, bad: !ok }">{{ msg }}</div>

    <div class="rr-outline">
      <div class="rr-ol-title">报告包含</div>
      <ol>
        <li>市场情绪总览（涨跌 / 涨停 / 炸板 / 封板资金 / 情绪指标）</li>
        <li>指数表现</li>
        <li>板块与题材（行业 / 概念 / 资金 / 活跃题材）</li>
        <li>近期催化剂</li>
        <li>连板股定格</li>
        <li>我的交易与绩效（成交流水 / 当日已实现盈亏）</li>
        <li>预警触发记录</li>
        <li>AI 复盘记录</li>
        <li>当日作战计划</li>
        <li>决策日志</li>
      </ol>
    </div>

    <div class="rr-disclaimer">本报告仅为个人盯盘记录与数据复盘，不构成任何投资建议。</div>
  </div>
</template>

<style scoped>
.rr {
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
  overflow-y: auto;
  background: var(--bg-card);
  color: var(--text);
  font-size: 12px;
}
.rr-title { font-size: 15px; font-weight: 700; color: var(--text); }
.rr-sub { font-size: 11px; color: var(--text-dim); margin-top: 2px; }

.rr-btns { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 4px; }
.rr-btn {
  display: flex;
  flex-direction: column;
  gap: 3px;
  align-items: flex-start;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-card2);
  padding: 12px 14px;
  cursor: pointer;
  color: var(--text-dim);
}
.rr-btn b { font-size: 14px; color: var(--text); }
.rr-btn span { font-size: 10px; }
.rr-btn:hover { border-color: var(--accent); }
.rr-btn:hover b { color: var(--accent); }
.rr-btn:disabled { opacity: .55; cursor: default; }

.rr-busy { font-size: 11px; color: var(--text-dim); }
.rr-msg { font-size: 11px; }
.rr-msg.good { color: var(--down); }
.rr-msg.bad { color: var(--up); }

.rr-outline { border: 1px solid var(--border); border-radius: 10px; padding: 10px 14px; }
.rr-ol-title { font-size: 11px; color: var(--text-dim); margin-bottom: 6px; }
.rr-outline ol { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 3px; color: var(--text); }

.rr-disclaimer {
  margin-top: auto;
  font-size: 11px;
  color: #7a5b14;
  background: rgba(201, 162, 74, .12);
  border: 1px solid rgba(201, 162, 74, .4);
  border-radius: 8px;
  padding: 8px 12px;
}
</style>
