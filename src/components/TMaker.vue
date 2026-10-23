<template>
  <div class="tmaker">
    <!-- ===== 昨日未闭环遗留提示 ===== -->
    <div v-if="tm.legacyUnclosed.value.length" class="tm-legacy">
      <span class="legacy-txt">
        ⚠️ 昨日{{ tm.legacyUnclosed.value[0].date }} {{ tm.legacyUnclosed.value[0].code }} 有
        {{ tm.legacyUnclosed.value[0].vol }} 股做T腿未闭环，已按隔夜持仓处理，请核对实际仓位
      </span>
      <button class="legacy-close" @click="tm.dismissLegacy()">知道了</button>
    </div>
    <!-- ===== 顶部行情条 ===== -->
    <div class="tm-quote-bar">
      <div class="qb-row1">
        <div class="qb-stock">
          <select class="tm-select" :value="code" @change="onSelect($event)">
            <option value="" disabled>选择持仓股做T</option>
            <option v-for="p in tm.positions.value" :key="p.code" :value="p.code">
              {{ p.name }} ({{ p.code }}) · {{ p.vol }}股
            </option>
          </select>
          <template v-if="q">
            <span class="qb-price" :class="q.pct >= 0 ? 'up' : 'down'">{{ q.price.toFixed(2) }}</span>
            <span class="qb-chg" :class="q.pct >= 0 ? 'up' : 'down'">
              {{ q.change >= 0 ? "+" : "" }}{{ q.change.toFixed(2) }}
              {{ q.pct >= 0 ? "+" : "" }}{{ q.pct.toFixed(2) }}%
            </span>
          </template>
        </div>
        <div class="qb-pos" v-if="pos">
          <span>成本 <b>{{ tm.costPrice.value.toFixed(2) }}</b></span>
          <span>持仓 <b>{{ pos.vol }}</b>/可卖<b>{{ pos.availVol }}</b></span>
          <span :class="posPnl >= 0 ? 'up' : 'down'">浮盈 <b>{{ posPnl >= 0 ? "+" : "" }}{{ posPnl.toFixed(0) }}</b></span>
        </div>
        <div class="qb-chips">
          <button class="tm-stats-btn" @click="statsOpen = true" title="今日做T 统计与回测参数配置">今日做T</button>
          <div class="tm-badge" :class="badgeClass">{{ badgeText }}</div>
          <div v-if="best" class="tm-badge scan" @click="onScanPick"
            :title="best.code === code ? '当前持仓中的最佳做T标的（按振幅/成交额/换手/动能评分）' : '全场扫描出的最佳做T标的，点击切换查看其做T信号'">
            <template v-if="best.code === code">✓ 当前最佳做T · {{ best.name }} {{ best.score }}分</template>
            <template v-else>🎯 最佳做T · {{ best.name }} {{ best.score }}分</template>
          </div>
          <div v-if="tm.stale.value" class="tm-badge stale" title="行情时间戳已陈旧，信号已暂停">
            ⏳ 行情陈旧 {{ tm.staleSec.value }}s
          </div>
        </div>
      </div>
      <div class="qb-row2" v-if="q">
        <span><i>今开</i><b :class="q.open >= q.prevClose ? 'up' : 'down'">{{ q.open.toFixed(2) }}</b></span>
        <span><i>最高</i><b class="up">{{ q.high.toFixed(2) }}</b></span>
        <span><i>最低</i><b class="down">{{ q.low.toFixed(2) }}</b></span>
        <span><i>昨收</i><b>{{ q.prevClose.toFixed(2) }}</b></span>
        <span class="qb-sep"></span>
        <span><i>成交量</i><b>{{ formatVol(q.volume) }}</b></span>
        <span><i>成交额</i><b>{{ formatAmount(q.amount) }}</b></span>
        <span><i>换手</i><b>{{ q.turnover.toFixed(2) }}%</b></span>
        <span><i>量比</i><b>{{ q.volumeRatio.toFixed(2) }}</b></span>
        <span><i>振幅</i><b>{{ q.amplitude.toFixed(2) }}%</b></span>
        <span><i>均价</i><b class="gold">{{ tm.vwap.value ? tm.vwap.value.toFixed(2) : "-" }}</b></span>
        <template v-if="ob">
          <span class="qb-sep"></span>
          <span><i>外盘</i><b class="up">{{ formatVol(ob.outsideVol) }}</b></span>
          <span><i>内盘</i><b class="down">{{ formatVol(ob.insideVol) }}</b></span>
        </template>
      </div>
    </div>

    <!-- ===== 主体：四象限驾驶舱（方案B） ===== -->
    <div class="tm-body">
      <!-- Q1：分时/K线图 -->
      <div class="tm-quad tm-q-chart">
        <div class="tm-chart">
          <template v-if="hasChartData">
            <TMakerChart
              :code="code"
              :name="name"
              :prev-close="prevClose"
              :support-low="lv.supportLow"
              :resist-high="lv.resistHigh"
              :cost="lv.cost"
              :grid-levels="gridLevelsSvg"
              :legs="tm.currentLegs.value"
              :signals="chartSignals"
              :minute-bars="tm.currentMinute.value"
              :load-failed="tm.loadFailed.value"
              @retry="tm.retryLoad()"
            />
          </template>
          <div v-else class="tm-empty">
            <div class="empty-txt">
              {{ tm.positions.value.length === 0
                ? "暂无持仓，做T需持有「昨日底仓」（T+1 当日可卖）"
                : code ? "行情加载中..." : "请选择一只持仓股票" }}
            </div>
            <div v-if="isDev && tm.positions.value.length === 0" class="seed-box">
              <input v-model="seedCode" class="seed-in" placeholder="6位代码，如300059" />
              <button class="seed-btn" :disabled="tm.busy.value" @click="doSeed">
                [DEV] 播种昨日底仓 {{ seedVol }} 股（T+1可卖）
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Q2：五档盘口 -->
      <div class="tm-quad tm-q-book">
        <div class="book-title">五档盘口</div>
        <template v-if="ob">
          <!-- 卖5→卖1 -->
          <div v-for="i in 5" :key="'a'+i" class="book-row" :style="barStyle(ob.asks[5-i]?.vol)">
            <span class="bk-lv">卖{{ 6 - i }}</span>
            <span class="bk-price" :class="askPriceClass(5-i)">{{ ob.asks[5-i]?.price?.toFixed(2) ?? "--" }}</span>
            <span class="bk-vol">{{ ob.asks[5-i]?.vol ?? "--" }}</span>
          </div>
          <!-- 中间 -->
          <div class="book-mid">
            <span class="mid-price" :class="ob.price >= ob.prevClose ? 'up' : 'down'">{{ ob.price.toFixed(2) }}</span>
            <span class="mid-avg">均价 {{ tm.vwap.value ? tm.vwap.value.toFixed(2) : "-" }}</span>
          </div>
          <!-- 买1→买5 -->
          <div v-for="i in 5" :key="'b'+i" class="book-row buy" :style="barStyle(ob.bids[i-1]?.vol)">
            <span class="bk-lv">买{{ i }}</span>
            <span class="bk-price" :class="bidPriceClass(i-1)">{{ ob.bids[i-1]?.price?.toFixed(2) ?? "--" }}</span>
            <span class="bk-vol">{{ ob.bids[i-1]?.vol ?? "--" }}</span>
          </div>
          <!-- 盘口概要 -->
          <div class="book-summary">
            <span><i>委比</i><b :class="ob.weiBi >= 0 ? 'up' : 'down'">{{ ob.weiBi?.toFixed(1) }}%</b></span>
            <span><i>委差</i><b>{{ ob.weiCha }}</b></span>
            <span><i>买盘</i><b class="up">{{ ob.bidTotal }}</b></span>
            <span><i>卖盘</i><b class="down">{{ ob.askTotal }}</b></span>
          </div>
        </template>
        <div v-else class="ft-empty" @click="tm.loadFailed.value ? tm.retryLoad() : null">
          <span :class="{ 'tm-empty-retry': tm.loadFailed.value }">
            {{ tm.loadFailed.value ? "盘口加载失败，点击重试 ↻" : "盘口加载中" }}
          </span>
        </div>
      </div>

      <!-- Q4：做T决策 -->
      <div class="tm-quad tm-q-decision">
        <div class="dc-title" :class="sig.action">{{ sig.title }}</div>
        <div class="dc-meta">
          <span class="dc-chip" :class="regimeClass">市况 · {{ regimeLabel }}</span>
          <span v-if="sig.score != null" class="dc-chip" :class="scoreClass">{{ scoreLabel }} · {{ sig.score }}/100</span>
          <span v-if="sig.vol" class="dc-chip chip-quant">1R量 {{ sig.vol }}股</span>
          <span v-if="tm.stale.value" class="dc-chip chip-warn">行情陈旧 {{ tm.staleSec.value }}s，信号已暂停</span>
        </div>
        <div class="dc-status">{{ code && q ? statusLine : "等待数据" }}</div>
        <div class="dc-grid">
          <div class="dc-item">
            <span class="dc-label">参考价</span>
            <span class="dc-val" :class="sig.side === 'buy' ? 'up' : sig.side === 'sell' ? 'down' : ''">{{ sig.price ? sig.price.toFixed(2) : "-" }}</span>
          </div>
          <div class="dc-item">
            <span class="dc-label">目标价</span>
            <span class="dc-val" :class="sig.side === 'buy' ? 'up' : 'down'">{{ sig.target ? sig.target.toFixed(2) : "-" }}</span>
          </div>
          <div class="dc-item">
            <span class="dc-label">止损价</span>
            <span class="dc-val down">{{ sig.stop ? sig.stop.toFixed(2) : "-" }}</span>
          </div>
          <div class="dc-item">
            <span class="dc-label">建议数量</span>
            <span class="dc-val">{{ sig.vol ? sig.vol + "股" : "-" }}</span>
          </div>
          <div class="dc-item">
            <span class="dc-label">预期价差</span>
            <span class="dc-val" :class="sig.spread > 0 ? 'up' : ''">{{ sig.spread ? sig.spread.toFixed(2) + "%" : "-" }}</span>
          </div>
          <div class="dc-item">
            <span class="dc-label">乖离率</span>
            <span class="dc-val" :class="tm.bias.value >= 0 ? 'up' : 'down'">{{ tm.bias.value ? tm.bias.value.toFixed(2) + "%" : "-" }}</span>
          </div>
        </div>
        <div class="dc-reasons">
          <div v-for="(r, i) in sig.reasons" :key="i" class="dc-reason">{{ r }}</div>
        </div>
        <!-- P2-8 数量快捷档 -->
        <div class="dc-vols" v-if="sig.vol">
          <button :class="{ on: volMult === 1 }" @click="volMult = 1">1R</button>
          <button :class="{ on: volMult === 0.5 }" @click="volMult = 0.5">半量</button>
          <button :class="{ on: volMult === 0.33 }" @click="volMult = 0.33">1/3</button>
          <span class="dc-vols-tip">执行量 {{ execVol }}股</span>
        </div>
        <div class="dc-actions">
          <button class="dc-btn" :class="sig.side"
            :disabled="sig.side === 'hold' || tm.busy.value"
            @click="requestConfirm">
            {{ tm.busy.value ? "执行中..." : (sig.side === "buy" ? "买入（对手价）" : sig.side === "sell" ? "卖出（对手价）" : "暂无操作") }}
          </button>
          <!-- P1-5 网格按钮：方向有效且无在途时可用 -->
          <button class="dc-btn grid" :class="tm.gridDir.value || ''"
            :disabled="!gridPlan || tm.busy.value || tm.currentLegs.value.length > 0"
            @click="requestGrid">
            {{ gridPlan ? `网格${gridDirLabel}（${gridPlan.count}档）` : "网格（不可用）" }}
          </button>
        </div>
        <!-- P2 执行确认层 -->
        <div v-if="confirmOpen && preview" class="dc-confirm">
          <div class="cf-title">确认执行 · {{ preview.side === "buy" ? "买入" : "卖出" }}</div>
          <div class="cf-row"><span>对手价</span><b :class="preview.side === 'buy' ? 'up' : 'down'">{{ preview.price.toFixed(2) }}</b></div>
          <div class="cf-row"><span>数量</span><b>{{ preview.vol }}股</b></div>
          <div class="cf-row"><span>预估费用</span><b>{{ preview.feeTotal.toFixed(2) }}元（{{ preview.feeRate.toFixed(3) }}%）</b></div>
          <div class="cf-row" v-if="preview.slipPct > 0.001"><span>相对参考价滑点</span><b>{{ preview.slipPct.toFixed(3) }}%</b></div>
          <div class="cf-tip">模拟盘按对手价+滑点撮合，费用与真实券商口径一致</div>
          <div class="cf-btns">
            <button class="cf-yes" @click="doExecute">确认执行</button>
            <button class="cf-no" @click="cancelAll">取消（Esc）</button>
          </div>
        </div>
        <!-- P1-5 网格确认层 -->
        <div v-if="confirmGridOpen && gridPlan" class="dc-confirm grid">
          <div class="cf-title">确认布网格 · {{ gridDirLabel }}</div>
          <div class="cf-row" v-for="(l, i) in gridPlan.levels" :key="i">
            <span>档{{ i + 1 }} @ {{ l.price.toFixed(2) }}</span><b>{{ l.vol }}股</b>
          </div>
          <div class="cf-row" v-if="gridPlan.truncated"><span class="cf-warn">触及支撑/压力边界，已少挂档</span></div>
          <div class="cf-tip">按档位价分批成交，每档独立止损/目标，可一键全平</div>
          <div class="cf-btns">
            <button class="cf-yes" @click="doExecuteGrid">确认布网格</button>
            <button class="cf-no" @click="cancelAll">取消（Esc）</button>
          </div>
        </div>
        <div v-if="tm.toast.value" class="dc-toast">{{ tm.toast.value }}</div>
      </div>


    <!-- ===== 今日做T 弹窗（统计 + 回测配置） ===== -->
    <div v-if="statsOpen" class="tm-modal">
      <div class="tm-modal-mask" @click="statsOpen = false"></div>
      <div class="tm-modal-panel">
        <div class="tm-modal-head">
          <span class="tm-modal-title">今日做T · 统计与回测配置</span>
          <button class="tm-modal-close" @click="statsOpen = false" title="关闭">✕</button>
        </div>
        <div class="tm-modal-body">
      <!-- 盘前计划（P3-7）：9:25 竞价后自动生成 -->
      <div class="tm-stats" v-if="dayPlan">
        <div class="ts-title">今日计划 <button class="ts-bt-run" @click="tm.buildPlanNow()">重算</button></div>
        <div class="ts-plan-line">中枢 <b>{{ dayPlan.center.toFixed(2) }}</b> ｜ 区间 ATR {{ dayPlan.atrPct.toFixed(2) }}%</div>
        <div class="ts-plan-lev" v-for="(l, i) in dayPlan.levels" :key="i">
          <span :class="l.side === 'buy' ? 'up' : 'down'">{{ l.note }}</span>
          <span>{{ l.price.toFixed(2) }} × {{ l.vol }}</span>
          <span class="ts-l">{{ l.gapPct.toFixed(2) }}%</span>
        </div>
        <div class="ts-plan-skip" v-if="dayPlan.skip.length">
          <span class="badge-red" v-for="(s, i) in dayPlan.skip" :key="i">{{ s }}</span>
        </div>
      </div>
      <!-- 做T统计 + 关键指标 -->
      <div class="tm-stats">
        <div class="ts-head">
          <span class="ts-title">今日做T</span>
          <div class="ts-row">
            <div class="ts-item"><span class="ts-n">{{ stats.count }}</span><span class="ts-l">次数</span></div>
            <div class="ts-item"><span class="ts-n">{{ stats.winRate.toFixed(0) }}%</span><span class="ts-l">成功</span></div>
            <div class="ts-item"><span class="ts-n" :class="stats.pnl >= 0 ? 'up' : 'down'">{{ stats.pnl >= 0 ? "+" : "" }}{{ stats.pnl.toFixed(0) }}</span><span class="ts-l">收益</span></div>
          </div>
        </div>
        <div class="ts-legs" v-if="tm.currentLegs.value.length">
          <div class="ts-leg" v-for="(l, i) in tm.currentLegs.value" :key="i">
            <span class="leg-dot" :class="l.type"></span>
            {{ l.type === "long" ? "正T" : "倒T" }}{{ l.gridId ? "·网格" : "" }} {{ l.vol }}股
            @ {{ l.openPrice.toFixed(2) }}
            <span :class="legFloatOf(l) >= 0 ? 'up' : 'down'">（{{ legFloatOf(l) >= 0 ? "+" : "" }}{{ legFloatOf(l).toFixed(2) }}%）</span>
          </div>
          <button class="ts-close-all" :disabled="tm.busy.value" @click="tm.closeAllLegs">
            一键全平（{{ tm.currentLegs.value.length }}腿）
          </button>
        </div>
        <!-- P2-4 跨日做T台账（SQL） -->
        <div class="ts-hist" v-if="hist">
          <span class="ts-h-title">跨日台账</span>
          <span class="ts-h-line">
            <span class="ts-h-num">{{ hist.count }}笔</span>
            <span class="ts-h-num">{{ hist.winRate.toFixed(0) }}%胜</span>
            <span class="ts-h-num" :class="hist.totalPnl >= 0 ? 'up' : 'down'">累计{{ hist.totalPnl >= 0 ? "+" : "" }}{{ hist.totalPnl.toFixed(0) }}元</span>
            <span class="ts-h-num">盈亏比{{ hist.profitFactor.toFixed(2) }}</span>
          </span>
        </div>
        <!-- P3 分钟级回测 -->
        <div class="ts-bt">
          <div class="ts-bt-head">
            <span class="ts-h-title">分钟级回测</span>
            <button class="ts-bt-run" :disabled="tm.btLoading.value" @click="tm.runBacktestNow()">
              {{ tm.btLoading.value ? "回测中…" : "跑回测" }}
            </button>
            <button class="ts-bt-run" @click="tm.buildDailyReport()">生成日报</button>
            <span class="ts-h-num">历史样本 {{ tm.btArchiveDays.value }} 天</span>
            <span class="ts-h-num" v-if="btArchTxt">{{ btArchTxt }}</span>
            <span class="ts-h-num" v-if="sigStats" :class="sigStats.hitRate >= 50 ? 'up' : 'down'">30min命中 {{ sigStats.hitRate.toFixed(0) }}%</span>
          </div>
          <div v-if="!bt && !tm.btLoading.value" class="ts-bt-tip">
            用最近 {{ tm.btArchiveDays.value }} 天分钟数据，按当前信号规则模拟做T，验证这套参数能不能赚钱。点「跑回测」开始。
          </div>
          <template v-if="bt">
            <div class="ts-h-line">
              <span class="ts-h-num">共 {{ bt.count }} 笔做T</span>
              <span class="ts-h-num" :class="bt.winRate >= bt.breakEvenWinRate ? 'up' : 'down'">胜率 {{ bt.winRate.toFixed(0) }}%</span>
              <span class="ts-h-num" :class="bt.totalPnl >= 0 ? 'up' : 'down'">净收益 {{ bt.totalPnl >= 0 ? "+" : "" }}{{ bt.totalPnl.toFixed(0) }} 元</span>
              <span class="ts-h-num">盈亏比 {{ bt.profitFactor.toFixed(2) }}</span>
            </div>
            <div class="ts-h-line sub">
              <span>正T {{ bt.long.count }} 笔（胜 {{ bt.long.winRate.toFixed(0) }}%）</span>
              <span>倒T {{ bt.short.count }} 笔（胜 {{ bt.short.winRate.toFixed(0) }}%）</span>
              <span>强平 {{ bt.forcedCloseCount }}</span>
              <span>单笔均 {{ bt.avgPnl >= 0 ? "+" : "" }}{{ bt.avgPnl.toFixed(1) }} 元</span>
            </div>
            <div class="ts-bt-notes">不做T对照 {{ bt.baselinePnl >= 0 ? "+" : "" }}{{ bt.baselinePnl.toFixed(0) }} 元（持有不动）· 最大回撤 {{ bt.maxDrawdown.toFixed(0) }} 元 · 保本需胜率 {{ bt.breakEvenWinRate.toFixed(0) }}%。A股 T+1 实盘正T需隔日，结果仅供参数参考</div>
          </template>
          <details class="ts-bt-params">
            <summary>⚙ 回测参数（怎么用？改完点「按参数重跑」）</summary>
            <div class="ts-bt-grid">
              <label class="tp">
                <span class="tp-lab">开仓信号分 <input type="number" v-model.number="tm.btParams.value.scoreOpen" min="0" max="100" step="1"></span>
                <span class="tp-tip">信号得分 ≥ 该值才开仓，越高越严格、做T次数越少</span>
              </label>
              <label class="tp">
                <span class="tp-lab">止损幅度 <input type="number" v-model.number="tm.btParams.value.stopMinPct" min="0.5" max="3" step="0.1">%</span>
                <span class="tp-tip">开仓后亏损到该幅度强制平仓</span>
              </label>
              <label class="tp">
                <span class="tp-lab">止盈倍数 <input type="number" v-model.number="tm.btParams.value.targetMult" min="0.8" max="3" step="0.1">×</span>
                <span class="tp-tip">盈利达到止损幅度的 N 倍时止盈</span>
              </label>
              <label class="tp">
                <span class="tp-lab">每日上限 <input type="number" v-model.number="tm.btParams.value.maxPerDay" min="1" max="10" step="1">次</span>
                <span class="tp-tip">一天最多开仓次数，防过度交易</span>
              </label>
              <label class="tp">
                <span class="tp-lab">成交滑点 <input type="number" v-model.number="tm.btParams.value.slipPct" min="0" max="0.5" step="0.01">%</span>
                <span class="tp-tip">模拟成交相对盘口的偏差，越接近真实越好</span>
              </label>
            </div>
            <div class="ts-bt-opt-btns">
              <button class="ts-bt-run" :disabled="tm.btLoading.value" @click="tm.runBacktestNow()">按参数重跑</button>
              <button class="ts-bt-run" :disabled="tm.optLoading.value" @click="tm.runOptimizeNow()">
                {{ tm.optLoading.value ? "寻优中…（54 组×内外切分）" : "⚙ 自动寻优" }}
              </button>
              <span class="ts-h-num">自动试 54 套参数组合，推荐样本外最赚的一组</span>
            </div>
          </details>
          <template v-if="opt">
            <div class="ts-bt-opt">
              <div class="ts-bt-opt-head">寻优结果（{{ opt.combos }} 组 × 样本 {{ opt.sampleDays }} 天，内 {{ opt.inDays }} / 外 {{ opt.outDays }}）—— 组合：开仓分/止损%/止盈倍数/日上限</div>
              <div v-for="(row, ri) in opt.rows" :key="ri" class="ts-bt-opt-row">
                <span class="ts-bt-opt-params">开{{ row.params.scoreOpen }} 止{{ row.params.stopMinPct }}% 倍{{ row.params.targetMult }} 日{{ row.params.maxPerDay }}</span>
                <span :class="row.out.avgPnl >= 0 ? 'up' : 'down'">外{{ row.out.count }}笔/{{ row.out.avgPnl.toFixed(1) }}元</span>
                <span>内{{ row.in.count }}笔/{{ row.in.avgPnl.toFixed(1) }}元</span>
                <button class="ts-bt-run" @click="tm.applyOptParams(row)">应用</button>
              </div>
            </div>
          </template>
        </div>
        <div class="ts-metrics">
          <div class="mt"><span>振幅</span><b>{{ q ? q.amplitude.toFixed(2)+"%" : "-" }}</b></div>
          <div class="mt"><span>量比</span><b>{{ q ? q.volumeRatio.toFixed(2) : "-" }}</b></div>
          <div class="mt"><span>换手</span><b>{{ q ? q.turnover.toFixed(2)+"%" : "-" }}</b></div>
          <div class="mt"><span>大盘</span><b :class="tm.marketPct.value >= 0 ? 'up' : 'down'">{{ tm.marketPct.value ? tm.marketPct.value.toFixed(2)+"%" : "-" }}</b></div>
        </div>
      </div>
        </div>
      </div>
    </div>

    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useTmaker } from "../composables/useTmaker";
import { isTrading, holidayName } from "../utils/sessions";
import TMakerChart from "./tmaker/TMakerChart.vue";

const tm = useTmaker();
const code = tm.selectedCode;

/** 是否渲染图表（有标的即渲染，空数据由子组件提示） */
const hasChartData = computed(() => !!code.value);
const name = computed(() => tm.quote.value?.name ?? code.value ?? "");

/** 图表信号点：当前强信号（做T决策）标记到最新 bar */
const chartSignals = computed<{ time: number; price: number; dir: "long" | "short"; score: number }[]>(() => {
  const s = tm.confirmedSignal.value;
  if (!s || s.urgency !== "strong" || s.side === "hold") return [];
  const bars = tm.currentMinute.value;
  return [{
    time: bars.length ? bars[bars.length - 1].timestamp : Date.now(),
    price: s.price,
    dir: s.side === "buy" ? "long" : "short",
    score: s.score ?? 0,
  }];
});

const statsOpen = ref(false);
const isDev = import.meta.env.DEV;
const seedCode = ref("300059");
const seedVol = 1000;
async function doSeed() {
  await tm.seedTestPosition(seedCode.value, seedVol);
}

// SVG 坐标系
const VBW = 800;
const PAD_L = 48;
const PAD_R = 48;
const PRICE_TOP = 8;
const PRICE_BOTTOM = 210;
const PRICE_H = PRICE_BOTTOM - PRICE_TOP;
const VOL_TOP = 220;
const VOL_BOTTOM = 268;
const VOL_H = VOL_BOTTOM - VOL_TOP;
const VBH = 288;

onMounted(() => { tm.start(); });

function onSelect(e: Event) {
  // 关键：不能用 v-model 直接改 selectedCode（会先于 select() 改值，导致 select() 因 code===selectedCode 提前 return，
  // 跳过清空/持久化/重载，切票串票）。改为单向 :value，由 select() 统一改值+清空+加载。
  const v = (e.target as HTMLSelectElement).value;
  tm.select(v);
}

const q = computed(() => tm.quote.value);
const ob = computed(() => tm.orderBook.value);
const pos = computed(() => tm.currentPos.value);
const sig = computed(() => tm.confirmedSignal.value);
const lv = computed(() => tm.keyLevels.value);
const stats = computed(() => tm.todayStats.value);
const prevClose = computed(() => q.value?.prevClose ?? 0);

const posPnl = computed(() => {
  if (!pos.value || !q.value) return 0;
  return (q.value.price - tm.costPrice.value) * pos.value.vol;
});

// 集合竞价最新点
// 集合竞价最新点
const auctionLatest = computed(() => {
  const auc = tm.depthEnhance.value?.auction;
  return auc && auc.length ? auc[auc.length - 1] : null;
});

// 可做T状态徽章
const canTInfo = computed(() => tm.canT.value);
const badgeClass = computed(() => {
  if (!pos.value) return "none";
  if (tm.leg.value) return "active";
  return canTInfo.value.ok ? "ok" : "warn";
});
const badgeText = computed(() => {
  if (!pos.value) return "无底仓";
  if (tm.leg.value) return tm.leg.value.type === "long" ? "正T在途" : "倒T在途";
  if (!canTInfo.value.ok) return canTInfo.value.reasons[0]?.slice(0, 10) || "不宜做T";
  return "可做T";
});

const statusLine = computed(() => {
  const hd = holidayName();
  if (hd) return `今日休市（${hd}），信号仅供参考`;
  if (!isTrading()) return "当前非交易时段，信号仅供参考";
  if (!canTInfo.value.ok) return canTInfo.value.reasons[0] || "";
  return "盯盘中，出现机会将提示";
});

// P1：市况标签 + 信号分级徽标
const REGIME_LABEL: Record<string, string> = {
  up: "单边上行", down: "单边下行", range: "震荡", extreme: "极端市况",
};
const regimeLabel = computed(() => REGIME_LABEL[tm.regime.value] ?? "-");
const regimeClass = computed(() => "chip-" + (tm.regime.value || "range"));
const scoreLabel = computed(() =>
  sig.value.grade === "strong" ? "强信号" : sig.value.grade === "prep" ? "预备" : "观望",
);
const scoreClass = computed(() =>
  sig.value.grade === "strong" ? "chip-strong" : sig.value.grade === "prep" ? "chip-prep" : "chip-wait",
);

const legFloat = computed(() => {
  const l = tm.leg.value;
  if (!l || !q.value) return 0;
  if (l.type === "long") return ((q.value.price - l.openPrice) / l.openPrice) * 100;
  return ((l.openPrice - q.value.price) / l.openPrice) * 100;
});

// ===== 分时图坐标 =====
const frame = computed(() => {
  const bars = tm.currentMinute.value;
  const prev = prevClose.value;
  if (!bars.length || !prev) return null;
  const prices: number[] = [];
  bars.forEach((b) => prices.push(b.close));
  tm.avgMap.value.forEach((v) => prices.push(v));
  [lv.value.supportLow, lv.value.resistHigh, lv.value.cost].forEach((p) => {
    if (p > 0) prices.push(p);
  });
  const hi = Math.max(...prices, prev);
  const lo = Math.min(...prices, prev);
  let range = Math.max(hi - prev, prev - lo, prev * 0.005);
  range *= 1.12;
  const top = prev + range;
  const bottom = prev - range;
  const n = bars.length;
  const plotW = VBW - PAD_L - PAD_R;
  const xAt = (i: number) => PAD_L + (n <= 1 ? 0 : (i / (n - 1)) * plotW);
  const yAt = (p: number) => PRICE_BOTTOM - ((p - bottom) / (top - bottom)) * PRICE_H;
  const pricePath = bars.map((b, i) =>
    `${i === 0 ? "M" : "L"}${xAt(i).toFixed(1)},${yAt(b.close).toFixed(1)}`).join(" ");
  const avgPath = bars.map((b, i) => {
    const a = tm.avgMap.value.get(b.timestamp);
    return a == null ? "" : `${i === 0 ? "M" : "L"}${xAt(i).toFixed(1)},${yAt(a).toFixed(1)}`;
  }).join(" ");
  const areaPath = bars.length
    ? `${pricePath} L${xAt(n - 1).toFixed(1)},${yAt(prev).toFixed(1)} L${xAt(0).toFixed(1)},${yAt(prev).toFixed(1)} Z`
    : "";
  const maxVol = Math.max(...bars.map((b) => b.volume), 1);
  const volBars = bars.map((b, i) => {
    const w = Math.max(plotW / n - 0.5, 1);
    const h = (b.volume / maxVol) * VOL_H;
    return { x: xAt(i) - w / 2, y: VOL_BOTTOM - h, w, h, up: b.close >= b.open };
  });
  // Y轴刻度（5档）
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => {
    const price = top - (top - bottom) * t;
    const y = PRICE_TOP + PRICE_H * t;
    const pct = ((price - prev) / prev) * 100;
    return { price, y, pct };
  });
  // X轴时间刻度（固定等间距，A股240分钟交易时段）
  const labels = [
    { label: "9:30", x: PAD_L + 2 },
    { label: "10:30", x: PAD_L + plotW * 0.25 },
    { label: "11:30/13:00", x: PAD_L + plotW * 0.5 },
    { label: "14:00", x: PAD_L + plotW * 0.75 },
    { label: "15:00", x: PAD_L + plotW - 2 },
  ];
  return {
    yAt, xAt, pricePath, avgPath, areaPath, volBars,
    lastX: xAt(n - 1), lastY: yAt(bars[n - 1].close),
    prevY: yAt(prev), ticks, labels,
  };
});
function priceToY(p: number): number {
  return frame.value ? frame.value.yAt(p) : PRICE_H / 2;
}

// ===== 五档盘口辅助 =====
const maxBookVol = computed(() => {
  if (!ob.value) return 1;
  const vols = [...ob.value.asks, ...ob.value.bids].map((l) => l?.vol ?? 0);
  return Math.max(...vols, 1);
});
function barStyle(vol?: number): Record<string, string> {
  if (!vol) return {};
  const pct = Math.min((vol / maxBookVol.value) * 100, 100);
  return { "--bar": `${pct}%` };
}
function askPriceClass(i: number): string {
  const p = ob.value?.asks[i]?.price;
  if (!p || !ob.value) return "";
  return p >= ob.value.prevClose ? "up" : "down";
}
function bidPriceClass(i: number): string {
  const p = ob.value?.bids[i]?.price;
  if (!p || !ob.value) return "";
  return p >= ob.value.prevClose ? "up" : "down";
}
// ===== 格式化 =====
// ===== 格式化 =====
function formatVol(v: number): string {
  if (v >= 1e8) return (v / 1e8).toFixed(2) + "亿手";
  if (v >= 1e4) return (v / 1e4).toFixed(2) + "万手";
  return v + "手";
}
function formatAmount(v: number): string {
  if (v >= 1e8) return (v / 1e8).toFixed(2) + "亿";
  if (v >= 1e4) return (v / 1e4).toFixed(2) + "万";
  return v.toFixed(0);
}

function round100(n: number): number {
  return Math.max(0, Math.floor(n / 100) * 100);
}

// ===== P1-5+P2：多腿 / 网格 / 确认层 / 快捷档 / 上屏标记 =====

/** 数量快捷档：1R / 半量 / 1/3（相对信号建议量） */
const volMult = ref(1);
const execVol = computed(() => {
  if (!sig.value || !sig.value.vol) return 0;
  return round100(sig.value.vol * volMult.value);
});

const gridPlan = computed(() => tm.gridPlanNow.value);
const gridDirLabel = computed(() => (tm.gridDir.value === "long" ? "正T低吸" : "倒T高抛"));

/** 网格档位 SVG 线 */
const gridLevelsSvg = computed(() => {
  const gp = gridPlan.value;
  if (!gp) return [];
  return gp.levels.map((l, i) => ({ ...l, i, label: `档${i + 1}@${l.price.toFixed(2)}` }));
});

/** 单腿止损价 / 目标价 */
function legStopPrice(l: { type: string; openPrice: number; stopPct: number }): number {
  return l.type === "long" ? l.openPrice * (1 - (l.stopPct ?? 1.5) / 100) : l.openPrice * (1 + (l.stopPct ?? 1.5) / 100);
}
function legTargetPrice(l: { type: string; openPrice: number; targetPct: number }): number {
  return l.type === "long" ? l.openPrice * (1 + (l.targetPct ?? 0.8) / 100) : l.openPrice * (1 - (l.targetPct ?? 0.8) / 100);
}
function legFloatOf(l: { type: string; openPrice: number }): number {
  if (!q.value) return 0;
  return l.type === "long"
    ? ((q.value.price - l.openPrice) / l.openPrice) * 100
    : ((l.openPrice - q.value.price) / l.openPrice) * 100;
}

/** 确认层状态 */
const confirmOpen = ref(false);
const confirmGridOpen = ref(false);
const preview = computed(() => tm.preview.value);
function requestConfirm() {
  if (!sig.value || sig.value.side === "hold") return;
  confirmOpen.value = true;
}
function doExecute() {
  confirmOpen.value = false;
  void tm.executeSignal(execVol.value || undefined);
}
function requestGrid() {
  if (!gridPlan.value || !tm.gridDir.value) return;
  confirmGridOpen.value = true;
}
function doExecuteGrid() {
  confirmGridOpen.value = false;
  if (tm.gridDir.value) void tm.executeGrid(tm.gridDir.value, execVol.value || undefined);
}
function cancelAll() {
  confirmOpen.value = false;
  confirmGridOpen.value = false;
}

// ===== P2-5 多票扫描 =====
const best = computed(() => tm.bestCandidate.value);
function onScanPick() {
  if (best.value) tm.select(best.value.code);
}

// ===== P2-4 跨日台账 =====
const hist = computed(() => tm.historyStats.value);
// ===== P3 分钟级回测 =====
const bt = computed(() => tm.btResult.value);
const sigStats = computed(() => tm.signalStats.value);
const opt = computed(() => tm.optResult.value);
const dayPlan = computed(() => tm.dayPlan.value);
const btArchTxt = computed(() => {
  const s = tm.archiveState.value;
  if (!s) return "";
  const n = s.archived.length;
  return n > 0 ? `已归档 ${n} 日` : "";
});

// 键盘：空格=确认执行 / Esc=取消（仅在弹层打开时生效）
onMounted(() => {
  window.addEventListener("keydown", onKey);
});
function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") { cancelAll(); return; }
  if (e.key === " " && confirmOpen.value) { e.preventDefault(); doExecute(); }
}

</script>

<style scoped>
.tmaker {
  --up: #ff6478;
  --down: #00e8a0;
  --cyan: #00e8d8;
  --gold: #ffd76a;
  --purple: #b07cff;
  --bg: #0a0f0d;
  --bg2: #0d1412;
  --bg3: #111a17;
  --line: rgba(0, 212, 255, .12);
  --t1: #cfe8e2;
  --t2: #8aa39c;
  --t3: #566a63;
  position: relative;
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  background: var(--bg);
  color: var(--t1);
  font-family: "Segoe UI", "Microsoft YaHei", sans-serif;
  font-size: 11px;
  overflow: hidden;
}
.up { color: var(--up); }
.down { color: var(--down); }
.gold { color: var(--gold); }

/* ===== 昨日未闭环遗留提示 ===== */
.tm-legacy {
  flex-shrink: 0;
  display: flex; align-items: center; gap: 10px;
  background: rgba(255,177,61,.08);
  border: 1px solid rgba(255,177,61,.4);
  border-radius: 6px; padding: 5px 10px; font-size: 11px;
}
.legacy-txt { color: #ffb13d; flex: 1; min-width: 0; line-height: 1.4; }
.legacy-close {
  flex-shrink: 0; background: rgba(255,177,61,.15); border: 1px solid rgba(255,177,61,.5);
  color: #ffb13d; border-radius: 4px; padding: 3px 10px; font-size: 11px; cursor: pointer;
}
.legacy-close:hover { background: rgba(255,177,61,.25); }

/* ===== P1 决策面板：市况/信号分徽标 ===== */
.dc-meta {
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  margin: 2px 0 6px;
}
.dc-chip {
  display: inline-flex; align-items: center;
  font-size: 10px; line-height: 1; padding: 3px 8px; border-radius: 10px;
  border: 1px solid rgba(148,163,184,.35); color: #94a3b8;
  background: rgba(148,163,184,.08);
}
.chip-up { color: #f87171; border-color: rgba(248,113,113,.45); background: rgba(248,113,113,.08); }
.chip-down { color: #34d399; border-color: rgba(52,211,153,.45); background: rgba(52,211,153,.08); }
.chip-extreme { color: #fbbf24; border-color: rgba(251,191,36,.5); background: rgba(251,191,36,.1); }
.chip-strong { color: #f87171; border-color: rgba(248,113,113,.55); background: rgba(248,113,113,.12); }
.chip-prep { color: #fbbf24; border-color: rgba(251,191,36,.5); background: rgba(251,191,36,.1); }
.chip-wait { color: #94a3b8; }
.chip-quant { color: #818cf8; border-color: rgba(129,140,248,.45); background: rgba(129,140,248,.08); }

/* ===== 顶部行情条 ===== */
.tm-quote-bar {
  flex-shrink: 0;
  background: var(--bg2);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 5px 10px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.qb-row1 { display: flex; align-items: center; gap: 10px; }
.qb-chips { margin-left: auto; display: flex; align-items: center; gap: 6px; }
.qb-stock { display: flex; align-items: center; gap: 8px; min-width: 0; }
.tm-select {
  background: var(--bg3);
  border: 1px solid var(--line);
  color: var(--t1);
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 12px;
  font-weight: 600;
  outline: none;
  max-width: 200px;
}
.qb-price { font-size: 20px; font-weight: 800; font-family: Consolas, monospace; }
.qb-chg { font-size: 12px; font-weight: 600; font-family: Consolas, monospace; }
.qb-pos { display: flex; gap: 8px; font-size: 10px; color: var(--t2); }
.qb-pos b { font-family: Consolas, monospace; color: var(--t1); font-weight: 600; }
.tm-badge {
  margin-left: auto;
  padding: 4px 10px;
  border-radius: 12px;
  font-size: 11px;
  font-weight: 700;
  white-space: nowrap;
}
.tm-badge.ok { background: rgba(0,232,216,.12); color: var(--cyan); border: 1px solid var(--cyan); }
.tm-badge.warn { background: rgba(255,177,61,.1); color: #ffb13d; border: 1px solid rgba(255,177,61,.4); }
.tm-badge.none { background: rgba(255,255,255,.05); color: var(--t3); border: 1px solid var(--line); }
.tm-badge.active { background: rgba(255,100,120,.12); color: var(--up); border: 1px solid var(--up); }
.tm-badge.scan {
  cursor: pointer;
  background: rgba(129,140,248,.12); color: #a5b4fc; border: 1px solid rgba(129,140,248,.5);
}
.tm-badge.scan:hover { background: rgba(129,140,248,.22); }
.tm-badge.stale {
  background: rgba(251,191,36,.1); color: #fbbf24; border: 1px solid rgba(251,191,36,.45);
}
.chip-warn { color: #fbbf24; border-color: rgba(251,191,36,.5); background: rgba(251,191,36,.1); }

.qb-row2 { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 12px; }
.qb-row2 > span { display: flex; align-items: baseline; gap: 4px; }
.qb-row2 i { font-style: normal; color: var(--t3); font-size: 11px; }
.qb-row2 b { font-family: Consolas, monospace; font-weight: 600; color: var(--t1); }
.qb-sep { width: 1px; height: 12px; background: var(--line); margin: 0 2px; }

/* ===== 主体 ===== */
.tm-body {
  flex: 1; min-height: 0;
  display: grid;
  grid-template-columns: 3fr 1fr;
  grid-template-rows: minmax(0, 1.45fr) minmax(0, 1fr);
  grid-template-areas: "chart book" "chart decision";
  gap: 6px;
}
.tm-quad {
  min-width: 0; min-height: 0;
  background: var(--bg2);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 6px 8px;
  display: flex; flex-direction: column;
  overflow: hidden;
}
.tm-q-chart { grid-area: chart; padding: 0; }
.tm-q-book { grid-area: book; }
.tm-q-decision { grid-area: decision; overflow-y: auto; }
.tm-stats-btn {
  background: rgba(0,232,216,.12); border: 1px solid rgba(0,232,216,.45); color: var(--cyan);
  border-radius: 4px; padding: 3px 10px; font-size: 11px; font-weight: 600; cursor: pointer;
  white-space: nowrap;
}
.tm-stats-btn:hover { background: rgba(0,232,216,.22); }
/* 今日做T 弹窗 */
.tm-modal { position: absolute; inset: 0; z-index: 1200; display: flex; align-items: center; justify-content: center; }
.tm-modal-mask { position: absolute; inset: 0; background: rgba(0,0,0,.55); }
.tm-modal-panel {
  position: relative; width: 640px; max-width: calc(100% - 24px); max-height: 86%;
  background: #0b1412; border: 1px solid var(--line); border-radius: 8px;
  display: flex; flex-direction: column; overflow: hidden;
  box-shadow: 0 12px 40px rgba(0,0,0,.5);
}
.tm-modal-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 12px; border-bottom: 1px solid var(--line); background: rgba(255,255,255,.03);
}
.tm-modal-title { font-size: 13px; font-weight: 700; color: var(--cyan); }
.tm-modal-close {
  background: none; border: none; color: var(--t2); font-size: 15px; cursor: pointer;
  padding: 2px 8px; border-radius: 4px;
}
.tm-modal-close:hover { background: rgba(255,255,255,.08); color: var(--t1); }
.tm-modal-body { padding: 10px 12px; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; }
.tm-modal-body .tm-stats { gap: 6px; }
.tm-modal-body .ts-metrics { margin-top: 0; }
.tm-chart {
  flex: 1;
  min-height: 0;
  background: var(--bg2);
  border: 1px solid var(--line);
  border-radius: 6px;
  position: relative;
  overflow: hidden;
}
.tm-svg { width: 100%; height: 100%; display: block; }
.tm-empty {
  height: 100%;
  display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  gap: 10px; color: var(--t3); font-size: 12px; text-align: center; padding: 16px;
}
.seed-box { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; justify-content: center; }
.seed-in {
  width: 120px; background: #0a1210; border: 1px dashed rgba(255,215,106,.5);
  color: var(--gold); border-radius: 4px; padding: 4px 8px; font-size: 11px;
  font-family: Consolas, monospace; outline: none;
}
.seed-btn {
  background: rgba(255,215,106,.1); border: 1px solid rgba(255,215,106,.5);
  color: var(--gold); border-radius: 4px; padding: 4px 10px; font-size: 11px;
  font-weight: 600; cursor: pointer;
}
.seed-btn:hover:not(:disabled) { background: rgba(255,215,106,.2); }
.seed-btn:disabled { opacity: .5; cursor: not-allowed; }

.tm-legend {
  position: absolute; top: 5px; left: 52px;
  display: flex; gap: 8px; font-size: 10px; color: var(--t2); flex-wrap: wrap;
  background: rgba(10,15,13,.6); padding: 2px 6px; border-radius: 3px;
}
.lg { display: flex; align-items: center; gap: 3px; }
.lg.auction { color: var(--purple); }
.dot { width: 8px; height: 3px; border-radius: 1px; display: inline-block; }
.dot.price { background: var(--cyan); }
.dot.avg { background: var(--gold); }
.dot.cost { background: var(--purple); }
.dot.support { background: var(--down); }
.dot.resist { background: var(--up); }
.dot.auc { background: var(--purple); }

/* SVG */
.grid-h { stroke: rgba(180,200,195,.06); stroke-width: 1; }
.bg-up { fill: rgba(255,100,120,.03); }
.bg-down { fill: rgba(0,232,160,.03); }
.ln-prev { stroke: rgba(180,200,195,.3); stroke-width: 1; stroke-dasharray: 4 4; }
.ln-support { stroke: var(--down); stroke-width: 1; stroke-dasharray: 5 3; opacity: .5; }
.ln-resist { stroke: var(--up); stroke-width: 1; stroke-dasharray: 5 3; opacity: .5; }
.ln-cost { stroke: var(--purple); stroke-width: 1; stroke-dasharray: 2 3; opacity: .65; }
/* P1-5 网格档位 */
.ln-grid { stroke: rgba(129,140,248,.5); stroke-width: 1; stroke-dasharray: 3 3; opacity: .7; }
.grid-label { fill: #a5b4fc; font-size: 9px; font-family: Consolas, monospace; }
/* P2-2 在途腿标记 */
.ln-leg-open { stroke-width: 1.4; stroke-dasharray: 6 3; opacity: .85; }
.ln-leg-open.long { stroke: var(--up); }
.ln-leg-open.short { stroke: var(--down); }
.ln-leg-stop { stroke: #ff5096; stroke-width: 1; stroke-dasharray: 2 3; opacity: .7; }
.ln-leg-target { stroke: var(--gold); stroke-width: 1; stroke-dasharray: 2 3; opacity: .7; }
.leg-label { font-size: 9px; font-family: Consolas, monospace; }
.leg-label.long { fill: var(--up); }
.leg-label.short { fill: var(--down); }
.price-line { stroke: var(--cyan); stroke-width: 1.5; }
.avg-line { stroke: var(--gold); stroke-width: 1.1; }
.area-fill.up { fill: rgba(255,100,120,.1); }
.area-fill.down { fill: rgba(0,232,160,.1); }
.last-dot { fill: var(--cyan); stroke: #fff; stroke-width: .5; }
.vol-up { fill: rgba(255,100,120,.3); }
.vol-down { fill: rgba(0,232,160,.3); }
.axis-text text { fill: var(--t3); font-size: 10px; font-family: Consolas, monospace; }
.axis-text.pct text.up { fill: var(--up); }
.axis-text.pct text.down { fill: var(--down); }
.axis-text.time text { fill: var(--t3); }

/* ===== 五档盘口 ===== */
.tm-book {
  flex: 1; min-width: 0;
  display: flex; flex-direction: column; gap: 1px;
  overflow: hidden;
}
.book-title { font-size: 11px; font-weight: 700; color: var(--cyan); padding-bottom: 3px; border-bottom: 1px solid var(--line); margin-bottom: 2px; }
.book-row {
  display: grid; grid-template-columns: 36px 1fr 52px; gap: 6px;
  font-size: 11px; padding: 2px 4px; border-radius: 3px;
  position: relative; align-items: center;
}
.book-row::before {
  content: ""; position: absolute; right: 0; top: 0; bottom: 0;
  width: var(--bar, 0%); background: rgba(255,100,120,.08); border-radius: 3px;
}
.book-row.buy::before { background: rgba(0,232,160,.08); }
.bk-lv { color: var(--t3); font-size: 10px; }
.bk-price { font-family: Consolas, monospace; font-weight: 600; position: relative; z-index: 1; }
.bk-vol { text-align: right; font-family: Consolas, monospace; color: var(--t2); position: relative; z-index: 1; }
.book-mid {
  display: flex; justify-content: space-between; align-items: center;
  padding: 3px 4px; margin: 2px 0;
  border-top: 1px solid var(--line); border-bottom: 1px solid var(--line);
}
.mid-price { font-size: 14px; font-weight: 800; font-family: Consolas, monospace; }
.mid-avg { font-size: 10px; color: var(--gold); font-family: Consolas, monospace; }
.book-summary {
  display: grid; grid-template-columns: 1fr 1fr; gap: 2px 8px;
  margin-top: auto; padding-top: 4px; border-top: 1px solid var(--line);
  font-size: 10px;
}
.book-summary span { display: flex; justify-content: space-between; }
.book-summary i { font-style: normal; color: var(--t3); }
.book-summary b { font-family: Consolas, monospace; font-weight: 600; }
.ft-empty { color: var(--t3); text-align: center; padding-top: 40px; font-size: 11px; flex: 1; }

/* 决策面板 */
.tm-decision {
  flex: 1; min-width: 0;
  display: flex; flex-direction: column; gap: 5px;
}
.dc-title {
  font-size: 15px; font-weight: 800; padding: 5px 8px; border-radius: 4px;
  text-align: center; background: rgba(255,255,255,.04);
}
.dc-title.long-open, .dc-title.long-close { color: var(--up); background: rgba(255,100,120,.1); }
.dc-title.short-open, .dc-title.short-close { color: var(--down); background: rgba(0,232,160,.08); }
.dc-title.force-close { color: #ffb13d; background: rgba(255,177,61,.12); }
.dc-title.stop-loss { color: #ff5096; background: rgba(255,80,150,.14); }
.dc-title.wait { color: var(--t2); }
.dc-status { font-size: 10px; color: var(--t3); text-align: center; }
.dc-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; }
.dc-item {
  display: flex; flex-direction: column; gap: 1px;
  background: rgba(255,255,255,.02); border-radius: 3px; padding: 3px 6px;
}
.dc-label { font-size: 9px; color: var(--t3); }
.dc-val { font-size: 13px; font-weight: 700; font-family: Consolas, monospace; color: var(--t1); }
.dc-reasons { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }
.dc-reason {
  font-size: 10px; color: var(--t2); padding: 3px 6px;
  background: rgba(0,232,216,.04); border-left: 2px solid var(--cyan); border-radius: 2px; line-height: 1.3;
}
.dc-btn {
  width: 100%; padding: 8px; border: none; border-radius: 4px;
  font-size: 13px; font-weight: 700; cursor: pointer; transition: all .2s;
  background: rgba(255,255,255,.08); color: var(--t3);
}
.dc-btn:disabled { cursor: not-allowed; }
.dc-btn.buy { background: linear-gradient(135deg, #ff6478, #e0455a); color: #fff; }
.dc-btn.sell { background: linear-gradient(135deg, #00c896, #00e8a0); color: #06281f; }
.dc-btn:hover:not(:disabled) { filter: brightness(1.1); }
.dc-btn.grid {
  margin-top: 4px;
  background: rgba(129,140,248,.15); color: #a5b4fc;
  border: 1px solid rgba(129,140,248,.5);
}
.dc-btn.grid:disabled { opacity: .45; cursor: not-allowed; }
.dc-actions { display: flex; flex-direction: column; gap: 4px; }
/* P2-8 数量快捷档 */
.dc-vols { display: flex; align-items: center; gap: 4px; }
.dc-vols button {
  background: rgba(255,255,255,.05); border: 1px solid var(--line); color: var(--t2);
  border-radius: 4px; padding: 3px 8px; font-size: 10px; cursor: pointer;
}
.dc-vols button.on { background: rgba(0,232,216,.15); color: var(--cyan); border-color: var(--cyan); }
.dc-vols-tip { font-size: 10px; color: var(--t3); margin-left: auto; font-family: Consolas, monospace; }
/* P2 执行确认层 */
.dc-confirm {
  border: 1px solid rgba(0,232,216,.4); background: rgba(0,232,216,.05);
  border-radius: 6px; padding: 8px; display: flex; flex-direction: column; gap: 3px;
}
.dc-confirm.grid { border-color: rgba(129,140,248,.5); background: rgba(129,140,248,.06); }
.cf-title { font-size: 11px; font-weight: 700; color: var(--cyan); text-align: center; padding-bottom: 3px; border-bottom: 1px solid var(--line); }
.dc-confirm.grid .cf-title { color: #a5b4fc; }
.cf-row { display: flex; justify-content: space-between; font-size: 10px; font-family: Consolas, monospace; }
.cf-row b { color: var(--t1); }
.cf-warn { color: #ffb13d; }
.cf-tip { font-size: 9px; color: var(--t3); }
.cf-btns { display: flex; gap: 6px; margin-top: 4px; }
.cf-yes {
  flex: 1; padding: 6px; border: none; border-radius: 4px;
  background: linear-gradient(135deg, #00c896, #00e8a0); color: #06281f;
  font-size: 12px; font-weight: 700; cursor: pointer;
}
.cf-no {
  flex: 1; padding: 6px; border: 1px solid var(--line); border-radius: 4px;
  background: rgba(255,255,255,.04); color: var(--t2); font-size: 12px; cursor: pointer;
}
.cf-yes:hover { filter: brightness(1.1); }
.cf-no:hover { background: rgba(255,255,255,.08); }
.dc-toast { font-size: 10px; color: var(--gold); text-align: center; }

/* 做T统计 */
.tm-stats {
  min-width: 0;
  display: flex; flex-direction: column; gap: 4px;
}
.tm-stats + .tm-stats { margin-top: 2px; }
.ts-head { display: flex; align-items: center; justify-content: space-between; }
.ts-title { font-size: 11px; font-weight: 700; color: var(--cyan); }
.ts-row { display: flex; gap: 8px; }
.ts-item { display: flex; flex-direction: column; align-items: center; }
.ts-n { font-size: 13px; font-weight: 800; font-family: Consolas, monospace; }
.ts-l { font-size: 8px; color: var(--t3); }
.ts-leg {
  font-size: 9px; color: var(--t2); padding: 2px 6px;
  background: rgba(255,177,61,.07); border-radius: 3px; font-family: Consolas, monospace;
}
.ts-legs { display: flex; flex-direction: column; gap: 2px; }
.ts-leg { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.ts-close-all {
  background: rgba(255,80,150,.12); border: 1px solid rgba(255,80,150,.5); color: #ff5096;
  border-radius: 4px; padding: 4px 8px; font-size: 10px; font-weight: 600; cursor: pointer;
}
.ts-close-all:hover:not(:disabled) { background: rgba(255,80,150,.22); }
.ts-close-all:disabled { opacity: .5; cursor: not-allowed; }
.leg-dot { width: 6px; height: 6px; border-radius: 50%; display: inline-block; margin-right: 3px; }
.leg-dot.long { background: var(--up); }
.leg-dot.short { background: var(--down); }
/* P2-4 跨日台账 */
.ts-hist {
  border-top: 1px dashed var(--line); padding-top: 3px;
  display: flex; align-items: baseline; gap: 8px;
}
.ts-h-title { font-size: 10px; font-weight: 700; color: var(--purple); }
.ts-h-line { display: flex; gap: 8px; font-size: 9px; font-family: Consolas, monospace; flex-wrap: wrap; }
.ts-h-line.sub { color: var(--t3); font-size: 9px; }
.ts-h-num { color: var(--t2); }
.ts-h-num.up { color: var(--up); }
.ts-h-num.down { color: var(--down); }
.ts-records { display: flex; flex-direction: column; gap: 1px; }
.ts-rec { display: flex; justify-content: space-between; font-size: 10px; font-family: Consolas, monospace; }
.rec-type { color: var(--t3); }
.rec-vol { color: var(--t2); }
.rec-pnl { font-weight: 600; }
.ts-metrics {
  margin-top: auto; display: grid; grid-template-columns: repeat(4, 1fr); gap: 2px 8px;
  padding-top: 4px; border-top: 1px solid var(--line); font-size: 10px;
}
.ts-metrics .mt { display: flex; justify-content: space-between; }
.ts-metrics .mt span { color: var(--t3); }
.ts-metrics .mt b { font-family: Consolas, monospace; font-weight: 600; color: var(--t1); }
/* P3 分钟级回测 */
.ts-bt { border-top: 1px dashed var(--line); padding-top: 3px; display: flex; flex-direction: column; gap: 3px; }
.ts-bt-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.ts-bt-head .ts-h-title { margin-right: 2px; }
.ts-bt-run {
  background: rgba(120,90,255,.14); color: var(--purple); border: 1px solid rgba(120,90,255,.35);
  border-radius: 4px; font-size: 10px; padding: 1px 8px; cursor: pointer;
}
.ts-bt-run:hover:not(:disabled) { background: rgba(120,90,255,.28); }
.ts-bt-run:disabled { opacity: .5; cursor: not-allowed; }
.ts-bt-notes { font-size: 9px; color: var(--t3); line-height: 1.3; }
.ts-bt-tip { font-size: 9px; color: var(--t3); line-height: 1.4; padding: 1px 0; }
.ts-bt-opt-btns { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 2px; }
.ts-bt-opt-btns .ts-h-num { font-size: 9px; }
.ts-bt-opt-head { font-size: 9px; color: var(--t3); padding: 1px 0 2px; border-bottom: 1px dashed var(--line); margin-bottom: 2px; line-height: 1.35; }
.ts-bt-params summary { font-size: 9px; color: var(--t3); cursor: pointer; }
.ts-bt-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 8px; padding: 4px 0 2px; }
.ts-bt-grid .tp { font-size: 9px; color: var(--t3); display: flex; flex-direction: column; align-items: stretch; justify-content: center; gap: 1px; }
.tp-lab { display: flex; align-items: center; gap: 4px; font-size: 9px; color: var(--t3); white-space: nowrap; }
.tp-tip { font-size: 8px; color: var(--t3); opacity: .72; line-height: 1.35; }
.ts-bt-grid input {
  width: 46px; background: rgba(255,255,255,.06); border: 1px solid var(--line);
  color: var(--t1); border-radius: 3px; font-size: 10px; text-align: right; padding: 0 2px;
}
.ts-bt-params .ts-bt-run { margin-top: 3px; }
.ts-bt-opt { display: flex; flex-direction: column; gap: 2px; }
.ts-bt-opt-row {
  display: flex; align-items: center; gap: 6px; font-size: 9px;
  background: rgba(255,255,255,.04); border: 1px solid var(--line); border-radius: 3px; padding: 1px 5px;
}
.ts-bt-opt-params { color: var(--t2); min-width: 84px; }
/* P3-7 盘前计划 */
.ts-plan-line { font-size: 9px; color: var(--t2); padding: 1px 0; }
.ts-plan-line b { color: var(--t1); font-family: Consolas, monospace; }
.ts-plan-lev { display: flex; justify-content: space-between; font-size: 9px; padding: 1px 0 1px 8px; color: var(--t2); }
.ts-plan-lev span:last-child { color: var(--t3); }
.ts-plan-skip { display: flex; flex-wrap: wrap; gap: 3px; padding-top: 3px; }
.badge-red { background: rgba(255,95,86,.14); color: #ff5f56; border-radius: 9px; padding: 0 7px; font-size: 9px; }
</style>
