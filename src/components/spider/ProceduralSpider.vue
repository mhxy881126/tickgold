<script setup lang="ts">
// 全屏 Canvas 渲染层：只负责把 SpiderSim 画出来 + 响应扫描事件驱动路径。
// pointer-events:none，所有业务（评分/落桥/后端）在引擎与 Rust 侧。
import { onBeforeUnmount, onMounted, ref } from "vue";
import { SpiderSim, type ScanPoint, type SignalKind } from "./sim";
import { resolveSignal } from "./signals";
import { useSpiderAnchors } from "../../composables/useSpiderAnchors";
import {
  onSpiderScan,
  advanceRound,
  heartbeat,
  type SpiderScanEvent,
} from "../../composables/useSpiderBotEngine";
import { smartRoute, naturalWaypoints, roamPath, localWanderPath, edgeRoute, type Vec2 } from "./ik";
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
let ctx2d: CanvasRenderingContext2D | null = null;
let raf = 0;
let last = 0;
let signalByCode = new Map<string, SignalKind>();
let flyTimer = 0;
// 有界重采令牌
let collectToken = 0;
let collectRetry = 0;
let lastCardId: CardId | null = null;
// 轮次推进
let roundDone = false;
let advanceTimer = 0;
let lastHeartbeat = 0;
// 滚动重采去抖
let scrollTimer = 0;
let alive = false;
let unlisten: (() => void) | null = null;
let dpr = 1;
// 扫描数据粒子：从行内被光束"吸出来"流向蜘蛛
const scanParticles: {
  x: number; y: number; vx: number; vy: number;
  life: number; maxLife: number; size: number; color: string;
}[] = [];
const MAX_SCAN_PARTICLES = 60;
// 空转漫游定时器（统一管理启动阶段+引擎跳卡两种场景）
let idleRoamTimer = 0;
const IDLE_ROAM_MS = 600;

// 自动推进：路径走完后引擎没响应，就自动跳下一张卡（自动发现模式的补充）
let autoNextTimer = 0;
const AUTO_NEXT_MS = 1200;

function triggerAutoNext() {
  if (autoNextTimer) return;
  autoNextTimer = window.setTimeout(() => {
    autoNextTimer = 0;
    if (!alive || !lastCardId || sim.active) return;
    // 引擎 1.2s 没给新卡 → 自动跳下一张
    autoDiscoverNext();
  }, AUTO_NEXT_MS);
}

function clearAutoNext() {
  if (autoNextTimer) { clearTimeout(autoNextTimer); autoNextTimer = 0; }
}

// ===== 自动发现：引擎事件没连上时，蜘蛛自己找页面上的卡片爬 =====
// 双保险：启动后 1.5s 还没收到 card 事件，就自动扫描页面上的卡片
const AUTO_DISCOVER_MS = 1500;
let autoDiscoverTimer = 0;
// 自动扫描时会循环这些卡片
const AUTO_DISCOVER_CARDS: CardId[] = [
  "watch", "rank", "sector", "concept", "market", "radar", "dragon", "screener",
];
let autoDiscoverIdx = 0;

function startAutoDiscover() {
  if (autoDiscoverTimer) return;
  autoDiscoverTimer = window.setTimeout(() => {
    autoDiscoverTimer = 0;
    if (!alive || lastCardId !== null) return; // 已经收到过 card 事件就不用自动发现了
    autoDiscoverNext();
  }, AUTO_DISCOVER_MS);
}

function autoDiscoverNext() {
  if (!alive || lastCardId !== null) return;
  // 依次尝试每个卡片，找到第一个 DOM 存在的
  for (let tries = 0; tries < AUTO_DISCOVER_CARDS.length; tries++) {
    const cardId = AUTO_DISCOVER_CARDS[autoDiscoverIdx % AUTO_DISCOVER_CARDS.length];
    autoDiscoverIdx++;
    const el = document.querySelector(`[data-card-id="${cardId}"]`);
    if (el) {
      // 找到一张可见的卡片 → 模拟收到 card 事件
      lastCardId = cardId;
      planCard(cardId);
      return;
    }
  }
  // 一个都找不到 → 1 秒后再试
  autoDiscoverTimer = window.setTimeout(autoDiscoverNext, 1000);
}

function stopAutoDiscover() {
  if (autoDiscoverTimer) { clearTimeout(autoDiscoverTimer); autoDiscoverTimer = 0; }
}

function signalColor(s: SignalKind): string {
  return s === "BUY" ? COLORS.buy : s === "SELL" ? COLORS.sell : COLORS.scan;
}

// ===== 扫描事件 → 行走路径 =====
// 核心策略：保证每卡至少有一次扫描视觉效果（光束+脉冲），有行再多扫几行
//   1. 卡片中心/标题栏 作为第一个真实扫描点（非 via，有光束+脉冲）
//   2. 后台重试采集真实行，采到了立即重建路径逐行扫描
//   3. 采不到也至少有卡片中心这一下的效果，不会"什么也不干"
function planCard(cardId: CardId) {
  const token = ++collectToken;
  lastCardId = cardId;
  roundDone = false;
  if (advanceTimer) { clearTimeout(advanceTimer); advanceTimer = 0; }
  cancelAnimationFrame(collectRetry);
  let attempts = 0;

  // 找一个"主扫描点"：优先用标题栏（有高度），没有就用卡片中心
  // 这个点一定是非 via 的，会触发光束和行框脉冲，保证有扫描视觉效果
  const cardEl = document.querySelector(`[data-card-id="${cardId}"]`);
  let mainAnchor: Anchor | null = null;
  if (cardEl) {
    // 先找标题栏
    const headEl = cardEl.querySelector(".card-head");
    if (headEl) {
      const rc = headEl.getBoundingClientRect();
      if (rc.width > 0 && rc.height > 0) {
        mainAnchor = {
          id: `${cardId}:head`,
          cardId,
          x: rc.left + 12,
          y: rc.top + rc.height / 2,
          width: rc.width,
          height: rc.height,
          name: "标题栏",
          kind: "header",
        };
      }
    }
    // 没有标题栏就用卡片整体
    if (!mainAnchor) {
      const rc = cardEl.getBoundingClientRect();
      if (rc.width > 0 && rc.height > 0) {
        mainAnchor = {
          id: `${cardId}:center`,
          cardId,
          x: rc.left + 12,
          y: rc.top + rc.height / 2,
          width: rc.width,
          height: rc.height,
          name: "卡片中心",
          kind: "card-center",
        };
      }
    }
  }

  // 构建初始路径：当前位置 → 主扫描点（至少保证有一次扫描效果）
  // 跨卡片：走面板边缘车道，不空中飞
  if (mainAnchor) {
    const vp = { w: window.innerWidth, h: window.innerHeight };
    const edgePts = edgeRoute(sim.body, mainAnchor, vp, { pad: 52, minDirect: 150, spacing: 200 });
    const viaPts = edgePts.length > 0
      ? edgePts
      : naturalWaypoints(sim.body, mainAnchor, { intensity: 0.4 });
    const pts: ScanPoint[] = viaPts.map((v) => ({
      x: v.x, y: v.y,
      anchor: { ...mainAnchor!, x: v.x, y: v.y, width: 0, height: 0, id: `viastart:${cardId}` },
      signal: null, via: true,
    }));
    pts.push({ x: mainAnchor.x, y: mainAnchor.y, anchor: mainAnchor, signal: null });
    sim.resetPath(pts);
  }

  const buildRowPath = (list: Anchor[]) => {
    const pts: ScanPoint[] = [];
    let prev: Vec2 = { ...sim.body };
    const vp = { w: window.innerWidth, h: window.innerHeight };
    const routeSeed = Date.now() + (cardId.charCodeAt(0) || 0);
    list.slice(0, 6).forEach((a: Anchor, i: number) => {
      let via: Vec2[];
      if (i === 0) {
        // 第一跳：跨卡片进入 → 强制走面板边缘车道，不空中飞行
        // 先用 edgeRoute 贴边；如果距离太近 edgeRoute 返回空，再 fallback 到自然曲线
        const edgePts = edgeRoute(prev, a, vp, { pad: 52, minDirect: 150, spacing: 200 });
        via = edgePts.length > 0
          ? edgePts
          : naturalWaypoints(prev, a, { seed: routeSeed + i, intensity: 0.4 });
      } else {
        // 同卡行间：短距离自然曲线即可
        via = naturalWaypoints(prev, a, { seed: routeSeed + i, intensity: 0.4 });
      }
      via.forEach((v) =>
        pts.push({
          x: v.x, y: v.y,
          anchor: { ...a, x: v.x, y: v.y, width: 0, height: 0, id: `${a.id}:via${i}` },
          signal: null, via: true,
        }),
      );
      pts.push({ x: a.x, y: a.y, anchor: a, signal: null });
      prev = { x: a.x, y: a.y };
    });
    if (pts.length) {
      sim.resetPath(pts);
      if (advanceTimer) { clearTimeout(advanceTimer); advanceTimer = 0; }
      roundDone = false;
    }
  };

  const attempt = () => {
    if (token !== collectToken) return;
    const list = anchors.collect(cardId);
    // 采到真实行 → 重建路径逐行扫描
    if (list.length > 0 && list.some(a => a.kind === "row" || a.code)) {
      const rowAnchors = list.filter(a => a.kind === "row" || a.code || a.name);
      if (rowAnchors.length > 0) {
        buildRowPath(rowAnchors);
        return;
      }
    }
    // 没采到行：继续重试（40 次 ≈ 前 15 帧高频 + 后 25 次 50ms ≈ 1.25s）
    if (attempts++ < 40) {
      if (attempts < 15) {
        collectRetry = requestAnimationFrame(attempt);
      } else {
        collectRetry = window.setTimeout(
          () => { if (token === collectToken) requestAnimationFrame(attempt); },
          50,
        ) as unknown as number;
      }
      return;
    }
    // 重试耗尽：在标题栏附近小范围踱步（每圈都扫一次标题栏，不空跑）
    if (mainAnchor) {
      const pts: ScanPoint[] = [];
      // 先走到主锚点（非 via，触发光束+脉冲）
      const toMain = naturalWaypoints(sim.body, mainAnchor, { intensity: 0.3 });
      toMain.forEach((v) => {
        pts.push({
          x: v.x, y: v.y,
          anchor: { ...mainAnchor!, x: v.x, y: v.y, width: 0, height: 0, id: `wapproach:${cardId}` },
          signal: null, via: true,
        });
      });
      pts.push({ x: mainAnchor.x, y: mainAnchor.y, anchor: mainAnchor, signal: null });

      // 小范围椭圆踱步（半径 30-40px，不像大圈乱跑）
      // 4 圈，每圈回到主锚点扫一次
      const loops = 4;
      const pointsPerLoop = 8;
      const rx = 32, ry = 22;
      for (let loop = 0; loop < loops; loop++) {
        for (let i = 1; i <= pointsPerLoop; i++) {
          const t = i / pointsPerLoop;
          const angle = t * Math.PI * 2;
          const x = mainAnchor.x + Math.cos(angle) * rx;
          const y = mainAnchor.y + Math.sin(angle) * ry;
          if (i < pointsPerLoop) {
            pts.push({
              x, y,
              anchor: { ...mainAnchor!, x, y, width: 0, height: 0, id: `wander:${cardId}:${loop}-${i}` },
              signal: null, via: true,
            });
          } else {
            // 每圈终点：回到主锚点，触发光束+脉冲
            pts.push({ x: mainAnchor.x, y: mainAnchor.y, anchor: mainAnchor, signal: null });
          }
        }
      }

      if (pts.length > 1) {
        sim.resetPath(pts);
      } else {
        sim.resetPath([]);
        scheduleAdvance();
      }
    } else {
      // 连卡片都找不到 → 短贴边漫游兜底
      const roam = roamPath(sim.body, { w: window.innerWidth, h: window.innerHeight },
        { distance: Math.min(600, window.innerWidth + window.innerHeight) * 0.35 });
      if (roam.length) {
        sim.resetPath(roam.map((v, j) => ({
          x: v.x, y: v.y,
          anchor: { id: `roam:${cardId}:${j}`, cardId, x: v.x, y: v.y, width: 0, height: 0 },
          signal: null, via: true,
        })));
      } else {
        sim.resetPath([]);
        scheduleAdvance();
      }
    }
  };
  attempt();
}

function onScan(ev: SpiderScanEvent) {
  if (ev.type === "card") {
    signalByCode = new Map();
    // 收到真实 card 事件 → 停止自动发现和自动推进，进入正常模式
    stopAutoDiscover();
    clearAutoNext();
    planCard(ev.cardId);
  } else {
    const { code, signal } = ev;
    signalByCode.set(code, signal);
    // 蜘蛛正停在该行驻留时，即时补上信号色
    if (signal && sim.current && !sim.current.via && sim.current.anchor.code === code) {
      sim.current.signal = signal;
    }
  }
}

// 滚动重采
function onScroll(ev: Event) {
  const target = ev.target as Element | null;
  if (!target?.closest?.("[data-card-id]")) return;
  if (scrollTimer) clearTimeout(scrollTimer);
  scrollTimer = window.setTimeout(() => {
    scrollTimer = 0;
    if (alive && sim.active && lastCardId !== null) planCard(lastCardId);
  }, 150);
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
  // 非 via（via 为 undefined/false 都算非 via）且有宽度 → 真实扫描点
  if (cur && !cur.via && cur.anchor.width > 0) {
    const color = signalColor(cur.signal);
    const a = cur.anchor;
    const isHeader = a.kind === "header" || a.kind === "card-center";
    const pulse = 0.6 + 0.4 * Math.sin(now / 90);
    // 扫描进度 0~1：
    // - 驻留中：用 sim.scanProgress（与驻留同步，0→1 完整扫完）
    // - 接近中（未到达）：根据距离计算预热进度（0~0.25），营造"正在靠近并准备扫描"的感觉
    const sp = sim.scanProgress;
    let scanProgress: number;
    if (sp > 0) {
      scanProgress = sp;
    } else {
      // 接近阶段：根据到目标的距离计算预热强度（越近越强，最多到 25%）
      const dx = sim.body.x - cur.x;
      const dy = sim.body.y - cur.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const approachDist = 120; // 进入此距离开始预热
      const approachT = Math.max(0, Math.min(1, 1 - dist / approachDist));
      scanProgress = approachT * 0.25; // 最多扫到 25%，营造蓄势感
    }

    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = reduced ? 0 : 18;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;

    // ═══ 通用：扫描光束横扫（行和标题栏都有）═══
    const topY = a.y - a.height / 2;
    const botY = a.y + a.height / 2;
    const leftX = a.x - 8;
    const rightX = a.x + a.width + 8;
    const totalW = rightX - leftX;

    // 1. 横向扫描光束（从左向右扫过整行）
    const beamX = leftX + scanProgress * totalW;
    const beamWidth = Math.max(60, totalW * 0.15);
    const beamGrad = ctx.createLinearGradient(beamX - beamWidth, 0, beamX + beamWidth, 0);
    beamGrad.addColorStop(0, "transparent");
    beamGrad.addColorStop(0.3, color + "18");
    beamGrad.addColorStop(0.5, color + "55");
    beamGrad.addColorStop(0.7, color + "18");
    beamGrad.addColorStop(1, "transparent");
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = beamGrad;
    ctx.fillRect(beamX - beamWidth, topY - 2, beamWidth * 2, a.height + 4);

    // 2. 扫描竖线（亮线）
    ctx.globalAlpha = 1;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.shadowBlur = reduced ? 0 : 25;
    ctx.beginPath();
    ctx.moveTo(beamX, topY - 6);
    ctx.lineTo(beamX, botY + 6);
    ctx.stroke();
    ctx.shadowBlur = reduced ? 0 : 18;

    // 3. 行框脉冲（四角高亮 + 完整边框）
    ctx.globalAlpha = pulse * 0.85;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = color;
    ctx.strokeRect(leftX, topY, a.width + 16, a.height);

    // 四角装饰（科技感直角）
    const cornerLen = Math.min(16, a.height * 0.8);
    ctx.globalAlpha = pulse;
    ctx.lineWidth = 2;
    ctx.beginPath();
    // 左上
    ctx.moveTo(leftX, topY + cornerLen);
    ctx.lineTo(leftX, topY);
    ctx.lineTo(leftX + cornerLen, topY);
    // 右上
    ctx.moveTo(rightX - cornerLen, topY);
    ctx.lineTo(rightX, topY);
    ctx.lineTo(rightX, topY + cornerLen);
    // 左下
    ctx.moveTo(leftX, botY - cornerLen);
    ctx.lineTo(leftX, botY);
    ctx.lineTo(leftX + cornerLen, botY);
    // 右下
    ctx.moveTo(rightX - cornerLen, botY);
    ctx.lineTo(rightX, botY);
    ctx.lineTo(rightX, botY - cornerLen);
    ctx.stroke();

    // 4. 行内已扫描区域的渐变填充（左侧亮，右侧暗）
    const scannedW = scanProgress * totalW;
    if (scannedW > 2) {
      const fillGrad = ctx.createLinearGradient(leftX, 0, leftX + scannedW, 0);
      fillGrad.addColorStop(0, color + "2a");
      fillGrad.addColorStop(0.7, color + "14");
      fillGrad.addColorStop(1, color + "05");
      ctx.globalAlpha = 0.65;
      ctx.fillStyle = fillGrad;
      ctx.fillRect(leftX, topY, scannedW, a.height);
    }

    // 5. 标题栏专属：顶部高亮条 + 底部波纹
    if (isHeader && a.width > 120) {
      // 顶部高亮条（呼吸）
      ctx.globalAlpha = 0.8 + 0.2 * Math.sin(now / 130);
      ctx.fillStyle = color;
      ctx.fillRect(leftX, topY - 3, totalW, 3);

      // 底部波纹扩散（2~3 圈）
      if (!reduced) {
        for (let i = 0; i < 3; i++) {
          const ringT = ((now / 1000) + i * 0.33) % 1;
          const ringY = botY + ringT * 28;
          const ringAlpha = (1 - ringT) * 0.45;
          ctx.globalAlpha = ringAlpha;
          ctx.strokeStyle = color;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.ellipse(a.x + a.width / 2, ringY, a.width / 2 * (0.8 + ringT * 0.3), 5 * (1 + ringT), 0, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    }

    // 6. 蜘蛛头到扫描线的锥形光束 + 粒子
    const head = { x: sim.body.x, y: sim.body.y - 26 };
    const cx = beamX;  // 光束跟随扫描线
    const cy = a.y;
    ctx.globalAlpha = pulse * 0.75;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(head.x, head.y - 3);
    ctx.lineTo(cx, cy - 6);
    ctx.lineTo(cx, cy + 6);
    ctx.lineTo(head.x, head.y + 3);
    ctx.stroke();

    // 沿线脉冲小方块（3 个错落，对应视频效果）
    if (!reduced) {
      for (let i = 0; i < 3; i++) {
        const tt = ((now / 700) + i * 0.35) % 1;
        const px = head.x + (cx - head.x) * tt;
        const py = head.y + (cy - head.y) * tt;
        ctx.globalAlpha = (1 - tt) * 0.95;
        ctx.fillStyle = color;
        const size = 3 + (1 - tt) * 3.5;
        // 旋转 45 度的菱形方块（更有"脉冲数据块"的感觉）
        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(Math.PI / 4);
        ctx.fillRect(-size / 2, -size / 2, size, size);
        ctx.restore();
      }
    }

    // 7. 扫描线两端的端点亮点
    ctx.globalAlpha = pulse;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(beamX, topY, 3.5, 0, Math.PI * 2);
    ctx.arc(beamX, botY, 3.5, 0, Math.PI * 2);
    ctx.fill();

    // 8. 数据粒子：从光束位置被"吸出来"流向蜘蛛头
    if (!reduced && sp > 0.05) {
      // 每帧生成 2-4 个粒子
      const emitCount = 2 + Math.floor(Math.random() * 3);
      for (let i = 0; i < emitCount && scanParticles.length < MAX_SCAN_PARTICLES; i++) {
        const px = beamX + (Math.random() - 0.5) * 20;
        const py = a.y + (Math.random() - 0.5) * a.height * 0.7;
        const dx = head.x - px;
        const dy = head.y - py;
        const dist = Math.hypot(dx, dy) || 1;
        const speed = 80 + Math.random() * 60;
        scanParticles.push({
          x: px, y: py,
          vx: (dx / dist) * speed,
          vy: (dy / dist) * speed,
          life: 0,
          maxLife: 600 + Math.random() * 400,
          size: 1 + Math.random() * 2,
          color,
        });
      }
    }

    ctx.restore();
  }

  // ===== 数据粒子更新与绘制 =====
  if (!reduced && scanParticles.length > 0) {
    const dt = Math.min(50, now - last);
    ctx.save();
    for (let i = scanParticles.length - 1; i >= 0; i--) {
      const p = scanParticles[i];
      p.life += dt;
      if (p.life >= p.maxLife) {
        scanParticles.splice(i, 1);
        continue;
      }
      p.x += p.vx * (dt / 1000);
      p.y += p.vy * (dt / 1000);
      // 越靠近蜘蛛，粒子越淡越小
      const t = p.life / p.maxLife;
      const alpha = (1 - t) * 0.8;
      const size = p.size * (1 - t * 0.5);
      ctx.globalAlpha = alpha;
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 6;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  // 腿
  ctx.lineCap = "round";
  for (const l of sim.legsForRender()) {
    ctx.strokeStyle = COLORS.leg;
    ctx.lineWidth = l.lifting ? 2.6 : 1.6;
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

  // 身体：呼吸起伏 + 多节轮廓 + 头眼 + 须肢
  const bob = reduced ? 0 : Math.sin(now / 160) * 2.5;
  const bx = sim.body.x;
  const by = sim.body.y + bob;
  ctx.save();
  ctx.translate(bx, by);
  ctx.rotate(sim.angle);
  ctx.lineJoin = "round";

  // 一体轮廓
  ctx.save();
  if (!reduced) { ctx.shadowColor = COLORS.leg; ctx.shadowBlur = 14; }
  ctx.fillStyle = "rgba(10,40,54,0.95)";
  ctx.strokeStyle = COLORS.leg;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(0, -22);
  ctx.bezierCurveTo(8, -22, 13, -16, 13, -8);
  ctx.bezierCurveTo(13, -2, 9, 3, 6, 5);
  ctx.bezierCurveTo(11, 7, 16, 12, 16, 20);
  ctx.bezierCurveTo(16, 30, 8, 35, 0, 36);
  ctx.bezierCurveTo(-8, 35, -16, 30, -16, 20);
  ctx.bezierCurveTo(-16, 12, -11, 7, -6, 5);
  ctx.bezierCurveTo(-9, 3, -13, -2, -13, -8);
  ctx.bezierCurveTo(-13, -16, -8, -22, 0, -22);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  // 腹节纹 3 条 + 中轴暗纹
  ctx.save();
  ctx.strokeStyle = "rgba(55,230,240,0.3)";
  ctx.lineWidth = 1;
  for (const yy of [12, 20, 27]) {
    ctx.beginPath();
    ctx.ellipse(0, yy, 10, 4, 0, 0, Math.PI);
    ctx.stroke();
  }
  ctx.strokeStyle = "rgba(0,0,0,0.35)";
  ctx.beginPath();
  ctx.moveTo(0, 7);
  ctx.lineTo(0, 34);
  ctx.stroke();
  ctx.restore();

  // 尾端纺器
  ctx.strokeStyle = COLORS.leg;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(-2, 36); ctx.lineTo(-2, 39);
  ctx.moveTo(2, 36); ctx.lineTo(2, 39);
  ctx.stroke();

  // 头眼（4：2 大 2 小）
  ctx.fillStyle = COLORS.leg;
  if (!reduced) { ctx.shadowColor = COLORS.leg; ctx.shadowBlur = 8; }
  for (const [ex, ey, er] of [
    [-4, -18, 1.8], [4, -18, 1.8], [-7, -14, 1.2], [7, -14, 1.2],
  ] as const) {
    ctx.beginPath();
    ctx.arc(ex, ey, er, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.shadowBlur = 0;

  // 须肢
  ctx.strokeStyle = COLORS.leg;
  ctx.lineWidth = 1.3;
  ctx.beginPath();
  ctx.moveTo(-4, -20); ctx.lineTo(-7, -26); ctx.lineTo(-5, -31);
  ctx.moveTo(4, -20); ctx.lineTo(7, -26); ctx.lineTo(5, -31);
  ctx.stroke();

  ctx.restore();

  // 数据包
  for (const p of sim.packets) {
    const color = p.side === "BUY" ? COLORS.buy : COLORS.sell;

    // 拖尾线（trailing 和 flying 状态都画）
    if (p.trail && p.trail.length > 1) {
      for (let i = 0; i < p.trail.length - 1; i++) {
        const alpha = (1 - i / p.trail.length) * 0.6;
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(0.5, 2 - i * 0.15);
        ctx.beginPath();
        ctx.moveTo(p.trail[i].x, p.trail[i].y);
        ctx.lineTo(p.trail[i + 1].x, p.trail[i + 1].y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // 粉色牵引线（trailing 状态连接蜘蛛身体，抽出阶段连接行位置）
    if (p.state === "trailing" || p.state === "extracting") {
      const lineStart = p.state === "trailing"
        ? { x: sim.body.x, y: sim.body.y + 8 }
        : p.extractFrom;
      // 外发光
      if (!reduced) {
        ctx.shadowColor = COLORS.string;
        ctx.shadowBlur = 8;
      }
      ctx.strokeStyle = COLORS.string;
      ctx.globalAlpha = 0.65;
      ctx.lineWidth = 1.2;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(lineStart.x, lineStart.y);
      ctx.lineTo(p.pos.x, p.pos.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
    }

    // 数据包磁贴（extracting/trailing/flying 状态都显示）
    if (p.state === "extracting" || p.state === "trailing" || p.state === "flying") {
      const nameText = p.name || p.code;
      const priceText = p.price > 0 ? `${p.price.toFixed(2)}` : "";
      const pctText = p.pct !== undefined ? `${p.pct >= 0 ? "+" : ""}${p.pct.toFixed(1)}%` : "";
      const label = nameText + "  " + priceText + "  " + pctText;
      ctx.font = "bold 10px Consolas, monospace";
      const tw = Math.max(78, ctx.measureText(label).width + 18);
      const th = 24;

      // 抽出动画：scale 从 0.3 弹到 1
      let scale = 1;
      if (p.state === "extracting") {
        const t = p.t;
        // 弹性回弹：0 → 1.1 → 1
        scale = t < 0.6
          ? t / 0.6 * 1.1
          : 1.1 - (t - 0.6) / 0.4 * 0.1;
        scale = Math.max(0.2, scale);
      }

      // 飞行状态下前 15% 和后 15% 渐隐
      let bodyAlpha = 1;
      if (p.state === "flying") {
        if (p.t < 0.15) bodyAlpha = p.t / 0.15;
        else if (p.t > 0.85) bodyAlpha = (1 - p.t) / 0.15;
      }
      if (p.state === "extracting") {
        bodyAlpha = 0.3 + 0.7 * p.t; // 抽出时渐显
      }

      ctx.save();
      ctx.translate(p.pos.x, p.pos.y);
      ctx.scale(scale, scale);
      ctx.globalAlpha = bodyAlpha;
      ctx.shadowColor = color;
      ctx.shadowBlur = reduced ? 0 : 16;

      // 磁贴背景
      ctx.fillStyle = "rgba(18,6,16,0.96)";
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.4;
      roundRect(ctx, -tw / 2, -th / 2, tw, th, 4);
      ctx.fill();
      ctx.stroke();

      // 左侧色条（磁贴感）
      ctx.shadowBlur = 0;
      ctx.fillStyle = color;
      ctx.globalAlpha = bodyAlpha * 0.9;
      ctx.fillRect(-tw / 2 + 1, -th / 2 + 1, 3.5, th - 2);

      // BUY/SELL 小箭头图标
      ctx.globalAlpha = bodyAlpha;
      ctx.fillStyle = color;
      ctx.font = "bold 9px Consolas, monospace";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      const arrow = p.side === "BUY" ? "▲" : "▼";
      ctx.fillText(arrow, -tw / 2 + 7, -3);

      // 股票名称（上排，粗体）
      ctx.fillStyle = "#e8f4f2";
      ctx.font = "bold 10px Consolas, 'PingFang SC', sans-serif";
      ctx.textAlign = "center";
      const displayName = nameText.length > 5 ? nameText.slice(0, 5) + ".." : nameText;
      ctx.fillText(displayName, 4, -3);

      // 价格 + 涨跌幅（下排）
      ctx.fillStyle = color;
      ctx.font = "9px Consolas, monospace";
      const pricePct = priceText + " " + pctText;
      ctx.fillText(pricePct, 4, 6);

      ctx.restore();
    }

    // 消散粒子
    if (p.state === "dissolving" && p.particles) {
      for (const pt of p.particles) {
        if (pt.life >= pt.maxLife) continue;
        const alpha = 1 - pt.life / pt.maxLife;
        ctx.globalAlpha = alpha * 0.8;
        ctx.fillStyle = color;
        ctx.shadowColor = color;
        ctx.shadowBlur = reduced ? 0 : 6;
        ctx.beginPath();
        ctx.arc(pt.pos.x, pt.pos.y, pt.size * alpha, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;
    }
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

/** 一轮收尾：路径走完且数据包飞完 600ms 后推进下一轮 */
function scheduleAdvance() {
  if (roundDone) return;
  roundDone = true;
  if (advanceTimer) clearTimeout(advanceTimer);
  advanceTimer = window.setTimeout(() => {
    advanceTimer = 0;
    if (alive && roundDone) advanceRound();
  }, 600);
}

function frame(now: number) {
  const ctx = ctx2d;
  if (!ctx) return;
  if (!last) last = now;
  const dt = Math.min(50, now - last);
  last = now;
  const ev = sim.update(dt, now);

  // 到达帧解析信号
  if (ev.arrived && !ev.arrived.via) {
    const sig = resolveSignal(signalByCode, ev.arrived.anchor.code, ev.arrived.signal);
    ev.arrived.signal = sig;
    if (sig) sim.spawnPacket(ev.arrived);
  }

  // 路径走完 → 推进引擎下一轮（只有引擎已启动时才推进）
  if (lastCardId !== null && !sim.active && sim.packets.length === 0) {
    scheduleAdvance();
    // 引擎没响应的话，自动跳下一张卡（双保险）
    triggerAutoNext();
  } else {
    clearAutoNext();
  }

  // ═══ 空转漫游：路径走完且无数据包时，自动漫游一小段 ═══
  // 两种场景：
  //   启动阶段（lastCardId 为 null）：循环漫游等第一张卡
  //   引擎跳卡（lastCardId 有值）：短暂漫游等下一轮
  if (!sim.active && sim.packets.length === 0) {
    if (!idleRoamTimer) {
      idleRoamTimer = window.setTimeout(() => {
        idleRoamTimer = 0;
        if (!alive || sim.active) return;
        const cardAnchor = lastCardId ? anchors.cardCenter(lastCardId) : null;
        const cardIdForAnchor = lastCardId ?? "warmup";
        const pts: ScanPoint[] = [];
        if (cardAnchor) {
          // 有目标卡片 → 在卡片附近椭圆游荡
          const wander = localWanderPath(sim.body, cardAnchor,
            { radiusX: 55, radiusY: 38, loops: 1.2, points: 10 });
          wander.forEach((v, j) => {
            pts.push({
              x: v.x, y: v.y,
              anchor: { ...cardAnchor, x: v.x, y: v.y, width: 0, height: 0, id: `idle:${cardIdForAnchor}:${j}` },
              signal: null, via: true,
            });
          });
        } else {
          // 没有目标（启动阶段）→ 贴边短漫游
          const roam = roamPath(sim.body, { w: window.innerWidth, h: window.innerHeight },
            { distance: Math.min(1000, window.innerWidth + window.innerHeight) * 0.5 });
          roam.forEach((v, j) => {
            pts.push({
              x: v.x, y: v.y,
              anchor: { id: `warmup:${j}`, cardId: cardIdForAnchor, x: v.x, y: v.y, width: 0, height: 0 },
              signal: null, via: true,
            });
          });
        }
        if (pts.length) {
          sim.resetPath(pts);
          roundDone = false;
        }
      }, lastCardId === null ? 300 : IDLE_ROAM_MS);
    }
  } else {
    // 有真实路径在走 → 清掉空转漫游
    if (idleRoamTimer) { clearTimeout(idleRoamTimer); idleRoamTimer = 0; }
  }

  // 活动心跳（5s 重置看门狗）
  if (now - lastHeartbeat > 5000) { lastHeartbeat = now; heartbeat(); }

  draw(ctx, now);

  // rAF 永不停止（蜘蛛绘制量极小，永久运行开销可忽略）
  if (alive) {
    raf = requestAnimationFrame(frame);
  } else {
    raf = 0;
  }
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
  alive = true;
  sim = new SpiderSim(
    { x: window.innerWidth / 2, y: 80 },
    { reducedMotion: reduced },
  );
  resize();
  ctx2d = canvasRef.value?.getContext("2d") ?? null;
  refreshFlyTarget();
  flyTimer = window.setInterval(refreshFlyTarget, 250);
  window.addEventListener("resize", resize);
  window.addEventListener("scroll", onScroll, { capture: true, passive: true });
  unlisten = onSpiderScan(onScan);
  // 挂载即漫游一小段（0.3 屏周长），消除首个 card 事件前的空窗期
  const roam = roamPath(sim.body, { w: window.innerWidth, h: window.innerHeight },
    { distance: Math.min(500, window.innerWidth + window.innerHeight) * 0.3, spacing: 150 });
  if (roam.length) {
    sim.resetPath(roam.map((v, j) => ({
      x: v.x, y: v.y,
      anchor: { id: "roam:init:" + j, cardId: "roam", x: v.x, y: v.y, width: 0, height: 0 },
      signal: null, via: true,
    })));
  }
  raf = requestAnimationFrame(frame);
  // 启动自动发现：1.5s 没收到 card 事件就自己找卡片爬
  startAutoDiscover();
});

onBeforeUnmount(() => {
  alive = false;
  collectToken++;
  cancelAnimationFrame(raf);
  cancelAnimationFrame(collectRetry);
  clearInterval(flyTimer);
  stopAutoDiscover();
  clearAutoNext();
  if (advanceTimer) clearTimeout(advanceTimer);
  if (scrollTimer) clearTimeout(scrollTimer);
  if (idleRoamTimer) clearTimeout(idleRoamTimer);
  window.removeEventListener("resize", resize);
  window.removeEventListener("scroll", onScroll, true);
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
