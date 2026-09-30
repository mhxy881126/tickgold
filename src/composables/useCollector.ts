// 采集调度器：盘中每 20 分钟增量抓公告/互动易催化；15:30-17:00 跑当日归因。
// 与 useTimeSeries 相同的前端调度模式；防重入、同日幂等、失败落 collector_run。
import { reactive } from "vue";
import {
  fetchAnnouncements,
  fetchIrmLatest,
} from "../api/kb";
import { db } from "../db/database";
import type { Db } from "../kb/repo";
import {
  finishRun,
  getRun,
  startRun,
} from "../kb/repo";
import {
  ingestCatalysts,
  announceToDraft,
  irmToDraft,
} from "../kb/catalystPipe";
import {
  isoDate,
  runAttributionJob,
  todayCompact,
} from "../kb/dailyJob";
import type { CollectorJob } from "../kb/types";

export const collectorStatus = reactive({
  running: false,
  lastAnnouncement: 0,
  lastIrm: 0,
  lastAttribution: "",
  announcementCount: 0,
  irmCount: 0,
  attributionThemes: 0,
  lastError: "",
});

let timer: number | null = null;
const locked = new Set<string>(); // 防重入键：job:date

function pad(n: number) {
  return String(n).padStart(2, "0");
}
function nowIso(d = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function runAnnouncement(d: Db, date: string): Promise<number> {
  const items = await fetchAnnouncements(date);
  const { inserted } = await ingestCatalysts(d, items.map(announceToDraft));
  collectorStatus.lastAnnouncement = Date.now();
  collectorStatus.announcementCount += inserted;
  return inserted;
}

async function runIrm(d: Db): Promise<number> {
  const items = await fetchIrmLatest();
  const { inserted } = await ingestCatalysts(d, items.map(irmToDraft));
  collectorStatus.lastIrm = 0; // 由下面赋真实时间
  collectorStatus.lastIrm = Date.now();
  collectorStatus.irmCount += inserted;
  return inserted;
}

async function runAttribution(d: Db, date: string): Promise<number> {
  const r = await runAttributionJob(d, date, todayCompact(new Date()));
  collectorStatus.lastAttribution = r.tradeDate;
  collectorStatus.attributionThemes = r.themes;
  return r.themes;
}

/** 立即执行一个作业（带 run 状态记录与幂等/防重入）。 */
export async function runCollectionNow(job: CollectorJob): Promise<void> {
  const date = nowIso();
  const key = `${job}:${date}`;
  const d: Db = db();

  // 归因作业同日成功则跳过；其余作业允许补抓
  if (job === "attribution") {
    const done = await getRun(d, date, job);
    if (done?.status === "success") return;
  }
  if (locked.has(key)) return;
  locked.add(key);

  const runId = await startRun(d, date, job);
  try {
    let rows = 0;
    if (job === "announcement") rows = await runAnnouncement(d, date);
    else if (job === "irm") rows = await runIrm(d);
    else rows = await runAttribution(d, date);
    await finishRun(d, runId, "success", rows);
    collectorStatus.lastError = "";
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    collectorStatus.lastError = msg;
    await finishRun(d, runId, "failed", 0, msg);
  } finally {
    locked.delete(key);
  }
}

function tick(): void {
  const now = new Date();
  const hm = now.getHours() * 60 + now.getMinutes();
  const weekday = now.getDay() >= 1 && now.getDay() <= 5;
  if (!weekday) return;

  // 盘中催化增量（9:30-15:00）
  if (hm >= 570 && hm <= 900) {
    void runCollectionNow("announcement");
    void runCollectionNow("irm");
  }
  // 盘后归因窗口 15:30-17:00
  if (hm >= 930 && hm <= 1020) {
    void runCollectionNow("attribution");
  }
}

export function startCollector(): void {
  if (collectorStatus.running) return;
  collectorStatus.running = true;
  // 每 20 分钟检查一次；启动后立即检查
  void Promise.resolve().then(tick);
  // 偏差说明：brief 逐字为 window.setInterval；仓库 vitest 默认 node 环境无 window
  // （逐字测试未装 browser globals），而 clearInterval 本就走全局函数。
  // 浏览器/Tauri webview 中全局 setInterval 与 window.setInterval 完全等价。
  timer = setInterval(tick, 20 * 60 * 1000);
}

export function stopCollector(): void {
  collectorStatus.running = false;
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}
