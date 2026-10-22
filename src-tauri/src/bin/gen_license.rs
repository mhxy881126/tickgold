//! gen_license：TickGold Pro 订阅卡密签发工具（开发者本地使用，私钥不进应用）。
//!
//! 用法：
//!   gen_license --gen-keypair <outdir>                    生成 RSA-2048 密钥对
//!   gen_license --key <priv.pem> --count 100 --days 365 --out codes.txt
//!                                                        批量签发年卡（每行一个激活码）
//! 私钥也可通过环境变量 TAURI_LICENSE_PRIVATE_KEY 传入（不落命令行）。

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{Duration, Local};
use rand::rngs::ThreadRng;
use rsa::pkcs1v15::SigningKey;
use rsa::pkcs8::{DecodePrivateKey, EncodePrivateKey, EncodePublicKey};
use rsa::signature::{SignatureEncoding, Signer};
use rsa::{RsaPrivateKey, RsaPublicKey};
use sha2::Sha256;
use std::env;
use std::fs;
use std::io::Write;
use std::process::exit;

const DEFAULT_PLAN: &str = "pro-annual";
const DEFAULT_PRODUCT: &str = "tickgold";

fn main() {
    let args: Vec<String> = env::args().collect();

    if args.get(1).map(|s| s.as_str()) == Some("--gen-keypair") {
        let outdir = args.get(2).cloned().unwrap_or_else(|| ".".to_string());
        let mut rng = ThreadRng::default();
        let key = match RsaPrivateKey::new(&mut rng, 2048) {
            Ok(k) => k,
            Err(e) => {
                eprintln!("keygen failed: {e}");
                exit(1);
            }
        };
        let pubk = RsaPublicKey::from(&key);
        let priv_pem = key
            .to_pkcs8_pem(rsa::pkcs8::LineEnding::LF)
            .expect("encode priv");
        let pub_pem = pubk
            .to_public_key_pem(rsa::pkcs8::LineEnding::LF)
            .expect("encode pub");
        fs::create_dir_all(&outdir).expect("mkdir");
        fs::write(format!("{outdir}/tickgold-license.key"), priv_pem.as_bytes())
            .expect("write key");
        fs::write(format!("{outdir}/tickgold-license.pub"), pub_pem.as_bytes())
            .expect("write pub");
        println!("keypair written to {outdir}");
        return;
    }

    let mut count = 100usize;
    let mut days = 365i64;
    let mut out = "codes.txt".to_string();
    let mut key_path: Option<String> = None;
    let mut plan = DEFAULT_PLAN.to_string();
    let mut ai_quota: Option<u32> = None;
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--key" => {
                i += 1;
                key_path = Some(args[i].clone());
            }
            "--count" => {
                i += 1;
                count = args[i].parse().unwrap_or(100);
            }
            "--days" => {
                i += 1;
                days = args[i].parse().unwrap_or(365);
            }
            "--plan" => {
                i += 1;
                plan = args[i].clone();
            }
            "--ai-quota" => {
                i += 1;
                ai_quota = Some(args[i].parse().unwrap_or(0));
            }
            "--out" => {
                i += 1;
                out = args[i].clone();
            }
            _ => {
                eprintln!("unknown arg: {}", args[i]);
                exit(1);
            }
        }
        i += 1;
    }

    let priv_pem = match key_path {
        Some(p) => fs::read_to_string(&p).expect("read key file"),
        None => env::var("TAURI_LICENSE_PRIVATE_KEY").expect("--key or TAURI_LICENSE_PRIVATE_KEY"),
    };
    let key = RsaPrivateKey::from_pkcs8_pem(priv_pem.trim()).expect("parse key");
    let sk = SigningKey::<Sha256>::new_unprefixed(key);
    let mut rng = ThreadRng::default();

    // ai-topup 卡不写 expires_at 限制（或给远期），其余按 days
    let expires = Local::now().date_naive() + Duration::days(days);
    let expires_s = expires.format("%Y-%m-%d").to_string();
    let mut f = fs::File::create(&out).expect("create out");
    let mut used = std::collections::HashSet::new();
    let mut n = 0usize;
    while n < count {
        let nonce: u128 = rand::Rng::gen(&mut rng);
        let mut payload = serde_json::json!({
            "plan": plan,
            "product": DEFAULT_PRODUCT,
            "expires_at": expires_s,
            "nonce": nonce.to_string(),
        });
        if let Some(q) = ai_quota {
            payload["ai_quota"] = serde_json::json!(q);
        }
        let pbytes = serde_json::to_vec(&payload).expect("json");
        let sig = sk.sign(&pbytes);
        let code = format!(
            "TG.{}.{}",
            URL_SAFE_NO_PAD.encode(&pbytes),
            URL_SAFE_NO_PAD.encode(sig.to_bytes())
        );
        if used.insert(code.clone()) {
            writeln!(f, "{code}").expect("write code");
            n += 1;
        }
    }
    println!(
        "wrote {count} codes (plan={plan}, expires_at={expires_s}, days={days}{ai}) -> {out}",
        ai = ai_quota.map(|q| format!(", ai_quota={q}")).unwrap_or_default()
    );
}
