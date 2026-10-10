// 新手模式（v2.24）：简化界面 + 操作提示，帮助新用户快速上手
// 状态持久化到 SQLite meta 表，开启时在 <html data-novice="true"> 上标记
import { ref } from "vue";
import { ensureDb, db } from "../db/database";
import { toast } from "./useToast";

const KEY = "novice_mode";
const novice = ref(false);

function apply(v: boolean) {
  if (v) document.documentElement.setAttribute("data-novice", "true");
  else document.documentElement.removeAttribute("data-novice");
}

async function load() {
  try {
    await ensureDb();
    const rows = await db().select<{ value: string }[]>(
      "SELECT value FROM meta WHERE key=?",
      [KEY]
    );
    novice.value = rows[0]?.value === "1";
    apply(novice.value);
  } catch {
    /* web 预览 / 数据库不可用 */
  }
}

function setNovice(v: boolean) {
  novice.value = v;
  apply(v);
  try {
    db()
      .execute("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)", [KEY, v ? "1" : "0"])
      .catch(() => {});
  } catch {
    /* ignore */
  }
  toast.success(v ? "新手模式已开启 · 界面将显示操作提示" : "新手模式已关闭");
}

function toggle() {
  setNovice(!novice.value);
}

export function useNovice() {
  return { novice, load, setNovice, toggle };
}
