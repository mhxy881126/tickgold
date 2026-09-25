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
/** 收盘写日级窗口 15:00-15:40 */
function isCloseWindow(d: Date) {
  if (!isWeekday(d)) return false;
  const hm = d.getHours() * 60 + d.getMinutes();
  return hm >= 15 * 60 && hm <= 15 * 60 + 40;
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

  // 板块日级
  const [ind, con] = await Promise.all([
    fetchSectors("industry"),
    fetchSectors("concept"),
  ]);
  const sectorPairs: [string, (typeof ind)[number]][] = [];
  ind.forEach((x) => sectorPairs.push(["industry", x]));
  con.forEach((x) => sectorPairs.push(["concept", x]));
  for (const [kind, s] of sectorPairs) {
    await db().execute(
      `INSERT OR REPLACE INTO ts_sector_day
       (day,kind,code,name,change_pct,net_amount,lead_code,lead_name,lead_pct)
       VALUES(?,?,?,?,?,?,?,?,?)`,
      [day, kind, s.code, s.name, s.changePct, s.netAmount, s.leadCode, s.leadName, s.leadPct]
    );
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
    } else if (isCloseWindow(d)) {
      await writeDaily(d);
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

  // 盘后启动：若处于收盘窗口，补写当日日级
  const d = new Date();
  if (isCloseWindow(d)) await writeDaily(d);

  await tick();
  timer = window.setInterval(tick, 30 * 1000);
}

onBeforeUnmount(() => {
  if (unlisten) unlisten();
  if (timer) clearInterval(timer);
});
