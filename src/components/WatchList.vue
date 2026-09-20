<script setup lang="ts">
import { ref, nextTick } from "vue";
import { useWatchlistStore } from "../stores/watchlist";
import { useQuotesStore } from "../stores/quotes";
import { searchStocks } from "../api/market";
import type { StockItem, Quote } from "../api/types";

const props = defineProps<{ selected: string | null }>();
const emit = defineEmits<{ select: [code: string] }>();

const wl = useWatchlistStore();
const quotes = useQuotesStore();

const keyword = ref("");
const searchResults = ref<StockItem[]>([]);
const showSearch = ref(false);

// 分组：新建 / 重命名
const adding = ref(false);
const newGroupName = ref("");
const editingId = ref<number | null>(null);
const editName = ref("");
const groupInput = ref<HTMLInputElement | null>(null);

async function doSearch() {
  if (!keyword.value.trim()) {
    searchResults.value = [];
    showSearch.value = false;
    return;
  }
  searchResults.value = await searchStocks(keyword.value);
  showSearch.value = true;
}
function pick(s: StockItem) {
  wl.add(s.code, s.name);
  keyword.value = "";
  searchResults.value = [];
  showSearch.value = false;
  emit("select", s.code);
}

function qOf(code: string): Quote | undefined {
  return quotes.map[code];
}
function cls(pct?: number) {
  if (pct == null) return "flat";
  if (pct > 0) return "up";
  if (pct < 0) return "down";
  return "flat";
}
function fmt(n?: number, d = 2) {
  return n ? n.toFixed(d) : "--";
}

async function startAdd() {
  adding.value = true;
  newGroupName.value = "";
  await nextTick();
  groupInput.value?.focus();
}
async function commitAdd() {
  if (!adding.value) return;
  const name = newGroupName.value.trim();
  adding.value = false;
  if (name) await wl.addGroup(name);
}
async function startEdit(g: { id: number; name: string }) {
  editingId.value = g.id;
  editName.value = g.name;
  await nextTick();
  groupInput.value?.focus();
}
async function commitEdit(g: { id: number }) {
  if (editingId.value !== g.id) return;
  const name = editName.value.trim();
  editingId.value = null;
  if (name) await wl.renameGroup(g.id, name);
}
</script>

<template>
  <div class="panel">
    <div class="search">
      <input
        v-model="keyword"
        placeholder="输入代码/名称，回车添加到当前分组"
        @input="doSearch"
        @keydown.enter="doSearch"
      />
      <div v-if="showSearch && searchResults.length" class="results">
        <div
          v-for="s in searchResults.slice(0, 8)"
          :key="s.code"
          class="result-item"
          @mousedown.prevent="pick(s)"
        >
          <span class="code">{{ s.code }}</span>
          <span>{{ s.name }}</span>
          <span class="mkt">{{ s.market }}</span>
        </div>
      </div>
    </div>

    <!-- 分组栏 -->
    <div class="groups">
      <div
        v-for="g in wl.groups"
        :key="g.id"
        class="chip"
        :class="{ active: g.id === wl.currentGroupId }"
        @click="wl.selectGroup(g.id)"
        @dblclick="startEdit(g)"
      >
        <input
          v-if="editingId === g.id"
          ref="groupInput"
          v-model="editName"
          class="chip-input"
          @click.stop
          @keydown.enter="commitEdit(g)"
          @blur="commitEdit(g)"
        />
        <template v-else>
          <span class="gname">{{ g.name }}</span>
          <span class="gcount">{{ wl.stocksOf(g.id).length }}</span>
          <span
            v-if="g.id !== 1"
            class="gdel"
            title="删除分组（股票移回默认分组）"
            @click.stop="wl.removeGroup(g.id)"
            >×</span
          >
        </template>
      </div>
      <div v-if="adding" class="chip editing">
        <input
          ref="groupInput"
          v-model="newGroupName"
          class="chip-input"
          @keydown.enter="commitAdd"
          @blur="commitAdd"
        />
      </div>
      <div class="chip add" title="新建分组" @click="startAdd">+</div>
    </div>

    <table class="list">
      <thead>
        <tr>
          <th>名称/代码</th><th class="r">最新</th><th class="r">涨跌幅</th><th class="r">成交额</th><th></th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="s in wl.currentStocks"
          :key="s.code"
          :class="{ active: s.code === props.selected }"
          @click="emit('select', s.code)"
        >
          <td>
            <div class="nm">{{ qOf(s.code)?.name || s.name || "--" }}</div>
            <div class="cd">{{ s.code }}</div>
          </td>
          <td class="r" :class="cls(qOf(s.code)?.pct)">{{ fmt(qOf(s.code)?.price) }}</td>
          <td class="r" :class="cls(qOf(s.code)?.pct)">
            <span v-if="qOf(s.code)">{{ fmt(qOf(s.code)?.pct) }}%</span>
            <span v-else>--</span>
          </td>
          <td class="r dim">
            <span v-if="qOf(s.code)">{{ (qOf(s.code)!.amount / 1e8).toFixed(2) }}亿</span>
            <span v-else>--</span>
          </td>
          <td class="ops">
            <button class="del" title="移出自选" @click.stop="wl.remove(s.code)">×</button>
          </td>
        </tr>
        <tr v-if="wl.currentStocks.length === 0">
          <td colspan="5" class="empty">该分组暂无股票，上方搜索添加</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.panel { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.search { position: relative; padding: 8px; }
.search input { width: 100%; }
.results {
  position: absolute; top: 100%; left: 8px; right: 8px; z-index: 30;
  background: var(--bg-panel); border: 1px solid var(--border); border-radius: 6px;
  max-height: 240px; overflow: auto;
}
.result-item { display: flex; gap: 8px; padding: 7px 10px; cursor: pointer; }
.result-item:hover { background: var(--bg-hover); }
.result-item .code { color: var(--text-dim); }
.result-item .mkt { margin-left: auto; color: var(--text-dim); font-size: 11px; }

/* 分组栏 */
.groups {
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  padding: 4px 8px 8px; border-bottom: 1px solid var(--border);
}
.chip {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 3px 9px; border-radius: 14px; font-size: 12px;
  background: var(--bg-panel); border: 1px solid var(--border);
  cursor: pointer; color: var(--text-dim); white-space: nowrap;
}
.chip:hover { background: var(--bg-hover); }
.chip.active { color: #e6edf3; border-color: #2f6fed; background: #16233a; }
.gcount {
  font-size: 10px; background: rgba(255,255,255,0.08); border-radius: 8px; padding: 0 6px;
}
.gdel { color: #8b98a5; padding: 0 2px; }
.gdel:hover { color: #f23645; }
.chip.add { font-size: 15px; line-height: 1; padding: 2px 10px; }
.chip.editing { padding: 1px 6px; }
.chip-input { width: 84px; background: transparent; border: none; outline: none; color: #e6edf3; font-size: 12px; }

table { width: 100%; border-collapse: collapse; }
thead th {
  text-align: left; color: var(--text-dim); font-weight: 500;
  padding: 6px 8px; border-bottom: 1px solid var(--border);
  position: sticky; top: 0; background: var(--bg-panel); z-index: 5;
}
th.r, td.r { text-align: right; }
tbody tr { cursor: pointer; }
tbody tr:hover { background: var(--bg-hover); }
tbody tr.active { background: #1c2735; }
td { padding: 7px 8px; border-bottom: 1px solid #1b2129; }
.nm { font-weight: 600; }
.cd { font-size: 11px; color: var(--text-dim); }
.dim { color: var(--text-dim); }
.ops { width: 28px; text-align: center; }
.del {
  background: transparent; border: none; color: #8b98a5;
  font-size: 15px; cursor: pointer; line-height: 1; padding: 0 4px;
}
.del:hover { color: #f23645; }
.empty { text-align: center; color: var(--text-dim); padding: 30px; }
</style>
