// Tauri 命令集（v2.27 巨石拆分：从 lib.rs 抽出）。
// 命令数量护栏见 src-tauri/INVENTORY.md；增删命令必须同步清单与 generate_handler!。
// 错误新代码优先用 crate::error::AppError；存量 String 错误按域逐步迁移。
use crate::ai;
use crate::logging;
use crate::market;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::{Manager, State, WebviewUrl, WebviewWindowBuilder};

#[tauri::command]
pub(crate) async fn get_quotes(codes: Vec<String>) -> Result<Vec<market::Quote>, String> {
    market::get_quotes(codes).await
}

#[tauri::command]
pub(crate) async fn get_kline(
    code: String,
    period: i64,
    count: i64,
) -> Result<Vec<market::KBar>, String> {
    market::get_kline(code, period, count).await
}

#[tauri::command]
pub(crate) async fn get_minute(code: String) -> Result<Vec<market::KBar>, String> {
    market::get_minute(code).await
}

#[tauri::command]
pub(crate) async fn get_hist_minute(
    code: String,
    date: String,
) -> Result<Vec<market::KBar>, String> {
    market::get_hist_minute(code, date).await
}

#[tauri::command]
pub(crate) async fn get_hist_minute_days(
    code: String,
    days: i64,
) -> Result<Vec<market::HistDayMinute>, String> {
    market::get_hist_minute_days(code, days).await
}

#[tauri::command]
pub(crate) async fn get_orderbook(code: String) -> Result<market::OrderBook, String> {
    market::get_orderbook(code).await
}

#[tauri::command]
pub(crate) async fn get_trades(code: String, n: i64) -> Result<Vec<market::TradeTick>, String> {
    market::get_trades(code, n).await
}

// v2.32 盘口增强：分价成交分布 / 集合竞价虚拟量 / 封单额趋势（安全降级，不报错）
#[tauri::command]
pub(crate) async fn get_depth_enhance(
    code: String,
) -> Result<market::depth_enhance::DepthEnhance, String> {
    market::depth_enhance::depth_enhance(&code).await
}

#[tauri::command]
pub(crate) async fn get_sectors(kind: String) -> Result<Vec<market::Sector>, String> {
    market::get_sectors(kind).await
}

#[tauri::command]
pub(crate) async fn get_sector_stocks(
    category: String,
    kind: String,
) -> Result<Vec<serde_json::Value>, String> {
    market::get_sector_stocks(category, kind).await
}

#[tauri::command]
pub(crate) async fn get_stock_theme_tags(
    codes: Vec<String>,
) -> Result<Vec<market::eastmoney::StockThemeTags>, String> {
    market::eastmoney::stock_theme_tags(&codes).await
}

#[tauri::command]
pub(crate) async fn get_screener(
    filter: market::ScreenFilter,
) -> Result<Vec<market::ScreenResult>, String> {
    market::get_screener(filter).await
}

#[tauri::command]
pub(crate) async fn search_stocks(keyword: String) -> Result<Vec<market::StockItem>, String> {
    market::search_stocks(keyword).await
}

#[tauri::command]
pub(crate) async fn get_index_quotes() -> Result<Vec<market::Quote>, String> {
    market::get_index_quotes().await
}

#[tauri::command]
pub(crate) async fn get_rank_page(
    sort: String,
    page: i64,
    num: i64,
) -> Result<Vec<market::Quote>, String> {
    market::get_rank_page(sort, page, num).await
}

#[tauri::command]
pub(crate) async fn get_rank_board(
    sort: String,
    page: i64,
    num: i64,
    scope: Option<String>,
) -> Result<Vec<market::RankRow>, String> {
    market::get_rank_board(sort, page, num, scope.unwrap_or_else(|| "a".into())).await
}

#[tauri::command]
pub(crate) async fn get_fund_flow(
    code: String,
    days: i64,
) -> Result<market::fundflow::StockFundFlow, String> {
    market::fundflow::fund_flow(&code, days).await
}

#[tauri::command]
pub(crate) async fn get_market_fund_panorama(
    days: i64,
) -> Result<market::fundflow::MarketFundPanorama, String> {
    market::fundflow::market_panorama(days).await
}

#[tauri::command]
pub(crate) async fn get_fund_rank(
    kind: String,
) -> Result<Vec<market::fundflow::FundRankRow>, String> {
    market::fundflow::fund_rank(&kind).await
}

/// 采集并落盘指定交易日（YYYYMMDD）行业/概念板块快照；用于收盘归档与历史补采
#[tauri::command]
pub(crate) async fn sector_day_snapshot(
    ai: State<'_, crate::ai::AiState>,
    day: String,
) -> Result<usize, String> {
    let dir = ai.dir();
    market::sector_day::snapshot_day(&dir, &day).await
}

/// 查询某类板块（industry/concept）最近 N 个交易日的日级快照
#[tauri::command]
pub(crate) async fn sector_day_query(
    ai: State<'_, crate::ai::AiState>,
    kind: String,
    days: i64,
) -> Result<Vec<market::sector_day::SectorDayRow>, String> {
    let dir = ai.dir();
    market::sector_day::query(&dir, &kind, days)
}

/// 已积累的板块快照交易日数量
#[tauri::command]
pub(crate) async fn sector_day_stats(ai: State<'_, crate::ai::AiState>) -> Result<i64, String> {
    market::sector_day::stats(&ai.dir())
}

#[tauri::command]
pub(crate) async fn get_news_flash(page: i64, size: i64) -> Result<Vec<market::NewsItem>, String> {
    market::get_news_flash(page, size).await
}

#[tauri::command]
pub(crate) async fn check_latest() -> Result<market::LatestInfo, String> {
    market::check_latest().await
}

#[tauri::command]
pub(crate) async fn get_f10_profile(code: String) -> Result<market::f10::CompanyProfile, String> {
    market::f10::get_profile(code).await
}

#[tauri::command]
pub(crate) async fn get_f10_finance(code: String) -> Result<market::f10::FinanceReport, String> {
    market::f10::get_finance(code).await
}

#[tauri::command]
pub(crate) async fn get_f10_chips(code: String) -> Result<market::f10::ChipDistribution, String> {
    market::f10::get_chips(code).await
}

#[tauri::command]
pub(crate) async fn get_ipo_list() -> Result<Vec<market::cninfo::IpoItem>, String> {
    market::cninfo::get_ipo_list().await
}

#[tauri::command]
pub(crate) async fn get_restricted_queue(
    code: String,
) -> Result<Vec<market::cninfo::RestrictedItem>, String> {
    market::cninfo::get_restricted_queue(code).await
}

#[tauri::command]
pub(crate) async fn get_market_restricted(
    start: String,
    end: String,
    page: i64,
    size: i64,
) -> Result<market::eastmoney::MarketRestrictedPage, String> {
    market::eastmoney::market_restricted(&start, &end, page, size).await
}

// ===== 集合竞价 / 涨停池明细 =====
#[tauri::command]
pub(crate) async fn get_auction() -> Result<market::eastmoney::AuctionData, String> {
    market::get_auction().await
}

#[tauri::command]
pub(crate) async fn get_auction_page(
    page: i64,
    asc: i32,
) -> Result<Vec<market::eastmoney::AuctionStock>, String> {
    market::sina::auction_page(page, asc).await
}

#[tauri::command]
pub(crate) async fn get_zt_pool(date: String) -> Result<market::eastmoney::ZtPool, String> {
    market::get_zt_pool(date).await
}

#[tauri::command]
pub(crate) async fn get_zb_pool(date: String) -> Result<market::eastmoney::ZtPool, String> {
    market::get_zb_pool(date).await
}

#[tauri::command]
pub(crate) async fn get_announcements(
    date: String,
) -> Result<Vec<market::announce::AnnounceItem>, String> {
    market::announce::announcements(date, 100).await
}

// ===== 互动易 / 上证 e 互动（两源独立失败，返回空/部分 Vec，不出 Err）=====
#[tauri::command]
pub(crate) async fn get_irm_latest() -> Vec<market::irminteract::IrmItem> {
    market::irminteract::irm_latest().await
}

// ===== v1.9 AI 慢脑命令 =====
#[tauri::command]
pub(crate) fn ai_get_config(
    state: tauri::State<ai::AiState>,
) -> Result<ai::config::AiConfig, String> {
    let db = ai::vectordb::open(&state.dir().join("ai.db"))?;
    ai::config::load_config(&db.0)
}

#[tauri::command]
pub(crate) fn ai_save_config(
    state: tauri::State<ai::AiState>,
    cfg: ai::config::AiConfig,
) -> Result<(), String> {
    let db = ai::vectordb::open(&state.dir().join("ai.db"))?;
    ai::config::save_config(&db.0, &cfg)
}

/// 云 Key 的系统凭据箱定位（服务名/账户固定）。
pub(crate) fn cloud_secret() -> ai::config::KeyringSecret {
    ai::config::KeyringSecret {
        service: "tickgold.ai.cloud-key".to_string(),
        user: "default".to_string(),
    }
}

#[tauri::command]
pub(crate) fn ai_get_cloud_key_set() -> bool {
    matches!(ai::config::SecretStore::get(&cloud_secret()), Ok(Some(_)))
}

#[tauri::command]
pub(crate) fn ai_set_cloud_key(secret: String) -> Result<(), String> {
    ai::config::SecretStore::set(&cloud_secret(), secret.trim())
}

#[tauri::command]
pub(crate) fn ai_clear_cloud_key() -> Result<(), String> {
    ai::config::SecretStore::erase(&cloud_secret())
}

#[tauri::command]
pub(crate) async fn ai_test_connection(
    state: tauri::State<'_, ai::AiState>,
) -> Result<serde_json::Value, String> {
    let cfg = {
        let db = ai::vectordb::open(&state.dir().join("ai.db"))?;
        ai::config::load_config(&db.0)?
    };
    let key = if cfg.provider == "cloud" {
        ai::config::SecretStore::get(&cloud_secret())?
    } else {
        None
    };
    let info = ai::provider::list_models(&cfg, &key).await?;
    Ok(serde_json::json!({"latencyMs": info.latency_ms, "models": info.models}))
}

#[tauri::command]
pub(crate) fn ai_new_session(state: tauri::State<ai::AiState>) -> Result<i64, String> {
    let db = ai::vectordb::open(&state.dir().join("ai.db"))?;
    ai::vectordb::create_session(&db.0, "")
}

#[tauri::command]
pub(crate) fn ai_list_sessions(
    state: tauri::State<ai::AiState>,
) -> Result<Vec<ai::vectordb::SessionRow>, String> {
    let db = ai::vectordb::open(&state.dir().join("ai.db"))?;
    ai::vectordb::list_sessions(&db.0)
}

#[tauri::command]
pub(crate) fn ai_load_session(
    state: tauri::State<ai::AiState>,
    session_id: i64,
) -> Result<Vec<AiMsgOut>, String> {
    // vectordb::MsgRow 未派生 Serialize（Tauri IPC 要求），在命令边界映射为可序列化 DTO；
    // 字段名与 MsgRow 原样一致（snake_case）。
    let db = ai::vectordb::open(&state.dir().join("ai.db"))?;
    let rows = ai::vectordb::list_messages(&db.0, session_id, 100)?;
    Ok(rows
        .into_iter()
        .map(|m| AiMsgOut {
            id: m.id,
            role: m.role,
            content: m.content,
            tool_calls: m.tool_calls,
            refs: m.refs,
            created_at: m.created_at,
        })
        .collect())
}

/// ai_load_session 的 IPC 输出行（与 ai::vectordb::MsgRow 同字段）。
#[derive(serde::Serialize)]
pub(crate) struct AiMsgOut {
    id: i64,
    role: String,
    content: String,
    tool_calls: String,
    refs: String,
    created_at: i64,
}

#[tauri::command]
pub(crate) fn ai_delete_session(
    state: tauri::State<ai::AiState>,
    session_id: i64,
) -> Result<(), String> {
    let db = ai::vectordb::open(&state.dir().join("ai.db"))?;
    ai::vectordb::delete_session(&db.0, session_id)
}

#[tauri::command]
pub(crate) async fn ai_chat_send(
    app: tauri::AppHandle,
    state: tauri::State<'_, ai::AiState>,
    registry: tauri::State<'_, ai::AbortRegistry>,
    session_id: i64,
    text: String,
) -> Result<(), String> {
    let (cfg, key, data_dir) = {
        let db = ai::vectordb::open(&state.dir().join("ai.db"))?;
        let cfg = ai::config::load_config(&db.0)?;
        let key = if cfg.provider == "cloud" {
            ai::config::SecretStore::get(&cloud_secret())?
        } else {
            None
        };
        (cfg, key, state.dir().clone())
    };
    // flags 是 Arc<Mutex<HashSet>>：克隆 Arc 与 spawn 共享，中止命令可即时置位
    let reg = ai::AbortRegistry {
        flags: registry.flags.clone(),
    };
    tauri::async_runtime::spawn(async move {
        if let Err(e) =
            ai::agent::run_turn(&app, &data_dir, &reg, &cfg, key, session_id, text).await
        {
            log::error!("AI 对话失败: {e}");
        }
    });
    Ok(())
}

#[tauri::command]
pub(crate) fn ai_chat_abort(
    registry: tauri::State<ai::AbortRegistry>,
    session_id: i64,
) -> Result<(), String> {
    registry.abort(session_id);
    Ok(())
}

#[tauri::command]
pub(crate) fn ai_kb_stats(
    state: tauri::State<ai::AiState>,
) -> Result<ai::vectordb::KbStats, String> {
    let db = ai::vectordb::open(&state.dir().join("ai.db"))?;
    ai::vectordb::stats(&db.0)
}

#[tauri::command]
pub(crate) fn ai_list_docs(state: tauri::State<ai::AiState>) -> Result<Vec<(String, i64)>, String> {
    let db = ai::vectordb::open(&state.dir().join("ai.db"))?;
    ai::vectordb::list_sources(&db.0, "manual_doc")
}

#[tauri::command]
pub(crate) async fn ai_import_docs(
    state: tauri::State<'_, ai::AiState>,
) -> Result<Vec<String>, String> {
    let files = rfd::AsyncFileDialog::new()
        .add_filter("文本文档", &["md", "txt"])
        .pick_files()
        .await
        .ok_or_else(|| "已取消选择".to_string())?;
    let mut imported = vec![];
    for f in files {
        let name = f.file_name();
        let is_md = name.to_lowercase().ends_with(".md");
        let bytes = tokio::fs::read(f.path()).await.map_err(|e| e.to_string())?;
        let content = String::from_utf8(bytes)
            .map_err(|_| format!("{name} 不是 UTF-8 文本，请转码后再导入"))?;
        let n = ai::ingest::ingest_document(&state.dir(), &name, &content, is_md)?;
        if n > 0 {
            imported.push(name);
        }
    }
    Ok(imported)
}

#[tauri::command]
pub(crate) fn ai_delete_doc(
    state: tauri::State<ai::AiState>,
    file_name: String,
) -> Result<usize, String> {
    let db = ai::vectordb::open(&state.dir().join("ai.db"))?;
    ai::vectordb::delete_by_source_ref(&db.0, "manual_doc", &file_name)
}

#[tauri::command]
pub(crate) async fn ai_reindex(state: tauri::State<'_, ai::AiState>) -> Result<usize, String> {
    let cfg = {
        let db = ai::vectordb::open(&state.dir().join("ai.db"))?;
        ai::config::load_config(&db.0)?
    };
    let key = if cfg.provider == "cloud" {
        ai::config::SecretStore::get(&cloud_secret())?
    } else {
        None
    };
    let embedder = ai::provider::HttpEmbedder {
        cfg: cfg.clone(),
        api_key: key,
    };
    ai::ingest::embed_pending(&state.dir(), &cfg, &embedder, None, 100_000).await
}

#[tauri::command]
pub(crate) async fn ai_index_daily(
    state: tauri::State<'_, ai::AiState>,
    trade_date: String,
) -> Result<usize, String> {
    let cfg = {
        let db = ai::vectordb::open(&state.dir().join("ai.db"))?;
        ai::config::load_config(&db.0)?
    };
    let key = if cfg.provider == "cloud" {
        ai::config::SecretStore::get(&cloud_secret())?
    } else {
        None
    };
    let embedder = ai::provider::HttpEmbedder {
        cfg: cfg.clone(),
        api_key: key,
    };
    ai::ingest::index_day(&state.dir(), &cfg, &embedder, &trade_date, None).await
}

// ===== v2.0 AI 决策：特征包 / 三层复盘 / 作战计划 =====
/// 加载慢脑配置与云 Key（复盘 / 计划命令共用）。
pub(crate) fn load_brain(
    state: &tauri::State<'_, ai::AiState>,
) -> Result<(ai::config::AiConfig, Option<String>, std::path::PathBuf), String> {
    let db = ai::vectordb::open(&state.dir().join("ai.db"))?;
    let cfg = ai::config::load_config(&db.0)?;
    let key = if cfg.provider == "cloud" {
        ai::config::SecretStore::get(&cloud_secret())?
    } else {
        None
    };
    Ok((cfg, key, state.dir()))
}

#[tauri::command]
pub(crate) async fn ai_build_decision_pack(
    state: tauri::State<'_, ai::AiState>,
    date: Option<String>,
app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    crate::license::require_pro(&app)?;
    let dir = state.dir();
    tauri::async_runtime::spawn_blocking(move || ai::decision::build_pack(&dir, date.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}

// v2.32 盯盘复盘报告数据包（聚合四大块，盘后读本地库）
#[tauri::command]
pub(crate) async fn ai_build_review_report(
    state: tauri::State<'_, ai::AiState>,
    date: Option<String>,
app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    crate::license::require_pro(&app)?;
    let dir = state.dir();
    tauri::async_runtime::spawn_blocking(move || ai::report::build_report(&dir, date.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn ai_run_review(
    state: tauri::State<'_, ai::AiState>,
    date: Option<String>,
    force: bool,
app: tauri::AppHandle) -> Result<Vec<ai::review::ReviewSummary>, String> {
    crate::license::require_pro(&app)?;
    let (cfg, key, dir) = load_brain(&state)?;
    ai::review::run_review(&dir, &cfg, &key, date.as_deref(), force).await
}

#[tauri::command]
pub(crate) fn ai_list_reviews(
    state: tauri::State<ai::AiState>,
    date: String,
) -> Result<Vec<ai::review::ReviewSummary>, String> {
    ai::review::list_reviews(&state.dir(), &date)
}

#[tauri::command]
pub(crate) fn ai_get_review(
    state: tauri::State<ai::AiState>,
    id: i64,
) -> Result<serde_json::Value, String> {
    ai::review::get_review(&state.dir(), id)
}

#[tauri::command]
pub(crate) async fn ai_generate_plan(
    state: tauri::State<'_, ai::AiState>,
    profile_key: Option<String>,
    review_date: Option<String>,
) -> Result<serde_json::Value, String> {
    let (cfg, key, dir) = load_brain(&state)?;
    ai::plan::generate_plan(
        &dir,
        &cfg,
        &key,
        profile_key.as_deref(),
        review_date.as_deref(),
    )
    .await
}

#[tauri::command]
pub(crate) fn ai_get_latest_plan(
    state: tauri::State<ai::AiState>,
) -> Result<serde_json::Value, String> {
    ai::plan::get_latest_plan(&state.dir())
}

#[tauri::command]
pub(crate) fn ai_get_plan(
    state: tauri::State<ai::AiState>,
    id: i64,
) -> Result<serde_json::Value, String> {
    ai::plan::get_plan(&state.dir(), id)
}

#[tauri::command]
pub(crate) fn ai_set_plan_status(
    state: tauri::State<ai::AiState>,
    id: i64,
    status: String,
) -> Result<(), String> {
    ai::plan::set_plan_status(&state.dir(), id, &status)
}

#[tauri::command]
pub(crate) fn ai_update_plan_text(
    state: tauri::State<ai::AiState>,
    id: i64,
    field: String,
    value: String,
) -> Result<(), String> {
    ai::plan::update_plan_text(&state.dir(), id, &field, &value)
}

#[tauri::command]
pub(crate) fn ai_update_instruction(
    state: tauri::State<ai::AiState>,
    instr_id: i64,
    field: String,
    value: String,
) -> Result<(), String> {
    ai::plan::update_instruction(&state.dir(), instr_id, &field, &value)
}

#[tauri::command]
pub(crate) fn ai_convert_instruction_alert(
    state: tauri::State<ai::AiState>,
    instr_id: i64,
) -> Result<String, String> {
    ai::plan::convert_instruction_to_alert(&state.dir(), instr_id)
}

// ===== 龙虎榜复盘 =====
#[tauri::command]
pub(crate) async fn get_lhb_list(date: String) -> Result<market::eastmoney::LhbList, String> {
    market::eastmoney::lhb_list(&date).await
}

#[tauri::command]
pub(crate) async fn get_lhb_detail(
    code: String,
    date: String,
) -> Result<market::eastmoney::LhbDetail, String> {
    market::eastmoney::lhb_detail(&code, &date).await
}

#[tauri::command]
pub(crate) async fn get_seat_back(code: String) -> Result<market::eastmoney::SeatBack, String> {
    market::eastmoney::seat_back(&code).await
}

#[tauri::command]
pub(crate) async fn get_seat_trades(
    code: String,
    size: i64,
    page: i64,
) -> Result<market::eastmoney::SeatTrades, String> {
    market::eastmoney::seat_trades(&code, size, page).await
}

// ===== v2.1 快脑 / 自动执行 / 决策日志 =====
#[tauri::command]
pub(crate) fn autoexec_get_config(
    ctl: tauri::State<'_, Arc<ai::autoexec::AutoExecCtl>>,
) -> Result<ai::autoexec::AutoExecConfig, String> {
    Ok(ctl.config.lock().unwrap().clone())
}

#[tauri::command]
pub(crate) async fn autoexec_start(
    app: tauri::AppHandle,
    ai_state: tauri::State<'_, ai::AiState>,
    ctl: tauri::State<'_, Arc<ai::autoexec::AutoExecCtl>>,
    mgr: tauri::State<'_, crate::broker::BrokerManager>,
    cfg: ai::autoexec::AutoExecConfig,
) -> Result<(), String> {
    // P1-2 程序化交易硬隔离：全自动模式与实盘互斥（防未来实盘链路下程序化自动下单）
    let live = mgr.config.lock().unwrap().live_enabled;
    if (cfg.trade_mode == "full" || cfg.full_auto_mode) && live {
        return Err(
            "全自动模式与实盘互斥：请先在「券商通道」关闭实盘开关，再启动全自动（全自动仅限模拟盘）"
                .to_string(),
        );
    }
    *ctl.config.lock().unwrap() = cfg.clone();
    if ctl.running.load(Ordering::Acquire) {
        return Ok(());
    }
    ctl.running.store(true, Ordering::Release);
    let data_dir = ai_state.dir();
    let c: Arc<ai::autoexec::AutoExecCtl> = ctl.inner().clone();
    tauri::async_runtime::spawn(async move {
        ai::autoexec::run_loop(app, c, data_dir).await;
    });
    log::info!("快脑自动执行器已启动（模式 {}）", cfg.brain_mode);
    Ok(())
}

#[tauri::command]
pub(crate) fn autoexec_stop(
    ctl: tauri::State<'_, Arc<ai::autoexec::AutoExecCtl>>,
) -> Result<(), String> {
    ctl.running.store(false, Ordering::Release);
    let mut cfg = ctl.config.lock().unwrap().clone();
    cfg.enabled = false;
    *ctl.config.lock().unwrap() = cfg;
    log::info!("快脑自动执行器已停止");
    Ok(())
}

#[tauri::command]
pub(crate) fn autoexec_set_config(
    ctl: tauri::State<'_, Arc<ai::autoexec::AutoExecCtl>>,
    mgr: tauri::State<'_, crate::broker::BrokerManager>,
    cfg: ai::autoexec::AutoExecConfig,
) -> Result<(), String> {
    // P1-2 程序化交易硬隔离：全自动模式与实盘互斥
    let live = mgr.config.lock().unwrap().live_enabled;
    if (cfg.trade_mode == "full" || cfg.full_auto_mode) && live {
        return Err(
            "全自动模式与实盘互斥：请先在「券商通道」关闭实盘开关，再启用全自动（全自动仅限模拟盘）"
                .to_string(),
        );
    }
    let cur = ctl.config.lock().unwrap().clone();
    let mut c = cfg;
    c.enabled = cur.enabled; // 运行开关仅由 启用/停用/急停 控制，保存参数不改启停
    *ctl.config.lock().unwrap() = c;
    Ok(())
}

#[tauri::command]
pub(crate) async fn laya_health(url: String) -> Result<f64, String> {
    ai::fastbrain::LayaClient::new(&url).health().await
}

#[tauri::command]
pub(crate) fn list_decision_logs(
    state: tauri::State<'_, ai::AiState>,
    date: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<serde_json::Value>, String> {
    let conn = ai::maindb::open_readonly(&state.dir())?;
    let limit = limit.unwrap_or(200).clamp(1, 1000);
    let mut sql = "SELECT id,trade_date,ts,code,name,strategy,instr_id,label,confidence,\
                   probs,features,mode,action,model_version,infer_ms,created_at \
                   FROM decision_log"
        .to_string();
    let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    if let Some(d) = date {
        sql.push_str(" WHERE trade_date=?1");
        params.push(Box::new(d));
    }
    sql.push_str(&format!(" ORDER BY id DESC LIMIT {limit}"));
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(params.iter()), |r| {
            let probs_s: String = r.get(9)?;
            let features_s: String = r.get(10)?;
            Ok(serde_json::json!({
                "id": r.get::<_, i64>(0)?,
                "tradeDate": r.get::<_, String>(1)?,
                "ts": r.get::<_, String>(2)?,
                "code": r.get::<_, String>(3)?,
                "name": r.get::<_, String>(4)?,
                "strategy": r.get::<_, String>(5)?,
                "instrId": r.get::<_, Option<i64>>(6)?,
                "label": r.get::<_, String>(7)?,
                "confidence": r.get::<_, f64>(8)?,
                "probs": serde_json::from_str::<serde_json::Value>(&probs_s).unwrap_or(serde_json::json!({})),
                "features": serde_json::from_str::<serde_json::Value>(&features_s).unwrap_or(serde_json::json!({})),
                "mode": r.get::<_, String>(11)?,
                "action": r.get::<_, String>(12)?,
                "modelVersion": r.get::<_, String>(13)?,
                "inferMs": r.get::<_, f64>(14)?,
                "createdAt": r.get::<_, i64>(15)?,
            }))
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.flatten().collect())
}

#[tauri::command]
pub(crate) async fn start_spider(
    app: tauri::AppHandle,
    watch: Vec<String>,
    ai: tauri::State<'_, crate::ai::AiState>,
    ctl: tauri::State<'_, Arc<market::spider::SpiderCtl>>,
) -> Result<String, String> {
    *ctl.watch.lock().unwrap() = watch;
    if ctl.running.load(Ordering::Acquire) {
        return Ok("already running".to_string());
    }
    ctl.running.store(true, Ordering::Release);
    let c: Arc<market::spider::SpiderCtl> = ctl.inner().clone();
    let data_dir = ai.dir();
    tauri::async_runtime::spawn(async move {
        market::spider::run_loop(app, c, data_dir).await;
    });
    log::info!("短线精灵引擎已启动");
    Ok("started".to_string())
}

/// 读取异动阈值（缺失返回默认值）。
#[tauri::command]
pub(crate) fn spider_get_thresholds(
    ai: tauri::State<'_, crate::ai::AiState>,
) -> Result<market::spider::SpiderThresholds, String> {
    Ok(market::spider::SpiderThresholds::load(&ai.dir()))
}

/// 保存异动阈值：夹紧到合理区间后写 meta，运行中引擎下一快照生效。
#[tauri::command]
pub(crate) fn spider_set_thresholds(
    ai: tauri::State<'_, crate::ai::AiState>,
    thresholds: market::spider::SpiderThresholds,
) -> Result<market::spider::SpiderThresholds, String> {
    let th = market::spider::SpiderThresholds {
        surge_pct: thresholds.surge_pct.clamp(0.05, 20.0),
        big_amount_wan: thresholds.big_amount_wan.clamp(50.0, 100_000.0),
        volume_ratio: thresholds.volume_ratio.clamp(0.5, 50.0),
    };
    let conn = ai::maindb::open_readwrite(&ai.dir())?;
    let json = serde_json::to_string(&th).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO meta(key,value) VALUES(?1,?2)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        rusqlite::params![market::spider::THRESHOLDS_KEY, json],
    )
    .map_err(|e| format!("保存异动阈值失败: {e}"))?;
    log::info!("短线精灵阈值已更新");
    Ok(th)
}

#[tauri::command]
pub(crate) fn stop_spider(
    ctl: tauri::State<'_, Arc<market::spider::SpiderCtl>>,
) -> Result<String, String> {
    ctl.running.store(false, Ordering::Release);
    log::info!("短线精灵引擎已停止");
    Ok("stopped".to_string())
}

#[tauri::command]
pub(crate) async fn start_radar(
    app: tauri::AppHandle,
    ctl: tauri::State<'_, Arc<market::limitup::LimitRadar>>,
) -> Result<String, String> {
    if ctl.running.load(Ordering::Acquire) {
        return Ok("already running".to_string());
    }
    ctl.running.store(true, Ordering::Release);
    let c: Arc<market::limitup::LimitRadar> = ctl.inner().clone();
    tauri::async_runtime::spawn(async move {
        market::limitup::run_loop(app, c).await;
    });
    log::info!("涨停雷达引擎已启动");
    Ok("started".to_string())
}

#[tauri::command]
pub(crate) fn stop_radar(
    ctl: tauri::State<'_, Arc<market::limitup::LimitRadar>>,
) -> Result<String, String> {
    ctl.running.store(false, Ordering::Release);
    log::info!("涨停雷达引擎已停止");
    Ok("stopped".to_string())
}

#[tauri::command]
pub(crate) async fn start_alert_engine(
    app: tauri::AppHandle,
    rules: Vec<market::alert::AlertRule>,
    engine: tauri::State<'_, Arc<market::alert::AlertEngine>>,
) -> Result<String, String> {
    // 每次规则变更都会重新调用：已运行则只更新规则快照
    *engine.rules.lock().unwrap() = rules;
    if engine.running.load(Ordering::Acquire) {
        return Ok("updated".to_string());
    }
    engine.running.store(true, Ordering::Release);
    let e: Arc<market::alert::AlertEngine> = engine.inner().clone();
    tauri::async_runtime::spawn(async move {
        market::alert::run_loop(app, e).await;
    });
    log::info!("预警引擎已启动");
    Ok("started".to_string())
}

#[tauri::command]
pub(crate) fn stop_alert_engine(
    engine: tauri::State<'_, Arc<market::alert::AlertEngine>>,
) -> Result<String, String> {
    engine.running.store(false, Ordering::Release);
    log::info!("预警引擎已停止");
    Ok("stopped".to_string())
}

// ===== 自绘标题栏窗口控制（Rust 端直接操作，绕过前端 ACL 与 drag-region 对点击的干扰）=====
#[tauri::command]
pub(crate) fn win_minimize(app: tauri::AppHandle) -> Result<(), String> {
    let w = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    w.minimize().map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn win_toggle_maximize(app: tauri::AppHandle) -> Result<bool, String> {
    let w = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    if w.is_maximized().map_err(|e| e.to_string())? {
        w.unmaximize().map_err(|e| e.to_string())?;
        Ok(false)
    } else {
        w.maximize().map_err(|e| e.to_string())?;
        Ok(true)
    }
}

#[tauri::command]
pub(crate) fn win_close(app: tauri::AppHandle) -> Result<(), String> {
    let w = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    // 不销毁窗口，隐藏到托盘；这样可从托盘 / 左键托盘重新打开（真正退出走托盘“退出”）
    w.hide().map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn win_is_maximized(app: tauri::AppHandle) -> Result<bool, String> {
    let w = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    w.is_maximized().map_err(|e| e.to_string())
}

// ===== 画中岛：无边框置顶小窗（前端无 set-decorations/position ACL，统一在 Rust 创建）=====
#[tauri::command]
pub(crate) fn open_pip_window(
    app: tauri::AppHandle,
    label: String,
    title: String,
    w: f64,
    h: f64,
    x: Option<f64>,
    y: Option<f64>,
) -> Result<(), String> {
    // 只允许 pip- 前缀 label，避免创建任意窗口
    if !label.starts_with("pip-") {
        return Err("invalid pip label".to_string());
    }
    // 已存在：还原 + 聚焦，不重复开窗
    if let Some(existing) = app.get_webview_window(&label) {
        existing.unminimize().map_err(|e| e.to_string())?;
        existing.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    let mut builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
        .title(title)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(true)
        .shadow(false)
        .min_inner_size(280.0, 180.0)
        .inner_size(w.max(280.0), h.max(180.0));
    if let (Some(px), Some(py)) = (x, y) {
        builder = builder.position(px, py);
    }
    builder.build().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub(crate) fn close_pip_window(app: tauri::AppHandle, label: String) -> Result<(), String> {
    let w = app
        .get_webview_window(&label)
        .ok_or_else(|| "pip window not found".to_string())?;
    w.close().map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn pip_set_always_on_top(
    app: tauri::AppHandle,
    label: String,
    on: bool,
) -> Result<(), String> {
    let w = app
        .get_webview_window(&label)
        .ok_or_else(|| "pip window not found".to_string())?;
    w.set_always_on_top(on).map_err(|e| e.to_string())
}

#[allow(dead_code)]
pub(crate) fn diag_log(msg: &str) {
    use std::io::Write;
    let path = std::env::temp_dir().join("card_win_diag.log");
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = writeln!(
            f,
            "{} {}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0),
            msg
        );
    }
}

// ===== 数据导出：rfd 原生保存对话框选路径，再写入文件（无需 dialog/fs 插件）=====
#[tauri::command]
pub(crate) async fn save_export_file(
    default_name: String,
    content: String,
) -> Result<bool, String> {
    let file = rfd::AsyncFileDialog::new()
        .set_file_name(&default_name)
        .save_file()
        .await
        .ok_or_else(|| "已取消保存".to_string())?;
    let path = file.path().to_path_buf();
    tokio::fs::write(&path, content.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    Ok(true)
}

// ===== 通用打开文本文件（rfd 原生选择对话框；用于导入皮肤 spec，无需 dialog 插件）=====
#[tauri::command]
pub(crate) async fn open_text_file(filter_name: String, ext: String) -> Result<String, String> {
    let file = rfd::AsyncFileDialog::new()
        .add_filter(&filter_name, &[ext.as_str()])
        .pick_file()
        .await
        .ok_or_else(|| "已取消选择".to_string())?;
    let path = file.path().to_path_buf();
    tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| e.to_string())
}

// ===== E2：更新前数据库备份 / 启动损坏自动恢复（失败回滚）=====
const DB_NAME: &str = "stock-dock.db";
const KEEP_BACKUPS: usize = 5;

pub(crate) fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// 是否为备份文件（stock-dock-*.db）
pub(crate) fn is_backup(p: &std::path::Path) -> bool {
    p.file_name()
        .map(|n| n.to_string_lossy().starts_with("stock-dock-"))
        .unwrap_or(false)
        && p.extension().and_then(|x| x.to_str()) == Some("db")
}

/// 仅保留最近 KEEP_BACKUPS 个备份（按修改时间，新→旧）
pub(crate) async fn prune_backups(bdir: &std::path::Path) {
    let Ok(mut rd) = tokio::fs::read_dir(bdir).await else {
        return;
    };
    let mut items: Vec<(std::time::SystemTime, std::path::PathBuf)> = Vec::new();
    while let Ok(Some(ent)) = rd.next_entry().await {
        let p = ent.path();
        if is_backup(&p) {
            if let Ok(md) = ent.metadata().await {
                if let Ok(modified) = md.modified() {
                    items.push((modified, p));
                }
            }
        }
    }
    items.sort_by_key(|item| std::cmp::Reverse(item.0));
    for (_, p) in items.iter().skip(KEEP_BACKUPS) {
        let _ = tokio::fs::remove_file(p).await;
    }
}

/// 更新前备份当前数据库；tag 通常为当前版本号。返回备份文件名。
#[tauri::command]
pub(crate) async fn backup_database(app: tauri::AppHandle, tag: String) -> Result<String, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let src = dir.join(DB_NAME);
    if !src.exists() {
        return Err("数据库文件不存在".to_string());
    }
    let bdir = dir.join("backups");
    tokio::fs::create_dir_all(&bdir)
        .await
        .map_err(|e| e.to_string())?;
    let safe_tag: String = tag
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let fname = format!("stock-dock-{}-{}.db", safe_tag, now_millis());
    let dst = bdir.join(&fname);
    tokio::fs::copy(&src, &dst)
        .await
        .map_err(|e| e.to_string())?;
    prune_backups(&bdir).await;
    Ok(fname)
}

/// 启动时数据库损坏：损坏库重命名留证，再把最近备份恢复为 stock-dock.db。
/// 返回 true=已恢复（前端应 relaunch）；false=无备份。
#[tauri::command]
pub(crate) async fn restore_latest_backup(app: tauri::AppHandle) -> Result<bool, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let bdir = dir.join("backups");
    let Ok(mut rd) = tokio::fs::read_dir(&bdir).await else {
        return Ok(false);
    };
    let mut newest: Option<(std::time::SystemTime, std::path::PathBuf)> = None;
    while let Ok(Some(ent)) = rd.next_entry().await {
        let p = ent.path();
        if is_backup(&p) {
            if let Ok(md) = ent.metadata().await {
                if let Ok(modified) = md.modified() {
                    if newest.as_ref().map(|(t, _)| modified > *t).unwrap_or(true) {
                        newest = Some((modified, p));
                    }
                }
            }
        }
    }
    let Some((_, backup)) = newest else {
        return Ok(false);
    };
    let cur = dir.join(DB_NAME);
    if cur.exists() {
        let corrupt = dir.join(format!("stock-dock.corrupt-{}.db", now_millis()));
        // NTFS 允许重命名已被 SQLite 打开的文件；旧连接随 relaunch 释放
        let _ = tokio::fs::rename(&cur, &corrupt).await;
    }
    tokio::fs::copy(&backup, &cur)
        .await
        .map_err(|e| e.to_string())?;
    Ok(true)
}
// ===== Rust 分级日志：读取 / 清空 / 动态调级（前端可合并前后端日志导出）=====
#[tauri::command]
pub(crate) fn rust_logs(min_level: Option<String>) -> Result<Vec<logging::LogItem>, String> {
    Ok(logging::records(min_level))
}

#[tauri::command]
pub(crate) fn rust_clear_logs() -> Result<(), String> {
    logging::clear();
    Ok(())
}

#[tauri::command]
pub(crate) fn rust_set_log_level(level: String) -> Result<bool, String> {
    Ok(logging::set_level(&level))
}
