// 作战计划：慢脑依据当日复盘 + 决策特征 + 策略 profile，生成下一交易日计划与分层指令
//（观察/候选/触发），用户可编辑批准，指令 alertRule 可一键转为预警。
use crate::ai::config::AiConfig;
use crate::ai::decision::build_pack;
use crate::ai::maindb::open_readwrite;
use crate::ai::now_millis;
use crate::ai::provider::{chat_stream, ChatMsg, StreamEv};
use serde_json::{json, Value};
use std::path::Path;

// ===== 交易日历（仅跳周末，节假日由用户在界面确认）=====
fn days_in_month(y: i32, m: i32) -> i32 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ => {
            if y % 4 == 0 && (y % 100 != 0 || y % 400 == 0) {
                29
            } else {
                28
            }
        }
    }
}

/// Sakamoto 星期：0=周日 … 6=周六。
fn weekday(y: i32, m: i32, d: i32) -> i32 {
    const T: [i32; 12] = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
    let y = y - if m < 3 { 1 } else { 0 };
    (y + y / 4 - y / 100 + y / 400 + T[(m - 1) as usize] + d).rem_euclid(7)
}

/// 下一交易日（跳过周六周日）。
fn next_trade_date(date: &str) -> String {
    let p: Vec<i32> = date.split('-').filter_map(|x| x.parse().ok()).collect();
    if p.len() != 3 {
        return date.to_string();
    }
    let (mut y, mut m, mut d) = (p[0], p[1], p[2]);
    for _ in 0..4 {
        d += 1;
        if d > days_in_month(y, m) {
            d = 1;
            m += 1;
            if m > 12 {
                m = 1;
                y += 1;
            }
        }
        if weekday(y, m, d) != 0 && weekday(y, m, d) != 6 {
            break;
        }
    }
    format!("{y:04}-{m:02}-{d:02}")
}

fn msg(role: &str, content: &str) -> ChatMsg {
    ChatMsg {
        role: role.into(),
        content: content.into(),
        tool_calls: None,
        tool_call_id: None,
    }
}

/// 从慢脑全文提取计划 JSON（容忍围栏/噪声），失败降级为空指令 + 原文观点。
fn extract_plan_json(raw: &str) -> Value {
    let t = raw.trim();
    let body = match (t.find('{'), t.rfind('}')) {
        (Some(s), Some(e)) if e >= s => &t[s..=e],
        _ => t,
    };
    serde_json::from_str(body).unwrap_or_else(|_| json!({"title":"", "marketView": t, "instructions": []}))
}

/// 当日复盘内容（市场/题材/个股）供计划引用。
fn review_contents(c: &rusqlite::Connection, date: &str) -> Result<Vec<Value>, String> {
    let mut stmt = c
        .prepare(
            "SELECT scope,subject,title,summary,content FROM ai_review WHERE trade_date=?1
             ORDER BY CASE scope WHEN 'market' THEN 0 WHEN 'theme' THEN 1 ELSE 2 END",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([date], |r| {
            Ok(json!({
                "scope": r.get::<_, String>(0)?,
                "subject": r.get::<_, String>(1)?,
                "title": r.get::<_, String>(2)?,
                "summary": r.get::<_, String>(3)?,
                "content": r.get::<_, String>(4)?
            }))
        })
        .map_err(|e| e.to_string())?;
    let mut out = vec![];
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/// 当前生效 profile（key 指定单个，否则全部 is_current=1）。
fn current_profiles(
    c: &rusqlite::Connection,
    profile_key: Option<&str>,
) -> Result<Vec<Value>, String> {
    let sql = "SELECT key,name,version,spec FROM strategy_profile WHERE is_current=1 \
        AND (?1 IS NULL OR key=?1)";
    let mut stmt = c.prepare(sanitize_profile_sql(sql)).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![profile_key], |r| {
            Ok(json!({
                "key": r.get::<_, String>(0)?,
                "name": r.get::<_, String>(1)?,
                "version": r.get::<_, i64>(2)?,
                "spec": serde_json::from_str::<Value>(&r.get::<_, String>(3)?).unwrap_or(json!({}))
            }))
        })
        .map_err(|e| e.to_string())?;
    let mut out = vec![];
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

// SQL 原样返回（占位，集中说明：?1 为命名绑定，无需改写）。
fn sanitize_profile_sql(sql: &str) -> &str {
    sql
}

/// 保存计划（plan_date 唯一）并重建其指令。
fn save_plan(
    c: &rusqlite::Connection,
    plan_date: &str,
    source_date: &str,
    profile_key: Option<&str>,
    cfg: &AiConfig,
    pj: &Value,
) -> Result<(), String> {
    let title = pj["title"].as_str().unwrap_or("");
    let market_view = pj["marketView"].as_str().unwrap_or("");
    let pk = profile_key.unwrap_or("");
    c.execute(
        "INSERT INTO plan(plan_date,title,market_view,status,profile_key,source_review_date,model,created_at,updated_at)
         VALUES(?1,?2,?3,'draft',?4,?5,?6,?7,?7)
         ON CONFLICT(plan_date) DO UPDATE SET title=excluded.title, market_view=excluded.market_view,
            profile_key=excluded.profile_key, source_review_date=excluded.source_review_date,
            model=excluded.model, updated_at=excluded.updated_at",
        rusqlite::params![plan_date, title, market_view, pk, source_date, cfg.chat_model, now_millis()],
    )
    .map_err(|e| e.to_string())?;
    let plan_id: i64 = c
        .query_row("SELECT id FROM plan WHERE plan_date=?1", [plan_date], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    // 指令全量重建（编辑旧计划时以最新生成结果为准）
    c.execute("DELETE FROM plan_instruction WHERE plan_id=?1", [plan_id])
        .map_err(|e| e.to_string())?;
    if let Some(arr) = pj["instructions"].as_array() {
        for (i, ins) in arr.iter().enumerate() {
            c.execute(
                "INSERT INTO plan_instruction(plan_id,tier,code,name,theme,condition,action,
                    position_hint,alert_rule,status,sort)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,'open',?10)",
                rusqlite::params![
                    plan_id,
                    ins["tier"].as_str().unwrap_or("watch"),
                    ins["code"].as_str().unwrap_or(""),
                    ins["name"].as_str().unwrap_or(""),
                    ins["theme"].as_str().unwrap_or(""),
                    ins["condition"].as_str().unwrap_or(""),
                    ins["action"].as_str().unwrap_or(""),
                    ins["positionHint"].as_str().unwrap_or(""),
                    ins["alertRule"].to_string(),
                    i as i64
                ],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// 生成下一交易日作战计划。review_date=None 取最近交易日。
pub async fn generate_plan(
    data_dir: &Path,
    cfg: &AiConfig,
    api_key: &Option<String>,
    profile_key: Option<&str>,
    review_date: Option<&str>,
) -> Result<Value, String> {
    let pack = build_pack(data_dir, review_date)?;
    let source_date = pack["date"].as_str().unwrap_or("").to_string();
    let plan_date = next_trade_date(&source_date);

    let c = open_readwrite(data_dir)?;
    let reviews = review_contents(&c, &source_date)?;
    let profiles = current_profiles(&c, profile_key)?;

    let sys = format!(
        "你是 A 股短线作战参谋。基于今日复盘与决策特征，为下一交易日（{plan_date}）生成作战计划。\
铁律：① 只依据提供的真实数据，严禁编造代码/数字；② 指令需具体、可执行、可转为价格或涨跌幅预警；\
③ 不做确定性预测、不构成投资建议。\
只输出一个 JSON：{{\"title\":\"计划标题\",\"marketView\":\"markdown 市场观点与情绪判断\",\
\"instructions\":[{{\"tier\":\"watch|candidate|trigger\",\"code\":\"代码\",\"name\":\"名称\",\"theme\":\"所属题材\",\
\"condition\":\"触发条件 markdown\",\"action\":\"操作建议\",\"positionHint\":\"仓位提示\",\
\"alertRule\":{{\"upPrice\":数字或null,\"downPrice\":数字或null,\"upPct\":数字或null,\"downPct\":数字或null,\"riseSpeed\":数字或null}}}}]}}。\
分层口径：watch=仅观察，candidate=备选待确认，trigger=满足条件即行动。"
    );
    let user = json!({
        "sourceDate": &source_date, "planDate": &plan_date,
        "decisionPack": pack, "reviews": reviews, "profiles": profiles
    })
    .to_string();

    let mut acc = String::new();
    let msgs = [msg("system", &sys), msg("user", &user)];
    chat_stream(cfg, api_key, &msgs, &[], &mut |ev| {
        if let StreamEv::Delta(d) = ev {
            acc.push_str(&d);
        }
    })
    .await?;
    let pj = extract_plan_json(&acc);
    save_plan(&c, &plan_date, &source_date, profile_key, cfg, &pj)?;
    let id: i64 = c
        .query_row("SELECT id FROM plan WHERE plan_date=?1", [&plan_date], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    plan_to_json(&c, id)
}

fn plan_to_json(c: &rusqlite::Connection, id: i64) -> Result<Value, String> {
    let base = c.query_row(
        "SELECT id,plan_date,title,market_view,status,profile_key,source_review_date,model,created_at,updated_at
         FROM plan WHERE id=?1", [id],
        |r| {
            Ok(json!({
                "id": r.get::<_, i64>(0)?,
                "planDate": r.get::<_, String>(1)?,
                "title": r.get::<_, String>(2)?,
                "marketView": r.get::<_, String>(3)?,
                "status": r.get::<_, String>(4)?,
                "profileKey": r.get::<_, String>(5)?,
                "sourceReviewDate": r.get::<_, String>(6)?,
                "model": r.get::<_, String>(7)?,
                "createdAt": r.get::<_, i64>(8)?,
                "updatedAt": r.get::<_, i64>(9)?
            }))
        },
    )
    .map_err(|e| e.to_string())?;
    let mut stmt = c
        .prepare(
            "SELECT id,tier,code,name,theme,condition,action,position_hint,alert_rule,status,sort
             FROM plan_instruction WHERE plan_id=?1 ORDER BY sort",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([id], |r| {
        Ok(json!({
            "id": r.get::<_, i64>(0)?,
            "tier": r.get::<_, String>(1)?,
            "code": r.get::<_, String>(2)?,
            "name": r.get::<_, String>(3)?,
            "theme": r.get::<_, String>(4)?,
            "condition": r.get::<_, String>(5)?,
            "action": r.get::<_, String>(6)?,
            "positionHint": r.get::<_, String>(7)?,
            "alertRule": r.get::<_, String>(8)?,
            "status": r.get::<_, String>(9)?,
            "sort": r.get::<_, i64>(10)?
        }))
    })
    .map_err(|e| e.to_string())?;
    let mut arr = vec![];
    for r in rows {
        arr.push(r.map_err(|e| e.to_string())?);
    }
    let mut v = base;
    v["instructions"] = json!(arr);
    Ok(v)
}

pub fn get_latest_plan(data_dir: &Path) -> Result<Value, String> {
    let c = open_readwrite(data_dir)?;
    let id = c
        .query_row("SELECT id FROM plan ORDER BY plan_date DESC LIMIT 1", [], |r| {
            r.get::<_, i64>(0)
        })
        .map_err(|_| "暂无作战计划，请先生成".to_string())?;
    plan_to_json(&c, id)
}

pub fn get_plan(data_dir: &Path, id: i64) -> Result<Value, String> {
    let c = open_readwrite(data_dir)?;
    plan_to_json(&c, id)
}

pub fn set_plan_status(data_dir: &Path, id: i64, status: &str) -> Result<(), String> {
    let c = open_readwrite(data_dir)?;
    c.execute(
        "UPDATE plan SET status=?1,updated_at=?2 WHERE id=?3",
        rusqlite::params![status, now_millis(), id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn update_plan_text(
    data_dir: &Path,
    id: i64,
    field: &str,
    value: &str,
) -> Result<(), String> {
    let col = match field {
        "title" => "title",
        "marketView" => "market_view",
        _ => return Err("计划仅支持编辑 title / marketView".to_string()),
    };
    let c = open_readwrite(data_dir)?;
    c.execute(
        &format!("UPDATE plan SET {col}=?1,updated_at=?2 WHERE id=?3"),
        rusqlite::params![value, now_millis(), id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn update_instruction(
    data_dir: &Path,
    instr_id: i64,
    field: &str,
    value: &str,
) -> Result<(), String> {
    let col = match field {
        "tier" => "tier",
        "name" => "name",
        "condition" => "condition",
        "action" => "action",
        "positionHint" => "position_hint",
        "status" => "status",
        _ => return Err("指令仅支持 tier/name/condition/action/positionHint/status".to_string()),
    };
    let c = open_readwrite(data_dir)?;
    c.execute(
        &format!("UPDATE plan_instruction SET {col}=?1 WHERE id=?2"),
        rusqlite::params![value, instr_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 指令 alertRule 映射为 alerts 行，返回新预警 id。
pub fn convert_instruction_to_alert(data_dir: &Path, instr_id: i64) -> Result<String, String> {
    let c = open_readwrite(data_dir)?;
    let (code, name, rule_json): (String, String, String) = c.query_row(
        "SELECT code,name,alert_rule FROM plan_instruction WHERE id=?1",
        [instr_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )
    .map_err(|e| e.to_string())?;
    let rule = serde_json::from_str::<Value>(&rule_json).unwrap_or(json!({}));
    let id = format!("plan-{}-{}", code, now_millis());
    c.execute(
        "INSERT INTO alerts(id,code,name,up_price,down_price,up_pct,down_pct,cooldown_sec,enabled,
            min_volume_ratio,rise_speed,speed_window_sec,down_speed,min_turnover,min_amount,
            seal_limit_up,seal_limit_down,broken_limit)
         VALUES(?1,?2,?3,?4,?5,?6,?7,300,1,?8,?9,?10,?11,?12,?13,?14,?15,?16)",
        rusqlite::params![
            id,
            code,
            name,
            rule["upPrice"].as_f64(),
            rule["downPrice"].as_f64(),
            rule["upPct"].as_f64(),
            rule["downPct"].as_f64(),
            rule["minVolumeRatio"].as_f64(),
            rule["riseSpeed"].as_f64(),
            rule["speedWindowSec"].as_i64(),
            rule["downSpeed"].as_f64(),
            rule["minTurnover"].as_f64(),
            rule["minAmount"].as_f64(),
            rule["sealLimitUp"].as_i64(),
            rule["sealLimitDown"].as_i64(),
            rule["brokenLimit"].as_i64()
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    const SCHEMA: &str = r#"
        CREATE TABLE plan(id INTEGER PRIMARY KEY AUTOINCREMENT,plan_date TEXT UNIQUE,title TEXT DEFAULT '',
            market_view TEXT DEFAULT '',status TEXT NOT NULL DEFAULT 'draft',profile_key TEXT DEFAULT '',
            source_review_date TEXT DEFAULT '',model TEXT DEFAULT '',created_at INTEGER,updated_at INTEGER);
        CREATE TABLE plan_instruction(id INTEGER PRIMARY KEY AUTOINCREMENT,plan_id INTEGER REFERENCES plan(id),
            tier TEXT NOT NULL DEFAULT 'watch',code TEXT DEFAULT '',name TEXT DEFAULT '',theme TEXT DEFAULT '',
            condition TEXT DEFAULT '',action TEXT DEFAULT '',position_hint TEXT DEFAULT '',
            alert_rule TEXT DEFAULT '{}',status TEXT NOT NULL DEFAULT 'open',sort INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE alerts(id TEXT PRIMARY KEY,code TEXT,name TEXT DEFAULT '',up_price REAL,down_price REAL,
            up_pct REAL,down_pct REAL,cooldown_sec INTEGER NOT NULL DEFAULT 300,enabled INTEGER NOT NULL DEFAULT 1,
            last_fired_at INTEGER,min_volume_ratio REAL,rise_speed REAL,speed_window_sec INTEGER,down_speed REAL,
            min_turnover REAL,min_amount REAL,seal_limit_up INTEGER,seal_limit_down INTEGER,broken_limit INTEGER);
        CREATE TABLE strategy_profile(id INTEGER PRIMARY KEY,key TEXT,name TEXT,version INTEGER,
            builtin INTEGER DEFAULT 0,is_current INTEGER DEFAULT 1,spec TEXT,note TEXT DEFAULT '',parent_id INTEGER,
            created_at INTEGER,updated_at INTEGER,UNIQUE(key,version));
    "#;

    fn fresh_db() -> (std::path::PathBuf, rusqlite::Connection) {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir()
            .join(format!("tickgold-plan-{}-{}", crate::ai::now_millis(), seq));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let c = rusqlite::Connection::open(dir.join("stock-dock.db")).unwrap();
        c.execute_batch(SCHEMA).unwrap();
        (dir, c)
    }

    #[test]
    fn next_trade_date_skips_weekend() {
        // 2026-10-02 是周五 → 下一交易日 10-05 周一
        assert_eq!(next_trade_date("2026-10-02"), "2026-10-05");
        // 2026-10-03 周六 → 10-05 周一
        assert_eq!(next_trade_date("2026-10-03"), "2026-10-05");
        // 2026-10-04 周日 → 10-05 周一
        assert_eq!(next_trade_date("2026-10-04"), "2026-10-05");
    }

    #[test]
    fn save_plan_rebuilds_instructions_and_stays_unique() {
        let (dir, c) = fresh_db();
        let cfg = AiConfig::default();
        let p1 = json!({"title":"T","marketView":"V","instructions":[
            {"tier":"watch","code":"300001","name":"甲"},
            {"tier":"trigger","code":"300002","name":"乙","alertRule":{"upPrice":10.5}}]});
        save_plan(&c, "2026-10-05", "2026-10-02", None, &cfg, &p1).unwrap();
        // 再次保存同一 plan_date（指令数量变化），plan 仍唯一、指令被重建
        let p2 = json!({"title":"T2","marketView":"V2","instructions":[
            {"tier":"candidate","code":"300003","name":"丙"}]});
        save_plan(&c, "2026-10-05", "2026-10-02", None, &cfg, &p2).unwrap();
        let plan_count: i64 =
            c.query_row("SELECT count(*) FROM plan", [], |r| r.get(0)).unwrap();
        let instr_count: i64 =
            c.query_row("SELECT count(*) FROM plan_instruction", [], |r| r.get(0)).unwrap();
        assert_eq!(plan_count, 1);
        assert_eq!(instr_count, 1, "旧指令应被删除后重建");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn convert_instruction_maps_alert_rule() {
        let (dir, c) = fresh_db();
        c.execute(
            "INSERT INTO plan(id,plan_date,created_at,updated_at) VALUES(1,'2026-10-05',0,0)",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO plan_instruction(id,plan_id,code,name,alert_rule)
             VALUES(7,1,'300001','甲','{\"upPrice\":10.5,\"upPct\":5,\"riseSpeed\":2}')",
            [],
        )
        .unwrap();
        let id = convert_instruction_to_alert(&dir, 7).unwrap();
        let (up_price, up_pct, rise): (f64, f64, f64) = c
            .query_row("SELECT up_price,up_pct,rise_speed FROM alerts WHERE id=?1", [&id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .unwrap();
        assert_eq!(up_price, 10.5);
        assert_eq!(up_pct, 5.0);
        assert_eq!(rise, 2.0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn extract_plan_json_tolerates_fence() {
        let raw = "```json\n{\"title\":\"P\",\"marketView\":\"M\",\"instructions\":[]}\n```";
        let v = extract_plan_json(raw);
        assert_eq!(v["title"], "P");
        assert_eq!(v["marketView"], "M");
    }
}
