// 决策特征包 decision-pack：聚合主库（情绪/指数/板块/题材/催化/涨停/持仓/自选），
// 产出快慢脑共用的统一结构化 JSON（约 12 个特征组、30-40 个指标）。
// 纯只读：复用 maindb 只读旁路，AI 永不写主库。
use crate::ai::maindb::open_readonly;
use rusqlite::Connection;
use serde_json::{json, Value};
use std::path::Path;

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

/// 最近交易日：优先日级情绪表 ts_day，回退涨停定格表。
fn latest_day(c: &Connection) -> Result<String, String> {
    if let Ok(d) =
        c.query_row("SELECT day FROM ts_day ORDER BY day DESC LIMIT 1", [], |r| {
            r.get::<_, String>(0)
        })
    {
        return Ok(d);
    }
    c.query_row(
        "SELECT trade_date FROM limit_up_record ORDER BY trade_date DESC LIMIT 1",
        [],
        |r| r.get::<_, String>(0),
    )
    .map_err(|_| {
        "本地暂无任何交易日数据（ts_day / limit_up_record 均空），请先完成收盘采集".to_string()
    })
}

/// 市场情绪：ts_day（盘后归档）为主，limit_up_record 聚合补封板资金/首板/连板计数。
fn market(c: &Connection, date: &str) -> Value {
    let ts: Option<Value> = c
        .query_row(
            "SELECT total,up_count,down_count,flat_count,limit_up,limit_down,broken,
                    broken_rate,max_boards,sentiment
             FROM ts_day WHERE day=?1",
            [date],
            |r| {
                Ok(json!({
                    "total": r.get::<_, Option<i64>>(0)?,
                    "upCount": r.get::<_, Option<i64>>(1)?,
                    "downCount": r.get::<_, Option<i64>>(2)?,
                    "flatCount": r.get::<_, Option<i64>>(3)?,
                    "limitUp": r.get::<_, Option<i64>>(4)?,
                    "limitDown": r.get::<_, Option<i64>>(5)?,
                    "broken": r.get::<_, Option<i64>>(6)?,
                    "brokenRate": r.get::<_, Option<f64>>(7)?,
                    "maxBoards": r.get::<_, Option<i64>>(8)?,
                    "sentiment": r.get::<_, Option<f64>>(9)?,
                }))
            },
        )
        .ok();
    // 涨停定格聚合：总数/炸板/最高板/均板/封板资金/首板数/连板数
    let agg: (i64, i64, i64, f64, f64, i64, i64) = c
        .query_row(
            "SELECT count(*),
                    COALESCE(sum(CASE WHEN broken>0 THEN 1 ELSE 0 END),0),
                    COALESCE(max(boards),0),
                    COALESCE(avg(boards),0),
                    COALESCE(sum(seal_fund),0),
                    COALESCE(sum(CASE WHEN boards=1 THEN 1 ELSE 0 END),0),
                    COALESCE(sum(CASE WHEN boards>=2 THEN 1 ELSE 0 END),0)
             FROM limit_up_record WHERE trade_date=?1",
            [date],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                ))
            },
        )
        .unwrap_or((0, 0, 0, 0.0, 0.0, 0, 0));
    let t = ts.as_ref();
    json!({
        "total": t.and_then(|v| v["total"].as_i64()),
        "upCount": t.and_then(|v| v["upCount"].as_i64()),
        "downCount": t.and_then(|v| v["downCount"].as_i64()),
        "flatCount": t.and_then(|v| v["flatCount"].as_i64()),
        "limitUp": t.and_then(|v| v["limitUp"].as_i64()).or(Some(agg.0)),
        "limitDown": t.and_then(|v| v["limitDown"].as_i64()),
        "broken": t.and_then(|v| v["broken"].as_i64()).or(Some(agg.1)),
        "brokenRate": t.and_then(|v| v["brokenRate"].as_f64()),
        "maxBoards": t.and_then(|v| v["maxBoards"].as_i64()).or(Some(agg.2)),
        "sentiment": t.and_then(|v| v["sentiment"].as_f64()),
        "sealFundTotal": agg.4,
        "avgBoards": round2(agg.3),
        "firstBoardCount": agg.5,
        "multiBoardCount": agg.6
    })
}

/// 近 5 日情绪序列（升序），用于情绪周期对比。
fn market_trend(c: &Connection) -> Result<Vec<Value>, String> {
    let mut stmt = c
        .prepare(
            "SELECT day,limit_up,broken,sentiment FROM ts_day
             ORDER BY day DESC LIMIT 5",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<i64>>(1)?,
                r.get::<_, Option<i64>>(2)?,
                r.get::<_, Option<f64>>(3)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut v: Vec<Value> = vec![];
    for r in rows {
        let (day, lu, br, se) = r.map_err(|e| e.to_string())?;
        v.push(json!({"day": day, "limitUp": lu, "broken": br, "sentiment": se}));
    }
    v.reverse();
    Ok(v)
}

/// 当日指数日级快照。
fn indices(c: &Connection, date: &str) -> Result<Vec<Value>, String> {
    let mut stmt = c
        .prepare(
            "SELECT code,name,price,pct,amount FROM ts_index_day WHERE day=?1",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([date], |r| {
        Ok(json!({
            "code": r.get::<_, String>(0)?,
            "name": r.get::<_, String>(1)?,
            "price": r.get::<_, Option<f64>>(2)?,
            "pct": r.get::<_, Option<f64>>(3)?,
            "amount": r.get::<_, Option<f64>>(4)?,
        }))
    })
    .map_err(|e| e.to_string())?;
    let mut out = vec![];
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/// 板块 top N：kind=None 时行业+概念合并；order 仅允许白名单列。
#[allow(clippy::needless_lifetimes)]
fn sector_top(
    c: &Connection,
    date: &str,
    kind: Option<&str>,
    order: &str,
    limit: i64,
) -> Result<Vec<Value>, String> {
    let order_col = match order {
        "change_pct" => "change_pct",
        "net_amount" => "net_amount",
        _ => return Err("sector_top order 仅支持 change_pct / net_amount".to_string()),
    };
    let mut sql = String::from(
        "SELECT code,name,change_pct,net_amount,lead_name,lead_pct
         FROM ts_sector_day WHERE day=?",
    );
    let mut params: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(date.to_string())];
    if let Some(k) = kind {
        sql.push_str(" AND kind=?");
        params.push(Box::new(k.to_string()));
    }
    sql.push_str(&format!(" ORDER BY {order_col} DESC LIMIT ?"));
    params.push(Box::new(limit));
    let mut stmt = c.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(params.iter()), |r| {
            Ok(json!({
                "code": r.get::<_, String>(0)?,
                "name": r.get::<_, String>(1)?,
                "changePct": r.get::<_, Option<f64>>(2)?,
                "netAmount": r.get::<_, Option<f64>>(3)?,
                "leadName": r.get::<_, Option<String>>(4)?,
                "leadPct": r.get::<_, Option<f64>>(5)?,
            }))
        })
        .map_err(|e| e.to_string())?;
    let mut out = vec![];
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/// 活跃题材（发酵/高潮）+ 龙头成分 + 最近催化剂。
fn themes(c: &Connection) -> Result<Vec<Value>, String> {
    let mut stmt = c
        .prepare(
            "SELECT id,name,level,stage FROM theme
             WHERE stage IN ('发酵','高潮')
             ORDER BY last_active_date DESC LIMIT 8",
        )
        .map_err(|e| e.to_string())?;
    let base: Vec<(i64, String, String, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    let mut out = vec![];
    for (id, name, level, stage) in base {
        let members: i64 = c
            .query_row(
                "SELECT count(*) FROM theme_stock
                 WHERE theme_id=?1 AND left_date IS NULL",
                [&id],
                |r| r.get(0),
            )
            .unwrap_or(0);
        let mut lstmt = c
            .prepare(
                "SELECT code,name,role FROM theme_stock
                 WHERE theme_id=?1 AND left_date IS NULL AND role IN ('龙一','龙二')
                 ORDER BY role_score DESC",
            )
            .map_err(|e| e.to_string())?;
        let leaders: Vec<Value> = lstmt
            .query_map([&id], |r| {
                Ok(json!({
                    "code": r.get::<_, String>(0)?,
                    "name": r.get::<_, String>(1)?,
                    "role": r.get::<_, String>(2)?,
                }))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        let recent: Option<String> = c
            .query_row(
                "SELECT title FROM catalyst WHERE theme_id=?1
                 ORDER BY collected_at DESC LIMIT 1",
                [&id],
                |r| r.get::<_, String>(0),
            )
            .ok();
        out.push(json!({
            "id": id, "name": name, "level": level, "stage": stage,
            "members": members, "leaders": leaders, "recentCatalyst": recent
        }));
    }
    Ok(out)
}

/// 最近 15 条催化剂（按发布/采集时间）。
fn catalysts(c: &Connection) -> Result<Vec<Value>, String> {
    let mut stmt = c
        .prepare(
            "SELECT c.kind,c.title,c.direction,c.code,t.name,
                    COALESCE(c.published_at,c.collected_at)
             FROM catalyst c LEFT JOIN theme t ON t.id=c.theme_id
             ORDER BY COALESCE(c.published_at,c.collected_at) DESC LIMIT 15",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| {
        Ok(json!({
            "kind": r.get::<_, String>(0)?,
            "title": r.get::<_, String>(1)?,
            "direction": r.get::<_, Option<String>>(2)?,
            "code": r.get::<_, Option<String>>(3)?,
            "theme": r.get::<_, Option<String>>(4)?,
            "ts": r.get::<_, Option<i64>>(5)?,
        }))
    })
    .map_err(|e| e.to_string())?;
    let mut out = vec![];
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/// 连板股（boards>=2）定格。
fn multiboard(c: &Connection, date: &str) -> Result<Vec<Value>, String> {
    let mut stmt = c
        .prepare(
            "SELECT code,name,boards,first_seal,seal_fund,broken,industry
             FROM limit_up_record
             WHERE trade_date=?1 AND boards>=2
             ORDER BY boards DESC, first_seal LIMIT 30",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([date], |r| {
        Ok(json!({
            "code": r.get::<_, String>(0)?,
            "name": r.get::<_, String>(1)?,
            "boards": r.get::<_, i64>(2)?,
            "firstSeal": r.get::<_, Option<i64>>(3)?,
            "sealFund": r.get::<_, Option<f64>>(4)?,
            "broken": r.get::<_, i64>(5)?,
            "industry": r.get::<_, Option<String>>(6)?,
        }))
    })
    .map_err(|e| e.to_string())?;
    let mut out = vec![];
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/// 当前模拟持仓。
fn positions(c: &Connection) -> Result<Vec<Value>, String> {
    let mut stmt = c
        .prepare(
            "SELECT code,name,vol,avail_vol,cost_amount
             FROM paper_position WHERE vol>0 ORDER BY code",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| {
        Ok(json!({
            "code": r.get::<_, String>(0)?,
            "name": r.get::<_, String>(1)?,
            "vol": r.get::<_, i64>(2)?,
            "availVol": r.get::<_, i64>(3)?,
            "costAmount": r.get::<_, f64>(4)?,
        }))
    })
    .map_err(|e| e.to_string())?;
    let mut out = vec![];
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

fn watch_count(c: &Connection) -> Result<i64, String> {
    c.query_row("SELECT count(*) FROM stocks", [], |r| r.get(0))
        .map_err(|e| e.to_string())
}

/// 构建决策特征包。date=None 取最近交易日。
pub fn build_pack(data_dir: &Path, date: Option<&str>) -> Result<Value, String> {
    let c = open_readonly(data_dir)?;
    let date = match date {
        Some(d) => d.to_string(),
        None => latest_day(&c)?,
    };
    
    // 读取当日作战计划
    let plan = read_today_plan(&c, &date).unwrap_or_default();
    
    // 读取当日决策日志
    let decision_logs = read_today_decision_logs(&c, &date).unwrap_or_default();
    
    Ok(json!({
        "date": date,
        "generatedAt": crate::ai::now_millis(),
        "market": market(&c, &date),
        "marketTrend": market_trend(&c).unwrap_or_default(),
        "indices": indices(&c, &date).unwrap_or_default(),
        "topIndustryUp": sector_top(&c, &date, Some("industry"), "change_pct", 10)?,
        "topConceptUp": sector_top(&c, &date, Some("concept"), "change_pct", 10)?,
        "topSectorFund": sector_top(&c, &date, None, "net_amount", 10)?,
        "activeThemes": themes(&c).unwrap_or_default(),
        "recentCatalysts": catalysts(&c).unwrap_or_default(),
        "multiBoardStocks": multiboard(&c, &date).unwrap_or_default(),
        "positions": positions(&c).unwrap_or_default(),
        "watchCount": watch_count(&c).unwrap_or(0),
        "todayPlan": plan,
        "todayDecisionLogs": decision_logs,
    }))
}

/// 读取当日作战计划
fn read_today_plan(c: &rusqlite::Connection, date: &str) -> Result<Value, String> {
    // 查 plan 表，找到当日的计划
    let plan_id: i64 = c.query_row(
        "SELECT id FROM plan WHERE plan_date=?1 LIMIT 1",
        [date],
        |r| r.get(0),
    ).unwrap_or(0);
    
    if plan_id == 0 {
        return Ok(json!({ "exists": false, "instructions": [] }));
    }
    
    // 读计划基本信息
    let (title, market_view): (String, String) = c.query_row(
        "SELECT title, market_view FROM plan WHERE id=?1",
        [plan_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    ).unwrap_or((String::new(), String::new()));
    
    // 读计划指令
    let mut stmt = c.prepare(
        "SELECT tier, code, name, condition, action FROM plan_instruction WHERE plan_id=?1 ORDER BY sort",
    ).map_err(|e| e.to_string())?;
    let instructions = stmt.query_map([plan_id], |r| {
        Ok(json!({
            "tier": r.get::<_, String>(0)?,
            "code": r.get::<_, String>(1)?,
            "name": r.get::<_, String>(2)?,
            "condition": r.get::<_, String>(3)?,
            "action": r.get::<_, String>(4)?,
        }))
    }).map_err(|e| e.to_string())?;
    
    let mut list = vec![];
    for ins in instructions {
        list.push(ins.map_err(|e| e.to_string())?);
    }
    
    Ok(json!({
        "exists": true,
        "title": title,
        "marketView": market_view,
        "instructions": list,
    }))
}

/// 读取当日决策日志
fn read_today_decision_logs(c: &rusqlite::Connection, date: &str) -> Result<Value, String> {
    let mut stmt = c.prepare(
        "SELECT code, name, label, confidence, mode, action, features FROM decision_log WHERE trade_date=?1 ORDER BY id DESC LIMIT 20",
    ).map_err(|e| e.to_string())?;
    let logs = stmt.query_map([date], |r| {
        Ok(json!({
            "code": r.get::<_, String>(0)?,
            "name": r.get::<_, String>(1)?,
            "label": r.get::<_, String>(2)?,
            "confidence": r.get::<_, f64>(3)?,
            "mode": r.get::<_, String>(4)?,
            "action": r.get::<_, String>(5)?,
            "features": r.get::<_, String>(6).unwrap_or_default(),
        }))
    }).map_err(|e| e.to_string())?;
    
    let mut list = vec![];
    for log in logs {
        list.push(log.map_err(|e| e.to_string())?);
    }
    
    Ok(json!(list))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    const SCHEMA: &str = r#"
        CREATE TABLE ts_day(day TEXT PRIMARY KEY,close_ts INTEGER,total INTEGER,up_count INTEGER,
            down_count INTEGER,flat_count INTEGER,limit_up INTEGER,limit_down INTEGER,broken INTEGER,
            broken_rate REAL,max_boards INTEGER,sentiment REAL);
        CREATE TABLE ts_index_day(day TEXT,code TEXT,name TEXT,price REAL,pct REAL,amount REAL,
            PRIMARY KEY(day,code));
        CREATE TABLE ts_sector_day(day TEXT,kind TEXT,code TEXT,name TEXT,change_pct REAL,net_amount REAL,
            lead_code TEXT,lead_name TEXT,lead_pct REAL,PRIMARY KEY(day,code));
        CREATE TABLE limit_up_record(trade_date TEXT,code TEXT,name TEXT DEFAULT '',boards INTEGER DEFAULT 1,
            first_seal INTEGER,last_seal INTEGER,seal_fund REAL DEFAULT 0,broken INTEGER DEFAULT 0,
            turnover REAL DEFAULT 0,industry TEXT DEFAULT '',concepts TEXT DEFAULT '');
        CREATE UNIQUE INDEX idx_lur ON limit_up_record(trade_date,code);
        CREATE TABLE theme(id INTEGER PRIMARY KEY,name TEXT UNIQUE,aliases TEXT DEFAULT '',level TEXT DEFAULT '分支',
            stage TEXT DEFAULT '萌芽',intro TEXT DEFAULT '',logic TEXT DEFAULT '',logic_version INTEGER DEFAULT 1,
            first_seen_date TEXT,last_active_date TEXT,created_at INTEGER,updated_at INTEGER);
        CREATE TABLE theme_stock(id INTEGER PRIMARY KEY,theme_id INTEGER,code TEXT,name TEXT DEFAULT '',
            role TEXT DEFAULT '跟风',role_score REAL DEFAULT 0,joined_date TEXT,left_date TEXT);
        CREATE TABLE catalyst(id INTEGER PRIMARY KEY,kind TEXT,title TEXT,summary TEXT DEFAULT '',source TEXT,
            source_url TEXT DEFAULT '',published_at INTEGER,direction TEXT DEFAULT '中性',theme_id INTEGER,code TEXT,
            fresh_score REAL DEFAULT 1,content_hash TEXT UNIQUE,collected_at INTEGER);
        CREATE TABLE paper_position(code TEXT PRIMARY KEY,name TEXT DEFAULT '',vol INTEGER DEFAULT 0,
            avail_vol INTEGER DEFAULT 0,cost_amount REAL DEFAULT 0,updated_at INTEGER);
        CREATE TABLE stocks(id INTEGER PRIMARY KEY,code TEXT UNIQUE,name TEXT DEFAULT '',group_id INTEGER,
            sort_order INTEGER,created_at INTEGER);
    "#;

    fn seeded() -> std::path::PathBuf {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir()
            .join(format!("tickgold-decision-{}-{}", crate::ai::now_millis(), seq));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let c = Connection::open(dir.join("stock-dock.db")).unwrap();
        c.execute_batch(SCHEMA).unwrap();
        c.execute(
            "INSERT INTO ts_day(day,total,up_count,down_count,flat_count,limit_up,limit_down,broken,
                broken_rate,max_boards,sentiment)
             VALUES('2026-09-30',5400,3000,2200,200,72,3,12,14.3,6,48.5)",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO limit_up_record(trade_date,code,name,boards,seal_fund,broken,industry)
             VALUES('2026-09-30','300001','甲',2,150000000,0,'机械'),
                   ('2026-09-30','300002','乙',1,50000000,1,'电子')",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO theme(name,stage,last_active_date,created_at,updated_at)
             VALUES('机器人','发酵','2026-09-30',0,0)",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO theme_stock(theme_id,code,name,role,role_score,joined_date)
             VALUES(1,'300001','甲','龙一',90,'2026-09-29')",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO catalyst(kind,title,source,theme_id,code,content_hash,collected_at)
             VALUES('order','甲公司签订大单','cninfo',1,'300001','ch1',1727600000000)",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO paper_position(code,name,vol,avail_vol,cost_amount,updated_at)
             VALUES('300001','甲',1000,1000,120000,0)",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO stocks(code,name,group_id,sort_order,created_at) VALUES('300001','甲',1,0,0)",
            [],
        )
        .unwrap();
        dir
    }

    #[test]
    fn pack_aggregates_all_groups() {
        let dir = seeded();
        let pack = build_pack(&dir, None).unwrap();
        // ts_day 为主
        assert_eq!(pack["market"]["limitUp"], 72);
        assert_eq!(pack["market"]["maxBoards"], 6);
        // limit_up_record 聚合：封板资金 1.5e8+5e7，连板 1 只，首板 1 只
        assert_eq!(pack["market"]["sealFundTotal"], 200_000_000.0);
        assert_eq!(pack["market"]["multiBoardCount"], 1);
        assert_eq!(pack["market"]["firstBoardCount"], 1);
        assert_eq!(pack["watchCount"], 1);
        assert_eq!(pack["activeThemes"][0]["name"], "机器人");
        assert_eq!(pack["activeThemes"][0]["leaders"][0]["role"], "龙一");
        assert_eq!(pack["positions"][0]["code"], "300001");
        assert_eq!(pack["recentCatalysts"][0]["title"], "甲公司签订大单");
    }

    #[test]
    fn pack_falls_back_when_no_ts_day() {
        let dir = seeded();
        // 一个既无 ts_day 也无定格的日期：聚合全为 0，不报错
        let pack = build_pack(&dir, Some("2026-09-29")).unwrap();
        assert_eq!(pack["market"]["limitUp"], 0);
        assert_eq!(pack["market"]["sealFundTotal"], 0.0);
    }

    #[test]
    fn latest_day_falls_back_to_limit_record() {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir()
            .join(format!("tickgold-decision-lb-{}-{}", crate::ai::now_millis(), seq));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let c = Connection::open(dir.join("stock-dock.db")).unwrap();
        c.execute_batch(
            "CREATE TABLE ts_day(day TEXT PRIMARY KEY);
             CREATE TABLE limit_up_record(trade_date TEXT,code TEXT);",
        )
        .unwrap();
        c.execute(
            "INSERT INTO limit_up_record(trade_date,code) VALUES('2026-09-29','300001')",
            [],
        )
        .unwrap();
        assert_eq!(latest_day(&c).unwrap(), "2026-09-29");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sector_top_rejects_unknown_order() {
        let dir = seeded();
        let c = open_readonly(&dir).unwrap();
        assert!(sector_top(&c, "2026-09-30", Some("industry"), "evil", 5).is_err());
    }
}
