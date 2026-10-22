//! 授权系统（v3.0.2 Pro 订阅）：面包多卡密 → 离线 RSA-SHA256 验签。
//! 密钥对独立于 updater minisign；私钥仅开发者本地
//! （signing-backup/tickgold-license.key，禁止入库），公钥内置于此文件。

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{Duration, Local, NaiveDate};
use rsa::pkcs1v15::VerifyingKey;
use rsa::pkcs8::DecodePublicKey;
use rsa::signature::Verifier;
use rsa::RsaPublicKey;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// 授权公钥（RSA-2048，PKCS8 PEM）。与 gen_license 签发私钥一一对应。
pub const LICENSE_PUBLIC_KEY_PEM: &str = r#"-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0QUwlK+t31FOcbpuB+9I
unPZzBPYHmCT7eRjXaeYJIAGVrVJQDl0jDpmoZQYdIB4yhA9FrHdEYv4rmXPr+Gs
JPL13DU0AyXRj3ChZCZBEGkn1Yrcx+ujkpdzpqgZDFod/cQYQvZUcAVTh9d09yV3
TFKVte5pUkeYCBcCAZHzEOEySquRX+gLtPkCAWRvidxqwpd25xP1dq//ZY3hMGH0
gxRZdqR19KPcCPcRVW+kHLLJ9p7hOGhhyXr8jSP0w/ZKq+JI2vvq4X5F7QRULjh2
F4OU9Ukr9ZXfYNycj8Srh/uICflOaCVJSjQRp+WpV/0X2Aie8p8WfFKL3YzJ4+Mk
xwIDAQAB
-----END PUBLIC KEY-----
"#;

/// 激活码载荷（签名内容，JSON 原文参与验签，字段顺序不影响）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LicensePayload {
    pub plan: String,
    pub product: String,
    pub expires_at: String, // YYYY-MM-DD
    #[serde(default)]
    pub nonce: String,
    /// AI 总次数包（可选）：>0 时此卡按总量扣减，不设每日上限。
    #[serde(default)]
    pub ai_quota: Option<u32>,
}

/// 本地授权状态（app_data_dir/license_state.json）。
#[derive(Debug, Clone, Serialize, Deserialize)]
struct LicenseState {
    code_hash: String,
    plan: String,
    expires_at: String,
    activated_at: String,
    /// 防回拨：最近一次成功运行（授权有效）的本地日期。
    #[serde(default)]
    last_run_date: Option<String>,
    /// 设备绑定指纹（加固 v3.4）：首次激活时写入本机 machine_id。
    #[serde(default)]
    machine_id: Option<String>,
}

/// 返回给前端的授权状态。
#[derive(Debug, Clone, Serialize)]
pub struct LicenseStatus {
    pub active: bool,
    pub plan: Option<String>,
    pub expires_at: Option<String>,
    pub days_left: Option<i64>,
    /// 检测到系统时间回拨（疑似改日期续期）。
    pub rollback_detected: bool,
    pub message: Option<String>,
    // ===== 加固 v3.4：设备绑定 =====
    /// 因换机被锁定（激活码绑定在其他设备）。
    pub device_locked: bool,
    /// 是否需要换机授权。
    pub need_relocate: bool,
    /// 换机申请码（RELOC.<code_hash>.<machine_id>），发给卖家换授权。
    pub relocate_request: Option<String>,
    /// 本机指纹（前 16 位 hex）。
    pub machine_id: Option<String>,
    /// 剩余 AI 总次数包（若卡含 ai_quota）；None 表示无次数包（走每日配额）。
    pub ai_balance: Option<u32>,
    // ===== 分档 v3.14：日配额 =====
    /// 当前 plan 对应的每日 AI 调用上限（trial=20/monthly=50/quarterly=80/annual=100）。
    pub daily_quota: Option<u32>,
    /// 今日已用 AI 次数。
    pub today_used: Option<u32>,
}

/// 各 plan 对应的每日 AI 调用上限。
fn daily_quota_for_plan(plan: &str) -> u32 {
    match plan {
        "trial" => 20,
        "monthly" => 50,
        "quarterly" => 80,
        "annual" => 100,
        "pro-annual" => 100, // 兼容老卡密
        _ => 0,
    }
}

/// 试用天数（首次启动自动给）。
const TRIAL_DAYS: i64 = 7;

/// 换机授权码载荷（卖家私钥签发，客户端公钥验签）。
#[derive(Debug, Deserialize)]
struct RelocatePayload {
    #[serde(rename = "type")]
    typ: String,
    code_hash: String,
    machine_id: String,
    exp: String, // YYYY-MM-DD
}

const RELOCATE_PREFIX: &str = "TGR";
const AI_QUOTA_SALT: &str = "tickgold-aiq-v1";

const PRODUCT_NAME: &str = "tickgold";

fn state_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位数据目录: {e}"))?;
    Ok(dir.join("license_state.json"))
}

fn load_state(app: &AppHandle) -> Option<LicenseState> {
    let p = state_path(app).ok()?;
    let s = fs::read_to_string(p).ok()?;
    serde_json::from_str(&s).ok()
}

fn save_state(app: &AppHandle, st: &LicenseState) -> Result<(), String> {
    let p = state_path(app)?;
    let s = serde_json::to_string_pretty(st).map_err(|e| e.to_string())?;
    fs::write(&p, s).map_err(|e| format!("写入授权状态失败: {e}"))
}

fn today_str() -> String {
    Local::now().date_naive().format("%Y-%m-%d").to_string()
}

/// 本机稳定指纹（前 16 位 hex）。
/// Windows：注册表 MachineGuid（每台机器唯一且稳定，无需管理员权限）。
/// macOS：IOPlatformUUID。Linux：/etc/machine-id。
/// 获取失败返回 None（绑定校验将跳过，产品降级为不绑定设备）。
pub fn current_machine_id() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        let out = std::process::Command::new("reg")
            .args([
                "query",
                "HKLM\\SOFTWARE\\Microsoft\\Cryptography",
                "/v",
                "MachineGuid",
            ])
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&out.stdout);
        let line = text
            .lines()
            .find(|l| l.contains("MachineGuid") && l.contains("REG_SZ"))?;
        let val = line.split("REG_SZ").nth(1).map(|s| s.trim()).filter(|s| !s.is_empty())?;
        let h = format!("{:x}", Sha256::digest(val.as_bytes()));
        Some(h[..16].to_string())
    }
    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("ioreg")
            .args(["-rd1", "-c", "IOPlatformExpertDevice"])
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&out.stdout);
        let line = text.lines().find(|l| l.contains("IOPlatformUUID"))?;
        let val = line.split('"').nth(3)?.to_string();
        if val.is_empty() {
            return None;
        }
        let h = format!("{:x}", Sha256::digest(val.as_bytes()));
        return Some(h[..16].to_string());
    }
    #[cfg(target_os = "linux")]
    {
        let s = fs::read_to_string("/etc/machine-id").ok()?;
        let val = s.trim();
        if val.is_empty() {
            return None;
        }
        let h = format!("{:x}", Sha256::digest(val.as_bytes()));
        return Some(h[..16].to_string());
    }
}

// ===== AI 配额 / 次数包（加固 v3.4）=====
// 存储结构 ai_quota.json：绑机器指纹 + 卡密哈希 + 校验和，防篡改数字。

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct AiQuotaFile {
    machine_id: Option<String>,
    code_hash: Option<String>,
    /// AI 总次数包剩余量。
    balance: Option<u32>,
    /// 已兑付过的 AI 次数卡哈希（防同卡重复兑付）。
    redeemed: Vec<String>,
    day: AiQuotaEntry,
    checksum: Option<String>,
}

fn ai_quota_checksum(q: &AiQuotaFile) -> String {
    let canonical = format!(
        "{:?}|{:?}|{:?}|{:?}|{}|{}",
        q.balance,
        q.redeemed,
        q.day.date,
        q.day.count,
        q.machine_id.as_deref().unwrap_or(""),
        q.code_hash.as_deref().unwrap_or(""),
    );
    let h = format!("{:x}", Sha256::digest(format!("{canonical}#{AI_QUOTA_SALT}").as_bytes()));
    h[..16].to_string()
}

/// 读取并校验配额文件；文件缺失 / 机器不符 / 校验和不符 → 重建（balance=0，防刷）。
fn load_ai_quota(app: &AppHandle, st: &LicenseState, mid: Option<&str>) -> AiQuotaFile {
    let Ok(p) = quota_path(app) else {
        return AiQuotaFile::default();
    };
    let q: AiQuotaFile = fs::read_to_string(&p)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    let valid = q.checksum.as_deref() == Some(ai_quota_checksum(&q).as_str())
        && q.code_hash.as_deref() == Some(st.code_hash.as_str())
        && match (mid, q.machine_id.as_deref()) {
            (Some(m), Some(f)) => m == f,
            (Some(_), None) => false, // 旧文件无指纹 → 重建
            _ => true,
        };
    if valid {
        q
    } else {
        AiQuotaFile::default()
    }
}

fn save_ai_quota(app: &AppHandle, st: &LicenseState, mid: Option<&str>, mut q: AiQuotaFile) -> Result<(), String> {
    q.machine_id = mid.map(|s| s.to_string());
    q.code_hash = Some(st.code_hash.clone());
    q.checksum = Some(ai_quota_checksum(&q));
    let s = serde_json::to_string(&q).map_err(|e| e.to_string())?;
    let p = quota_path(app)?;
    fs::write(p, s).map_err(|e| format!("写入 AI 配额失败: {e}"))
}

/// 解析并验签激活码，返回载荷。失败给出人话错误。
pub fn verify_code(code: &str) -> Result<LicensePayload, String> {
    decode_and_verify(code, LICENSE_PUBLIC_KEY_PEM)
}

/// 参数化验签（公钥可注入，便于测试与未来密钥轮换）。
pub fn decode_and_verify(code: &str, pubkey_pem: &str) -> Result<LicensePayload, String> {
    let trimmed = code.trim();
    let parts: Vec<&str> = trimmed.split('.').collect();
    if parts.len() != 3 || parts[0] != "TG" {
        return Err("激活码格式不正确（应为 TG.载荷.签名 三段）".into());
    }
    let pbytes = URL_SAFE_NO_PAD
        .decode(parts[1])
        .map_err(|_| "激活码载荷解码失败".to_string())?;
    let sig_bytes = URL_SAFE_NO_PAD
        .decode(parts[2])
        .map_err(|_| "激活码签名解码失败".to_string())?;

    let pubkey = RsaPublicKey::from_public_key_pem(pubkey_pem)
        .map_err(|_| "内置公钥解析失败".to_string())?;
    let vk = VerifyingKey::<Sha256>::new_unprefixed(pubkey);
    let sig = rsa::pkcs1v15::Signature::try_from(sig_bytes.as_slice())
        .map_err(|_| "签名长度异常".to_string())?;
    vk.verify(&pbytes, &sig)
        .map_err(|_| "激活码验签失败：激活码无效或已被篡改".to_string())?;

    let payload: LicensePayload =
        serde_json::from_slice(&pbytes).map_err(|_| "激活码内容解析失败".to_string())?;
    if payload.product != PRODUCT_NAME {
        return Err("激活码产品不匹配（非 TickGold 授权）".into());
    }
    if payload.plan.is_empty() || payload.expires_at.is_empty() {
        return Err("激活码缺少必要字段".into());
    }
    NaiveDate::parse_from_str(&payload.expires_at, "%Y-%m-%d")
        .map_err(|_| "激活码到期日期格式错误".to_string())?;
    Ok(payload)
}

/// 剩余天数（相对本地今日；已过期返回负数）。
fn days_left(expires_at: &str) -> Option<i64> {
    let exp = NaiveDate::parse_from_str(expires_at, "%Y-%m-%d").ok()?;
    Some((exp - Local::now().date_naive()).num_days())
}

/// 由状态构建对外状态，并做防回拨检查（顺带更新 last_run_date）。
fn build_status(app: &AppHandle) -> LicenseStatus {
    // 首次启动：无任何授权状态时自动给 7 天 trial（绑本机指纹）。
    if load_state(app).is_none() {
        if let Some(mid) = current_machine_id() {
            let exp = (Local::now().date_naive() + Duration::days(TRIAL_DAYS))
                .format("%Y-%m-%d")
                .to_string();
            let trial = LicenseState {
                code_hash: "trial".to_string(),
                plan: "trial".to_string(),
                expires_at: exp,
                activated_at: today_str(),
                last_run_date: Some(today_str()),
                machine_id: Some(mid),
            };
            let _ = save_state(app, &trial);
        }
    }

    let Some(mut state) = load_state(app) else {
        return LicenseStatus {
            active: false,
            plan: None,
            expires_at: None,
            days_left: None,
            rollback_detected: false,
            message: Some("未激活 Pro".into()),
            device_locked: false,
            need_relocate: false,
            relocate_request: None,
            machine_id: None,
            ai_balance: None,
            daily_quota: None,
            today_used: None,
        };
    };

    let today = today_str();
    let today_d = Local::now().date_naive();
    let mut rollback = false;
    if let Some(last) = &state.last_run_date {
        if let Ok(last_d) = NaiveDate::parse_from_str(last, "%Y-%m-%d") {
            if today_d < last_d - Duration::days(1) {
                rollback = true;
            }
        }
    }

    // 未检测到回拨时推进 last_run_date（仅授权有效期间记录）。
    if !rollback {
        let mut st = state.clone();
        if st.last_run_date.as_deref() != Some(today.as_str()) {
            st.last_run_date = Some(today.clone());
            let _ = save_state(app, &st);
        }
    }

    // ===== 设备绑定校验（加固 v3.4）=====
    let mid = current_machine_id();
    let mut need_relocate = false;
    let mut device_locked = false;
    if let Some(mid_now) = &mid {
        match state.machine_id.as_deref() {
            None => {
                // 旧版本升级：自动绑定当前机器（无感）
                state.machine_id = Some(mid_now.clone());
                let _ = save_state(app, &state);
            }
            Some(bound) if bound != mid_now => {
                need_relocate = true;
                device_locked = true;
            }
            _ => {}
        }
    }
    let relocate_request = if need_relocate {
        Some(format!("RELOC.{}.{}", state.code_hash, mid.as_deref().unwrap_or("unknown")))
    } else {
        None
    };

    let dl = days_left(&state.expires_at);
    let expired = dl.is_some_and(|d| d < 0);
    let active = !rollback && !expired && !need_relocate;

    // AI 次数包余额 + 今日已用（有主授权才读）
    let (ai_balance, today_used, daily_quota) = if !need_relocate && !expired {
        let q = load_ai_quota(app, &state, mid.as_deref());
        (
            q.balance,
            Some(if q.day.date == today_str() { q.day.count } else { 0 }),
            Some(daily_quota_for_plan(&state.plan)),
        )
    } else {
        (None, Some(0), Some(0))
    };

    let msg = if rollback {
        "检测到系统时间回拨，Pro 已暂停，请校正系统时间".to_string()
    } else if need_relocate {
        "该激活码已绑定其他设备，需换机授权后才能使用".to_string()
    } else if expired {
        if state.plan == "trial" {
            "试用已结束，订阅后继续使用 AI".to_string()
        } else {
            "Pro 已到期，已降级为免费版".to_string()
        }
    } else if state.plan == "trial" {
        "免费试用中".to_string()
    } else {
        "Pro 订阅生效中".to_string()
    };

    LicenseStatus {
        active,
        plan: Some(state.plan.clone()),
        expires_at: Some(state.expires_at.clone()),
        days_left: dl,
        rollback_detected: rollback,
        message: Some(msg),
        device_locked,
        need_relocate,
        relocate_request,
        machine_id: state.machine_id.clone(),
        ai_balance,
        daily_quota,
        today_used,
    }
}

/// Pro 门控：Pro 专属命令在入口调用；未激活/已过期/时间回拨时拒绝。
pub fn require_pro(app: &AppHandle) -> Result<(), String> {
    let st = build_status(app);
    if st.active {
        Ok(())
    } else {
        Err(st
            .message
            .unwrap_or_else(|| "此功能为 Pro 订阅专享，请先在设置中激活 Pro".into()))
    }
}


/// AI 调用配额：基于当前激活卡密指纹，每自然日限 AI_DAILY_QUOTA 次。
/// 防止卡密共享/多设备刷量造成内置模型 token 成本失控。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct AiQuotaEntry {
    date: String,
    count: u32,
}

fn quota_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位数据目录: {e}"))?;
    Ok(dir.join("ai_quota.json"))
}

/// 消费一次 AI 配额（Pro AI 命令入口调用；未激活/超限均拒绝）。
/// 优先级：AI 总次数包（balance）→ 每日配额（按 plan：trial=20/monthly=50/quarterly=80/annual=100）。
pub fn consume_ai_quota(app: &AppHandle) -> Result<(), String> {
    let st = load_state(app).ok_or_else(|| "未激活 Pro，AI 功能不可用".to_string())?;
    let mid = current_machine_id();
    let mut q = load_ai_quota(app, &st, mid.as_deref());

    // 有总次数包：按总量扣减（不设每日上限）
    if let Some(bal) = q.balance {
        if bal == 0 {
            return Err("AI 次数包已用完，请在设置中购买 AI 次数卡充值".into());
        }
        q.balance = Some(bal - 1);
        save_ai_quota(app, &st, mid.as_deref(), q)?;
        return Ok(());
    }

    // 每日配额：按当前 plan
    let daily_quota = daily_quota_for_plan(&st.plan);
    if daily_quota == 0 {
        return Err("当前套餐无 AI 调用配额，请订阅 Pro".into());
    }
    let today = today_str();
    if q.day.date != today {
        q.day.date = today.clone();
        q.day.count = 0;
    }
    if q.day.count >= daily_quota {
        return Err(format!(
            "今日 AI 调用已达上限（{} 次/天），明日自动重置。",
            daily_quota
        ));
    }
    q.day.count += 1;
    save_ai_quota(app, &st, mid.as_deref(), q)?;
    Ok(())
}

/// 换机授权：粘贴卖家签发的授权码（TGR.载荷.签名），验签通过后把激活码重绑到本机。
#[tauri::command]
pub(crate) async fn license_relocate(
    app: AppHandle,
    auth_code: String,
) -> Result<LicenseStatus, String> {
    let Some(state) = load_state(&app) else {
        return Err("当前未激活 Pro，无需换机".into());
    };
    let trimmed = auth_code.trim();
    let parts: Vec<&str> = trimmed.split('.').collect();
    if parts.len() != 3 || parts[0] != RELOCATE_PREFIX {
        return Err("换机授权码格式不正确（应为 TGR.载荷.签名）".into());
    }
    let pbytes = URL_SAFE_NO_PAD
        .decode(parts[1])
        .map_err(|_| "换机授权码载荷解码失败".to_string())?;
    let sig_bytes = URL_SAFE_NO_PAD
        .decode(parts[2])
        .map_err(|_| "换机授权码签名解码失败".to_string())?;
    let pubkey = RsaPublicKey::from_public_key_pem(LICENSE_PUBLIC_KEY_PEM)
        .map_err(|_| "内置公钥解析失败".to_string())?;
    let vk = VerifyingKey::<Sha256>::new_unprefixed(pubkey);
    let sig = rsa::pkcs1v15::Signature::try_from(sig_bytes.as_slice())
        .map_err(|_| "换机授权码签名长度异常".to_string())?;
    vk.verify(&pbytes, &sig)
        .map_err(|_| "换机授权码验签失败：授权码无效或已被篡改".to_string())?;

    let payload: RelocatePayload =
        serde_json::from_slice(&pbytes).map_err(|_| "换机授权码内容解析失败".to_string())?;
    if payload.typ != "relocate" {
        return Err("换机授权码类型不匹配".into());
    }
    if payload.code_hash != state.code_hash {
        return Err("换机授权码与当前激活的卡密不匹配".into());
    }
    let mid_now = current_machine_id().ok_or_else(|| "无法获取本机指纹".to_string())?;
    if payload.machine_id != mid_now {
        return Err("换机授权码与本机指纹不匹配，请使用本机展示的申请码向卖家申请".into());
    }
    let exp = NaiveDate::parse_from_str(&payload.exp, "%Y-%m-%d")
        .map_err(|_| "换机授权码过期日期格式错误".to_string())?;
    if exp < Local::now().date_naive() {
        return Err("换机授权码已过期，请重新申请".into());
    }

    let mut st = state.clone();
    st.machine_id = Some(mid_now.clone());
    save_state(&app, &st)?;
    // ===== AI 次数包随换机迁移 =====
    // 换机授权成功后，若本地 ai_quota.json 存在且属于同一主授权卡（code_hash 匹配），
    // 但机器指纹仍是旧机，则重绑到新机，避免换机后 AI 次数包被清零。
    if let Ok(qp) = quota_path(&app) {
        if let Ok(s) = fs::read_to_string(&qp) {
            if let Ok(q) = serde_json::from_str::<AiQuotaFile>(&s) {
                if q.code_hash.as_deref() == Some(st.code_hash.as_str())
                    && q.machine_id.as_deref() != Some(mid_now.as_str())
                {
                    let _ = save_ai_quota(&app, &st, Some(&mid_now), q);
                }
            }
        }
    }
    Ok(build_status(&app))
}

/// Pro 门控 + AI 配额（AI 生成类命令入口统一调用）。
pub fn require_pro_ai(app: &AppHandle) -> Result<(), String> {
    require_pro_ai_ex(app, true)
}

/// Pro 门控 + 按模型源决定配额：内置模型消耗开发者 token，需扣每日配额；
/// 自备模型源（本地 Ollama / 用户云端 Key）不消耗开发者成本，只校验 Pro、不限量。
pub fn require_pro_ai_ex(app: &AppHandle, use_builtin: bool) -> Result<(), String> {
    require_pro(app)?;
    if use_builtin {
        consume_ai_quota(app)
    } else {
        Ok(())
    }
}

/// 查询授权状态（前端启动时调用）。
#[tauri::command]
pub(crate) async fn license_status(app: AppHandle) -> Result<LicenseStatus, String> {
    Ok(build_status(&app))
}

/// 激活 Pro / 兑付 AI 次数卡：粘贴卡密 → 验签 → 记录本地授权。
/// - plan=ai-topup：不覆盖主授权，只把 ai_quota 次数并入本地次数包。
/// - 其他（pro-annual 等）：主授权，写入本机指纹绑定。
#[tauri::command]
pub(crate) async fn license_activate(
    app: AppHandle,
    code: String,
) -> Result<LicenseStatus, String> {
    let payload = verify_code(&code)?;
    let dl = days_left(&payload.expires_at).unwrap_or(i64::MIN);
    if dl < 0 {
        return Err("该激活码已过期，无法激活".into());
    }
    let hash = format!("{:x}", Sha256::digest(code.trim().as_bytes()));
    let hash16 = hash[..16].to_string();
    let mid = current_machine_id();

    // AI 次数卡：只兑付次数，不动主授权
    if payload.plan == "ai-topup" {
        let quota = payload.ai_quota.unwrap_or(0);
        if quota == 0 {
            return Err("AI 次数卡缺少次数（ai_quota 为 0）".into());
        }
        let Some(st) = load_state(&app) else {
            return Err("请先激活 Pro 年卡，再充值 AI 次数".into());
        };
        let mut q = load_ai_quota(&app, &st, mid.as_deref());
        if q.redeemed.contains(&hash16) {
            return Err("该 AI 次数卡已兑付过，请勿重复激活".into());
        }
        q.redeemed.push(hash16);
        q.balance = Some(q.balance.unwrap_or(0) + quota);
        save_ai_quota(&app, &st, mid.as_deref(), q)?;
        return Ok(build_status(&app));
    }

    let state = LicenseState {
        code_hash: hash16,
        plan: payload.plan.clone(),
        expires_at: payload.expires_at.clone(),
        activated_at: today_str(),
        last_run_date: Some(today_str()),
        machine_id: mid,
    };
    save_state(&app, &state)?;
    Ok(build_status(&app))
}

/// 退出 Pro（清除本地授权）。
/// debug 测试入口：同时清掉主授权与 AI 次数包，回到干净免费态。
#[tauri::command]
pub(crate) async fn license_deactivate(app: AppHandle) -> Result<LicenseStatus, String> {
    let p = state_path(&app)?;
    if p.exists() {
        fs::remove_file(&p).map_err(|e| format!("清除授权失败: {e}"))?;
    }
    // 顺带清 AI 次数包，避免测试时次数残留
    if let Ok(qp) = quota_path(&app) {
        if qp.exists() {
            let _ = fs::remove_file(&qp);
        }
    }
    Ok(LicenseStatus {
        active: false,
        plan: None,
        expires_at: None,
        days_left: None,
        rollback_detected: false,
        message: Some("已退出 Pro，恢复免费版".into()),
        device_locked: false,
        need_relocate: false,
        relocate_request: None,
        machine_id: None,
        ai_balance: None,
        daily_quota: Some(0),
        today_used: Some(0),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::rngs::ThreadRng;
    use rsa::pkcs1v15::SigningKey;
    use rsa::pkcs8::{EncodePublicKey, LineEnding};
    use rsa::signature::{SignatureEncoding, Signer};
    use rsa::RsaPrivateKey;

    /// 用临时密钥对签发一个激活码（返回码 + 对应公钥 PEM）。
    fn make_code(expires_at: &str, product: &str) -> (String, String) {
        let mut rng = ThreadRng::default();
        let key = RsaPrivateKey::new(&mut rng, 2048).unwrap();
        let pub_pem = RsaPublicKey::from(&key)
            .to_public_key_pem(LineEnding::LF)
            .unwrap();
        let sk = SigningKey::<Sha256>::new_unprefixed(key);
        let payload = serde_json::json!({
            "plan": "pro-annual",
            "product": product,
            "expires_at": expires_at,
            "nonce": "test-nonce",
        });
        let pbytes = serde_json::to_vec(&payload).unwrap();
        let sig = sk.sign(&pbytes);
        let code = format!(
            "TG.{}.{}",
            URL_SAFE_NO_PAD.encode(&pbytes),
            URL_SAFE_NO_PAD.encode(sig.to_bytes())
        );
        (code, pub_pem)
    }

    #[test]
    fn verify_valid_code() {
        let (code, pub_pem) = make_code("2027-10-15", "tickgold");
        let p = decode_and_verify(&code, &pub_pem).expect("should verify");
        assert_eq!(p.plan, "pro-annual");
        assert_eq!(p.expires_at, "2027-10-15");
        assert_eq!(p.product, "tickgold");
    }

    #[test]
    fn verify_tampered_payload_fails() {
        let (code, pub_pem) = make_code("2027-10-15", "tickgold");
        // 篡改载荷字节（翻转首字节）后重新编码，签名不变 → 验签必须失败
        let parts: Vec<&str> = code.split('.').collect();
        let mut pbytes = URL_SAFE_NO_PAD.decode(parts[1]).unwrap();
        pbytes[0] ^= 0x01;
        let tampered = format!(
            "TG.{}.{}",
            URL_SAFE_NO_PAD.encode(&pbytes),
            parts[2]
        );
        assert!(tampered != code);
        assert!(decode_and_verify(&tampered, &pub_pem).is_err());
    }

    #[test]
    fn verify_bad_format_fails() {
        let (_, pub_pem) = make_code("2027-10-15", "tickgold");
        assert!(decode_and_verify("", &pub_pem).is_err());
        assert!(decode_and_verify("TG.abc", &pub_pem).is_err());
        assert!(decode_and_verify("XX.abc.def", &pub_pem).is_err());
        assert!(decode_and_verify("TG.!!!.def", &pub_pem).is_err());
    }

    #[test]
    fn verify_wrong_product_fails() {
        let (code, pub_pem) = make_code("2027-10-15", "other-app");
        assert!(decode_and_verify(&code, &pub_pem).is_err());
    }

    #[test]
    fn verify_wrong_key_fails() {
        let (code, pub_pem) = make_code("2027-10-15", "tickgold");
        // 用另一把临时公钥验签应失败
        let mut rng = ThreadRng::default();
        let other = RsaPrivateKey::new(&mut rng, 2048).unwrap();
        let other_pub = RsaPublicKey::from(&other)
            .to_public_key_pem(LineEnding::LF)
            .unwrap();
        assert!(other_pub != pub_pem);
        assert!(decode_and_verify(&code, &other_pub).is_err());
    }

    #[test]
    fn days_left_math() {
        // 相对今天：+10 天应为 10
        let future = (Local::now().date_naive() + Duration::days(10))
            .format("%Y-%m-%d")
            .to_string();
        assert_eq!(days_left(&future), Some(10));
        let past = (Local::now().date_naive() - Duration::days(3))
            .format("%Y-%m-%d")
            .to_string();
        assert_eq!(days_left(&past), Some(-3));
        assert_eq!(days_left("bad-date"), None);
    }
}
