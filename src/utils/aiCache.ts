/**
 * AI 卡片本地缓存工具
 * 解决 AI 加载慢、易报错的问题：
 * 1. 每次成功获取都存 localStorage
 * 2. 打开卡片先展示缓存，后台静默刷新
 * 3. 失败时继续展示缓存 + 错误提示条
 */

const CACHE_PREFIX = "tickgold:ai:";
const CACHE_TTL = 30 * 60 * 1000; // 30 分钟内算新鲜，超过则后台刷新

export interface AiCacheItem<T> {
  data: T;
  timestamp: number;
}

/** 读取缓存 */
export function readAiCache<T>(key: string): AiCacheItem<T> | null {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key);
    if (!raw) return null;
    return JSON.parse(raw) as AiCacheItem<T>;
  } catch {
    return null;
  }
}

/** 写入缓存 */
export function writeAiCache<T>(key: string, data: T): void {
  try {
    const item: AiCacheItem<T> = { data, timestamp: Date.now() };
    localStorage.setItem(CACHE_PREFIX + key, JSON.stringify(item));
  } catch {
    /* localStorage 写入失败忽略 */
  }
}

/** 缓存是否新鲜（30分钟内） */
export function isCacheFresh(key: string): boolean {
  const cached = readAiCache(key);
  if (!cached) return false;
  return Date.now() - cached.timestamp < CACHE_TTL;
}

/** 格式化缓存时间 */
export function formatCacheTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60 * 1000) return "刚刚";
  if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + "分钟前";
  if (diff < 24 * 60 * 60 * 1000) return Math.floor(diff / 3600000) + "小时前";
  return new Date(ts).toLocaleDateString("zh-CN");
}
