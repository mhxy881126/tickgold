// 主题（配色）管理：应用到 <html data-theme>，选择持久化到 SQLite meta 表
import { ref } from "vue";
import { ensureDb, db } from "../db/database";

export type ThemeId = "obsidian" | "graphite" | "carbon" | "titanium";

export interface ThemeMeta {
  id: ThemeId;
  name: string;
  desc: string;
  sw: string[]; // 预览色块
}

const KEY = "app_theme";

export const THEMES: ThemeMeta[] = [
  {
    id: "obsidian",
    name: "曜石黑金",
    desc: "纯黑底 + 金色点缀，经典专业",
    sw: ["#05070b", "#d4af37", "#f23645", "#08c98a"],
  },
  {
    id: "graphite",
    name: "石墨护眼灰",
    desc: "中性深灰，柔和护眼",
    sw: ["#15181d", "#c9ced6", "#f0606d", "#22c99a"],
  },
  {
    id: "carbon",
    name: "碳纤维",
    desc: "纯黑冷硬 + 细微纹理，硬核",
    sw: ["#0a0a0c", "#d8d8e0", "#f6485a", "#16c98e"],
  },
  {
    id: "titanium",
    name: "深空钛金属",
    desc: "钛灰蓝金属质感，沉稳高级",
    sw: ["#0e1013", "#aeb8c4", "#f25868", "#1ec896"],
  },
];

const theme = ref<ThemeId>("carbon");

function apply(t: ThemeId) {
  document.documentElement.setAttribute("data-theme", t);
}

/** 启动时读取已保存的主题；无记录或 web 预览时使用默认碳纤维 */
async function load() {
  let t: ThemeId = "carbon";
  try {
    await ensureDb();
    const rows = await db().select<{ value: string }[]>(
      "SELECT value FROM meta WHERE key=?",
      [KEY]
    );
    const v = rows[0]?.value as ThemeId;
    if (v && THEMES.some((x) => x.id === v)) t = v;
  } catch {
    /* web 预览 / 数据库不可用：保持默认 */
  }
  theme.value = t;
  apply(t);
}

/** 切换主题并持久化 */
function setTheme(t: ThemeId) {
  theme.value = t;
  apply(t);
  try {
    db()
      .execute("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)", [KEY, t])
      .catch(() => {});
  } catch {
    /* ignore */
  }
}

export function useTheme() {
  return { theme, load, setTheme, THEMES };
}
