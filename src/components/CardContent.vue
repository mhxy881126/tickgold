<script setup lang="ts">
import { onErrorCaptured, ref } from "vue";
import { logger } from "../utils/logger";
import WatchList from "./WatchList.vue";
import RankBoard from "./RankBoard.vue";
import StockChart from "./StockChart.vue";
import LimitRadar from "./LimitRadar.vue";
import AuctionBoard from "./AuctionBoard.vue";
import LimitPool from "./LimitPool.vue";
import RadarSweep from "./RadarSweep.vue";
import ReviewTimeline from "./ReviewTimeline.vue";
import MultiStockGrid from "./MultiStockGrid.vue";
import MarketHeatMatrix from "./MarketHeatMatrix.vue";
import BentoFocus from "./BentoFocus.vue";
import TelegraphWall from "./TelegraphWall.vue";
import BreadthBoard from "./BreadthBoard.vue";
import ShortTermSpider from "./ShortTermSpider.vue";
import SectorBoard from "./SectorBoard.vue";
import SectorHeatmap from "./SectorHeatmap.vue";
import SectorEvents from "./SectorEvents.vue";
import Screener from "./Screener.vue";
import ThemeRotation from "./ThemeRotation.vue";
import DistBoard from "./DistBoard.vue";
import NewsFlash from "./NewsFlash.vue";
import FundFlow from "./FundFlow.vue";
import AlertCenter from "./AlertCenter.vue";
import F10Card from "./F10Card.vue";
import PaperTrade from "./PaperTrade.vue";
import Journal from "./Journal.vue";
import EcoCalendar from "./EcoCalendar.vue";
import IpoCalendar from "./IpoCalendar.vue";
import CalcTools from "./CalcTools.vue";
import DataExport from "./DataExport.vue";
import DragonTiger from "./DragonTiger.vue";
import TradeTape from "./TradeTape.vue";
import RightPanel from "./RightPanel.vue";
import type { CardId } from "../composables/useWorkbench";

const props = defineProps<{ id: CardId; selected: string | null; compact?: boolean }>();
defineEmits<{ select: [code: string] }>();

// 单卡崩溃边界：捕获子卡片渲染错误，显示兜底而非整屏白屏（不影响其他卡片）
const crashed = ref(false);
const errMsg = ref("");
onErrorCaptured((err, _instance, info) => {
  const e = err instanceof Error ? err : new Error(String(err));
  logger.error(e.message, `card:${props.id}`, { info, stack: e.stack });
  errMsg.value = e.message;
  crashed.value = true;
  return false; // 阻止错误继续向上冒泡，避免整树卸载
});
function retry() {
  crashed.value = false;
  errMsg.value = "";
}
</script>

<template>
  <div v-if="crashed" class="card-crash">
    <div class="crash-badge">!</div>
    <div class="crash-title">该卡片出现问题</div>
    <div class="crash-msg">{{ errMsg }}</div>
    <button class="crash-btn" @click="retry">重试</button>
  </div>
  <template v-else>
    <WatchList v-if="id === 'watch'" :selected="selected" @select="$emit('select', $event)" />
    <RankBoard v-else-if="id === 'rank'" @select="$emit('select', $event)" />
    <div v-else-if="id === 'chart'" class="chart-card">
      <StockChart v-if="selected" :key="selected" :code="selected" />
      <div v-else class="card-empty">从自选或榜单选择一只股票</div>
    </div>
    <AuctionBoard v-else-if="id === 'auction'" @select="$emit('select', $event)" />
    <LimitPool v-else-if="id === 'limitpool'" @select="$emit('select', $event)" />
    <LimitRadar v-else-if="id === 'radar'" @select="$emit('select', $event)" />
    <RadarSweep v-else-if="id === 'radarsweep'" @select="$emit('select', $event)" />
    <ReviewTimeline v-else-if="id === 'reviewtimeline'" @select="$emit('select', $event)" />
    <MultiStockGrid v-else-if="id === 'multigrid'" @select="$emit('select', $event)" />
    <MarketHeatMatrix v-else-if="id === 'heatmatrix'" @select="$emit('select', $event)" />
    <BentoFocus v-else-if="id === 'bentofocus'" @select="$emit('select', $event)" />
    <TelegraphWall v-else-if="id === 'telegraph'" @select="$emit('select', $event)" />
    <BreadthBoard v-else-if="id === 'breadth'" :compact="compact" />
    <ShortTermSpider v-else-if="id === 'spider'" @select="$emit('select', $event)" />
    <SectorBoard v-else-if="id === 'sector'" @select="$emit('select', $event)" />
    <SectorHeatmap v-else-if="id === 'sectorheat'" @select="$emit('select', $event)" />
    <SectorEvents v-else-if="id === 'sectorevent'" @select="$emit('select', $event)" />
    <Screener v-else-if="id === 'screener'" @select="$emit('select', $event)" />
    <ThemeRotation v-else-if="id === 'theme'" @select="$emit('select', $event)" />
    <DistBoard v-else-if="id === 'dist'" />
    <NewsFlash v-else-if="id === 'news'" />
    <FundFlow v-else-if="id === 'fundflow'" :code="selected" />
    <AlertCenter v-else-if="id === 'alert'" />
    <F10Card v-else-if="id === 'f10'" :code="selected" />
    <PaperTrade v-else-if="id === 'trade'" :code="selected" />
    <Journal v-else-if="id === 'journal'" :code="selected" />
    <EcoCalendar v-else-if="id === 'calendar'" :code="selected" />
    <IpoCalendar v-else-if="id === 'ipo'" :code="selected" @select="$emit('select', $event)" />
    <CalcTools v-else-if="id === 'calc'" />
    <DataExport v-else-if="id === 'export'" :code="selected" />
    <DragonTiger v-else-if="id === 'dragon'" @select="$emit('select', $event)" />
    <TradeTape v-else-if="id === 'trades'" :code="selected" />
    <RightPanel v-else :code="selected" />
  </template>
</template>

<style scoped>
.chart-card { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.card-empty {
  flex: 1; display: flex; align-items: center; justify-content: center;
  color: var(--text-dim); font-size: 12px;
}
.card-crash {
  flex: 1; min-height: 0; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 9px; padding: 20px;
}
.crash-badge {
  width: 40px; height: 40px; border-radius: 50%; display: flex;
  align-items: center; justify-content: center; font-size: 22px; font-weight: 800;
  color: #ff6b78; background: rgba(255, 93, 107, 0.12);
  border: 1px solid rgba(255, 93, 107, 0.35);
}
.crash-title { font-size: 13px; font-weight: 700; color: var(--text, #e6ecf5); }
.crash-msg {
  max-width: 80%; font-size: 11px; color: var(--text-dim); text-align: center;
  word-break: break-word;
}
.crash-btn {
  margin-top: 4px; padding: 6px 22px; border: 1px solid var(--border, #2a3344);
  border-radius: 8px; background: var(--bg-card, #15181f);
  color: var(--text, #e6ecf5); font-size: 12px; cursor: pointer;
}
.crash-btn:hover { border-color: var(--accent, #e8c66a); }
</style>
