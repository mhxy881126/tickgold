<script setup lang="ts">
import { inject, ref, onMounted } from "vue";
import type { useWorkbench } from "../composables/useWorkbench";
import type { NamedLayout } from "../composables/useWorkbench";

type Bench = ReturnType<typeof useWorkbench>;
const bench = inject<Bench>("workbench")!;

const open = ref(false);
const name = ref("");
const layouts = ref<NamedLayout[]>([]);

async function refresh() {
  layouts.value = await bench.listNamedLayouts();
}
onMounted(refresh);

async function save() {
  if (!name.value.trim()) return;
  await bench.saveNamedLayout(name.value);
  name.value = "";
  await refresh();
}
async function load(id: number) {
  await bench.loadNamedLayout(id);
  open.value = false;
}
async function del(id: number) {
  await bench.deleteNamedLayout(id);
  await refresh();
}
function reset() {
  bench.resetLayout();
}
function fmt(ts: number) {
  return new Date(ts).toLocaleDateString();
}
</script>

<template>
  <div class="lm">
    <button class="lm-btn" :class="{ on: open }" @click="open = !open">布局</button>
    <template v-if="open">
      <div class="lm-mask" @click="open = false"></div>
      <div class="lm-panel" @click.stop>
        <div class="lm-title">布局管理</div>

        <div class="lm-save">
          <input
            v-model="name"
            class="lm-input"
            placeholder="命名当前布局，如：短线盯盘"
            maxlength="20"
            @keyup.enter="save"
          />
          <button class="lm-go" @click="save">保存</button>
        </div>

        <div class="lm-list">
          <div v-if="layouts.length === 0" class="lm-empty">还没有保存的布局</div>
          <div v-for="l in layouts" :key="l.id" class="lm-item">
            <div class="lm-info" @click="load(l.id)">
              <div class="lm-name">{{ l.name }}</div>
              <div class="lm-date">{{ fmt(l.updated_at) }}</div>
            </div>
            <button class="lm-del" title="删除" @click="del(l.id)">
              <svg viewBox="0 0 24 24" width="12" height="12">
                <path
                  fill="currentColor"
                  d="M18.3 5.71 12 12.01l-6.3-6.3-1.4 1.4 6.3 6.3-6.3 6.3 1.4 1.4 6.3-6.3 6.3 6.3 1.4-1.4-6.3-6.3 6.3-6.3z"
                />
              </svg>
            </button>
          </div>
        </div>

        <button class="lm-reset" @click="reset">恢复默认分区与顺序</button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.lm {
  position: relative;
}
.lm-btn {
  background: transparent;
  color: var(--text-dim);
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: 2px 9px;
  font-size: 12px;
  cursor: pointer;
}
.lm-btn:hover,
.lm-btn.on {
  color: var(--text);
  border-color: var(--text-dim);
}
.lm-mask {
  position: fixed;
  inset: 0;
  z-index: 40;
}
.lm-panel {
  position: absolute;
  top: 26px;
  right: 0;
  width: 248px;
  z-index: 50;
  background: #141a23;
  border: 1px solid #2a333f;
  border-radius: 10px;
  box-shadow: 0 12px 36px rgba(0, 0, 0, 0.5);
  padding: 12px;
}
.lm-title {
  font-size: 12px;
  font-weight: 700;
  color: #c9d1d9;
  margin-bottom: 10px;
}
.lm-save {
  display: flex;
  gap: 6px;
  margin-bottom: 10px;
}
.lm-input {
  flex: 1;
  min-width: 0;
  height: 28px;
  border-radius: 6px;
  border: 1px solid #2a333f;
  background: #0f141b;
  color: #e6edf3;
  padding: 0 9px;
  font-size: 12px;
}
.lm-input:focus {
  outline: none;
  border-color: #3d7bf5;
}
.lm-go {
  height: 28px;
  padding: 0 12px;
  border-radius: 6px;
  border: none;
  background: #2f6fed;
  color: #fff;
  font-size: 12px;
  cursor: pointer;
}
.lm-go:hover {
  background: #3d7bf5;
}
.lm-list {
  max-height: 200px;
  overflow-y: auto;
  margin-bottom: 10px;
}
.lm-empty {
  font-size: 12px;
  color: #6b7684;
  padding: 8px 0;
  text-align: center;
}
.lm-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 4px;
  border-radius: 6px;
}
.lm-item:hover {
  background: #1b232e;
}
.lm-info {
  flex: 1;
  min-width: 0;
  cursor: pointer;
}
.lm-name {
  font-size: 12px;
  color: #d7dee7;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.lm-date {
  font-size: 10px;
  color: #6b7684;
  margin-top: 1px;
}
.lm-del {
  border: none;
  background: transparent;
  color: #6b7684;
  cursor: pointer;
  display: flex;
  border-radius: 5px;
  padding: 3px;
}
.lm-del:hover {
  color: #f23645;
  background: rgba(242, 54, 69, 0.12);
}
.lm-reset {
  width: 100%;
  height: 28px;
  border-radius: 6px;
  border: 1px solid #2a333f;
  background: transparent;
  color: #aab4c0;
  font-size: 12px;
  cursor: pointer;
}
.lm-reset:hover {
  border-color: #4a5565;
  color: #e6edf3;
}
</style>
