// P5 模型接管：rule → shadow → canary → live 状态机。
//
// 四阶段（只许逐级前进、随时可一键回退规则脑）：
//   rule    规则脑执行（默认，最安全）。
//   shadow  影子观察：规则脑照常执行，影子脑（laya/cloud）每信号同时决策但只记录、不执行，
//           累计一致率 / 决策耗时，作为能否灰度的客观依据。
//   canary  灰度：按 gray_pct 比例（按标的代码确定性分流，同一只票始终走同一脑）让影子脑执行，
//           且强制小仓位（small_position_pct 上限）；影子脑连续失败自动回退规则脑。
//   live    影子脑全量接管（真实通道必须已武装、且强制半自动）。
//
// 所有阶段切换都经人工审批并写 signal_audit；任何异常/故障/急停都可回退 rule。
use crate::ai::{maindb, now_millis};
use rusqlite::Connection;
use serde::Serialize;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::Path;
use tauri::{AppHandle, State};

pub const STAGE_RULE: &str = "rule";
pub const STAGE_SHADOW: &str = "shadow";
pub const STAGE_CANARY: &str = "canary";
pub const STAGE_LIVE: &str = "live";

/// 影子脑连续失败达到该次数，自动回退规则脑（canary/live 阶段）。
pub const AUTO_ROLLBACK_FAILS: i64 = 5;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Rollout {
    pub stage: String,
    pub requested_stage: String,
    pub request_json: String,
    pub status: String,
    pub gray_pct: f64,
    pub small_position_pct: f64,
    pub shadow_min_samples: i64,
    pub shadow_min_agree_pct: f64,
    pub fail_count: i64,
    pub approved_at: i64,
    pub approve_note: String,
    pub rollback_reason: String,
    pub updated_at: i64,
}

impl Default for Rollout {
    fn default() -> Self {
        Rollout {
            stage: STAGE_RULE.to_string(),
            requested_stage: String::new(),
            request_json: "{}".to_string(),
            status: "active".to_string(),
            gray_pct: 10.0,
            small_position_pct: 5.0,
            shadow_min_samples: 100,
            shadow_min_agree_pct: 60.0,
            fail_count: 0,
            approved_at: 0,
            approve_note: String::new(),
            rollback_reason: String::new(),
            updated_at: 0,
        }
    }
}

fn audit(conn: &Connection, action: &str, detail: &str) {
    let _ = conn.execute(
        "INSERT INTO signal_audit(sig_id,action,detail,actor,created_at)
         VALUES(?1,?2,?3,?4,?5)",
        rusqlite::params!["BRAIN", action, detail, "brain_rollout", now_millis()],
    );
}

pub fn load(conn: &Connection) -> Rollout {
    let r = conn.query_row(
        "SELECT stage,requested_stage,request_json,status,gray_pct,small_position_pct,
                shadow_min_samples,shadow_min_agree_pct,fail_count,approved_at,
                approve_note,rollback_reason,updated_at
         FROM brain_rollout WHERE id=1",
        [],
        |row| {
            Ok(Rollout {
                stage: row.get(0)?,
                requested_stage: row.get(1)?,
                request_json: row.get(2)?,
                status: row.get(3)?,
                gray_pct: row.get(4)?,
                small_position_pct: row.get(5)?,
                shadow_min_samples: row.get(6)?,
                shadow_min_agree_pct: row.get(7)?,
                fail_count: row.get(8)?,
                approved_at: row.get(9)?,
                approve_note: row.get(10)?,
                rollback_reason: row.get(11)?,
                updated_at: row.get(12)?,
            })
        },
    );
    r.unwrap_or_default()
}

fn save(conn: &Connection, r: &Rollout) {
    let _ = conn.execute(
        "UPDATE brain_rollout SET
           stage=?1,requested_stage=?2,request_json=?3,status=?4,gray_pct=?5,
           small_position_pct=?6,shadow_min_samples=?7,shadow_min_agree_pct=?8,fail_count=?9,
           approved_at=?10,approve_note=?11,rollback_reason=?12,updated_at=?13
         WHERE id=1",
        rusqlite::params![
            r.stage,
            r.requested_stage,
            r.request_json,
            r.status,
            r.gray_pct,
            r.small_position_pct,
            r.shadow_min_samples,
            r.shadow_min_agree_pct,
            r.fail_count,
            r.approved_at,
            r.approve_note,
            r.rollback_reason,
            now_millis(),
        ],
    );
}

fn next_stage(cur: &str) -> Option<&'static str> {
    match cur {
        STAGE_RULE => Some(STAGE_SHADOW),
        STAGE_SHADOW => Some(STAGE_CANARY),
        STAGE_CANARY => Some(STAGE_LIVE),
        _ => None,
    }
}

/// 影子决策记录（由 autoexec 决策循环填充）。
#[derive(Default, Clone)]
pub struct ShadowRec<'a> {
    pub code: &'a str,
    pub name: &'a str,
    pub strategy: &'a str,
    pub side: &'a str,
    pub rule_label: &'a str,
    pub rule_conf: f64,
    pub rule_model: &'a str,
    pub shadow_label: &'a str,
    pub shadow_conf: f64,
    pub shadow_model: &'a str,
    pub shadow_ok: bool,
    pub executed_brain: &'a str,
    pub rule_infer_ms: i64,
    pub shadow_infer_ms: i64,
    pub features_json: &'a str,
}

/// 毫秒时间戳转北京时间（date, hh:mm:ss）。
fn beijing_from_millis(ms: i64) -> (String, String) {
    let secs = ms / 1000 + 8 * 3600;
    let days = secs.div_euclid(86400);
    let tod = secs.rem_euclid(86400);
    // Howard Hinnant civil_from_days
    let z = days + 719468;
    let era = if z >= 0 { z / 146097 } else { (z - 146096) / 146097 };
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    let (h, mi, s) = (tod / 3600, (tod % 3600) / 60, tod % 60);
    (
        format!("{y:04}-{m:02}-{d:02}"),
        format!("{h:02}:{mi:02}:{s:02}"),
    )
}

pub fn record_shadow(conn: &Connection, rec: &ShadowRec<'_>) {
    let (date, ts) = beijing_from_millis(now_millis());
    let agree = if rec.shadow_ok {
        rec.rule_label == rec.shadow_label
    } else {
        false
    };
    let _ = conn.execute(
        "INSERT INTO shadow_decision
           (trade_date,ts,created_at,code,name,strategy,side,
            rule_label,rule_conf,rule_model,shadow_label,shadow_conf,shadow_model,
            shadow_ok,agree,executed_brain,rule_infer_ms,shadow_infer_ms,features_json)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19)",
        rusqlite::params![
            date,
            ts,
            now_millis(),
            rec.code,
            rec.name,
            rec.strategy,
            rec.side,
            rec.rule_label,
            rec.rule_conf,
            rec.rule_model,
            rec.shadow_label,
            rec.shadow_conf,
            rec.shadow_model,
            rec.shadow_ok as i64,
            agree as i64,
            rec.executed_brain,
            rec.rule_infer_ms,
            rec.shadow_infer_ms,
            rec.features_json,
        ],
    );
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ShadowStats {
    pub samples: i64,
    pub shadow_ok_samples: i64,
    pub laya_available: bool,
    pub agree_pct: f64,
    pub disagree_pct: f64,
    pub rule_p50_ms: f64,
    pub rule_p99_ms: f64,
    pub shadow_p50_ms: f64,
    pub shadow_p99_ms: f64,
    pub meets_canary: bool,
}

fn percentile(sorted: &[i64], q: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let idx = (((sorted.len() as f64 - 1.0) * q).round() as usize).min(sorted.len() - 1);
    sorted[idx] as f64
}

pub fn shadow_stats(conn: &Connection) -> ShadowStats {
    let rollout = load(conn);
    let samples: i64 = conn
        .query_row("SELECT COUNT(*) FROM shadow_decision", [], |row| row.get(0))
        .unwrap_or(0);
    let ok: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM shadow_decision WHERE shadow_ok=1",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    let agree: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM shadow_decision WHERE shadow_ok=1 AND agree=1",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    // laya 最近是否可用：最近 20 条里至少 1 条成功
    let recent_ok: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM (SELECT shadow_ok FROM shadow_decision ORDER BY id DESC LIMIT 20)
             WHERE shadow_ok=1",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    let mut rule_ms: Vec<i64> = Vec::new();
    let mut shadow_ms: Vec<i64> = Vec::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT rule_infer_ms,shadow_infer_ms,shadow_ok FROM shadow_decision
                 WHERE id > (SELECT COALESCE(MAX(id),0)-2000 FROM shadow_decision)",
            )
            .unwrap();
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })
            .unwrap();
        for r in rows.flatten() {
            if r.0 > 0 {
                rule_ms.push(r.0);
            }
            if r.2 == 1 && r.1 > 0 {
                shadow_ms.push(r.1);
            }
        }
    }
    rule_ms.sort_unstable();
    shadow_ms.sort_unstable();
    let agree_pct = if ok > 0 {
        agree as f64 * 100.0 / ok as f64
    } else {
        0.0
    };
    let meets = ok >= rollout.shadow_min_samples && agree_pct >= rollout.shadow_min_agree_pct;
    ShadowStats {
        samples,
        shadow_ok_samples: ok,
        laya_available: recent_ok > 0,
        agree_pct: (agree_pct * 10.0).round() / 10.0,
        disagree_pct: ((100.0 - agree_pct) * 10.0).round() / 10.0,
        rule_p50_ms: percentile(&rule_ms, 0.5),
        rule_p99_ms: percentile(&rule_ms, 0.99),
        shadow_p50_ms: percentile(&shadow_ms, 0.5),
        shadow_p99_ms: percentile(&shadow_ms, 0.99),
        meets_canary: meets,
    }
}

/// 灰度阶段按标的代码确定性分流：同一只票始终走同一脑，避免反复横跳。
/// 返回应执行的脑："rule" / "laya"。
pub fn pick_exec_brain(stage: &str, gray_pct: f64, code: &str) -> &'static str {
    match stage {
        STAGE_CANARY => {
            let mut h = DefaultHasher::new();
            code.hash(&mut h);
            let bucket = (h.finish() % 100) as f64;
            if bucket < gray_pct.clamp(0.0, 100.0) {
                "laya"
            } else {
                "rule"
            }
        }
        STAGE_LIVE => "laya",
        _ => "rule",
    }
}

/// 申请进入下一阶段（进入 pending，等待人工审批）。
#[allow(clippy::too_many_arguments)]
pub fn apply_request(
    conn: &Connection,
    target: &str,
    gray_pct: f64,
    small_position_pct: f64,
    shadow_min_samples: i64,
    shadow_min_agree_pct: f64,
    note: &str,
    live_armed: bool,
) -> Result<Rollout, String> {
    let mut r = load(conn);
    if r.status == "pending" {
        return Err("已有待审批的接管申请，请先审批或撤销".to_string());
    }
    let want = next_stage(&r.stage);
    if want != Some(target) {
        let expected = want.unwrap_or("（已到最终阶段，如需返回请用一键回退）");
        return Err(format!(
            "当前为「{}」阶段，只能申请进入「{}」，不能越级申请「{}」",
            stage_label(&r.stage),
            stage_label(expected),
            stage_label(target)
        ));
    }
    if target == STAGE_CANARY {
        if !(0.0..=100.0).contains(&gray_pct) {
            return Err("灰度比例须在 0–100 之间".to_string());
        }
        if !(0.0..=100.0).contains(&small_position_pct) || small_position_pct <= 0.0 {
            return Err("灰度小仓位上限须大于 0、不超过 100（%）".to_string());
        }
        let st = shadow_stats(conn);
        if !st.meets_canary {
            return Err(format!(
                "影子观察尚未达标：有效样本 {}（需 {}）、一致率 {:.1}%（需 {:.1}%），请先在影子阶段积累足够样本",
                st.shadow_ok_samples, r.shadow_min_samples, st.agree_pct, r.shadow_min_agree_pct
            ));
        }
    }
    if target == STAGE_LIVE && !live_armed {
        return Err("进入「模型接管」前必须先在券商交易中完成实盘武装（限额/白名单/风险确认）".to_string());
    }
    r.gray_pct = gray_pct;
    r.small_position_pct = small_position_pct;
    if shadow_min_samples > 0 {
        r.shadow_min_samples = shadow_min_samples;
    }
    if (0.0..=100.0).contains(&shadow_min_agree_pct) {
        r.shadow_min_agree_pct = shadow_min_agree_pct;
    }
    r.requested_stage = target.to_string();
    r.request_json = serde_json::json!({
        "target": target,
        "grayPct": gray_pct,
        "smallPositionPct": small_position_pct,
        "note": note,
    })
    .to_string();
    r.status = "pending".to_string();
    r.rollback_reason = String::new();
    save(conn, &r);
    audit(
        conn,
        "brain_request",
        &format!("申请进入 {} 阶段：{}", stage_label(target), note),
    );
    Ok(r)
}

/// 人工审批当前申请（approve=true 通过；false 撤销）。
pub fn apply_approve(conn: &Connection, approve: bool, live_armed: bool) -> Result<Rollout, String> {
    let mut r = load(conn);
    if r.status != "pending" || r.requested_stage.is_empty() {
        return Err("当前没有待审批的接管申请".to_string());
    }
    let target = r.requested_stage.clone();
    if !approve {
        r.requested_stage = String::new();
        r.request_json = "{}".to_string();
        r.status = "active".to_string();
        save(conn, &r);
        audit(conn, "brain_request_rejected", &format!("已撤销进入 {} 的申请", stage_label(&target)));
        return Ok(r);
    }
    if target == STAGE_LIVE && !live_armed {
        return Err("审批通过前检测到实盘已解除武装，请重新武装后再审批".to_string());
    }
    r.stage = target.clone();
    r.requested_stage = String::new();
    r.request_json = "{}".to_string();
    r.status = "active".to_string();
    r.fail_count = 0;
    r.approved_at = now_millis();
    r.approve_note = format!("人工审批进入 {}", stage_label(&target));
    save(conn, &r);
    audit(
        conn,
        "brain_approved",
        &format!(
            "已接管至 {} 阶段（灰度 {}%，小仓位 {}%）",
            stage_label(&target),
            r.gray_pct,
            r.small_position_pct
        ),
    );
    Ok(r)
}

/// 一键回退到规则脑（任何阶段、任何时刻可用）。
pub fn apply_rollback(conn: &Connection, reason: &str) -> Rollout {
    let mut r = load(conn);
    let from = r.stage.clone();
    r.stage = STAGE_RULE.to_string();
    r.requested_stage = String::new();
    r.request_json = "{}".to_string();
    r.status = "active".to_string();
    r.fail_count = 0;
    r.rollback_reason = if reason.trim().is_empty() {
        format!("从 {} 手动回退", stage_label(&from))
    } else {
        reason.to_string()
    };
    save(conn, &r);
    audit(conn, "brain_rollback", &format!("{} → 规则脑：{}", stage_label(&from), r.rollback_reason));
    r
}

/// 影子脑/接管脑失败累计；canary/live 阶段连续失败达阈值自动回退。
/// 返回更新后的 rollout（调用方据 stage 是否变为 rule 判断是否已回退）。
pub fn note_failure(conn: &Connection) -> Rollout {
    let mut r = load(conn);
    if r.stage != STAGE_CANARY && r.stage != STAGE_LIVE {
        return r;
    }
    r.fail_count += 1;
    if r.fail_count >= AUTO_ROLLBACK_FAILS {
        save(conn, &r);
        return apply_rollback(
            conn,
            &format!("影子脑连续失败 {} 次，触发自动回退", r.fail_count),
        );
    }
    save(conn, &r);
    r
}

/// 影子脑成功一次，清零失败计数。
pub fn note_success(conn: &Connection) {
    let mut r = load(conn);
    if r.fail_count != 0 {
        r.fail_count = 0;
        save(conn, &r);
    }
}

pub fn stage_label(s: &str) -> &'static str {
    match s {
        STAGE_SHADOW => "影子观察",
        STAGE_CANARY => "灰度接管",
        STAGE_LIVE => "模型接管",
        _ => "规则脑",
    }
}

// ===== Tauri 命令 =====

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RolloutView {
    #[serde(flatten)]
    pub rollout: Rollout,
    pub stats: ShadowStats,
}

#[tauri::command]
pub fn brain_rollout_get(ai: State<'_, crate::ai::AiState>) -> Result<RolloutView, String> {
    let conn = maindb::open_readonly(&ai.dir())?;
    Ok(RolloutView {
        rollout: load(&conn),
        stats: shadow_stats(&conn),
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn brain_rollout_request(
    ai: State<'_, crate::ai::AiState>,
    mgr: State<'_, crate::broker::BrokerManager>,
    app: AppHandle,
    target: String,
    gray_pct: Option<f64>,
    small_position_pct: Option<f64>,
    shadow_min_samples: Option<i64>,
    shadow_min_agree_pct: Option<f64>,
    note: Option<String>,
) -> Result<Rollout, String> {
    crate::license::require_pro(&app)?;
    let conn = maindb::open_readwrite(&ai.dir())?;
    let live_armed = mgr.config.lock().unwrap().live_enabled;
    apply_request(
        &conn,
        &target,
        gray_pct.unwrap_or(10.0),
        small_position_pct.unwrap_or(5.0),
        shadow_min_samples.unwrap_or(0),
        shadow_min_agree_pct.unwrap_or(-1.0),
        &note.unwrap_or_default(),
        live_armed,
    )
}

#[tauri::command]
pub fn brain_rollout_approve(
    ai: State<'_, crate::ai::AiState>,
    mgr: State<'_, crate::broker::BrokerManager>,
    app: AppHandle,
    approve: bool,
) -> Result<Rollout, String> {
    crate::license::require_pro(&app)?;
    let conn = maindb::open_readwrite(&ai.dir())?;
    let live_armed = mgr.config.lock().unwrap().live_enabled;
    apply_approve(&conn, approve, live_armed)
}

#[tauri::command]
pub fn brain_rollout_rollback(
    ai: State<'_, crate::ai::AiState>,
    reason: Option<String>,
) -> Result<Rollout, String> {
    let conn = maindb::open_readwrite(&ai.dir())?;
    Ok(apply_rollback(&conn, &reason.unwrap_or_default()))
}

/// 只读打开（命令复用）。
#[allow(dead_code)]
fn open_ro(dir: &Path) -> Result<Connection, String> {
    maindb::open_readonly(dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memdb() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        // 最小化建表（审计 + 状态机）
        conn.execute_batch(
            "CREATE TABLE signal_audit(sig_id TEXT,action TEXT,detail TEXT,actor TEXT,created_at INTEGER);
             CREATE TABLE brain_rollout (
               id INTEGER PRIMARY KEY CHECK (id=1),
               stage TEXT NOT NULL DEFAULT 'rule', requested_stage TEXT NOT NULL DEFAULT '',
               request_json TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'active',
               gray_pct REAL NOT NULL DEFAULT 10, small_position_pct REAL NOT NULL DEFAULT 5,
               shadow_min_samples INTEGER NOT NULL DEFAULT 100, shadow_min_agree_pct REAL NOT NULL DEFAULT 60,
               fail_count INTEGER NOT NULL DEFAULT 0, approved_at INTEGER NOT NULL DEFAULT 0,
               approve_note TEXT NOT NULL DEFAULT '', rollback_reason TEXT NOT NULL DEFAULT '',
               updated_at INTEGER NOT NULL DEFAULT 0);
             INSERT INTO brain_rollout(id) VALUES(1);
             CREATE TABLE shadow_decision (
               id INTEGER PRIMARY KEY AUTOINCREMENT, trade_date TEXT, ts TEXT, created_at INTEGER,
               code TEXT, name TEXT DEFAULT '', strategy TEXT DEFAULT '', side TEXT DEFAULT '',
               rule_label TEXT DEFAULT '', rule_conf REAL DEFAULT 0, rule_model TEXT DEFAULT '',
               shadow_label TEXT DEFAULT '', shadow_conf REAL DEFAULT 0, shadow_model TEXT DEFAULT '',
               shadow_ok INTEGER DEFAULT 0, agree INTEGER DEFAULT 0, executed_brain TEXT DEFAULT 'rule',
               rule_infer_ms INTEGER DEFAULT 0, shadow_infer_ms INTEGER DEFAULT 0, features_json TEXT DEFAULT '{}');",
        )
        .unwrap();
        conn
    }

    fn seed_shadow(conn: &Connection, n: i64, agree: bool, ok: bool) {
        for i in 0..n {
            let sl = if agree { "watch_up" } else { "hold" };
            conn.execute(
                "INSERT INTO shadow_decision(trade_date,ts,created_at,code,rule_label,shadow_label,
                   shadow_ok,agree,executed_brain,rule_infer_ms,shadow_infer_ms)
                 VALUES('2026-10-17','10:00:00',?1,?2,'watch_up',?3,?4,?5,'rule',10,20)",
                rusqlite::params![
                    i,
                    format!("60000{i}"),
                    sl,
                    ok as i64,
                    (ok && agree) as i64
                ],
            )
            .unwrap();
        }
    }

    #[test]
    fn rule_request_shadow_ok() {
        let conn = memdb();
        let r = apply_request(&conn, STAGE_SHADOW, 10.0, 5.0, 0, -1.0, "", false).unwrap();
        assert_eq!(r.status, "pending");
        assert_eq!(r.requested_stage, "shadow");
        let r = apply_approve(&conn, true, false).unwrap();
        assert_eq!(r.stage, "shadow");
    }

    #[test]
    fn cannot_skip_stage() {
        let conn = memdb();
        // rule 不能直接申请 canary
        assert!(apply_request(&conn, STAGE_CANARY, 10.0, 5.0, 0, -1.0, "", false).is_err());
    }

    #[test]
    fn canary_requires_shadow_qualification() {
        let conn = memdb();
        apply_request(&conn, STAGE_SHADOW, 10.0, 5.0, 0, -1.0, "", false).unwrap();
        apply_approve(&conn, true, false).unwrap();
        // 无影子样本 → 拒绝灰度
        assert!(apply_request(&conn, STAGE_CANARY, 10.0, 5.0, 0, -1.0, "", false).is_err());
    }

    #[test]
    fn canary_allowed_after_qualified_shadow() {
        let conn = memdb();
        // 门槛降到 10 样本 60%
        apply_request(&conn, STAGE_SHADOW, 10.0, 5.0, 10, 60.0, "", false).unwrap();
        apply_approve(&conn, true, false).unwrap();
        seed_shadow(&conn, 12, true, true);
        let r = apply_request(&conn, STAGE_CANARY, 20.0, 5.0, 0, -1.0, "", false).unwrap();
        assert_eq!(r.requested_stage, "canary");
        apply_approve(&conn, true, false).unwrap();
        let r = load(&conn);
        assert_eq!(r.stage, "canary");
        assert_eq!(r.gray_pct, 20.0);
    }

    #[test]
    fn live_requires_armed() {
        let conn = memdb();
        apply_request(&conn, STAGE_SHADOW, 10.0, 5.0, 1, 1.0, "", false).unwrap();
        apply_approve(&conn, true, false).unwrap();
        seed_shadow(&conn, 1, true, true);
        // 审批 canary 不要求武装
        apply_request(&conn, STAGE_CANARY, 100.0, 10.0, 0, -1.0, "", false).unwrap();
        apply_approve(&conn, true, false).unwrap();
        assert_eq!(load(&conn).stage, "canary");
        // 申请 live 但未武装 → 拒绝（仍停留在 canary）
        assert!(apply_request(&conn, STAGE_LIVE, 100.0, 10.0, 0, -1.0, "", false).is_err());
        assert_eq!(load(&conn).stage, "canary");
        // 武装后可申请，审批前若解除武装仍拒绝
        apply_request(&conn, STAGE_LIVE, 100.0, 10.0, 0, -1.0, "", true).unwrap();
        assert!(apply_approve(&conn, true, false).is_err());
        // 武装状态下审批通过
        assert!(apply_approve(&conn, true, true).is_ok());
        assert_eq!(load(&conn).stage, "live");
    }

    #[test]
    fn rollback_always_works() {
        let conn = memdb();
        apply_request(&conn, STAGE_SHADOW, 10.0, 5.0, 0, -1.0, "", false).unwrap();
        apply_approve(&conn, true, false).unwrap();
        let r = apply_rollback(&conn, "手动");
        assert_eq!(r.stage, "rule");
        assert!(r.rollback_reason.contains("手动"));
    }

    #[test]
    fn auto_rollback_after_repeated_failures() {
        let conn = memdb();
        apply_request(&conn, STAGE_SHADOW, 10.0, 5.0, 1, 1.0, "", false).unwrap();
        apply_approve(&conn, true, false).unwrap();
        seed_shadow(&conn, 1, true, true);
        apply_request(&conn, STAGE_CANARY, 100.0, 10.0, 0, -1.0, "", false).unwrap();
        apply_approve(&conn, true, false).unwrap();
        let mut r = load(&conn);
        for _ in 0..AUTO_ROLLBACK_FAILS {
            r = note_failure(&conn);
        }
        assert_eq!(r.stage, "rule", "连续失败达阈值应自动回退");
        assert!(r.rollback_reason.contains("连续失败"));
    }

    #[test]
    fn gray_pick_is_stable_per_code() {
        // 同一代码在固定灰度下结果稳定
        let first = pick_exec_brain(STAGE_CANARY, 50.0, "600000");
        for _ in 0..20 {
            assert_eq!(first, pick_exec_brain(STAGE_CANARY, 50.0, "600000"));
        }
        // 0% 灰度永远规则脑，100% 永远 laya
        assert_eq!(pick_exec_brain(STAGE_CANARY, 0.0, "600000"), "rule");
        assert_eq!(pick_exec_brain(STAGE_CANARY, 100.0, "600000"), "laya");
        assert_eq!(pick_exec_brain(STAGE_LIVE, 0.0, "600000"), "laya");
        assert_eq!(pick_exec_brain(STAGE_SHADOW, 100.0, "600000"), "rule");
    }
}
