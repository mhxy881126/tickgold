// P1 盘前闭环：采集 → 分析 → 计划 三步自动串。
// 复用现有真实引擎：涨停/炸板池（采集）、六战法量化选股 strategy_scan（分析）、
// 规则作战卡 + 预警 alerts（计划）。全程不依赖大模型 / Pro 授权，新手可用。
// collect/analyze/plan 对应 daily_mission 第 0/1/2 步，严格门禁、不可跳步。
use crate::ai::maindb::open_readwrite;
use crate::ai::plan;
use crate::ai::workflow::{
    self, load_briefing, load_mission_state, mission_json, persist_advance, save_briefing,
    MissionState,
};
use crate::ai::{now_millis, AiState};
use crate::market::eastmoney::{ZtPool, ZtStock};
use crate::market::strategy_scan::{scan, StrategyScanReq, TacticHit};
use crate::market::{get_zb_pool, get_zt_pool, today_yyyymmdd};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use tauri::{AppHandle, State};

const CANDIDATE_LIMIT: i64 = 50;

// ============================ 采集：战场态势包 ============================

fn empty_pool() -> ZtPool {
    ZtPool {
        date: String::new(),
        total: 0,
        list: Vec::new(),
    }
}

fn stock_brief(z: &ZtStock) -> Value {
    json!({
        "code": z.code,
        "name": z.name,
        "boards": z.boards,
        "fundYi": (z.fund / 1e8 * 10.0).round() / 10.0,
        "industry": z.industry,
        "firstSeal": z.first_seal,
        "turnover": z.turnover,
        "pct": z.pct,
        "broken": z.broken,
    })
}

struct ThemeAgg {
    count: i64,
    max_boards: u32,
    leader: Option<(String, String, u32)>,
}

/// P8 演示态势包（教学 dry-run）：内置演示涨停/炸板数据，明确标注非真实行情。
#[allow(clippy::type_complexity)]
fn build_demo_briefing(trade_date: &str) -> Value {
    // (code, name, boards, industry, pct%, fund亿, first_seal, turnover%, broken)
    let d: Vec<(&str, &str, u32, &str, f64, f64, i64, f64, u32)> = vec![
        ("600519", "贵州茅台", 1, "白酒", 10.0, 45.2, 92500, 1.2, 0),
        ("300750", "宁德时代", 2, "锂电池", 20.0, 38.6, 93100, 3.4, 0),
        ("601127", "赛力斯", 3, "汽车整车", 33.1, 25.9, 93500, 5.1, 0),
        ("300308", "中际旭创", 4, "光模块", 44.0, 30.1, 94100, 7.5, 0),
        ("000977", "浪潮信息", 2, "算力", 19.5, 18.3, 100200, 6.8, 1),
        ("002230", "科大讯飞", 1, "AI应用", 10.0, 12.7, 101500, 4.2, 0),
    ];
    let mut ladder_map: BTreeMap<u32, i64> = BTreeMap::new();
    let mut themes: HashMap<String, ThemeAgg> = HashMap::new();
    let mut high: Vec<Value> = Vec::new();
    for (code, name, boards, industry, pct, fund_yi, first_seal, turnover, broken) in &d {
        *ladder_map.entry((*boards).max(1)).or_insert(0) += 1;
        let e = themes
            .entry((*industry).to_string())
            .or_insert(ThemeAgg { count: 0, max_boards: 0, leader: None });
        e.count += 1;
        if *boards > e.max_boards {
            e.max_boards = *boards;
            e.leader = Some(((*code).to_string(), (*name).to_string(), *boards));
        }
        if *boards >= 2 {
            high.push(json!({
                "code": code, "name": name, "boards": boards,
                "fundYi": fund_yi, "industry": industry,
                "firstSeal": first_seal, "turnover": turnover, "pct": pct, "broken": broken,
            }));
        }
    }
    high.sort_by(|a, b| {
        b["boards"]
            .as_u64()
            .unwrap_or(0)
            .cmp(&a["boards"].as_u64().unwrap_or(0))
    });
    let ladder: Vec<Value> = ladder_map
        .iter()
        .map(|(b, n)| json!({ "boards": b, "count": n }))
        .collect();
    let theme_arr: Vec<Value> = themes
        .iter()
        .map(|(name, a)| {
            let leader = a.leader.as_ref().map(|(c, n, b)| json!({ "code": c, "name": n, "boards": b }));
            json!({ "name": name, "count": a.count, "maxBoards": a.max_boards, "leader": leader })
        })
        .collect();
    json!({
        "tradeDate": trade_date,
        "rawDate": today_yyyymmdd(),
        "limitUp": 6,
        "broken": 1,
        "brokenRate": 14.3,
        "maxBoards": 4,
        "ladder": ladder,
        "themes": theme_arr,
        "highStocks": high,
        "degraded": vec!["demo"],
        "collectedAt": now_millis(),
    })
}

/// P8 演示候选池（教学 dry-run）：直接构造六只演示股候选，走同一打分/落库路径。
#[allow(clippy::type_complexity)]
fn demo_hits() -> Vec<TacticHit> {
    // code, name, price, pct%, boards, fund亿, first_seal, broken, turnover%, industry, tactics
    let d: Vec<(&str, &str, f64, f64, u32, f64, i64, u32, f64, &str, Vec<&str>)> = vec![
        ("300308", "中际旭创", 186.4, 44.0, 4, 30.1, 94100, 0, 7.5, "光模块", vec!["高标连板", "龙头共振", "题材驱动"]),
        ("601127", "赛力斯", 138.0, 33.1, 3, 25.9, 93500, 0, 5.1, "汽车整车", vec!["龙头共振", "连板梯队"]),
        ("300750", "宁德时代", 268.5, 20.0, 2, 38.6, 93100, 0, 3.4, "锂电池", vec!["潜龙出海", "题材驱动"]),
        ("000977", "浪潮信息", 52.3, 19.5, 2, 18.3, 100200, 1, 6.8, "算力", vec!["潜龙出海", "题材驱动"]),
        ("600519", "贵州茅台", 1520.0, 10.0, 1, 45.2, 92500, 0, 1.2, "白酒", vec!["龙头共振"]),
        ("002230", "科大讯飞", 48.6, 10.0, 1, 12.7, 101500, 0, 4.2, "AI应用", vec!["题材驱动"]),
    ];
    d.into_iter()
        .map(|(code, name, price, pct, boards, fund, first_seal, broken, turnover, industry, tactics)| TacticHit {
            code: code.to_string(),
            name: name.to_string(),
            price,
            pct,
            amount: fund * 1e8,
            turnover,
            volume_ratio: 1.8,
            speed5: 2.4,
            main_net: fund * 0.42 * 1e8,
            boards,
            fund: fund * 1e8,
            first_seal,
            broken,
            industry: industry.to_string(),
            tactics: tactics.into_iter().map(|s| s.to_string()).collect(),
            reasons: vec!["演示数据（非真实行情）".to_string()],
        })
        .collect()
}

/// 聚合当日涨停池 / 炸板池为「战场态势包」。任一数据源失败降级为空并标记，不整体报错。
async fn build_briefing(trade_date: &str) -> Value {
    let raw = today_yyyymmdd();
    let mut degraded: Vec<&str> = Vec::new();

    let zt = match get_zt_pool(raw.clone()).await {
        Ok(p) => p,
        Err(e) => {
            log::warn!("[P1] 涨停池采集失败: {e}");
            degraded.push("limitUp");
            empty_pool()
        }
    };
    let zb = match get_zb_pool(raw.clone()).await {
        Ok(p) => p,
        Err(e) => {
            log::warn!("[P1] 炸板池采集失败: {e}");
            degraded.push("broken");
            empty_pool()
        }
    };

    let limit_up = zt.list.len() as i64;
    let broken = zb.list.len() as i64;
    let attempt = limit_up + broken;
    let broken_rate = if attempt > 0 {
        (broken as f64 * 100.0 / attempt as f64 * 10.0).round() / 10.0
    } else {
        0.0
    };
    let max_boards = zt.list.iter().map(|z| z.boards).max().unwrap_or(0);

    // 连板梯队：按连板数计数（升序）。
    let mut ladder_map: BTreeMap<u32, i64> = BTreeMap::new();
    for z in &zt.list {
        *ladder_map.entry(z.boards.max(1)).or_insert(0) += 1;
    }
    let ladder: Vec<Value> = ladder_map
        .iter()
        .map(|(b, n)| json!({ "boards": b, "count": n }))
        .collect();

    // 主线题材：按行业聚合涨停家数、最高板与龙头。
    let mut themes: HashMap<String, ThemeAgg> = HashMap::new();
    for z in &zt.list {
        if z.industry.is_empty() {
            continue;
        }
        let e = themes.entry(z.industry.clone()).or_insert(ThemeAgg {
            count: 0,
            max_boards: 0,
            leader: None,
        });
        e.count += 1;
        if z.boards > e.max_boards {
            e.max_boards = z.boards;
            e.leader = Some((z.code.clone(), z.name.clone(), z.boards));
        }
    }
    let mut theme_arr: Vec<Value> = themes
        .iter()
        .map(|(name, a)| {
            let leader = a.leader.as_ref().map(|(c, n, b)| {
                json!({ "code": c, "name": n, "boards": b })
            });
            json!({
                "name": name, "count": a.count, "maxBoards": a.max_boards,
                "leader": leader
            })
        })
        .collect();
    theme_arr.sort_by(|a, b| {
        b["count"]
            .as_i64()
            .unwrap_or(0)
            .cmp(&a["count"].as_i64().unwrap_or(0))
    });
    theme_arr.truncate(8);

    // 高标梯队：连板股按板数、封单降序。
    let mut high: Vec<&ZtStock> = zt.list.iter().filter(|z| z.boards >= 2).collect();
    high.sort_by(|a, b| {
        b.boards
            .cmp(&a.boards)
            .then_with(|| b.fund.partial_cmp(&a.fund).unwrap_or(std::cmp::Ordering::Equal))
    });
    let high_stocks: Vec<Value> = high.iter().take(12).map(|z| stock_brief(z)).collect();

    json!({
        "tradeDate": trade_date,
        "rawDate": raw,
        "limitUp": limit_up,
        "broken": broken,
        "brokenRate": broken_rate,
        "maxBoards": max_boards,
        "ladder": ladder,
        "themes": theme_arr,
        "highStocks": high_stocks,
        "degraded": degraded,
        "collectedAt": now_millis(),
    })
}

// ============================ 分析：六战法打分 ============================

/// 单只候选打分（0-100，纯函数）。短线打板口径：连板高度 + 封单强度 + 首封时间
/// + 主力资金 + 多战法共振，炸板/换手过高扣分。
fn score_hit(h: &TacticHit) -> f64 {
    let mut s = 50.0;
    // 连板高度
    s += match h.boards {
        1 => 5.0,
        2 => 12.0,
        3 => 20.0,
        b if b >= 4 => 26.0,
        _ => 0.0,
    };
    // 封单金额（亿元），上限 10 分
    s += (h.fund / 1e8).clamp(0.0, 5.0) * 2.0;
    // 首次封板时间：越早越强
    if h.first_seal > 0 && h.first_seal < 100_000 {
        s += 8.0;
    } else if h.first_seal > 0 && h.first_seal < 110_000 {
        s += 4.0;
    }
    // 主力净流入（亿元），上限 6 分
    s += (h.main_net / 1e8).clamp(0.0, 3.0) * 2.0;
    // 多战法共振：每多命中一个战法加 4 分
    if h.tactics.len() > 1 {
        s += (h.tactics.len() - 1) as f64 * 4.0;
    }
    // 炸板次数扣分
    s -= h.broken as f64 * 3.0;
    // 换手过高（>25%）扣分
    if h.turnover > 25.0 {
        s -= 5.0;
    }
    s.clamp(0.0, 100.0)
}

// ============================ 候选池表 ============================

fn ensure_candidate_table(c: &Connection) -> Result<(), String> {
    c.execute_batch(
        "CREATE TABLE IF NOT EXISTS candidate_pool (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            trade_date TEXT NOT NULL,
            code TEXT NOT NULL,
            name TEXT NOT NULL DEFAULT '',
            tactics_json TEXT NOT NULL DEFAULT '[]',
            score REAL NOT NULL DEFAULT 0,
            rank_no INTEGER NOT NULL DEFAULT 0,
            boards INTEGER NOT NULL DEFAULT 0,
            price REAL NOT NULL DEFAULT 0,
            pct REAL NOT NULL DEFAULT 0,
            amount REAL NOT NULL DEFAULT 0,
            turnover REAL NOT NULL DEFAULT 0,
            fund REAL NOT NULL DEFAULT 0,
            main_net REAL NOT NULL DEFAULT 0,
            industry TEXT NOT NULL DEFAULT '',
            reasons_json TEXT NOT NULL DEFAULT '[]',
            status TEXT NOT NULL DEFAULT 'candidate',
            created_at INTEGER NOT NULL,
            UNIQUE(trade_date, code)
        );
        CREATE INDEX IF NOT EXISTS idx_candidate_pool_date ON candidate_pool(trade_date, score DESC);",
    )
    .map_err(|e| format!("初始化 candidate_pool 失败: {e}"))
}

/// 幂等重写当日候选池（先删后插，rank 按打分降序）。
fn save_candidates(c: &Connection, date: &str, hits: &[TacticHit]) -> Result<(), String> {
    c.execute("DELETE FROM candidate_pool WHERE trade_date=?1", [date])
        .map_err(|e| e.to_string())?;
    let now = now_millis();
    for (i, h) in hits.iter().enumerate() {
        let score = score_hit(h);
        c.execute(
            "INSERT INTO candidate_pool(trade_date,code,name,tactics_json,score,rank_no,boards,
                price,pct,amount,turnover,fund,main_net,industry,reasons_json,status,created_at)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,'candidate',?16)",
            rusqlite::params![
                date,
                h.code,
                h.name,
                serde_json::to_string(&h.tactics).unwrap_or_else(|_| "[]".into()),
                score,
                (i + 1) as i64,
                h.boards,
                h.price,
                h.pct,
                h.amount,
                h.turnover,
                h.fund,
                h.main_net,
                h.industry,
                serde_json::to_string(&h.reasons).unwrap_or_else(|_| "[]".into()),
                now
            ],
        )
        .map_err(|e| format!("写入候选池失败: {e}"))?;
    }
    Ok(())
}

/// 读取当日候选池（按排名升序）。
fn load_candidates(c: &Connection, date: &str, limit: i64) -> Result<Vec<Value>, String> {
    let mut stmt = c
        .prepare(
            "SELECT code,name,tactics_json,score,rank_no,boards,price,pct,turnover,fund,
                    main_net,industry,reasons_json,status
             FROM candidate_pool WHERE trade_date=?1 ORDER BY rank_no ASC LIMIT ?2",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![date, limit], |r| {
            let tactics: String = r.get(2)?;
            let reasons: String = r.get(12)?;
            Ok(json!({
                "code": r.get::<_, String>(0)?,
                "name": r.get::<_, String>(1)?,
                "tactics": serde_json::from_str::<Value>(&tactics).unwrap_or(json!([])),
                "score": (r.get::<_, f64>(3)? * 10.0).round() / 10.0,
                "rank": r.get::<_, i64>(4)?,
                "boards": r.get::<_, i64>(5)?,
                "price": r.get::<_, f64>(6)?,
                "pct": r.get::<_, f64>(7)?,
                "turnover": r.get::<_, f64>(8)?,
                "fundYi": (r.get::<_, f64>(9)? / 1e8 * 10.0).round() / 10.0,
                "mainNetYi": (r.get::<_, f64>(10)? / 1e8 * 100.0).round() / 100.0,
                "industry": r.get::<_, String>(11)?,
                "reasons": serde_json::from_str::<Value>(&reasons).unwrap_or(json!([])),
                "status": r.get::<_, String>(13)?
            }))
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

// ============================ 计划：规则作战卡 ============================

/// 情绪判定（涨停数 / 炸板率 / 最高板）→ 情绪、仓位上限、操作建议。
fn mood_of(limit_up: i64, broken_rate: f64, max_boards: i64) -> (&'static str, &'static str, &'static str) {
    if limit_up >= 70 && broken_rate <= 20.0 && max_boards >= 5 {
        ("亢奋", "≤80%", "情绪高潮、高位接力风险累积，次日防分歧，只跟最强主线、不追杂毛")
    } else if limit_up >= 40 && broken_rate <= 35.0 {
        ("偏暖", "≤60%", "情绪尚可，可围绕主线龙头试错，严格控制仓位")
    } else if limit_up <= 25 || broken_rate >= 45.0 {
        ("冰点", "≤20%", "亏钱效应明显，宜防守、轻仓或空仓，等待情绪修复信号")
    } else {
        ("中性", "≤40%", "情绪一般，以结构性机会为主，快进快出")
    }
}

/// 从态势包 + 候选池构造规则作战卡（与 LLM 计划同构：title/marketView/instructions）。
fn build_plan_json(plan_date: &str, briefing: &Value, candidates: &[Value]) -> Value {
    let limit_up = briefing["limitUp"].as_i64().unwrap_or(0);
    let broken_rate = briefing["brokenRate"].as_f64().unwrap_or(0.0);
    let max_boards = briefing["maxBoards"].as_i64().unwrap_or(0);
    let (mood, cap, advice) = mood_of(limit_up, broken_rate, max_boards);

    let market_view = format!(
        "情绪{mood}（涨停 {limit_up} 家、炸板率 {broken_rate:.0}%、最高 {max_boards} 板）。{advice}。次日总仓位 {cap}。\n\
         本作战卡由规则引擎基于当日真实涨停池与六战法量化候选生成，仅为客观观察条件与风险提示，不构成投资建议。"
    );

    let mut instructions: Vec<Value> = Vec::new();
    for c in candidates.iter().take(8) {
        let score = c["score"].as_f64().unwrap_or(0.0);
        let boards = c["boards"].as_i64().unwrap_or(0);
        let tier = if score >= 80.0 || boards >= 3 {
            "candidate"
        } else {
            "watch"
        };
        let tactics = c["tactics"].as_array().cloned().unwrap_or_default();
        let tactics_txt: Vec<String> = tactics
            .iter()
            .filter_map(|t| t.as_str().map(crate::market::strategy_scan::tactic_label))
            .collect();
        let reasons = c["reasons"].as_array().cloned().unwrap_or_default();
        let reasons_txt: Vec<String> =
            reasons.iter().filter_map(|r| r.as_str().map(String::from)).collect();
        let mut cond = format!("战法：{}；依据：{}", tactics_txt.join("、"), reasons_txt.join("；"));
        if cond.ends_with("：") {
            cond = format!("综合评分 {:.0}，观察次日竞价与量能是否确认", score);
        }
        cond.push_str("；断板、低开走弱或无量一字则放弃，不追高");
        instructions.push(json!({
            "tier": tier,
            "code": c["code"].as_str().unwrap_or(""),
            "name": c["name"].as_str().unwrap_or(""),
            "theme": c["industry"].as_str().unwrap_or(""),
            "condition": cond,
            "action": if tier == "candidate" { "备选待人工确认，是否参与由用户自行决定" } else { "仅观察，不动作" },
            "positionHint": "不设仓位指令，确认后转为价格/涨跌幅预警辅助盯盘",
            "alertRule": { "upPrice": null, "downPrice": null, "upPct": 5, "downPct": -5, "riseSpeed": null }
        }));
    }

    json!({
        "title": format!("{plan_date} 盘前作战卡"),
        "marketView": market_view,
        "instructions": instructions
    })
}

// ============================ 门禁 helper ============================

fn require_step(
    c: &Connection,
    date: &str,
    expect: i64,
    label: &str,
) -> Result<MissionState, String> {
    let st = load_mission_state(c, date)?;
    if st.current_step != expect {
        return Err(format!(
            "「{label}」需要在第 {} 步进行，当前在第 {} 步，请按顺序推进或重置作战流",
            expect + 1,
            st.current_step + 1
        ));
    }
    Ok(st)
}

fn mission_from_state(date: &str, st: &MissionState) -> Value {
    mission_json(
        date,
        st.current_step,
        &st.steps,
        &st.mode,
        &st.account_json,
        st.created_at,
        now_millis(),
    )
}

// ============================ Tauri 命令 ============================

/// 第①步：采集当日战场态势（涨停/炸板/连板梯队/题材/高标），推进到分析。
#[tauri::command]
pub async fn workflow_collect(
    state: State<'_, AiState>,
    trade_date: Option<String>,
    demo: Option<bool>,
) -> Result<Value, String> {
    let date = trade_date.unwrap_or_else(workflow::today_str);
    let dir = state.dir().clone();
    let briefing = if demo.unwrap_or(false) {
        build_demo_briefing(&date)
    } else {
        build_briefing(&date).await
    };
    let c = open_readwrite(&dir)?;
    let mut st = require_step(&c, &date, 0, "采集")?;
    save_briefing(&c, &date, &briefing)?;
    let snapshot = json!({
        "kind": "briefing",
        "limitUp": briefing["limitUp"],
        "broken": briefing["broken"],
        "maxBoards": briefing["maxBoards"]
    })
    .to_string();
    let mission = persist_advance(&c, &date, &mut st, Some(snapshot))?;
    Ok(json!({ "mission": mission, "briefing": briefing }))
}

/// 第②步：六战法量化选股 + 打分排序，落候选池，推进到计划。
#[tauri::command]
pub async fn workflow_analyze(
    state: State<'_, AiState>,
    trade_date: Option<String>,
    demo: Option<bool>,
) -> Result<Value, String> {
    let date = trade_date.unwrap_or_else(workflow::today_str);
    let dir = state.dir().clone();
    let mut hits = if demo.unwrap_or(false) {
        demo_hits()
    } else {
        let req = StrategyScanReq {
            tactics: Vec::new(),
            limit: Some(CANDIDATE_LIMIT),
            theme: String::new(),
        };
        scan(&req).await.map_err(|e| format!("六战法选股失败: {e}"))?
    };
    hits.sort_by(|a, b| {
        score_hit(b)
            .partial_cmp(&score_hit(a))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let total = hits.len();

    let c = open_readwrite(&dir)?;
    let mut st = require_step(&c, &date, 1, "分析")?;
    ensure_candidate_table(&c)?;
    save_candidates(&c, &date, &hits)?;
    let candidates = load_candidates(&c, &date, 30)?;
    let snapshot = json!({ "kind": "candidates", "total": total, "top": candidates.len() }).to_string();
    let mission = persist_advance(&c, &date, &mut st, Some(snapshot))?;
    Ok(json!({ "mission": mission, "candidates": candidates, "total": total }))
}

/// 第③步：生成次日作战卡（规则，不推进；供用户预览/编辑后再确认）。
#[tauri::command]
pub fn workflow_plan(
    state: State<'_, AiState>,
    trade_date: Option<String>,
) -> Result<Value, String> {
    let date = trade_date.unwrap_or_else(workflow::today_str);
    let dir = state.dir().clone();
    let (briefing, candidates, st_view) = {
        let c = open_readwrite(&dir)?;
        let st = require_step(&c, &date, 2, "计划")?;
        ensure_candidate_table(&c)?;
        let cands = load_candidates(&c, &date, 20)?;
        (load_briefing(&c, &date), cands, mission_from_state(&date, &st))
    };
    if candidates.is_empty() {
        return Err("候选池为空，请先完成第②步分析".to_string());
    }
    let plan_date = plan::next_trade_date(&date);
    let pj = build_plan_json(&plan_date, &briefing, &candidates);
    let saved = plan::save_external_plan(&dir, &plan_date, &date, "p1-rules", &pj)?;
    Ok(json!({ "mission": st_view, "plan": saved }))
}

/// 第③步确认：作战卡指令批量转预警（入明日盯盘），计划置 confirmed，推进到盯盘。
#[tauri::command]
pub fn workflow_plan_confirm(
    state: State<'_, AiState>,
    trade_date: Option<String>,
) -> Result<Value, String> {
    let date = trade_date.unwrap_or_else(workflow::today_str);
    let dir = state.dir().clone();
    {
        let c = open_readwrite(&dir)?;
        let _st = require_step(&c, &date, 2, "作战卡确认")?;
    }
    let plan_date = plan::next_trade_date(&date);
    let plan_id = plan::find_plan_id_by_date(&dir, &plan_date)?
        .ok_or_else(|| "请先生成作战卡再确认".to_string())?;
    let alerts_created = plan::confirm_plan_alerts(&dir, plan_id)?;
    // P1-a：不在确认时物化。本计划面向下一交易日，条件单必须等计划日当天再建，
    // 否则 ttl=day 的单会在建单当日被 conditional::expire_due 判过期；
    // 计划日的物化入口见 instruction::materialize_today（后台 30s 循环 + 指令列表读取路径）。
    let saved = plan::get_plan(&dir, plan_id)?;

    let c = open_readwrite(&dir)?;
    let mut st = load_mission_state(&c, &date)?;
    let snapshot =
        json!({ "kind": "planConfirmed", "planId": plan_id, "alerts": alerts_created }).to_string();
    let mission = persist_advance(&c, &date, &mut st, Some(snapshot))?;
    Ok(json!({
        "mission": mission,
        "plan": saved,
        "alertsCreated": alerts_created
    }))
}

/// 只读回显：重开驾驶舱 / 次日盘前时，取回当日已产出的态势包、候选池与次日作战卡。
#[tauri::command]
pub fn workflow_p1_products(
    app: AppHandle,
    state: State<'_, AiState>,
    trade_date: Option<String>,
) -> Result<Value, String> {
    let date = trade_date.unwrap_or_else(workflow::today_str);
    let dir = state.dir().clone();
    // 条件单触发循环与旧预警引擎解耦：旧引擎启动时会被前端停掉，
    // 这里在计划日读路径上幂等拉起专用循环（只启动一次，非计划日也会拉起）。
    crate::market::alert::ensure_co_engine(&app);
    let c = open_readwrite(&dir)?;
    let briefing = load_briefing(&c, &date);
    ensure_candidate_table(&c)?;
    let candidates = load_candidates(&c, &date, 30).unwrap_or_default();
    // 计划日读取 P1 产物时把今日作战卡物化为条件单（非计划日 no-op，幂等）。
    if let Err(e) = crate::ai::instruction::materialize_today(&c) {
        log::warn!("materialize_today failed: {e}");
    }
    let plan_date = plan::next_trade_date(&date);
    let plan = plan::find_plan_id_by_date(&dir, &plan_date)
        .ok()
        .flatten()
        .and_then(|id| plan::get_plan(&dir, id).ok());
    let confirmed = plan
        .as_ref()
        .and_then(|p| p["status"].as_str())
        .map(|x| x == "confirmed")
        .unwrap_or(false);
    Ok(json!({
        "briefing": briefing,
        "candidates": candidates,
        "plan": plan,
        "planConfirmed": confirmed
    }))
}

/// 按计划日取计划 id（旧库缺 plan 表时返回 None，由调用方按空态处理）。
fn plan_id_on(c: &Connection, plan_date: &str) -> Option<i64> {
    c.query_row("SELECT id FROM plan WHERE plan_date=?1", [plan_date], |r| {
        r.get(0)
    })
    .ok()
}

/// 指令列表展示哪张计划：计划日（今天）优先，其次下一交易日（盘后预览）。
///
/// `materialize_today` 只物化 `plan_date == 今天` 的计划，故盘中必须读今天的计划，
/// 否则拿不到条件单状态；今天无计划（周末 / 盘后尚未生成）时回退到下一交易日，
/// 让盘后确认的作战卡也能提前预览（未建单，全部「仅观察」）。
fn instruction_plan_id(c: &Connection, date: &str) -> Option<i64> {
    let today = crate::broker::conditional::today_dashed();
    plan_id_on(c, &today).or_else(|| plan_id_on(c, &plan::next_trade_date(date)))
}

/// P1-a：作战台只读指令列表（状态由条件单 / 信号票 / 委托在读取时推导，不落库）。
///
/// 先做一次幂等物化：5s 轮询会反复调用本命令，今天的已确认计划因此始终「最多晚
/// 30s」就能拿到 `co_id` 与实时状态（后台循环是兜底，不依赖作战台是否挂载）。
#[tauri::command]
pub fn workflow_instructions(
    state: State<'_, AiState>,
    trade_date: Option<String>,
) -> Result<Value, String> {
    let date = trade_date.unwrap_or_else(workflow::today_str);
    let dir = state.dir().clone();
    let c = open_readwrite(&dir)?;
    if let Err(e) = crate::ai::instruction::materialize_today(&c) {
        log::warn!("materialize_today failed: {e}");
    }
    let Some(pid) = instruction_plan_id(&c, &date) else {
        return Ok(json!({ "plan": null, "instructions": [] }));
    };
    let plan = plan::get_plan(&dir, pid).unwrap_or(Value::Null);
    let instructions = crate::ai::instruction::list_instructions(&c, pid)?;
    Ok(json!({ "plan": plan, "instructions": instructions }))
}

// ============================ 单测 ============================

#[cfg(test)]
mod tests {
    use super::*;

    fn hit(boards: u32, fund: f64, first_seal: i64, main_net: f64, broken: u32, tactics: usize) -> TacticHit {
        TacticHit {
            code: "000001".into(),
            name: "测试".into(),
            price: 10.0,
            pct: 10.0,
            amount: 1e9,
            turnover: 10.0,
            volume_ratio: 2.0,
            speed5: 0.0,
            main_net,
            boards,
            fund,
            first_seal,
            broken,
            industry: "机器人".into(),
            tactics: vec!["x".to_string(); tactics],
            reasons: vec!["r".into()],
        }
    }

    #[test]
    fn score_high_board_beats_first_board() {
        let high = hit(4, 3e8, 93500, 1e8, 0, 2);
        let first = hit(1, 1e8, 140000, 0.0, 1, 1);
        assert!(score_hit(&high) > score_hit(&first));
    }

    #[test]
    fn score_clamped_to_100() {
        let strong = hit(5, 8e8, 93000, 5e8, 0, 4);
        assert_eq!(score_hit(&strong), 100.0);
    }

    #[test]
    fn score_broken_and_turnover_penalize() {
        let clean = hit(2, 1e8, 100000, 0.0, 0, 1);
        let mut messy = hit(2, 1e8, 100000, 0.0, 3, 1);
        messy.turnover = 30.0;
        assert!(score_hit(&messy) < score_hit(&clean));
    }

    #[test]
    fn mood_thresholds() {
        assert_eq!(mood_of(80, 10.0, 6).0, "亢奋");
        assert_eq!(mood_of(50, 20.0, 3).0, "偏暖");
        assert_eq!(mood_of(20, 50.0, 1).0, "冰点");
        assert_eq!(mood_of(35, 30.0, 2).0, "中性");
    }

    #[test]
    fn build_plan_splits_tiers_and_keeps_top8() {
        let briefing = json!({ "limitUp": 55, "brokenRate": 20.0, "maxBoards": 4 });
        let mut cands = Vec::new();
        for i in 0..12 {
            cands.push(json!({
                "code": format!("00000{i}"), "name": format!("股{i}"),
                "tactics": ["multi_board"], "score": 90 - i * 5, "boards": if i < 2 { 4 } else { 1 },
                "industry": "机器人", "reasons": ["连板"]
            }));
        }
        let pj = build_plan_json("2026-10-17", &briefing, &cands);
        let ins = pj["instructions"].as_array().unwrap();
        assert_eq!(ins.len(), 8);
        assert_eq!(ins[0]["tier"], "candidate");
        assert!(ins[0]["condition"].as_str().unwrap().contains("连板"));
        assert!(pj["title"].as_str().unwrap().contains("2026-10-17"));
    }

    #[test]
    fn instruction_plan_prefers_today_then_next_trade_date() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE plan(id INTEGER PRIMARY KEY AUTOINCREMENT, plan_date TEXT NOT NULL UNIQUE);",
        )
        .unwrap();
        // 用远期基准日构造「下一交易日」，避免用例与真实日期耦合（不会被今天命中）。
        let base = "2999-01-01";
        let next = plan::next_trade_date(base);
        // 空库：没有计划 → None（列表走空态）
        assert_eq!(instruction_plan_id(&c, base), None);

        c.execute("INSERT INTO plan(plan_date) VALUES(?1)", [&next])
            .unwrap();
        let next_id = c.last_insert_rowid();
        // 今天没有计划：回退到下一交易日（盘后确认的作战卡预览）
        assert_eq!(instruction_plan_id(&c, base), Some(next_id));

        let today = crate::broker::conditional::today_dashed();
        c.execute("INSERT INTO plan(plan_date) VALUES(?1)", [&today])
            .unwrap();
        let today_id = c.last_insert_rowid();
        // 今天已有计划：计划日优先，避免盘中展示明天的计划
        assert_eq!(instruction_plan_id(&c, base), Some(today_id));
    }
}
