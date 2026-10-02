<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import {
  cloneProfile,
  listProfiles,
  saveProfileVersion,
  seedStrategyProfiles,
  setCurrentProfile,
  type ProfileRow,
  type StrategySpec,
} from "../lib/strategySeed";

const rows = ref<ProfileRow[]>([]);
const selectedKey = ref<string | null>(null);
const editing = ref(false);
const showHistory = ref(false);
const cloning = ref(false);
const errMsg = ref("");
const editName = ref("");
const editNote = ref("");
const editSpec = ref("");
const cloneName = ref("");

const grouped = computed(() => {
  const map = new Map<string, { current?: ProfileRow; count: number }>();
  for (const r of rows.value) {
    const g = map.get(r.key) ?? { count: 0 };
    g.count += 1;
    if (r.is_current === 1) g.current = r;
    map.set(r.key, g);
  }
  return [...map.entries()].map(([key, g]) => ({
    key,
    current: g.current,
    count: g.count,
  }));
});

const current = computed(
  () => grouped.value.find((g) => g.key === selectedKey.value)?.current ?? null
);
const versions = computed(() =>
  rows.value
    .filter((r) => r.key === selectedKey.value)
    .sort((a, b) => b.version - a.version)
);
const spec = computed<StrategySpec | null>(() =>
  current.value ? (JSON.parse(current.value.spec) as StrategySpec) : null
);

async function reload() {
  await seedStrategyProfiles();
  rows.value = await listProfiles();
  if (!selectedKey.value && grouped.value[0]) {
    selectedKey.value = grouped.value[0].key;
  }
}

function startEdit() {
  if (!current.value) return;
  editName.value = current.value.name;
  editNote.value = current.value.note;
  editSpec.value = JSON.stringify(
    JSON.parse(current.value.spec),
    null,
    2
  );
  errMsg.value = "";
  editing.value = true;
}

async function saveEdit() {
  let parsed: StrategySpec;
  try {
    parsed = JSON.parse(editSpec.value) as StrategySpec;
  } catch {
    errMsg.value = "spec JSON 格式有误，请检查";
    return;
  }
  await saveProfileVersion({
    key: selectedKey.value as string,
    name: editName.value,
    spec: parsed,
    note: editNote.value,
    builtin: current.value?.builtin === 1,
  });
  editing.value = false;
  await reload();
}

function startClone() {
  cloneName.value = `${current.value?.name ?? ""} 副本`;
  cloning.value = true;
}

async function confirmClone() {
  const key = await cloneProfile(
    current.value as ProfileRow,
    cloneName.value || `${current.value?.name ?? ""} 副本`
  );
  cloning.value = false;
  await reload();
  selectedKey.value = key;
}

async function rollback(v: ProfileRow) {
  await setCurrentProfile(v.id, v.key);
  await reload();
}

function fmtDate(ts: number) {
  return new Date(ts).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

onMounted(() => {
  void reload().catch(() => {});
});
</script>

<template>
  <div class="sp">
    <div class="sp-head">
      <div class="sp-title">策略库</div>
      <button class="sp-btn" @click="reload">刷新</button>
    </div>

    <div class="sp-body">
      <div class="sp-list">
        <div
          v-for="g in grouped"
          :key="g.key"
          class="sp-row"
          :class="{ on: g.key === selectedKey }"
          @click="selectedKey = g.key"
        >
          <span class="sp-name">{{ g.current?.name ?? g.key }}</span>
          <span class="sp-meta">
            {{ g.current?.builtin ? "内置" : "自定义" }} · v{{ g.current?.version }} ·
            {{ g.count }} 版
          </span>
        </div>
      </div>

      <div class="sp-detail" v-if="current && spec">
        <template v-if="!editing">
          <div class="sp-d-head">
            <span class="sp-d-name">{{ current.name }}</span>
            <div class="sp-actions">
              <button class="sp-mini" @click="startClone">克隆</button>
              <button class="sp-mini" @click="startEdit">编辑</button>
              <button class="sp-mini" @click="showHistory = !showHistory">
                版本 {{ versions.length }}
              </button>
            </div>
          </div>
          <div class="sp-note" v-if="current.note">{{ current.note }}</div>

          <div class="sp-sec">适用环境</div>
          <div class="sp-val">{{ spec.marketRegime }}</div>

          <div class="sp-sec">入场条件</div>
          <div class="sp-kv">
            <span v-for="(v, k) in spec.entry" :key="k">
              <b>{{ k }}</b><i>{{ v }}</i>
            </span>
          </div>

          <div class="sp-sec">仓位管理（%）</div>
          <div class="sp-kv">
            <span><b>初始</b><i>{{ spec.position.initial }}</i></span>
            <span><b>加仓</b><i>{{ spec.position.add }}</i></span>
            <span><b>上限</b><i>{{ spec.position.max }}</i></span>
          </div>

          <div class="sp-sec">止盈 / 止损</div>
          <div class="sp-kv">
            <span>
              <b>止盈{{ spec.takeProfit.pct != null ? `(${spec.takeProfit.pct}%)` : "" }}</b>
              <i>{{ spec.takeProfit.rule }}</i>
            </span>
            <span>
              <b>止损{{ spec.stopLoss.pct != null ? `(${spec.stopLoss.pct}%)` : "" }}</b>
              <i>{{ spec.stopLoss.rule }}</i>
            </span>
          </div>

          <div class="sp-sec">持有周期</div>
          <div class="sp-val">{{ spec.holdingPeriod }}</div>

          <div class="sp-sec">排除条件</div>
          <div class="sp-tags">
            <span v-for="(e, i) in spec.exclude" :key="i">{{ e }}</span>
          </div>

          <template v-if="showHistory">
            <div class="sp-sec">版本历史</div>
            <div class="sp-ver">
              <div v-for="v in versions" :key="v.id" class="sp-ver-row">
                <span class="sp-ver-name">
                  v{{ v.version }}<i v-if="v.is_current"> · 当前</i>
                </span>
                <span class="sp-ver-date">{{ fmtDate(v.updated_at) }}</span>
                <button v-if="!v.is_current" class="sp-mini" @click="rollback(v)">
                  设为当前
                </button>
              </div>
            </div>
          </template>
        </template>

        <template v-else>
          <div class="sp-sec">名称</div>
          <input v-model="editName" class="sp-input" />
          <div class="sp-sec">说明</div>
          <input v-model="editNote" class="sp-input" />
          <div class="sp-sec">spec（JSON，保存为新版本）</div>
          <textarea v-model="editSpec" class="sp-area" rows="14"></textarea>
          <div class="sp-err" v-if="errMsg">{{ errMsg }}</div>
          <div class="sp-actions" style="margin-top: 6px">
            <button class="sp-mini sp-primary" @click="saveEdit">保存为新版本</button>
            <button class="sp-mini" @click="editing = false">取消</button>
          </div>
        </template>
      </div>
    </div>

    <div v-if="cloning" class="sp-mask" @click.self="cloning = false">
      <div class="sp-modal">
        <div class="sp-modal-title">克隆策略</div>
        <input v-model="cloneName" class="sp-input" />
        <div class="sp-actions" style="margin-top: 8px">
          <button class="sp-mini sp-primary" @click="confirmClone">克隆</button>
          <button class="sp-mini" @click="cloning = false">取消</button>
        </div>
      </div>
    </div>

    <div class="sp-foot">策略参数仅供参考，不构成投资建议</div>
  </div>
</template>

<style scoped>
.sp { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 6px; font-size: 12px; }
.sp-head { display: flex; align-items: center; justify-content: space-between; }
.sp-title { font-weight: 700; color: var(--text, #e6ecf5); }
.sp-btn {
  padding: 3px 12px; border: 1px solid var(--border, #2a3344); border-radius: 7px;
  background: var(--bg-card, #15181f); color: var(--accent, #d4af37);
  font-size: 11px; cursor: pointer;
}
.sp-body { flex: 1; min-height: 0; display: flex; gap: 8px; }
.sp-list { width: 36%; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }
.sp-row {
  display: flex; flex-direction: column; gap: 2px; padding: 6px 8px;
  border: 1px solid transparent; border-radius: 8px; cursor: pointer;
}
.sp-row:hover { background: var(--bg-hover, rgba(255, 255, 255, 0.04)); }
.sp-row.on { background: var(--bg-hover, rgba(255, 255, 255, 0.06)); border-color: var(--border, #2a3344); }
.sp-name { color: var(--text, #e6ecf5); font-weight: 600; }
.sp-meta { color: var(--text-dim, #8a93a6); font-size: 10px; }
.sp-detail { flex: 1; min-width: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 3px; }
.sp-d-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 2px; }
.sp-d-name { font-size: 13px; font-weight: 700; color: var(--text, #e6ecf5); }
.sp-actions { display: flex; gap: 6px; }
.sp-mini {
  padding: 2px 10px; border: 1px solid var(--border, #2a3344); border-radius: 6px;
  background: var(--bg-card, #15181f); color: var(--text, #dfe5f0);
  font-size: 10px; cursor: pointer;
}
.sp-mini:hover { border-color: var(--accent, #d4af37); color: var(--accent, #d4af37); }
.sp-primary { color: var(--accent, #d4af37); border-color: var(--accent, #d4af37); }
.sp-note { color: var(--text-dim, #9aa3b6); font-size: 11px; margin-bottom: 4px; }
.sp-sec {
  margin-top: 6px; font-size: 10px; letter-spacing: .5px;
  color: var(--accent, #d4af37); font-weight: 700;
}
.sp-val { color: var(--text, #dfe5f0); line-height: 1.5; }
.sp-kv { display: flex; flex-direction: column; gap: 3px; }
.sp-kv span { display: flex; gap: 8px; align-items: baseline; }
.sp-kv b { color: var(--text-dim, #aab2c4); font-weight: 500; min-width: 92px; font-size: 11px; }
.sp-kv i { color: var(--text, #e6ecf5); font-style: normal; line-height: 1.45; }
.sp-tags { display: flex; flex-wrap: wrap; gap: 4px; }
.sp-tags span {
  padding: 1px 8px; border-radius: 10px; font-size: 10px;
  background: rgba(255, 255, 255, 0.05); color: var(--text-dim, #b6bdcc);
}
.sp-ver { display: flex; flex-direction: column; gap: 3px; }
.sp-ver-row {
  display: flex; align-items: center; gap: 8px; padding: 4px 6px;
  border-radius: 6px; background: rgba(255, 255, 255, 0.03);
}
.sp-ver-name { color: var(--text, #dfe5f0); font-size: 11px; min-width: 64px; }
.sp-ver-name i { color: var(--accent, #d4af37); font-style: normal; }
.sp-ver-date { flex: 1; color: var(--text-dim, #8a93a6); font-size: 10px; }
.sp-input {
  width: 100%; box-sizing: border-box; padding: 5px 8px; font-size: 11px;
  border: 1px solid var(--border, #2a3344); border-radius: 6px;
  background: var(--bg-card, #11141b); color: var(--text, #e6ecf5);
}
.sp-area {
  width: 100%; box-sizing: border-box; padding: 8px; font-size: 11px; line-height: 1.5;
  border: 1px solid var(--border, #2a3344); border-radius: 6px;
  background: var(--bg-card, #11141b); color: var(--text, #dfe5f0);
  font-family: ui-monospace, Consolas, monospace; resize: vertical;
}
.sp-err { color: #ff6b78; font-size: 11px; margin-top: 4px; }
.sp-mask {
  position: absolute; inset: 0; background: rgba(0, 0, 0, 0.5);
  display: flex; align-items: center; justify-content: center; z-index: 20; border-radius: inherit;
}
.sp-modal {
  width: 280px; padding: 14px; border-radius: 12px;
  background: var(--bg-elevated, #1a1e28); border: 1px solid var(--border, #2a3344);
}
.sp-modal-title { font-weight: 700; margin-bottom: 8px; color: var(--text, #e6ecf5); }
.sp-foot { color: var(--text-dim, #7a8496); font-size: 10px; }
</style>
