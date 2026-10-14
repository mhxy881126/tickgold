// 信号质量服务（v2.31）：把 v2.30 的「可验」延伸到盘中实时信号。
// 数据源：trade_label（后续 N 日真实走势打标）JOIN decision_log（特征/时段/打法）。
// 分桶维度：打法 strategy × 交易时段 session × 题材/行业 theme × 因子组合 factors。
// 只读聚合：本模块不写任何配置；样本不足显式标灰，禁止用小样本编造高胜率。
use crate::ai::maindb;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use tauri::State;

/// 实时信号同型历史命中率查询。
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct QualityQuery {
    /// 打法（decision_log.strategy）；空串 = 不限。
    #[serde(default)]
    pub strategy: String,
    /// 时段：open(09:30-10:30) / mid(10:30-14:00) / close(14:00-15:00)；空 = 不限。
    #[serde(default)]
    pub session: String,
    /// 题材/行业关键词（命中特征 JSON 中 industry/theme/concepts 等字段）；空 = 不限。
    #[serde(default)]
    pub theme: String,
    /// 因子组合：key=特征名（与快脑特征包一致，如 rsi14/macdHist），value=当前值；
    /// 历史样本该因子数值落在 ±20%（绝对下限 0.15）内视为同型。
    #[serde(default)]
    pub factors: Option<HashMap<String, f64>>,
    /// 方向：buy（决策标签 watch_up，兼容旧 BUY；默认）/ sell（watch_down，兼容旧 SELL）。
    #[serde(default)]
    pub side: String,
}

/// 分桶聚合结果。
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct QualityView {
    pub strategy: String,
    pub session: String,
    pub samples: i64,
    /// 已判定样本中的 good 占比（%）。
    pub win_rate_pct: f64,
    /// 同型样本后续收益均值（%）。
    pub avg_ret_pct: f64,
    /// 盈亏比：盈利和 / 亏损和绝对值。
    pub profit_factor: f64,
    /// 样本是否充足（< MIN_SAMPLES 不足，前端标灰）。
    pub sufficient: bool,
    /// 置信标注：high ≥30 / medium ≥10 / low ≥5 / insufficient <5。
    pub level: String,
}

/// 样本充足门槛：低于此数不建议作为决策依据。
pub const MIN_SAMPLES: i64 = 5;

/// HH:MM:SS（或 HH:MM）→ 交易时段桶。纯函数。
pub fn session_of(hms: &str) -> &'static str {
    let mins = hms
        .split(':')
        .take(2)
        .filter_map(|x| x.parse::<i64>().ok())
        .fold(0, |acc, x| if acc == 0 { x * 60 } else { acc + x });
    if mins < 10 * 60 + 30 {
        "open"
    } else if mins < 14 * 60 {
        "mid"
    } else {
        "close"
    }
}

/// 一条已打标历史决策（SQL 取出后的内存结构）。
struct Row {
    strategy: String,
    ts: String,
    features: Value,
    verdict: String,
    ret: Option<f64>,
}

struct Agg {
    samples: i64,
    good: i64,
    bad: i64,
    win_sum: f64,
    loss_sum: f64,
    ret_sum: f64,
}

impl Agg {
    fn new() -> Agg {
        Agg {
            samples: 0,
            good: 0,
            bad: 0,
            win_sum: 0.0,
            loss_sum: 0.0,
            ret_sum: 0.0,
        }
    }

    fn push(&mut self, verdict: &str, ret: Option<f64>) {
        self.samples += 1;
        if verdict == "good" {
            self.good += 1;
        } else if verdict == "bad" {
            self.bad += 1;
        }
        if let Some(v) = ret {
            self.ret_sum += v;
            if v > 0.0 {
                self.win_sum += v;
            } else if v < 0.0 {
                self.loss_sum += v;
            }
        }
    }

    fn into_view(self, strategy: String, session: String) -> QualityView {
        let decided = self.good + self.bad;
        let win_rate_pct = if decided > 0 {
            self.good as f64 / decided as f64 * 100.0
        } else {
            0.0
        };
        let avg_ret_pct = if self.samples > 0 {
            self.ret_sum / self.samples as f64
        } else {
            0.0
        };
        let profit_factor = if self.loss_sum < 0.0 {
            self.win_sum / self.loss_sum.abs()
        } else if self.win_sum > 0.0 {
            f64::INFINITY
        } else {
            0.0
        };
        let level = if self.samples >= 30 {
            "high"
        } else if self.samples >= 10 {
            "medium"
        } else if self.samples >= MIN_SAMPLES {
            "low"
        } else {
            "insufficient"
        };
        QualityView {
            strategy,
            session,
            samples: self.samples,
            win_rate_pct,
            avg_ret_pct,
            profit_factor: if profit_factor.is_infinite() {
                999.0
            } else {
                profit_factor
            },
            sufficient: self.samples >= MIN_SAMPLES,
            level: level.to_string(),
        }
    }
}

/// 因子同型判定：历史特征中该因子数值与当前值的偏差 ≤ ±20%（绝对下限 0.15）。
fn factor_matches(features: &Value, factors: &HashMap<String, f64>) -> bool {
    for (k, target) in factors {
        let v = match features.get(k).and_then(Value::as_f64) {
            Some(v) => v,
            None => return false,
        };
        let tol = (0.2 * target.abs()).max(0.15);
        if (v - target).abs() > tol {
            return false;
        }
    }
    true
}

/// 题材/行业关键词命中：优先查 industry/theme/concepts/sector 字段，否则全文兜底。
fn theme_matches(features: &Value, theme: &str) -> bool {
    let needle = theme.to_lowercase();
    for key in ["industry", "theme", "concepts", "sector", "themes"] {
        if let Some(v) = features.get(key) {
            let hay = match v {
                Value::String(s) => s.to_lowercase(),
                Value::Array(a) => a
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(",")
                    .to_lowercase(),
                _ => v.to_string().to_lowercase(),
            };
            if hay.contains(&needle) {
                return true;
            }
        }
    }
    features.to_string().to_lowercase().contains(&needle)
}

/// 方向 → 兼容新旧标签的查询集合（新观察态 + 旧指令态）。
fn labels_of_side(side: &str) -> &'static [&'static str] {
    if side == "sell" {
        &[crate::ai::fastbrain::LABEL_WATCH_DOWN, "SELL"]
    } else {
        &[crate::ai::fastbrain::LABEL_WATCH_UP, "BUY"]
    }
}

fn fetch_labeled(conn: &Connection, labels: &[&str]) -> Result<Vec<Row>, String> {
    let placeholders = std::iter::repeat_n("?", labels.len()).collect::<Vec<_>>().join(",");
    let sql = format!(
        "SELECT dl.strategy,dl.ts,dl.features,tl.verdict,\
         COALESCE(NULLIF(tl.ret5d,0),NULLIF(tl.ret3d,0),NULLIF(tl.ret2d,0),NULLIF(tl.ret1d,0)) \
       FROM trade_label tl JOIN decision_log dl ON dl.id=tl.decision_id \
       WHERE dl.label IN ({placeholders})"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(labels.iter().copied()), |r| {
            let features_str: String = r.get(2).unwrap_or_default();
            let features = serde_json::from_str::<Value>(&features_str)
                .unwrap_or(Value::Object(Default::default()));
            Ok(Row {
                strategy: r.get(0).unwrap_or_default(),
                ts: r.get(1).unwrap_or_default(),
                features,
                verdict: r.get(3).unwrap_or_default(),
                ret: r.get(4).unwrap_or(None),
            })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.flatten().collect())
}

fn matches_query(row: &Row, q: &QualityQuery) -> bool {
    if !q.strategy.is_empty() && row.strategy != q.strategy {
        return false;
    }
    if !q.session.is_empty() && session_of(&row.ts) != q.session.as_str() {
        return false;
    }
    if !q.theme.is_empty() && !theme_matches(&row.features, &q.theme) {
        return false;
    }
    if let Some(factors) = &q.factors {
        if !factors.is_empty() && !factor_matches(&row.features, factors) {
            return false;
        }
    }
    true
}

/// 单次同型命中率查询。
pub fn lookup(data_dir: &std::path::Path, q: &QualityQuery) -> Result<QualityView, String> {
    let conn = maindb::open_readonly(data_dir)?;
    let rows = fetch_labeled(&conn, labels_of_side(&q.side))?;
    let mut agg = Agg::new();
    for row in &rows {
        if matches_query(row, q) {
            agg.push(&row.verdict, row.ret);
        }
    }
    Ok(agg.into_view(
        if q.strategy.is_empty() {
            "ALL".to_string()
        } else {
            q.strategy.clone()
        },
        if q.session.is_empty() {
            "ALL".to_string()
        } else {
            q.session.clone()
        },
    ))
}

/// 总览：按 打法 × 时段 全部分桶（含样本数为 0 以上的桶，按样本数降序，上限 60）。
pub fn overview(data_dir: &std::path::Path) -> Result<Vec<QualityView>, String> {
    let conn = maindb::open_readonly(data_dir)?;
    let rows = fetch_labeled(&conn, labels_of_side("buy"))?;
    let mut buckets: HashMap<(String, String), Agg> = HashMap::new();
    for row in &rows {
        let key = (row.strategy.clone(), session_of(&row.ts).to_string());
        buckets
            .entry(key)
            .or_insert_with(Agg::new)
            .push(&row.verdict, row.ret);
    }
    let mut out: Vec<QualityView> = buckets
        .into_iter()
        .map(|((strategy, session), agg)| agg.into_view(strategy, session))
        .collect();
    out.sort_by_key(|v| std::cmp::Reverse(v.samples));
    out.truncate(60);
    Ok(out)
}

#[tauri::command]
pub fn signal_quality_lookup(
    state: State<'_, crate::ai::AiState>,
    query: QualityQuery,
) -> Result<QualityView, String> {
    lookup(&state.dir(), &query)
}

#[tauri::command]
pub fn signal_quality_overview(
    state: State<'_, crate::ai::AiState>,
) -> Result<Vec<QualityView>, String> {
    overview(&state.dir())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn session_buckets() {
        assert_eq!(session_of("09:30:05"), "open");
        assert_eq!(session_of("10:29:59"), "open");
        assert_eq!(session_of("10:30:00"), "mid");
        assert_eq!(session_of("13:59:00"), "mid");
        assert_eq!(session_of("14:00:00"), "close");
        assert_eq!(session_of("14:55:10"), "close");
    }

    #[test]
    fn factor_tolerance_band() {
        let mut f = HashMap::new();
        f.insert("rsi14".to_string(), 50.0);
        let features = json!({ "rsi14": 55.0 });
        assert!(factor_matches(&features, &f)); // 偏差 5 ≤ 10
        let features = json!({ "rsi14": 70.0 });
        assert!(!factor_matches(&features, &f)); // 偏差 20 > 10
    }

    #[test]
    fn factor_missing_is_no_match() {
        let mut f = HashMap::new();
        f.insert("nope".to_string(), 1.0);
        assert!(!factor_matches(&json!({}), &f));
    }

    #[test]
    fn theme_keyword_hit() {
        let features = json!({ "industry": "半导体及元件", "concepts": ["芯片", "国产替代"] });
        assert!(theme_matches(&features, "半导体"));
        assert!(theme_matches(&features, "芯片"));
        assert!(!theme_matches(&features, "白酒"));
    }

    #[test]
    fn aggregate_win_rate_and_levels() {
        let mut agg = Agg::new();
        agg.push("good", Some(3.0));
        agg.push("good", Some(5.0));
        agg.push("bad", Some(-2.0));
        agg.push("neutral", None);
        let v = agg.into_view("t1".into(), "open".into());
        assert_eq!(v.samples, 4);
        assert!((v.win_rate_pct - 66.6667).abs() < 0.01);
        assert!((v.avg_ret_pct - 1.5).abs() < 0.01);
        assert!((v.profit_factor - 4.0).abs() < 0.01);
        assert_eq!(v.level, "insufficient");
        assert!(!v.sufficient);
    }

    #[test]
    fn query_filter_chain() {
        let row = Row {
            strategy: "daban".into(),
            ts: "09:45:00".into(),
            features: json!({ "rsi14": 60.0, "industry": "证券" }),
            verdict: "good".into(),
            ret: Some(2.0),
        };
        let mut factors = HashMap::new();
        factors.insert("rsi14".to_string(), 60.0);
        let mut q = QualityQuery {
            strategy: "daban".into(),
            session: "open".into(),
            factors: Some(factors),
            theme: "证券".into(),
            ..Default::default()
        };
        assert!(matches_query(&row, &q));

        q.session = "close".into();
        assert!(!matches_query(&row, &q));
    }
}
