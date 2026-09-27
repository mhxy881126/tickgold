<template>
  <div class="tree-node">
    <div class="node-head">
      <div class="combo">
        <button
          class="combo-btn"
          :class="{ active: model.op === 'AND' }"
          @click="model.op = 'AND'"
        >且 AND</button>
        <button
          class="combo-btn"
          :class="{ active: model.op === 'OR' }"
          @click="model.op = 'OR'"
        >或 OR</button>
      </div>
      <button class="add-btn" @click="addLeaf">+ 条件</button>
      <button class="add-btn ghost" @click="addNode">+ 分组</button>
      <button v-if="!isRoot" class="del-node" title="删除分组" @click="$emit('remove')">×</button>
    </div>

    <div class="node-children">
      <template v-for="child in model.children" :key="child.id">
        <AlertTreeNode
          v-if="isNode(child)"
          :model="child"
          :is-root="false"
          @remove="removeChild(child.id)"
        />
        <AlertLeafRow
          v-else
          :model="child"
          @remove="removeChild(child.id)"
        />
      </template>
      <div v-if="model.children.length === 0" class="empty-hint">
        空分组，点击「+ 条件」添加
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { TreeNode, TreeItem, Leaf, Op } from "../../alert/types";
import { isNode, newId } from "../../alert/types";
import AlertLeafRow from "./AlertLeafRow.vue";

defineOptions({ name: "AlertTreeNode" });

const props = withDefaults(
  defineProps<{ model: TreeNode; isRoot?: boolean }>(),
  { isRoot: false }
);
defineEmits<{ remove: [] }>();

function makeLeaf(): Leaf {
  return { id: newId("l"), field: "price", op: ">=" as Op, value: 0 };
}
function makeNode(): TreeNode {
  return { id: newId("n"), op: "AND", children: [makeLeaf()] };
}

function addLeaf() {
  props.model.children.push(makeLeaf());
}
function addNode() {
  props.model.children.push(makeNode());
}
function removeChild(id: string) {
  props.model.children = props.model.children.filter(
    (c: TreeItem) => c.id !== id
  );
}
</script>

<style scoped>
.tree-node {
  border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
  border-radius: 8px;
  padding: 8px;
  background: var(--bg-elevated-soft, rgba(255, 255, 255, 0.03));
}
.node-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
}
.combo {
  display: inline-flex;
  border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
  border-radius: 6px;
  overflow: hidden;
}
.combo-btn {
  background: transparent;
  border: none;
  color: var(--text-dim, #9aa0a6);
  font-size: 11px;
  padding: 3px 10px;
  cursor: pointer;
}
.combo-btn.active {
  background: var(--accent, #d4af37);
  color: #1a1a1a;
}
.add-btn {
  background: transparent;
  border: 1px solid var(--border, rgba(255, 255, 255, 0.14));
  color: var(--text, #e8eaed);
  border-radius: 6px;
  font-size: 11px;
  padding: 3px 8px;
  cursor: pointer;
}
.add-btn.ghost { color: var(--text-dim, #9aa0a6); }
.del-node {
  margin-left: auto;
  background: transparent;
  border: none;
  color: var(--text-dim, #9aa0a6);
  font-size: 15px;
  cursor: pointer;
}
.del-node:hover { color: var(--down, #ef5350); }
.node-children {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-left: 10px;
  border-left: 2px solid var(--border, rgba(255, 255, 255, 0.1));
}
.empty-hint {
  font-size: 11px;
  color: var(--text-dim, #9aa0a6);
  padding: 4px 0;
}
</style>
