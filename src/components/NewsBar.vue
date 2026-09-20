<script setup lang="ts">
defineProps<{ code: string | null }>();
</script>

<template>
  <div class="news">
    <div class="col">
      <h5>个股资讯</h5>
      <div class="todo">资讯接口 P4 接入</div>
    </div>
    <div class="col">
      <h5>公司公告</h5>
      <div class="todo">公告接口 P4 接入</div>
    </div>
    <div class="col">
      <h5>行业热点</h5>
      <div class="todo">热点接口 P4 接入</div>
    </div>
  </div>
</template>

<style scoped>
.news {
  background: var(--bg-panel); border-top: 1px solid var(--border);
  display: flex; height: 100%; overflow: hidden;
}
.col { flex: 1; padding: 6px 12px; overflow: hidden; }
h5 { font-size: 11px; color: var(--text-dim); font-weight: 500; margin-bottom: 4px; }
.todo { font-size: 11px; color: var(--text-dim); opacity: 0.6; }
</style>
