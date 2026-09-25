// 可访问性设置：界面缩放（zoom）与高对比模式
// 缩放应用到 <html style.zoom>（WebView2/Chromium 等比缩放所有 px）；
// 高对比应用到 <html data-hc="true">，由 global.css 覆盖变量。
// 选择持久化到 SQLite meta 表。
import { ref } from "vue";
import { ensureDb, db } from "../db/database";

export interface ZoomMeta {
  value: number;
  label: string;
}

// 界面缩放档位（紧凑 / 标准 / 大 / 特大）
export const ZOOM_LEVELS: ZoomMeta[] = [
  { value: 0.9, label: "紧凑" },
  { value: 1.0, label: "标准" },
  { value: 1.1, label: "大" },
  { value: 1.2, label: "特大" },
];

const ZKEY = "app_zoom";
const HKEY = "app_hc";

const zoom = ref<number>(1.0);
const highContrast = ref<boolean>(false);

function applyZoom(z: number) {
  // style.zoom 在 Chromium/WebView2 支持；TS 旧 lib 可能缺该属性，故用 as any
  (document.documentElement.style as unknown as { zoom: string }).zoom = String(z);
}

function applyHc(on: boolean) {
  if (on) document.documentElement.setAttribute("data-hc", "true");
  else document.documentElement.removeAttribute("data-hc");
}

function persist(key: string, value: string) {
  try {
    db()
      .execute("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)", [key, value])
      .catch(() => {});
  } catch {
    /* ignore */
  }
}

/** 启动时读取已保存的缩放 / 高对比设置 */
async function load() {
  let z = 1.0;
  let hc = false;
  try {
    await ensureDb();
    const rows = await db().select<{ key: string; value: string }[]>(
      "SELECT key,value FROM meta WHERE key IN (?,?)",
      [ZKEY, HKEY]
    );
    for (const r of rows) {
      if (r.key === ZKEY) {
        const n = parseFloat(r.value);
        if (ZOOM_LEVELS.some((x) => x.value === n)) z = n;
      } else if (r.key === HKEY) {
        hc = r.value === "1";
      }
    }
  } catch {
    /* web 预览 / 数据库不可用：保持默认 */
  }
  zoom.value = z;
  highContrast.value = hc;
  applyZoom(z);
  applyHc(hc);
}

/** 设置界面缩放并持久化 */
function setZoom(z: number) {
  zoom.value = z;
  applyZoom(z);
  persist(ZKEY, String(z));
}

/** 开关高对比模式并持久化 */
function setHighContrast(on: boolean) {
  highContrast.value = on;
  applyHc(on);
  persist(HKEY, on ? "1" : "0");
}

export function useAccessibility() {
  return { zoom, highContrast, load, setZoom, setHighContrast, ZOOM_LEVELS };
}
