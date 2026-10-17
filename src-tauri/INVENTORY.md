# TickGold 后端命令 / 迁移对照清单（v2.29.0 基线）

> 巨石拆分（lib.rs → db/migrations.rs、commands.rs、setup.rs 模块化）的护栏。
> 每次后端结构调整后，必须重新核对：**命令总数 233、迁移总数 60**，逐一对照无缺失。
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
| 217 | client::broker_client_confirm（P3 同花顺模拟半自动确认/拒绝） |
| 218 | client::broker_client_selfcheck（P3 读取连接自检） |
| 219 | client::broker_client_shot（P3 读取下单前截图） |

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

> P1 盘前闭环新增 5 个命令（模块 ai::workflow_p1，实际注册总数 212）：
> - workflow_collect（第①步门禁：聚合涨停/炸板/连板梯队/题材/高标，生成战场态势包 briefing_json，推进 0→1）
> - workflow_analyze（第②步：六战法全市场扫描→统一打分排序→幂等重写 candidate_pool，推进 1→2）
> - workflow_plan（第③步：按情绪与候选池生成次日作战卡草稿 plan/plan_instruction，不推进）
> - workflow_plan_confirm（确认作战卡：候选/观察指令幂等转预警并入明日盯盘，推进 2→3）
> - workflow_p1_products（只读回显：重开驾驶舱/次日盘前取回 briefing/candidates/plan/planConfirmed）

> P2 盯盘执行层新增 4 个命令（模块 ai::workflow_p2，实际注册总数 216）：
> - workflow_watch_start（第④步门禁：急停/实盘开关拦截；模拟盘 paper 全自动配置启动 autoexec 5s 循环；盯盘对象继承 open/alerted 作战卡指令 + 持仓，推进 3→4）
> - workflow_execute_status（只读：运行态/急停/盯盘数 + 当日 decision_log 信号统计 + paper_order 成交统计，供前端 3s 轮询）
> - workflow_feedback（第⑤步收盘：停自动执行→settle 结算→聚合当日信号/成交/胜率/持仓/现金/盈亏→写 feedback_json，连续推进 4→5→6；幂等）
> - workflow_p2_products（只读回显：重开驾驶舱取回 mission/feedback/running/killSwitch）
> 一键熔断复用既有 broker_emergency_halt / broker_release_kill，不新增命令。

> P3 同花顺客户端自动化通道（模块 broker::client，实际注册总数 219）新增 3 个命令：
> - broker_client_confirm（半自动确认桥：人工核对截图后向 sidecar 发 confirm/reject，确认才在客户端点「确定」）
> - broker_client_selfcheck（读取 sidecar 连接自检：Python 版本 / pywinauto / 客户端路径 / 模拟或 dry-run 模式）
> - broker_client_shot（读取某笔委托下单前截图，供确认桥展示；不传 sig_id 取最近一张）
>
> 通道实现：新增 Python sidecar `resources/broker/sidecar_client.py`（NDJSON 协议与 sidecar_qmt 对齐），
> 由 `sidecar::spawn_generic` 统一托管；broker config 新增 7 个 client_* 字段，默认 vendor=ths、sim=true、
> auto_confirm=true、dry_run=true、min_interval=1200ms（模拟环境安全默认）。submit/cancel/query_asset/
> query_position/emergency_halt 均扩展为 qmt|client 双分支；模拟 client 不要求 live_enabled、不做实盘金额上限。
> 真实客户端通道（client_sim=false）强制半自动、留待 P4 开放。
> 前端与打包：设置 → 券商交易新增「同花顺模拟」模式卡（Python/客户端路径/模板目录/限速 + 模拟交易、dry-run、自动确认三开关 + 连接自检面板）；SignalBridge 新增「下单前核对」截图确认浮层（方向/代码/价格/数量/金额/模拟盘标记 + 截图 + 确认/取消），监听 broker:client_screenshot / broker:client_note；sidecar_client.py 已在 tauri.conf.json resources 注册随安装包分发。
> 真机联调与 selectors.json 模板录制见 docs/同花顺模拟通道·真机联调手册.md。

> P4 真实通道安全护栏（模块 broker，实际注册总数 222）新增 3 个命令：
> - broker_live_whitelist_set（设置实盘标的白名单，标准化为裸 6 位代码、去重排序；武装后改动自动解除武装）
> - broker_live_mark_drill（标记同花顺模拟盘真机演练是否通过，client 真实通道武装前置；自我声明 + 审计）
> - broker_live_usage（只读：武装状态 / 单笔·单日限额 / 今日已用 / 剩余 / 白名单 / 演练标记，供武装状态条）
>
> 武装（broker_enable_live 重写，真实通道 = QMT 或同花顺真实账户，is_live()）前置 6 项：真实通道、单笔上限>0、
> 单日上限>0 且 ≥ 单笔、白名单非空、client 须模拟演练通过且强制半自动、风险告知 ack；任一安全参数变更（安全指纹）
> 自动解除武装并须重新武装。
> 下单闸门（submit_with_sig，is_live 才生效）：强制半自动（client）→ 白名单（裸 6 位）→ 强制涨跌停行情快照
> （无快照即拒，防乌龙指）→ 单笔金额上限 → 单日累计买入上限（只统计 is_live=1 的 BUY，排除已撤/已拒）。
> config 新增 4 字段：live_max_daily_amount / live_codes_whitelist / live_sim_drill_passed / live_armed_at（serde 默认全锁）。
> sidecar 纵深：client.rs 向 sidecar_client.py / sidecar_qmt.py 下发 --whitelist/--max-amount/--max-daily；
> sidecar_client.py 真实模式强制忽略 --auto-confirm、pre_check 独立白名单/限额/单日累计、连接时按窗口标题交叉校验
> 模拟/真实账户（连错即拒绝）；sidecar_qmt.py 无护栏参数时拒绝一切下单，submit 前独立校验。
> 前端：设置 → 券商交易「实盘委托」升级为红色高危武装向导（单笔/单日限额、白名单增删、模拟演练勾选、
> 输入「风险确认」、武装/解除、当日额度状态条）；SignalBridge 截图确认浮层真实态强红、金额醒目、确认按钮改为「提交真实委托」。
> 上线流程 / 资金门槛 / 风险与熔断见 docs/真实通道上线手册.md。

> **P5 模型接管（影子→灰度→接管）与故障演练**（模块 ai::brain_rollout、ai::drill，实际注册总数 227）新增 5 个命令：
> - brain_rollout_get（只读：四阶段状态机 + 影子统计 ShadowStats：样本数 / 影子可用 / 一致率 / 规则·影子耗时 p50·p99 / 达标判定）
> - brain_rollout_request（申请进入下一阶段：rule→shadow→canary→live 只能逐级；shadow→canary 校验样本数 + 一致率双门槛，canary→live 校验实盘已武装；可携带灰度比例 / 小仓位 / 达标阈值；Pro）
> - brain_rollout_approve（审批 pending 申请；live 审批二次校验实盘武装；Pro）
> - brain_rollout_rollback（一键回退规则脑，不强制 Pro，随时可用）
> - drill_run_all（仅模拟 / 未武装环境可运行的故障演练：模型超时 / 断网 / sidecar 崩溃 / 行情陈旧 / 一键急停 5 项，真实调用降级路径并写审计）
>
> 状态机：rule（规则脑，维持原 brain_mode，含 cloud_llm）→ shadow（AI 并行只记录到 shadow_decision，规则脑照常执行）
> → canary（按标的 code 哈希确定性灰度分流，同票始终同脑；laya 执行的买入强制小仓位 max_single_pct=min(原值,small_position_pct)，
> 只收紧不放宽；laya 不可用/超时一律降级规则脑并累计失败）→ live（全量 AI 执行）；canary/live 连续失败 5 次自动回退规则脑。
> 风控 fail-safe 提取为 risk::limit_prices_ready（真实下单必须同时具备涨停价与跌停价，缺任一即拒），broker submit 与演练共用。
> 前端：cockpit/BrainRolloutPanel.vue（四阶段流水线 / 影子统计 / 灰度参数 / 申请·审批·回退 / 演练面板）+
> cockpit/LaunchWizard.vue（三道选择上线向导：模拟盘 / 半自动实盘 / 全自动接管，含前置 checklist、风控确认、故障演练）。
> 影子达标默认 ≥100 样本且一致率 ≥60%；真正的 laya_sidecar 未启动前影子脑不可用（shadow_ok=0），启动 sidecar 后即开始攒样本。

> **P6 一键智驾模式（模块 ai::pilot，实际注册总数 233）新增 6 个命令**：
> - pilot_start（一键开始智驾：仅模拟盘校验 + 非急停 → 立即执行首轮闭环 → 启动 20s 轮询排程器）
> - pilot_pause / pilot_stop（暂停保留进度 / 停止置 off，均持久化 mode）
> - pilot_status（配置 + 当日扫描进度 + 排程器运行态 + 当日小结 + 下次触发点）
> - pilot_config_get / pilot_config_set（读取 / 更新智驾配置：风控档位、虚拟资金、战法、调度开关、每日扫描次数；仅 mode=off 可写）
>
> 调度：每日 15 次扫描（09:30 / 09:45 / 10:00–11:40 每 20 分 / 13:00–14:40 每 20 分 / 15:10）+ 15:30 收盘结算；
> 盘前四步自动补齐（复用 workflow_p1 采集/分析/计划/确认），盘中复用 workflow_watch_start 启动 autoexec 全自动执行，
> 收盘复用 workflow_feedback 回灌并写 pilot_daily_log 小结。
> 安全红线：智驾强制模拟盘（live_enabled / live_armed_at / client_sim=false 任一命中即拒启动），急停状态禁止启动；
> 执行风控仍走 autoexec 现有闸门（硬止损/日亏/回撤/连亏），风控档位三档映射 steady（-7%/80%/5%/20%）/
> aggressive（-8%/90%/6%/25%）/ defensive（-4%/60%/3%/12%）。
> 数据表：迁移 v60 新增 pilot_config（单行配置）+ pilot_daily_log（按交易日运行日志）。

---

## 二、数据库迁移：60 条（主库 sqlite:stock-dock.db）

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
| 56 | P1 pre-market loop: daily_mission.briefing_json + candidate_pool (six-tactic scored candidates) |
| 57 | P2 execution loop: daily_mission.feedback_json (daily trading summary writeback) |
| 58 | P4 broker_order.is_live (mark real vs simulated orders; live daily buy quota counts is_live=1 only) |
| 59 | P5 brain_rollout (rule→shadow→canary→live state machine) + shadow_decision (shadow vs rule decision log) |
| 60 | P6 pilot_config (one-row autopilot config) + pilot_daily_log (per-trading-day autopilot run log) |

> ai.db 另有独立版本链（当前 v4），不在此表。
