// P3 客户端自动化通道（同花顺模拟）：sidecar_client.py 参数构造、
// 半自动确认/拒绝、下单前截图与连接自检查询。
// 真实同花顺无公开交易 API，本通道通过 Python UI 自动化（pywinauto/pyautogui）操控客户端；
// 模拟炒股（client_sim=true）为虚拟资金，不碰真钱，无需 live_enabled。
use crate::ai::now_millis;
use crate::broker::config::BrokerConfig;
use crate::broker::sidecar;
use crate::broker::BrokerManager;
use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::State;
use tokio::process::ChildStdin;
use tokio::sync::Mutex as AsyncMutex;

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
    if !cfg.client_tesseract.trim().is_empty() {
        args.push("--tesseract".to_string());
        args.push(cfg.client_tesseract.trim().to_string());
    }
    // P4 真实通道纵深：把白名单 / 单笔 / 单日限额下发给 sidecar，
    // Python 端独立兜底（即使 Rust 闸门被绕过，sidecar 也拒绝越界下单）。
    if cfg.is_live() {
        args.push("--whitelist".to_string());
        args.push(cfg.live_codes_whitelist.join(","));
        args.push("--max-amount".to_string());
        args.push(format!("{:.0}", cfg.live_max_order_amount));
        args.push("--max-daily".to_string());
        args.push(format!("{:.0}", cfg.live_max_daily_amount));
    }
    args
}

/// sidecar 启动即发的 connect 帧参数。
pub fn connect_params(cfg: &BrokerConfig) -> Value {
    let mut v = json!({
        "vendor": cfg.client_vendor,
        "account": cfg.account_id,
        "sim": cfg.client_sim,
        "dryRun": cfg.client_dry_run,
        "autoConfirm": cfg.client_auto_confirm,
    });
    // P4 真实通道：连接帧携带武装护栏，供 sidecar 自检与独立兜底。
    if cfg.is_live() {
        if let Some(o) = v.as_object_mut() {
            o.insert("live".to_string(), json!(true));
            o.insert("whitelist".to_string(), json!(cfg.live_codes_whitelist));
            o.insert("maxAmount".to_string(), json!(cfg.live_max_order_amount));
            o.insert("maxDaily".to_string(), json!(cfg.live_max_daily_amount));
        }
    }
    v
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

// ===== P7 同花顺真实通道（移植 THSAutoTrader 键盘精灵引擎）：四表 / 撤单 / 仓位 / 探测 / 透传 / 验证码 =====

/// 取当前 sidecar stdin；未连接 / 未运行时返回中文错误。
async fn client_stdin(
    mgr: &State<'_, BrokerManager>,
) -> Result<Arc<AsyncMutex<ChildStdin>>, String> {
    if !mgr.connected.load(Ordering::SeqCst) {
        return Err("客户端通道未连接".to_string());
    }
    mgr.sidecar
        .lock()
        .unwrap()
        .as_ref()
        .map(|h| h.stdin.clone())
        .ok_or_else(|| "客户端 sidecar 未运行".to_string())
}

/// 当日成交：优先返回缓存；缓存为空时向 sidecar 查询，前端下次轮询取回报。
#[tauri::command]
pub async fn broker_client_query_trades(
    mgr: State<'_, BrokerManager>,
) -> Result<Value, String> {
    let cached = mgr.trades_cache.lock().unwrap().clone();
    if cached.get("trades").is_some() {
        return Ok(cached);
    }
    let s = client_stdin(&mgr).await?;
    sidecar::send_to(&s, sidecar::request("query-trades", "query_trades", json!({}))).await?;
    Ok(json!({ "note": "正在向客户端查询当日成交…" }))
}

/// 当日挂单（未成交委托）：同上。
#[tauri::command]
pub async fn broker_client_query_pending(
    mgr: State<'_, BrokerManager>,
) -> Result<Value, String> {
    let cached = mgr.pending_cache.lock().unwrap().clone();
    if cached.get("orders").is_some() {
        return Ok(cached);
    }
    let s = client_stdin(&mgr).await?;
    sidecar::send_to(&s, sidecar::request("query-pending", "query_pending", json!({}))).await?;
    Ok(json!({ "note": "正在向客户端查询当日挂单…" }))
}

/// 一键撤单：kind = A(全撤) / X(撤买) / C(撤卖)。
#[tauri::command]
pub async fn broker_client_cancel_all(
    mgr: State<'_, BrokerManager>,
    kind: String,
) -> Result<(), String> {
    let s = client_stdin(&mgr).await?;
    let cid = format!("CA{}{}", now_millis(), kind);
    sidecar::send_to(
        &s,
        sidecar::request(
            "cancel-all",
            "cancel_all",
            json!({ "client_order_id": cid, "type": kind }),
        ),
    )
    .await
}

/// 仓位下单：position 0/1=满(全)仓、2=半仓、3=1/3、4=1/4。返回 client_order_id 供确认桥/截图关联。
#[tauri::command]
pub async fn broker_client_position_order(
    mgr: State<'_, BrokerManager>,
    code: String,
    side: String,
    position: i64,
    ref_price: f64,
) -> Result<String, String> {
    let s = client_stdin(&mgr).await?;
    let cid = format!("POS{}{}", now_millis(), code);
    sidecar::send_to(
        &s,
        sidecar::request(
            "position-order",
            "position_order",
            json!({
                "client_order_id": cid,
                "code": code,
                "side": side,
                "position": position,
                "ref_price": ref_price,
            }),
        ),
    )
    .await?;
    Ok(cid)
}

/// 探测同花顺下单程序进程 / 窗口状态：主动探测一次，结果经 broker:app_state 事件回传，同时返回缓存。
#[tauri::command]
pub async fn broker_client_check_app(
    mgr: State<'_, BrokerManager>,
) -> Result<Value, String> {
    if let Ok(s) = client_stdin(&mgr).await {
        let _ = sidecar::send_to(&s, sidecar::request("check-app", "check_app", json!({}))).await;
    }
    Ok(mgr.app_state_cache.lock().unwrap().clone())
}

/// 读取当前前台窗口信息（标题/句柄/最小化等），用于校准与故障排查。
#[tauri::command]
pub async fn broker_client_current_page(
    mgr: State<'_, BrokerManager>,
) -> Result<Value, String> {
    if let Ok(s) = client_stdin(&mgr).await {
        let _ =
            sidecar::send_to(&s, sidecar::request("current-page", "current_page", json!({}))).await;
    }
    Ok(mgr.current_page_cache.lock().unwrap().clone())
}

/// 高级调试：向同花顺窗口发送键盘序列（空格分隔按键，如 "F4"、"600519 ENTER 21 ENTER"）。
#[tauri::command]
pub async fn broker_client_send_key(
    mgr: State<'_, BrokerManager>,
    key: String,
) -> Result<(), String> {
    let s = client_stdin(&mgr).await?;
    sidecar::send_to(
        &s,
        sidecar::request("send-key", "send_key", json!({ "key": key })),
    )
    .await
}

/// 高级调试：在同花顺窗口客户区点击坐标 (x, y)。
#[tauri::command]
pub async fn broker_client_click(
    mgr: State<'_, BrokerManager>,
    x: i64,
    y: i64,
) -> Result<(), String> {
    let s = client_stdin(&mgr).await?;
    sidecar::send_to(
        &s,
        sidecar::request("click", "click", json!({ "x": x, "y": y })),
    )
    .await
}

/// 人工验证码：复制表格遇到验证码且 OCR 不可用 / 失败时，前端弹窗输入数字后回传。
#[tauri::command]
pub async fn broker_client_captcha_input(
    mgr: State<'_, BrokerManager>,
    text: String,
) -> Result<(), String> {
    let s = client_stdin(&mgr).await?;
    sidecar::send_to(
        &s,
        sidecar::request("captcha-input", "captcha_input", json!({ "text": text })),
    )
    .await
}
