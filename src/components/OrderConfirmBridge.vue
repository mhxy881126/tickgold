<script setup lang="ts">
// P0-5 全局下单确认桥：所有下单入口（信号确认桥 / 同花顺控制台 / 条件单 / 爬虫）
// 在 sidecar 挂起委托、回传下单前截图（expect 含 code）时，统一在此弹出，
// 醒目标注金额（买入红 / 卖出绿）、hard_validate 三维硬校验（资金 / 持仓 / T+1）。
// 硬校验不通过时禁止确认。组件常驻 App 根，不依赖任何卡片是否打开。
import { ref, onMounted, onBeforeUnmount } from "vue";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { brokerClientConfirm, type ClientShot } from "../broker/api";

const pendingShot = ref<ClientShot | null>(null);
const shotBusy = ref(false);
const toast = ref("");
let toastTimer: ReturnType<typeof setTimeout> | undefined;
function flash(m: string) {
  toast.value = m;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.value = ""), 2600);
}

async function onClientDecision(approved: boolean) {
  const shot = pendingShot.value;
  if (!shot || !shot.client_order_id || shotBusy.value) return;
  shotBusy.value = true;
  try {
    await brokerClientConfirm(shot.client_order_id, approved);
    flash(approved ? "已在客户端确认下单" : "已取消该笔委托");
    pendingShot.value = null;
  } catch (e) {
    flash(String(e));
  } finally {
    shotBusy.value = false;
  }
}
function dismissShot() {
  if (!shotBusy.value) pendingShot.value = null;
}

let un: UnlistenFn | undefined;
let un2: UnlistenFn | undefined;
onMounted(() => {
  listen<ClientShot>("broker:client_screenshot", (ev) => {
    const shot = ev.payload;
    if (!shot) return;
    // 仅下单类截图（闪电下单 / 仓位下单，expect 含 code）；
    // 验证码（captcha）、撤单页（cancelPage）由各自组件处理。
    if (shot.client_order_id && shot.expect?.code) {
      pendingShot.value = shot;
    }
  }).then((u) => (un = u));
  // P0-1 买入成交后自动武装止损，提示用户（可在条件单卡片调整/撤销）
  listen<{ code?: string; stopPrice?: number }>("broker:stop_armed", (ev) => {
    const d = ev.payload;
    if (d?.code) {
      flash(`已为 ${d.code} 自动武装止损单：跌破 ${Number(d.stopPrice ?? 0).toFixed(2)} 元卖出（-4%），触发仍需你确认；可在条件单调整`);
    }
  }).then((u) => (un2 = u));
});
onBeforeUnmount(() => {
  un?.();
  un2?.();
  clearTimeout(toastTimer);
});
</script>

<template>
  <transition name="shot-fade">
    <div v-if="pendingShot" class="shot-mask" @click.self="dismissShot">
      <div class="shot-modal" :class="{ live: pendingShot.expect?.sim === false }">
        <div class="shot-modal-title" :class="{ live: pendingShot.expect?.sim === false }">
          {{ pendingShot.expect?.sim === false ? "下单前核对 · 真实资金委托" : "下单前核对 · 本地模拟" }}
        </div>
        <div v-if="pendingShot.expect?.sim === false" class="shot-live-banner">
          <span class="shot-live-icon">⚠</span>
          真实资金委托 · 确认后将在真实账户提交订单，资金发生真实变动
          <span class="shot-live-amount">约 {{ pendingShot.expect?.amount ? pendingShot.expect.amount.toLocaleString("zh-CN") : "—" }} 元</span>
        </div>
        <!-- P0-5 醒目金额大卡 -->
        <div class="shot-amount-card" :class="{ live: pendingShot.expect?.sim === false, sell: pendingShot.expect?.side === 'SELL' }">
          <div class="shot-amount-label">{{ pendingShot.expect?.side === "SELL" ? "卖出金额" : "买入金额" }}</div>
          <div class="shot-amount-value">
            <span class="shot-amount-currency">¥</span>
            <span class="shot-amount-num">{{ pendingShot.expect?.amount ? pendingShot.expect.amount.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—" }}</span>
          </div>
          <div v-if="pendingShot.expect?.validation" class="shot-amount-fee">
            预估佣金 {{ pendingShot.expect.validation.commission.toFixed(2) }} 元
            <template v-if="pendingShot.expect.validation.stamp > 0"> · 印花税 {{ pendingShot.expect.validation.stamp.toFixed(2) }} 元</template>
          </div>
        </div>
        <!-- P0-5 硬校验状态条（失败项红色置顶） -->
        <div v-if="pendingShot.expect?.validation" class="shot-validation">
          <span
            v-for="c in pendingShot.expect.validation.checks"
            :key="c.name"
            class="shot-val-chip"
            :class="{ ok: c.ok === true, fail: c.ok === false, unknown: c.ok === null }"
            :title="c.note || (c.need != null ? `需 ${c.need}，可用 ${c.avail}` : '')"
          >
            <span class="shot-val-icon">{{ c.ok === true ? "✓" : c.ok === false ? "✕" : "?" }}</span>
            {{ c.name }}
            <template v-if="c.ok === false && c.note">：{{ c.note }}</template>
          </span>
        </div>
        <div v-if="pendingShot.expect?.validation && !pendingShot.expect.validation.ok" class="shot-block">
          硬校验未通过（资金 / 持仓 / T+1 至少一项不满足），已禁止提交，请核对后重新下单。
        </div>
        <div class="shot-expect">
          <span class="shot-tag" :class="pendingShot.expect?.side === 'SELL' ? 'sell' : 'buy'">
            {{ pendingShot.expect?.side === "SELL" ? "卖出" : "买入" }}
          </span>
          <span class="shot-code">{{ pendingShot.expect?.code }}</span>
          <span class="shot-fld">价格 {{ pendingShot.expect?.price }}</span>
          <span class="shot-fld">数量 {{ pendingShot.expect?.vol }}</span>
          <span class="shot-fld" :class="{ 'amount-live': pendingShot.expect?.sim === false }">金额 {{ pendingShot.expect?.amount ? pendingShot.expect.amount.toLocaleString() : "—" }} 元</span>
          <span class="shot-fld" :class="pendingShot.expect?.sim ? 'sim' : 'reallive'">{{ pendingShot.expect?.sim ? "模拟盘" : "真实盘" }}</span>
        </div>
        <div class="shot-img-wrap">
          <img v-if="pendingShot.shot" :src="pendingShot.shot" alt="下单窗口截图" class="shot-img" />
          <div v-else class="shot-noimg">暂无截图（dry-run 占位或客户端未返回画面）</div>
        </div>
        <div v-if="pendingShot.message" class="shot-msg">{{ pendingShot.message }}</div>
        <div class="shot-tip">请核对截图中的代码 / 方向 / 价格 / 数量是否与上方一致；硬校验已覆盖余额 / 持仓 / T+1，确认后 sidecar 才会在客户端点「确定」。</div>
        <div class="shot-actions">
          <button class="ocb ghost" :disabled="shotBusy" @click="onClientDecision(false)">取消委托</button>
          <button
            class="ocb"
            :class="pendingShot.expect?.sim === false ? 'dangerlive' : 'primary'"
            :disabled="shotBusy || (pendingShot.expect?.validation && !pendingShot.expect.validation.ok)"
            @click="onClientDecision(true)"
          >
            {{ shotBusy ? "处理中…" : (pendingShot.expect?.validation && !pendingShot.expect.validation.ok ? "硬校验未通过 · 无法下单" : (pendingShot.expect?.sim === false ? "核对无误 · 提交真实委托" : "核对无误 · 确认下单")) }}
          </button>
        </div>
      </div>
    </div>
  </transition>

  <transition name="shot-fade">
    <div v-if="toast" class="ocb-toast">{{ toast }}</div>
  </transition>
</template>

<style scoped>
.ocb {
  border: 1px solid rgba(90,160,255,.5); background: rgba(90,160,255,.16);
  color: #e8ecf4; font-size: 13px; font-weight: 600;
  border-radius: 8px; padding: 9px 18px; cursor: pointer;
}
.ocb.primary { background: rgba(90,160,255,.22); }
.ocb.ghost { background: transparent; border-color: rgba(255,255,255,.2); }
.ocb:disabled { opacity: .5; cursor: not-allowed; }
.ocb.dangerlive { background: #ff3b46; border-color: #ff3b46; color: #fff; font-weight: 700; }

.shot-mask { position: fixed; inset: 0; background: rgba(5,8,15,.72); backdrop-filter: blur(3px); display: flex; align-items: center; justify-content: center; z-index: 1300; padding: 24px; }
.shot-modal { width: min(560px, 94vw); max-height: 88vh; overflow: auto; background: #12161f; border: 1px solid rgba(90,160,255,.35); border-radius: 12px; padding: 16px; box-shadow: 0 18px 60px rgba(0,0,0,.6); }
.shot-modal-title { font-size: 15px; font-weight: 700; margin-bottom: 10px; }
.shot-modal.live { border-color: rgba(242,54,69,.7); background: #1a1216; box-shadow: 0 18px 60px rgba(242,54,69,.22); }
.shot-modal-title.live { color: #ff5a6a; }
.shot-live-banner {
  margin-bottom: 10px; padding: 10px 14px; border-radius: 8px;
  background: linear-gradient(135deg, rgba(242,54,69,.22), rgba(242,54,69,.08));
  border: 1px solid rgba(242,54,69,.6);
  color: #ff8a96; font-size: 12px; font-weight: 700; line-height: 1.6;
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
}
.shot-live-icon { font-size: 16px; }
.shot-live-amount { margin-left: auto; font-size: 15px; font-weight: 800; color: #fff; background: rgba(242,54,69,.35); padding: 2px 10px; border-radius: 6px; font-variant-numeric: tabular-nums; }
.shot-amount-card {
  margin-bottom: 10px; padding: 14px 16px; border-radius: 10px;
  background: linear-gradient(135deg, rgba(90,160,255,.1), rgba(90,160,255,.03));
  border: 1px solid rgba(90,160,255,.3); text-align: center;
}
.shot-amount-card.live { background: linear-gradient(135deg, rgba(242,54,69,.14), rgba(242,54,69,.04)); border-color: rgba(242,54,69,.45); }
.shot-amount-card.sell { background: linear-gradient(135deg, rgba(45,212,140,.1), rgba(45,212,140,.03)); border-color: rgba(45,212,140,.3); }
.shot-amount-label { font-size: 11px; color: #8892a8; font-weight: 600; letter-spacing: 1px; text-transform: uppercase; margin-bottom: 4px; }
.shot-amount-value { display: flex; align-items: baseline; justify-content: center; gap: 4px; }
.shot-amount-currency { font-size: 18px; font-weight: 700; color: #e8ecf4; opacity: .8; }
.shot-amount-num { font-size: 30px; font-weight: 800; color: #fff; font-variant-numeric: tabular-nums; letter-spacing: -0.5px; }
.shot-amount-card.live .shot-amount-num { color: #ff6b78; }
.shot-amount-card.sell .shot-amount-num { color: #37d67a; }
.shot-amount-fee { margin-top: 6px; font-size: 11px; color: #8892a8; font-variant-numeric: tabular-nums; }
.shot-validation { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
.shot-val-chip { display: inline-flex; align-items: center; gap: 4px; padding: 3px 9px; border-radius: 6px; font-size: 11px; font-weight: 600; border: 1px solid transparent; }
.shot-val-chip.ok { background: rgba(31,191,117,.12); color: #3dd68a; border-color: rgba(31,191,117,.3); }
.shot-val-chip.fail { background: rgba(242,54,69,.14); color: #ff6b78; border-color: rgba(242,54,69,.4); }
.shot-val-chip.unknown { background: rgba(255,177,61,.1); color: #ffb13d; border-color: rgba(255,177,61,.3); }
.shot-val-icon { font-weight: 800; }
.shot-block {
  margin-bottom: 10px; padding: 9px 12px; border-radius: 8px;
  background: rgba(242,54,69,.12); border: 1px solid rgba(242,54,69,.4);
  color: #ff8a96; font-size: 12px; font-weight: 600; line-height: 1.5;
}
.shot-fld.reallive { color: #ff5a6a; font-weight: 700; }
.shot-fld.amount-live { font-size: 16px; font-weight: 800; color: #ff5a6a; font-variant-numeric: tabular-nums; }
.shot-expect { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; margin-bottom: 10px; }
.shot-tag { padding: 2px 8px; border-radius: 6px; font-weight: 700; font-size: 12px; }
.shot-tag.buy { background: rgba(255,90,90,.18); color: #ff7a7a; }
.shot-tag.sell { background: rgba(45,212,140,.18); color: #37d67a; }
.shot-code { font-weight: 700; font-size: 15px; font-variant-numeric: tabular-nums; }
.shot-fld { font-size: 12px; opacity: .85; }
.shot-fld.sim { color: #ffb13d; }
.shot-img-wrap { border: 1px solid rgba(255,255,255,.1); border-radius: 8px; overflow: hidden; background: #0b0e14; }
.shot-img { display: block; width: 100%; height: auto; }
.shot-noimg { padding: 28px; text-align: center; opacity: .5; font-size: 12px; }
.shot-msg { margin-top: 8px; font-size: 12px; opacity: .8; }
.shot-tip { margin-top: 8px; font-size: 11px; opacity: .6; line-height: 1.6; }
.shot-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 14px; }
.shot-fade-enter-active, .shot-fade-leave-active { transition: opacity .18s; }
.shot-fade-enter-from, .shot-fade-leave-to { opacity: 0; }
.ocb-toast { position: fixed; bottom: 28px; left: 50%; transform: translateX(-50%); z-index: 1310; background: #1f2530; border: 1px solid rgba(90,160,255,.4); color: #e8ecf4; font-size: 13px; padding: 9px 18px; border-radius: 8px; box-shadow: 0 8px 30px rgba(0,0,0,.5); }
</style>
