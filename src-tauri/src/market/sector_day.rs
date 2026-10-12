// 板块日级快照（v2.29）：每日收盘落盘行业 / 概念板块的涨跌幅、成交额、换手率、
// 主力净流入、涨跌家数、涨停家数与领涨股；支持指定历史日补采。
// 数据源：东方财富 clist（m:90 t:2 行业 / t:3 概念）+ 涨停池按行业归并涨停家数。
use super::eastmoney;
use crate::ai::maindb;
use rusqlite::params;
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use serde_json::Value;

/// 板块日级快照行
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SectorDayRow {
    pub day: String,
    pub kind: String,
    pub code: String,
    pub name: String,
    pub change_pct: f64,
    pub net_amount: f64,
    pub lead_code: String,
    pub lead_name: String,
    pub lead_pct: f64,
    pub up_count: i64,
    pub down_count: i64,
    pub limit_up: i64,
    pub turnover: f64,
    pub amount: f64,
}

fn vf(v: &Value, k: &str) -> f64 {
    v.get(k).and_then(|x| x.as_f64()).unwrap_or(0.0)
}
fn vi(v: &Value, k: &str) -> i64 {
    v.get(k).and_then(|x| x.as_i64()).unwrap_or(0)
}
fn vs(v: &Value, k: &str) -> String {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

/// 拉取一类板块（industry / concept）的快照原始行。
/// f3 涨跌幅 f6 成交额 f8 换手 f12 代码 f14 名称 f62 主力净流入
/// f104 上涨家数 f105 下跌家数 f128 领涨股 f136 领涨股涨跌幅 f140 领涨股名称
async fn fetch_rows(kind: &str) -> Result<Vec<SectorDayRow>, String> {
    let t = if kind == "concept" { "3" } else { "2" };
    let path = format!(
        "/api/qt/clist/get?pn=1&pz=500&po=1&np=1&fltt=2&invt=2\
         &fid=f3&fs=m:90+t:{t}\
         &fields=f3,f6,f8,f12,f14,f62,f104,f105,f128,f136,f140"
    );
    let v = eastmoney::push2_json(&path).await?;
    let diff = v["data"].get("diff").and_then(|x| x.as_array()).ok_or("板块快照为空")?;
    Ok(diff
        .iter()
        .filter(|x| !vs(x, "f12").is_empty())
        .map(|x| SectorDayRow {
            day: String::new(),
            kind: kind.to_string(),
            code: vs(x, "f12"),
            name: vs(x, "f14"),
            change_pct: vf(x, "f3"),
            net_amount: vf(x, "f62"),
            lead_code: vs(x, "f128"),
            lead_name: vs(x, "f140"),
            lead_pct: vf(x, "f136"),
            up_count: vi(x, "f104"),
            down_count: vi(x, "f105"),
            limit_up: 0,
            turnover: vf(x, "f8"),
            amount: vf(x, "f6"),
        })
        .collect())
}

/// 取指定交易日涨停池中「行业名称 -> 涨停家数」映射。
/// 概念板块涨停家数无可靠归并字段，暂置 0。
async fn limitup_by_industry(day: &str) -> HashMap<String, i64> {
    let mut map: HashMap<String, i64> = HashMap::new();
    if let Ok(pool) = eastmoney::zt_pool(day).await {
        for s in pool.list {
            if !s.industry.is_empty() {
                *map.entry(s.industry).or_insert(0) += 1;
            }
        }
    }
    map
}

/// 采集并落盘指定交易日（YYYYMMDD）两类板块快照，返回写入行数。
pub async fn snapshot_day(dir: &Path, day: &str) -> Result<usize, String> {
    let (ind, con) = tokio::join!(fetch_rows("industry"), fetch_rows("concept"));
    let mut rows = ind?;
    rows.extend(con?);
    rows.iter_mut().for_each(|r| r.day = day.to_string());

    let lu = limitup_by_industry(day).await;
    for r in rows.iter_mut() {
        if r.kind == "industry" {
            r.limit_up = lu.get(&r.name).copied().unwrap_or(0);
        }
    }

    let mut conn = maindb::open_readwrite(dir)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    {
        let mut stmt = tx
            .prepare(
                "INSERT INTO ts_sector_day
                    (day, kind, code, name, change_pct, net_amount, lead_code, lead_name, lead_pct,
                     up_count, down_count, limit_up, turnover, amount)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)
                 ON CONFLICT(day, kind, code) DO UPDATE SET
                    name=excluded.name, change_pct=excluded.change_pct,
                    net_amount=excluded.net_amount, lead_code=excluded.lead_code,
                    lead_name=excluded.lead_name, lead_pct=excluded.lead_pct,
                    up_count=excluded.up_count, down_count=excluded.down_count,
                    limit_up=excluded.limit_up, turnover=excluded.turnover, amount=excluded.amount",
            )
            .map_err(|e| e.to_string())?;
        for r in &rows {
            stmt.execute(params![
                r.day, r.kind, r.code, r.name, r.change_pct, r.net_amount, r.lead_code,
                r.lead_name, r.lead_pct, r.up_count, r.down_count, r.limit_up, r.turnover, r.amount
            ])
            .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(rows.len())
}

/// 查询指定交易日（或最近 N 个交易日）某类板块快照。
pub fn query(dir: &Path, kind: &str, days: i64) -> Result<Vec<SectorDayRow>, String> {
    let conn = maindb::open_readonly(dir)?;
    let mut stmt = conn
        .prepare(
            "SELECT day, kind, code, name, change_pct, net_amount, lead_code, lead_name, lead_pct,
                    up_count, down_count, limit_up, turnover, amount
             FROM ts_sector_day
             WHERE kind = ?1 AND day IN (
                 SELECT DISTINCT day FROM ts_sector_day WHERE kind = ?1
                 ORDER BY day DESC LIMIT ?2
             )
             ORDER BY day DESC, change_pct DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![kind, days], |row| {
            Ok(SectorDayRow {
                day: row.get(0)?,
                kind: row.get(1)?,
                code: row.get(2)?,
                name: row.get(3)?,
                change_pct: row.get(4)?,
                net_amount: row.get(5)?,
                lead_code: row.get(6)?,
                lead_name: row.get(7)?,
                lead_pct: row.get(8)?,
                up_count: row.get(9)?,
                down_count: row.get(10)?,
                limit_up: row.get(11)?,
                turnover: row.get(12)?,
                amount: row.get(13)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/// 已积累的板块快照交易日数量
pub fn stats(dir: &Path) -> Result<i64, String> {
    let conn = maindb::open_readonly(dir)?;
    conn.query_row(
        "SELECT COUNT(DISTINCT day) FROM ts_sector_day",
        [],
        |row| row.get(0),
    )
    .map_err(|e| e.to_string())
}
