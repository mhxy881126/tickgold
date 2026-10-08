import type { SignalKind } from "./sim";
/** 到达帧信号解析：map 中存在该 code（含显式 null）即以 map 为准，否则用建点时的 fallback */
export function resolveSignal(
  map: ReadonlyMap<string, SignalKind>,
  code: string | undefined,
  fallback: SignalKind,
): SignalKind {
  if (code === undefined) return fallback;
  return map.has(code) ? (map.get(code) as SignalKind) : fallback;
}
