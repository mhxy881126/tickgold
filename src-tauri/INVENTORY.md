# TickGold 后端命令 / 迁移对照清单（v2.27.0 基线）

> 巨石拆分（lib.rs → db/migrations.rs、commands.rs、setup.rs 模块化）的护栏。
> 每次后端结构调整后，必须重新核对：**命令总数 149、迁移总数 48**，逐一对照无缺失。
> 基线：v2.26.1（142 命令 / 47 迁移，2026-10-11）；v2.27.0 新增 7 个 hist_* 命令 + 迁移 v48。

## 一、Tauri Commands：149 个

### 原 lib.rs 本地命令：89 个（拆分后 88 个在 commands.rs，open_in_app_browser 在 setup.rs）

| # | 命令 |
| --- | --- |
| 1 | get_quotes |
| 2 | get_kline |
| 3 | get_minute |
| 4 | get_hist_minute |
| 5 | get_hist_minute_days |
| 6 | get_orderbook |
| 7 | get_trades |
| 8 | get_sectors |
| 9 | get_sector_stocks |
| 10 | get_stock_theme_tags |
| 11 | get_screener |
| 12 | search_stocks |
| 13 | get_index_quotes |
| 14 | get_rank_page |
| 15 | get_rank_board |
| 16 | get_news_flash |
| 17 | check_latest |
| 18 | get_f10_profile |
| 19 | get_f10_finance |
| 20 | get_f10_chips |
| 21 | get_ipo_list |
| 22 | get_restricted_queue |
| 23 | get_market_restricted |
| 24 | get_auction |
| 25 | get_auction_page |
| 26 | get_zt_pool |
| 27 | get_zb_pool |
| 28 | get_announcements |
| 29 | get_irm_latest |
| 30 | get_lhb_list |
| 31 | get_lhb_detail |
| 32 | get_seat_back |
| 33 | get_seat_trades |
| 34 | start_spider |
| 35 | stop_spider |
| 36 | start_radar |
| 37 | stop_radar |
| 38 | start_alert_engine |
| 39 | stop_alert_engine |
| 40 | win_minimize |
| 41 | win_toggle_maximize |
| 42 | win_close |
| 43 | win_is_maximized |
| 44 | open_pip_window |
| 45 | close_pip_window |
| 46 | pip_set_always_on_top |
| 47 | open_in_app_browser |
| 48 | save_export_file |
| 49 | open_text_file |
| 50 | rust_logs |
| 51 | rust_clear_logs |
| 52 | rust_set_log_level |
| 53 | backup_database |
| 54 | restore_latest_backup |
| 55 | ai_get_config |
| 56 | ai_save_config |
| 57 | ai_get_cloud_key_set |
| 58 | ai_set_cloud_key |
| 59 | ai_clear_cloud_key |
| 60 | ai_test_connection |
| 61 | ai_new_session |
| 62 | ai_list_sessions |
| 63 | ai_load_session |
| 64 | ai_delete_session |
| 65 | ai_chat_send |
| 66 | ai_chat_abort |
| 67 | ai_kb_stats |
| 68 | ai_list_docs |
| 69 | ai_import_docs |
| 70 | ai_delete_doc |
| 71 | ai_reindex |
| 72 | ai_index_daily |
| 73 | ai_build_decision_pack |
| 74 | ai_run_review |
| 75 | ai_list_reviews |
| 76 | ai_get_review |
| 77 | ai_generate_plan |
| 78 | ai_get_latest_plan |
| 79 | ai_get_plan |
| 80 | ai_set_plan_status |
| 81 | ai_update_plan_text |
| 82 | ai_update_instruction |
| 83 | ai_convert_instruction_alert |
| 84 | autoexec_get_config |
| 85 | autoexec_start |
| 86 | autoexec_stop |
| 87 | autoexec_set_config |
| 88 | laya_health |
| 89 | list_decision_logs |

### ai 模块：22 个

| # | 命令 |
| --- | --- |
| 90 | commentary::ai_intraday_commentary |
| 91 | commentary::ai_explain_signal |
| 92 | commentary::ai_suggest_alerts |
| 93 | commentary::ai_news_digest |
| 94 | commentary::ai_tomorrow_mainline |
| 95 | commentary::ai_news_for_stock |
| 96 | commentary::ai_intraday_commentary_stream |
| 97 | commentary::ai_news_digest_stream |
| 98 | commentary::ai_tomorrow_mainline_stream |
| 99 | evolution::evolution_run_labeling |
| 100 | evolution::evolution_list_labels |
| 101 | evolution::evolution_stats |
| 102 | evolution::evolution_data_check |
| 103 | bridge::signal_list |
| 104 | bridge::signal_confirm |
| 105 | bridge::signal_reject |
| 106 | bridge::signal_done |
| 107 | bridge::signal_expire |
| 108 | bridge::signal_create_manual |
| 109 | bridge::signal_create_spider |
| 110 | bridge::signal_launch_broker |
| 111 | bridge::signal_preview_order |

### broker 模块：20 个

| # | 命令 |
| --- | --- |
| 112 | broker_get_status |
| 113 | broker_get_config |
| 114 | broker_set_config |
| 115 | broker_enable_live |
| 116 | broker_connect |
| 117 | broker_disconnect |
| 118 | broker_submit |
| 119 | broker_cancel |
| 120 | broker_list_orders |
| 121 | broker_query_asset |
| 122 | broker_query_position |
| 123 | broker_kill_switch |
| 124 | broker_release_kill |
| 125 | mock_seed_position |
| 126 | mock_reset |
| 127 | conditional::co_list |
| 128 | conditional::co_create |
| 129 | conditional::co_update |
| 130 | conditional::co_cancel |
| 131 | conditional::co_cancel_all |

### plugin 模块：11 个

| # | 命令 |
| --- | --- |
| 132 | plugin_list |
| 133 | plugin_scan |
| 134 | plugin_install |
| 135 | plugin_enable |
| 136 | plugin_disable |
| 137 | plugin_uninstall |
| 138 | plugin_rpc |
| 139 | plugin_read_asset |
| 140 | plugin_get_dev_mode |
| 141 | plugin_set_dev_mode |
| 142 | plugin_reload |

### market::history 模块（v2.27 新增）：7 个

| # | 命令 |
| --- | --- |
| 143 | hist_backfill |
| 144 | hist_backfill_stop |
| 145 | hist_backfill_status |
| 146 | hist_query |
| 147 | hist_stats |
| 148 | hist_sync_calendar |
| 149 | hist_is_trading_day |

---

## 二、数据库迁移：48 条（主库 sqlite:stock-dock.db）

| v | description |
| --- | --- |
| 1 | create meta |
| 2 | create groups |
| 3 | create stocks |
| 4 | create alerts |
| 5 | create paper account |
| 6 | create paper position |
| 7 | create paper order |
| 8 | create trading journal |
| 9 | create finance calendar events |
| 10 | create saved workbench layouts |
| 11 | add min_volume_ratio to alerts |
| 12 | add rise_speed to alerts |
| 13 | add speed_window_sec to alerts |
| 14 | create ts_market (market sentiment intraday) |
| 15 | create ts_index (index intraday) |
| 16 | create ts_sector (sector intraday) |
| 17 | create ts_day (market sentiment daily) |
| 18 | create ts_index_day (index daily) |
| 19 | create ts_sector_day (sector daily) |
| 20 | create drawing (chart drawings persisted per scope) |
| 21 | create index idx_drawing_scope |
| 22 | create ind_template (named indicator templates) |
| 23 | add down_speed to alerts |
| 24 | add min_turnover to alerts |
| 25 | add min_amount to alerts |
| 26 | add seal_limit_up to alerts |
| 27 | add seal_limit_down to alerts |
| 28 | add broken_limit to alerts |
| 29 | create alert_event (alert trigger history) |
| 30 | create index idx_alert_event_time |
| 31 | create skin |
| 32 | collector run status |
| 33 | theme profile |
| 34 | theme stock membership |
| 35 | catalyst events |
| 36 | daily limit-up snapshot |
| 37 | create strategy_profile (versioned strategy configs) |
| 38 | create ai_review (market/theme/stock reviews) |
| 39 | create plan (next-day battle plan) |
| 40 | create plan_instruction (watch/candidate/trigger) |
| 41 | create company_note (per-stock notes) |
| 42 | create decision_log (fast-brain decisions audit/replay) |
| 43 | create model_version (fast/slow model registry) |
| 44 | create trade_label (decision outcome labeling / evolution feedback) |
| 45 | create signal_ticket + signal_audit (manual-confirm broker bridge) |
| 46 | create plugin registry / kv / audit tables |
| 47 | create conditional_order (local conditional trading orders) |
| 48 | create hist_kline + trade_calendar (multi-year history) |

> ai.db 另有独立版本链（当前 v4），不在此表。
