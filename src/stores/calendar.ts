import { defineStore } from "pinia";
import { ref } from "vue";
import { db, ensureDb } from "../db/database";

export interface CalEvent {
  id: number;
  date: string;
  time: string | null;   // HH:MM，null=全天
  title: string;
  type: string;          // macro/policy/ipo/restricted/earnings/other
  note: string;
  code: string | null;
  remind: number;        // 0/1
  done: number;          // 0/1
  createdAt: number;
}

interface ERow {
  id: number; date: string; time: string | null; title: string; type: string;
  note: string; code: string | null; remind: number; done: number; created_at: number;
}

const FIELDS = ["time", "title", "type", "note", "code", "remind", "done"] as const;

export const useCalendarStore = defineStore("calendar", () => {
  const events = ref<CalEvent[]>([]);
  const loaded = ref(false);

  async function load() {
    await ensureDb();
    const rows = await db().select<ERow[]>(
      `SELECT id, date, time, title, type, note, code, remind, done, created_at AS created_at
       FROM cal_event ORDER BY date ASC, time ASC, id ASC LIMIT 1500`
    );
    events.value = rows.map((r) => ({
      id: r.id, date: r.date, time: r.time, title: r.title, type: r.type,
      note: r.note, code: r.code, remind: r.remind, done: r.done, createdAt: r.created_at,
    }));
    loaded.value = true;
  }

  async function create(date: string): Promise<CalEvent> {
    const now = Date.now();
    const r = await db().execute(
      `INSERT INTO cal_event(date,time,title,type,note,code,remind,done,created_at)
       VALUES(?, NULL, '', 'other', '', NULL, 0, 0, ?)`,
      [date, now]
    );
    const id = Number(r.lastInsertId);
    const row = await db().select<ERow[]>(
      `SELECT id, date, time, title, type, note, code, remind, done, created_at AS created_at
       FROM cal_event WHERE id=?`, [id]
    );
    const e: CalEvent = {
      id: row[0].id, date: row[0].date, time: row[0].time, title: row[0].title,
      type: row[0].type, note: row[0].note, code: row[0].code,
      remind: row[0].remind, done: row[0].done, createdAt: row[0].created_at,
    };
    events.value = [...events.value, e];
    events.value.sort((a, b) =>
      a.date.localeCompare(b.date) || (a.time ?? "").localeCompare(b.time ?? ""));
    return e;
  }

  async function update(id: number, patch: Partial<Pick<CalEvent, (typeof FIELDS)[number]>>) {
    const keys = Object.keys(patch).filter((k) => (FIELDS as readonly string[]).includes(k));
    if (keys.length === 0) return;
    const setSql = keys.map((k) => `${k} = ?`).join(", ");
    const vals = keys.map((k) => (patch as Record<string, unknown>)[k] ?? null);
    await db().execute(`UPDATE cal_event SET ${setSql} WHERE id=?`, [...vals, id]);
    const e = events.value.find((x) => x.id === id);
    if (e) Object.assign(e, patch);
  }

  async function remove(id: number) {
    await db().execute("DELETE FROM cal_event WHERE id=?", [id]);
    events.value = events.value.filter((e) => e.id !== id);
  }

  function byDate(date: string): CalEvent[] {
    return events.value
      .filter((e) => e.date === date)
      .sort((a, b) => (a.time ?? "00:00").localeCompare(b.time ?? "00:00"));
  }

  return { events, loaded, load, create, update, remove, byDate };
});
