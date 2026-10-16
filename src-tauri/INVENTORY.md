# TickGold 后端命令 / 迁移对照清单（v2.29.0 基线）

> 巨石拆分（lib.rs → db/migrations.rs、commands.rs、setup.rs 模块化）的护栏。
> 每次后端结构调整后，必须重新核对：**命令总数 207、迁移总数 55**，逐一对照无缺失。
> （v2.30 起命令/迁移逐步增加，历史编号未全量回填；P0 新增条目见文末对应小节。）
> 基线：v2.27.0（149 命令 / 48 迁移）；v2.28.0 净增 21 个命令
> （资金流 3、组合层 2、风险仪表盘 1、异动阈值 2、板块日快照 3、备份中心 7、数据治理 3）
> + 迁移 v49（统一账本回填）+ v50（重建 ts_sector_day 支持自建板块日历史）；
> v2.29.0 净增 2 个数据治理命令（过期清理预览 / 执行），迁移数不变。
>
> v2.30 / v2.31 / v2.32 陆续新增命令（含 v2.32 `get_depth_enhance`），
> 全表逐行重新编号在发版核对时统一进行（#20）；下列编号仅基线快照。

## 一、Tauri Commands：193 个

> 编号严格按 `lib.rs` 中 `generate_handler!` 的出现顺序。

### 本地命令（commands.rs + setup.rs）：97 个

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
| 16 | get_fund_flow |
| 17 | get_market_fund_panorama |
| 18 | get_fund_rank |
| 19 | sector_day_snapshot |
| 20 | sector_day_query |
| 21 | sector_day_stats |
| 22 | get_news_flash |
| 23 | check_latest |
| 24 | get_f10_profile |
| 25 | get_f10_finance |
| 26 | get_f10_chips |
| 27 | get_ipo_list |
| 28 | get_restricted_queue |
| 29 | get_market_restricted |
| 30 | get_auction |
| 31 | get_auction_page |
| 32 | get_zt_pool |
| 33 | get_zb_pool |
| 34 | get_announcements |
| 35 | get_irm_latest |
| 36 | get_lhb_list |
| 37 | get_lhb_detail |
| 38 | get_seat_back |
| 39 | get_seat_trades |
| 40 | start_spider |
| 41 | stop_spider |
| 42 | spider_get_thresholds |
| 43 | spider_set_thresholds |
| 44 | start_radar |
| 45 | stop_radar |
| 46 | start_alert_engine |
| 47 | stop_alert_engine |
| 48 | win_minimize |
| 49 | win_toggle_maximize |
| 50 | win_close |
| 51 | win_is_maximized |
| 52 | open_pip_window |
| 53 | close_pip_window |
| 54 | pip_set_always_on_top |
| 55 | open_in_app_browser（setup.rs） |
| 56 | save_export_file |
| 57 | open_text_file |
| 58 | rust_logs |
| 59 | rust_clear_logs |
| 60 | rust_set_log_level |
| 61 | backup_database（旧单库备份，保留） |
| 62 | restore_latest_backup（旧单库恢复，保留） |
| 63 | ai_get_config |
| 64 | ai_save_config |
| 65 | ai_get_cloud_key_set |
| 66 | ai_set_cloud_key |
| 67 | ai_clear_cloud_key |
| 68 | ai_test_connection |
| 69 | ai_new_session |
| 70 | ai_list_sessions |
| 71 | ai_load_session |
| 72 | ai_delete_session |
| 73 | ai_chat_send |
| 74 | ai_chat_abort |
| 75 | ai_kb_stats |
| 76 | ai_list_docs |
| 77 | ai_import_docs |
| 78 | ai_delete_doc |
| 79 | ai_reindex |
| 80 | ai_index_daily |
| 81 | ai_build_decision_pack |
| 82 | ai_run_review |
| 83 | ai_list_reviews |
| 84 | ai_get_review |
| 85 | ai_generate_plan |
| 86 | ai_get_latest_plan |
| 87 | ai_get_plan |
| 88 | ai_set_plan_status |
| 89 | ai_update_plan_text |
| 90 | ai_update_instruction |
| 91 | ai_convert_instruction_alert |
| 92 | autoexec_get_config |
| 93 | autoexec_start |
| 94 | autoexec_stop |
| 95 | autoexec_set_config |
| 96 | laya_health |
| 97 | list_decision_logs |

### ai 模块：22 个

| # | 命令 |
| --- | --- |
| 98 | commentary::ai_intraday_commentary |
| 99 | commentary::ai_explain_signal |
| 100 | commentary::ai_suggest_alerts |
| 101 | commentary::ai_news_digest |
| 102 | commentary::ai_tomorrow_mainline |
| 103 | commentary::ai_news_for_stock |
| 104 | commentary::ai_intraday_commentary_stream |
| 105 | commentary::ai_news_digest_stream |
| 106 | commentary::ai_tomorrow_mainline_stream |
| 107 | evolution::evolution_run_labeling |
| 108 | evolution::evolution_list_labels |
| 109 | evolution::evolution_stats |
| 110 | evolution::evolution_data_check |
| 111 | bridge::signal_list |
| 112 | bridge::signal_confirm |
| 113 | bridge::signal_reject |
| 114 | bridge::signal_done |
| 115 | bridge::signal_expire |
| 116 | bridge::signal_create_manual |
| 117 | bridge::signal_create_spider |
| 118 | bridge::signal_launch_broker |
| 119 | bridge::signal_preview_order |

### broker 模块（含 conditional 条件单）：23 个

| # | 命令 |
| --- | --- |
| 120 | broker_get_status |
| 121 | broker_get_config |
| 122 | broker_set_config |
| 123 | broker_enable_live |
| 124 | broker_connect |
| 125 | broker_disconnect |
| 126 | broker_submit |
| 127 | portfolio_buy（统一成交层买入） |
| 128 | portfolio_sell（统一成交层卖出） |
| 129 | risk_snapshot（风险仪表盘读数） |
| 130 | broker_cancel |
| 131 | broker_list_orders |
| 132 | broker_query_asset |
| 133 | broker_query_position |
| 134 | broker_kill_switch |
| 135 | broker_release_kill |
| 136 | mock_seed_position |
| 137 | mock_reset |
| 138 | conditional::co_list |
| 139 | conditional::co_create |
| 140 | conditional::co_update |
| 141 | conditional::co_cancel |
| 142 | conditional::co_cancel_all |

### plugin 模块：11 个

| # | 命令 |
| --- | --- |
| 143 | plugin_list |
| 144 | plugin_scan |
| 145 | plugin_install |
| 146 | plugin_enable |
| 147 | plugin_disable |
| 148 | plugin_uninstall |
| 149 | plugin_rpc |
| 150 | plugin_read_asset |
| 151 | plugin_get_dev_mode |
| 152 | plugin_set_dev_mode |
| 153 | plugin_reload |
| - | plugin_l2_set_key（v2.32 Level-2 Key 录入）|
| - | plugin_l2_key_set（v2.32 查询 Key 是否已配置）|
| - | plugin_l2_clear_key（v2.32 清除 Key）|
| - | plugin_l2_providers（v2.32 发现 Level-2 数据源）|

> v2.32 Level-2 新增 4 个命令（暂未重排编号，#20 统一编号）；
> `level2.book` 走既有 `plugin_rpc`，不另增命令。

### backup 模块（v2.28 备份 / 恢复中心）：7 个

| # | 命令 |
| --- | --- |
| 154 | backup_full_create |
| 155 | backup_full_list |
| 156 | backup_write_config |
| 157 | backup_read_config |
| 158 | backup_full_restore |
| 159 | backup_full_delete |
| 160 | backup_take_pending_config |

### storage 模块（数据治理）：5 个

| # | 命令 |
| --- | --- |
| 161 | storage_stats |
| 162 | storage_cleanup_orphans |
| 163 | storage_vacuum |
| 164 | storage_purge_preview |
| 165 | storage_purge_run |

### market::history 模块：7 个

| # | 命令 |
| --- | --- |
| 166 | hist_backfill |
| 167 | hist_backfill_stop |
| 168 | hist_backfill_status |
| 169 | hist_query |
| 170 | hist_stats |
| 171 | hist_sync_calendar |
| 172 | hist_is_trading_day |

> 以 `generate_handler!` 实际枚举为准：本地 97 + ai 22 + broker 23 + plugin 11
> + backup 7 + storage 5 + history 7 = **172 个**。

### license 模块（v3.0.2 Pro 订阅授权）：3 个

| # | 命令 |
| --- | --- |
| - | license_status（查询授权状态） |
| - | license_activate（粘贴卡密激活 Pro） |
| - | license_deactivate（退出 Pro） |

> v3.0.2 授权系统新增 3 个命令（暂未重排编号，发版核对时统一 #20）。

> P0 AI 作战流编排新增 3 个命令（模块 ai::workflow，实际注册总数 207）：
> - workflow_get_today（取今日 daily_mission，不存在则建，current_step=0）
> - workflow_advance（顺序推进当前步，写入快照；禁止跳步，全完成报错）
> - workflow_reset（重置今日流程回第 0 步）

---

## 二、数据库迁移：55 条（主库 sqlite:stock-dock.db）

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
| 26 | seal_limit_up to alerts |
| 27 | seal_limit_down to alerts |
| 28 | broken_limit to alerts |
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
| 49 | backfill broker_order + paper_order.sig_id (unified ledger) |
| 50 | rebuild ts_sector_day: PK(day,kind) + 涨跌家数/涨停数/换手/成交额 |
| 51 | create backtest_run (backtest engine result storage) |
| 52 | create tuning_proposal (backtest-to-live human approval queue) |
| 53 | smart watch groups + screener subscription (v2.31 signal quality & quant screening) |
| 54 | persist broken-limit pool for ladder reseal rate + amount on limit_up_record (v2.31 ladder depth) |
| 55 | create daily_mission (P0 AI trading workflow orchestrator: six-step state machine) |

> ai.db 另有独立版本链（当前 v4），不在此表。
