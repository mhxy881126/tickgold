// QMT sidecar 进程管理：以 stdio NDJSON(JSON-RPC) 托管用户 Python 进程（sidecar_qmt.py）。
// Tauri 负责启动 / 监控 / 退出（kill_on_drop），无端口暴露；stdout 回报逐行转发为事件并驱动状态机。
// 说明：本机当前无 QMT / xtquant，connect 会失败并返回中文原因；真实回报链路在第 2 步联调。
use serde_json::{json, Value};
use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;
use tokio::process::{Child, ChildStdin};
use tokio::sync::Mutex;

/// 一条 JSON-RPC 请求。
pub fn request(id: &str, method: &str, params: Value) -> Value {
    json!({ "id": id, "method": method, "params": params })
}

/// 向 stdin 写入一行 JSON。
pub async fn send_to(stdin: &Arc<Mutex<ChildStdin>>, value: Value) -> Result<(), String> {
    let line = serde_json::to_string(&value).map_err(|e| format!("序列化请求失败: {e}"))?;
    let mut s = stdin.lock().await;
    s.write_all(line.as_bytes())
        .await
        .map_err(|e| format!("写入 sidecar 失败: {e}"))?;
    s.write_all(b"\n")
        .await
        .map_err(|e| format!("写入 sidecar 失败: {e}"))?;
    s.flush()
        .await
        .map_err(|e| format!("刷新 sidecar 失败: {e}"))
}

/// sidecar 句柄：子进程与 stdin 均为 Arc，便于在 std 管理锁外进行异步操作。
pub struct SidecarHandle {
    pub child: Arc<Mutex<Child>>,
    pub stdin: Arc<Mutex<ChildStdin>>,
}

/// 启动 sidecar 核心：以给定命令行参数拉起 Python 脚本，发送 connect，并拉起后台回报读取任务。
/// qmt / client 两类脚本共用本函数；差异仅在 extra_args 与 connect_params。
///
/// 说明：必须使用 python.exe（而非 pythonw.exe）。pythonw 属 GUI 子系统，
/// 其 stdout/stderr 句柄无效，sidecar 的 NDJSON 帧无法送达 Rust，会被误判为断开。
pub async fn spawn_generic(
    app: AppHandle,
    dir: &Path,
    python_path: &str,
    script_path: &str,
    extra_args: &[String],
    connect_params: Value,
) -> Result<SidecarHandle, String> {
    if python_path.trim().is_empty() {
        return Err("未配置 Python 路径（设置 - 券商交易）".to_string());
    }
    if !Path::new(python_path).exists() {
        return Err(format!("Python 不存在：{python_path}"));
    }
    if !Path::new(script_path).exists() {
        return Err(format!("sidecar 脚本不存在：{script_path}"));
    }

    let out_path = std::env::temp_dir().join("tickgold_sidecar_out.ndjson");
    let err_path = std::env::temp_dir().join("tickgold_sidecar_err.log");
    let out_file = std::fs::File::create(&out_path).map_err(|e| format!("创建 sidecar 输出文件失败: {e}"))?;
    let err_file = std::fs::File::create(&err_path).map_err(|e| format!("创建 sidecar 错误文件失败: {e}"))?;

    let mut cmd = tokio::process::Command::new(python_path);
    cmd.arg("-u") // 无缓冲输出
        .env("PYTHONIOENCODING", "utf-8") // P12-8 强制 UTF-8 输出，杜绝 stdout 文件 GBK 乱码
        .env("PYTHONUTF8", "1")
        .arg(script_path)
        .args(extra_args)
        .stdin(Stdio::piped())
        // Windows GUI 主进程下 tokio 的 piped stdout 无法被子进程继承
        // （已实测：stdout 立即 EOF、一帧不达，而 stdin 正常），故 stdout/stderr
        // 重定向到临时文件，由下方读取任务轮询文件增量。
        .stdout(Stdio::from(out_file))
        .stderr(Stdio::from(err_file))
        .kill_on_drop(true);
    // 仅 Windows：不弹控制台窗口。
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|e| format!("启动 sidecar 失败: {e}"))?;
    let child_stdin = child.stdin.take().ok_or("无法获取 sidecar stdin")?;

    let stdin = Arc::new(Mutex::new(child_stdin));
    let handle = SidecarHandle {
        child: Arc::new(Mutex::new(child)),
        stdin: stdin.clone(),
    };

    // connect 请求（参数由各通道决定）
    send_to(&stdin, request("connect", "connect", connect_params)).await?;

    // 后台读取：轮询 stdout 文件增量，逐行解析并转发事件 / 驱动状态机；
    // 同时轮询 stderr 文件缓冲尾部（进程秒退归因用）。
    let app2 = app.clone();
    let dir2 = dir.to_path_buf();
    let err_buf: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let err_buf2 = err_buf.clone();
    let out_path2 = out_path.clone();
    let err_path2 = err_path.clone();
    let child2 = handle.child.clone();
    tokio::spawn(async move {
        use std::io::{Read as _, Seek as _, SeekFrom};
        let mut pos: u64 = 0;
        let mut err_pos: u64 = 0;
        let mut pending = String::new();
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            // 1) stdout 文件增量
            if let Ok(meta) = std::fs::metadata(&out_path2) {
                let len = meta.len();
                if len > pos {
                    if let Ok(mut f) = std::fs::File::open(&out_path2) {
                        if f.seek(SeekFrom::Start(pos)).is_ok() {
                            let mut chunk = vec![0u8; (len - pos) as usize];
                            if f.read_exact(&mut chunk).is_ok() {
                                pos = len;
                                pending.push_str(&String::from_utf8_lossy(&chunk));
                                while let Some(idx) = pending.find('\n') {
                                    let line = pending[..idx].trim().to_string();
                                    pending = pending[idx + 1..].to_string();
                                    if line.is_empty() {
                                        continue;
                                    }
                                    match serde_json::from_str::<Value>(&line) {
                                        Ok(v) => {
                                            let _ = app2.emit("broker:sidecar", v.clone());
                                            crate::broker::apply_sidecar_event(&app2, &dir2, &v);
                                        }
                                        Err(e) => log::warn!("sidecar 帧解析失败（{e}）: {line}"),
                                    }
                                }
                            }
                        }
                    }
                }
            }
            // 2) stderr 文件增量（缓冲尾部）
            if let Ok(meta) = std::fs::metadata(&err_path2) {
                let len = meta.len();
                if len > err_pos {
                    if let Ok(mut f) = std::fs::File::open(&err_path2) {
                        if f.seek(SeekFrom::Start(err_pos)).is_ok() {
                            let mut chunk = vec![0u8; (len - err_pos) as usize];
                            if f.read_exact(&mut chunk).is_ok() {
                                err_pos = len;
                                let s = String::from_utf8_lossy(&chunk);
                                log::info!("[sidecar] {s}");
                                let mut buf = err_buf2.lock().await;
                                for l in s.lines() {
                                    buf.push(l.to_string());
                                }
                                while buf.len() > 40 {
                                    buf.remove(0);
                                }
                            }
                        }
                    }
                }
            }
            // 3) 进程退出检测 → 处理残留帧并宣告断开
            let exited = {
                let mut c = child2.lock().await;
                matches!(c.try_wait(), Ok(Some(_)))
            };
            if exited {
                if !pending.trim().is_empty() {
                    if let Ok(v) = serde_json::from_str::<Value>(pending.trim()) {
                        let _ = app2.emit("broker:sidecar", v.clone());
                        crate::broker::apply_sidecar_event(&app2, &dir2, &v);
                    }
                }
                let _ = app2.emit("broker:sidecar", json!({ "event": "disconnected" }));
                let tail = {
                    let buf = err_buf2.lock().await;
                    buf.iter().rev().take(6).cloned().collect::<Vec<_>>()
                };
                if !tail.is_empty() {
                    let detail = tail.iter().rev().cloned().collect::<Vec<_>>().join(" | ");
                    let _ = app2.emit(
                        "broker:sidecar_error",
                        json!({
                            "message": format!("交易通道进程已退出：{detail}"),
                            "fatal": true,
                        }),
                    );
                }
                break;
            }
        }
    });

    // 快速死亡检测：spawn 后 3 秒内进程退出且无任何 stderr 归因
    // → 高度疑似被安全软件（360 / 腾讯电脑管家）拦截（已确认：其会终止
    // 「未知签名应用派生的、监听 TCP 端口的子进程」），给出可操作提示。
    {
        let app2 = app.clone();
        let child2 = handle.child.clone();
        let err_buf3 = err_buf.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            let exited = {
                let mut c = child2.lock().await;
                matches!(c.try_wait(), Ok(Some(_)))
            };
            if exited {
                let tail = {
                    let buf = err_buf3.lock().await;
                    buf.iter().rev().take(6).cloned().collect::<Vec<_>>()
                };
                if tail.is_empty() {
                    let _ = app2.emit(
                        "broker:sidecar_error",
                        json!({
                            "message": "交易通道进程在启动后立即被终止（无任何报错输出）。已确认：360 安全卫士 / 腾讯电脑管家会拦截本应用派生的进程，请将其加入「信任区 / 白名单」后重试；若开启了 HTTP API 服务端口，请先在券商交易设置中关闭（或加白名单）。",
                            "fatal": true,
                        }),
                    );
                }
            }
        });
    }

    // 连接结果由后台任务经 broker:sidecar(connected/error/selfcheck) 事件回传，
    // 避免在无客户端环境长时间阻塞命令。
    Ok(handle)
}

/// 启动 QMT sidecar（保留原签名，内部走通用 spawn_generic）。
pub async fn spawn(
    app: AppHandle,
    dir: &Path,
    python_path: &str,
    script_path: &str,
    qmt_path: &str,
    account: &str,
) -> Result<SidecarHandle, String> {
    let extra = vec![
        "--qmt".to_string(),
        qmt_path.to_string(),
        "--account".to_string(),
        account.to_string(),
    ];
    let params = json!({ "qmt": qmt_path, "account": account });
    spawn_generic(app, dir, python_path, script_path, &extra, params).await
}
