<script setup lang="ts">
import { ref } from "vue";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { fetchNewsFlash, type NewsItem } from "../api/market";
import { useSmartPolling } from "../composables/useSmartPolling";

const items = ref<NewsItem[]>([]);
const loading = ref(false);
const live = ref(true);
const page = ref(1);
const seen = new Set<number>();

function hm(t: string) {
  // "2026-09-23 09:45:12" -> "09:45"
  return t.length >= 16 ? t.substring(11, 16) : t;
}

async function load(p: number) {
  if (loading.value) return;
  loading.value = true;
  try {
    const list = await fetchNewsFlash(p, 30);
    if (p === 1) {
      const fresh = list.filter((x) => !seen.has(x.id));
      items.value = [...fresh, ...items.value];
    } else {
      const more = list.filter((x) => !seen.has(x.id));
      items.value = [...items.value, ...more];
    }
    list.forEach((x) => seen.add(x.id));
  } catch (e) {
    console.error("fetchNewsFlash", e);
  }
  loading.value = false;
}

function onScroll(e: Event) {
  const el = e.target as HTMLElement;
  if (el.scrollHeight - el.scrollTop - el.clientHeight < 40) {
    page.value += 1;
    load(page.value);
  }
}

const NEWS_LABEL = "news-web";
async function open(n: NewsItem) {
  if (!n.url) return;
  // 复用同一个内置网页弹窗：先关旧窗再开新窗，避免堆叠；窗口本身可拖动/缩放/关闭
  try {
    const old = await WebviewWindow.getByLabel(NEWS_LABEL);
    if (old) await old.close();
  } catch {
    /* ignore */
  }
  try {
    const w = new WebviewWindow(NEWS_LABEL, {
      url: n.url,
      title: n.text ? n.text.replace(/\s+/g, " ").slice(0, 26) : "盘中快讯",
      width: 1080,
      height: 760,
      resizable: true,
    });
    await new Promise((res, rej) => {
      w.once("tauri://created", res);
      w.once("tauri://error", rej);
    });
  } catch (e) {
    console.error("open news webview", e);
  }
}

// 智能轮询：仅在卡片可见 / 在线 / 非聚焦后台时刷新，断网、最小化自动暂停，恢复即刷新
useSmartPolling(() => load(1), { interval: 45000, cardId: "news" });
</script>

<template>
  <div class="newsflash">
    <div class="nf-status">
      <span class="dot" :class="{ on: live }"></span>
      {{ live ? "直播中 · 45s 自动刷新" : "已暂停" }}
    </div>
    <div class="nf-list" @scroll="onScroll">
      <div v-for="n in items" :key="n.id" class="nf-item" @click="open(n)">
        <span class="nf-time">{{ hm(n.time) }}</span>
        <span v-for="(t, i) in n.tags" :key="i" class="nf-tag">{{ t }}</span>
        <span class="nf-text">{{ n.text }}</span>
      </div>
      <div v-if="loading" class="nf-load">加载中…</div>
    </div>
  </div>
</template>

<style scoped>
.newsflash {
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 6px 10px 8px;
  overflow: hidden;
}
.nf-status {
  font-size: 9.5px;
  color: #7d8792;
  display: flex;
  align-items: center;
  gap: 5px;
  flex: none;
  padding-bottom: 5px;
  border-bottom: 1px solid #20272f;
  margin-bottom: 3px;
}
.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #5d6878;
}
.dot.on {
  background: #08c98a;
  box-shadow: 0 0 6px rgba(8, 201, 138, 0.8);
  animation: nfpulse 1.6s infinite;
}
@keyframes nfpulse {
  50% {
    opacity: 0.4;
  }
}
.nf-list {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}
.nf-item {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 4px 2px;
  border-bottom: 1px solid rgba(32, 39, 47, 0.6);
  cursor: pointer;
}
.nf-item:hover .nf-text {
  color: #e9eef6;
}
.nf-time {
  font-size: 9.5px;
  color: #7d8792;
  font-variant-numeric: tabular-nums;
  flex: none;
}
.nf-tag {
  font-size: 8.5px;
  color: #b07cff;
  background: rgba(176, 124, 255, 0.12);
  border-radius: 3px;
  padding: 0 4px;
  flex: none;
  white-space: nowrap;
}
.nf-text {
  font-size: 11px;
  color: #b8c2cf;
  line-height: 1.45;
  flex: 1;
  transition: color 0.15s;
}
.nf-load {
  text-align: center;
  font-size: 10px;
  color: #5d6878;
  padding: 8px 0;
}
</style>
