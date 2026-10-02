// 回灌进化：对历史快脑决策按后续 N 个交易日真实走势自动打标（good/bad/neutral + 误判类型），
// 按「模型版本 × 策略」聚合胜率 / 盈亏比 / 期望收益 / 误判分布，并做链路一致性校验与过期清理。
// 闭环：特征 → 概率 → 执行 → 标签 → 收益。调参仅产出建议、须人工批准，本模块不自动改 profile。
use crate::ai::maindb;
use crate::market::{self, KBar};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::collections::HashMap;
use tauri::State;

// ===== 打标参数 =====

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EvolutionConfig {
    pub stop_pct: f64,     // 止损阈值（%，负数）
    pub target_pct: f64,   // 止盈阈值（%）
    pub horizon: i64,      // 评估后续交易日数（≤5）
    pub include_watch: bool, // 是否同时评估观察信号（纸面校准阈值）
}

impl Default for EvolutionConfig {
    fn default() -> Self {
        EvolutionConfig {
            stop_pct: -7.0,
            target_pct: 10.0,
            horizon: 5,
            include_watch: true,
        }
    }
}

// ===== 日期（北京时间，无 chrono）=====

fn civil_from_days(z: i64) -> (i32, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 12 { y } else { y + 1 };
    (y as i32, m as u32, d as u32)
}

/// KBar.timestamp（日 K 为「北京收盘 15:00 当作 UTC」的秒/毫秒）→ YYYY-MM-DD。
fn dashed_from_ts(ts: i64) -> String {
    let secs = if ts.abs() > 10_000_000_000 {
        ts.div_euclid(1000)
    } else {
        ts
    };
    let days = secs.div_euclid(86400);
    let (y, m, d) = civil_from_days(days);
    format!("{y}-{m:02}-{d:02}")
}

// ===== 打标判定（纯函数，便于单测）=====

pub struct Outcome {
    pub rets: [Option<f64>; 5],
    pub max_gain: f64,
    pub max_pain: f64,
    pub hit_stop: bool,
    pub hit_target: bool,
    pub horizon_days: usize,
    pub verdict: String,
    pub miss_type: String,
}

/// 给定决策方向、基准价、决策日之后的日 K（升序），输出后续收益与判定。
pub fn evaluate(label: &str, entry: f64, after: &[KBar], cfg: &EvolutionConfig) -> Outcome {
    let h = (cfg.horizon.clamp(1, 5)) as usize;
    let mut rets: [Option<f64>; 5] = [None; 5];
    let mut max_gain = 0.0_f64;
    let mut max_pain = 0.0_f64;
    let mut hit_stop = false;
    let mut hit_target = false;

    for (i, b) in after.iter().enumerate().take(h) {
        let r = (b.close - entry) / entry * 100.0;
        rets[i] = Some(r);
        let g = (b.high - entry) / entry * 100.0;
        let p = (b.low - entry) / entry * 100.0;
        if g > max_gain {
            max_gain = g;
        }
        if p < max_pain {
            max_pain = p;
        }
        if g >= cfg.target_pct {
            hit_target = true;
        }
        if p <= cfg.stop_pct {
            hit_stop = true;
        }
    }
    let horizon_days = after.len().min(h);
    let last_ret = rets[horizon_days.saturating_sub(1)].unwrap_or(0.0);

    let verdict;
    let miss_type;
    match label {
        "BUY" => {
            if hit_target && !hit_stop {
                (verdict, miss_type) = ("good".to_string(), "none".to_string());
            } else if hit_stop && !hit_target {
                (verdict, miss_type) = ("bad".to_string(), "false_positive".to_string());
            } else if last_ret > 1.0 {
                (verdict, miss_type) = ("good".to_string(), "none".to_string());
            } else if last_ret < -1.0 {
                (verdict, miss_type) = ("bad".to_string(), "false_positive".to_string());
            } else {
                (verdict, miss_type) = ("neutral".to_string(), "none".to_string());
            }
        }
        "SELL" => {
            // 基准价=卖出价：卖后下跌为正确避险（good），卖后上涨为卖飞（bad/sell_too_early）。
            if max_pain <= cfg.stop_pct {
                (verdict, miss_type) = ("good".to_string(), "none".to_string());
            } else if max_gain >= cfg.target_pct {
                (verdict, miss_type) = ("bad".to_string(), "sell_too_early".to_string());
            } else if last_ret < -1.0 {
                (verdict, miss_type) = ("good".to_string(), "none".to_string());
            } else if last_ret > 3.0 {
                (verdict, miss_type) = ("bad".to_string(), "sell_too_early".to_string());
            } else {
                (verdict, miss_type) = ("neutral".to_string(), "none".to_string());
            }
        }
        _ => {
            (verdict, miss_type) = ("neutral".to_string(), "none".to_string());
        }
    }

    Outcome {
        rets,
        max_gain,
        max_pain,
        hit_stop,
        hit_target,
        horizon_days,
        verdict,
        miss_type,
    }
}

// ===== 待标注决策 =====

#[allow(dead_code)]
struct DecRow {
    id: i64,
    trade_date: String,
    code: String,
    name: String,
    label: String,
    model_version: String,
    strategy: String,
    features: String,
    action: String,
}

fn fetch_pending(conn: &Connection, cfg: &EvolutionConfig) -> Result<Vec<DecRow>, String> {
    let mut sql = String::from(
        "SELECT id,trade_date,code,name,label,model_version,strategy,features,action \
         FROM decision_log d \
         WHERE NOT EXISTS (SELECT 1 FROM trade_label t WHERE t.decision_id=d.id)",
    );
    if cfg.include_watch {
        sql.push_str(" AND d.action IN ('executed','watch')");
    } else {
        sql.push_str(" AND d.action='executed'");
    }
    sql.push_str(" ORDER BY d.id");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(DecRow {
                id: r.get(0)?,
                trade_date: r.get(1)?,
                code: r.get(2)?,
                name: r.get(3)?,
                label: r.get(4)?,
                model_version: r.get(5).unwrap_or_default(),
                strategy: r.get(6).unwrap_or_default(),
                features: r.get(7).unwrap_or_else(|_| "{}".to_string()),
                action: r.get(8).unwrap_or_default(),
            })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.flatten().collect())
}

fn insert_label(conn: &Connection, d: &DecRow, entry: f64, o: &Outcome) -> Result<(), String> {
    conn.execute(
        "INSERT INTO trade_label \
           (decision_id,trade_date,code,name,decision_label,model_version,strategy,entry_price,\
            ret1d,ret2d,ret3d,ret5d,max_gain,max_pain,hit_stop,hit_target,horizon_days,\
            verdict,miss_type,checked_at) \
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20)",
        rusqlite::params![
            d.id,
            d.trade_date,
            d.code,
            d.name,
            d.label,
            d.model_version,
            d.strategy,
            entry,
            o.rets[0],
            o.rets[1],
            o.rets[2],
            o.rets[3],
            o.max_gain,
            o.max_pain,
            o.hit_stop as i64,
            o.hit_target as i64,
            o.horizon_days as i64,
            o.verdict,
            o.miss_type,
            crate::ai::now_millis(),
        ],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// 跑一次自动打标。force=true 先清空旧标签全量重算。
pub async fn run_labeling(
    data_dir: &std::path::Path,
    cfg: EvolutionConfig,
    force: bool,
) -> Result<Value, String> {
    if force {
        let wc = maindb::open_readwrite(data_dir)?;
        wc.execute("DELETE FROM trade_label", [])
            .map_err(|e| e.to_string())?;
    }

    let pending = {
        let rc = maindb::open_readonly(data_dir)?;
        fetch_pending(&rc, &cfg)?
    };
    let total = pending.len();

    // 按 code 分组，每只只拉一次日 K
    let mut by_code: HashMap<String, Vec<&DecRow>> = HashMap::new();
    for d in &pending {
        by_code.entry(d.code.clone()).or_default().push(d);
    }

    let mut labeled = 0_usize;
    let mut insufficient = 0_usize;
    let wc = maindb::open_readwrite(data_dir)?;

    for (code, drows) in &by_code {
        let bars = match market::get_kline(code.clone(), 101, 320).await {
            Ok(b) if !b.is_empty() => b,
            _ => {
                insufficient += drows.len();
                continue;
            }
        };
        let dated: Vec<String> = bars.iter().map(|b| dashed_from_ts(b.timestamp)).collect();

        for &d in drows.iter() {
            let Some(pi) = dated.iter().position(|x| x == &d.trade_date) else {
                insufficient += 1;
                continue;
            };
            let after: Vec<KBar> = bars[(pi + 1)..].to_vec();
            if after.is_empty() {
                insufficient += 1;
                continue;
            }
            let snap = serde_json::from_str::<Value>(&d.features).unwrap_or(json!({}));
            let entry = snap["price"]
                .as_f64()
                .filter(|p| *p > 0.0)
                .unwrap_or(bars[pi].close);
            if entry <= 0.0 {
                insufficient += 1;
                continue;
            }
            let o = evaluate(&d.label, entry, &after, &cfg);
            insert_label(&wc, d, entry, &o)?;
            labeled += 1;
        }
    }

    Ok(json!({
        "total": total,
        "labeled": labeled,
        "insufficient": insufficient,
        "codes": by_code.len(),
        "stopPct": cfg.stop_pct,
        "targetPct": cfg.target_pct,
        "horizon": cfg.horizon,
        "ranAt": crate::ai::now_millis(),
    }))
}

// ===== 标签明细 =====

pub fn list_labels(
    data_dir: &std::path::Path,
    verdict: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<Value>, String> {
    let conn = maindb::open_readonly(data_dir)?;
    let limit = limit.unwrap_or(200).clamp(1, 1000);
    let mut sql = String::from(
        "SELECT t.id,t.decision_id,t.trade_date,t.code,t.name,t.decision_label,t.model_version,\
                t.strategy,t.entry_price,t.ret1d,t.ret2d,t.ret3d,t.ret5d,t.max_gain,t.max_pain,\
                t.hit_stop,t.hit_target,t.horizon_days,t.verdict,t.miss_type,t.checked_at,\
                d.confidence,d.ts,d.action \
         FROM trade_label t JOIN decision_log d ON d.id=t.decision_id",
    );
    let vfilter: Option<String> = verdict.filter(|v| !v.is_empty() && v != "all");
    if vfilter.is_some() {
        sql.push_str(" WHERE t.verdict=?1");
    }
    sql.push_str(&format!(" ORDER BY t.id DESC LIMIT {limit}"));

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let mapped = stmt.query_map(rusqlite::params_from_iter(vfilter.iter()), |r| {
                let opt = |i: usize| r.get::<_, Option<f64>>(i).unwrap_or(None);
                Ok(json!({
                    "id": r.get::<_, i64>(0)?,
                    "decisionId": r.get::<_, i64>(1)?,
                    "tradeDate": r.get::<_, String>(2)?,
                    "code": r.get::<_, String>(3)?,
                    "name": r.get::<_, String>(4)?,
                    "decisionLabel": r.get::<_, String>(5)?,
                    "modelVersion": r.get::<_, String>(6)?,
                    "strategy": r.get::<_, String>(7)?,
                    "entryPrice": r.get::<_, f64>(8)?,
                    "ret1d": opt(9),
                    "ret2d": opt(10),
                    "ret3d": opt(11),
                    "ret5d": opt(12),
                    "maxGain": r.get::<_, f64>(13)?,
                    "maxPain": r.get::<_, f64>(14)?,
                    "hitStop": r.get::<_, i64>(15).unwrap_or(0) == 1,
                    "hitTarget": r.get::<_, i64>(16).unwrap_or(0) == 1,
                    "horizonDays": r.get::<_, i64>(17).unwrap_or(0),
                    "verdict": r.get::<_, String>(18)?,
                    "missType": r.get::<_, String>(19)?,
                    "checkedAt": r.get::<_, i64>(20)?,
                    "confidence": r.get::<_, f64>(21).unwrap_or(0.0),
                    "ts": r.get::<_, String>(22).unwrap_or_default(),
                    "action": r.get::<_, String>(23).unwrap_or_default(),
                }))
            })
        .map_err(|e| e.to_string())?;
    Ok(mapped.flatten().collect())
}

// ===== 版本 × 策略效果汇总 =====

fn final_ret_expr() -> &'static str {
    "COALESCE(NULLIF(ret5d,0),NULLIF(ret3d,0),NULLIF(ret2d,0),NULLIF(ret1d,0))"
}

pub fn stats(data_dir: &std::path::Path) -> Result<Value, String> {
    let conn = maindb::open_readonly(data_dir)?;
    let sql = format!(
        "SELECT model_version,strategy,verdict,{final_ret_expr()} AS fr,hit_stop,hit_target,miss_type \
         FROM trade_label"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0).unwrap_or_default(),
                r.get::<_, String>(1).unwrap_or_default(),
                r.get::<_, String>(2).unwrap_or_default(),
                r.get::<_, Option<f64>>(3).unwrap_or(None),
                r.get::<_, i64>(4).unwrap_or(0),
                r.get::<_, i64>(5).unwrap_or(0),
                r.get::<_, String>(6).unwrap_or_default(),
            ))
        })
        .map_err(|e| e.to_string())?;

    struct Agg {
        samples: i64,
        good: i64,
        bad: i64,
        neutral: i64,
        stops: i64,
        targets: i64,
        false_positive: i64,
        sell_too_early: i64,
        win_sum: f64,
        win_n: i64,
        loss_sum: f64,
        loss_n: i64,
        ret_sum: f64,
        ret_n: i64,
    }
    impl Agg {
        fn new() -> Agg {
            Agg {
                samples: 0,
                good: 0,
                bad: 0,
                neutral: 0,
                stops: 0,
                targets: 0,
                false_positive: 0,
                sell_too_early: 0,
                win_sum: 0.0,
                win_n: 0,
                loss_sum: 0.0,
                loss_n: 0,
                ret_sum: 0.0,
                ret_n: 0,
            }
        }
    }
    let mut groups: HashMap<(String, String), Agg> = HashMap::new();
    let mut total_labels = 0_i64;
    for row in rows.flatten() {
        let (mv, strat, verdict, fr, stops, targets, miss) = row;
        total_labels += 1;
        let a = groups.entry((mv, strat)).or_insert_with(Agg::new);
        a.samples += 1;
        match verdict.as_str() {
            "good" => a.good += 1,
            "bad" => a.bad += 1,
            _ => a.neutral += 1,
        }
        a.stops += stops;
        a.targets += targets;
        if miss == "false_positive" {
            a.false_positive += 1;
        }
        if miss == "sell_too_early" {
            a.sell_too_early += 1;
        }
        if let Some(v) = fr {
            a.ret_sum += v;
            a.ret_n += 1;
            if v > 0.0 {
                a.win_sum += v;
                a.win_n += 1;
            } else if v < 0.0 {
                a.loss_sum += v;
                a.loss_n += 1;
            }
        }
    }

    let mut out: Vec<Value> = Vec::new();
    for ((mv, strat), a) in groups {
        let decided = a.good + a.bad;
        let win_rate = if decided > 0 {
            a.good as f64 / decided as f64 * 100.0
        } else {
            0.0
        };
        let avg_win = if a.win_n > 0 { a.win_sum / a.win_n as f64 } else { 0.0 };
        let avg_loss = if a.loss_n > 0 {
            (a.loss_sum / a.loss_n as f64).abs()
        } else {
            0.0
        };
        let profit_factor = if avg_loss > 0.0 {
            avg_win / avg_loss
        } else if avg_win > 0.0 {
            f64::INFINITY
        } else {
            0.0
        };
        let expectancy = win_rate / 100.0 * avg_win - (1.0 - win_rate / 100.0) * avg_loss;
        let avg_ret = if a.ret_n > 0 {
            a.ret_sum / a.ret_n as f64
        } else {
            0.0
        };
        out.push(json!({
            "modelVersion": mv,
            "strategy": strat,
            "samples": a.samples,
            "good": a.good,
            "bad": a.bad,
            "neutral": a.neutral,
            "winRate": (win_rate * 100.0).round() / 100.0,
            "avgWin": (avg_win * 100.0).round() / 100.0,
            "avgLoss": (avg_loss * 100.0).round() / 100.0,
            "profitFactor": if profit_factor.is_infinite() { json!(null) } else { json!(((profit_factor*100.0).round())/100.0) },
            "expectancy": (expectancy * 100.0).round() / 100.0,
            "avgRet": (avg_ret * 100.0).round() / 100.0,
            "hitStop": a.stops,
            "hitTarget": a.targets,
            "falsePositive": a.false_positive,
            "sellTooEarly": a.sell_too_early,
        }));
    }
    out.sort_by(|x, y| {
        y["samples"]
            .as_i64()
            .unwrap_or(0)
            .cmp(&x["samples"].as_i64().unwrap_or(0))
    });

    Ok(json!({
        "groups": out,
        "totalLabels": total_labels,
        "generatedAt": crate::ai::now_millis(),
        "note": "胜率=good/(good+bad)；期末收益取后续最长可用交易日；样本不足时指标仅供参考。",
    }))
}

// ===== 数据治理：链路一致性校验 + 过期清理 =====

pub fn data_check(
    data_dir: &std::path::Path,
    cleanup: bool,
    keep_days: i64,
) -> Result<Value, String> {
    let cutoff = {
        let secs = (crate::ai::now_millis() / 1000) + 8 * 3600;
        let today = secs.div_euclid(86400);
        let (y, m, d) = civil_from_days(today - 10);
        format!("{y}-{m:02}-{d:02}")
    };
    let keep_cutoff = {
        let secs = (crate::ai::now_millis() / 1000) + 8 * 3600;
        let today = secs.div_euclid(86400);
        let (y, m, d) = civil_from_days(today - keep_days.max(1));
        format!("{y}-{m:02}-{d:02}")
    };

    let (
        missing_label_stale,
        horizon_zero,
        orphan_labels,
        missing_model,
        total_decisions,
        total_labels,
    ) = {
        let conn = maindb::open_readonly(data_dir)?;
        let count = |sql: &str, p: &[String]| -> i64 {
            let mut stmt = match conn.prepare(sql) {
                Ok(s) => s,
                Err(_) => return -1,
            };
            stmt.query_row(rusqlite::params_from_iter(p.iter()), |r| r.get(0))
                .unwrap_or(-1)
        };
        (
            count(
                "SELECT COUNT(*) FROM decision_log d \
                 WHERE d.action IN ('executed','watch') \
                   AND NOT EXISTS (SELECT 1 FROM trade_label t WHERE t.decision_id=d.id) \
                   AND d.trade_date<=?1",
                &[cutoff.clone()],
            ),
            count("SELECT COUNT(*) FROM trade_label WHERE horizon_days=0", &[]),
            count(
                "SELECT COUNT(*) FROM trade_label t \
                 WHERE NOT EXISTS (SELECT 1 FROM decision_log d WHERE d.id=t.decision_id)",
                &[],
            ),
            count(
                "SELECT COUNT(DISTINCT d.model_version) FROM decision_log d \
                 WHERE d.model_version<>'' \
                   AND NOT EXISTS (SELECT 1 FROM model_version m WHERE m.version=d.model_version)",
                &[],
            ),
            count("SELECT COUNT(*) FROM decision_log", &[]),
            count("SELECT COUNT(*) FROM trade_label", &[]),
        )
    };

    let mut deleted_orphan = 0_i64;
    let mut deleted_old_labels = 0_i64;
    let mut deleted_old_decisions = 0_i64;
    if cleanup {
        let wc = maindb::open_readwrite(data_dir)?;
        deleted_orphan = wc
            .execute(
                "DELETE FROM trade_label t \
                 WHERE NOT EXISTS (SELECT 1 FROM decision_log d WHERE d.id=t.decision_id)",
                [],
            )
            .map_err(|e| e.to_string())? as i64;
        deleted_old_labels = wc
            .execute("DELETE FROM trade_label WHERE trade_date<?1", rusqlite::params![keep_cutoff])
            .map_err(|e| e.to_string())? as i64;
        deleted_old_decisions = wc
            .execute(
                "DELETE FROM decision_log WHERE trade_date<?1",
                rusqlite::params![keep_cutoff],
            )
            .map_err(|e| e.to_string())? as i64;
    }

    let issues = missing_label_stale.max(0)
        + horizon_zero.max(0)
        + orphan_labels.max(0)
        + missing_model.max(0);
    Ok(json!({
        "totalDecisions": total_decisions,
        "totalLabels": total_labels,
        "missingLabelStale": missing_label_stale,
        "horizonZero": horizon_zero,
        "orphanLabels": orphan_labels,
        "missingModelRegistry": missing_model,
        "issues": issues,
        "cleanup": cleanup,
        "keepDays": keep_days,
        "deletedOrphan": deleted_orphan,
        "deletedOldLabels": deleted_old_labels,
        "deletedOldDecisions": deleted_old_decisions,
        "checkedAt": crate::ai::now_millis(),
    }))
}

// ===== Tauri 命令 =====

#[tauri::command]
pub async fn evolution_run_labeling(
    state: State<'_, crate::ai::AiState>,
    config: Option<EvolutionConfig>,
    force: Option<bool>,
) -> Result<Value, String> {
    run_labeling(&state.dir(), config.unwrap_or_default(), force.unwrap_or(false)).await
}

#[tauri::command]
pub fn evolution_list_labels(
    state: State<'_, crate::ai::AiState>,
    verdict: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<Value>, String> {
    list_labels(&state.dir(), verdict, limit)
}

#[tauri::command]
pub fn evolution_stats(state: State<'_, crate::ai::AiState>) -> Result<Value, String> {
    stats(&state.dir())
}

#[tauri::command]
pub fn evolution_data_check(
    state: State<'_, crate::ai::AiState>,
    cleanup: Option<bool>,
    keep_days: Option<i64>,
) -> Result<Value, String> {
    data_check(&state.dir(), cleanup.unwrap_or(false), keep_days.unwrap_or(180))
}

// ===== 单测 =====

#[cfg(test)]
mod tests {
    use super::*;

    fn bar(close: f64, high: f64, low: f64) -> KBar {
        KBar {
            timestamp: 0,
            open: close,
            close,
            high,
            low,
            volume: 0.0,
        }
    }

    #[test]
    fn buy_hit_target_is_good() {
        let cfg = EvolutionConfig::default();
        let after = vec![bar(11.2, 11.3, 9.9)];
        let o = evaluate("BUY", 10.0, &after, &cfg);
        assert_eq!(o.verdict, "good");
        assert!(o.hit_target);
        assert_eq!(o.miss_type, "none");
    }

    #[test]
    fn buy_hit_stop_is_false_positive() {
        let cfg = EvolutionConfig::default();
        let after = vec![bar(9.1, 10.0, 9.0)];
        let o = evaluate("BUY", 10.0, &after, &cfg);
        assert_eq!(o.verdict, "bad");
        assert!(o.hit_stop);
        assert_eq!(o.miss_type, "false_positive");
    }

    #[test]
    fn sell_after_drop_is_good() {
        let cfg = EvolutionConfig::default();
        // 卖价 10，随后跌到 9.2（-8%，触及 stop）
        let after = vec![bar(9.2, 10.0, 9.2)];
        let o = evaluate("SELL", 10.0, &after, &cfg);
        assert_eq!(o.verdict, "good");
    }

    #[test]
    fn sell_after_rally_is_too_early() {
        let cfg = EvolutionConfig::default();
        // 卖价 10，随后涨到 11.2（+12%，达 target）
        let after = vec![bar(11.2, 11.2, 9.9)];
        let o = evaluate("SELL", 10.0, &after, &cfg);
        assert_eq!(o.verdict, "bad");
        assert_eq!(o.miss_type, "sell_too_early");
    }

    #[test]
    fn neutral_band() {
        let cfg = EvolutionConfig::default();
        let after = vec![bar(10.05, 10.2, 9.95)];
        let o = evaluate("BUY", 10.0, &after, &cfg);
        assert_eq!(o.verdict, "neutral");
    }

    #[test]
    fn daily_ts_roundtrip() {
        // 日 K：北京 2026-09-18 收盘 15:00 当作 UTC 的毫秒
        // days_from_civil(2026,9,18)*86400 + 15*3600，*1000
        let days = days_from_civil(2026, 9, 18);
        let ts = (days * 86400 + 15 * 3600) * 1000;
        assert_eq!(dashed_from_ts(ts), "2026-09-18");
    }

    // 与 tencent::days_from_civil 同口径的本地副本，用于构造测试时间戳
    fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
        let y = if month <= 2 { year - 1 } else { year };
        let era = if y >= 0 { y } else { y - 399 } / 400;
        let yoe = y - era * 400;
        let madj = if month > 2 { month - 3 } else { month + 9 };
        let doy = (153 * madj + 2) / 5 + day - 1;
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        era * 146097 + doe - 719468
    }
}
