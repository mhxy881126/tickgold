// 盘后三层复盘：市场 / 题材 / 个股。慢脑依据决策特征包生成结构化复盘并写入 ai_review，
// 结论字段结构化、同日幂等（force 可重跑），单篇失败不阻断其余。
use crate::ai::config::AiConfig;
use crate::ai::decision::build_pack;
use crate::ai::maindb::open_readwrite;
use crate::ai::now_millis;
use crate::ai::provider::{chat_stream, ChatMsg, StreamEv};
use serde_json::{json, Value};
use std::path::Path;

#[derive(serde::Serialize, Clone)]
pub struct ReviewSummary {
    pub id: i64,
    pub trade_date: String,
    pub scope: String,
    pub subject: String,
    pub title: String,
    pub summary: String,
    pub reused: bool,
}

const JSON_RULE: &str = "只输出一个 JSON 对象，不要 markdown 代码围栏、不要任何额外文字，字段：\n\
{\"title\":\"不超过20字标题\",\"summary\":\"一句话结论\",\"content\":\"markdown 正文，分点并引用特征中的真实数字\",\"evidence\":[{\"kind\":\"card\",\"card\":\"数据表名\"}]}";

fn sys_prompt(role_desc: &str) -> String {
    format!(
        "你是 A 股短线交易复盘助手。{role_desc}\n\
铁律：① 只能依据提供的决策特征包（本地采集的真实数据），严禁编造数字或代码；\
② 结论需对应特征数据；③ 不做涨跌预测、不构成投资建议。\n{JSON_RULE}"
    )
}

/// 调一次慢脑，累积全文并解析为结构化字段。
async fn generate_one(
    cfg: &AiConfig,
    api_key: &Option<String>,
    sys: &str,
    user: &str,
) -> Result<Value, String> {
    let mut acc = String::new();
    let msgs = vec![
        ChatMsg {
            role: "system".into(),
            content: sys.to_string(),
            tool_calls: None,
            tool_call_id: None,
        },
        ChatMsg {
            role: "user".into(),
            content: user.to_string(),
            tool_calls: None,
            tool_call_id: None,
        },
    ];
    chat_stream(cfg, api_key, &msgs, &[], &mut |ev| {
        if let StreamEv::Delta(d) = ev {
            acc.push_str(&d);
        }
    })
    .await?;
    Ok(parse_review_json(&acc))
}

/// 解析慢脑 JSON；容忍代码围栏/前后噪声；非 JSON 时降级为整段 markdown。
fn parse_review_json(raw: &str) -> Value {
    let trimmed = raw.trim();
    let body = match (trimmed.find('{'), trimmed.rfind('}')) {
        (Some(s), Some(e)) if e >= s => &trimmed[s..=e],
        _ => trimmed,
    };
    match serde_json::from_str::<Value>(body) {
        Ok(v) => json!({
            "title": v.get("title").and_then(|x| x.as_str()).unwrap_or(""),
            "summary": v.get("summary").and_then(|x| x.as_str()).unwrap_or(""),
            "content": v.get("content").and_then(|x| x.as_str()).unwrap_or(trimmed),
            "evidence": v.get("evidence").cloned().unwrap_or(json!([]))
        }),
        Err(_) => json!({
            "title": "",
            "summary": "",
            "content": trimmed,
            "evidence": json!([])
        }),
    }
}

/// 运行三层复盘。date=None 取最近交易日；force=true 重新生成已存在篇目。
pub async fn run_review(
    data_dir: &Path,
    cfg: &AiConfig,
    api_key: &Option<String>,
    date: Option<&str>,
    force: bool,
) -> Result<Vec<ReviewSummary>, String> {
    let pack = build_pack(data_dir, date)?;
    let date = pack["date"].as_str().unwrap_or_default().to_string();

    // 待生成清单：(scope, subject, focus_json)
    let mut jobs: Vec<(String, String, Value)> = vec![("market".into(), String::new(), pack.clone())];
    
    // 新增：交易复盘（对比当日计划 vs 实际交易）
    if pack["todayPlan"]["exists"].as_bool().unwrap_or(false) || pack["todayDecisionLogs"].as_array().map(|a| !a.is_empty()).unwrap_or(false) {
        jobs.push((
            "trade".into(),
            "当日交易复盘".into(),
            json!({
                "date": &date,
                "todayPlan": pack["todayPlan"],
                "todayDecisionLogs": pack["todayDecisionLogs"],
                "positions": pack["positions"],
                "market": pack["market"],
            }),
        ));
    }
    for t in pack["activeThemes"].as_array().cloned().unwrap_or_default().iter().take(5) {
        let name = t["name"].as_str().unwrap_or("").to_string();
        jobs.push((
            "theme".into(),
            name,
            json!({ "date": &date, "theme": t, "recentCatalysts": pack["recentCatalysts"] }),
        ));
    }
    // 个股：连板股 + 持仓并集去重，最多 8 只
    let mut codes: Vec<String> = vec![];
    for s in pack["multiBoardStocks"].as_array().cloned().unwrap_or_default() {
        codes.push(s["code"].as_str().unwrap_or("").to_string());
    }
    for s in pack["positions"].as_array().cloned().unwrap_or_default() {
        let c = s["code"].as_str().unwrap_or("").to_string();
        if !c.is_empty() && !codes.contains(&c) {
            codes.push(c);
        }
    }
    let multi = pack["multiBoardStocks"].as_array().cloned().unwrap_or_default();
    let posis = pack["positions"].as_array().cloned().unwrap_or_default();
    for code in codes.iter().take(8) {
        let mb = multi.iter().find(|s| s["code"].as_str() == Some(code.as_str())).cloned();
        let pos = posis.iter().find(|s| s["code"].as_str() == Some(code.as_str())).cloned();
        jobs.push((
            "stock".into(),
            code.clone(),
            json!({ "date": &date, "code": code, "limitUp": mb, "position": pos,
                "market": pack["market"] }),
        ));
    }

    let wdb = open_readwrite(data_dir)?;
    let mut out: Vec<ReviewSummary> = vec![];
    let mut market_failed = false;
    for (scope, subject, focus) in jobs {
        if let Some((id, title, summary)) = wdb
            .query_row(
                "SELECT id,title,summary FROM ai_review
                 WHERE trade_date=?1 AND scope=?2 AND subject=?3",
                rusqlite::params![date, scope, subject],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .ok()
        {
            if !force {
                out.push(ReviewSummary {
                    id,
                    trade_date: date.clone(),
                    scope: scope.clone(),
                    subject: subject.clone(),
                    title,
                    summary,
                    reused: true,
                });
                continue;
            }
        }
        let role_desc = match scope.as_str() {
            "market" => "复盘当日全市场情绪、指数、板块与涨停结构。".to_string(),
            "theme" => format!("聚焦题材「{subject}」的所处阶段、龙头梯队与催化。"),
            "trade" => "对比当日作战计划与实际交易，找出偏差，分析原因，给出改进建议。".to_string(),
            _ => format!("聚焦个股 {subject} 的涨停结构、资金与所处题材。"),
        };
        let user = serde_json::to_string(&focus).unwrap_or_default();
        match generate_one(cfg, api_key, &sys_prompt(&role_desc), &user).await {
            Ok(parsed) => {
                let title = parsed["title"].as_str().unwrap_or("").to_string();
                let summary = parsed["summary"].as_str().unwrap_or("").to_string();
                let content = parsed["content"].as_str().unwrap_or("").to_string();
                let evidence = parsed["evidence"].to_string();
                wdb.execute(
                    "INSERT INTO ai_review(trade_date,scope,subject,title,summary,content,evidence,model,created_at)
                     VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)
                     ON CONFLICT(trade_date,scope,subject) DO UPDATE SET
                        title=excluded.title, summary=excluded.summary, content=excluded.content,
                        evidence=excluded.evidence, model=excluded.model, created_at=excluded.created_at",
                    rusqlite::params![date, scope, subject, title, summary, content, evidence,
                        cfg.chat_model, now_millis()],
                )
                .map_err(|e| e.to_string())?;
                let id = wdb
                    .query_row(
                        "SELECT id FROM ai_review WHERE trade_date=?1 AND scope=?2 AND subject=?3",
                        rusqlite::params![date, scope, subject],
                        |r| r.get::<_, i64>(0),
                    )
                    .unwrap_or(wdb.last_insert_rowid());
                out.push(ReviewSummary {
                    id,
                    trade_date: date.clone(),
                    scope: scope.clone(),
                    subject: subject.clone(),
                    title,
                    summary,
                    reused: false,
                });
            }
            Err(e) => {
                if scope == "market" {
                    market_failed = true;
                }
                log::error!("复盘 {scope}/{subject} 失败: {e}");
            }
        }
    }
    if market_failed && out.is_empty() {
        return Err("市场复盘生成失败（请检查 AI 模型配置与网络后重试）".to_string());
    }
    Ok(out)
}

/// 列出某日全部复盘摘要。
pub fn list_reviews(data_dir: &Path, date: &str) -> Result<Vec<ReviewSummary>, String> {
    let c = open_readwrite(data_dir)?;
    let mut stmt = c
        .prepare(
            "SELECT id,trade_date,scope,subject,title,summary FROM ai_review
             WHERE trade_date=?1 ORDER BY CASE scope WHEN 'market' THEN 0
                WHEN 'theme' THEN 1 ELSE 2 END, id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([date], |r| {
            Ok(ReviewSummary {
                id: r.get(0)?,
                trade_date: r.get(1)?,
                scope: r.get(2)?,
                subject: r.get(3)?,
                title: r.get(4)?,
                summary: r.get(5)?,
                reused: false,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = vec![];
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/// 取单篇复盘全文（含 evidence/model）。
pub fn get_review(data_dir: &Path, id: i64) -> Result<Value, String> {
    let c = open_readwrite(data_dir)?;
    c.query_row(
        "SELECT id,trade_date,scope,subject,title,summary,content,evidence,model,created_at
         FROM ai_review WHERE id=?1",
        [id],
        |r| {
            Ok(json!({
                "id": r.get::<_, i64>(0)?,
                "tradeDate": r.get::<_, String>(1)?,
                "scope": r.get::<_, String>(2)?,
                "subject": r.get::<_, String>(3)?,
                "title": r.get::<_, String>(4)?,
                "summary": r.get::<_, String>(5)?,
                "content": r.get::<_, String>(6)?,
                "evidence": r.get::<_, String>(7)?,
                "model": r.get::<_, String>(8)?,
                "createdAt": r.get::<_, i64>(9)?,
            }))
        },
    )
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_plain_json() {
        let v = parse_review_json(r##"{"title":"市场缩量","summary":"情绪回落","content":"# 点一","evidence":[]}"##);
        assert_eq!(v["title"], "市场缩量");
        assert_eq!(v["summary"], "情绪回落");
        assert!(v["content"].as_str().unwrap().contains("点一"));
    }

    #[test]
    fn parse_tolerates_fence_and_noise() {
        let raw = "好的，结果如下：\n```json\n{\"title\":\"T\",\"summary\":\"S\",\"content\":\"C\"}\n```\n以上。";
        let v = parse_review_json(raw);
        assert_eq!(v["title"], "T");
        assert_eq!(v["content"], "C");
    }

    #[test]
    fn parse_degrades_to_markdown() {
        let v = parse_review_json("今日市场整体偏弱，涨停减少。");
        assert_eq!(v["title"], "");
        assert!(v["content"].as_str().unwrap().contains("偏弱"));
        assert_eq!(v["evidence"], json!([]));
    }

    #[test]
    fn upsert_is_idempotent_per_unique_key() {
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir()
            .join(format!("tickgold-review-sql-{}-{}", crate::ai::now_millis(), seq));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let c = rusqlite::Connection::open(dir.join("stock-dock.db")).unwrap();
        c.execute_batch(
            "CREATE TABLE ai_review(
                id INTEGER PRIMARY KEY AUTOINCREMENT, trade_date TEXT, scope TEXT,
                subject TEXT NOT NULL DEFAULT '', title TEXT DEFAULT '', summary TEXT DEFAULT '',
                content TEXT NOT NULL, evidence TEXT NOT NULL DEFAULT '[]', model TEXT DEFAULT '',
                tokens INTEGER DEFAULT 0, created_at INTEGER NOT NULL,
                UNIQUE(trade_date,scope,subject));",
        )
        .unwrap();
        let insert = |title: &str| {
            c.execute(
                "INSERT INTO ai_review(trade_date,scope,subject,title,content,created_at)
                 VALUES('2026-09-30','market','',?1,'x',0)
                 ON CONFLICT(trade_date,scope,subject) DO UPDATE SET title=excluded.title",
                [title],
            )
            .unwrap()
        };
        insert("初版");
        insert("重跑版");
        let count: i64 = c.query_row("SELECT count(*) FROM ai_review", [], |r| r.get(0)).unwrap();
        let title: String =
            c.query_row("SELECT title FROM ai_review", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 1, "同 UNIQUE 键必须只保留一行");
        assert_eq!(title, "重跑版");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
