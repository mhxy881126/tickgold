// 主库迁移清单（v2.27 巨石拆分：从 lib.rs 抽出）。
// 追加式：只许新增版本，禁止改动已发布条目。共 52 条（v1..v52）。
// 数量护栏见 src-tauri/INVENTORY.md；改动后需与之一致。
use tauri_plugin_sql::{Migration, MigrationKind};

pub fn migrations() -> Vec<Migration> {
    vec![
                        Migration {
                            version: 1,
                            description: "create meta",
                            sql: "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);",
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 2,
                            description: "create groups",
                            sql: "CREATE TABLE IF NOT EXISTS groups (
                                id INTEGER PRIMARY KEY AUTOINCREMENT,
                                name TEXT NOT NULL,
                                sort_order INTEGER NOT NULL DEFAULT 0,
                                created_at INTEGER NOT NULL
                            );",
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 3,
                            description: "create stocks",
                            sql: "CREATE TABLE IF NOT EXISTS stocks (
                                id INTEGER PRIMARY KEY AUTOINCREMENT,
                                code TEXT NOT NULL UNIQUE,
                                name TEXT NOT NULL DEFAULT '',
                                group_id INTEGER NOT NULL DEFAULT 1,
                                sort_order INTEGER NOT NULL DEFAULT 0,
                                created_at INTEGER NOT NULL
                            );",
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 4,
                            description: "create alerts",
                            sql: "CREATE TABLE IF NOT EXISTS alerts (
                                id TEXT PRIMARY KEY,
                                code TEXT NOT NULL,
                                name TEXT NOT NULL DEFAULT '',
                                up_price REAL,
                                down_price REAL,
                                up_pct REAL,
                                down_pct REAL,
                                cooldown_sec INTEGER NOT NULL DEFAULT 300,
                                enabled INTEGER NOT NULL DEFAULT 1,
                                last_fired_at INTEGER
                            );",
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 5,
                            description: "create paper account",
                            sql: "CREATE TABLE IF NOT EXISTS paper_account (
                                id INTEGER PRIMARY KEY CHECK (id = 1),
                                init_cash REAL NOT NULL,
                                cash REAL NOT NULL,
                                created_at INTEGER NOT NULL
                            );",
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 6,
                            description: "create paper position",
                            sql: "CREATE TABLE IF NOT EXISTS paper_position (
                                code TEXT PRIMARY KEY,
                                name TEXT NOT NULL DEFAULT '',
                                vol INTEGER NOT NULL DEFAULT 0,
                                avail_vol INTEGER NOT NULL DEFAULT 0,
                                cost_amount REAL NOT NULL DEFAULT 0,
                                updated_at INTEGER NOT NULL
                            );",
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 7,
                            description: "create paper order",
                            sql: "CREATE TABLE IF NOT EXISTS paper_order (
                                id TEXT PRIMARY KEY,
                                code TEXT NOT NULL,
                                name TEXT NOT NULL DEFAULT '',
                                side TEXT NOT NULL,
                                price REAL NOT NULL,
                                vol INTEGER NOT NULL,
                                amount REAL NOT NULL,
                                fee REAL NOT NULL DEFAULT 0,
                                status TEXT NOT NULL,
                                created_at INTEGER NOT NULL,
                                trade_date TEXT NOT NULL
                            );",
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 8,
                            description: "create trading journal",
                            sql: "CREATE TABLE IF NOT EXISTS journal (
                                id INTEGER PRIMARY KEY AUTOINCREMENT,
                                date TEXT NOT NULL,
                                title TEXT NOT NULL DEFAULT '',
                                content TEXT NOT NULL DEFAULT '',
                                mood TEXT,
                                tags TEXT NOT NULL DEFAULT '',
                                code TEXT,
                                created_at INTEGER NOT NULL,
                                updated_at INTEGER NOT NULL
                            );",
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 9,
                            description: "create finance calendar events",
                            sql: "CREATE TABLE IF NOT EXISTS cal_event (
                                id INTEGER PRIMARY KEY AUTOINCREMENT,
                                date TEXT NOT NULL,
                                time TEXT,
                                title TEXT NOT NULL,
                                type TEXT NOT NULL DEFAULT 'other',
                                note TEXT NOT NULL DEFAULT '',
                                code TEXT,
                                remind INTEGER NOT NULL DEFAULT 0,
                                done INTEGER NOT NULL DEFAULT 0,
                                created_at INTEGER NOT NULL
                            );",
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 10,
                            description: "create saved workbench layouts",
                            sql: "CREATE TABLE IF NOT EXISTS layout (
                                id INTEGER PRIMARY KEY AUTOINCREMENT,
                                name TEXT NOT NULL,
                                cards TEXT NOT NULL,
                                created_at INTEGER NOT NULL,
                                updated_at INTEGER NOT NULL
                            );",
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 11,
                            description: "add min_volume_ratio to alerts",
                            sql: "ALTER TABLE alerts ADD COLUMN min_volume_ratio REAL;",
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 12,
                            description: "add rise_speed to alerts",
                            sql: "ALTER TABLE alerts ADD COLUMN rise_speed REAL;",
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 13,
                            description: "add speed_window_sec to alerts",
                            sql: "ALTER TABLE alerts ADD COLUMN speed_window_sec INTEGER;",
                            kind: MigrationKind::Up,
                        },
                        // ===== v0.51 本地时序库：盘中分时 + 收盘日级（日级长期保留）=====
                        Migration {
                            version: 14,
                            description: "create ts_market (market sentiment intraday)",
                            sql: "CREATE TABLE IF NOT EXISTS ts_market (
                                day TEXT NOT NULL,
                                ts INTEGER NOT NULL,
                                total INTEGER,
                                up_count INTEGER,
                                down_count INTEGER,
                                flat_count INTEGER,
                                limit_up INTEGER,
                                limit_down INTEGER,
                                broken INTEGER,
                                broken_rate REAL,
                                max_boards INTEGER,
                                sentiment REAL,
                                PRIMARY KEY (day, ts)
                            );",
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 15,
                            description: "create ts_index (index intraday)",
                            sql: "CREATE TABLE IF NOT EXISTS ts_index (
                                day TEXT NOT NULL,
                                ts INTEGER NOT NULL,
                                code TEXT NOT NULL,
                                name TEXT,
                                price REAL,
                                pct REAL,
                                amount REAL,
                                PRIMARY KEY (day, ts, code)
                            );",
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 16,
                            description: "create ts_sector (sector intraday)",
                            sql: "CREATE TABLE IF NOT EXISTS ts_sector (
                                day TEXT NOT NULL,
                                ts INTEGER NOT NULL,
                                kind TEXT,
                                code TEXT NOT NULL,
                                name TEXT,
                                change_pct REAL,
                                net_amount REAL,
                                lead_code TEXT,
                                lead_name TEXT,
                                lead_pct REAL,
                                PRIMARY KEY (day, ts, code)
                            );",
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 17,
                            description: "create ts_day (market sentiment daily)",
                            sql: "CREATE TABLE IF NOT EXISTS ts_day (
                                day TEXT PRIMARY KEY,
                                close_ts INTEGER,
                                total INTEGER,
                                up_count INTEGER,
                                down_count INTEGER,
                                flat_count INTEGER,
                                limit_up INTEGER,
                                limit_down INTEGER,
                                broken INTEGER,
                                broken_rate REAL,
                                max_boards INTEGER,
                                sentiment REAL
                            );",
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 18,
                            description: "create ts_index_day (index daily)",
                            sql: "CREATE TABLE IF NOT EXISTS ts_index_day (
                                day TEXT,
                                code TEXT,
                                name TEXT,
                                price REAL,
                                pct REAL,
                                amount REAL,
                                PRIMARY KEY (day, code)
                            );",
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 19,
                            description: "create ts_sector_day (sector daily)",
                            sql: "CREATE TABLE IF NOT EXISTS ts_sector_day (
                                day TEXT,
                                kind TEXT,
                                code TEXT,
                                name TEXT,
                                change_pct REAL,
                                net_amount REAL,
                                lead_code TEXT,
                                lead_name TEXT,
                                lead_pct REAL,
                                PRIMARY KEY (day, code)
                            );",
                            kind: MigrationKind::Up,
                        },
                        // ===== v0.52 画线工具：按 股票+周期 作用域持久化 =====
                        Migration {
                            version: 20,
                            description: "create drawing (chart drawings persisted per scope)",
                            sql: "CREATE TABLE IF NOT EXISTS drawing (
                                id INTEGER PRIMARY KEY AUTOINCREMENT,
                                scope TEXT NOT NULL,
                                name TEXT NOT NULL,
                                points TEXT NOT NULL,
                                sort INTEGER NOT NULL DEFAULT 0,
                                updated_at INTEGER NOT NULL
                            );",
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 21,
                            description: "create index idx_drawing_scope",
                            sql: "CREATE INDEX IF NOT EXISTS idx_drawing_scope ON drawing(scope);",
                            kind: MigrationKind::Up,
                        },
                        // ===== v0.53 指标模板：保存 / 复用指标参数与配色 =====
                        Migration {
                            version: 22,
                            description: "create ind_template (named indicator templates)",
                            sql: "CREATE TABLE IF NOT EXISTS ind_template (
                                id INTEGER PRIMARY KEY AUTOINCREMENT,
                                name TEXT NOT NULL UNIQUE,
                                payload TEXT NOT NULL,
                                created_at INTEGER NOT NULL
                            );",
                            kind: MigrationKind::Up,
                        },
                        // ===== v0.61 预警增强：alerts 新增条件列 =====
                        Migration {
                            version: 23,
                            description: "add down_speed to alerts",
                            sql: "ALTER TABLE alerts ADD COLUMN down_speed REAL;",
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 24,
                            description: "add min_turnover to alerts",
                            sql: "ALTER TABLE alerts ADD COLUMN min_turnover REAL;",
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 25,
                            description: "add min_amount to alerts",
                            sql: "ALTER TABLE alerts ADD COLUMN min_amount REAL;",
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 26,
                            description: "add seal_limit_up to alerts",
                            sql: "ALTER TABLE alerts ADD COLUMN seal_limit_up INTEGER;",
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 27,
                            description: "add seal_limit_down to alerts",
                            sql: "ALTER TABLE alerts ADD COLUMN seal_limit_down INTEGER;",
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 28,
                            description: "add broken_limit to alerts",
                            sql: "ALTER TABLE alerts ADD COLUMN broken_limit INTEGER;",
                            kind: MigrationKind::Up,
                        },
                        // ===== 触发历史持久化（前端写入，便于复盘）=====
                        Migration {
                            version: 29,
                            description: "create alert_event (alert trigger history)",
                            sql: "CREATE TABLE IF NOT EXISTS alert_event (
                                id INTEGER PRIMARY KEY AUTOINCREMENT,
                                rule_id TEXT,
                                code TEXT,
                                name TEXT,
                                kind TEXT,
                                label TEXT,
                                message TEXT,
                                price REAL,
                                pct REAL,
                                target REAL,
                                tone TEXT,
                                triggered_at INTEGER
                            );",
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 30,
                            description: "create index idx_alert_event_time",
                            sql: "CREATE INDEX IF NOT EXISTS idx_alert_event_time ON alert_event(triggered_at);",
                            kind: MigrationKind::Up,
                        },
                        // ===== 卡片皮肤包（v0.90；spec 由前端幂等 seed）=====
                        Migration {
                            version: 31,
                            description: "create skin",
                            sql: "CREATE TABLE IF NOT EXISTS skin (
                                id TEXT PRIMARY KEY,
                                name TEXT NOT NULL,
                                spec TEXT NOT NULL,
                                builtin INTEGER NOT NULL DEFAULT 0,
                                created_at INTEGER,
                                updated_at INTEGER
                            );",
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 32,
                            description: "collector run status",
                            sql: "CREATE TABLE IF NOT EXISTS collector_run (
                                id INTEGER PRIMARY KEY AUTOINCREMENT,
                                trade_date TEXT NOT NULL,
                                job TEXT NOT NULL,
                                status TEXT NOT NULL,
                                rows_affected INTEGER DEFAULT 0,
                                error TEXT,
                                started_at INTEGER NOT NULL,
                                finished_at INTEGER,
                                UNIQUE(trade_date, job)
                            );",
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 33,
                            description: "theme profile",
                            sql: "CREATE TABLE IF NOT EXISTS theme (
                                id INTEGER PRIMARY KEY AUTOINCREMENT,
                                name TEXT NOT NULL UNIQUE,
                                aliases TEXT DEFAULT '',
                                level TEXT DEFAULT '分支',
                                stage TEXT DEFAULT '萌芽',
                                intro TEXT DEFAULT '',
                                logic TEXT DEFAULT '',
                                logic_version INTEGER DEFAULT 1,
                                first_seen_date TEXT,
                                last_active_date TEXT,
                                created_at INTEGER NOT NULL,
                                updated_at INTEGER NOT NULL
                            );",
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 34,
                            description: "theme stock membership",
                            sql: "CREATE TABLE IF NOT EXISTS theme_stock (
                                id INTEGER PRIMARY KEY AUTOINCREMENT,
                                theme_id INTEGER NOT NULL REFERENCES theme(id),
                                code TEXT NOT NULL,
                                name TEXT DEFAULT '',
                                role TEXT NOT NULL DEFAULT '跟风',
                                role_score REAL DEFAULT 0,
                                joined_date TEXT NOT NULL,
                                left_date TEXT,
                                UNIQUE(theme_id, code)
                            );
                            CREATE INDEX IF NOT EXISTS idx_theme_stock_code ON theme_stock(code);",
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 35,
                            description: "catalyst events",
                            sql: "CREATE TABLE IF NOT EXISTS catalyst (
                                id INTEGER PRIMARY KEY AUTOINCREMENT,
                                kind TEXT NOT NULL,
                                title TEXT NOT NULL,
                                summary TEXT DEFAULT '',
                                source TEXT NOT NULL,
                                source_url TEXT DEFAULT '',
                                published_at INTEGER,
                                direction TEXT DEFAULT '中性',
                                theme_id INTEGER REFERENCES theme(id),
                                code TEXT,
                                fresh_score REAL DEFAULT 1,
                                content_hash TEXT NOT NULL UNIQUE,
                                collected_at INTEGER NOT NULL
                            );
                            CREATE INDEX IF NOT EXISTS idx_catalyst_code ON catalyst(code);
                            CREATE INDEX IF NOT EXISTS idx_catalyst_theme ON catalyst(theme_id);",
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 36,
                            description: "daily limit-up snapshot",
                            sql: "CREATE TABLE IF NOT EXISTS limit_up_record (
                                id INTEGER PRIMARY KEY AUTOINCREMENT,
                                trade_date TEXT NOT NULL,
                                code TEXT NOT NULL,
                                name TEXT DEFAULT '',
                                boards INTEGER DEFAULT 1,
                                first_seal INTEGER,
                                last_seal INTEGER,
                                seal_fund REAL DEFAULT 0,
                                broken INTEGER DEFAULT 0,
                                turnover REAL DEFAULT 0,
                                industry TEXT DEFAULT '',
                                concepts TEXT DEFAULT '',
                                UNIQUE(trade_date, code)
                            );",
                            kind: MigrationKind::Up,
                        },
                        // ===== v2.0 AI 决策：策略 profile（版本化，可克隆/回滚）=====
                        Migration {
                            version: 37,
                            description: "create strategy_profile (versioned strategy configs)",
                            sql: "CREATE TABLE IF NOT EXISTS strategy_profile (
                                id INTEGER PRIMARY KEY AUTOINCREMENT,
                                key TEXT NOT NULL,
                                name TEXT NOT NULL,
                                version INTEGER NOT NULL DEFAULT 1,
                                builtin INTEGER NOT NULL DEFAULT 0,
                                is_current INTEGER NOT NULL DEFAULT 1,
                                spec TEXT NOT NULL,
                                note TEXT DEFAULT '',
                                parent_id INTEGER,
                                created_at INTEGER NOT NULL,
                                updated_at INTEGER NOT NULL,
                                UNIQUE(key, version)
                            );
                            CREATE INDEX IF NOT EXISTS idx_strategy_profile_key
                                ON strategy_profile(key, is_current);",
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 38,
                            description: "create ai_review (market/theme/stock reviews)",
                            sql: "CREATE TABLE IF NOT EXISTS ai_review (
                                id INTEGER PRIMARY KEY AUTOINCREMENT,
                                trade_date TEXT NOT NULL,
                                scope TEXT NOT NULL,
                                subject TEXT NOT NULL DEFAULT '',
                                title TEXT DEFAULT '',
                                summary TEXT DEFAULT '',
                                content TEXT NOT NULL,
                                evidence TEXT NOT NULL DEFAULT '[]',
                                model TEXT DEFAULT '',
                                tokens INTEGER DEFAULT 0,
                                created_at INTEGER NOT NULL,
                                UNIQUE(trade_date, scope, subject)
                            );
                            CREATE INDEX IF NOT EXISTS idx_ai_review_date
                                ON ai_review(trade_date, scope);",
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 39,
                            description: "create plan (next-day battle plan)",
                            sql: "CREATE TABLE IF NOT EXISTS plan (
                                id INTEGER PRIMARY KEY AUTOINCREMENT,
                                plan_date TEXT NOT NULL,
                                title TEXT DEFAULT '',
                                market_view TEXT DEFAULT '',
                                status TEXT NOT NULL DEFAULT 'draft',
                                profile_key TEXT DEFAULT '',
                                source_review_date TEXT DEFAULT '',
                                model TEXT DEFAULT '',
                                created_at INTEGER NOT NULL,
                                updated_at INTEGER NOT NULL,
                                UNIQUE(plan_date)
                            );",
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 40,
                            description: "create plan_instruction (watch/candidate/trigger)",
                            sql: "CREATE TABLE IF NOT EXISTS plan_instruction (
                                id INTEGER PRIMARY KEY AUTOINCREMENT,
                                plan_id INTEGER NOT NULL REFERENCES plan(id),
                                tier TEXT NOT NULL DEFAULT 'watch',
                                code TEXT DEFAULT '',
                                name TEXT DEFAULT '',
                                theme TEXT DEFAULT '',
                                condition TEXT DEFAULT '',
                                action TEXT DEFAULT '',
                                position_hint TEXT DEFAULT '',
                                alert_rule TEXT DEFAULT '{}',
                                status TEXT NOT NULL DEFAULT 'open',
                                sort INTEGER NOT NULL DEFAULT 0
                            );
                            CREATE INDEX IF NOT EXISTS idx_plan_instruction_plan
                                ON plan_instruction(plan_id, sort);",
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 41,
                            description: "create company_note (per-stock notes)",
                            sql: "CREATE TABLE IF NOT EXISTS company_note (
                                id INTEGER PRIMARY KEY AUTOINCREMENT,
                                code TEXT NOT NULL,
                                trade_date TEXT DEFAULT '',
                                title TEXT DEFAULT '',
                                content TEXT DEFAULT '',
                                tags TEXT DEFAULT '',
                                created_at INTEGER NOT NULL,
                                updated_at INTEGER NOT NULL
                            );
                            CREATE INDEX IF NOT EXISTS idx_company_note_code
                                ON company_note(code);",
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 42,
                            description: "create decision_log (fast-brain decisions audit/replay)",
                            sql: "CREATE TABLE IF NOT EXISTS decision_log (
                                id INTEGER PRIMARY KEY AUTOINCREMENT,
                                trade_date TEXT NOT NULL,
                                ts TEXT DEFAULT '',
                                code TEXT NOT NULL,
                                name TEXT DEFAULT '',
                                strategy TEXT DEFAULT '',
                                instr_id INTEGER,
                                label TEXT NOT NULL,
                                confidence REAL DEFAULT 0,
                                probs TEXT DEFAULT '{}',
                                features TEXT DEFAULT '{}',
                                mode TEXT DEFAULT 'rule',
                                action TEXT DEFAULT 'drop',
                                model_version TEXT DEFAULT '',
                                infer_ms REAL DEFAULT 0,
                                created_at INTEGER NOT NULL
                            );
                            CREATE INDEX IF NOT EXISTS idx_decision_log_code
                                ON decision_log(code, created_at);
                            CREATE INDEX IF NOT EXISTS idx_decision_log_date
                                ON decision_log(trade_date);",
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 43,
                            description: "create model_version (fast/slow model registry)",
                            sql: "CREATE TABLE IF NOT EXISTS model_version (
                                id INTEGER PRIMARY KEY AUTOINCREMENT,
                                kind TEXT DEFAULT 'fast',
                                version TEXT NOT NULL,
                                provider TEXT DEFAULT '',
                                active INTEGER DEFAULT 1,
                                note TEXT DEFAULT '',
                                created_at INTEGER NOT NULL
                            );",
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 44,
                            description: "create trade_label (decision outcome labeling / evolution feedback)",
                            sql: "CREATE TABLE IF NOT EXISTS trade_label (
                                id INTEGER PRIMARY KEY AUTOINCREMENT,
                                decision_id INTEGER NOT NULL UNIQUE,
                                trade_date TEXT DEFAULT '',
                                code TEXT NOT NULL,
                                name TEXT DEFAULT '',
                                decision_label TEXT DEFAULT '',
                                model_version TEXT DEFAULT '',
                                strategy TEXT DEFAULT '',
                                entry_price REAL DEFAULT 0,
                                ret1d REAL DEFAULT 0,
                                ret2d REAL DEFAULT 0,
                                ret3d REAL DEFAULT 0,
                                ret5d REAL DEFAULT 0,
                                max_gain REAL DEFAULT 0,
                                max_pain REAL DEFAULT 0,
                                hit_stop INTEGER DEFAULT 0,
                                hit_target INTEGER DEFAULT 0,
                                horizon_days INTEGER DEFAULT 0,
                                verdict TEXT DEFAULT 'neutral',
                                miss_type TEXT DEFAULT 'none',
                                checked_at INTEGER NOT NULL
                            );
                            CREATE INDEX IF NOT EXISTS idx_trade_label_model
                                ON trade_label(model_version, strategy);
                            CREATE INDEX IF NOT EXISTS idx_trade_label_verdict
                                ON trade_label(verdict);
                            CREATE INDEX IF NOT EXISTS idx_trade_label_date
                                ON trade_label(trade_date);",
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 45,
                            description: "create signal_ticket + signal_audit (manual-confirm broker bridge)",
                            sql: "CREATE TABLE IF NOT EXISTS signal_ticket (
                                id INTEGER PRIMARY KEY AUTOINCREMENT,
                                sig_id TEXT NOT NULL UNIQUE,
                                trade_date TEXT DEFAULT '',
                                created_at INTEGER NOT NULL,
                                code TEXT NOT NULL,
                                name TEXT DEFAULT '',
                                side TEXT DEFAULT '',
                                source TEXT DEFAULT '',
                                model_version TEXT DEFAULT '',
                                strategy TEXT DEFAULT '',
                                confidence REAL DEFAULT 0,
                                ref_price REAL DEFAULT 0,
                                price REAL DEFAULT 0,
                                vol INTEGER DEFAULT 0,
                                amount REAL DEFAULT 0,
                                reason TEXT DEFAULT '',
                                status TEXT DEFAULT 'pending',
                                action_kind TEXT DEFAULT '',
                                broker TEXT DEFAULT '',
                                order_text TEXT DEFAULT '',
                                decided_by TEXT DEFAULT '',
                                decided_at INTEGER DEFAULT 0,
                                updated_at INTEGER DEFAULT 0
                            );
                            CREATE INDEX IF NOT EXISTS idx_signal_status ON signal_ticket(status);
                            CREATE INDEX IF NOT EXISTS idx_signal_code ON signal_ticket(code);
                            CREATE INDEX IF NOT EXISTS idx_signal_date ON signal_ticket(trade_date);
                            CREATE TABLE IF NOT EXISTS signal_audit (
                                id INTEGER PRIMARY KEY AUTOINCREMENT,
                                sig_id TEXT NOT NULL,
                                action TEXT DEFAULT '',
                                detail TEXT DEFAULT '',
                                actor TEXT DEFAULT '',
                                created_at INTEGER NOT NULL
                            );
                            CREATE INDEX IF NOT EXISTS idx_signal_audit_sig ON signal_audit(sig_id);",
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 46,
                            description: "create plugin registry / kv / audit tables",
                            sql: "CREATE TABLE IF NOT EXISTS plugin_registry(
                                id INTEGER PRIMARY KEY AUTOINCREMENT,
                                plugin_id TEXT UNIQUE, name TEXT, version TEXT,
                                api_version INTEGER, builtin INTEGER, source_path TEXT,
                                enabled INTEGER, signed INTEGER, signature TEXT, hash TEXT,
                                permissions TEXT, status TEXT, error_msg TEXT,
                                installed_at INTEGER, updated_at INTEGER);
                             CREATE TABLE IF NOT EXISTS plugin_kv(
                                id INTEGER PRIMARY KEY AUTOINCREMENT,
                                plugin_id TEXT, key TEXT, value TEXT, updated_at INTEGER,
                                UNIQUE(plugin_id, key));
                             CREATE TABLE IF NOT EXISTS plugin_audit(
                                id INTEGER PRIMARY KEY AUTOINCREMENT,
                                plugin_id TEXT, action TEXT, method TEXT, detail TEXT,
                                created_at INTEGER);",
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 47,
                            description: "create conditional_order (local conditional trading orders)",
                            sql: "CREATE TABLE IF NOT EXISTS conditional_order (
                                id INTEGER PRIMARY KEY AUTOINCREMENT,
                                co_id TEXT NOT NULL UNIQUE,
                                trade_date TEXT DEFAULT '',
                                code TEXT NOT NULL,
                                name TEXT DEFAULT '',
                                side TEXT NOT NULL,
                                trigger_json TEXT NOT NULL,
                                price_mode TEXT DEFAULT 'trigger',
                                limit_price REAL DEFAULT 0,
                                vol INTEGER NOT NULL,
                                ttl TEXT DEFAULT 'day',
                                expire_at INTEGER DEFAULT 0,
                                auto_confirm INTEGER DEFAULT 0,
                                status TEXT DEFAULT 'active',
                                ticket_id TEXT DEFAULT '',
                                note TEXT DEFAULT '',
                                created_at INTEGER NOT NULL,
                                updated_at INTEGER DEFAULT 0,
                                triggered_at INTEGER DEFAULT 0
                            );
                            CREATE INDEX IF NOT EXISTS idx_co_status ON conditional_order(status);
                            CREATE INDEX IF NOT EXISTS idx_co_code ON conditional_order(code);",
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 48,
                            description: "create hist_kline + trade_calendar (multi-year history)",
                            sql: "CREATE TABLE IF NOT EXISTS hist_kline (
                                id INTEGER PRIMARY KEY AUTOINCREMENT,
                                code TEXT NOT NULL,
                                period INTEGER NOT NULL,
                                adj TEXT NOT NULL DEFAULT 'qfq',
                                date TEXT NOT NULL,
                                open REAL NOT NULL,
                                close REAL NOT NULL,
                                high REAL NOT NULL,
                                low REAL NOT NULL,
                                volume REAL NOT NULL DEFAULT 0,
                                amount REAL NOT NULL DEFAULT 0,
                                UNIQUE(code, period, adj, date)
                            );
                            CREATE INDEX IF NOT EXISTS idx_hist_kline_lookup ON hist_kline(code, period, adj, date);
                            CREATE TABLE IF NOT EXISTS trade_calendar (
                                date TEXT PRIMARY KEY,
                                is_open INTEGER NOT NULL DEFAULT 1
                            );",
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 49,
                            description: "backfill broker_order table + paper_order.sig_id (unified ledger)",
                            sql: "CREATE TABLE IF NOT EXISTS broker_order (
                                id INTEGER PRIMARY KEY AUTOINCREMENT,
                                sig_id TEXT UNIQUE,
                                broker_kind TEXT,
                                broker_account TEXT,
                                broker_order_id TEXT,
                                code TEXT,
                                side TEXT,
                                price REAL,
                                vol INTEGER,
                                status TEXT,
                                filled_vol INTEGER,
                                filled_avg_price REAL,
                                error_msg TEXT,
                                created_at INTEGER,
                                updated_at INTEGER
                            );
                            ALTER TABLE paper_order ADD COLUMN sig_id TEXT DEFAULT '';
                            ALTER TABLE paper_order ADD COLUMN realized_pnl REAL DEFAULT 0;",
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 50,
                            description: "rebuild ts_sector_day: PK +kind, add up/down/limitup counts, turnover, amount",
                            sql: "CREATE TABLE IF NOT EXISTS ts_sector_day_new (
                                day TEXT NOT NULL,
                                kind TEXT NOT NULL DEFAULT 'industry',
                                code TEXT NOT NULL,
                                name TEXT,
                                change_pct REAL,
                                net_amount REAL,
                                lead_code TEXT,
                                lead_name TEXT,
                                lead_pct REAL,
                                up_count INTEGER NOT NULL DEFAULT 0,
                                down_count INTEGER NOT NULL DEFAULT 0,
                                limit_up INTEGER NOT NULL DEFAULT 0,
                                turnover REAL NOT NULL DEFAULT 0,
                                amount REAL NOT NULL DEFAULT 0,
                                PRIMARY KEY (day, kind, code)
                            );
                            INSERT INTO ts_sector_day_new
                                (day, kind, code, name, change_pct, net_amount, lead_code, lead_name, lead_pct)
                            SELECT day, COALESCE(kind, 'industry'), code, name, change_pct, net_amount,
                                lead_code, lead_name, lead_pct
                            FROM ts_sector_day;
                            DROP TABLE ts_sector_day;
                            ALTER TABLE ts_sector_day_new RENAME TO ts_sector_day;
                            CREATE INDEX IF NOT EXISTS idx_sector_day_lookup ON ts_sector_day(day, kind);",
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 51,
                            description: "create backtest_run (backtest engine result storage)",
                            sql: "CREATE TABLE IF NOT EXISTS backtest_run (
                                id INTEGER PRIMARY KEY AUTOINCREMENT,
                                name TEXT NOT NULL DEFAULT '',
                                start TEXT NOT NULL,
                                end TEXT NOT NULL,
                                params_json TEXT NOT NULL DEFAULT '{}',
                                result_json TEXT NOT NULL,
                                created_at INTEGER NOT NULL
                            );",
                            kind: MigrationKind::Up,
                        },
                        Migration {
                            version: 52,
                            description: "create tuning_proposal (backtest-to-live human approval queue)",
                            sql: "CREATE TABLE IF NOT EXISTS tuning_proposal (
                                id INTEGER PRIMARY KEY AUTOINCREMENT,
                                backtest_id INTEGER,
                                payload_json TEXT NOT NULL,
                                baseline_json TEXT NOT NULL DEFAULT '{}',
                                status TEXT NOT NULL DEFAULT 'pending',
                                decided_at INTEGER NOT NULL DEFAULT 0,
                                created_at INTEGER NOT NULL
                            );",
                            kind: MigrationKind::Up,
                        },
    ]
}
