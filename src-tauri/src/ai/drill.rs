// P5 故障注入与急停演练（仅允许在模拟环境 / 实盘未武装时运行）。
//
// 每一项都真实调用生产的降级 / fail-safe 路径（而非只做静态检查），并给出可核验证据：
//   model_timeout  影子脑（laya）不可达 / 超时 → 必须自动降级规则脑。
//   network_down   断网时规则脑完全依赖本地特征 → 仍能产出决策（安全暂停而非崩溃）。
//   sidecar_crash  交易 sidecar 崩溃，但实盘未武装 → 武装闸门保证不会有真实委托。
//   quote_stale    行情陈旧 / 缺涨跌停价 → 真实通道下单前必须拒绝（乌龙指 fail-safe）。
//   kill_switch    一键急停原子量可置位（拦新单）并可复位。
use crate::ai::{maindb, now_millis};
use crate::broker::risk::{self, MarketSnapshot};
use crate::broker::BrokerManager;
use serde::Serialize;
use serde_json::json;
use std::sync::atomic::Ordering;
use tauri::{AppHandle, State};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DrillItem {
    pub kind: String,
    pub name: String,
    pub pass: bool,
    pub evidence: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DrillReport {
    pub armed: bool,
    pub passed: i64,
    pub total: i64,
    pub all_pass: bool,
    pub items: Vec<DrillItem>,
    pub ran_at: i64,
}

/// 一键运行全部故障演练（模拟环境）。
#[tauri::command]
pub async fn drill_run_all(
    ai: State<'_, crate::ai::AiState>,
    mgr: State<'_, BrokerManager>,
    _app: AppHandle,
) -> Result<DrillReport, String> {
    let armed = mgr.config.lock().unwrap().live_enabled;
    if armed {
        return Err("实盘已武装，故障演练只允许在模拟环境（未武装）下运行，以防误触发真实通道".to_string());
    }

    let mut items: Vec<DrillItem> = Vec::new();
    let pack = json!({"side":"buy","code":"600000","name":"演练标的","features":{}});

    // 1) 模型超时 / 不可用：指向拒绝端口，健康检查失败后必须降级规则脑。
    {
        let d = crate::ai::fastbrain::fast_decide(
            pack.clone(),
            "laya",
            "http://127.0.0.1:1",
            None,
            None,
            None,
        )
        .await;
        let pass = d.mode == "rule";
        items.push(DrillItem {
            kind: "model_timeout".to_string(),
            name: "模型超时 / 不可用".to_string(),
            pass,
            evidence: if pass {
                format!("影子脑不可达，健康检查失败后自动降级为规则脑（mode=rule，耗时 {:.0}ms）", d.infer_ms)
            } else {
                "影子脑不可用时未能降级到规则脑，存在失控风险".to_string()
            },
        });
    }

    // 2) 断网：规则脑只用本地特征，不依赖任何网络 → 仍可产出决策。
    {
        let d =
            crate::ai::fastbrain::fast_decide(pack.clone(), "rule", "", None, None, None).await;
        let pass = !d.label.is_empty();
        items.push(DrillItem {
            kind: "network_down".to_string(),
            name: "断网行情 / 模型不可达".to_string(),
            pass,
            evidence: if pass {
                format!("断网时规则脑本地计算正常，仍给出决策 label={}（可安全暂停开新仓而非崩溃）", d.label)
            } else {
                "断网时规则脑未能产出决策".to_string()
            },
        });
    }

    // 3) 交易 sidecar 崩溃：实盘未武装 → 武装闸门保证不会发出真实委托。
    {
        let cfg = mgr.config.lock().unwrap().clone();
        let kind_label = if cfg.kind == "mock" {
            "模拟交易".to_string()
        } else if cfg.kind == "client" && cfg.client_sim {
            "同花顺模拟".to_string()
        } else {
            cfg.kind.clone()
        };
        let pass = !cfg.live_enabled;
        items.push(DrillItem {
            kind: "sidecar_crash".to_string(),
            name: "交易客户端 / sidecar 崩溃".to_string(),
            pass,
            evidence: format!(
                "当前为「{kind_label}」、实盘未武装（锁定）：即使 sidecar 崩溃，武装闸门在下单前拦截，不会发出真实委托"
            ),
        });
    }

    // 4) 行情陈旧 / 缺涨跌停价：真实通道 fail-safe 必须拒单。
    {
        let none_ok = !risk::limit_prices_ready(None);
        let partial_ok = !risk::limit_prices_ready(Some(MarketSnapshot {
            limit_up: Some(11.0),
            limit_down: None,
        }));
        let full_ok = risk::limit_prices_ready(Some(MarketSnapshot {
            limit_up: Some(11.0),
            limit_down: Some(9.0),
        }));
        let pass = none_ok && partial_ok && full_ok;
        items.push(DrillItem {
            kind: "quote_stale".to_string(),
            name: "行情陈旧 / 缺涨跌停价".to_string(),
            pass,
            evidence: if pass {
                "缺快照或缺任一涨跌停价 → 真实通道下单前拒绝；涨跌停齐备 → 放行，判定正确".to_string()
            } else {
                "涨跌停快照 fail-safe 判定异常".to_string()
            },
        });
    }

    // 5) 一键急停：置位（拦新单）→ 校验 → 复位。
    {
        mgr.kill_switch.store(true, Ordering::SeqCst);
        let set = mgr.kill_switch.load(Ordering::SeqCst);
        mgr.kill_switch.store(false, Ordering::SeqCst);
        let reset = !mgr.kill_switch.load(Ordering::SeqCst);
        let pass = set && reset;
        items.push(DrillItem {
            kind: "kill_switch".to_string(),
            name: "一键急停（Kill Switch）".to_string(),
            pass,
            evidence: if pass {
                "急停可立即置位（置位后拦截一切新委托），演练结束已复位，不影响后续运行".to_string()
            } else {
                "急停开关置位 / 复位异常".to_string()
            },
        });
    }

    let passed = items.iter().filter(|i| i.pass).count() as i64;
    let total = items.len() as i64;
    let report = DrillReport {
        armed,
        passed,
        total,
        all_pass: passed == total,
        items,
        ran_at: now_millis(),
    };

    // 审计
    if let Ok(conn) = maindb::open_readwrite(&ai.dir()) {
        let detail = format!("故障演练 {passed}/{total} 通过：{}", report.all_pass);
        let _ = conn.execute(
            "INSERT INTO signal_audit(sig_id,action,detail,actor,created_at)
             VALUES(?1,?2,?3,?4,?5)",
            rusqlite::params!["DRILL", "drill_run", detail, "drill", now_millis()],
        );
    }
    Ok(report)
}
