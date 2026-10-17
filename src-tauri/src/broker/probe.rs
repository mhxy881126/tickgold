// P8 券商路径一键自检：本机探测 python / qmt / 同花顺客户端 / tesseract 常见位置，
// 不依赖 sidecar，纯文件系统检查。前端每个路径框的「自动探测」与「一键自检」共用本命令。
use crate::broker::BrokerManager;
use serde::Serialize;
use std::path::Path;
use std::process::Command;
use tauri::State;

#[derive(Serialize)]
struct PathProbe {
    field: String,
    label: String,
    /// ok（配置值可用）/ empty（未配置但有建议）/ missing（配置值无效且无建议）
    status: String,
    configured: String,
    exists: bool,
    suggested: String,
    hint: String,
}

impl PathProbe {
    fn ok(field: &str, label: &str, value: &str) -> Self {
        PathProbe {
            field: field.into(),
            label: label.into(),
            status: "ok".into(),
            configured: value.trim().into(),
            exists: true,
            suggested: String::new(),
            hint: "路径可用".into(),
        }
    }
    fn empty(field: &str, label: &str, suggested: &str, hint: &str) -> Self {
        PathProbe {
            field: field.into(),
            label: label.into(),
            status: "empty".into(),
            configured: String::new(),
            exists: false,
            suggested: suggested.into(),
            hint: hint.into(),
        }
    }
    fn missing(field: &str, label: &str, configured: &str, hint: &str) -> Self {
        PathProbe {
            field: field.into(),
            label: label.into(),
            status: "missing".into(),
            configured: configured.trim().into(),
            exists: false,
            suggested: String::new(),
            hint: hint.into(),
        }
    }
}

fn exists(p: &str) -> bool {
    let t = p.trim();
    !t.is_empty() && Path::new(t).is_file()
}

fn exists_dir(p: &str) -> bool {
    let t = p.trim();
    !t.is_empty() && Path::new(t).is_dir()
}

/// 枚举 dir 下以 prefix 开头的一级子目录，返回其中命中 file 的第一个完整路径。
fn scan_dir_for(dir: &str, prefix: &str, file: &str) -> Option<String> {
    let d = Path::new(dir);
    if !d.is_dir() {
        return None;
    }
    let rd = std::fs::read_dir(d).ok()?;
    for ent in rd.flatten() {
        let p = ent.path();
        let name = ent.file_name().to_string_lossy().to_string();
        if p.is_dir() && name.starts_with(prefix) {
            let cand = p.join(file);
            if cand.is_file() {
                return Some(cand.to_string_lossy().to_string());
            }
        }
    }
    None
}

fn find_in_path(exe: &str) -> Option<String> {
    let path = std::env::var_os("PATH")?;
    for d in std::env::split_paths(&path) {
        let c = d.join(exe);
        if c.is_file() {
            return Some(c.to_string_lossy().to_string());
        }
    }
    None
}

fn local_appdata() -> String {
    std::env::var("LOCALAPPDATA").unwrap_or_else(|_| "C:\\Users\\Public".into())
}

fn probe_python(configured: &str) -> PathProbe {
    if exists(configured) {
        return PathProbe::ok("pythonPath", "Python 路径", configured);
    }
    let base = local_appdata();
    let mut sug = scan_dir_for(&format!("{}\\Programs\\Python", base), "Python3", "python.exe")
        .or_else(|| scan_dir_for("C:\\", "Python3", "python.exe"))
        .or_else(|| find_in_path("python.exe"))
        .or_else(|| find_in_path("python3.exe"));
    if sug.is_none() {
        // 尝试 py 启动器解析
        if let Ok(out) = Command::new("py").arg("-3.12").arg("-c").arg("import sys;print(sys.executable)")
            .output()
        {
            if out.status.success() {
                let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if exists(&s) {
                    sug = Some(s);
                }
            }
        }
    }
    match sug {
        Some(s) => PathProbe::empty("pythonPath", "Python 路径", &s, "未配置；已自动找到可用解释器，点「自动填入」即可"),
        None => PathProbe::missing("pythonPath", "Python 路径", configured, "未找到 python.exe：请安装 Python 3.10–3.12 后重试，或手动填写完整路径"),
    }
}

fn probe_qmt(configured: &str) -> PathProbe {
    if exists_dir(configured) {
        return PathProbe::ok("qmtPath", "userdata_mini 路径", configured);
    }
    const COMMON: &[&str] = &[
        "C:\\国金证券QMT交易端\\userdata_mini",
        "D:\\国金证券QMT交易端\\userdata_mini",
        "C:\\QMT\\userdata_mini",
        "D:\\QMT\\userdata_mini",
        "C:\\迅投\\userdata_mini",
        "D:\\迅投\\userdata_mini",
    ];
    for c in COMMON {
        if Path::new(c).is_dir() {
            return PathProbe::empty("qmtPath", "userdata_mini 路径", c, "未配置；已发现 QMT 数据目录，点「自动填入」即可");
        }
    }
    PathProbe::missing("qmtPath", "userdata_mini 路径", configured, "未找到 userdata_mini：请先在本机启动一次 miniQMT 客户端（会生成该目录），或手动填写")
}

fn probe_client(configured: &str) -> PathProbe {
    if exists(configured) {
        return PathProbe::ok("clientPath", "同花顺客户端路径", configured);
    }
    const COMMON: &[&str] = &[
        "C:\\同花顺\\xiadan.exe",
        "D:\\同花顺\\xiadan.exe",
        "C:\\ths\\xiadan.exe",
        "D:\\ths\\xiadan.exe",
        "C:\\同花顺模拟炒股\\xiadan.exe",
        "D:\\同花顺模拟炒股\\xiadan.exe",
    ];
    for c in COMMON {
        if Path::new(c).is_file() {
            return PathProbe::empty("clientPath", "同花顺客户端路径", c, "未配置；已发现同花顺下单程序，点「自动填入」即可");
        }
    }
    PathProbe::missing("clientPath", "同花顺客户端路径", configured, "未找到下单程序；可留空（连接时按窗口标题自动探测），或在同花顺安装目录手动填写 xiadan.exe")
}

fn probe_tesseract(configured: &str) -> PathProbe {
    if exists(configured) {
        return PathProbe::ok("clientTesseract", "Tesseract OCR 路径", configured);
    }
    let base = local_appdata();
    let cands = [
        "C:\\Program Files\\Tesseract-OCR\\tesseract.exe".to_string(),
        "C:\\Program Files (x86)\\Tesseract-OCR\\tesseract.exe".to_string(),
        format!("{}\\Programs\\Tesseract-OCR\\tesseract.exe", base),
    ];
    for c in cands {
        if Path::new(&c).is_file() {
            return PathProbe::empty("clientTesseract", "Tesseract OCR 路径", &c, "未配置；已找到 tesseract.exe，点「自动填入」即可（复制表格验证码可自动识别）");
        }
    }
    PathProbe::empty("clientTesseract", "Tesseract OCR 路径", "", "未找到 tesseract.exe（可选）：不装也能用，复制表格遇验证码时会在控制台弹图由你手动输入")
}

/// 券商路径一键自检：mode = mock / qmt / client；缺省用当前配置模式。
/// 返回每个路径字段的状态 + 建议值，前端可一键回填。
#[tauri::command]
pub fn broker_probe_paths(
    mgr: State<'_, BrokerManager>,
    mode: Option<String>,
) -> Result<serde_json::Value, String> {
    let cfg = mgr.config.lock().unwrap().clone();
    let mode = mode.unwrap_or_else(|| cfg.kind.clone());
    let mut probes = vec![probe_python(&cfg.python_path)];
    match mode.as_str() {
        "qmt" => probes.push(probe_qmt(&cfg.qmt_path)),
        "client" => {
            probes.push(probe_client(&cfg.client_path));
            probes.push(probe_tesseract(&cfg.client_tesseract));
        }
        _ => {}
    }
    let ok = probes.iter().filter(|p| p.status == "ok").count();
    Ok(serde_json::json!({
        "mode": mode,
        "probes": probes,
        "summary": { "ok": ok, "bad": probes.len() - ok },
    }))
}
