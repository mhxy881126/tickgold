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
    /// 命中来源标注：manual / running-process / registry / filesystem / path（可空）
    source: String,
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
            source: "manual".into(),
        }
    }
    fn ok_with_source(field: &str, label: &str, value: &str, source: &str, hint: &str) -> Self {
        PathProbe {
            field: field.into(),
            label: label.into(),
            status: "ok".into(),
            configured: value.trim().into(),
            exists: true,
            suggested: String::new(),
            hint: hint.into(),
            source: source.into(),
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
            source: String::new(),
        }
    }
    fn empty_with_source(field: &str, label: &str, suggested: &str, source: &str, hint: &str) -> Self {
        PathProbe {
            field: field.into(),
            label: label.into(),
            status: "empty".into(),
            configured: String::new(),
            exists: false,
            suggested: suggested.into(),
            hint: hint.into(),
            source: source.into(),
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
            source: String::new(),
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

/// 创建隐藏窗口的子进程：GUI 父进程无控制台时，直接启动 python / powershell / reg / py 等
/// 控制台子程序会闪现黑色命令窗。CREATE_NO_WINDOW（0x0800_0000）抑制窗口创建，仅 Windows 生效。
fn silent_cmd(program: &str) -> Command {
    let mut c = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    c
}

// ===== 纯逻辑（无 I/O，可单测）=====

/// 下单程序厂商分类：Ths=同花顺系，Other=其他券商/非同花顺，Unknown=无法判断。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Vendor {
    Ths,
    Other,
    Unknown,
}

/// 从 DisplayName / DisplayIcon / 安装路径文本判定是否同花顺系。
/// 关键词：同花顺 / THS（独立词）/ hexin / 核桃。
fn vendor_from_text(text: &str) -> Vendor {
    if text.trim().is_empty() {
        return Vendor::Unknown;
    }
    let lower = text.to_lowercase();
    if lower.contains("同花顺") || lower.contains("核桃") || lower.contains("hexin") {
        return Vendor::Ths;
    }
    // ASCII 只在「独立词」命中 ths，避免 months/authorship 之类子串误判
    for tok in lower.split(|c: char| !c.is_alphanumeric()) {
        if tok == "ths" {
            return Vendor::Ths;
        }
    }
    Vendor::Other
}

/// 客户端候选（I/O 收集，纯逻辑排序）。
#[derive(Clone, Debug)]
struct ClientCandidate {
    path: String,
    /// running-process / registry / filesystem / path
    source: &'static str,
    vendor: Vendor,
}

/// 厂商排序分：同花顺最优先。
fn vendor_rank(v: Vendor) -> u8 {
    match v {
        Vendor::Ths => 0,
        Vendor::Unknown => 1,
        Vendor::Other => 2,
    }
}

/// 文件名排序分：下单程序 xiadan.exe 优先于 xiadan-plus.exe，再其次其他（如 hexin.exe 行情主程序）。
fn exe_rank(p: &str) -> u8 {
    let n = Path::new(p)
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if n == "xiadan.exe" {
        0
    } else if n == "xiadan-plus.exe" {
        1
    } else {
        2
    }
}

/// 候选排序：同花顺优先，其次无法判断，其他券商排后；同 vendor 内下单程序优先于行情主程序。
fn rank_clients(mut cands: Vec<ClientCandidate>) -> Vec<ClientCandidate> {
    cands.sort_by(|a, b| {
        vendor_rank(a.vendor)
            .cmp(&vendor_rank(b.vendor))
            .then_with(|| exe_rank(&a.path).cmp(&exe_rank(&b.path)))
    });
    cands
}

/// 按路径大小写不敏感去重（保留首次出现）。
fn dedupe_candidates(mut cands: Vec<ClientCandidate>) -> Vec<ClientCandidate> {
    let mut seen = std::collections::HashSet::new();
    cands.retain(|c| seen.insert(c.path.to_lowercase()));
    cands
}

/// 解析 "3.11.9" / "3.12" → (major, minor)；无法解析返回 None。
fn parse_python_version(raw: &str) -> Option<(u8, u8)> {
    let v = raw.trim();
    let mut parts = v.split('.');
    let major = parts.next()?.parse::<u8>().ok()?;
    let minor = parts.next()?.parse::<u8>().ok()?;
    Some((major, minor))
}

/// 推荐版本区间 3.10 <= v <= 3.12（仅此区间承诺 pywinauto/pyautogui 稳定）。
fn is_supported_python_version(major: u8, minor: u8) -> bool {
    major == 3 && (10..=12).contains(&minor)
}

/// 缺依赖排除文案（纯文本拼装，包名由调用方给出）。
fn missing_deps_hint(missing: &[&str]) -> String {
    format!(
        "该解释器缺少依赖（{}），已排除不建议使用：请安装 Python 3.10–3.12 并 `pip install pywinauto pyautogui pillow`，或换用已装好依赖的解释器",
        missing.join("、")
    )
}

/// 手填值是否为裸文件名或相对路径（无盘符、非 UNC）。
fn is_bare_or_relative(p: &str) -> bool {
    let t = p.trim();
    if t.is_empty() {
        return false;
    }
    // 绝对路径：盘符 C: 或 UNC \\server
    if t.chars().nth(1) == Some(':') {
        return false;
    }
    !t.starts_with("\\\\")
}

/// 从 DisplayIcon 原始值（`"C:\a\b.exe",0` / `C:\a\b.exe`）提取 exe 路径。
fn parse_display_icon_path(raw: &str) -> Option<String> {
    let t = raw.trim().trim_matches('"').trim();
    if t.is_empty() {
        return None;
    }
    let path = t.split(',').next().unwrap_or(t).trim().trim_matches('"').to_string();
    if path.ends_with(".exe") || path.contains('\\') || path.contains('/') {
        Some(path)
    } else {
        None
    }
}

/// 解析 `reg query /s` 输出块中的 DisplayName / InstallLocation / DisplayIcon。
/// 返回 (DisplayName, InstallLocation, DisplayIcon 原始值)。
fn parse_reg_block(block: &str) -> (Option<String>, Option<String>, Option<String>) {
    let mut name = None;
    let mut loc = None;
    let mut icon = None;
    for line in block.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("DisplayName") {
            let v = reg_value_after(rest);
            if !v.is_empty() {
                name = Some(v);
            }
        } else if let Some(rest) = line.strip_prefix("InstallLocation") {
            let v = reg_value_after(rest);
            if !v.is_empty() {
                loc = Some(v);
            }
        } else if let Some(rest) = line.strip_prefix("DisplayIcon") {
            let v = reg_value_after(rest);
            if !v.is_empty() {
                icon = Some(v);
            }
        }
    }
    (name, loc, icon)
}

/// reg 行格式：`    DisplayName    REG_SZ    值`，跳过类型段后把值拼回（值可含空格）。
fn reg_value_after(rest: &str) -> String {
    let mut it = rest.split_whitespace();
    it.next(); // REG_SZ / REG_EXPAND_SZ / REG_DWORD
    it.collect::<Vec<_>>().join(" ")
}

/// 取路径末段文件名，用于 hint 罗列其他券商候选。
fn short_path(p: &str) -> String {
    Path::new(p)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| p.to_string())
}

/// Windows 控制台（wmic / reg / powershell）输出解码：优先 UTF-8（新系统 / 65001 代码页），
/// 非法 UTF-8 回退 GBK（旧中文系统）。纯 ASCII 两种解码结果一致，可安全优先 UTF-8。
fn cmd_text(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        Err(_) => encoding_rs::GBK.decode(bytes).0.into_owned(),
    }
}

/// 枚举 dir 下以 prefix 开头的一级子目录，返回其中命中 file 的第一个完整路径。
#[allow(dead_code)]
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

/// 试运行 python：确认解释器真的可执行（防失效 venv / 坏安装）。
fn python_runnable(p: &str) -> bool {
    if !exists(p) {
        return false;
    }
    silent_cmd(p)
        .arg("-c")
        .arg("import sys;print(sys.executable)")
        .output()
        .map(|o| o.status.success() && !o.stdout.is_empty())
        .unwrap_or(false)
}

/// 扫描 dir 下全部 Python3* 一级目录中的真实 python.exe（跳过 venv 内嵌解释器）。
/// venv 判定：python.exe 同目录存在 pyvenv.cfg（真实安装没有此文件）。
/// 注意不能用「Lib\venv」判断——venv 是标准库模块，所有标准安装都带 Lib\venv 目录，
/// 用它会把本机已装的 Python 全部误伤跳过。
fn scan_python_exe(dir: &str) -> Vec<String> {
    let mut out = Vec::new();
    let d = Path::new(dir);
    if !d.is_dir() {
        return out;
    }
    let rd = std::fs::read_dir(d).ok();
    let Some(rd) = rd else { return out };
    for ent in rd.flatten() {
        let p = ent.path();
        let name = ent.file_name().to_string_lossy().to_string();
        if !p.is_dir() || !name.starts_with("Python3") {
            continue;
        }
        // 跳过 venv 内嵌解释器：python.exe 同目录存在 pyvenv.cfg 即为 venv
        if p.join("pyvenv.cfg").is_file() {
            continue;
        }
        let cand = p.join("python.exe");
        if cand.is_file() {
            out.push(cand.to_string_lossy().to_string());
        }
    }
    out
}

/// 体检一个解释器：(可运行, 版本(major,minor), 缺失依赖列表)。I/O 都在这层，版本/依赖判定结果供纯逻辑使用。
fn inspect_python(p: &str) -> (bool, Option<(u8, u8)>, Vec<String>) {
    if !exists(p) {
        return (false, None, Vec::new());
    }
    let ver = silent_cmd(p)
        .args(["-c", "import sys;print(f'{sys.version_info.major}.{sys.version_info.minor}')"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| cmd_text(&o.stdout))
        .and_then(|s| parse_python_version(s.trim()));
    let runnable = ver.is_some() || python_runnable(p);
    let mut missing = Vec::new();
    for pkg in ["pywinauto", "pyautogui", "PIL"] {
        let ok = silent_cmd(p)
            .args(["-c", &format!("import {pkg}")])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !ok {
            missing.push(pkg.to_string());
        }
    }
    (runnable, ver, missing)
}

fn probe_python(configured: &str) -> PathProbe {
    let cfg = configured.trim();
    // 手填值即时体检：存在 → 可运行 → 依赖齐全 → 版本兼容；任一不过给明确 hint
    if !cfg.is_empty() {
        if !exists(cfg) {
            return PathProbe::missing(
                "pythonPath",
                "Python 路径",
                cfg,
                "填写的 Python 路径不存在；请核对 python.exe 完整路径，或留空由自动探测",
            );
        }
        let (runnable, ver, missing) = inspect_python(cfg);
        if !runnable {
            return PathProbe::missing(
                "pythonPath",
                "Python 路径",
                cfg,
                "该 Python 无法运行（可能是失效的虚拟环境，缺少 pyvenv.cfg）：请点「自动探测」换用可用解释器，或手动填写",
            );
        }
        if !missing.is_empty() {
            let miss: Vec<&str> = missing.iter().map(|s| s.as_str()).collect();
            return PathProbe::missing("pythonPath", "Python 路径", cfg, &missing_deps_hint(&miss));
        }
        let compat = ver.map(|v| is_supported_python_version(v.0, v.1)).unwrap_or(false);
        if !compat {
            let vtxt = ver.map(|v| format!("{}.{}", v.0, v.1)).unwrap_or_else(|| "未知".into());
            return PathProbe::ok_with_source(
                "pythonPath",
                "Python 路径",
                cfg,
                "manual",
                &format!("解释器可运行且依赖齐全；但版本 {vtxt} 不在推荐 3.10–3.12，建议更换为 3.10–3.12"),
            );
        }
        return PathProbe::ok("pythonPath", "Python 路径", cfg);
    }
    let base = local_appdata();
    // 候选顺序：py 启动器（3.12/3.11/3.10）→ 真实安装 python.exe → PATH
    let mut cands: Vec<String> = Vec::new();
    for ver in ["-3.12", "-3.11", "-3.10"] {
        if let Ok(out) = silent_cmd("py")
            .arg(ver)
            .arg("-c")
            .arg("import sys;print(sys.executable)")
            .output()
        {
            if out.status.success() {
                let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if exists(&s) {
                    cands.push(s);
                }
            }
        }
    }
    cands.extend(scan_python_exe(&format!("{}\\Programs\\Python", base)));
    cands.extend(scan_python_exe("C:\\"));
    for e in ["python.exe", "python3.exe"] {
        if let Some(p) = find_in_path(e) {
            cands.push(p);
        }
    }
    // 顺序保留去重（py 启动器 3.12→3.10 的偏好不被打乱）
    let mut seen = std::collections::HashSet::new();
    cands.retain(|c| seen.insert(c.to_lowercase()));

    let mut preferred: Option<String> = None;
    let mut excluded: Vec<String> = Vec::new();
    for c in cands {
        let (runnable, ver, missing) = inspect_python(&c);
        if !runnable {
            excluded.push(format!("{}（无法运行/失效环境）", short_path(&c)));
            continue;
        }
        if !missing.is_empty() {
            excluded.push(format!("{}（缺 {}）", short_path(&c), missing.join("、")));
            continue;
        }
        let compat = ver.map(|v| is_supported_python_version(v.0, v.1)).unwrap_or(false);
        if !compat {
            let vtxt = ver.map(|v| format!("{}.{}", v.0, v.1)).unwrap_or_else(|| "未知版本".into());
            excluded.push(format!("{}（版本 {vtxt} 不在 3.10–3.12）", short_path(&c)));
            continue;
        }
        if preferred.is_none() {
            preferred = Some(c);
        }
    }
    match preferred {
        Some(s) => {
            let mut hint = "未配置；已自动找到可用解释器（3.10–3.12，pywinauto/pyautogui/PIL 齐全），点「自动填入」即可".to_string();
            if !excluded.is_empty() {
                hint.push_str(&format!("；已排除：{}", excluded.join("；")));
            }
            PathProbe::empty("pythonPath", "Python 路径", &s, &hint)
        }
        None => {
            let mut h = "未找到符合要求的 python.exe：请安装 Python 3.10–3.12 并 `pip install pywinauto pyautogui pillow`；".to_string();
            if !excluded.is_empty() {
                h.push_str(&format!("本机候选已排除：{}；", excluded.join("；")));
            }
            h.push_str("若已有虚拟环境失效请重装/重建，再点「自动探测」");
            PathProbe::missing("pythonPath", "Python 路径", configured, &h)
        }
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

/// 裸文件名 / 相对路径解析：先 PATH（仅裸名），再当前目录；都找不到返回 None。
fn resolve_bare_or_relative(name: &str) -> Option<String> {
    if !name.contains('\\') && !name.contains('/') {
        if let Some(p) = find_in_path(name) {
            return Some(p);
        }
    }
    let cwd = std::env::current_dir().ok()?;
    let joined = cwd.join(name);
    if joined.is_file() {
        Some(joined.to_string_lossy().to_string())
    } else {
        None
    }
}

/// 1) 正在运行的 xiadan.exe / xiadan-plus.exe 进程可执行路径。
/// wmic 优先，PowerShell CIM 回退；命令缺失/无进程/权限不足一律静默跳过，不报错。
fn running_client_process() -> Vec<ClientCandidate> {
    let mut out = Vec::new();
    if let Ok(o) = silent_cmd("wmic")
        .args([
            "process",
            "where",
            "name='xiadan.exe' or name='xiadan-plus.exe'",
            "get",
            "ExecutablePath",
        ])
        .output()
    {
        for line in cmd_text(&o.stdout).lines() {
            let p = line.trim();
            if p.is_empty() || p.eq_ignore_ascii_case("ExecutablePath") {
                continue;
            }
            if p.to_lowercase().ends_with(".exe") && Path::new(p).is_file() {
                out.push(ClientCandidate {
                    path: p.into(),
                    source: "running-process",
                    vendor: vendor_from_text(p),
                });
            }
        }
    }
    if out.is_empty() {
        let ps = "Get-CimInstance Win32_Process -Filter \"Name='xiadan.exe' OR Name='xiadan-plus.exe'\" | Select-Object -ExpandProperty ExecutablePath";
        if let Ok(o) = silent_cmd("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", ps])
            .output()
        {
            for line in cmd_text(&o.stdout).lines() {
                let p = line.trim();
                if p.is_empty() {
                    continue;
                }
                if p.to_lowercase().ends_with(".exe") && Path::new(p).is_file() {
                    out.push(ClientCandidate {
                        path: p.into(),
                        source: "running-process",
                        vendor: vendor_from_text(p),
                    });
                }
            }
        }
    }
    out
}

/// 2) 注册表 Uninstall（HKLM 64/32 视图 + HKCU），reg query /s 一次性取全量后按块解析，
/// 仅保留同花顺系（DisplayName / DisplayIcon 命中关键词），失败静默跳过。
fn registry_client_candidates() -> Vec<ClientCandidate> {
    const ROOTS: &[&str] = &[
        r"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
        r"HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
        r"HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
    ];
    let mut out = Vec::new();
    for root in ROOTS {
        let o = match silent_cmd("reg").args(["query", root, "/s"]).output() {
            Ok(o) => o,
            Err(_) => continue,
        };
        let text = cmd_text(&o.stdout).replace("\r\n", "\n");
        for block in text.split("\n\n") {
            let (name, loc, icon) = parse_reg_block(block);
            let hay = match (&name, &icon) {
                (Some(n), Some(i)) => format!("{n} {i}"),
                (Some(n), None) => n.clone(),
                (None, Some(i)) => i.clone(),
                (None, None) => continue,
            };
            if vendor_from_text(&hay) != Vendor::Ths {
                continue;
            }
            if let Some(icon_raw) = &icon {
                if let Some(p) = parse_display_icon_path(icon_raw) {
                    if Path::new(&p).is_file() {
                        out.push(ClientCandidate { path: p, source: "registry", vendor: Vendor::Ths });
                    }
                }
            }
            if let Some(loc) = loc.filter(|s| !s.trim().is_empty()) {
                let cand = Path::new(&loc).join("xiadan.exe");
                if cand.is_file() {
                    out.push(ClientCandidate {
                        path: cand.to_string_lossy().into(),
                        source: "registry",
                        vendor: Vendor::Ths,
                    });
                }
            }
        }
    }
    out
}

/// 文件系统剪枝目录名（不递归进入，控制耗时、避免全盘漫游）。
fn is_pruned_dir(name: &str) -> bool {
    matches!(
        name.to_lowercase().as_str(),
        "windows" | "system32" | "$recycle.bin" | "node_modules" | ".git" | "appdata"
            | "programdata" | "perflogs" | "recovery" | "documents and settings"
    )
}

/// 有界深度递归找 xiadan.exe / xiadan-plus.exe（默认最深 3 层）。
fn walk_find_xiadan(dir: &Path, depth: usize, max_depth: usize, out: &mut Vec<ClientCandidate>) {
    if depth > max_depth {
        return;
    }
    let rd = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return,
    };
    for ent in rd.flatten() {
        let p = ent.path();
        let name = ent.file_name().to_string_lossy().to_string();
        let lower = name.to_lowercase();
        if p.is_file() && (lower == "xiadan.exe" || lower == "xiadan-plus.exe") {
            out.push(ClientCandidate {
                path: p.to_string_lossy().into(),
                source: "filesystem",
                vendor: vendor_from_text(&p.to_string_lossy()),
            });
            continue;
        }
        if p.is_dir() && depth < max_depth && !is_pruned_dir(&name) {
            walk_find_xiadan(&p, depth + 1, max_depth, out);
        }
    }
}

/// 3) 文件系统有界深度补扫：Program Files(64/32)、用户 Downloads/360download/下载、常见同花顺目录。
fn scan_fs_clients() -> Vec<ClientCandidate> {
    let mut roots: Vec<String> = Vec::new();
    for d in [
        "C:\\Program Files",
        "C:\\Program Files (x86)",
        "D:\\Program Files",
        "D:\\Program Files (x86)",
    ] {
        if Path::new(d).is_dir() {
            roots.push(d.into());
        }
    }
    if let Ok(home) = std::env::var("USERPROFILE") {
        for sub in ["Downloads", "360download", "下载", "Desktop"] {
            let p = Path::new(&home).join(sub);
            if p.is_dir() {
                roots.push(p.to_string_lossy().into());
            }
        }
    }
    // 多盘符常见下载根（用户常把客户端装在 D:\360download 之类非用户目录）
    for d in [
        "C:\\360download",
        "D:\\360download",
        "C:\\Downloads",
        "D:\\Downloads",
        "C:\\下载",
        "D:\\下载",
    ] {
        if Path::new(d).is_dir() {
            roots.push(d.into());
        }
    }
    for d in [
        "C:\\同花顺",
        "D:\\同花顺",
        "C:\\ths",
        "D:\\ths",
        "C:\\同花顺模拟炒股",
        "D:\\同花顺模拟炒股",
    ] {
        if Path::new(d).is_dir() {
            roots.push(d.into());
        }
    }
    let mut out = Vec::new();
    for root in roots {
        walk_find_xiadan(Path::new(&root), 0, 3, &mut out);
    }
    out
}

fn probe_client(configured: &str) -> PathProbe {
    let cfg = configured.trim();
    // 手填值：绝对路径直接判；裸名/相对路径走 PATH → 当前目录解析
    if !cfg.is_empty() {
        if is_bare_or_relative(cfg) {
            if let Some(p) = resolve_bare_or_relative(cfg) {
                return PathProbe::ok_with_source(
                    "clientPath",
                    "同花顺客户端路径",
                    &p,
                    "path",
                    "已通过 PATH/当前目录解析到下单程序，请核对是否为同花顺",
                );
            }
            return PathProbe::missing(
                "clientPath",
                "同花顺客户端路径",
                cfg,
                "填写的是裸文件名/相对路径，但 PATH 与当前目录都未找到；请填写 xiadan.exe 完整绝对路径，或留空由自动探测",
            );
        }
        if exists(cfg) {
            let hint = match vendor_from_text(cfg) {
                Vendor::Ths => "路径可用",
                Vendor::Other => "路径可用，但该程序看起来不是同花顺（其他券商/非同花顺，注意核对）",
                Vendor::Unknown => "路径可用，请核对是否为同花顺下单程序",
            };
            return PathProbe::ok_with_source("clientPath", "同花顺客户端路径", cfg, "manual", hint);
        }
        return PathProbe::missing(
            "clientPath",
            "同花顺客户端路径",
            cfg,
            "填写的客户端路径不存在；请核对 xiadan.exe 完整路径，或留空由自动探测",
        );
    }

    // 自动探测顺序：正在运行进程 → 注册表安装记录 → 文件系统有界扫描 → PATH
    let mut cands = running_client_process();
    cands.extend(registry_client_candidates());
    cands.extend(scan_fs_clients());
    if let Some(p) = find_in_path("xiadan.exe") {
        cands.push(ClientCandidate { path: p, source: "path", vendor: vendor_from_text("") });
    }
    let cands = rank_clients(dedupe_candidates(cands));
    let Some(top) = cands.first() else {
        return PathProbe::missing(
            "clientPath",
            "同花顺客户端路径",
            configured,
            "未找到下单程序；可留空（连接时按窗口标题自动探测），或在同花顺安装目录手动填写 xiadan.exe",
        );
    };
    let others: Vec<&ClientCandidate> = cands.iter().filter(|c| c.vendor != Vendor::Ths).collect();
    let source_note = match top.source {
        "running-process" => "（来源：正在运行的进程）",
        "registry" => "（来源：注册表安装记录）",
        "filesystem" => "（来源：本机目录扫描）",
        _ => "（来源：PATH）",
    };
    let mut hint = format!("未配置；已发现下单程序{source_note}，点「自动填入」即可");
    if top.vendor != Vendor::Ths {
        hint.push_str("；该程序看起来不是同花顺（其他券商/非同花顺，注意核对）");
    }
    if !others.is_empty() {
        let names: Vec<String> = others.iter().take(3).map(|c| short_path(&c.path)).collect();
        hint.push_str(&format!(
            "；另检测到 {} 个其他券商/非同花顺下单程序（{}），请注意核对勿选错",
            others.len(),
            names.join("、")
        ));
    }
    PathProbe::empty_with_source("clientPath", "同花顺客户端路径", &top.path, top.source, &hint)
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
    PathProbe::empty(
        "clientTesseract",
        "Tesseract OCR 路径",
        "",
        "未找到 tesseract.exe（可选）：不装也能用，遇验证码时控制台会弹图由你手动输入；需自动识别请安装 UB-Mannheim/tesseract（github.com/UB-Mannheim/tesseract 下载 Windows 安装包）后点「自动探测」，或手动填写 tesseract.exe 绝对路径",
    )
}

/// 券商路径一键自检：mode = mock / qmt / client；缺省用当前配置模式。
/// python_path / client_path 为前端手填框的即时覆盖值（空串/None 回落已保存配置）。
/// 返回每个路径字段的状态 + 建议值，前端可一键回填。
#[tauri::command]
pub fn broker_probe_paths(
    mgr: State<'_, BrokerManager>,
    mode: Option<String>,
    python_path: Option<String>,
    client_path: Option<String>,
) -> Result<serde_json::Value, String> {
    let cfg = mgr.config.lock().unwrap().clone();
    let mode = mode.unwrap_or_else(|| cfg.kind.clone());
    // 空串与 None 等价：回落已保存配置，让未保存的手填内容即时参与校验
    let eff_python = python_path
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(cfg.python_path.clone());
    let eff_client = client_path
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(cfg.client_path.clone());
    let mut probes = vec![probe_python(&eff_python)];
    match mode.as_str() {
        "qmt" => probes.push(probe_qmt(&cfg.qmt_path)),
        "client" => {
            probes.push(probe_client(&eff_client));
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

/// P12-11 验证码 OCR 引擎管理：探测 / 安装 / 卸载 ddddocr（sidecar 同款 Python 环境）。
/// action: "status"（探测已装版本）/ "install"（pip 安装或升级）/ "uninstall"（pip 卸载）
#[tauri::command]
pub fn broker_ocr_engine(
    action: String,
    mgr: State<'_, BrokerManager>,
) -> Result<serde_json::Value, String> {
    let cfg = mgr.config.lock().unwrap().clone();
    let py = if cfg.python_path.trim().is_empty() {
        let pr = probe_python("");
        // 自动探测成功时路径在 suggested（此时 configured 为空）；探测失败时二者皆空。
        // 只读 configured 会误判「未找到 python」，导致 OCR 检测/安装/卸载全部失效。
        if !pr.suggested.trim().is_empty() {
            pr.suggested
        } else {
            pr.configured
        }
    } else {
        cfg.python_path.clone()
    };
    if py.trim().is_empty() {
        return Err("未找到可用的 python.exe：请先配置 Python 路径".into());
    }
    let run = |args: &[&str]| -> (bool, String) {
        match silent_cmd(&py).args(args).output() {
            Ok(o) => {
                let mut s = String::from_utf8_lossy(&o.stdout).trim().to_string();
                let e = String::from_utf8_lossy(&o.stderr).trim().to_string();
                if !e.is_empty() {
                    if !s.is_empty() {
                        s.push('\n');
                    }
                    s.push_str(&e);
                }
                (o.status.success(), s)
            }
            Err(e) => (false, format!("无法启动 Python：{e}")),
        }
    };
    match action.as_str() {
        "status" => {
            let (ok, out) = run(&["-c", "import importlib.metadata as m;print(m.version('ddddocr'))"]);
            let (version, error) = if ok {
                (out, String::new())
            } else {
                (String::new(), out)
            };
            Ok(serde_json::json!({
                "engine": "ddddocr",
                "installed": ok,
                "version": version,
                "error": error,
                "python": py,
            }))
        }
        "install" => {
            let (ok, out) = run(&["-m", "pip", "install", "-U", "ddddocr"]);
            if ok {
                Ok(serde_json::json!({ "ok": true, "message": "ddddocr 已安装/升级", "detail": out }))
            } else {
                Err(format!("ddddocr 安装失败：{out}"))
            }
        }
        "uninstall" => {
            let (ok, out) = run(&["-m", "pip", "uninstall", "-y", "ddddocr"]);
            if ok {
                Ok(serde_json::json!({ "ok": true, "message": "ddddocr 已卸载", "detail": out }))
            } else {
                Err(format!("ddddocr 卸载失败：{out}"))
            }
        }
        _ => Err(format!("未知动作：{action}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vendor_matches_ths_keywords() {
        assert_eq!(vendor_from_text("同花顺远航版"), Vendor::Ths);
        assert_eq!(vendor_from_text("THS 下单程序"), Vendor::Ths);
        assert_eq!(vendor_from_text(r"C:\hexin\xiadan.exe,0"), Vendor::Ths);
        assert_eq!(vendor_from_text("核桃大师"), Vendor::Ths);
    }

    #[test]
    fn vendor_other_brokers_not_ths() {
        assert_eq!(vendor_from_text("广发证券金融终端"), Vendor::Other);
        assert_eq!(vendor_from_text("银河海王星"), Vendor::Other);
        // ths 作为 months 这类子串不得误判
        assert_eq!(vendor_from_text("months report"), Vendor::Other);
        assert_eq!(vendor_from_text(""), Vendor::Unknown);
    }

    #[test]
    fn rank_clients_puts_ths_first() {
        let other = ClientCandidate {
            path: r"D:\360download\广发\xiadan.exe".into(),
            source: "filesystem",
            vendor: Vendor::Other,
        };
        let ths = ClientCandidate {
            path: r"C:\同花顺\xiadan.exe".into(),
            source: "filesystem",
            vendor: Vendor::Ths,
        };
        let ranked = rank_clients(vec![other, ths]);
        assert_eq!(ranked[0].path, r"C:\同花顺\xiadan.exe");
    }

    #[test]
    fn dedupe_case_insensitive_keeps_first() {
        let a = ClientCandidate { path: r"C:\THS\xiadan.exe".into(), source: "filesystem", vendor: Vendor::Ths };
        let b = ClientCandidate { path: r"c:\ths\xiadan.exe".into(), source: "registry", vendor: Vendor::Ths };
        let out = dedupe_candidates(vec![a, b]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].source, "filesystem");
    }

    #[test]
    fn python_version_range_310_to_312() {
        assert!(is_supported_python_version(3, 10));
        assert!(is_supported_python_version(3, 11));
        assert!(is_supported_python_version(3, 12));
        assert!(!is_supported_python_version(3, 9));
        assert!(!is_supported_python_version(3, 13));
        assert!(!is_supported_python_version(3, 14));
        assert!(!is_supported_python_version(4, 0));
    }

    #[test]
    fn parse_python_version_samples() {
        assert_eq!(parse_python_version("3.11.9"), Some((3, 11)));
        assert_eq!(parse_python_version(" 3.12 "), Some((3, 12)));
        assert_eq!(parse_python_version("garbage"), None);
        assert_eq!(parse_python_version(""), None);
    }

    #[test]
    fn missing_deps_hint_lists_packages_and_range() {
        let h = missing_deps_hint(&["pywinauto", "pyautogui"]);
        assert!(h.contains("pywinauto"));
        assert!(h.contains("pyautogui"));
        assert!(h.contains("3.10–3.12"));
    }

    #[test]
    fn bare_vs_absolute_rule() {
        assert!(is_bare_or_relative("xiadan.exe"));
        assert!(is_bare_or_relative(r"sub\xiadan.exe"));
        assert!(!is_bare_or_relative(r"C:\同花顺\xiadan.exe"));
        assert!(!is_bare_or_relative(r"\\server\share\xiadan.exe"));
        assert!(!is_bare_or_relative(""));
    }

    #[test]
    fn parse_display_icon_variants() {
        assert_eq!(parse_display_icon_path(r#""C:\ths\xiadan.exe",0"#), Some(r"C:\ths\xiadan.exe".into()));
        assert_eq!(parse_display_icon_path(r"C:\ths\xiadan.exe"), Some(r"C:\ths\xiadan.exe".into()));
        assert_eq!(parse_display_icon_path(""), None);
    }

    #[test]
    fn reg_block_parses_fields() {
        let block = "\nHKEY_LOCAL_MACHINE\\SOFTWARE\\THS\n    DisplayName    REG_SZ    同花顺远航版\n    InstallLocation    REG_SZ    C:\\同花顺\n    DisplayIcon    REG_EXPAND_SZ    \"C:\\同花顺\\xiadan.exe\",0\n";
        let (name, loc, icon) = parse_reg_block(block);
        assert_eq!(name.as_deref(), Some("同花顺远航版"));
        assert!(loc.unwrap().ends_with("C:\\同花顺"));
        assert!(icon.unwrap().contains("xiadan.exe"));
    }

    #[test]
    fn scan_python_exe_collects_all_versions_not_just_first() {
        // 模拟本机同时装 Python311 + Python314 的场景：两个都应进入候选。
        // 标准安装都带 Lib\venv（标准库模块），不得因此被跳过；真 venv 用 pyvenv.cfg 识别。
        let tmp = std::env::temp_dir().join(format!("tg_probe_scan_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join("Python311").join("Lib").join("venv")).unwrap();
        std::fs::create_dir_all(tmp.join("Python314")).unwrap();
        std::fs::write(tmp.join("Python311").join("python.exe"), b"").unwrap();
        std::fs::write(tmp.join("Python314").join("python.exe"), b"").unwrap();
        // 真 venv：python.exe 同目录有 pyvenv.cfg，应被跳过
        std::fs::create_dir_all(tmp.join("Python312").join("venvproj")).unwrap();
        std::fs::write(tmp.join("Python312").join("python.exe"), b"").unwrap();
        std::fs::write(tmp.join("Python312").join("pyvenv.cfg"), b"home = x\n").unwrap();
        // 非 Python3 前缀目录应被跳过
        std::fs::create_dir_all(tmp.join("Launcher")).unwrap();

        let got = scan_python_exe(&tmp.to_string_lossy());
        let names: Vec<String> = got
            .iter()
            .map(|p| Path::new(p).parent().unwrap().file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert!(names.contains(&"Python311".to_string()), "标准安装不得因 Lib\\venv 被跳过, got {names:?}");
        assert!(names.contains(&"Python314".to_string()), "应返回全部版本候选, got {names:?}");
        assert!(!names.contains(&"Python312".to_string()), "真 venv（pyvenv.cfg）应跳过, got {names:?}");
        assert!(!names.contains(&"Launcher".to_string()), "非 Python3 前缀应跳过, got {names:?}");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn cmd_text_utf8_output_decodes_without_garbling() {
        // 新系统（代码页 65001）下 reg / powershell 输出为 UTF-8：GBK 硬解码会把中文变乱码
        let utf8_path = "D:\\360download\\同花顺\\xiadan.exe".as_bytes();
        assert_eq!(cmd_text(utf8_path), "D:\\360download\\同花顺\\xiadan.exe");
    }

    #[test]
    fn cmd_text_gbk_output_falls_back() {
        // 旧中文系统输出为 GBK：UTF-8 严格解码失败后应回退 GBK，结果一致
        let gbk_bytes = encoding_rs::GBK.encode(&"D:\\360download\\同花顺\\xiadan.exe").0.into_owned();
        assert_eq!(cmd_text(&gbk_bytes), "D:\\360download\\同花顺\\xiadan.exe");
    }

    #[test]
    fn cmd_text_ascii_both_encodings_agree() {
        assert_eq!(cmd_text(b"ExecutablePath\nC:\\x\\a.exe\n"), "ExecutablePath\nC:\\x\\a.exe\n");
    }

    #[test]
    fn rank_prefers_xiadan_over_hexin_within_same_vendor() {
        let hexin = ClientCandidate {
            path: r"D:\360download\同花顺\hexin.exe".into(),
            source: "registry",
            vendor: Vendor::Ths,
        };
        let xiadan = ClientCandidate {
            path: r"D:\360download\同花顺\xiadan.exe".into(),
            source: "registry",
            vendor: Vendor::Ths,
        };
        let ranked = rank_clients(vec![hexin, xiadan]);
        assert_eq!(ranked[0].path, r"D:\360download\同花顺\xiadan.exe");
        assert_eq!(ranked[0].source, "registry");
    }
}
