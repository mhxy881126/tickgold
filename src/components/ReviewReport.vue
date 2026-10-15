<script setup lang="ts">
// v2.32 盯盘复盘报告导出：拉取后端聚合数据包，前端渲染单文件 HTML / Markdown，
// 通过原生保存框落盘。报告只如实记录，不出现荐股措辞，固定附免责声明。
import ComplianceFooter from "./ComplianceFooter.vue";
import { ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { buildReviewReport } from "../ai/api";
import { renderHtml, renderMarkdown } from "../utils/reviewReport";

const busy = ref(false);
const msg = ref("");
const ok = ref(false);
const previewHtml = ref("");
const previewDay = ref("");
const previewBusy = ref(false);

function pad2(n: number) {
  return String(n).padStart(2, "0");
}
function stamp() {
  const d = new Date();
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}`;
}

async function preview() {
  if (previewHtml.value) { previewHtml.value = ""; return; }  // 再点收起
  previewBusy.value = true;
  try {
    const data = await buildReviewReport();
    previewHtml.value = renderHtml(data);
    previewDay.value = data.date;
  } catch (e: any) {
    msg.value = "生成预览失败：" + (e?.message || String(e));
    ok.value = false;
  } finally {
    previewBusy.value = false;
  }
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
      <button class="rr-btn prev" :disabled="busy" @click="preview">
        <b>{{ previewHtml ? '收起预览' : '预览报告' }}</b>
        <span>{{ previewHtml ? '关闭内嵌预览' : '内嵌查看完整报告' }}</span>
      </button>
    </div>

    <div v-if="previewBusy" class="rr-busy">正在生成预览…</div>
    <div v-if="previewHtml" class="rr-preview">
      <div class="rr-preview-bar">
        <span>{{ previewDay }} 复盘报告预览</span>
        <button @click="previewHtml = ''">关闭</button>
      </div>
      <iframe class="rr-preview-frame" :srcdoc="previewHtml" sandbox="allow-same-origin"></iframe>
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
<ComplianceFooter />
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

.rr-btn.prev { grid-column: 1 / -1; border-color: var(--accent, #3370ff); color: var(--accent, #3370ff); }
.rr-preview { display: flex; flex-direction: column; gap: 6px; min-height: 0; flex: 1; }
.rr-preview-bar {
  display: flex; align-items: center; justify-content: space-between;
  font-size: 12px; font-weight: 600; color: var(--text);
}
.rr-preview-bar button {
  border: 1px solid var(--border); background: var(--bg-card2); color: var(--text);
  border-radius: 6px; padding: 2px 10px; font-size: 11px; cursor: pointer;
}
.rr-preview-frame {
  width: 100%; flex: 1; min-height: 0;
  border: 1px solid var(--border); border-radius: 10px;
  background: #fff;
}
</style>
