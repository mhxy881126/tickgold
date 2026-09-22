<script setup lang="ts">
import { ref, watch } from "vue";
import { getVersion } from "@tauri-apps/api/app";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { openUrl } from "@tauri-apps/plugin-opener";
import { fetchLatest } from "../api/market";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ "update:open": [v: boolean] }>();

type Phase = "checking" | "available" | "uptodate" | "preparing" | "downloading" | "installing" | "error";
const phase = ref<Phase>("checking");
const curVersion = ref("");
const latestVersion = ref("");
const notes = ref("");
const pubDate = ref("");
const errorMsg = ref("");
const fallback = ref(false); // Tauri 检查尚未就绪、先由后端镜像拿到版本

const pct = ref(0);
const gotMB = ref(0);
const totalMB = ref(0);
const speed = ref(0);

let pendingUpdate: Update | null = null;
let tauriReady: Promise<Update | null> = Promise.resolve(null);

function cmpVer(a: string, b: string): number {
  const pa = a.split(".").map((x) => parseInt(x) || 0);
  const pb = b.split(".").map((x) => parseInt(x) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}
function newer(v: string): boolean {
  return cmpVer(v, curVersion.value) > 0;
}

function close() {
  if (phase.value === "preparing" || phase.value === "downloading" || phase.value === "installing") return;
  emit("update:open", false);
}

async function runCheck() {
  phase.value = "checking";
  errorMsg.value = "";
  notes.value = "";
  pubDate.value = "";
  fallback.value = false;
  pendingUpdate = null;
  if (!curVersion.value) {
    try { curVersion.value = await getVersion(); } catch { /* ignore */ }
  }

  // 两路并行：Tauri 官方检查（拿到即可下载安装） + 后端多镜像竞速（通常更快，先展示）
  tauriReady = check()
    .then((u) => u)
    .catch((e) => {
      console.warn("[updater] tauri check failed:", e);
      return null;
    });
  const tauriP = tauriReady.then((u) =>
    u ? ({ k: "t" as const, u }) : ({ k: "none" as const }),
  );
  const latestP = fetchLatest()
    .then((i) => ({ k: "l" as const, i }))
    .catch(() => ({ k: "none" as const }));

  let tDone = false;
  let lDone = false;
  const tp = tauriP.then((r) => { tDone = true; return r; });
  const lp = latestP.then((r) => { lDone = true; return r; });

  let r = await Promise.race([tp, lp]);
  if (r.k === "none") r = await (tDone ? lp : tp);

  if (r.k === "t") {
    pendingUpdate = r.u;
    latestVersion.value = r.u.version;
    notes.value = r.u.body || "";
    phase.value = newer(r.u.version) ? "available" : "uptodate";
    return;
  }

  if (r.k === "l") {
    latestVersion.value = r.i.version;
    notes.value = r.i.notes;
    pubDate.value = r.i.pubDate;
    if (!newer(r.i.version)) {
      phase.value = "uptodate";
      return;
    }
    fallback.value = true;
    phase.value = "available";
    // 后台等 Tauri 检查补全可下载对象，补全后自动转为可直接更新
    tauriReady.then((u) => {
      if (u && !pendingUpdate) {
        pendingUpdate = u;
        fallback.value = false;
        latestVersion.value = u.version;
        if (u.body) notes.value = u.body;
      }
    });
    return;
  }

  errorMsg.value = "无法连接到更新服务器，请稍后重试或手动下载";
  phase.value = "error";
}

async function ensureUpdate(): Promise<Update | null> {
  if (pendingUpdate) return pendingUpdate;
  // 等待后台 Tauri 检查（最多 15s）
  const u1 = await Promise.race([
    tauriReady,
    new Promise<null>((res) => setTimeout(() => res(null), 15000)),
  ]);
  if (u1) { pendingUpdate = u1; return u1; }
  // 再主动检查一次（endpoints 已镜像优先）
  try {
    const u2 = await check();
    if (u2) { pendingUpdate = u2; return u2; }
  } catch (e) {
    console.warn("[updater] recheck failed:", e);
  }
  return null;
}

async function doUpdate() {
  phase.value = "preparing";
  const u = await ensureUpdate();
  if (!u) {
    errorMsg.value = "自动下载暂不可用，请使用「手动下载」";
    phase.value = "error";
    return;
  }
  latestVersion.value = u.version;

  phase.value = "downloading";
  pct.value = 0; gotMB.value = 0; totalMB.value = 0; speed.value = 0;
  let lastT = Date.now();
  let lastGot = 0;

  try {
    await u.download((e: any) => {
      if (e.event === "Started") {
        totalMB.value = (e.data.contentLength || 0) / 1048576;
      } else if (e.event === "Progress") {
        gotMB.value += e.data.chunkLength / 1048576;
        const now = Date.now();
        const dt = now - lastT;
        if (dt >= 500) {
          speed.value = ((gotMB.value - lastGot) / dt) * 1000;
          lastT = now; lastGot = gotMB.value;
        }
        pct.value = totalMB.value ? Math.min(99, Math.round((gotMB.value / totalMB.value) * 100)) : pct.value;
      } else if (e.event === "Finished") {
        pct.value = 100;
      }
    });
    phase.value = "installing";
    await u.install();
    await relaunch();
  } catch (e: any) {
    errorMsg.value = "下载/安装失败：" + String(e?.message || e);
    phase.value = "error";
  }
}

async function manualDownload() {
  try {
    await openUrl("https://github.com/mhxy881126/tickgold/releases/latest");
  } catch { /* ignore */ }
}

watch(
  () => props.open,
  (v) => { if (v) runCheck(); },
);
</script>

<template>
  <div v-if="props.open" class="mask" @click.self="close">
    <div class="dlg">
      <div class="dlg-head">
        <span class="dlg-title">软件更新</span>
        <button class="x" @click="close" :disabled="phase === 'preparing' || phase === 'downloading' || phase === 'installing'">&times;</button>
      </div>

      <div class="dlg-body">
        <!-- 检查中 -->
        <div v-if="phase === 'checking' || phase === 'preparing'" class="center">
          <span class="spin"></span> {{ phase === 'preparing' ? '正在准备下载…' : '正在检查最新版本…' }}
        </div>

        <!-- 已是最新 -->
        <div v-else-if="phase === 'uptodate'" class="center col">
          <div class="ok-badge">&#10003;</div>
          <p>当前已是最新版本</p>
          <p class="ver-line">TickGold v{{ curVersion }}</p>
        </div>

        <!-- 有新版本 -->
        <template v-else-if="phase === 'available'">
          <div class="ver-row">
            <div class="ver-block">
              <div class="vl">当前版本</div>
              <div class="vv dim">v{{ curVersion }}</div>
            </div>
            <div class="arrow">&#8594;</div>
            <div class="ver-block">
              <div class="vl">最新版本</div>
              <div class="vv new">v{{ latestVersion }}</div>
            </div>
          </div>
          <div v-if="fallback" class="tip">自动检查通道不稳定，已通过备用镜像获取到新版本，可尝试自动更新或手动下载。</div>
          <div v-if="notes" class="notes">
            <div class="notes-title">更新内容</div>
            <pre>{{ notes }}</pre>
          </div>
        </template>

        <!-- 下载中 -->
        <template v-else-if="phase === 'downloading'">
          <div class="dl-top">
            <span class="dl-ver">正在下载 v{{ latestVersion }}</span>
            <span class="dl-pct">{{ pct }}%</span>
          </div>
          <div class="pbar"><div class="pfill" :style="{ width: pct + '%' }"></div></div>
          <div class="dl-meta">
            <span>{{ gotMB.toFixed(1) }}<template v-if="totalMB"> / {{ totalMB.toFixed(1) }}</template> MB</span>
            <span v-if="speed > 0.05">{{ speed.toFixed(1) }} MB/s</span>
          </div>
        </template>

        <!-- 安装中 -->
        <div v-else-if="phase === 'installing'" class="center">
          <span class="spin"></span> 下载完成，即将退出并启动安装…
        </div>

        <!-- 错误 -->
        <div v-else class="center col">
          <div class="err-badge">!</div>
          <p class="err-msg">{{ errorMsg || "更新失败" }}</p>
        </div>
      </div>

      <div class="dlg-foot">
        <button class="btn ghost" @click="manualDownload">手动下载</button>
        <template v-if="phase === 'available'">
          <button class="btn primary" @click="doUpdate">立即更新</button>
        </template>
        <template v-else-if="phase === 'error'">
          <button class="btn primary" @click="runCheck">重试</button>
        </template>
        <template v-else>
          <button class="btn ghost" @click="close" :disabled="phase==='preparing'||phase==='downloading'||phase==='installing'">关闭</button>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mask {
  position: fixed; inset: 0; background: rgba(0,0,0,.55);
  display: flex; align-items: center; justify-content: center; z-index: 1000;
}
.dlg {
  width: 420px; max-width: 92vw; border-radius: 12px; overflow: hidden;
  background: #161b22; border: 1px solid #2a313b;
  box-shadow: 0 24px 70px rgba(0,0,0,.6);
}
.dlg-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 13px 16px; border-bottom: 1px solid #232a33;
}
.dlg-title { font-weight: 700; font-size: 14px; }
.x { background: none; border: none; color: #8b949e; font-size: 20px; cursor: pointer; line-height: 1; }
.x:disabled { opacity: .35; cursor: default; }

.dlg-body { padding: 20px 18px; min-height: 132px; }
.center { display: flex; align-items: center; justify-content: center; gap: 10px; color: #c9d1d9; height: 92px; font-size: 13px; }
.center.col { flex-direction: column; gap: 8px; }
.spin {
  width: 16px; height: 16px; border: 2px solid #2f3943; border-top-color: #4ea1ff;
  border-radius: 50%; animation: rot .8s linear infinite;
}
@keyframes rot { to { transform: rotate(360deg); } }

.ok-badge {
  width: 46px; height: 46px; border-radius: 50%; background: rgba(38,208,124,.15);
  color: #26d07c; display: flex; align-items: center; justify-content: center; font-size: 24px;
}
.err-badge {
  width: 46px; height: 46px; border-radius: 50%; background: rgba(242,54,69,.15);
  color: #f23645; display: flex; align-items: center; justify-content: center; font-size: 26px; font-weight: 700;
}
.ver-line { color: #8b949e; font-size: 12px; margin: 0; }
.err-msg { color: #ff858f; font-size: 12px; text-align: center; margin: 0; max-width: 340px; }

.ver-row { display: flex; align-items: center; justify-content: center; gap: 22px; }
.ver-block { text-align: center; }
.vl { font-size: 11px; color: #8b949e; margin-bottom: 5px; }
.vv { font-size: 22px; font-weight: 700; }
.vv.dim { color: #8b949e; }
.vv.new { color: #4ea1ff; }
.arrow { color: #555; font-size: 20px; }
.tip { margin-top: 14px; font-size: 11px; color: #e3c25f; background: rgba(212,175,55,.1); border-radius: 6px; padding: 7px 10px; }
.notes { margin-top: 14px; }
.notes-title { font-size: 12px; color: #c9d1d9; margin-bottom: 6px; }
.notes pre {
  margin: 0; max-height: 150px; overflow-y: auto; white-space: pre-wrap; word-break: break-word;
  font-family: inherit; font-size: 11px; color: #8b949e; line-height: 1.6;
  background: #11151a; border-radius: 6px; padding: 9px 11px;
}

.dl-top { display: flex; justify-content: space-between; align-items: baseline; }
.dl-ver { font-size: 13px; color: #c9d1d9; }
.dl-pct { font-size: 20px; font-weight: 700; color: #4ea1ff; font-variant-numeric: tabular-nums; }
.pbar { height: 8px; border-radius: 5px; background: #232a33; overflow: hidden; margin: 12px 0 9px; }
.pfill { height: 100%; background: linear-gradient(90deg,#2f6fed,#5ea0ff); border-radius: 5px; transition: width .25s; }
.dl-meta { display: flex; justify-content: space-between; font-size: 11px; color: #8b949e; font-variant-numeric: tabular-nums; }

.dlg-foot {
  display: flex; justify-content: flex-end; gap: 10px;
  padding: 12px 16px; border-top: 1px solid #232a33;
}
.btn { border-radius: 7px; padding: 7px 18px; font-size: 13px; cursor: pointer; border: 1px solid transparent; }
.btn.ghost { background: transparent; border-color: #2f3943; color: #c9d1d9; }
.btn.ghost:hover { border-color: #4a5563; }
.btn.primary { background: #2f6fed; color: #fff; }
.btn.primary:hover { background: #3d7bf5; }
</style>
