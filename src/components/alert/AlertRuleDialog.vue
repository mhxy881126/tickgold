<template>
  <Transition name="dlg">
    <div v-if="open" class="mask" @click.self="close">
      <div class="dialog" role="dialog">
        <div class="d-head">
          <span class="d-title">{{ isEdit ? '编辑预警' : '新建预警' }}</span>
          <button class="x" @click="close">×</button>
        </div>

        <div class="d-body">
          <div class="row">
            <label class="lbl">名称</label>
            <input v-model="form.name" class="inp grow" placeholder="给规则起个名字" />
          </div>

          <div class="row">
            <label class="lbl">作用范围</label>
            <div class="seg">
              <button :class="{ on: form.scope.kind === 'all' }" @click="setScope('all')">全部自选</button>
              <button :class="{ on: form.scope.kind === 'group' }" @click="setScope('group')">自选分组</button>
              <button :class="{ on: form.scope.kind === 'code' }" @click="setScope('code')">单只股票</button>
            </div>
          </div>

          <div v-if="form.scope.kind === 'group'" class="row sub">
            <select v-model="groupVal" class="inp grow">
              <option v-for="g in wl.groups" :key="g.id" :value="g.id">{{ g.name }}</option>
            </select>
          </div>
          <div v-if="form.scope.kind === 'code'" class="row sub">
            <input v-model="kw" class="inp grow" placeholder="输入代码/名称/拼音搜索" />
            <div v-if="results.length" class="search-pop">
              <div
                v-for="s in results"
                :key="s.code"
                class="search-item"
                @click="pickCode(s.code, s.name)"
              >
                {{ s.code }} {{ s.name }}
              </div>
            </div>
            <span v-if="codeVal" class="code-chip">{{ codeVal }} ×</span>
          </div>

          <div class="section-title">触发条件</div>
          <AlertTreeNode :model="form.tree" :is-root="true" />

          <div class="section-title">触发动作</div>
          <div class="chk-grid">
            <label v-for="a in ACTION_OPTS" :key="a.key" class="chk">
              <input v-model="form.actions[a.key]" type="checkbox" />{{ a.label }}
            </label>
          </div>

          <div class="row two">
            <div class="grow">
              <label class="lbl">频率</label>
              <div class="seg">
                <button :class="{ on: form.frequency === 'persistent' }" @click="form.frequency = 'persistent'">持续</button>
                <button :class="{ on: form.frequency === 'daily' }" @click="form.frequency = 'daily'">每日一次</button>
                <button :class="{ on: form.frequency === 'once' }" @click="form.frequency = 'once'">仅一次</button>
              </div>
            </div>
            <div>
              <label class="lbl">冷却(秒)</label>
              <input v-model.number="form.cooldownSec" type="number" min="0" class="inp" />
            </div>
            <div>
              <label class="lbl">提示基调</label>
              <div class="seg">
                <button :class="{ on: form.tone === 'auto' }" @click="form.tone = 'auto'">自动</button>
                <button :class="{ on: form.tone === 'up' }" @click="form.tone = 'up'">涨</button>
                <button :class="{ on: form.tone === 'down' }" @click="form.tone = 'down'">跌</button>
              </div>
            </div>
          </div>

          <div class="section-title">静默时段</div>
          <div v-for="(q, i) in form.quiet" :key="i" class="row sub">
            <input v-model="q.start" type="time" class="inp" />
            <span>至</span>
            <input v-model="q.end" type="time" class="inp" />
            <button class="x-btn" @click="form.quiet.splice(i, 1)">×</button>
          </div>
          <button class="add-quiet" @click="form.quiet.push({ start: '11:30', end: '13:00' })">
            + 添加静默时段
          </button>
        </div>

        <div class="d-foot">
          <button class="btn ghost" @click="close">取消</button>
          <button class="btn primary" @click="submit">保存</button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import type { AlertRuleV2, Scope } from "../../alert/types";
import { defaultActions, emptyTree, newRuleId } from "../../alert/types";
import { useWatchlistStore } from "../../stores/watchlist";
import { searchStocks } from "../../api/market";
import AlertTreeNode from "./AlertTreeNode.vue";

const props = defineProps<{ open: boolean; rule?: AlertRuleV2 | null }>();
const emit = defineEmits<{ "update:open": [boolean]; save: [AlertRuleV2] }>();

const wl = useWatchlistStore();

const ACTION_OPTS: { key: keyof AlertRuleV2["actions"]; label: string }[] = [
  { key: "notify", label: "系统通知" },
  { key: "sound", label: "声音" },
  { key: "popup", label: "弹窗" },
  { key: "island", label: "灵动岛" },
  { key: "openChart", label: "打开K线" },
  { key: "openBook", label: "打开盘口" },
];

const isEdit = computed(() => !!props.rule);

const form = reactive<AlertRuleV2>(blank());

function blank(): AlertRuleV2 {
  const now = Date.now();
  return {
    id: newRuleId(),
    name: "",
    scope: { kind: "all" },
    tree: emptyTree(),
    actions: defaultActions(),
    tone: "auto",
    frequency: "persistent",
    cooldownSec: 300,
    quiet: [],
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
}

const groupVal = ref<number>(1);
const codeVal = ref<string>("");
const kw = ref("");
const results = ref<{ code: string; name: string }[]>([]);

function setScope(kind: Scope["kind"]) {
  if (kind === "all") form.scope = { kind: "all" };
  else if (kind === "group") form.scope = { kind: "group", groupId: groupVal.value };
  else form.scope = { kind: "code", code: codeVal.value };
}

function pickCode(code: string, _name?: string) {
  codeVal.value = code;
  form.scope = { kind: "code", code };
  kw.value = "";
  results.value = [];
}

let searchTimer: number | null = null;
watch(kw, (v) => {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = window.setTimeout(async () => {
    if (!v.trim()) results.value = [];
    else results.value = await searchStocks(v);
  }, 250);
});

watch(
  groupVal,
  (v) => {
    if (form.scope.kind === "group") form.scope = { kind: "group", groupId: v };
  }
);

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    if (props.rule) {
      Object.assign(form, JSON.parse(JSON.stringify(props.rule)) as AlertRuleV2);
      if (form.scope.kind === "group") groupVal.value = form.scope.groupId;
      if (form.scope.kind === "code") codeVal.value = form.scope.code;
    } else {
      Object.assign(form, blank());
      codeVal.value = "";
      kw.value = "";
    }
  },
  { immediate: true }
);

function close() {
  emit("update:open", false);
}

function submit() {
  if (!form.name.trim()) form.name = "未命名预警";
  if (form.scope.kind === "code" && !form.scope.code) return;
  if (form.scope.kind === "group")
    form.scope = { kind: "group", groupId: groupVal.value };
  form.updatedAt = Date.now();
  emit("save", JSON.parse(JSON.stringify(form)) as AlertRuleV2);
  close();
}
</script>

<style scoped>
.mask {
  position: fixed; inset: 0; z-index: 9000;
  background: rgba(0, 0, 0, 0.55);
  display: flex; align-items: center; justify-content: center;
  backdrop-filter: blur(2px);
}
.dialog {
  width: min(680px, 92vw); max-height: 88vh; display: flex; flex-direction: column;
  background: var(--bg-card, #16181d);
  border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
  border-radius: 12px;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.5);
}
.d-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 18px; border-bottom: 1px solid var(--border, rgba(255, 255, 255, 0.1));
}
.d-title { font-size: 15px; font-weight: 600; }
.x { background: none; border: none; color: var(--text-dim, #9aa0a6); font-size: 20px; cursor: pointer; }
.d-body { padding: 16px 18px; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; }
.d-foot { display: flex; justify-content: flex-end; gap: 10px; padding: 12px 18px; border-top: 1px solid var(--border, rgba(255, 255, 255, 0.1)); }

.row { display: flex; align-items: center; gap: 10px; }
.row.sub { padding-left: 84px; position: relative; }
.row.two { align-items: flex-end; gap: 14px; }
.lbl { font-size: 12px; color: var(--text-dim, #9aa0a6); width: 72px; flex: none; }
.grow { flex: 1; }
.inp {
  background: var(--bg-elevated, rgba(255, 255, 255, 0.06));
  border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
  color: var(--text, #e8eaed);
  border-radius: 6px; padding: 6px 8px; font-size: 13px;
}
.inp.grow { width: 100%; }

.seg { display: inline-flex; border: 1px solid var(--border, rgba(255, 255, 255, 0.14)); border-radius: 7px; overflow: hidden; flex-wrap: wrap; }
.seg button {
  background: transparent; border: none; color: var(--text-dim, #9aa0a6);
  font-size: 12px; padding: 5px 12px; cursor: pointer;
}
.seg button.on { background: var(--accent, #d4af37); color: #1a1a1a; }

.section-title { font-size: 12px; font-weight: 600; color: var(--text, #e8eaed); margin-top: 8px; }

.chk-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.chk { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text, #e8eaed); }

.search-pop {
  position: absolute; top: 100%; left: 84px; right: 0; z-index: 5;
  background: var(--bg-card, #1d2026); border: 1px solid var(--border, rgba(255, 255, 255, 0.14));
  border-radius: 8px; max-height: 200px; overflow-y: auto;
}
.search-item { padding: 7px 10px; font-size: 12px; cursor: pointer; }
.search-item:hover { background: var(--bg-elevated, rgba(255, 255, 255, 0.08)); }
.code-chip { font-size: 12px; color: var(--accent, #d4af37); }

.x-btn { background: none; border: none; color: var(--text-dim, #9aa0a6); cursor: pointer; font-size: 15px; }
.add-quiet {
  align-self: flex-start; background: transparent;
  border: 1px dashed var(--border, rgba(255, 255, 255, 0.2));
  color: var(--text-dim, #9aa0a6); border-radius: 7px; font-size: 12px; padding: 5px 12px; cursor: pointer;
}
.btn { border-radius: 8px; font-size: 13px; padding: 7px 18px; cursor: pointer; border: 1px solid transparent; }
.btn.ghost { background: transparent; color: var(--text-dim, #9aa0a6); border-color: var(--border, rgba(255, 255, 255, 0.14)); }
.btn.primary { background: var(--accent, #d4af37); color: #1a1a1a; font-weight: 600; }

.dlg-enter-active, .dlg-leave-active { transition: opacity 0.18s ease; }
.dlg-enter-from, .dlg-leave-to { opacity: 0; }
</style>
