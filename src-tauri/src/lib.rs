mod ai;
mod backup;
mod broker;
mod commands;
mod db;
mod error;
mod logging;
mod market;
mod license;
mod plugin;
mod proxy;
mod setup;
mod storage;

// 命令在 generate_handler! 中按原名引用（数量护栏见 INVENTORY.md）。
use commands::*;
use setup::BossHidden;
use std::sync::Arc;
use std::sync::Mutex;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    logging::init();
    diag_log(&format!("BOOT cfg(dev)={} profile_compiled", cfg!(dev)));
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        // 预警/提醒仅允许应用内 Toast，不注册系统通知插件，杜绝电脑弹窗
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:stock-dock.db", db::migrations::migrations())
                .build(),
        )
        .manage(ai::AiState::default())
        .manage(ai::AbortRegistry::default())
        .manage(BossHidden(Mutex::new(false)))
        .manage(Arc::new(market::spider::SpiderCtl::new()))
        .manage(market::history::HistState::default())
        .manage(Arc::new(market::limitup::LimitRadar::new()))
        .manage(Arc::new(market::alert::AlertEngine::new()))
        .manage(ai::autoexec::AutoExecCtl::new())
        .manage(ai::pilot::PilotCtl::new())
        .manage(broker::BrokerManager::new())
        .manage(plugin::PluginManager::new())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(setup::init)
        .invoke_handler(tauri::generate_handler![
            commands::get_quotes,
            commands::get_kline,
            commands::get_minute,
            commands::get_hist_minute,
            commands::get_hist_minute_days,
            commands::get_orderbook,
            commands::get_trades,
            commands::get_depth_enhance,
            commands::get_sectors,
            commands::get_sector_stocks,
            commands::get_stock_theme_tags,
            commands::get_screener,
            commands::search_stocks,
            commands::get_index_quotes,
            commands::get_rank_page,
            commands::get_rank_board,
            commands::get_fund_flow,
            commands::get_market_fund_panorama,
            commands::get_fund_rank,
            commands::sector_day_snapshot,
            commands::sector_day_query,
            commands::sector_day_stats,
            commands::get_news_flash,
            commands::check_latest,
            commands::get_f10_profile,
            commands::get_f10_finance,
            commands::get_f10_chips,
            commands::get_ipo_list,
            commands::get_restricted_queue,
            commands::get_market_restricted,
            commands::get_auction,
            commands::get_auction_page,
            commands::get_zt_pool,
            commands::get_zb_pool,
            commands::get_announcements,
            commands::get_irm_latest,
            commands::get_lhb_list,
            commands::get_lhb_detail,
            commands::get_seat_back,
            commands::get_seat_trades,
            commands::start_spider,
            commands::stop_spider,
            commands::spider_get_thresholds,
            commands::spider_set_thresholds,
            commands::get_radar_snapshot,
            commands::start_radar,
            commands::stop_radar,
            commands::start_alert_engine,
            commands::stop_alert_engine,
            commands::win_minimize,
            commands::win_toggle_maximize,
            commands::win_close,
            commands::win_is_maximized,
            commands::open_pip_window,
            commands::close_pip_window,
            commands::pip_set_always_on_top,
            setup::open_in_app_browser,
            commands::save_export_file,
            commands::open_text_file,
            commands::rust_logs,
            commands::rust_clear_logs,
            commands::rust_set_log_level,
            commands::backup_database,
            commands::restore_latest_backup,
            commands::ai_get_config,
            commands::ai_save_config,
            commands::ai_get_cloud_key_set,
            commands::ai_set_cloud_key,
            commands::ai_clear_cloud_key,
            commands::ai_test_connection,
            commands::ai_new_session,
            commands::ai_list_sessions,
            commands::ai_load_session,
            commands::ai_delete_session,
            commands::ai_chat_send,
            commands::ai_chat_abort,
            commands::ai_kb_stats,
            commands::ai_list_docs,
            commands::ai_import_docs,
            commands::ai_delete_doc,
            commands::ai_reindex,
            commands::ai_index_daily,
            commands::ai_build_decision_pack,
            commands::ai_build_review_report,
            commands::ai_run_review,
            commands::ai_list_reviews,
            commands::ai_get_review,
            commands::ai_generate_plan,
            commands::ai_get_latest_plan,
            commands::ai_get_plan,
            commands::ai_set_plan_status,
            commands::ai_update_plan_text,
            commands::ai_update_instruction,
            commands::ai_convert_instruction_alert,
            // ===== v2.25 智能赋能 =====
            ai::commentary::ai_intraday_commentary,
            ai::commentary::ai_explain_signal,
            ai::commentary::ai_suggest_alerts,
            ai::commentary::ai_news_digest,
            ai::commentary::ai_tomorrow_mainline,
            ai::commentary::ai_news_for_stock,
            // ===== v2.25.6 流式渲染 =====
            ai::commentary::ai_intraday_commentary_stream,
            ai::commentary::ai_news_digest_stream,
            ai::commentary::ai_tomorrow_mainline_stream,
            commands::autoexec_get_config,
            commands::autoexec_start,
            commands::autoexec_stop,
            commands::autoexec_set_config,
            commands::laya_health,
            commands::list_decision_logs,
            ai::evolution::evolution_run_labeling,
            ai::evolution::evolution_list_labels,
            ai::evolution::evolution_stats,
            ai::evolution::evolution_data_check,
            ai::signal_quality::signal_quality_lookup,
            ai::signal_quality::signal_quality_overview,
            ai::bridge::signal_list,
            ai::bridge::signal_confirm,
            ai::bridge::signal_reject,
            ai::bridge::signal_done,
            ai::bridge::signal_expire,
            ai::bridge::signal_create_manual,
            ai::bridge::signal_create_spider,
            ai::bridge::signal_launch_broker,
            ai::bridge::signal_preview_order,
            // ===== v2.6 券商实盘对接 =====
            broker::broker_get_status,
            broker::broker_get_config,
            broker::broker_set_config,
            broker::broker_enable_live,
            broker::broker_connect,
            broker::broker_disconnect,
            broker::broker_submit,
            broker::broker_confirm_submit,
            broker::broker_quick_order,
            broker::portfolio_buy,
            broker::portfolio_sell,
            broker::risk_snapshot,
            broker::broker_cancel,
            broker::broker_list_orders,
            broker::broker_query_asset,
            broker::broker_query_position,
            broker::broker_kill_switch,
            broker::broker_emergency_halt,
            broker::broker_reconcile,
            broker::broker_recon_status,
            broker::broker_recon_recalibrate,
            broker::broker_chase_validate,
            broker::broker_rate_reset,
            broker::broker_release_kill,
            broker::mock_seed_position,
            broker::mock_reset,
            // P3 客户端自动化通道（同花顺模拟）
            broker::client::broker_client_confirm,
            broker::client::broker_client_selfcheck,
            broker::client::broker_client_shot,
            // P7 同花顺真实通道：四表查询 / 撤单 / 仓位 / 探测 / 透传 / 验证码
            broker::client::broker_client_query_trades,
            broker::client::broker_client_query_pending,
            broker::client::broker_client_cancel_all,
            broker::client::broker_client_position_order,
            broker::client::broker_client_check_app,
            broker::client::broker_client_current_page,
            broker::client::broker_client_send_key,
            broker::client::broker_client_click,
            broker::client::broker_client_captcha_input,
            // P4 真实通道安全护栏（白名单 / 模拟演练 / 额度读数）
            broker::broker_live_whitelist_set,
            broker::broker_live_mark_drill,
            broker::broker_live_usage,
            // P8 券商路径一键自检（本机探测，不依赖 sidecar）
            broker::probe::broker_probe_paths,
            // P12-11 OCR 引擎管理（ddddocr 探测/安装/卸载）
            broker::probe::broker_ocr_engine,
            // ===== P5 模型接管：状态机 / 影子 / 灰度 / 回退 =====
            ai::brain_rollout::brain_rollout_get,
            ai::brain_rollout::brain_rollout_request,
            ai::brain_rollout::brain_rollout_approve,
            ai::brain_rollout::brain_rollout_rollback,
            ai::drill::drill_run_all,
            // ===== v2.23 本地条件单 =====
            broker::conditional::co_list,
            broker::conditional::co_create,
            broker::conditional::co_update,
            broker::conditional::co_cancel,
            broker::conditional::co_cancel_all,
            // ===== v2.6 插件生态 =====
            plugin::plugin_list,
            plugin::plugin_scan,
            plugin::plugin_install,
            plugin::plugin_enable,
            plugin::plugin_disable,
            plugin::plugin_uninstall,
            plugin::plugin_rpc,
            plugin::plugin_read_asset,
            plugin::plugin_get_dev_mode,
            plugin::plugin_set_dev_mode,
            plugin::plugin_reload,
            // v2.32 Level-2 数据源试点
            plugin::plugin_l2_set_key,
            plugin::plugin_l2_key_set,
            plugin::plugin_l2_clear_key,
            plugin::plugin_l2_providers,
            // ===== v2.29 备份 / 恢复中心 =====
            backup::backup_full_create,
            backup::backup_full_list,
            backup::backup_write_config,
            backup::backup_read_config,
            backup::backup_full_restore,
            backup::backup_full_delete,
            backup::backup_take_pending_config,
            // ===== v2.29 数据治理 =====
            storage::storage_stats,
            storage::storage_cleanup_orphans,
            storage::storage_vacuum,
            storage::storage_purge_preview,
            storage::storage_purge_run,
            // ===== v2.27 多年历史 K 线库 =====
            market::history::hist_backfill,
            market::history::hist_backfill_stop,
            market::history::hist_backfill_status,
            market::history::hist_query,
            market::history::hist_stats,
            market::history::hist_sync_calendar,
            market::history::hist_is_trading_day,
            // ===== v2.30 回测引擎 =====
            ai::backtest::backtest_run,
            ai::backtest::backtest_save,
            ai::backtest::backtest_list,
            ai::backtest::backtest_load,
            ai::backtest::backtest_delete,
            ai::backtest::backtest_optimize,
            // ===== v2.30 回测→实盘人工审批护栏（迁移 v52）=====
            ai::backtest::tuning_proposal_create,
            ai::backtest::tuning_proposal_list,
            ai::backtest::tuning_proposal_approve,
            ai::backtest::tuning_proposal_reject,
            ai::backtest::tuning_proposal_revert,
            // ===== v2.31 战法选股 / 天梯深化 =====
            market::strategy_scan::strategy_scan_run,
            market::ladder_stats::ladder_stats,
            // ===== v2.31 选股订阅（定时战法扫描 + 应用内推送）=====
            market::screen_sub::screen_sub_list,
            market::screen_sub::screen_sub_upsert,
            market::screen_sub::screen_sub_delete,
            market::screen_sub::screen_sub_runs,
            market::screen_sub::screen_sub_run_now,
            // ===== v3.0.2 Pro 订阅授权（面包多卡密 · 离线验签）=====
            license::license_status,
            license::license_activate,
            license::license_deactivate,
            // ===== P0 AI 作战流编排（daily_mission 六步状态机）=====
            ai::workflow::workflow_get_today,
            ai::workflow::workflow_advance,
            ai::workflow::workflow_reset,
            // ===== P1 盘前闭环（采集/分析/计划自动串）=====
            ai::workflow_p1::workflow_collect,
            ai::workflow_p1::workflow_analyze,
            ai::workflow_p1::workflow_plan,
            ai::workflow_p1::workflow_plan_confirm,
            ai::workflow_p1::workflow_p1_products,
            ai::workflow_p1::workflow_instructions,
            ai::hitrate::workflow_hit_rate,
            ai::instruction::workflow_instruction_trigger_set,
            ai::instruction::workflow_instruction_tag_set,
            ai::instruction::workflow_instruction_tag_stats,
            ai::workflow_p2::workflow_watch_start,
            ai::workflow_p2::workflow_execute_status,
            ai::workflow_p2::workflow_feedback,
            ai::workflow_p2::workflow_p2_products,
            // ===== P6 一键智驾模式（模拟盘全自动闭环，真实通道互斥）=====
            ai::pilot::pilot_start,
            ai::pilot::pilot_pause,
            ai::pilot::pilot_stop,
            ai::pilot::pilot_status,
            ai::pilot::pilot_config_get,
            ai::pilot::pilot_config_set,
            // ===== v3.0.7 关于页版本号 =====
            app_version
        ])
        .run(tauri::generate_context!())
        .expect("error while running stock-dock");
}
