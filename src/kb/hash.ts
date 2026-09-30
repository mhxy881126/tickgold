// FNV-1a 32 位：稳定、零依赖，用于 catalyst.content_hash 去重。
export function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    // h * 16777619，用无符号右移保证 32 位
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
