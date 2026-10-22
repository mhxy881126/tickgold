<script setup lang="ts">
// v2.32 盯盘复盘报告导出：拉取后端聚合数据包，前端渲染单文件 HTML / Markdown，
// 通过原生保存框落盘。报告只如实记录，不出现荐股措辞，固定附免责声明。
import ComplianceFooter from "./ComplianceFooter.vue";
import { ref, onMounted } from "vue";
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

async function loadPreview() {
  if (previewHtml.value) return;
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

onMounted(() => {
  void loadPreview();
});

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
        content: "﻿" + content,
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
    <!-- 顶部标题栏 -->
    <div class="rr-head">
      <div class="rr-title">当日盯盘复盘报告</div>
      <div class="rr-sub">汇总市场情绪、指数板块、信号 / 成交、AI 复盘与绩效快照</div>
    </div>

    <!-- 操作按钮栏 -->
    <div class="rr-toolbar">
      <button class="rr-btn html" :disabled="busy" @click="exportAs('html')">
        <span class="rr-btn-ic">📄</span>
        <span>导出 HTML</span>
      </button>
      <button class="rr-btn md" :disabled="busy" @click="exportAs('md')">
        <span class="rr-btn-ic">📝</span>
        <span>导出 Markdown</span>
      </button>
      <button class="rr-btn refresh" :disabled="previewBusy" @click="loadPreview">
        <span class="rr-btn-ic">🔄</span>
        <span>{{ previewBusy ? "生成中…" : "刷新" }}</span>
      </button>
      <span v-if="msg" class="rr-msg" :class="{ good: ok, bad: !ok }">{{ msg }}</span>
    </div>

    <!-- 预览区域 -->
    <div class="rr-preview">
      <div v-if="previewBusy" class="rr-loading">
        <div class="rr-loading-spinner" />
        <span>正在生成报告预览…</span>
      </div>
      <iframe
        v-else-if="previewHtml"
        class="rr-frame"
        :srcdoc="previewHtml"
        sandbox="allow-same-origin"
      />
      <div v-else class="rr-empty">
        <div class="rr-empty-icon">📊</div>
        <div>暂无报告数据</div>
        <div class="rr-empty-hint">点击「刷新」重新生成</div>
      </div>
    </div>
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
  background: var(--bg-card);
  color: var(--text);
  font-size: 12px;
}

.rr-title {
  font-size: 16px;
  font-weight: 700;
  color: var(--text);
}
.rr-sub {
  font-size: 11px;
  color: var(--text-dim);
  margin-top: 2px;
}

/* 工具栏 */
.rr-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.rr-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  border: 1px solid rgba(232, 200, 120, 0.25);
  border-radius: 8px;
  background: rgba(232, 200, 120, 0.05);
  padding: 7px 14px;
  cursor: pointer;
  color: #e8c878;
  font-size: 12px;
  font-weight: 500;
  transition: all 0.15s;
}
.rr-btn:hover:not(:disabled) {
  background: rgba(232, 200, 120, 0.15);
  border-color: rgba(232, 200, 120, 0.5);
  box-shadow: 0 0 12px rgba(232, 200, 120, 0.15);
}
.rr-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.rr-btn-ic {
  font-size: 14px;
}
.rr-btn.html {
  background: linear-gradient(135deg, rgba(232, 200, 120, 0.2), rgba(201, 162, 74, 0.15));
  border-color: rgba(232, 200, 120, 0.4);
}
.rr-btn.refresh {
  margin-left: auto;
}

.rr-msg {
  font-size: 11px;
}
.rr-msg.good {
  color: #1dbe7d;
}
.rr-msg.bad {
  color: #ff5b5b;
}

/* 预览区域 */
.rr-preview {
  flex: 1;
  min-height: 0;
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
  background: #0d0f14;
  position: relative;
}
.rr-frame {
  width: 100%;
  height: 100%;
  border: 0;
  display: block;
}

/* 加载状态 */
.rr-loading {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  background: var(--bg-card);
  color: var(--text-dim);
  font-size: 13px;
}
.rr-loading-spinner {
  width: 32px;
  height: 32px;
  border: 3px solid rgba(232, 200, 120, 0.2);
  border-top-color: #e8c878;
  border-radius: 50%;
  animation: rr-spin 0.8s linear infinite;
}
@keyframes rr-spin {
  to {
    transform: rotate(360deg);
  }
}

/* 空状态 */
.rr-empty {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  background: var(--bg-card);
  color: var(--text-dim);
}
.rr-empty-icon {
  font-size: 40px;
  opacity: 0.5;
}
.rr-empty-hint {
  font-size: 11px;
  opacity: 0.7;
}

/* 底部免责 */
.rr-disclaimer {
  font-size: 10px;
  color: #7a5b14;
  background: rgba(201, 162, 74, 0.1);
  border: 1px solid rgba(201, 162, 74, 0.3);
  border-radius: 6px;
  padding: 6px 10px;
  text-align: center;
}
</style>
