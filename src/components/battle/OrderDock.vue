<script setup lang="ts">
import { computed, ref } from "vue";
import { brokerQuickOrder, type BrokerStatus } from "../../broker/api";
import { fetchOrderBook } from "../../api/market";
import { useQuotesStore } from "../../stores/quotes";
import { toast } from "../../composables/useToast";
import { canSubmitQuickOrder, limitPrices, positionVolume, type PositionPct } from "./orderModel";
import type { OrderBook } from "../../api/types";

const props = defineProps<{ status: BrokerStatus | null; cash: number }>();
const emit = defineEmits<{ (e: "ordered"): void }>();

const quotes = useQuotesStore();
const code = ref("");
const price = ref(0);
const vol = ref(100);
const position = ref<PositionPct>(2);
const side = ref<"BUY" | "SELL">("BUY");
const book = ref<OrderBook | null>(null);
const confirmOpen = ref(false);
const busy = ref(false);
const lastMsg = ref("");

const q = computed(() => quotes.map[code.value]);
const name = computed(() => q.value?.name ?? book.value?.name ?? "");
const prevClose = computed(() => book.value?.prevClose ?? q.value?.prevClose ?? 0);
const limit = computed(() => limitPrices(code.value, prevClose.value));

const chips = computed(() => [
  { label: "最新", value: q.value?.price ?? 0 },
  { label: "买一", value: book.value?.bids?.[0]?.price ?? 0 },
  { label: "卖一", value: book.value?.asks?.[0]?.price ?? 0 },
  { label: "涨停", value: limit.value.up },
  { label: "跌停", value: limit.value.down },
]);

const live = computed(() => !!props.status && props.status.kind !== "mock");
const blocked = computed(() => !props.status || props.status.killSwitch || !props.status.connected);
const canSubmit = computed(() =>
  canSubmitQuickOrder({ code: code.value, price: price.value, vol: vol.value, blocked: blocked.value }),
);
const modeText = computed(() => {
  if (!props.status) return "未连接";
  if (props.status.killSwitch) return "已熔断";
  if (!props.status.connected) return "未连接";
  return live.value ? (props.status.liveEnabled ? "实盘" : "实盘未启用") : "模拟";
});
const amount = computed(() => price.value * vol.value);

async function loadBook(c: string) {
  if (!/^\d{6}$/.test(c)) return;
  try {
    book.value = await fetchOrderBook(c);
    if (!price.value) price.value = book.value.price || 0;
  } catch {
    book.value = null;
  }
}

function applyPosition(p: PositionPct) {
  position.value = p;
  const v = positionVolume(props.cash, p, price.value);
  if (v > 0) vol.value = v;
}

function openConfirm(s: "BUY" | "SELL") {
  if (blocked.value) return;
  side.value = s;
  if (!price.value) price.value = q.value?.price ?? book.value?.price ?? 0;
  confirmOpen.value = true;
}

async function submit() {
  if (!canSubmit.value || busy.value) return;
  busy.value = true;
  lastMsg.value = "";
  try {
    const info = await brokerQuickOrder(code.value, side.value, price.value, vol.value, position.value);
    lastMsg.value = `已提交 ${info.sigId}`;
    toast.success(`${side.value === "BUY" ? "买入" : "卖出"}委托已提交：${code.value} ${vol.value} 股`);
    confirmOpen.value = false;
    emit("ordered");
  } catch (e) {
    lastMsg.value = String((e as Error)?.message ?? e);
    toast.error(lastMsg.value);
  } finally {
    busy.value = false;
  }
}

function setCode(c: string) {
  code.value = c;
  price.value = quotes.map[c]?.price ?? 0;
  void loadBook(c);
}
defineExpose({ setCode });
</script>

<template>
  <div class="od" data-testid="order-dock">
    <div class="od-row">
      <input
        v-model.trim="code"
        class="od-code mono"
        data-testid="order-code"
        placeholder="代码"
        maxlength="6"
        inputmode="numeric"
        @blur="loadBook(code)"
      />
      <span class="od-name">{{ name || "—" }}</span>

      <input v-model.number="price" class="od-num mono" type="number" step="0.01" min="0" placeholder="价格" />
      <input v-model.number="vol" class="od-num mono" type="number" step="100" min="0" placeholder="数量" />

      <div class="od-chips">
        <button
          v-for="c in chips"
          :key="c.label"
          type="button"
          class="od-chip"
          :disabled="!c.value"
          @click="price = c.value"
        >{{ c.label }}</button>
      </div>

      <div class="od-pos">
        <button type="button" class="od-chip" :class="{ on: position === 2 }" @click="applyPosition(2)">1/2</button>
        <button type="button" class="od-chip" :class="{ on: position === 3 }" @click="applyPosition(3)">1/3</button>
        <button type="button" class="od-chip" :class="{ on: position === 4 }" @click="applyPosition(4)">1/4</button>
      </div>

      <button type="button" class="od-btn buy" data-testid="order-buy" :disabled="blocked" @click="openConfirm('BUY')">买入</button>
      <button type="button" class="od-btn sell" data-testid="order-sell" :disabled="blocked" @click="openConfirm('SELL')">卖出</button>

      <span class="od-mode" :class="{ live, dead: blocked }" data-testid="order-mode">{{ modeText }}</span>
      <span v-if="lastMsg" class="od-msg" data-testid="order-msg">{{ lastMsg }}</span>
    </div>

    <div v-if="confirmOpen" class="od-mask" @click.self="confirmOpen = false">
      <div class="od-confirm" data-testid="order-confirm">
        <h4>{{ side === "BUY" ? "买入" : "卖出" }}确认</h4>
        <dl>
          <dt>标的</dt><dd>{{ name || "—" }} <span class="mono">{{ code }}</span></dd>
          <dt>价格</dt><dd class="mono">{{ price.toFixed(2) }}</dd>
          <dt>数量</dt><dd class="mono">{{ vol }} 股（{{ position === 2 ? "1/2" : position === 3 ? "1/3" : "1/4" }} 仓）</dd>
          <dt>金额</dt><dd class="mono">{{ amount.toLocaleString("zh-CN", { maximumFractionDigits: 2 }) }} 元</dd>
          <dt>账户</dt><dd>{{ modeText }}</dd>
          <dt>风控</dt><dd>提交时校验（熔断 / 白名单 / 单笔上限 / 新鲜度）</dd>
        </dl>
        <div class="od-actions">
          <button type="button" class="od-btn ghost" data-testid="order-confirm-cancel" @click="confirmOpen = false">取消</button>
          <button type="button" class="od-btn primary" data-testid="order-confirm-ok" :disabled="busy || !canSubmit" @click="submit">
            {{ busy ? "提交中…" : "确认下单" }}
          </button>
        </div>
        <p v-if="lastMsg" class="od-err">{{ lastMsg }}</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.od { border-top: 1px solid var(--border); padding-top: 8px; }
.od-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.od-code { width: 72px; }
.od-name { font-size: 11.5px; color: var(--text-dim); min-width: 48px; }
.od-num { width: 78px; }
.od-chip { padding: 2px 6px; font-size: 10.5px; border: 1px solid var(--border); border-radius: 5px; background: transparent; color: var(--text-dim); cursor: pointer; }
.od-chip:disabled { opacity: .45; cursor: default; }
.od-chip.on { color: var(--accent); border-color: var(--accent); }
.od-chips, .od-pos { display: flex; gap: 3px; }
.od-btn { padding: 4px 12px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg-card); color: var(--text); font-size: 12px; cursor: pointer; }
.od-btn:disabled { opacity: .45; cursor: not-allowed; }
.od-btn.buy { color: var(--up); border-color: var(--up); }
.od-btn.sell { color: var(--down); border-color: var(--down); }
.od-btn.primary { background: var(--accent); color: #111; border-color: var(--accent); }
.od-btn.ghost { background: transparent; }
.od-mode { margin-left: auto; font-size: 10.5px; padding: 1px 6px; border-radius: 4px; border: 1px solid var(--border); color: var(--text-dim); }
.od-mode.live { color: var(--up); border-color: var(--up); }
.od-mode.dead { color: var(--text-dim); opacity: .8; }
.od-msg { font-size: 11px; color: var(--text-dim); }
.od-mask { position: fixed; inset: 0; background: rgba(5,7,11,.55); display: flex; align-items: center; justify-content: center; z-index: 400; }
.od-confirm { width: 340px; background: var(--bg-card); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; }
.od-confirm h4 { margin: 0 0 10px; font-size: 13px; }
.od-confirm dl { display: grid; grid-template-columns: 56px 1fr; gap: 4px 8px; margin: 0; font-size: 12px; }
.od-confirm dt { color: var(--text-dim); }
.od-confirm dd { margin: 0; }
.od-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
.od-err { margin: 8px 0 0; color: var(--up); font-size: 11.5px; }
.mono { font-variant-numeric: tabular-nums; }
</style>
