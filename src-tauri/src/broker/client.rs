// P3 客户端自动化通道（同花顺模拟）：sidecar_client.py 参数构造、
// 半自动确认/拒绝、下单前截图与连接自检查询。
// 真实同花顺无公开交易 API，本通道通过 Python UI 自动化（pywinauto/pyautogui）操控客户端；
// 模拟炒股（client_sim=true）为虚拟资金，不碰真钱，无需 live_enabled。
use crate::broker::config::BrokerConfig;
use crate::broker::sidecar;
use crate::broker::BrokerManager;
use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use tauri::State;

/// 构造 sidecar_client.py 命令行参数。
pub fn build_args(cfg: &BrokerConfig) -> Vec<String> {
    let mut args = vec![
        "--vendor".to_string(),
        cfg.client_vendor.clone(),
        "--account".to_string(),
        cfg.account_id.clone(),
        "--min-interval".to_string(),
        cfg.client_min_interval_ms.to_string(),
    ];
    if cfg.client_sim {
        args.push("--sim".to_string());
    }
    if cfg.client_auto_confirm {
        args.push("--auto-confirm".to_string());
    }
    if cfg.client_dry_run {
        args.push("--dry-run".to_string());
    }
    if !cfg.client_path.trim().is_empty() {
        args.push("--client-path".to_string());
        args.push(cfg.client_path.trim().to_string());
    }
    if !cfg.client_template_dir.trim().is_empty() {
        args.push("--template-dir".to_string());
        args.push(cfg.client_template_dir.trim().to_string());
    }
    args
}

/// sidecar 启动即发的 connect 帧参数。
pub fn connect_params(cfg: &BrokerConfig) -> Value {
    json!({
        "vendor": cfg.client_vendor,
        "account": cfg.account_id,
        "sim": cfg.client_sim,
        "dryRun": cfg.client_dry_run,
        "autoConfirm": cfg.client_auto_confirm,
    })
}

/// 半自动确认桥：人工核对下单前截图后，确认/拒绝在客户端挂起的委托。
#[tauri::command]
pub async fn broker_client_confirm(
    mgr: State<'_, BrokerManager>,
    sig_id: String,
    approved: bool,
) -> Result<(), String> {
    if !mgr.connected.load(Ordering::SeqCst) {
        return Err("客户端通道未连接".to_string());
    }
    let method = if approved { "confirm" } else { "reject" };
    let req = sidecar::request(
        &format!("{method}-{sig_id}"),
        method,
        json!({ "client_order_id": sig_id }),
    );
    let stdin = mgr
        .sidecar
        .lock()
        .unwrap()
        .as_ref()
        .map(|h| h.stdin.clone());
    match stdin {
        Some(s) => sidecar::send_to(&s, req).await,
        None => Err("客户端 sidecar 未运行".to_string()),
    }
}

/// 读取最近一次连接自检结果（connect 时 sidecar 推送 selfcheck 事件，由 apply_sidecar_event 缓存）。
#[tauri::command]
pub fn broker_client_selfcheck(mgr: State<'_, BrokerManager>) -> Value {
    mgr.client_selfcheck.lock().unwrap().clone()
}

/// 读取指定委托的下单前截图（不传 sig_id 则取最近一张），供确认桥展示。
#[tauri::command]
pub fn broker_client_shot(
    mgr: State<'_, BrokerManager>,
    sig_id: Option<String>,
) -> Option<Value> {
    let shots = mgr.client_shots.lock().unwrap();
    if let Some(id) = sig_id {
        shots
            .iter()
            .rev()
            .find(|(c, _)| c == &id)
            .map(|(_, v)| v.clone())
    } else {
        shots.last().map(|(_, v)| v.clone())
    }
}
