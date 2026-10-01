// 只读工具注册表：8 个工具覆盖市场/题材/催化/个股/语义/持仓。
// 入参手工校验；输出 JSON 文本（喂给模型）+ FactRef（前端证据跳转）。
use crate::ai::maindb::open_readonly;
use crate::ai::provider::{Embedder, ToolSpec};
use crate::ai::vectordb::{self, AiDb};
use serde::Serialize;
use serde_json::json;
use std::future::Future;
use std::path::Path;
use std::pin::Pin;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FactRef {
    pub kind: String, // "card" | "url"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub card: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

impl FactRef {
    pub fn card(card: &str, code: Option<&str>, date: Option<&str>) -> Self {
        FactRef {
            kind: "card".into(),
            card: Some(card.into()),
            code: code.map(String::from),
            date: date.map(String::from),
            url: None,
            title: None,
        }
    }
    pub fn url(url: &str, title: &str) -> Self {
        FactRef {
            kind: "url".into(),
            card: None,
            code: None,
            date: None,
            url: Some(url.into()),
            title: Some(title.into()),
        }
    }
}

pub struct ToolOut {
    pub content: String,
    pub refs: Vec<FactRef>,
}

pub struct ToolCtx<'a> {
    pub data_dir: &'a Path,
    pub embedder: &'a dyn Embedder,
}

const MAX_OUT: usize = 4000;

fn truncate(mut s: String) -> String {
    if s.chars().count() > MAX_OUT {
        let keep: String = s.chars().take(MAX_OUT).collect();
        s = format!("{keep}\n……（结果已截断，请缩小查询条件）");
    }
    s
}

fn valid_code(s: &str) -> bool {
    s.len() == 6 && s.bytes().all(|b| b.is_ascii_digit())
}
fn valid_date(s: &str) -> bool {
    let mut parts = s.split('-');
    let (y, m, d) = match (parts.next(), parts.next(), parts.next(), parts.next()) {
        (Some(y), Some(m), Some(d), None) => (y, m, d),
        _ => return false,
    };
    y.len() == 4
        && m.len() == 2
        && d.len() == 2
        && y.chars().chain(m.chars()).chain(d.chars()).all(|c| c.is_ascii_digit())
}
fn arg_str(v: &serde_json::Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(|x| x.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}
fn arg_i64(v: &serde_json::Value, key: &str, d: i64) -> i64 {
    v.get(key).and_then(|x| x.as_i64()).unwrap_or(d)
}

pub fn specs() -> Vec<ToolSpec> {
    vec![
        ToolSpec {
            name: "market_overview".into(),
            description: "查询某交易日（默认最近有数据的交易日）的市场情绪概览：涨停数、炸板数、最高连板、平均连板、首板晋级率。无参数则取最近交易日。".into(),
            parameters: json!({
                "type":"object",
                "properties":{"date":{"type":"string","description":"YYYY-MM-DD"}},
                "additionalProperties":false
            }),
        },
        ToolSpec {
            name: "list_themes".into(),
            description: "列出题材库题材（阶段、级别、活跃日期、在册成分数）。可按生命周期阶段过滤与关键词搜索。".into(),
            parameters: json!({
                "type":"object",
                "properties":{
                    "stage":{"type":"string","enum":["萌芽","发酵","高潮","退潮"]},
                    "q":{"type":"string","description":"题材名关键词"},
                    "limit":{"type":"integer","minimum":1,"maximum":50}
                },
                "additionalProperties":false
            }),
        },
        ToolSpec {
            name: "theme_detail".into(),
            description: "按题材 id 或名称查询题材详情：在册成分股及其龙头角色、最近催化剂。".into(),
            parameters: json!({
                "type":"object",
                "properties":{"themeId":{"type":"integer"},"name":{"type":"string"}},
                "additionalProperties":false
            }),
        },
        ToolSpec {
            name: "query_catalysts".into(),
            description: "查询催化剂：公告/互动易问答：可按股票代码、题材名、关键词、类型、日期区间过滤。".into(),
            parameters: json!({
                "type":"object",
                "properties":{
                    "code":{"type":"string","description":"6 位股票代码"},
                    "theme":{"type":"string"},
                    "keyword":{"type":"string"},
                    "kind":{"type":"string","enum":["policy","industry","company","order","earnings","price","event"]},
                    "from":{"type":"string","description":"YYYY-MM-DD"},
                    "to":{"type":"string","description":"YYYY-MM-DD"},
                    "limit":{"type":"integer","minimum":1,"maximum":30}
                },
                "additionalProperties":false
            }),
        },
        ToolSpec {
            name: "stock_profile".into(),
            description: "查询单只个股的题材档案：行业/概念、在题材中的角色、近期涨停定格、最近催化剂时间线。".into(),
            parameters: json!({
                "type":"object",
                "required":["code"],
                "properties":{"code":{"type":"string","description":"6 位股票代码"}},
                "additionalProperties":false
            }),
        },
        ToolSpec {
            name: "list_limit_ups".into(),
            description: "查询涨停定格记录：可按日期（默认最近交易日）、最低连板数、股票代码过滤。".into(),
            parameters: json!({
                "type":"object",
                "properties":{
                    "date":{"type":"string","description":"YYYY-MM-DD"},
                    "minBoards":{"type":"integer","minimum":1},
                    "code":{"type":"string"},
                    "limit":{"type":"integer","minimum":1,"maximum":50}
                },
                "additionalProperties":false
            }),
        },
        ToolSpec {
            name: "semantic_search".into(),
            description: "在本地知识库（战法文档、催化剂、互动问答、题材资料）中做语义检索，返回最相关的 k 段原文。需要已配置可用的嵌入模型。".into(),
            parameters: json!({
                "type":"object",
                "required":["query"],
                "properties":{
                    "query":{"type":"string"},
                    "topK":{"type":"integer","minimum":1,"maximum":10},
                    "sourceType":{"type":"string","enum":["manual_doc","catalyst","irm","theme","limitup"]}
                },
                "additionalProperties":false
            }),
        },
        ToolSpec {
            name: "paper_positions".into(),
            description: "查询当前模拟盘持仓（代码、名称、持仓量、可用量、成本金额）。无参数。".into(),
            parameters: json!({"type":"object","properties":{},"additionalProperties":false}),
        },
    ]
}

fn latest_date(c: &rusqlite::Connection) -> Result<String, String> {
    c.query_row(
        "SELECT trade_date FROM limit_up_record ORDER BY trade_date DESC LIMIT 1",
        [],
        |r| r.get::<_, String>(0),
    )
    .map_err(|_| "暂无涨停定格数据（可能尚未完成过收盘归因）".to_string())
}

fn market_overview(c: &rusqlite::Connection, args: &serde_json::Value) -> Result<ToolOut, String> {
    let date = arg_str(args, "date").unwrap_or_else(|| latest_date(c).unwrap_or_default());
    if date.is_empty() {
        return Ok(ToolOut {
            content: "暂无涨停定格数据".into(),
            refs: vec![],
        });
    }
    if !valid_date(&date) {
        return Err("date 必须为 YYYY-MM-DD".into());
    }
    let total: i64 = c
        .query_row(
            "SELECT count(*) FROM limit_up_record WHERE trade_date=?1",
            [&date],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let broken: i64 = c
        .query_row(
            "SELECT count(*) FROM limit_up_record WHERE trade_date=?1 AND broken>0",
            [&date],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let max_boards: i64 = c
        .query_row(
            "SELECT COALESCE(max(boards),0) FROM limit_up_record WHERE trade_date=?1",
            [&date],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let avg_boards: f64 = c
        .query_row(
            "SELECT COALESCE(avg(boards),0) FROM limit_up_record WHERE trade_date=?1",
            [&date],
            |r| r.get(0),
        )
        .unwrap_or(0.0);
    // 晋级率：今日 boards=2 且昨日 boards=1 的数量 / 昨日首板数量
    let prev: Option<String> = c
        .query_row(
            "SELECT trade_date FROM limit_up_record WHERE trade_date<?1 GROUP BY trade_date ORDER BY trade_date DESC LIMIT 1",
            [&date],
            |r| r.get(0),
        )
        .ok();
    let promotion = if let Some(pd) = prev {
        let y_first: i64 = c
            .query_row(
                "SELECT count(*) FROM limit_up_record WHERE trade_date=?1 AND boards=1",
                [&pd],
                |r| r.get(0),
            )
            .unwrap_or(0);
        let promoted: i64 = c
            .query_row(
                "SELECT count(*) FROM limit_up_record t JOIN limit_up_record y
                 ON y.code=t.code AND y.trade_date=?1
                 WHERE t.trade_date=?2 AND t.boards=2 AND y.boards=1",
                rusqlite::params![pd, date],
                |r| r.get(0),
            )
            .unwrap_or(0);
        if y_first > 0 {
            Some(promoted as f64 / y_first as f64)
        } else {
            None
        }
    } else {
        None
    };
    let content = serde_json::to_string_pretty(&json!({
        "date": date,
        "limitUpCount": total,
        "brokenCount": broken,
        "maxBoards": max_boards,
        "avgBoards": ((avg_boards * 100.0).round() / 100.0),
        "firstBoardPromotionRate": promotion.map(|p| (p * 1000.0).round() / 10.0),
        "note": "firstBoardPromotionRate 为百分比；null=缺少前一交易日数据"
    }))
    .map_err(|e| e.to_string())?;
    Ok(ToolOut {
        content,
        refs: vec![FactRef::card("limitpool", None, Some(&date))],
    })
}

fn list_themes(c: &rusqlite::Connection, args: &serde_json::Value) -> Result<ToolOut, String> {
    let stage = arg_str(args, "stage");
    let q = arg_str(args, "q");
    let limit = arg_i64(args, "limit", 20).clamp(1, 50);
    let mut sql = String::from(
        "SELECT t.id,t.name,t.level,t.stage,t.last_active_date,
                (SELECT count(*) FROM theme_stock ts WHERE ts.theme_id=t.id AND ts.left_date IS NULL) AS members
         FROM theme t WHERE 1=1",
    );
    // 动态位置参数：只绑定实际出现的占位符（多余命名参数会被 rusqlite 拒绝）
    let mut params: Vec<Box<dyn rusqlite::ToSql>> = vec![];
    if let Some(s) = &stage {
        sql.push_str(" AND t.stage=?");
        params.push(Box::new(s.clone()));
    }
    if let Some(s) = &q {
        sql.push_str(" AND (t.name LIKE ? OR t.aliases LIKE ?)");
        let like = format!("%{s}%");
        params.push(Box::new(like.clone()));
        params.push(Box::new(like));
    }
    sql.push_str(" ORDER BY members DESC, t.last_active_date DESC LIMIT ?");
    params.push(Box::new(limit));
    let mut stmt = c.prepare(&sql).map_err(|e| e.to_string())?;
    let mut rows = stmt
        .query_map(rusqlite::params_from_iter(params.iter()), |r| {
            Ok(json!({
                "themeId": r.get::<_,i64>(0)?,
                "name": r.get::<_,String>(1)?,
                "level": r.get::<_,String>(2)?,
                "stage": r.get::<_,String>(3)?,
                "lastActiveDate": r.get::<_,Option<String>>(4)?,
                "memberCount": r.get::<_,i64>(5)?,
            }))
        })
        .map_err(|e| e.to_string())?;
    let mut items = vec![];
    while let Some(r) = rows.next() {
        items.push(r.map_err(|e| e.to_string())?);
    }
    Ok(ToolOut {
        content: truncate(
            serde_json::to_string_pretty(&json!({"themes": items})).unwrap(),
        ),
        refs: vec![FactRef::card("themelib", None, None)],
    })
}

fn theme_detail(c: &rusqlite::Connection, args: &serde_json::Value) -> Result<ToolOut, String> {
    let id = args.get("themeId").and_then(|x| x.as_i64());
    let name = arg_str(args, "name");
    if id.is_none() && name.is_none() {
        return Err("theme_detail 需要 themeId 或 name".into());
    }
    let theme: Option<(i64, String, String, String, String)> = c
        .query_row(
            "SELECT id,name,level,stage,intro FROM theme WHERE id=?1 OR name=?2",
            rusqlite::params![id.unwrap_or(-1), name.unwrap_or_default()],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .ok();
    let Some((tid, tname, level, stage, intro)) = theme else {
        return Ok(ToolOut {
            content: json!({"found":false}).to_string(),
            refs: vec![],
        });
    };
    let mut members = vec![];
    {
        let mut stmt = c
            .prepare(
                "SELECT code,name,role,role_score FROM theme_stock
                 WHERE theme_id=?1 AND left_date IS NULL ORDER BY role_score DESC",
            )
            .map_err(|e| e.to_string())?;
        let mut rs = stmt
            .query_map(rusqlite::params![tid], |r| {
                Ok(json!({
                    "code": r.get::<_,String>(0)?, "name": r.get::<_,String>(1)?,
                    "role": r.get::<_,String>(2)?, "roleScore": r.get::<_,f64>(3)?,
                }))
            })
            .map_err(|e| e.to_string())?;
        while let Some(r) = rs.next() {
            members.push(r.map_err(|e| e.to_string())?);
        }
    }
    let mut catalysts = vec![];
    {
        let mut stmt = c
            .prepare(
                "SELECT kind,title,direction,published_at FROM catalyst
                 WHERE theme_id=?1 ORDER BY COALESCE(published_at,collected_at) DESC LIMIT 10",
            )
            .map_err(|e| e.to_string())?;
        let mut rs = stmt
            .query_map(rusqlite::params![tid], |r| {
                Ok(json!({
                    "kind": r.get::<_,String>(0)?, "title": r.get::<_,String>(1)?,
                    "direction": r.get::<_,String>(2)?, "publishedAt": r.get::<_,Option<i64>>(3)?,
                }))
            })
            .map_err(|e| e.to_string())?;
        while let Some(r) = rs.next() {
            catalysts.push(r.map_err(|e| e.to_string())?);
        }
    }
    Ok(ToolOut {
        content: truncate(
            serde_json::to_string_pretty(&json!({
                "found": true, "themeId": tid, "name": tname,
                "level": level, "stage": stage, "intro": intro,
                "members": members, "recentCatalysts": catalysts
            }))
            .unwrap(),
        ),
        refs: vec![FactRef::card("themelib", None, None)],
    })
}

fn query_catalysts(c: &rusqlite::Connection, args: &serde_json::Value) -> Result<ToolOut, String> {
    let code = arg_str(args, "code");
    if let Some(cd) = &code {
        if !valid_code(cd) {
            return Err("code 必须为 6 位数字".into());
        }
    }
    for k in ["from", "to"] {
        if let Some(d) = arg_str(args, k) {
            if !valid_date(&d) {
                return Err(format!("{k} 必须为 YYYY-MM-DD"));
            }
        }
    }
    let theme = arg_str(args, "theme");
    let keyword = arg_str(args, "keyword");
    let kind = arg_str(args, "kind");
    let from = arg_str(args, "from");
    let to = arg_str(args, "to");
    let limit = arg_i64(args, "limit", 20).clamp(1, 30);

    let day_ms = |d: &str, end: bool| -> i64 {
        // YYYY-MM-DD → 北京时间毫秒
        let p: Vec<i64> = d.split('-').filter_map(|x| x.parse().ok()).collect();
        if p.len() != 3 {
            return 0;
        }
        let days = civil_days(p[0], p[1], p[2]) + if end { 1 } else { 0 };
        (days * 86400 - 8 * 3600) * 1000
    };
    let mut sql = String::from(
        "SELECT c.kind,c.title,c.summary,c.direction,c.code,c.source_url,
                COALESCE(c.published_at,c.collected_at) AS ts, t.name AS theme_name
         FROM catalyst c LEFT JOIN theme t ON t.id=c.theme_id WHERE 1=1",
    );
    // 动态位置参数，顺序与拼接条件一致
    let mut params: Vec<Box<dyn rusqlite::ToSql>> = vec![];
    if let Some(cd) = &code {
        sql.push_str(" AND c.code=?");
        params.push(Box::new(cd.clone()));
    }
    if let Some(th) = &theme {
        sql.push_str(" AND t.name LIKE ?");
        params.push(Box::new(format!("%{th}%")));
    }
    if let Some(kw) = &keyword {
        sql.push_str(" AND (c.title LIKE ? OR c.summary LIKE ?)");
        let like = format!("%{kw}%");
        params.push(Box::new(like.clone()));
        params.push(Box::new(like));
    }
    if let Some(kd) = &kind {
        sql.push_str(" AND c.kind=?");
        params.push(Box::new(kd.clone()));
    }
    if let Some(fd) = &from {
        sql.push_str(" AND ts>=?");
        params.push(Box::new(day_ms(fd, false)));
    }
    if let Some(td) = &to {
        sql.push_str(" AND ts<=?");
        params.push(Box::new(day_ms(td, true)));
    }
    sql.push_str(" ORDER BY ts DESC LIMIT ?");
    params.push(Box::new(limit));

    let mut stmt = c.prepare(&sql).map_err(|e| e.to_string())?;
    let mut rs = stmt
        .query_map(rusqlite::params_from_iter(params.iter()), |r| {
            let url: String = r.get(5).unwrap_or_default();
            Ok((
                json!({
                    "kind": r.get::<_,String>(0)?, "title": r.get::<_,String>(1)?,
                    "summary": r.get::<_,String>(2)?, "direction": r.get::<_,String>(3)?,
                    "code": r.get::<_,Option<String>>(4)?,
                    "publishedAt": r.get::<_,i64>(6)?,
                    "theme": r.get::<_,Option<String>>(7)?,
                    "url": if url.is_empty() { serde_json::Value::Null } else { json!(url) },
                }),
                url,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut items = vec![];
    let mut refs = vec![];
    while let Some(r) = rs.next() {
        let (v, url) = r.map_err(|e| e.to_string())?;
        if !url.is_empty() {
            refs.push(FactRef::url(&url, v["title"].as_str().unwrap_or("原文")));
        }
        items.push(v);
    }
    Ok(ToolOut {
        content: truncate(
            serde_json::to_string_pretty(&json!({"catalysts": items})).unwrap(),
        ),
        refs,
    })
}

/// 公历（年月日）→ 自 1970-01-01 天数（Howard Hinnant）。
fn civil_days(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

fn stock_profile(c: &rusqlite::Connection, args: &serde_json::Value) -> Result<ToolOut, String> {
    let code = arg_str(args, "code").ok_or("stock_profile 需要 code")?;
    if !valid_code(&code) {
        return Err("code 必须为 6 位数字".into());
    }
    let latest: Option<(String, String, i64, i64, String, String)> = c
        .query_row(
            "SELECT trade_date,name,boards,first_seal,industry,concepts FROM limit_up_record
             WHERE code=?1 ORDER BY trade_date DESC LIMIT 1",
            [&code],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
        )
        .ok();
    let mut themes = vec![];
    {
        let mut stmt = c
            .prepare(
                "SELECT t.name,ts.role FROM theme_stock ts JOIN theme t ON t.id=ts.theme_id
                 WHERE ts.code=?1",
            )
            .map_err(|e| e.to_string())?;
        let mut rs = stmt
            .query_map([&code], |r| {
                Ok(json!({"theme": r.get::<_,String>(0)?, "role": r.get::<_,String>(1)?}))
            })
            .map_err(|e| e.to_string())?;
        while let Some(r) = rs.next() {
            themes.push(r.map_err(|e| e.to_string())?);
        }
    }
    let mut catalysts = vec![];
    {
        let mut stmt = c
            .prepare(
                "SELECT kind,title,direction,COALESCE(published_at,collected_at)
                 FROM catalyst WHERE code=?1 ORDER BY collected_at DESC LIMIT 10",
            )
            .map_err(|e| e.to_string())?;
        let mut rs = stmt
            .query_map([&code], |r| {
                Ok(json!({
                    "kind": r.get::<_,String>(0)?, "title": r.get::<_,String>(1)?,
                    "direction": r.get::<_,String>(2)?, "publishedAt": r.get::<_,i64>(3)?,
                }))
            })
            .map_err(|e| e.to_string())?;
        while let Some(r) = rs.next() {
            catalysts.push(r.map_err(|e| e.to_string())?);
        }
    }
    let v = match latest {
        Some((date, name, boards, first_seal, industry, concepts)) => json!({
            "code": code, "name": name,
            "latestLimitUp": {
                "date": date, "boards": boards, "firstSeal": first_seal,
                "industry": industry, "concepts": concepts
            },
            "themes": themes, "recentCatalysts": catalysts
        }),
        None => json!({"code": code, "name": serde_json::Value::Null,
            "note": "本地无该股票涨停定格；以下为题材/催化资料", "themes": themes, "recentCatalysts": catalysts}),
    };
    Ok(ToolOut {
        content: truncate(serde_json::to_string_pretty(&v).unwrap()),
        refs: vec![
            FactRef::card("chart", Some(&code), None),
            FactRef::card("f10", Some(&code), None),
        ],
    })
}

fn list_limit_ups(c: &rusqlite::Connection, args: &serde_json::Value) -> Result<ToolOut, String> {
    let date = arg_str(args, "date").unwrap_or_else(|| latest_date(c).unwrap_or_default());
    if date.is_empty() {
        return Ok(ToolOut {
            content: "暂无涨停定格数据".into(),
            refs: vec![],
        });
    }
    if !valid_date(&date) {
        return Err("date 必须为 YYYY-MM-DD".into());
    }
    let code = arg_str(args, "code");
    if let Some(cd) = &code {
        if !valid_code(cd) {
            return Err("code 必须为 6 位数字".into());
        }
    }
    let min_boards = arg_i64(args, "minBoards", 1).max(1);
    let limit = arg_i64(args, "limit", 30).clamp(1, 50);
    // :code 在 SQL 中始终出现（未给代码时绑空串），避免 rusqlite 对多余命名参数报
    // InvalidParameterName（SQL 内短路过滤，仍为参数化查询）。
    let sql = "SELECT code,name,boards,first_seal,broken,seal_fund,industry,concepts
         FROM limit_up_record
         WHERE trade_date=:date AND boards>=:mb AND (:code='' OR code=:code)
         ORDER BY boards DESC, first_seal LIMIT :limit";
    let mut stmt = c.prepare(sql).map_err(|e| e.to_string())?;
    let mut rs = stmt
        .query_map(
            rusqlite::named_params! {
                ":date": date,
                ":mb": min_boards,
                ":limit": limit,
                ":code": code.unwrap_or_default()
            },
            |r| {
                Ok(json!({
                    "code": r.get::<_,String>(0)?, "name": r.get::<_,String>(1)?,
                    "boards": r.get::<_,i64>(2)?, "firstSeal": r.get::<_,Option<i64>>(3)?,
                    "broken": r.get::<_,i64>(4)?, "sealFund": r.get::<_,f64>(5)?,
                    "industry": r.get::<_,String>(6)?, "concepts": r.get::<_,String>(7)?,
                }))
            },
        )
        .map_err(|e| e.to_string())?;
    let mut items = vec![];
    while let Some(r) = rs.next() {
        items.push(r.map_err(|e| e.to_string())?);
    }
    Ok(ToolOut {
        content: truncate(
            serde_json::to_string_pretty(&json!({"date": date, "limitUps": items})).unwrap(),
        ),
        refs: vec![FactRef::card("limitpool", None, Some(&date))],
    })
}

async fn semantic_search(
    ctx: &ToolCtx<'_>,
    args: &serde_json::Value,
) -> Result<ToolOut, String> {
    let query = arg_str(args, "query").ok_or("semantic_search 需要 query")?;
    let k = arg_i64(args, "topK", 5).clamp(1, 10);
    let source_type = arg_str(args, "sourceType");
    let vecs = ctx.embedder.embed(vec![query.clone()]).await?;
    let q = vecs
        .into_iter()
        .next()
        .ok_or("嵌入服务返回空向量")?;
    let ai_path = ctx.data_dir.join("ai.db");
    let db: AiDb = vectordb::open(&ai_path)?;
    let hits = vectordb::search(&db.0, &q, k, source_type.as_deref())?;
    if hits.is_empty() {
        return Ok(ToolOut {
            content: "知识库中没有可匹配的已索引内容（可能尚未完成嵌入）。可提示用户先在设置→AI 大脑导入文档或等待自动入库。".into(),
            refs: vec![],
        });
    }
    let items: Vec<serde_json::Value> = hits
        .iter()
        .map(|h| {
            json!({
                "score": ((h.score * 1000.0).round() / 1000.0),
                "sourceType": h.source_type, "sourceRef": h.source_ref,
                "title": h.title, "chunkIndex": h.chunk_index, "text": h.text
            })
        })
        .collect();
    Ok(ToolOut {
        content: truncate(
            serde_json::to_string_pretty(&json!({"matches": items})).unwrap(),
        ),
        refs: vec![],
    })
}

fn paper_positions(c: &rusqlite::Connection) -> Result<ToolOut, String> {
    let mut stmt = c
        .prepare(
            "SELECT code,name,vol,avail_vol,cost_amount FROM paper_position WHERE vol>0 ORDER BY code",
        )
        .map_err(|e| e.to_string())?;
    let items: Vec<serde_json::Value> = stmt
        .query_map([], |r| {
            Ok(json!({
                "code": r.get::<_,String>(0)?, "name": r.get::<_,String>(1)?,
                "vol": r.get::<_,i64>(2)?, "availVol": r.get::<_,i64>(3)?,
                "costAmount": r.get::<_,f64>(4)?,
            }))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    Ok(ToolOut {
        content: serde_json::to_string_pretty(&json!({"positions": items})).unwrap(),
        refs: vec![FactRef::card("trade", None, None)],
    })
}

pub fn dispatch<'a>(
    name: &'a str,
    args: serde_json::Value,
    ctx: &'a ToolCtx<'a>,
) -> Pin<Box<dyn Future<Output = Result<ToolOut, String>> + Send + 'a>> {
    Box::pin(async move {
        if name == "semantic_search" {
            return semantic_search(ctx, &args).await;
        }
        let c = open_readonly(ctx.data_dir)?;
        match name {
            "market_overview" => market_overview(&c, &args),
            "list_themes" => list_themes(&c, &args),
            "theme_detail" => theme_detail(&c, &args),
            "query_catalysts" => query_catalysts(&c, &args),
            "stock_profile" => stock_profile(&c, &args),
            "list_limit_ups" => list_limit_ups(&c, &args),
            "paper_positions" => paper_positions(&c),
            other => Err(format!("未知工具: {other}")),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::provider::Embedder;
    use std::future::Future;
    use std::pin::Pin;

    /// 固定向量桩 Embedder：含「战法」字样返回 (1,0)，否则 (0,1)。
    struct MockEmbedder;
    impl Embedder for MockEmbedder {
        fn embed<'a>(
            &'a self,
            texts: Vec<String>,
        ) -> Pin<Box<dyn Future<Output = Result<Vec<Vec<f32>>, String>> + Send + 'a>> {
            Box::pin(async move {
                Ok(texts
                    .into_iter()
                    .map(|t| if t.contains("战法") { vec![1.0, 0.0] } else { vec![0.0, 1.0] })
                    .collect())
            })
        }
    }

    /// 在 tempdir 构造一个含主库表结构与样例数据的 data_dir。
    fn seeded_dir() -> std::path::PathBuf {
        // brief 原仅以 now_millis 命名，并行测试同毫秒撞目录后 CREATE TABLE 报
        // "table already exists"；追加进程内原子序号保证唯一（最小偏离）。
        static SEED_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let seq = SEED_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir()
            .join(format!("tickgold-ai-tools-{}-{}", crate::ai::now_millis(), seq));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let c = rusqlite::Connection::open(dir.join("stock-dock.db")).unwrap();
        c.execute_batch(
            "CREATE TABLE limit_up_record(trade_date TEXT,code TEXT,name TEXT DEFAULT '',
                boards INTEGER DEFAULT 1,first_seal INTEGER,last_seal INTEGER,seal_fund REAL DEFAULT 0,
                broken INTEGER DEFAULT 0,turnover REAL DEFAULT 0,industry TEXT DEFAULT '',concepts TEXT DEFAULT '');
             CREATE UNIQUE INDEX idx_lu ON limit_up_record(trade_date,code);
             CREATE TABLE theme(id INTEGER PRIMARY KEY,name TEXT UNIQUE,aliases TEXT DEFAULT '',
                level TEXT DEFAULT '分支',stage TEXT DEFAULT '萌芽',intro TEXT DEFAULT '',logic TEXT DEFAULT '',
                logic_version INTEGER DEFAULT 1,first_seen_date TEXT,last_active_date TEXT,
                created_at INTEGER,updated_at INTEGER);
             CREATE TABLE theme_stock(id INTEGER PRIMARY KEY,theme_id INTEGER,code TEXT,name TEXT DEFAULT '',
                role TEXT DEFAULT '跟风',role_score REAL DEFAULT 0,joined_date TEXT,left_date TEXT);
             CREATE TABLE catalyst(id INTEGER PRIMARY KEY,kind TEXT,title TEXT,summary TEXT DEFAULT '',
                source TEXT,source_url TEXT DEFAULT '',published_at INTEGER,direction TEXT DEFAULT '中性',
                theme_id INTEGER,code TEXT,fresh_score REAL DEFAULT 1,content_hash TEXT UNIQUE,collected_at INTEGER);
             CREATE TABLE paper_position(code TEXT PRIMARY KEY,name TEXT DEFAULT '',vol INTEGER DEFAULT 0,
                avail_vol INTEGER DEFAULT 0,cost_amount REAL DEFAULT 0,updated_at INTEGER);",
        )
        .unwrap();
        c.execute(
            "INSERT INTO limit_up_record(trade_date,code,name,boards,first_seal,broken,industry,concepts)
             VALUES('2026-09-29','300001','甲',1,93500,0,'机械','机器人'),
                   ('2026-09-30','300001','甲',2,93100,0,'机械','机器人'),
                   ('2026-09-30','300002','乙',1,94000,1,'电子','芯片')",
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
            "INSERT INTO catalyst(kind,title,source,published_at,direction,theme_id,code,content_hash,collected_at)
             VALUES('order','甲公司签订大单','cninfo',1727600000000,'利好',1,'300001','h1',1727600000000)",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO paper_position(code,name,vol,avail_vol,cost_amount,updated_at)
             VALUES('300001','甲',1000,1000,120000,0)",
            [],
        )
        .unwrap();
        dir
    }

    #[tokio::test]
    async fn market_overview_aggregates_and_promotion() {
        let dir = seeded_dir();
        let c = open_readonly(&dir).unwrap();
        let out = market_overview(&c, &json!({"date":"2026-09-30"})).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out.content).unwrap();
        assert_eq!(v["limitUpCount"], 2);
        assert_eq!(v["brokenCount"], 1);
        assert_eq!(v["maxBoards"], 2);
        // 昨日首板 1 只，今日晋级 1 只 → 100%
        assert_eq!(v["firstBoardPromotionRate"], 100.0);
        assert_eq!(out.refs[0].card.as_deref(), Some("limitpool"));
    }

    #[tokio::test]
    async fn theme_detail_and_catalyst_linking() {
        let dir = seeded_dir();
        let c = open_readonly(&dir).unwrap();
        let out = theme_detail(&c, &json!({"name":"机器人"})).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out.content).unwrap();
        assert_eq!(v["stage"], "发酵");
        assert_eq!(v["members"][0]["role"], "龙一");
        assert_eq!(v["recentCatalysts"][0]["title"], "甲公司签订大单");
    }

    #[tokio::test]
    async fn semantic_search_via_mock_embedder() {
        let dir = seeded_dir();
        {
            let db = vectordb::open(&dir.join("ai.db")).unwrap();
            let h = crate::ai::fnv1a_hex("战法文档块");
            vectordb::insert_chunk_ignore(
                &db.0,
                &vectordb::NewChunk {
                    text: "龙头战法要点：只做主线最强。",
                    source_type: "manual_doc",
                    source_ref: "龙头战法.md",
                    title: "龙头战法",
                    chunk_index: 0,
                    content_hash: &h,
                    model_hash: "m1",
                    embedding: Some(&[1.0, 0.0]),
                },
            )
            .unwrap();
        }
        let ctx = ToolCtx {
            data_dir: &dir,
            embedder: &MockEmbedder,
        };
        let out = dispatch("semantic_search", json!({"query":"战法怎么用","topK":3}), &ctx)
            .await
            .unwrap();
        let v: serde_json::Value = serde_json::from_str(&out.content).unwrap();
        assert_eq!(v["matches"][0]["sourceRef"], "龙头战法.md");
    }

    #[tokio::test]
    async fn paper_positions_and_validation() {
        let dir = seeded_dir();
        let c = open_readonly(&dir).unwrap();
        let out = paper_positions(&c).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out.content).unwrap();
        assert_eq!(v["positions"][0]["vol"], 1000);
        assert!(stock_profile(&c, &json!({"code":"12"})).is_err());
        assert!(market_overview(&c, &json!({"date":"2026/09/30"})).is_err());
    }

    #[tokio::test]
    async fn dispatch_unknown_tool_errors() {
        let dir = seeded_dir();
        let ctx = ToolCtx {
            data_dir: &dir,
            embedder: &MockEmbedder,
        };
        assert!(dispatch("nope", json!({}), &ctx).await.is_err());
    }

    #[tokio::test]
    async fn list_limit_ups_default_all_and_code_filter() {
        let dir = seeded_dir();
        let c = open_readonly(&dir).unwrap();

        // 1) 不传 code：走 SQL 短路条件 `AND (:code='' OR code=:code)`，
        //    这是修复 rusqlite「多绑未用命名参数 InvalidParameterName」的关键回归路径。
        let out = list_limit_ups(&c, &json!({"date":"2026-09-30"})).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out.content).unwrap();
        assert_eq!(v["date"], "2026-09-30");
        let ups = v["limitUps"].as_array().unwrap();
        assert_eq!(ups.len(), 2);
        // ORDER BY boards DESC：2 板甲在前、1 板乙在后（乙 broken=1 仍在榜）。
        assert_eq!(ups[0]["code"], "300001");
        assert_eq!(ups[0]["name"], "甲");
        assert_eq!(ups[0]["boards"], 2);
        assert_eq!(ups[0]["broken"], 0);
        assert_eq!(ups[1]["code"], "300002");
        assert_eq!(ups[1]["name"], "乙");
        assert_eq!(ups[1]["boards"], 1);
        assert_eq!(ups[1]["broken"], 1);
        assert_eq!(out.refs.len(), 1);
        assert_eq!(out.refs[0].card.as_deref(), Some("limitpool"));
        assert_eq!(out.refs[0].date.as_deref(), Some("2026-09-30"));

        // 2) 传 code：短路条件走 code=:code 精确过滤。
        let out = list_limit_ups(&c, &json!({"date":"2026-09-30","code":"300001"})).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out.content).unwrap();
        let ups = v["limitUps"].as_array().unwrap();
        assert_eq!(ups.len(), 1);
        assert_eq!(ups[0]["code"], "300001");
        assert_eq!(ups[0]["boards"], 2);

        // 3) minBoards=2：仅 2 连板的甲入选。
        let out = list_limit_ups(&c, &json!({"date":"2026-09-30","minBoards":2})).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out.content).unwrap();
        let ups = v["limitUps"].as_array().unwrap();
        assert_eq!(ups.len(), 1);
        assert_eq!(ups[0]["code"], "300001");
    }
}
