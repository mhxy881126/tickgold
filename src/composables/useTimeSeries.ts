// 本地时序库采集引擎（v0.51）
// 盘中定时把「全市场情绪（涨停雷达）/ 指数 / 板块（行业·概念）」快照写入 SQLite：
//   - 分时：ts_market / ts_index 每分钟，ts_sector 每 5 分钟
//   - 收盘：ts_day / ts_index_day / ts_sector_day（日级长期保留，供情绪周期与题材轮动）
// 仅在交易时段、且雷达数据新鲜时写入，避免节假日 / 非交易时段写入重复陈旧数据。
import { onBeforeUnmount, reactive, ref } from "vue";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { db } from "../db/database";
import {
  fetchIndexQuotes,
  fetchSectors,
  snapshotSectorDay,
  startRadar,
  type RadarData,
} from "../api/market";

// 分时明细保留天数（日级表长期保留）
const INTRADAY_KEEP_DAYS = 60;

export const tsStatus = reactive({
  running: false,
  lastMarketTs: 0,
  lastIndexTs: 0,
  lastSectorTs: 0,
  lastDailyDay: "",
  todayDaily: false,
  marketRows: 0,
  indexRows: 0,
  sectorRows: 0,
  dayRows: 0,
  lastError: "",
  makeupPending: 0,
  makeupDone: 0,
  lastMakeupTs: 0,
});

let radar = ref<RadarData | null>(null);
let unlisten: UnlistenFn | null = null;
let timer = 0;
let lastMinuteKey = "";
let lastSectorKey = "";
let dailyDoneDay = "";

// ===== 日期 / 时段工具（本地时间，A股按北京时间）=====
function pad(n: number) {
  return String(n).padStart(2, "0");
}
function dayStr(d: Date) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function minuteFloor(d: Date) {
  return new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate(),
    d.getHours(),
    d.getMinutes(),
    0,
    0
  );
}
function isWeekday(d: Date) {
  const g = d.getDay();
  return g >= 1 && g <= 5;
}
/** 连续交易时段 9:30-11:30 / 13:00-15:00 */
function isTrading(d: Date) {
  if (!isWeekday(d)) return false;
  const hm = d.getHours() * 60 + d.getMinutes();
  return (hm >= 9 * 60 + 30 && hm <= 11 * 60 + 30) ||
    (hm >= 13 * 60 && hm <= 15 * 60);
}
/** 雷达数据是否新鲜（5 分钟内更新），用于过滤节假日陈旧数据 */
function radarFresh(r: RadarData | null) {
  return !!r && Date.now() - r.updated < 5 * 60 * 1000;
}

// ===== 分时写入 =====
async function writeMarket(d: Date) {
  const r = radar.value;
  if (!radarFresh(r) || !r) return;
  const ts = minuteFloor(d).getTime();
  await db().execute(
    `INSERT OR REPLACE INTO ts_market
     (day,ts,total,up_count,down_count,flat_count,limit_up,limit_down,broken,broken_rate,max_boards,sentiment)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      dayStr(d), ts, r.total, r.upCount, r.downCount, r.flatCount,
      r.limitUp, r.limitDown, r.broken, r.brokenRate, r.maxBoards, r.sentiment,
    ]
  );
  tsStatus.lastMarketTs = ts;
}

async function writeIndex(d: Date) {
  const list = await fetchIndexQuotes();
  if (!list.length) return;
  const ts = minuteFloor(d).getTime();
  const day = dayStr(d);
  for (const q of list) {
    await db().execute(
      `INSERT OR REPLACE INTO ts_index (day,ts,code,name,price,pct,amount)
       VALUES(?,?,?,?,?,?,?)`,
      [day, ts, q.code, q.name, q.price, q.pct, q.amount]
    );
  }
  tsStatus.lastIndexTs = ts;
}

async function writeSector(d: Date) {
  const ts = minuteFloor(d).getTime();
  const day = dayStr(d);
  const [ind, con] = await Promise.all([
    fetchSectors("industry"),
    fetchSectors("concept"),
  ]);
  const rows: [string, string, string, number, number, string, string, number][] = [];
  ind.forEach((s) =>
    rows.push(["industry", s.code, s.name, s.changePct, s.netAmount, s.leadCode, s.leadName, s.leadPct])
  );
  con.forEach((s) =>
    rows.push(["concept", s.code, s.name, s.changePct, s.netAmount, s.leadCode, s.leadName, s.leadPct])
  );
  for (const r of rows) {
    await db().execute(
      `INSERT OR REPLACE INTO ts_sector
       (day,ts,kind,code,name,change_pct,net_amount,lead_code,lead_name,lead_pct)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
      [day, ts, r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7]]
    );
  }
  tsStatus.lastSectorTs = ts;
}

// ===== 收盘日级写入（幂等）=====
async function writeDaily(d: Date) {
  const day = dayStr(d);
  if (dailyDoneDay === day) return;
  const exist = await db().select<{ c: number }[]>(
    "SELECT COUNT(*) AS c FROM ts_day WHERE day=?",
    [day]
  );
  if ((exist[0]?.c ?? 0) > 0) {
    dailyDoneDay = day;
    tsStatus.todayDaily = true;
    return;
  }
  const r = radar.value;
  if (!r) return;

  // 市场情绪日级
  await db().execute(
    `INSERT OR REPLACE INTO ts_day
     (day,close_ts,total,up_count,down_count,flat_count,limit_up,limit_down,broken,broken_rate,max_boards,sentiment)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      day, r.updated, r.total, r.upCount, r.downCount, r.flatCount,
      r.limitUp, r.limitDown, r.broken, r.brokenRate, r.maxBoards, r.sentiment,
    ]
  );

  // 指数日级
  const idx = await fetchIndexQuotes();
  for (const q of idx) {
    await db().execute(
      `INSERT OR REPLACE INTO ts_index_day (day,code,name,price,pct,amount)
       VALUES(?,?,?,?,?,?)`,
      [day, q.code, q.name, q.price, q.pct, q.amount]
    );
  }

  // 板块日级：v2.29 起走 Rust 东财快照（含成交额/换手/涨跌家数/涨停家数）
  // 字段比旧新浪口径更全；失败不阻断情绪/指数归档
  try {
    await snapshotSectorDay(day);
  } catch (e) {
    tsStatus.lastError = `板块快照:${String(e)}`;
  }

  dailyDoneDay = day;
  tsStatus.todayDaily = true;
  tsStatus.lastDailyDay = day;
}

/** 清理过期分时明细（日级保留） */
async function purgeOld() {
  const cutoff = new Date(Date.now() - INTRADAY_KEEP_DAYS * 86400000);
  const day = dayStr(cutoff);
  await db().execute("DELETE FROM ts_market WHERE day < ?", [day]);
  await db().execute("DELETE FROM ts_index WHERE day < ?", [day]);
  await db().execute("DELETE FROM ts_sector WHERE day < ?", [day]);
}

async function refreshCounts() {
  const f = async (sql: string) =>
    (await db().select<{ c: number }[]>(sql))[0]?.c ?? 0;
  tsStatus.marketRows = await f("SELECT COUNT(*) c FROM ts_market");
  tsStatus.indexRows = await f("SELECT COUNT(*) c FROM ts_index");
  tsStatus.sectorRows = await f("SELECT COUNT(*) c FROM ts_sector");
  tsStatus.dayRows = await f("SELECT COUNT(*) c FROM ts_day");

  // 回查最近一次采集时间，避免"有数据但显示尚未采集"的误导
  const lastTs = async (table: string, dayCol = "day") => {
    try {
      const rows = await db().select<{ last_ts: number | null }[]>(
        `SELECT MAX(ts) AS last_ts FROM ${table}`
      );
      return rows[0]?.last_ts ?? 0;
    } catch {
      return 0;
    }
  };
  if (!tsStatus.lastMarketTs) tsStatus.lastMarketTs = await lastTs("ts_market");
  if (!tsStatus.lastIndexTs) tsStatus.lastIndexTs = await lastTs("ts_index");
  if (!tsStatus.lastSectorTs) tsStatus.lastSectorTs = await lastTs("ts_sector");

  // 回查今日是否已收盘归档
  try {
    const today = dayStr(new Date());
    const rows = await db().select<{ c: number }[]>(
      "SELECT COUNT(*) AS c FROM ts_day WHERE day = ?",
      [today]
    );
    if ((rows[0]?.c ?? 0) > 0) {
      tsStatus.todayDaily = true;
      dailyDoneDay = today;
    }
  } catch { /* ignore */ }
}

/** 错过交易日补采：近 10 个自然日里的工作日，若 ts_sector_day 缺该日则补板块快照。
 *  情绪/指数分时无法事后还原，但板块日级（东财历史接口）可以补。每日最多跑一轮。 */
async function makeupMissingDays(now: Date) {
  const day0 = dayStr(now);
  if (makeupDoneDay === day0) return;
  try {
    const have = new Set(
      (await db().select<{ day: string }[]>("SELECT DISTINCT day FROM ts_sector_day"))
        .map((r) => r.day)
    );
    const missing: string[] = [];
    for (let back = 1; back <= 10; back++) {
      const d = new Date(now);
      d.setDate(now.getDate() - back);
      if (!isWeekday(d)) continue;
      const ds = dayStr(d);
      if (!have.has(ds)) missing.push(ds);
    }
    if (!missing.length) { makeupDoneDay = day0; return; }
    tsStatus.makeupPending = missing.length;
    tsStatus.makeupDone = 0;
    for (const ds of missing) {
      try {
        await snapshotSectorDay(ds);
      } catch (e) {
        tsStatus.lastError = `补采${ds}:${String(e)}`;
      }
      tsStatus.makeupDone += 1;
      tsStatus.lastMakeupTs = Date.now();
      await new Promise((r) => setTimeout(r, 1200));
    }
    makeupDoneDay = day0;
    await refreshCounts();
  } catch (e) {
    tsStatus.lastError = `补采扫描:${String(e)}`;
  }
}
let makeupDoneDay = "";

/** 收盘后（工作日 ≥15:00，含错过 15:40 窗口的场景）持续尝试日级归档，幂等 */
function isAfterClose(d: Date) {
  if (!isWeekday(d)) return false;
  return d.getHours() >= 15;
}

/** 主调度：30s 一次，按时间决定动作，幂等防重复 */
async function tick() {
  const d = new Date();
  try {
    if (isTrading(d)) {
      const mkey = `${dayStr(d)} ${d.getHours()}:${pad(d.getMinutes())}`;
      if (mkey !== lastMinuteKey) {
        lastMinuteKey = mkey;
        await writeMarket(d);
        await writeIndex(d);
      }
      // 每 5 分钟采板块
      const skey = `${dayStr(d)} ${Math.floor(d.getHours() * 60 + d.getMinutes()) / 5}`;
      if (skey !== lastSectorKey) {
        lastSectorKey = skey;
        await writeSector(d);
      }
    } else if (isAfterClose(d)) {
      // 收盘归档：不再限于 15:00-15:40，错过窗口 / 当日失败也会持续重试
      await writeDaily(d);
      // 16:00 后补采历史缺日（板块日级）
      if (d.getHours() >= 16) await makeupMissingDays(d);
    } else {
      // 周末 / 盘前：也允许补采
      await makeupMissingDays(d);
    }
    tsStatus.lastError = "";
  } catch (e) {
    tsStatus.lastError = String(e);
  }
}

/** 启动采集（App.vue 启动时调用一次，常驻后台） */
export async function startTimeSeries() {
  if (tsStatus.running) return;
  tsStatus.running = true;
  unlisten = await listen<RadarData>("radar:data", (e) => {
    radar.value = e.payload;
  });
  try {
    await startRadar(); // 幂等，确保有全市场情绪源
  } catch {
    /* ignore */
  }
  await purgeOld();
  await refreshCounts();

  // 盘后启动：收盘后任意时刻补写当日日级（writeDaily 幂等）
  const d = new Date();
  if (isAfterClose(d)) await writeDaily(d);

  await tick();
  timer = window.setInterval(tick, 30 * 1000);
}

onBeforeUnmount(() => {
  if (unlisten) unlisten();
  if (timer) clearInterval(timer);
});
