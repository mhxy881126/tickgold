<script setup lang="ts">
import { computed } from "vue";
import type { Sector } from "../api/types";

const props = defineProps<{ sectors: Sector[]; mode?: "scan" | "review" }>();
const emit = defineEmits<{ select: [code: string] }>();

interface Dot {
  s: Sector;
  x: number;
  y: number;
  lx: number;
  ly: number;
  level: "hot" | "warm" | "gold" | "cool" | "neutral";
  pct: string;
}

function levelOf(p: number): Dot["level"] {
  if (p >= 4) return "hot";
  if (p >= 2) return "warm";
  if (p >= 0.5) return "gold";
  if (p > -0.5) return "neutral";
  return "cool";
}

// 板块点：黄金角分布角度（避免重叠），半径按涨幅强度
const dots = computed<Dot[]>(() => {
  const top = props.sectors.slice(0, 14);
  const maxAbs = Math.max(...top.map((s) => Math.abs(s.changePct)), 1);
  return top.map((s, i) => {
    const ang = (i * 137.508) * (Math.PI / 180) - Math.PI / 2;
    const rr = 0.32 + 0.5 * Math.min(Math.abs(s.changePct) / maxAbs, 1);
    const x = 50 + rr * 45 * Math.cos(ang);
    const y = 50 + rr * 45 * Math.sin(ang);
    // 标签沿径向往外（盘坐标系百分比）
    const lx = 50 + (rr + 0.1) * 45 * Math.cos(ang);
    const ly = 50 + (rr + 0.1) * 45 * Math.sin(ang);
    return {
      s, x, y, lx, ly,
      level: levelOf(s.changePct),
      pct: (s.changePct >= 0 ? "+" : "") + s.changePct.toFixed(1) + "%",
    };
  });
});
</script>

<template>
  <div class="radar-disc">
    <div class="r-ring r3"></div>
    <div class="r-ring r2"></div>
    <div class="r-ring r1"></div>
    <div class="r-cross h"></div>
    <div class="r-cross v"></div>
    <div class="r-sweep" :class="{ slow: mode === 'review' }"></div>

    <template v-for="d in dots" :key="d.s.code">
      <span
        class="r-dot"
        :class="d.level"
        :style="{ left: d.x + '%', top: d.y + '%' }"
        @click="emit('select', d.s.leadCode)"
      ></span>
      <span
        class="r-lbl"
        :class="d.level"
        :style="{ left: d.lx + '%', top: d.ly + '%' }"
        @click="emit('select', d.s.leadCode)"
      >{{ d.s.name }} {{ d.pct }}</span>
    </template>

    <div class="r-center">
      <span class="rc-label">市场雷达</span>
    </div>
  </div>
</template>

<style scoped>
.radar-disc {
  position: relative;
  width: 100%;
  height: 100%;
  border-radius: 50%;
  border: 1px solid rgba(45, 225, 255, 0.28);
  background: radial-gradient(circle, rgba(45, 225, 255, 0.07), rgba(45, 225, 255, 0.015) 70%);
}
.r-ring {
  position: absolute;
  border: 1px solid rgba(45, 225, 255, 0.16);
  border-radius: 50%;
}
.r3 { inset: 0; }
.r2 { inset: 18%; }
.r1 { inset: 36%; }
.r-cross { position: absolute; background: rgba(45, 225, 255, 0.14); }
.r-cross.h { left: 0; right: 0; height: 1px; top: 50%; }
.r-cross.v { top: 0; bottom: 0; width: 1px; left: 50%; }

.r-sweep {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: conic-gradient(
    from 0deg,
    rgba(45, 225, 255, 0) 0deg,
    rgba(45, 225, 255, 0.32) 52deg,
    rgba(45, 225, 255, 0) 66deg,
    transparent 360deg
  );
  animation: rspin 4s linear infinite;
}
.r-sweep.slow { animation-duration: 9s; }
@keyframes rspin { to { transform: rotate(360deg); } }

.r-dot {
  position: absolute;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  transform: translate(-50%, -50%);
  cursor: pointer;
  animation: rpulse 1.9s ease-in-out infinite;
}
.r-lbl {
  position: absolute;
  transform: translate(-50%, -50%);
  font-size: 9.5px;
  white-space: nowrap;
  font-weight: 600;
  cursor: pointer;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.95);
}
.r-lbl:hover { color: #84ecff !important; }
.r-lbl.hot { color: #ff8d97; }
.r-lbl.warm { color: #ffb27d; }
.r-lbl.gold { color: #ffe08a; }
.r-lbl.cool { color: #7dffc8; }
.r-lbl.neutral { color: #c7cedb; }
.r-dot.hot { background: #ff5d6b; box-shadow: 0 0 10px #ff4d5e; }
.r-dot.warm { background: #ff9a4d; box-shadow: 0 0 10px #ff8a3d; }
.r-dot.gold { background: #ffd24d; box-shadow: 0 0 10px #ffd24d; }
.r-dot.cool { background: #1dffa0; box-shadow: 0 0 10px #1dffa0; }
.r-dot.neutral { background: #7d8aa0; box-shadow: 0 0 8px rgba(125, 138, 160, 0.7); }
@keyframes rpulse {
  0%, 100% { transform: translate(-50%, -50%) scale(1); opacity: 1; }
  50% { transform: translate(-50%, -50%) scale(1.7); opacity: 0.5; }
}

.r-center {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 30%;
  height: 30%;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
}
.rc-label {
  font-size: 9px;
  letter-spacing: 2px;
  color: rgba(132, 236, 255, 0.55);
}
</style>
