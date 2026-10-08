<script setup lang="ts">
// 全屏 Canvas 渲染层：只负责把 SpiderSim 画出来 + 响应扫描事件驱动路径。
// pointer-events:none，所有业务（评分/落桥/后端）在引擎与 Rust 侧。
import { onBeforeUnmount, onMounted, ref } from "vue";
import { SpiderSim, type ScanPoint, type SignalKind } from "./sim";
import { useSpiderAnchors } from "../../composables/useSpiderAnchors";
import { onSpiderScan } from "../../composables/useSpiderBotEngine";
import { buildWaypoints, type Vec2 } from "./ik";
import type { Anchor } from "./anchors";
import type { CardId } from "../../lib/cards";

const props = defineProps<{ logEl: Element | null }>();

const COLORS = {
  buy: "#ff4d8d",
  sell: "#17c964",
  scan: "#2fd4e1",
  leg: "#37e6f0",
  joint: "#ff5ea8",
  string: "#ff7ad9",
};

const canvasRef = ref<HTMLCanvasElement | null>(null);
const anchors = useSpiderAnchors();
const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

let sim: SpiderSim;
let ctx2d: CanvasRenderingContext2D | null = null; // 上下文只获取一次
let raf = 0;
let last = 0;
let signalByCode = new Map<string, SignalKind>();
let flyTimer = 0;
let unlisten: (() => void) | null = null;
let dpr = 1;

function signalColor(s: SignalKind): string {
  return s === "BUY" ? COLORS.buy : s === "SELL" ? COLORS.sell : COLORS.scan;
}

// ===== 扫描事件 → 行走路径 =====
function planCard(cardId: CardId) {
  const list = anchors.collect(cardId);
  if (!list.length) return;
  const pts: ScanPoint[] = [];
  let prev: Vec2 = { ...sim.body };
  list.slice(0, 8).forEach((a: Anchor, i: number) => {
    const via = i === 0 ? buildWaypoints(prev, a, { maxSeg: 3, segLen: 260 }) : [];
    via.forEach((v) =>
      pts.push({
        x: v.x, y: v.y,
        anchor: { ...a, x: v.x, y: v.y, width: 0, height: 0, id: `${a.id}:via${i}` },
        signal: null, via: true,
      }),
    );
    pts.push({ x: a.x, y: a.y, anchor: a, signal: signalByCode.get(a.code ?? "") ?? null });
    prev = { x: a.x, y: a.y };
  });
  if (pts.length) sim.resetPath(pts);
}

function onScan(ev: { type: string; cardId?: CardId; code?: string; signal?: SignalKind }) {
  if (ev.type === "card" && ev.cardId) {
    signalByCode = new Map();
    planCard(ev.cardId);
  } else if (ev.type === "target" && ev.code && ev.signal) {
    signalByCode.set(ev.code, ev.signal);
    // 蜘蛛正停在该行驻留时，即时补上信号色
    if (sim.current?.anchor.code === ev.code) sim.current.signal = ev.signal;
  }
}

function refreshFlyTarget() {
  const bridge = anchors.cardCenter("signalbridge");
  const fallback = anchors.elCenter(props.logEl);
  const target = bridge ?? fallback;
  if (target) sim.setFlyTarget({ x: target.x, y: target.y });
}

// ===== 绘制 =====
function draw(ctx: CanvasRenderingContext2D, now: number) {
  const { width, height } = ctx.canvas;
  ctx.clearRect(0, 0, width, height);
  ctx.save();
  ctx.scale(dpr, dpr);

  // 当前驻留行：高亮整行 + 光束（via 中途点不扫描、不高亮）
  const cur = sim.current;
  if (cur && !cur.via) {
    const color = signalColor(cur.signal);
    const a = cur.anchor;
    const pulse = 0.55 + 0.3 * Math.sin(now / 110);
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = reduced ? 0 : 14;
    ctx.strokeStyle = color;
    ctx.globalAlpha = pulse;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(a.x - 6, a.y - a.height / 2, a.width, a.height);
    // 光束：从头点到行中心的锥形
    const head = { x: sim.body.x, y: sim.body.y - 12 };
    const cx = a.x + Math.min(a.width, 180);
    const cy = a.y;
    ctx.globalAlpha = pulse * 0.8;
    ctx.beginPath();
    ctx.moveTo(head.x, head.y - 2);
    ctx.lineTo(cx, cy - 5);
    ctx.lineTo(cx, cy + 5);
    ctx.lineTo(head.x, head.y + 2);
    ctx.stroke();
    // 沿线脉冲方块
    if (!reduced) {
      const tt = (now % 900) / 900;
      const px = head.x + (cx - head.x) * tt;
      const py = head.y + (cy - head.y) * tt;
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = color;
      ctx.fillRect(px - 2, py - 2, 4, 4);
    }
    ctx.restore();
  }

  // 腿
  ctx.lineCap = "round";
  for (const l of sim.legsForRender()) {
    ctx.strokeStyle = COLORS.leg;
    ctx.lineWidth = l.lifting ? 2 : 1.4;
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.moveTo(l.hip.x, l.hip.y);
    ctx.lineTo(l.knee.x, l.knee.y);
    ctx.lineTo(l.foot.x, l.foot.y);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = COLORS.joint;
    ctx.beginPath();
    ctx.arc(l.foot.x, l.foot.y, l.lifting ? 3 : 2.2, 0, Math.PI * 2);
    ctx.fill();
  }

  // 身体：呼吸起伏 + 腹部椭圆 + 头点
  const bob = reduced ? 0 : Math.sin(now / 160) * 1.4;
  const bx = sim.body.x;
  const by = sim.body.y + bob;
  ctx.save();
  ctx.translate(bx, by);
  ctx.rotate(sim.angle);
  if (!reduced) {
    ctx.shadowColor = COLORS.leg;
    ctx.shadowBlur = 12;
  }
  ctx.fillStyle = "rgba(10,40,54,0.92)";
  ctx.strokeStyle = COLORS.leg;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.ellipse(0, 2, 7, 11, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = COLORS.leg;
  ctx.beginPath();
  ctx.arc(0, -9, 2.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // 数据包
  for (const p of sim.packets) {
    // 牵引线（拖行期连身体）
    if (p.state === "trailing") {
      ctx.strokeStyle = COLORS.string;
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(sim.body.x, sim.body.y);
      ctx.lineTo(p.pos.x, p.pos.y);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    const color = p.side === "BUY" ? COLORS.buy : COLORS.sell;
    const label = `${p.name} ${p.price.toFixed(2)} ${p.pct >= 0 ? "+" : ""}${p.pct.toFixed(1)}%`;
    ctx.font = "10px Consolas, monospace";
    const tw = ctx.measureText(label).width + 12;
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = reduced ? 0 : 10;
    ctx.fillStyle = "rgba(28,10,24,0.92)";
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.3;
    roundRect(ctx, p.pos.x - tw / 2, p.pos.y - 10, tw, 20, 5);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, p.pos.x, p.pos.y + 0.5);
    ctx.restore();
  }

  ctx.restore();
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function frame(now: number) {
  const ctx = ctx2d;
  if (!ctx) return;
  if (!last) last = now; // 首帧懒初始化，避免把 rAF 绝对时间戳当作 dt
  const dt = Math.min(50, now - last);
  last = now;
  const ev = sim.update(dt, now);
  if (ev.arrived && ev.arrived.signal) sim.spawnPacket(ev.arrived);
  draw(ctx, now);
  raf = requestAnimationFrame(frame);
}

function resize() {
  const c = canvasRef.value;
  if (!c) return;
  dpr = Math.min(2, window.devicePixelRatio || 1);
  c.width = window.innerWidth * dpr;
  c.height = window.innerHeight * dpr;
  c.style.width = `${window.innerWidth}px`;
  c.style.height = `${window.innerHeight}px`;
}

onMounted(() => {
  sim = new SpiderSim({ x: window.innerWidth * 0.3, y: window.innerHeight * 0.55 });
  resize();
  ctx2d = canvasRef.value?.getContext("2d") ?? null;
  refreshFlyTarget();
  flyTimer = window.setInterval(refreshFlyTarget, 250);
  window.addEventListener("resize", resize);
  unlisten = onSpiderScan(onScan);
  raf = requestAnimationFrame(frame);
});

onBeforeUnmount(() => {
  cancelAnimationFrame(raf);
  clearInterval(flyTimer);
  window.removeEventListener("resize", resize);
  unlisten?.();
});
</script>

<template>
  <canvas ref="canvasRef" class="spider-canvas" aria-hidden="true" />
</template>

<style scoped>
.spider-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  z-index: 1;
}
</style>
