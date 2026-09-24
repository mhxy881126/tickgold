<script setup lang="ts">
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
import RightPanel from "./RightPanel.vue";
import type { CardId } from "../composables/useWorkbench";

defineProps<{ id: CardId; selected: string | null; compact?: boolean }>();
defineEmits<{ select: [code: string] }>();
</script>

<template>
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
  <RightPanel v-else :code="selected" />
</template>

<style scoped>
.chart-card { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.card-empty {
  flex: 1; display: flex; align-items: center; justify-content: center;
  color: var(--text-dim); font-size: 12px;
}
</style>
