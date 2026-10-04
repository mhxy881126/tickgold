// QMT sidecar 进程管理：以 stdio NDJSON(JSON-RPC) 托管用户 Python 进程（sidecar_qmt.py）。
// Tauri 负责启动 / 监控 / 退出（kill_on_drop），无端口暴露；stdout 回报逐行转发为事件并驱动状态机。
// 说明：本机当前无 QMT / xtquant，connect 会失败并返回中文原因；真实回报链路在第 2 步联调。
use serde_json::{json, Value};
use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
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
    s.write_all(b"\n").await.map_err(|e| format!("写入 sidecar 失败: {e}"))?;
    s.flush().await.map_err(|e| format!("刷新 sidecar 失败: {e}"))
}

/// sidecar 句柄：子进程与 stdin 均为 Arc，便于在 std 管理锁外进行异步操作。
pub struct SidecarHandle {
    pub child: Arc<Mutex<Child>>,
    pub stdin: Arc<Mutex<ChildStdin>>,
}

impl SidecarHandle {
    pub async fn kill(&self) {
        let _ = self.child.lock().await.kill().await;
    }
}

/// 启动 sidecar，发送 connect，并拉起后台回报读取任务。
pub async fn spawn(
    app: AppHandle,
    dir: &Path,
    python_path: &str,
    script_path: &str,
    qmt_path: &str,
    account: &str,
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

    let mut cmd = tokio::process::Command::new(python_path);
    cmd.arg(script_path)
        .arg("--qmt")
        .arg(qmt_path)
        .arg("--account")
        .arg(account)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // 仅 Windows：不弹控制台窗口（tokio Command 内置 creation_flags）。
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|e| format!("启动 sidecar 失败: {e}"))?;
    let child_stdin = child.stdin.take().ok_or("无法获取 sidecar stdin")?;
    let stdout = child.stdout.take().ok_or("无法获取 sidecar stdout")?;
    let stderr = child.stderr.take();

    let stdin = Arc::new(Mutex::new(child_stdin));
    let handle = SidecarHandle {
        child: Arc::new(Mutex::new(child)),
        stdin: stdin.clone(),
    };

    // connect 请求
    send_to(
        &stdin,
        request("connect", "connect", json!({ "qmt": qmt_path, "account": account })),
    )
    .await?;

    // 后台读取 stdout：逐行解析，转发事件 + 驱动状态机。
    let app2 = app.clone();
    let dir2 = dir.to_path_buf();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if line.trim().is_empty() {
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
        log::warn!("sidecar stdout 已结束（进程退出）");
        let _ = app2.emit("broker:sidecar", json!({ "event": "disconnected" }));
    });

    // stderr 落日志
    if let Some(err) = stderr {
        tokio::spawn(async move {
            let mut lines = BufReader::new(err).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                log::info!("[sidecar] {l}");
            }
        });
    }

    // 连接结果由后台任务经 broker:sidecar(connected/error) 事件回传，
    // 避免在无 QMT 环境长时间阻塞命令。
    Ok(handle)
}
