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
}

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
    let Some(state) = load_state(app) else {
        return LicenseStatus {
            active: false,
            plan: None,
            expires_at: None,
            days_left: None,
            rollback_detected: false,
            message: Some("未激活 Pro".into()),
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

    let dl = days_left(&state.expires_at);
    let expired = dl.is_some_and(|d| d < 0);
    let active = !rollback && !expired;

    LicenseStatus {
        active,
        plan: Some(state.plan.clone()),
        expires_at: Some(state.expires_at.clone()),
        days_left: dl,
        rollback_detected: rollback,
        message: if rollback {
            Some("检测到系统时间回拨，Pro 已暂停，请校正系统时间".into())
        } else if expired {
            Some("Pro 已到期，已降级为免费版".into())
        } else {
            Some("Pro 订阅生效中".into())
        },
    }
}

/// 查询授权状态（前端启动时调用）。
#[tauri::command]
pub(crate) async fn license_status(app: AppHandle) -> Result<LicenseStatus, String> {
    Ok(build_status(&app))
}

/// 激活 Pro：粘贴卡密 → 验签 → 记录本地授权。
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
    let state = LicenseState {
        code_hash: hash[..16].to_string(),
        plan: payload.plan.clone(),
        expires_at: payload.expires_at.clone(),
        activated_at: today_str(),
        last_run_date: Some(today_str()),
    };
    save_state(&app, &state)?;
    Ok(build_status(&app))
}

/// 退出 Pro（清除本地授权）。
#[tauri::command]
pub(crate) async fn license_deactivate(app: AppHandle) -> Result<LicenseStatus, String> {
    let p = state_path(&app)?;
    if p.exists() {
        fs::remove_file(&p).map_err(|e| format!("清除授权失败: {e}"))?;
    }
    Ok(LicenseStatus {
        active: false,
        plan: None,
        expires_at: None,
        days_left: None,
        rollback_detected: false,
        message: Some("已退出 Pro，恢复免费版".into()),
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
