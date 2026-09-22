import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { db, ensureDb } from "../db/database";

export interface JournalEntry {
  id: number;
  date: string;
  title: string;
  content: string;
  mood: string | null;
  tags: string;   // 逗号分隔
  code: string | null;
  createdAt: number;
  updatedAt: number;
}

interface JRow {
  id: number; date: string; title: string; content: string; mood: string | null;
  tags: string; code: string | null; created_at: number; updated_at: number;
}

const FIELDS = ["title", "content", "mood", "tags", "code"] as const;

export const useJournalStore = defineStore("journal", () => {
  const entries = ref<JournalEntry[]>([]);
  const loaded = ref(false);

  async function load() {
    await ensureDb();
    const rows = await db().select<JRow[]>(
      `SELECT id, date, title, content, mood, tags, code, created_at AS created_at, updated_at AS updated_at
       FROM journal ORDER BY date DESC, id DESC LIMIT 1000`
    );
    entries.value = rows.map((r) => ({
      id: r.id, date: r.date, title: r.title, content: r.content, mood: r.mood,
      tags: r.tags, code: r.code, createdAt: r.created_at, updatedAt: r.updated_at,
    }));
    loaded.value = true;
  }

  async function create(date: string): Promise<JournalEntry> {
    const now = Date.now();
    const r = await db().execute(
      "INSERT INTO journal(date,title,content,mood,tags,code,created_at,updated_at) VALUES(?, '', '', NULL, '', NULL, ?, ?)",
      [date, now, now]
    );
    const id = Number(r.lastInsertId);
    const row = await db().select<JRow[]>(
      `SELECT id, date, title, content, mood, tags, code, created_at AS created_at, updated_at AS updated_at
       FROM journal WHERE id=?`, [id]
    );
    const e: JournalEntry = {
      id: row[0].id, date: row[0].date, title: row[0].title, content: row[0].content,
      mood: row[0].mood, tags: row[0].tags, code: row[0].code,
      createdAt: row[0].created_at, updatedAt: row[0].updated_at,
    };
    entries.value = [e, ...entries.value];
    return e;
  }

  // 局部更新（自动保存），patch 仅允许白名单字段
  async function update(id: number, patch: Partial<Pick<JournalEntry, (typeof FIELDS)[number]>>) {
    const keys = Object.keys(patch).filter((k) => (FIELDS as readonly string[]).includes(k));
    if (keys.length === 0) return;
    const setSql = keys.map((k) => `${k} = ?`).join(", ");
    const vals = keys.map((k) => (patch as Record<string, unknown>)[k] ?? null);
    await db().execute(
      `UPDATE journal SET ${setSql}, updated_at = ? WHERE id=?`,
      [...vals, Date.now(), id]
    );
    const e = entries.value.find((x) => x.id === id);
    if (e) Object.assign(e, patch, { updatedAt: Date.now() });
  }

  async function remove(id: number) {
    await db().execute("DELETE FROM journal WHERE id=?", [id]);
    entries.value = entries.value.filter((e) => e.id !== id);
  }

  // 某日的条目（id 升序）
  function byDate(date: string): JournalEntry[] {
    return entries.value.filter((e) => e.date === date).sort((a, b) => a.id - b.id);
  }
  // 日期 -> 条目数（日历标记）
  const dateCount = computed<Record<string, number>>(() => {
    const m: Record<string, number> = {};
    for (const e of entries.value) m[e.date] = (m[e.date] ?? 0) + 1;
    return m;
  });

  return { entries, loaded, load, create, update, remove, byDate, dateCount };
});
