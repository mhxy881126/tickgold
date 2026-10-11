mod ai;
mod broker;
mod commands;
mod db;
mod error;
mod logging;
mod market;
mod plugin;
mod proxy;
mod setup;

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
        .plugin(tauri_plugin_shell::init())
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
        .manage(Arc::new(market::limitup::LimitRadar::new()))
        .manage(Arc::new(market::alert::AlertEngine::new()))
        .manage(ai::autoexec::AutoExecCtl::new())
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
            commands::get_sectors,
            commands::get_sector_stocks,
            commands::get_stock_theme_tags,
            commands::get_screener,
            commands::search_stocks,
            commands::get_index_quotes,
            commands::get_rank_page,
            commands::get_rank_board,
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
            broker::broker_cancel,
            broker::broker_list_orders,
            broker::broker_query_asset,
            broker::broker_query_position,
            broker::broker_kill_switch,
            broker::broker_release_kill,
            broker::mock_seed_position,
            broker::mock_reset,
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
            plugin::plugin_reload
        ])
        .run(tauri::generate_context!())
        .expect("error while running stock-dock");
}
