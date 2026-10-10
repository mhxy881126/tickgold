// v2.25 智能赋能：AI 自然语言层——盘中解读、信号归因、预警推荐、资讯聚合、明日主线。
// 复用现有行情/快讯/涨停池/板块数据，通过 LLM 转化为可理解的自然语言输出。
use super::config::{load_config, AiConfig, SecretStore};
use super::provider::{chat_stream, ChatMsg, StreamEv};
use crate::market;
use tauri::Manager;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;

// ==================== 辅助函数 ====================

/// 从 AiState 加载 AI 配置与云 Key。
pub fn load_cfg(dir: &PathBuf) -> Result<(AiConfig, Option<String>), String> {
    let db = super::vectordb::open(&dir.join("ai.db"))?;
    let cfg = load_config(&db.0)?;
    let key = if cfg.provider == "cloud" {
        SecretStore::get(&crate::ai::config::KeyringSecret {
            service: "tickgold.ai.cloud-key".to_string(),
            user: "default".to_string(),
        })?
    } else {
        None
    };
    Ok((cfg, key))
}

/// 调用 LLM，收集流式 delta，返回完整文本。
async fn call_llm_text(cfg: &AiConfig, key: &Option<String>, system: &str, user: &str) -> Result<String, String> {
    let msgs = vec![
        ChatMsg {
            role: "system".to_string(),
            content: system.to_string(),
            tool_calls: None,
            tool_call_id: None,
        },
        ChatMsg {
            role: "user".to_string(),
            content: user.to_string(),
            tool_calls: None,
            tool_call_id: None,
        },
    ];
    let mut buf = String::new();
    let mut on = |ev: StreamEv| {
        if let StreamEv::Delta(t) = ev {
            buf.push_str(&t);
        }
    };
    chat_stream(cfg, key, &msgs, &[], &mut on).await?;
    Ok(buf.trim().to_string())
}

/// 调用 LLM 并解析 JSON 结果。LLM 需返回纯 JSON（可含 ```json 围栏，自动剥离）。
async fn call_llm_json(cfg: &AiConfig, key: &Option<String>, system: &str, user: &str) -> Result<Value, String> {
    let text = call_llm_text(cfg, key, system, user).await?;
    let text = text
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    serde_json::from_str(text).map_err(|e| format!("AI 返回 JSON 解析失败: {e}; raw={}", &text[..text.len().min(500)]))
}

/// 调用 LLM 流式输出，每收到 delta 调用 on_delta 回调，返回完整文本。
async fn call_llm_text_stream(
    cfg: &AiConfig,
    key: &Option<String>,
    system: &str,
    user: &str,
    mut on_delta: impl FnMut(String),
) -> Result<String, String> {
    let msgs = vec![
        ChatMsg { role: "system".to_string(), content: system.to_string(), tool_calls: None, tool_call_id: None },
        ChatMsg { role: "user".to_string(), content: user.to_string(), tool_calls: None, tool_call_id: None },
    ];
    let mut buf = String::new();
    let mut on = |ev: StreamEv| {
        if let StreamEv::Delta(t) = ev {
            buf.push_str(&t);
            on_delta(t);
        }
    };
    chat_stream(cfg, key, &msgs, &[], &mut on).await.map_err(|e| format!("AI 调用失败: {e}"))?;
    Ok(buf)
}

// ==================== 行情数据缓存（10秒TTL，避免AI调用时重复拉取） ====================
use std::sync::Mutex;
use std::time::{Instant, Duration};

struct CacheEntry<T> {
    data: T,
    expiry: Instant,
}
lazy_static::lazy_static! {
    static ref INDEX_CACHE: Mutex<Option<CacheEntry<String>>> = Mutex::new(None);
    static ref SECTOR_CACHE: Mutex<Option<CacheEntry<String>>> = Mutex::new(None);
    static ref ZT_CACHE: Mutex<Option<CacheEntry<String>>> = Mutex::new(None);
    static ref NEWS_CACHE: Mutex<Option<CacheEntry<Vec<String>>>> = Mutex::new(None);
}
const CACHE_TTL: Duration = Duration::from_secs(10);

fn get_cached<T: Clone>(cache: &Mutex<Option<CacheEntry<T>>>) -> Option<T> {
    let guard = cache.lock().ok()?;
    guard.as_ref().and_then(|e| {
        if Instant::now() < e.expiry { Some(e.data.clone()) } else { None }
    })
}
fn set_cached<T: Clone>(cache: &Mutex<Option<CacheEntry<T>>>, data: T) {
    if let Ok(mut guard) = cache.lock() {
        *guard = Some(CacheEntry { data, expiry: Instant::now() + CACHE_TTL });
    }
}

// ==================== 数据聚合 ====================

/// 大盘指数摘要
async fn index_summary() -> String {
    if let Some(cached) = get_cached(&INDEX_CACHE) { return cached; }
    let result = match market::get_index_quotes().await {
        Ok(list) => {
            let parts: Vec<String> = list
                .iter()
                .map(|q| format!("{} {:.2} ({:+.2}%)", q.name, q.price, q.pct))
                .collect();
            parts.join("；")
        }
        Err(_) => "指数数据暂不可用".to_string(),
    };
    set_cached(&INDEX_CACHE, result.clone());
    result
}

/// 板块涨跌前5
async fn sector_summary() -> String {
    if let Some(cached) = get_cached(&SECTOR_CACHE) { return cached; }
    let result = match market::get_sectors("industry".to_string()).await {
        Ok(mut list) => {
            list.sort_by(|a, b| b.change_pct.partial_cmp(&a.change_pct).unwrap_or(std::cmp::Ordering::Equal));
            let top: Vec<String> = list.iter().take(5).map(|s| format!("{} {:+.2}%", s.name, s.change_pct)).collect();
            let bottom: Vec<String> = list.iter().rev().take(5).map(|s| format!("{} {:+.2}%", s.name, s.change_pct)).collect();
            format!("领涨：{}；领跌：{}", top.join("、"), bottom.join("、"))
        }
        Err(_) => "板块数据暂不可用".to_string(),
    };
    set_cached(&SECTOR_CACHE, result.clone());
    result
}

/// 涨停池摘要
async fn zt_summary() -> String {
    if let Some(cached) = get_cached(&ZT_CACHE) { return cached; }
    let today = market::today_yyyymmdd();
    let result = match market::get_zt_pool(today).await {
        Ok(pool) => {
            let total = pool.list.len();
            let multi: Vec<&str> = pool.list.iter().filter(|s| s.boards >= 2).map(|s| s.name.as_str()).collect();
            format!("涨停 {} 家，连板 {} 家（{}）", total, multi.len(), multi.join("、"))
        }
        Err(_) => "涨停池数据暂不可用".to_string(),
    };
    set_cached(&ZT_CACHE, result.clone());
    result
}

/// 最近 N 条快讯摘要
async fn news_summary(n: usize) -> String {
    match market::get_news_flash(1, n as i64).await {
        Ok(list) => {
            let parts: Vec<String> = list.iter().take(n).map(|n| format!("[{}] {}", n.time, n.text)).collect();
            parts.join("\n")
        }
        Err(_) => "快讯数据暂不可用".to_string(),
    }
}

// ==================== 1. 盘中实时解读 ====================

#[derive(Serialize, Deserialize)]
pub struct IntradayCommentary {
    pub timestamp: i64,
    pub market_view: String,
    pub key_drivers: Vec<String>,
    pub risk_notes: Vec<String>,
    pub raw: String,
}

const SYSTEM_INTRADAY: &str = "你是 A 股盘中实时解读助手。基于给定的大盘指数、板块涨跌、涨停池和最新快讯，用简洁专业的语言解读当前市场状态。输出严格 JSON：{\"market_view\":\"一段话市场总览（100字内）\",\"key_drivers\":[\"驱动因素1\",\"驱动因素2\",\"驱动因素3\"],\"risk_notes\":[\"风险提示1\",\"风险提示2\"]}。只输出 JSON，不要其他文字。";

#[tauri::command]
pub async fn ai_intraday_commentary(state: tauri::State<'_, super::AiState>) -> Result<IntradayCommentary, String> {
    let (cfg, key) = load_cfg(&state.dir())?;
    let (idx, sec, zt, news) = tokio::join!(
        index_summary(),
        sector_summary(),
        zt_summary(),
        news_summary(8)
    );

    let user = format!(
        "【大盘指数】{}\n【板块】{}\n【涨停池】{}\n【最新快讯】\n{}\n\n请基于以上数据，生成当前盘中市场解读。",
        idx, sec, zt, news
    );

    let v = call_llm_json(&cfg, &key, SYSTEM_INTRADAY, &user).await?;
    Ok(IntradayCommentary {
        timestamp: super::now_millis(),
        market_view: v["market_view"].as_str().unwrap_or("").to_string(),
        key_drivers: v["key_drivers"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default(),
        risk_notes: v["risk_notes"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default(),
        raw: v.to_string(),
    })
}

// ==================== 2. 信号归因 ====================

#[derive(Serialize, Deserialize)]
pub struct SignalAttribution {
    pub code: String,
    pub name: String,
    pub summary: String,
    pub technical: String,
    pub fund_flow: String,
    pub sector: String,
    pub news: String,
    pub confidence: f64,
}

const SYSTEM_ATTRIBUTION: &str = "你是 A 股信号归因分析师。当一只股票出现异动（大涨/大跌/涨停/跌停/放量）时，基于给定的实时行情、板块联动和相关快讯，从技术面、资金面、板块面、消息面四个维度归因分析。输出严格 JSON：{\"summary\":\"一句话归因结论（50字内）\",\"technical\":\"技术面分析（量价/形态/指标，80字内）\",\"fund_flow\":\"资金面分析（主力/大单/换手，80字内）\",\"sector\":\"板块面分析（联动/龙头/轮动，80字内）\",\"news\":\"消息面分析（相关快讯/公告/催化，80字内）\",\"confidence\":0.85}。confidence 为 0-1 的归因置信度。只输出 JSON。";

#[tauri::command]
pub async fn ai_explain_signal(
    state: tauri::State<'_, super::AiState>,
    code: String,
    name: String,
    kind: String,
) -> Result<SignalAttribution, String> {
    let (cfg, key) = load_cfg(&state.dir())?;

    // 拉取个股实时行情
    let quote_info = match market::get_quotes(vec![code.clone()]).await {
        Ok(q) if !q.is_empty() => {
            let q = &q[0];
            format!("现价 {:.2}，涨跌幅 {:+.2}%，成交量 {:.0}，换手率 {:.2}%，量比 {:.2}", q.price, q.pct, q.volume, q.turnover, q.volume_ratio)
        }
        _ => "行情数据暂不可用".to_string(),
    };

    // 拉取相关快讯
    let news = news_summary(10).await;

    let user = format!(
        "【标的】{} ({})\n【异动类型】{}\n【实时行情】{}\n【市场快讯】\n{}\n\n请对该标的的异动进行四维度归因分析。",
        name, code, kind, quote_info, news
    );

    let v = call_llm_json(&cfg, &key, SYSTEM_ATTRIBUTION, &user).await?;
    Ok(SignalAttribution {
        code,
        name,
        summary: v["summary"].as_str().unwrap_or("").to_string(),
        technical: v["technical"].as_str().unwrap_or("").to_string(),
        fund_flow: v["fund_flow"].as_str().unwrap_or("").to_string(),
        sector: v["sector"].as_str().unwrap_or("").to_string(),
        news: v["news"].as_str().unwrap_or("").to_string(),
        confidence: v["confidence"].as_f64().unwrap_or(0.7),
    })
}

// ==================== 3. 智能预警推荐 ====================

#[derive(Serialize, Deserialize)]
pub struct AlertSuggestion {
    pub code: String,
    pub name: String,
    pub field: String,
    pub op: String,
    pub value: f64,
    pub reason: String,
    pub priority: String,
}

const SYSTEM_ALERT: &str = "你是 A 股预警策略师。基于用户自选股的实时行情和近期波动，推荐应该设置的预警规则。可用字段：price（价格）、pct（涨跌幅%）、volume_ratio（量比）、turnover（换手率%）、speed5m（5分钟涨速%）、amount（成交额）。运算符：>=、<=、>、<、crossUp、crossDown。输出严格 JSON 数组，每条：{\"code\":\"股票代码\",\"name\":\"股票名称\",\"field\":\"字段名\",\"op\":\"运算符\",\"value\":阈值数字,\"reason\":\"推荐理由（60字内）\",\"priority\":\"high/medium/low\"}。返回 3-5 条推荐。只输出 JSON 数组。";

#[tauri::command]
pub async fn ai_suggest_alerts(
    state: tauri::State<'_, super::AiState>,
    watchlist: Vec<String>,
) -> Result<Vec<AlertSuggestion>, String> {
    let (cfg, key) = load_cfg(&state.dir())?;

    // 拉取自选股行情
    let quotes = market::get_quotes(watchlist.clone()).await.unwrap_or_default();
    let quote_text: Vec<String> = quotes
        .iter()
        .map(|q| {
            format!(
                "{}({}) 现价 {:.2} 涨跌幅 {:+.2}% 量比 {:.2} 换手 {:.2}% 成交额 {:.0}",
                q.name, q.code, q.price, q.pct, q.volume_ratio, q.turnover, q.amount
            )
        })
        .collect();

    let user = format!(
        "【自选股行情】\n{}\n\n请基于以上自选股的实时行情和波动特征，推荐 3-5 条应该设置的预警规则。优先推荐高波动、临近关键价位、量能异常的标的。",
        quote_text.join("\n")
    );

    let v = call_llm_json(&cfg, &key, SYSTEM_ALERT, &user).await?;
    let arr = v.as_array().ok_or("AI 未返回数组")?;
    let suggestions: Vec<AlertSuggestion> = arr
        .iter()
        .map(|item| AlertSuggestion {
            code: item["code"].as_str().unwrap_or("").to_string(),
            name: item["name"].as_str().unwrap_or("").to_string(),
            field: item["field"].as_str().unwrap_or("").to_string(),
            op: item["op"].as_str().unwrap_or(">=").to_string(),
            value: item["value"].as_f64().unwrap_or(0.0),
            reason: item["reason"].as_str().unwrap_or("").to_string(),
            priority: item["priority"].as_str().unwrap_or("medium").to_string(),
        })
        .collect();
    Ok(suggestions)
}

// ==================== 4. 资讯聚合 ====================

#[derive(Serialize, Deserialize)]
pub struct NewsDigestItem {
    pub title: String,
    pub summary: String,
    pub category: String,
    pub related_codes: Vec<String>,
    pub time: String,
    pub url: String,
}

#[derive(Serialize, Deserialize)]
pub struct NewsDigest {
    pub generated_at: i64,
    pub macro_count: usize,
    pub industry_count: usize,
    pub stock_count: usize,
    pub items: Vec<NewsDigestItem>,
}

const SYSTEM_NEWS: &str = "你是 A 股资讯聚合分析师。对给定的盘中快讯列表进行去重、分类和摘要。分类仅限：macro（宏观/政策）、industry（行业/板块）、stock（个股）。每条输出：{\"title\":\"提炼的标题（20字内）\",\"summary\":\"摘要（60字内）\",\"category\":\"macro/industry/stock\",\"related_codes\":[\"关联股票代码1\",\"关联股票代码2\"],\"time\":\"原文时间\",\"url\":\"原文链接\"}。输出 JSON 数组。只输出 JSON。";

#[tauri::command]
pub async fn ai_news_digest(state: tauri::State<'_, super::AiState>) -> Result<NewsDigest, String> {
    let (cfg, key) = load_cfg(&state.dir())?;

    // 拉取最近 30 条快讯
    let news = match market::get_news_flash(1, 30).await {
        Ok(list) => list,
        Err(_) => Vec::new(),
    };
    let news_text: Vec<String> = news
        .iter()
        .map(|n| format!("[{}] {} | tags:{} | url:{}", n.time, n.text, n.tags.join(","), n.url))
        .collect();

    let user = format!(
        "【快讯列表】\n{}\n\n请对以上快讯进行去重、分类和摘要，输出 JSON 数组。",
        news_text.join("\n")
    );

    let v = call_llm_json(&cfg, &key, SYSTEM_NEWS, &user).await?;
    let arr = v.as_array().ok_or("AI 未返回数组")?;
    let items: Vec<NewsDigestItem> = arr
        .iter()
        .map(|item| NewsDigestItem {
            title: item["title"].as_str().unwrap_or("").to_string(),
            summary: item["summary"].as_str().unwrap_or("").to_string(),
            category: item["category"].as_str().unwrap_or("macro").to_string(),
            related_codes: item["related_codes"]
                .as_array()
                .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                .unwrap_or_default(),
            time: item["time"].as_str().unwrap_or("").to_string(),
            url: item["url"].as_str().unwrap_or("").to_string(),
        })
        .collect();

    let macro_count = items.iter().filter(|i| i.category == "macro").count();
    let industry_count = items.iter().filter(|i| i.category == "industry").count();
    let stock_count = items.iter().filter(|i| i.category == "stock").count();

    Ok(NewsDigest {
        generated_at: super::now_millis(),
        macro_count,
        industry_count,
        stock_count,
        items,
    })
}

// ==================== 5. 明日主线 ====================

#[derive(Serialize, Deserialize)]
pub struct MainlineTheme {
    pub theme: String,
    pub logic: String,
    pub leaders: Vec<String>,
    pub catalysts: Vec<String>,
    pub risk: String,
    pub strength: String,
}

#[derive(Serialize, Deserialize)]
pub struct TomorrowMainline {
    pub generated_at: i64,
    pub market_review: String,
    pub themes: Vec<MainlineTheme>,
    pub overall_risk: String,
}

const SYSTEM_MAINLINE: &str = "你是 A 股明日主线预测分析师。基于当日涨停池（连板梯队）、板块涨跌和最新快讯，预测明日 3-5 条市场主线。每条主线输出：{\"theme\":\"主线名称（15字内）\",\"logic\":\"核心逻辑（80字内）\",\"leaders\":[\"龙头标的1\",\"龙头标的2\"],\"catalysts\":[\"催化因素1\",\"催化因素2\"],\"risk\":\"风险提示（40字内）\",\"strength\":\"strong/medium/weak\"}。另需 market_review（今日市场一句话复盘，80字内）和 overall_risk（整体风险提示，60字内）。输出严格 JSON：{\"market_review\":\"...\",\"themes\":[...],\"overall_risk\":\"...\"}。只输出 JSON。";

#[tauri::command]
pub async fn ai_tomorrow_mainline(state: tauri::State<'_, super::AiState>) -> Result<TomorrowMainline, String> {
    let (cfg, key) = load_cfg(&state.dir())?;
    let today = market::today_yyyymmdd();

    // 并行获取涨停池/炸板池/板块/快讯
    let (zt_res, zb_res, sec, news) = tokio::join!(
        market::get_zt_pool(today.clone()),
        market::get_zb_pool(today.clone()),
        sector_summary(),
        news_summary(15)
    );

    let zt_text = match zt_res {
        Ok(pool) => {
            let items: Vec<String> = pool
                .list
                .iter()
                .take(30)
                .map(|s| format!("{}({}) {}板 封单{:.0}万 行业:{}", s.name, s.code, s.boards, s.fund / 10000.0, s.industry))
                .collect();
            format!("涨停 {} 家：\n{}", pool.total, items.join("\n"))
        }
        Err(_) => "涨停池数据暂不可用".to_string(),
    };
    let zb_text = match zb_res {
        Ok(pool) => {
            let names: Vec<&str> = pool.list.iter().take(10).map(|s| s.name.as_str()).collect();
            format!("炸板 {} 家：{}", pool.total, names.join("、"))
        }
        Err(_) => "炸板池数据暂不可用".to_string(),
    };

    let user = format!(
        "【涨停池】\n{}\n【炸板池】{}\n【板块】{}\n【最新快讯】\n{}\n\n请基于以上数据，预测明日市场主线。",
        zt_text, zb_text, sec, news
    );

    let v = call_llm_json(&cfg, &key, SYSTEM_MAINLINE, &user).await?;

    let themes_arr = v["themes"].as_array().ok_or("AI 未返回 themes 数组")?;
    let themes: Vec<MainlineTheme> = themes_arr
        .iter()
        .map(|t| MainlineTheme {
            theme: t["theme"].as_str().unwrap_or("").to_string(),
            logic: t["logic"].as_str().unwrap_or("").to_string(),
            leaders: t["leaders"]
                .as_array()
                .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                .unwrap_or_default(),
            catalysts: t["catalysts"]
                .as_array()
                .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                .unwrap_or_default(),
            risk: t["risk"].as_str().unwrap_or("").to_string(),
            strength: t["strength"].as_str().unwrap_or("medium").to_string(),
        })
        .collect();

    Ok(TomorrowMainline {
        generated_at: super::now_millis(),
        market_review: v["market_review"].as_str().unwrap_or("").to_string(),
        themes,
        overall_risk: v["overall_risk"].as_str().unwrap_or("").to_string(),
    })
}

// ==================== 个股资讯摘要 ====================

#[tauri::command]
pub async fn ai_news_for_stock(
    state: tauri::State<'_, super::AiState>,
    code: String,
    name: String,
) -> Result<String, String> {
    let (cfg, key) = load_cfg(&state.dir())?;
    let news = news_summary(20).await;

    let system = "你是 A 股个股资讯分析师。从给定的快讯列表中筛选与指定个股相关的资讯，生成一段个股资讯摘要（150字内），包含利好/利空判断。如果没有相关资讯，说明暂无重大资讯。只输出摘要文字。";
    let user = format!("【标的】{} ({})\n【快讯列表】\n{}\n\n请生成该个股的资讯摘要。", name, code, news);

    call_llm_text(&cfg, &key, system, &user).await
}

// ==================== 流式版本 command（v2.25.6） ====================
// 通过 Tauri event 逐块推送 AI 响应，前端边接收边渲染。
// 事件名: ai:stream:{stream_id}
// payload: {type: "delta", content: "..."} | {type: "done", full_text: "..."} | {type: "error", message: "..."}

fn emit_stream(app: &tauri::AppHandle, stream_id: &str, payload: &serde_json::Value) {
    let _ = app.emit(&format!("ai:stream:{}", stream_id), payload);
}

#[tauri::command]
pub async fn ai_intraday_commentary_stream(
    state: tauri::State<'_, super::AiState>,
    app_handle: tauri::AppHandle,
    stream_id: String,
) -> Result<(), String> {
    let (cfg, key) = match load_cfg(&state.dir()) {
        Ok(v) => v,
        Err(e) => { emit_stream(&app_handle, &stream_id, &json!({"type":"error","message":e})); return Err(e); }
    };
    let (idx, sec, zt, news) = tokio::join!(index_summary(), sector_summary(), zt_summary(), news_summary(8));
    let user = format!("【大盘指数】{}\n【板块】{}\n【涨停池】{}\n【最新快讯】\n{}\n\n请基于以上数据，生成当前盘中市场解读。", idx, sec, zt, news);

    let app = app_handle.clone();
    let sid = stream_id.clone();
    let result = call_llm_text_stream(&cfg, &key, SYSTEM_INTRADAY, &user, move |delta| {
        emit_stream(&app, &sid, &json!({"type":"delta","content":delta}));
    }).await;

    match result {
        Ok(full) => { emit_stream(&app_handle, &stream_id, &json!({"type":"done","full_text":full})); Ok(()) }
        Err(e) => { emit_stream(&app_handle, &stream_id, &json!({"type":"error","message":e})); Err(e) }
    }
}

#[tauri::command]
pub async fn ai_news_digest_stream(
    state: tauri::State<'_, super::AiState>,
    app_handle: tauri::AppHandle,
    stream_id: String,
) -> Result<(), String> {
    let (cfg, key) = match load_cfg(&state.dir()) {
        Ok(v) => v,
        Err(e) => { emit_stream(&app_handle, &stream_id, &json!({"type":"error","message":e})); return Err(e); }
    };
    let news = match market::get_news_flash(1, 30).await { Ok(list) => list, Err(_) => Vec::new() };
    let news_text: Vec<String> = news.iter().map(|n| format!("[{}] {} | tags:{} | url:{}", n.time, n.text, n.tags.join(","), n.url)).collect();
    let user = format!("【快讯列表】\n{}\n\n请对以上快讯进行去重、分类和摘要，输出 JSON 数组。", news_text.join("\n"));

    let app = app_handle.clone();
    let sid = stream_id.clone();
    let result = call_llm_text_stream(&cfg, &key, SYSTEM_NEWS, &user, move |delta| {
        emit_stream(&app, &sid, &json!({"type":"delta","content":delta}));
    }).await;

    match result {
        Ok(full) => { emit_stream(&app_handle, &stream_id, &json!({"type":"done","full_text":full})); Ok(()) }
        Err(e) => { emit_stream(&app_handle, &stream_id, &json!({"type":"error","message":e})); Err(e) }
    }
}

#[tauri::command]
pub async fn ai_tomorrow_mainline_stream(
    state: tauri::State<'_, super::AiState>,
    app_handle: tauri::AppHandle,
    stream_id: String,
) -> Result<(), String> {
    let (cfg, key) = match load_cfg(&state.dir()) {
        Ok(v) => v,
        Err(e) => { emit_stream(&app_handle, &stream_id, &json!({"type":"error","message":e})); return Err(e); }
    };
    let today = market::today_yyyymmdd();
    let (zt_res, zb_res, sec, news) = tokio::join!(
        market::get_zt_pool(today.clone()),
        market::get_zb_pool(today.clone()),
        sector_summary(),
        news_summary(15)
    );
    let zt_text = match zt_res {
        Ok(pool) => { let items: Vec<String> = pool.list.iter().take(30).map(|s| format!("{}({}) {}板 封单{:.0}万 行业:{}", s.name, s.code, s.boards, s.fund/10000.0, s.industry)).collect(); format!("涨停 {} 家：\n{}", pool.total, items.join("\n")) }
        Err(_) => "涨停池数据暂不可用".to_string(),
    };
    let zb_text = match zb_res {
        Ok(pool) => { let names: Vec<&str> = pool.list.iter().take(10).map(|s| s.name.as_str()).collect(); format!("炸板 {} 家：{}", pool.total, names.join("、")) }
        Err(_) => "炸板池数据暂不可用".to_string(),
    };
    let user = format!("【涨停池】\n{}\n【炸板池】{}\n【板块】{}\n【最新快讯】\n{}\n\n请基于以上数据，推演明日市场主线。", zt_text, zb_text, sec, news);

    let app = app_handle.clone();
    let sid = stream_id.clone();
    let result = call_llm_text_stream(&cfg, &key, SYSTEM_MAINLINE, &user, move |delta| {
        emit_stream(&app, &sid, &json!({"type":"delta","content":delta}));
    }).await;

    match result {
        Ok(full) => { emit_stream(&app_handle, &stream_id, &json!({"type":"done","full_text":full})); Ok(()) }
        Err(e) => { emit_stream(&app_handle, &stream_id, &json!({"type":"error","message":e})); Err(e) }
    }
}
