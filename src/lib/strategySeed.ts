// 策略 profile 内置三套（龙头 / 1进2 / 抄底），幂等 seed 到 strategy_profile。
// 版本化：编辑保存为新版本（旧版本 is_current=0），内置仅在缺失时插入，不覆盖用户改动。
import { db } from "../db/database";

export interface StrategySpec {
  marketRegime: string;
  entry: Record<string, number | string>;
  position: { initial: number; add: number; max: number };
  takeProfit: { rule: string; pct?: number };
  stopLoss: { rule: string; pct?: number };
  holdingPeriod: string;
  exclude: string[];
}

export interface BuiltinProfile {
  key: string;
  name: string;
  note: string;
  spec: StrategySpec;
}

export const BUILTIN_PROFILES: BuiltinProfile[] = [
  {
    key: "leader",
    name: "龙头战法",
    note: "情绪上升 / 题材主升期，做最强领涨龙头",
    spec: {
      marketRegime: "情绪上升期或题材主升，涨停家数扩张、连板高度打开",
      entry: {
        题材阶段: "发酵或高潮",
        角色: "龙一优先，龙二次之",
        竞价量比: 1.5,
        封板确认: "回封强度不弱于预期",
      },
      position: { initial: 30, add: 20, max: 50 },
      takeProfit: { rule: "断板或放量滞涨减仓，跌破 5 日线清仓", pct: 20 },
      stopLoss: { rule: "龙头地位丧失 / 题材退潮即走", pct: 7 },
      holdingPeriod: "1-5 日，主升持有至断板",
      exclude: ["ST", "无板块效应的独立涨停", "尾盘偷袭板"],
    },
  },
  {
    key: "promotion1to2",
    name: "1进2",
    note: "首板次日接力，博弈二板溢价",
    spec: {
      marketRegime: "情绪平稳偏强、无系统性退潮，二板成功率较高",
      entry: {
        首板质量: "早盘封板、封单强、未炸板",
        竞价: "高开 2%-6%，竞价金额放大",
        题材: "当日主流题材优先",
        竞价量比: 1.2,
      },
      position: { initial: 20, add: 10, max: 30 },
      takeProfit: { rule: "二板封死持有，次日不板冲高走", pct: 10 },
      stopLoss: { rule: "二板失败（翻绿 / 冲高回落）当日走", pct: 5 },
      holdingPeriod: "1-2 日",
      exclude: ["一字首板（无换手）", "尾盘板", "高位补跌首板"],
    },
  },
  {
    key: "bottomfishing",
    name: "超跌抄底",
    note: "恐慌末期 / 退潮尾声，博弈超跌反弹",
    spec: {
      marketRegime: "情绪冰点、连续杀跌后出现企稳信号（涨停回升 / 炸板率下降）",
      entry: {
        跌幅: "短期回撤 ≥30% 或连续缩量阴跌",
        企稳: "出现下影线 / 放量止跌",
        位置: "靠近重要支撑或前低",
      },
      position: { initial: 15, add: 15, max: 30 },
      takeProfit: { rule: "反弹至压力位 / 5-10 日线分批止盈", pct: 8 },
      stopLoss: { rule: "跌破抄底低点 / 前低无条件走", pct: 5 },
      holdingPeriod: "1-3 日，反弹不恋战",
      exclude: ["下跌趋势中继", "退市风险股", "无量阴跌未止跌"],
    },
  },
];

export interface ProfileRow {
  id: number;
  key: string;
  name: string;
  version: number;
  builtin: number;
  is_current: number;
  spec: string;
  note: string;
  parent_id: number | null;
  created_at: number;
  updated_at: number;
}

let seeded = false;

/** 幂等 seed 内置三套：仅在该 key 无内置当前版本时插入。 */
export async function seedStrategyProfiles(): Promise<void> {
  if (seeded) return;
  const database = db();
  for (const p of BUILTIN_PROFILES) {
    const rows = await database.select<{ id: number }[]>(
      "SELECT id FROM strategy_profile WHERE key=? AND builtin=1 AND is_current=1",
      [p.key]
    );
    if (rows.length === 0) {
      const now = Date.now();
      await database.execute(
        `INSERT INTO strategy_profile(key,name,version,builtin,is_current,spec,note,created_at,updated_at)
         VALUES(?,?,1,1,1,?,?,?,?)`,
        [p.key, p.name, JSON.stringify(p.spec), p.note, now, now]
      );
    }
  }
  seeded = true;
}

/** 列出全部 profile（含历史版本），按 key、版本倒序。 */
export async function listProfiles(): Promise<ProfileRow[]> {
  return db().select<ProfileRow[]>(
    `SELECT id,key,name,version,builtin,is_current,spec,note,parent_id,created_at,updated_at
     FROM strategy_profile ORDER BY key, version DESC`
  );
}

/** 保存编辑：旧版本 is_current=0，插入 version+1 新版本为当前。返回新 id。 */
export async function saveProfileVersion(input: {
  key: string;
  name: string;
  spec: StrategySpec;
  note?: string;
  builtin?: boolean;
  parentId?: number | null;
}): Promise<number> {
  const database = db();
  const latest = await database.select<{ version: number }[]>(
    "SELECT MAX(version) AS version FROM strategy_profile WHERE key=?",
    [input.key]
  );
  const nextVersion = (latest[0]?.version ?? 0) + 1;
  const now = Date.now();
  await database.execute(
    "UPDATE strategy_profile SET is_current=0 WHERE key=?",
    [input.key]
  );
  await database.execute(
    `INSERT INTO strategy_profile(key,name,version,builtin,is_current,spec,note,parent_id,created_at,updated_at)
     VALUES(?,?,?,?,1,?,?,?,?,?)`,
    [
      input.key,
      input.name,
      nextVersion,
      input.builtin ? 1 : 0,
      JSON.stringify(input.spec),
      input.note ?? "",
      input.parentId ?? null,
      now,
      now,
    ]
  );
  const row = await database.select<{ id: number }[]>(
    "SELECT id FROM strategy_profile WHERE key=? AND version=?",
    [input.key, nextVersion]
  );
  return row[0]?.id ?? 0;
}

/** 回滚 / 切换：把同 key 其余版本 is_current=0，指定版本置 1。 */
export async function setCurrentProfile(id: number, key: string): Promise<void> {
  const database = db();
  await database.execute(
    "UPDATE strategy_profile SET is_current=0 WHERE key=?",
    [key]
  );
  await database.execute(
    "UPDATE strategy_profile SET is_current=1 WHERE id=?",
    [id]
  );
}

/** 克隆：基于源行创建自定义 key 的 v1（builtin=0）。 */
export async function cloneProfile(source: ProfileRow, newName: string): Promise<string> {
  const spec = JSON.parse(source.spec) as StrategySpec;
  const keyBase = source.key;
  // 生成不冲突的自定义 key
  const existing = await db().select<{ key: string }[]>(
    "SELECT DISTINCT key FROM strategy_profile WHERE key LIKE ?",
    [`${keyBase}-copy%`]
  );
  let n = existing.length + 1;
  let key = `${keyBase}-copy${n}`;
  const keys = new Set(existing.map((r) => r.key));
  while (keys.has(key)) {
    n += 1;
    key = `${keyBase}-copy${n}`;
  }
  await saveProfileVersion({
    key,
    name: newName,
    spec,
    note: `克隆自 ${source.name} v${source.version}`,
    builtin: false,
    parentId: source.id,
  });
  return key;
}
