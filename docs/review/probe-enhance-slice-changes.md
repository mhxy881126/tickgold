# 券商一键自检 / 探测增强切片改动说明（probe enhance slice）

> 切片日期：2026-10-20　范围：仅 `broker_probe_paths` 本机探测增强（客户端进程/注册表/文件系统/PATH 解析 + Python 依赖/版本校验 + 手填覆盖参数接线）。
> 严格叠加在工作区既有 P0-2 / P0-3 / P0-6 / P0-4 / P0-5 未提交改动之上，未回退、未改写那几切片的代码。
> 未执行任何 git commit / push / tag / add，未改版本三件套（package.json / src-tauri/tauri.conf.json / src-tauri/Cargo.toml），
> 未 kill / 重启 / 触碰运行中的 tauri dev，未引入实盘自动成交，实盘默认关闭不变，本地 API 仍仅 127.0.0.1。
> mock / 模拟 / dry-run / qmt 既有行为零回归；未读取 docs/opensource-autotrade-research.md；代码未写死任何本机绝对路径/版本号。

## 一、改动文件清单（绝对路径）

| 文件 | 改动 |
|---|---|
| `D:\Doubao-pek\股票盯盘系统·灵动岛版\src-tauri\src\broker\probe.rs` | probe_client / probe_python 增强；新增纯逻辑层、进程/注册表/文件系统 I/O 层；`broker_probe_paths` 增加覆盖参数；新增 `#[cfg(test)]` 单测 |
| `D:\Doubao-pek\股票盯盘系统·灵动岛版\src\broker\api.ts` | `PathProbe` 增加 `source`；新增 `ProbeOptions`；`brokerProbePaths(mode?, opts?)` 同步签名 |
| `D:\Doubao-pek\股票盯盘系统·灵动岛版\src\components\SettingsDialog.vue` | 三处 `brokerProbePaths` 调用传入当前输入框 `bForm.pythonPath / bForm.clientPath` |

未新增 crate（Cargo.toml 零改动）；进程/注册表/扫描全部用 `std::process::Command` 调系统自带 `wmic` / `powershell` CIM / `reg query`，失败静默跳过。

## 二、客户端（xiadan.exe）探测顺序与命中来源标注

`probe_client`（probe.rs:673）手填值判定之后，自动探测严格按以下顺序收集候选，再统一排序/去重：

1. **正在运行的进程**（`running_client_process`，probe.rs:499）
   - 先 `wmic process where "name='xiadan.exe' or name='xiadan-plus.exe'" get ExecutablePath`；
   - wmic 缺失/无输出/失败 → 回退 PowerShell CIM `Get-CimInstance Win32_Process -Filter "Name='xiadan.exe' OR Name='xiadan-plus.exe'"`；
   - 命令不存在、无进程、权限不足一律静默跳过，不报错、不中断后续探测。
   - 命中来源标注 `running-process`。
2. **注册表 Uninstall**（`registry_client_candidates`，probe.rs:551）
   - 三个视图一次性 `reg query /s`：`HKLM\SOFTWARE\...\Uninstall`（64 位）、`HKLM\SOFTWARE\WOW6432Node\...\Uninstall`（32 位）、`HKCU\SOFTWARE\...\Uninstall`；
   - 按空行分块，纯函数 `parse_reg_block`（probe.rs:202）解析 `DisplayName / InstallLocation / DisplayIcon`；
   - 仅保留同花顺系（DisplayName/DisplayIcon 命中关键词），DisplayIcon 取 exe（`"C:\a\b.exe",0` 剥序号，纯函数 `parse_display_icon_path` probe.rs:187），InstallLocation 拼 `xiadan.exe` 复核存在性。
   - 命中来源标注 `registry`。
3. **文件系统有界深度补扫**（`scan_fs_clients`，probe.rs:634；递归 `walk_find_xiadan` probe.rs:607）
   - 根：`C:\Program Files`、`C:\Program Files (x86)`、`D:\Program Files`、`D:\Program Files (x86)`（存在才扫）；用户 `%USERPROFILE%\Downloads / 360download / 下载 / Desktop`；常见同花顺/模拟炒股目录（C/D 盘 `同花顺`、`ths`、`同花顺模拟炒股`，存在才扫）；
   - 深度上限 3 层，剪枝 `windows / system32 / $recycle.bin / node_modules / .git / appdata / programdata / perflogs / recovery / documents and settings`，避免全盘递归。
   - 命中来源标注 `filesystem`。
4. **PATH 兜底**：`find_in_path("xiadan.exe")`（复用既有），来源标注 `path`。

### 排序与多券商标注（纯逻辑 `rank_clients` probe.rs:135 / `dedupe_candidates` probe.rs:145）

- 厂商分类纯函数 `vendor_from_text`（probe.rs:108）：关键词 `同花顺` / `核桃` / `hexin` / 独立词 `ths`（ASCII 按非字母数字切词，避免 months 之类子串误判）→ `Ths`；其他券商 → `Other`；空 → `Unknown`。
- 排序：Ths(0) → Unknown(1) → Other(2)，**同花顺优先**；路径大小写不敏感去重、保留首次出现。
- 首选建议值取排序第一；其余非同花顺候选在 hint 罗列（最多 3 个文件名）：「另检测到 N 个其他券商/非同花顺下单程序（…），请注意核对勿选错」；首选本身非同花顺时也在 hint 提示「看起来不是同花顺（其他券商/非同花顺，注意核对）」。

### 手填裸名 / 相对路径解析（`resolve_bare_or_relative` probe.rs:482 + 纯规则 `is_bare_or_relative` probe.rs:174）

- 无盘符、非 UNC 视为裸名/相对路径：裸名先在 PATH（复用 `find_in_path`）解析，再用当前目录拼接复核；
- 解析成功 → ok（来源 `path`，提示核对是否同花顺）；仍无效 → missing，提示填完整绝对路径或留空自动探测；
- 绝对路径存在即 ok，并按厂商分类给差异化 hint（非同花顺显式标注注意核对）。

## 三、Python 解释器依赖 / 版本判定逻辑

`inspect_python`（probe.rs:323，I/O 层）对每个候选：可运行性（沿用 `python_runnable`）+ 取 `major.minor` 版本 + 逐个 `import pywinauto / pyautogui / PIL` 探测缺哪个；版本/兼容判定全部走纯函数。

- **纯函数**：`parse_python_version`（probe.rs:152，解析 `3.11.9 / 3.12`）、`is_supported_python_version`（probe.rs:161，**3.10 <= v <= 3.12**）、`missing_deps_hint`（probe.rs:166，缺依赖排除文案，列出缺哪些包 + 安装命令）。
- **手填值即时体检**（probe_python probe.rs:349）：
  1. 路径不存在 → missing；
  2. 无法运行（失效 venv/坏安装）→ missing（原文案保留）；
  3. 缺依赖 → missing + `missing_deps_hint` 明确排除、不建议；
  4. 依赖齐全但版本不在 3.10–3.12 → ok 但 hint 提示更换（不阻断）；
  5. 齐全且版本兼容 → ok。
- **自动候选**（py 启动器 3.12/3.11/3.10 → `%LOCALAPPDATA%\Programs\Python` → `C:\` Python3* → PATH，顺序保留去重）：仅「可运行 + 依赖齐全 + 版本兼容」进入 preferred；其余逐条进 `excluded` 并在 hint 写明排除原因（无法运行/缺哪些包/版本号不在区间），首选取第一个 preferred；全被排除 → missing 并罗列本机已排除候选。

## 四、覆盖参数与前端接线

### Rust 命令 `broker_probe_paths`（probe.rs:775）

- 新增可选参数 `python_path: Option<String>`、`client_path: Option<String>`；
- **空串与 None 等价**：`.filter(|s| !s.trim().is_empty()).unwrap_or(已保存配置)`，未保存的手填内容即时参与校验，未填则回落已保存配置；
- qmt 模式仍只探 qmtPath（沿用原逻辑）；client 模式探 clientPath（覆盖值）+ tesseract（不变）；pythonPath 始终探。

### 前端 `src/broker/api.ts`

- `PathProbe` 增加可选 `source?: string`（manual / running-process / registry / filesystem / path）；
- 新增 `ProbeOptions { pythonPath?, clientPath? }`；
- `brokerProbePaths(mode?, opts?)`（api.ts:519）invoke 透传 `pythonPath / clientPath`（空 → null 回落）。

### SettingsDialog.vue 三处调用（均传入当前输入框值，badge 状态随本次探测刷新）

| 位置 | 场景 | 改动 |
|---|---|---|
| 1021 | `bRefreshSelfcheck` 未连接先做本机路径自检 | `brokerProbePaths(bForm.value.kind, { pythonPath: bForm.value.pythonPath, clientPath: bForm.value.clientPath })` |
| 1084 | `bProbeRun`「一键自检」 | 同上 |
| 1139 | `bProbeFill(field)` 单字段「探测/自动填入」 | 同上（tesseract 字段调用同样透传，后端按字段取用，无副作用） |

模板（2473 clientPath 输入框、2486 pythonPath 输入框）、badge 样式、`bProbeClass/bProbeText/bProbeHint` 均未改。

## 五、测试结果

### Rust（本机未裸跑 cargo，以 CI 为准；纯逻辑测试已写好并静态核对）

- 本机不执行 `cargo test`：C 依赖（ring/libsqlite3-sys/rquickjs-sys）需 `scripts/dev-tauri.ps1` 加载 MSVC cl.exe/INCLUDE/LIB，且需避开运行中 dev 的 target 锁；故编译/测试以 CI `cargo test` 为准。
- 新增 `#[cfg(test)] mod tests`（probe.rs:875）共 10 个纯逻辑用例，与 I/O 隔离（进程/注册表/扫描不进测试）：
  1. `vendor_matches_ths_keywords`：同花顺 / THS 独立词 / hexin 路径 / 核桃 → Ths；
  2. `vendor_other_brokers_not_ths`：广发/银河 → Other；months 子串不误判；空 → Unknown；
  3. `rank_clients_puts_ths_first`：Other 在前时排序后 Ths 居首；
  4. `dedupe_case_insensitive_keeps_first`：大小写同路径去重、保留首次来源；
  5. `python_version_range_310_to_312`：3.10/3.11/3.12 true，3.9/3.13/3.14/4.0 false；
  6. `parse_python_version_samples`：3.11.9 / 3.12 / garbage / 空；
  7. `missing_deps_hint_lists_packages_and_range`：列出缺包且含 3.10–3.12；
  8. `bare_vs_absolute_rule`：裸名/相对 true，盘符绝对/UNC/空 false；
  9. `parse_display_icon_variants`：带序号引号 / 裸路径 / 空；
  10. `reg_block_parses_fields`：DisplayName/InstallLocation/DisplayIcon 三块解析。

### 前端（本机实跑）

- `npx vue-tsc --noEmit`：退出码 0，无类型错误（build 脚本同款，未跑 vite build，未触碰运行态）。
- `npx vitest run`：**87 个测试文件 / 868 用例全部通过**（含既有各切片用例，零回归；Duration 7.08s）。
- 本切片未抽新的前端纯函数，组件既有 Vitest 基建未新增测试文件，前端改动靠类型检查 + 全量回归 + 代码审查保证。

## 六、仍需真机验证点（单测覆盖不到）

1. **进程枚举在不同机器/权限**：wmic 在新版 Windows 可能被弃用，需确认回退 PowerShell CIM 可取到 `xiadan.exe`/`xiadan-plus.exe` 的 ExecutablePath；非管理员/受权限限制时静默跳过且不报错。
2. **reg query 32 位视图**：WOW6432Node 视图与 HKCU 块解析在真实注册表输出（REG_EXPAND_SZ、值含空格/中文）下能正确取到 DisplayIcon/InstallLocation；GBK 解码下中文 DisplayName 关键词不误伤。
3. **多券商候选标注**：同机存在其他券商 `xiadan.exe`（如其他目录的银河/广发）时，同花顺候选排首，其余在 hint 标注「其他券商/非同花顺，注意核对」，数量与文件名罗列正确。
4. **缺依赖解释器排除**：3.13/3.14/缺 pywinauto/pyautogui 的解释器进入 excluded 并写明缺包，不被推荐；3.10–3.12 依赖齐全者首选。
5. **手填即时校验**：未点保存时直接点「一键自检/探测」，输入框里的 pythonPath/clientPath 立即参与体检并刷新 badge；清空输入框回落已保存配置。
6. 有界深度扫描在大盘盘/多盘机器上耗时可控（不递归 appdata/windows，3 层封顶）。

## 七、边界声明

- 未 commit / push / tag，未改版本号，未碰运行中的 tauri dev，未引入实盘自动成交，实盘默认关闭，本地 API 仅 127.0.0.1。
- 未新增 crate，未改 Cargo.toml；qmt/tesseract/mock/模拟/dry-run 路径逻辑未动；`broker_ocr_engine` 命令未改。
- 工作区其余 P0-2/P0-3/P0-6/P0-4/P0-5 既有未提交改动本切片未触碰、未回退。
