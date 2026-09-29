<template>
  <div
    v-if="show"
    class="skeleton-block"
    :style="{ width: width, height: height, borderRadius: radius + 'px' }"
  ></div>
  <slot v-else />
</template>

<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from "vue";

// loading 持续超过 delay 才显示骨架，避免快速返回的数据造成闪烁。
const props = withDefaults(
  defineProps<{
    loading?: boolean;
    width?: string;
    height?: string;
    radius?: number;
    delay?: number;
  }>(),
  { loading: true, width: "100%", height: "16px", radius: 8, delay: 120 }
);

const show = ref(false);
let timer: ReturnType<typeof setTimeout> | null = null;

watch(
  () => props.loading,
  (loading) => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (loading) {
      timer = setTimeout(() => (show.value = true), props.delay);
    } else {
      show.value = false;
    }
  },
  { immediate: true }
);

onBeforeUnmount(() => {
  if (timer) clearTimeout(timer);
});
</script>
