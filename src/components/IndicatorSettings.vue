<template>
  <Teleport to="body">
    <div v-if="open" class="is-overlay" @click="close">
      <div class="is-box" @click.stop>
        <div class="is-title">
          <span>指标设置</span>
          <button class="is-x" @click="close">×</button>
        </div>
        <div class="is-tabs">
          <button class="is-tab" :class="{ on: tab === 'params' }" @click="tab = 'params'">参数 / 配色</button>
          <button class="is-tab" :class="{ on: tab === 'tpl' }" @click="switchTpl">模板管理</button>
        </div>

        <!-- ===== Tab1：参数 / 配色 ===== -->
        <div v-if="tab === 'params'" class="is-pane">
          <div v-if="!targets.length" class="is-empty">当前周期暂无可设置的指标</div>
          <template v-else>
            <div class="is-chips">
              <button
                v-for="t in targets"
                :key="t.paneId + t.name"
                class="is-chip"
                :class="{ on: sel && sel.name === t.name && sel.paneId === t.paneId }"
                @click="select(t)"
              >{{ t.label }}</button>
            </div>
            <template v-if="form">
              <div v-if="form.params.length" class="is-sec">参数周期</div>
              <div v-for="(p, i) in form.params" :key="'p' + i" class="is-row">
                <label>参数 {{ i + 1 }}</label>
                <input type="number" v-model.number="form.params[i]" class="is-input" />
              </div>
              <div v-if="form.colors.length" class="is-sec">线条颜色</div>
              <div v-for="(c, i) in form.colors" :key="'c' + i" class="is-row">
                <label>{{ form.lineTitles[i] || ('线 ' + (i + 1)) }}</label>
                <input type="color" v-model="form.colors[i]" class="is-color" />
              </div>
              <div v-if="!form.colors.length" class="is-hint">该指标无独立线条（点状 / 柱状由默认样式渲染）</div>
              <div class="is-actions">
                <button class="is-btn reset" @click="resetForm">还原</button>
                <button class="is-btn apply" @click="apply">应用</button>
              </div>
            </template>
          </template>
        </div>

        <!-- ===== Tab2：模板管理 ===== -->
        <div v-if="tab === 'tpl'" class="is-pane">
          <div class="tpl-save">
            <input v-model="tplName" class="is-input grow" placeholder="模板名称，如：短线主图" @keyup.enter="saveTemplate" />
            <button class="is-btn apply" @click="saveTemplate">保存当前</button>
          </div>
          <div v-if="!tpls.length" class="is-empty">暂无模板，配置好指标后点「保存当前」</div>
          <div v-for="t in tpls" :key="t.id" class="tpl-item">
            <div class="tpl-meta">
              <span class="tpl-name">{{ t.name }}</span>
              <span class="tpl-date">{{ fmtDate(t.created_at) }}</span>
            </div>
            <div class="tpl-btns">
              <button class="tpl-btn" @click="useTemplate(t)">应用</button>
              <button class="tpl-btn" @click="exportTemplate(t)">导出</button>
              <button class="tpl-btn danger" @click="delTemplate(t)">删除</button>
            </div>
          </div>
          <div class="tpl-foot">
            <label class="is-btn ghost file">
              导入 JSON
              <input type="file" accept="application/json,.json" @change="importFile" hidden />
            </label>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import type { Chart } from "klinecharts";
import { db } from "../db/database";

interface Target { name: string; paneId: string; label: string }
const props = defineProps<{
  open: boolean;
  chart: Chart | null;
  targets: Target[];
  snapshotFn: () => any;
}>();
const emit = defineEmits<{
  "update:open": [v: boolean];
  "apply-template": [p: any];
}>();

// 完整线条样式（缺字段会导致库内部 mergeLines 读取 dashedValue 异常）
const fullLine = (color: string) => ({
  color,
  style: "solid" as const,
  smooth: false,
  size: 1,
  dashedValue: [2, 2] as [number, number],
});

const tab = ref<"params" | "tpl">("params");
const sel = ref<Target | null>(null);
const form = ref<{ params: number[]; colors: string[]; lineTitles: string[] } | null>(null);

function close() {
  emit("update:open", false);
}

// 读取目标指标，填充表单
function select(t: Target) {
  sel.value = t;
  if (!props.chart) { form.value = null; return; }
  const ind = props.chart.getIndicatorByPaneId(t.paneId, t.name) as any;
  if (!ind) { form.value = null; return; }
  const colors: string[] = [];
  const lineTitles: string[] = [];
  for (const f of ind.figures ?? []) {
    if (f.type === "line") {
      lineTitles.push(String(f.title || "").replace(/[:：\s]+$/, ""));
      colors.push(ind.styles?.lines?.[colors.length]?.color ?? "#ffffff");
    }
  }
  form.value = {
    params: ((ind.calcParams as any[]) ?? []).map((x) => Number(x)),
    colors,
    lineTitles,
  };
}
function resetForm() {
  if (sel.value) select(sel.value);
}
function apply() {
  if (!props.chart || !sel.value || !form.value) return;
  const { params, colors } = form.value;
  props.chart.overrideIndicator(
    {
      name: sel.value.name,
      calcParams: params.slice(),
      styles: { lines: colors.map((c) => fullLine(c)) },
    } as any,
    sel.value.paneId
  );
}

// 弹窗打开：默认选中第一个目标
watch(
  () => props.open,
  (v) => {
    if (v) {
      tab.value = "params";
      sel.value = null;
      form.value = null;
      if (props.targets.length) select(props.targets[0]);
    }
  }
);
// 指标开关变化导致目标变化时，保持有效选中
watch(
  () => props.targets,
  (ts) => {
    if (!props.open) return;
    const still =
      sel.value && ts.some((x) => x.name === sel.value!.name && x.paneId === sel.value!.paneId);
    if (!still) select(ts[0]);
  },
  { deep: true }
);

// ===== 模板管理 =====
const tplName = ref("");
const tpls = ref<{ id: number; name: string; payload: string; created_at: number }[]>([]);

async function loadTpls() {
  let d;
  try { d = db(); } catch { return; }
  try {
    tpls.value = await d.select(
      "SELECT id,name,payload,created_at FROM ind_template ORDER BY created_at DESC"
    );
  } catch (e) {
    console.warn("[ind] load templates", e);
  }
}
function switchTpl() {
  tab.value = "tpl";
  loadTpls();
}

async function saveTemplate() {
  const name = tplName.value.trim();
  if (!name) { alert("请填写模板名称"); return; }
  let d;
  try { d = db(); } catch { return; }
  const payload = JSON.stringify(props.snapshotFn());
  try {
    await d.execute(
      "INSERT INTO ind_template(name,payload,created_at) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET payload=excluded.payload, created_at=excluded.created_at",
      [name, payload, Date.now()]
    );
    tplName.value = "";
    await loadTpls();
  } catch (e) {
    console.warn("[ind] save template", e);
    alert("保存失败");
  }
}

function useTemplate(t: { payload: string }) {
  let p;
  try { p = JSON.parse(t.payload); } catch { alert("模板已损坏"); return; }
  emit("apply-template", p);
  emit("update:open", false);
}
async function delTemplate(t: { id: number; name: string }) {
  if (!confirm(`删除模板「${t.name}」？`)) return;
  let d;
  try { d = db(); } catch { return; }
  await d.execute("DELETE FROM ind_template WHERE id=?", [t.id]);
  await loadTpls();
}
function fmtDate(ts: number) {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 导出为 JSON 文件
function exportTemplate(t: { name: string; payload: string }) {
  const blob = new Blob([t.payload], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `TickGold-ind-${t.name}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// 导入 JSON：确定=立即应用，取消=仅存为模板
function importFile(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    let p;
    try { p = JSON.parse(String(reader.result)); } catch { alert("文件不是有效的 JSON"); return; }
    if (!p || typeof p !== "object") { alert("内容不是有效的指标模板"); return; }
    const act = confirm("确定 = 立即应用该模板；取消 = 仅保存为模板");
    if (act) {
      emit("apply-template", p);
      emit("update:open", false);
    } else {
      const name = prompt("模板名称", file.name.replace(/\.json$/i, ""));
      if (!name) return;
      let d;
      try { d = db(); } catch { return; }
      d.execute(
        "INSERT INTO ind_template(name,payload,created_at) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET payload=excluded.payload, created_at=excluded.created_at",
        [name, JSON.stringify(p), Date.now()]
      ).then(() => loadTpls());
    }
  };
  reader.readAsText(file);
  (e.target as HTMLInputElement).value = "";
}
</script>

<style>
.is-overlay {
  position: fixed; inset: 0; z-index: 9300;
  background: rgba(0, 0, 0, .55);
  display: flex; align-items: center; justify-content: center;
}
.is-box {
  width: 452px; max-height: 84vh;
  display: flex; flex-direction: column;
  background: #14161d; border: 1px solid rgba(255, 255, 255, .12);
  border-radius: 14px; overflow: hidden;
  box-shadow: 0 24px 70px rgba(0, 0, 0, .65);
  color: #d6dae3; font-size: 12px;
}
.is-title {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 16px; font-size: 14px; font-weight: 700; color: #eef1f6;
  border-bottom: 1px solid rgba(255, 255, 255, .07);
}
.is-x {
  border: none; background: transparent; color: #9aa1b1;
  width: 28px; height: 28px; border-radius: 6px; cursor: pointer; font-size: 16px;
}
.is-x:hover { background: rgba(255, 255, 255, .1); color: #fff; }
.is-tabs { display: flex; gap: 6px; padding: 10px 16px 0; }
.is-tab {
  border: none; background: transparent; color: #9aa1b1;
  padding: 7px 14px; border-radius: 8px 8px 0 0; cursor: pointer; font-size: 12px;
}
.is-tab:hover { color: #e6e9f0; }
.is-tab.on { color: #ff8a8a; background: rgba(255, 50, 50, .1); font-weight: 600; }
.is-pane {
  padding: 14px 16px 16px; overflow-y: auto;
  border-top: 1px solid rgba(255, 255, 255, .07);
}
.is-empty { color: #7b8294; text-align: center; padding: 28px 0; }
.is-hint { color: #7b8294; font-size: 11px; padding: 6px 0; }

.is-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
.is-chip {
  border: 1px solid rgba(255, 255, 255, .12); background: rgba(255, 255, 255, .03);
  color: #c0c6d4; padding: 5px 11px; border-radius: 14px; cursor: pointer; font-size: 11px;
}
.is-chip:hover { background: rgba(255, 255, 255, .08); }
.is-chip.on { border-color: rgba(255, 80, 80, .55); background: rgba(255, 50, 50, .16); color: #ff8a8a; }

.is-sec {
  font-size: 11px; color: #8b93a7; font-weight: 600;
  margin: 10px 0 7px; padding-bottom: 5px; border-bottom: 1px dashed rgba(255, 255, 255, .08);
}
.is-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 8px; }
.is-row label { color: #9aa1b1; }
.is-input {
  height: 30px; width: 130px; border: 1px solid rgba(255, 255, 255, .12); border-radius: 6px;
  background: #0d0f14; color: #e6e9f0; padding: 0 10px; font-size: 12px; box-sizing: border-box;
}
.is-color {
  height: 30px; width: 64px; border: 1px solid rgba(255, 255, 255, .12); border-radius: 6px;
  background: #0d0f14; padding: 2px; cursor: pointer; box-sizing: border-box;
}
.is-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
.is-btn {
  height: 32px; padding: 0 16px; border-radius: 7px; cursor: pointer; font-size: 12px;
  display: inline-flex; align-items: center; justify-content: center;
}
.is-btn.reset { border: 1px solid rgba(255, 255, 255, .15); background: transparent; color: #c7ccd8; }
.is-btn.apply { border: none; background: #ff3232; color: #fff; font-weight: 600; }
.is-btn.apply:hover { background: #ff4d4d; }
.is-btn.ghost { border: 1px solid rgba(255, 255, 255, .18); background: transparent; color: #c7ccd8; }
.is-btn.file { cursor: pointer; }

/* 模板 */
.tpl-save { display: flex; gap: 8px; margin-bottom: 14px; }
.is-input.grow { flex: 1; width: auto; }
.tpl-item {
  display: flex; align-items: center; justify-content: space-between;
  padding: 9px 10px; margin-bottom: 7px;
  background: rgba(255, 255, 255, .03); border: 1px solid rgba(255, 255, 255, .07);
  border-radius: 9px;
}
.tpl-meta { display: flex; flex-direction: column; gap: 2px; }
.tpl-name { color: #e6e9f0; font-weight: 600; }
.tpl-date { color: #7b8294; font-size: 10px; }
.tpl-btns { display: flex; gap: 5px; }
.tpl-btn {
  border: 1px solid rgba(255, 255, 255, .14); background: transparent; color: #c0c6d4;
  padding: 4px 10px; border-radius: 6px; cursor: pointer; font-size: 11px;
}
.tpl-btn:hover { background: rgba(255, 255, 255, .08); color: #fff; }
.tpl-btn.danger { border-color: rgba(255, 90, 90, .4); color: #ff8a8a; }
.tpl-btn.danger:hover { background: rgba(255, 60, 60, .18); }
.tpl-foot { margin-top: 12px; display: flex; justify-content: center; }
</style>
