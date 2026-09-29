// 卡片皮肤管理：skin 表读写 + 当前全局皮肤（meta app_skin）+ 场景映射（skin_scene_map）。
// 模块级 ref（同 useTheme 模式），启动 seed 内置鎏金皮肤并幂等。
import { ref, computed } from "vue";
import { ensureDb, db } from "../db/database";
import {
  parseSkinSpec,
  type SkinSpec,
} from "../lib/skin";
import { BUILTIN_SKINS } from "../lib/skin-presets";

const APP_KEY = "app_skin";
const SCENE_MAP_KEY = "skin_scene_map";

interface SkinRow {
  id: string;
  name: string;
  spec: string;
  builtin: number;
}

const skins = ref<SkinSpec[]>([]);
const appSkinId = ref<string | null>(null);
const sceneMap = ref<Record<string, string>>({});
let loaded = false;

const appSkin = computed<SkinSpec | null>(
  () => skins.value.find((s) => s.id === appSkinId.value) ?? null
);

async function getMeta(key: string): Promise<string | null> {
  const rows = await db().select<{ value: string }[]>(
    "SELECT value FROM meta WHERE key=?",
    [key]
  );
  return rows[0]?.value ?? null;
}
function setMeta(key: string, value: string) {
  db()
    .execute("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)", [key, value])
    .catch(() => {});
}

// 幂等 upsert 内置皮肤（builtin=1）
async function seedBuiltins(now: number) {
  for (const spec of BUILTIN_SKINS) {
    const body = JSON.stringify(spec);
    await db().execute(
      `INSERT INTO skin(id,name,spec,builtin,created_at,updated_at)
       VALUES(?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, spec=excluded.spec, builtin=1, updated_at=excluded.updated_at`,
      [spec.id, spec.name, body, 1, now, now]
    );
  }
}

async function readAll() {
  const rows = await db().select<SkinRow[]>("SELECT id,name,spec,builtin FROM skin ORDER BY builtin DESC, id");
  const list: SkinSpec[] = [];
  for (const r of rows) {
    try { list.push(parseSkinSpec(JSON.parse(r.spec))); }
    catch { /* 跳过损坏行 */ }
  }
  skins.value = list;
}

/** 启动：建表由 Rust 迁移保证；seed 内置 → 读取列表 → 恢复 app_skin / 场景映射 */
async function load() {
  if (loaded) return;
  try {
    await ensureDb();
    const now = Date.now();
    await seedBuiltins(now);
    await readAll();
    const app = await getMeta(APP_KEY);
    if (app && skins.value.some((s) => s.id === app)) appSkinId.value = app;
    else appSkinId.value = null; // 无 app_skin → 与现状等效
    const sm = await getMeta(SCENE_MAP_KEY);
    if (sm) {
      try {
        const obj = JSON.parse(sm);
        if (obj && typeof obj === "object") sceneMap.value = obj as Record<string, string>;
      } catch { /* ignore */ }
    }
    loaded = true;
  } catch (e) {
    console.error("[skins] load", e);
  }
}

/** 选择全局皮肤（null = 默认/无皮肤）*/
function select(id: string | null) {
  if (id && !skins.value.some((s) => s.id === id)) return;
  appSkinId.value = id;
  setMeta(APP_KEY, id ?? "");
}

/** 场景皮肤（id 为场景标识；传 null 清除）*/
function setSceneSkin(scene: string, id: string | null) {
  const next = { ...sceneMap.value };
  if (id) {
    if (!skins.value.some((s) => s.id === id)) return;
    next[scene] = id;
  } else {
    delete next[scene];
  }
  sceneMap.value = next;
  setMeta(SCENE_MAP_KEY, JSON.stringify(next));
}
function sceneSkinOf(scene: string): SkinSpec | null {
  const id = sceneMap.value[scene];
  if (!id) return null;
  return skins.value.find((s) => s.id === id) ?? null;
}

// 唯一 id（冲突加后缀）
function uniqueId(base: string): string {
  let id = base;
  let i = 2;
  while (skins.value.some((s) => s.id === id)) id = `${base}-${i++}`;
  return id;
}

/** 导入 spec JSON（已严格校验）；id 冲突自动加后缀。返回最终 id */
async function importSpec(input: unknown): Promise<string> {
  let spec = parseSkinSpec(input);
  if (skins.value.some((s) => s.id === spec.id)) {
    spec = { ...spec, id: uniqueId(spec.id) };
  }
  const now = Date.now();
  await db().execute(
    "INSERT INTO skin(id,name,spec,builtin,created_at,updated_at) VALUES(?,?,?,?,?,?)",
    [spec.id, spec.name, JSON.stringify(spec), 0, now, now]
  );
  await readAll();
  return spec.id;
}

/** 导出某皮肤 spec JSON 字符串 */
function exportSpec(id: string): string | null {
  const s = skins.value.find((x) => x.id === id);
  return s ? JSON.stringify(s, null, 2) : null;
}

/** 删除自定义皮肤（内置不可删）；若正被使用则清除引用 */
async function remove(id: string): Promise<boolean> {
  const s = skins.value.find((x) => x.id === id);
  if (!s) return false;
  if (BUILTIN_SKINS.some((b) => b.id === id)) return false;
  await db().execute("DELETE FROM skin WHERE id=?", [id]);
  if (appSkinId.value === id) select(null);
  let changed = false;
  const next = { ...sceneMap.value };
  for (const [k, v] of Object.entries(next)) {
    if (v === id) { delete next[k]; changed = true; }
  }
  if (changed) {
    sceneMap.value = next;
    setMeta(SCENE_MAP_KEY, JSON.stringify(next));
  }
  await readAll();
  return true;
}

export function useSkins() {
  return {
    skins,
    appSkinId,
    appSkin,
    sceneMap,
    load,
    select,
    setSceneSkin,
    sceneSkinOf,
    importSpec,
    exportSpec,
    remove,
  };
}
