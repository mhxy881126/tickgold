# v1.9.0 慢脑知识库 + 应用内 AI 问数助手 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 TickGold 内落地「慢脑」底座：Ollama/云端双通道可配，Rust 单环 Agent 经只读工具查询本地数据仓 + RAG 语义检索，流式回答并附可点击证据；采集数据自动入向量边车库，支持导入 md/txt 战法文档。

**Architecture:** 新增 Rust 模块 `src-tauri/src/ai/`（provider/agent/tools/vectordb/maindb/ingest/config）。主库 `stock-dock.db` 零迁移，Rust 用 rusqlite 以只读旁路访问；AI 专属表放独立边车库 `ai.db`（Rust 自管 `PRAGMA user_version`）。Agent 循环全部在 Rust（Key 不出 Rust、CSP 不放开外网），经 Tauri events 推流给纯渲染的前端 AI 助手卡。

**Tech Stack:** Rust: rusqlite 0.32（bundled，与锁内 libsqlite3-sys 0.30.1 对齐）、keyring 2.3（系统凭据箱）、tokio-stream 0.1（SSE 流）、现有 reqwest 0.12。前端：Vue 3/TS、`@tauri-apps/api/event` listen、markdown-it（`html:false`）、Vitest。

## Global Constraints

- 主库 `stock-dock.db` **零结构变更**；AI 表全部在 `ai.db`，两库同处 app_data_dir。
- 所有外网请求只从 Rust 发出；Webview CSP 不新增外部域名。
- 时间戳一律毫秒整数；日期 `YYYY-MM-DD`（涨停记录沿用现有格式）。
- 云 Key 仅存系统凭据箱（service=`tickgold.ai.cloud-key`，user=`default`），永不回显、永不入库；测试用独立 service 名（默认走内存假实现）。
- 工具全部只读；入参必须校验（6 位代码、YYYY-MM-DD）；单工具输出 ≤4000 字符，超出显式截断。
- 全部单测不触网（HTTP 用手写 TcpListener mock）；证据/回答保留「不构成投资建议」口径。
- Windows 环境命令前缀：`$env:PATH="$env:USERPROFILE\.cargo\bin;$env:PATH"`；若遇 esbuild Access denied，先 `$env:TEMP="$PWD\.tmp";$env:TMP="$PWD\.tmp"`（仅前端命令需要）。
- 验证命令：前端 `pnpm test`、`pnpm build`；Rust `cargo test --manifest-path src-tauri/Cargo.toml --lib`；整包 `pnpm tauri build --no-bundle`。
- 频繁提交；不碰用户脏文件（`src/styles/stock-chart.css`、`tests/e2e/perf.spec.ts`、`pw.local.ts`、`tests/e2e/probe.spec.ts`）。
- 当前分支 `feature/v1.7-collector`；本批直接在该分支续做（交付时与 v1.8 一并由用户决定合并）。

---

## File Structure

```
src-tauri/Cargo.toml                         修改：加 3 个依赖
src-tauri/src/lib.rs                         修改：mod ai；manage AiState/AbortRegistry；
                                             setup 初始化 ai.db；注册 18 个 ai_* 命令
src-tauri/src/ai/mod.rs                      新建：AiState、常量、fnv1a、now_millis、工具
src-tauri/src/ai/config.rs                   新建：AiConfig、SecretStore trait、内存/keyring 实现
src-tauri/src/ai/vectordb.rs                 新建：ai.db 连接/迁移/分块/会话/索引状态 CRUD/余弦
src-tauri/src/ai/maindb.rs                   新建：主库只读连接
src-tauri/src/ai/provider.rs                 新建：OpenAI 兼容 chat 流式/embeddings/SSE 解析
src-tauri/src/ai/ingest.rs                   新建：md/txt 切块器、fnv 去重、批量嵌入、日度入库
src-tauri/src/ai/tools.rs                    新建：8 个只读工具注册表 + 分发 + FactRef
src-tauri/src/ai/agent.rs                    新建：Agent 循环、中止注册、事件载荷
src/ai/types.ts                              新建：前端 AI 域类型
src/ai/markdown.ts                           新建：html:false 安全 markdown 渲染
src/ai/streamReducer.ts                      新建：事件→消息列表纯函数（零 Tauri 依赖）
src/ai/api.ts                                新建：invoke 封装（18 个）
src/composables/useAiChat.ts                 新建：流式会话状态机（调 streamReducer）
src/composables/useCollector.ts              修改：归因成功后 fire-and-forget ai_index_daily
src/components/AiAssistant.vue               新建：AI 助手卡
src/components/CardContent.vue               修改：aiassistant 分支
src/components/SettingsDialog.vue            修改：新增「AI 大脑」标签页 + 数据中心行
src/lib/cards.ts                             修改：CardId + 元信息
src/lib/dock.ts                              修改：新增「AI 助手」分组
src/lib/layout.ts                            修改：默认尺寸
src/lib/scenes.ts                            修改：review 场景含 AI 卡且仍=72 格
tests/unit/ai-chat.test.ts                   新建：事件拼装/中止/refs
tests/unit/ai-chunker.test.ts                新建：切块规则镜像测试（与 Rust 对齐的关键样例）
tests/unit/scenes.test.ts                    修改：72 格守卫
```

---

### Task 1: AI 模块脚手架与边车库迁移

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/ai/mod.rs`
- Create: `src-tauri/src/ai/vectordb.rs`
- Modify: `src-tauri/src/lib.rs`（mod 声明 + setup 初始化 + manage 状态）

**Interfaces:**
- Produces: `ai::AiState(pub std::path::PathBuf)`（data_dir）；`ai::vectordb::open(path:&std::path::Path) -> Result<AiDb,String>`；`AiDb` 元组结构体 `pub struct AiDb(pub rusqlite::Connection)`；`ai::fnv1a_hex(s:&str)->String`；`ai::now_millis()->i64`。
- 后续任务均以 `AiDb.0` 取连接。

- [ ] **Step 1: 添加依赖**

在 `src-tauri/Cargo.toml` 的 `[dependencies]` 末尾（`tauri-plugin-autostart` 行之后）追加：

```toml
# ===== v1.9 AI 慢脑：边车库 / 系统凭据箱 / SSE 流 =====
rusqlite = { version = "0.32", features = ["bundled"] }
keyring = "2.3"
tokio-stream = "0.1"
```

- [ ] **Step 2: 写失败测试（随实现文件一起建，先跑红）**

创建 `src-tauri/src/ai/mod.rs`：

```rust
// v1.9 慢脑：知识库边车库 + OpenAI 兼容慢脑 + 只读工具 Agent。
pub mod agent;
pub mod config;
pub mod ingest;
pub mod maindb;
pub mod provider;
pub mod tools;
pub mod vectordb;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::collections::HashSet;

/// 全局 AI 状态：app_data_dir（主库与 ai.db 同目录）。
/// Mutex 内部可变性：setup 时写入，命令经 dir() 克隆读取。
#[derive(Default)]
pub struct AiState(Mutex<PathBuf>);

impl AiState {
    pub fn dir(&self) -> PathBuf {
        self.0.lock().unwrap().clone()
    }
}

/// 进行中会话的中止标记集合：sessionId 入集即表示请求中止。
#[derive(Default)]
pub struct AbortRegistry {
    pub flags: Arc<Mutex<HashSet<i64>>>,
}

impl AbortRegistry {
    pub fn abort(&self, session: i64) {
        self.flags.lock().unwrap().insert(session);
    }
    /// 取出并清除中止标记（agent 在循环边界检查）。
    pub fn take_abort(&self, session: i64) -> bool {
        self.flags.lock().unwrap().remove(&session)
    }
    pub fn clear(&self, session: i64) {
        self.flags.lock().unwrap().remove(&session);
    }
}

pub fn now_millis() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// FNV-1a 32-bit，8 位十六进制；与前端 src/kb/hash.ts 同口径。
pub fn fnv1a_hex(s: &str) -> String {
    let mut h: u32 = 0x811c9dc5;
    for b in s.as_bytes() {
        h ^= *b as u32;
        h = h.wrapping_mul(0x01000193);
    }
    format!("{:08x}", h)
}

#[cfg(test)]
mod scaffold_tests {
    use super::*;

    #[test]
    fn fnv_vectors_match_frontend() {
        assert_eq!(fnv1a_hex(""), "811c9dc5");
        assert_eq!(fnv1a_hex("a"), "e40c292c");
    }

    #[tokio::test]
    async fn abort_registry_latch() {
        let r = AbortRegistry::default();
        assert!(!r.take_abort(7));
        r.abort(7);
        assert!(r.take_abort(7));
        assert!(!r.take_abort(7));
    }
}
```

创建 `src-tauri/src/ai/vectordb.rs`（本步只放 open/迁移与表存在性测试；CRUD 在 Task 4 加）：

```rust
// AI 边车库 ai.db：分块/向量/会话/配置/索引游标。Rust 自管 user_version。
use rusqlite::Connection;
use std::path::Path;

pub struct AiDb(pub Connection);

const V1: &str = "
CREATE TABLE IF NOT EXISTS kb_chunk (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  chunk_index INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT NOT NULL UNIQUE,
  model_hash TEXT NOT NULL DEFAULT '',
  dim INTEGER NOT NULL DEFAULT 0,
  embedding BLOB,
  embedded INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kb_chunk_source ON kb_chunk(source_type, source_ref);
";

const V2: &str = "
CREATE TABLE IF NOT EXISTS ai_session (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ai_message (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  tool_calls TEXT NOT NULL DEFAULT '[]',
  refs TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_message_session ON ai_message(session_id, id);
";

const V3: &str = "
CREATE TABLE IF NOT EXISTS ai_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
";

const V4: &str = "
CREATE TABLE IF NOT EXISTS ai_index_state (
  source_type TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  cursor_hash TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (source_type, source_ref)
);
";

/// 打开（不存在则创建）边车库并迁移到最新版本。
pub fn open(path: &Path) -> Result<AiDb, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| e.to_string())?;
    migrate(&conn)?;
    Ok(AiDb(conn))
}

fn migrate(c: &Connection) -> Result<(), String> {
    let mut version: i64 =
        c.query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
    let batches: Vec<(i64, &str)> = vec![(1, V1), (2, V2), (3, V3), (4, V4)];
    for (v, sql) in batches {
        if version < v {
            c.execute_batch(sql).map_err(|e| format!("ai.db migration v{v} failed: {e}"))?;
            c.execute_batch(&format!("PRAGMA user_version = {v}"))
                .map_err(|e| e.to_string())?;
            version = v;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_db(name: &str) -> AiDb {
        let p = std::env::temp_dir().join(format!("tickgold-ai-test-{}-{}.db", name, crate::ai::now_millis()));
        let _ = std::fs::remove_file(&p);
        open(&p).unwrap()
    }

    #[test]
    fn migrate_to_v4_and_idempotent() {
        let db = tmp_db("migrate");
        let v: i64 = db.0.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(v, 4);
        for t in ["kb_chunk", "ai_session", "ai_message", "ai_config", "ai_index_state"] {
            let n: i64 = db
                .0
                .query_row(
                    "SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?1",
                    [t],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(n, 1, "table {t} missing");
        }
        // 二次 open 不报错且不重建（user_version 仍 4）
        let path = std::env::temp_dir();
        let mut found = None;
        for e in std::fs::read_dir(path).unwrap() {
            let p = e.unwrap().path();
            if let Some(n) = p.file_name().and_then(|n| n.to_str()) {
                if n.starts_with("tickgold-ai-test-migrate-") && n.ends_with(".db") {
                    found = Some(p);
                }
            }
        }
        let db2 = open(&found.unwrap()).unwrap();
        let v2: i64 = db2.0.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(v2, 4);
    }
}
```

- [ ] **Step 3: 在 lib.rs 挂载模块与状态**

`src-tauri/src/lib.rs` 顶部 `mod logging;` 之前加：

```rust
mod ai;
```

在 `.manage(BossHidden(Mutex::new(false)))`（约 1070 行）之前加：

```rust
        .manage(ai::AiState::default())
        .manage(ai::AbortRegistry::default())
```

在 `.setup(|app| {` 的开头（`// ===== 主窗口` 注释之前）加入边车库初始化（失败只记日志，不阻断启动）：

```rust
            // ===== v1.9 AI 边车库初始化 + data_dir 状态就位 =====
            {
                let dir = app.path().app_data_dir()?;
                let ai_path = dir.join("ai.db");
                match ai::vectordb::open(&ai_path) {
                    Ok(_db) => log::info!("AI 边车库就绪: {}", ai_path.display()),
                    Err(e) => log::error!("AI 边车库初始化失败（AI 功能不可用）: {e}"),
                }
                *app.state::<ai::AiState>().inner().0.lock().unwrap() = dir;
            }
```

- [ ] **Step 4: 跑测试验证**

Run（PowerShell）：

```powershell
$env:PATH="$env:USERPROFILE\.cargo\bin;$env:PATH"
cargo test --manifest-path src-tauri/Cargo.toml --lib ai::
```

Expected：2 个 ai 测试 PASS（首次会编译 rusqlite bundled，耗时较长属正常）。

- [ ] **Step 5: 提交**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/ai src-tauri/src/lib.rs
git commit -m "feat(ai): AI 模块脚手架与 ai.db 边车库迁移（v1-v4）"
```

---

### Task 2: 模型配置与云 Key 凭据抽象

**Files:**
- Create: `src-tauri/src/ai/config.rs`

**Interfaces:**
- Produces:
  - `AiConfig { provider:String, base_url:String, chat_model:String, embed_model:String, temperature:f32, enable_auto_index:bool }`（serde camelCase：`baseUrl/chatModel/embedModel/enableAutoIndex`）
  - `impl Default for AiConfig`（provider="ollama"，baseUrl="http://127.0.0.1:11434/v1"，chatModel="qwen2.5:7b"，embedModel="nomic-embed-text"，temperature=0.3，auto=true）
  - `trait SecretStore { fn get(&self)->Result<Option<String>,String>; fn set(&self,secret:&str)->Result<(),String>; fn erase(&self)->Result<(),String>; }`
  - `MemSecret(Arc<Mutex<Option<String>>>)`（测试用）
  - `KeyringSecret { service:String, user:String }`（生产，keyring 2.3 阻塞 API；无凭据时 get 返回 Ok(None)）
  - `load_config(c:&Connection)->Result<AiConfig,String>`；`save_config(c:&Connection,cfg:&AiConfig)->Result<(),String>`

- [ ] **Step 1: 写 config.rs（含失败测试先行，测试在文件底部）**

```rust
// 慢脑配置：ai_config 单行 JSON；云 Key 走 SecretStore（生产=系统凭据箱）。
use crate::ai::now_millis;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AiConfig {
    pub provider: String,          // "ollama" | "cloud"
    pub base_url: String,
    pub chat_model: String,
    pub embed_model: String,
    pub temperature: f32,
    pub enable_auto_index: bool,
}

impl Default for AiConfig {
    fn default() -> Self {
        AiConfig {
            provider: "ollama".to_string(),
            base_url: "http://127.0.0.1:11434/v1".to_string(),
            chat_model: "qwen2.5:7b".to_string(),
            embed_model: "nomic-embed-text".to_string(),
            temperature: 0.3,
            enable_auto_index: true,
        }
    }
}

pub fn load_config(c: &Connection) -> Result<AiConfig, String> {
    let row: Option<String> = c
        .query_row("SELECT json FROM ai_config WHERE id=1", [], |r| r.get(0))
        .ok();
    match row {
        Some(json) => serde_json::from_str(&json).map_err(|e| format!("配置解析失败: {e}")),
        None => Ok(AiConfig::default()),
    }
}

pub fn save_config(c: &Connection, cfg: &AiConfig) -> Result<(), String> {
    let json = serde_json::to_string(cfg).map_err(|e| e.to_string())?;
    c.execute(
        "INSERT INTO ai_config(id,json,updated_at) VALUES(1,?1,?2)
         ON CONFLICT(id) DO UPDATE SET json=?1, updated_at=?2",
        rusqlite::params![json, now_millis()],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

pub trait SecretStore: Send + Sync {
    fn get(&self) -> Result<Option<String>, String>;
    fn set(&self, secret: &str) -> Result<(), String>;
    fn erase(&self) -> Result<(), String>;
}

/// 测试用内存凭据。
pub struct MemSecret(pub Arc<Mutex<Option<String>>>);
impl MemSecret {
    pub fn new() -> Self {
        MemSecret(Arc::new(Mutex::new(None)))
    }
}
impl SecretStore for MemSecret {
    fn get(&self) -> Result<Option<String>, String> {
        Ok(self.0.lock().unwrap().clone())
    }
    fn set(&self, secret: &str) -> Result<(), String> {
        *self.0.lock().unwrap() = Some(secret.to_string());
        Ok(())
    }
    fn erase(&self) -> Result<(), String> {
        *self.0.lock().unwrap() = None;
        Ok(())
    }
}

/// 系统凭据箱（Windows 凭据管理器 / macOS Keychain / Linux Secret Service）。
pub struct KeyringSecret {
    pub service: String,
    pub user: String,
}
impl SecretStore for KeyringSecret {
    fn get(&self) -> Result<Option<String>, String> {
        let entry = keyring::Entry::new(&self.service, &self.user).map_err(|e| e.to_string())?;
        match entry.get_password() {
            Ok(s) => Ok(Some(s)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }
    fn set(&self, secret: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(&self.service, &self.user).map_err(|e| e.to_string())?;
        entry.set_password(secret).map_err(|e| e.to_string())
    }
    fn erase(&self) -> Result<(), String> {
        let entry = keyring::Entry::new(&self.service, &self.user).map_err(|e| e.to_string())?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::vectordb::open;

    fn db() -> crate::ai::vectordb::AiDb {
        let p = std::env::temp_dir().join(format!("tickgold-ai-test-cfg-{}.db", now_millis()));
        open(&p).unwrap()
    }

    #[test]
    fn default_config_when_absent() {
        let db = db();
        let cfg = load_config(&db.0).unwrap();
        assert_eq!(cfg.provider, "ollama");
        assert_eq!(cfg.base_url, "http://127.0.0.1:11434/v1");
        assert!(cfg.enable_auto_index);
    }

    #[test]
    fn save_and_reload_roundtrip_camelcase() {
        let db = db();
        let mut cfg = AiConfig::default();
        cfg.provider = "cloud".to_string();
        cfg.base_url = "https://api.deepseek.com/v1".to_string();
        cfg.temperature = 0.1;
        save_config(&db.0, &cfg).unwrap();
        let back = load_config(&db.0).unwrap();
        assert_eq!(back.provider, "cloud");
        assert_eq!(back.base_url, "https://api.deepseek.com/v1");
        // 存储为 camelCase JSON
        let raw: String = db.0.query_row("SELECT json FROM ai_config WHERE id=1", [], |r| r.get(0)).unwrap();
        assert!(raw.contains("baseUrl"));
        assert!(!raw.contains("base_url"));
    }

    #[test]
    fn mem_secret_lifecycle() {
        let s = MemSecret::new();
        assert_eq!(s.get().unwrap(), None);
        s.set("sk-test").unwrap();
        assert_eq!(s.get().unwrap().as_deref(), Some("sk-test"));
        s.erase().unwrap();
        assert_eq!(s.get().unwrap(), None);
    }
}
```

- [ ] **Step 2: 跑测试**

```powershell
$env:PATH="$env:USERPROFILE\.cargo\bin;$env:PATH"
cargo test --manifest-path src-tauri/Cargo.toml --lib ai::config
```

Expected：3 个测试 PASS。

- [ ] **Step 3: 提交**

```bash
git add src-tauri/src/ai/config.rs
git commit -m "feat(ai): 模型配置 JSON 与云 Key 凭据抽象（内存/系统凭据箱）"
```

---

### Task 3: OpenAI 兼容 Provider（SSE 流式 chat + embeddings）

**Files:**
- Create: `src-tauri/src/ai/provider.rs`

**Interfaces:**
- Produces:
  - `struct ChatMsg { pub role:String, pub content:String }`；`ChatMsg::system/user/assistant/tool(role,content)` 构造（直接结构体字面量即可）
  - `struct ToolSpec { pub name:String, pub description:String, pub parameters:serde_json::Value }`
  - `enum StreamEv { Delta(String), ToolFrag { index:i64, id:String, name:String, args:String } }`
  - `struct ToolCall { pub index:i64, pub id:String, pub name:String, pub args:String }`
  - `struct SseState { tools: std::collections::BTreeMap<i64, ToolAcc> }` with `new()`, `feed(&mut self, data_line:&str, on:&mut impl FnMut(StreamEv)) -> Result<(),String>`（data_line 为已去掉 `data:` 前缀的负载），`finish_tools(&self)->Vec<ToolCall>`（按 index 升序）
  - `async fn chat_stream(cfg:&AiConfig, api_key:&Option<String>, msgs:&[ChatMsg], tools:&[ToolSpec], on:&mut impl FnMut(StreamEv)) -> Result<Vec<ToolCall>,String>`（**返回本轮组装好的工具调用**；无工具调用时返回空 Vec 表示终轮）
  - `async fn embed(cfg:&AiConfig, api_key:&Option<String>, texts:&[String]) -> Result<Vec<Vec<f32>>,String>`
  - `async fn list_models(cfg:&AiConfig, api_key:&Option<String>) -> Result<ModelInfo,String>`，`struct ModelInfo { pub latency_ms:i64, pub models:Vec<String> }`
  - `#[async_trait]` **不引入**；trait 用手动 BoxFuture：
    ```rust
    pub trait Embedder: Send + Sync {
        fn embed<'a>(&'a self, texts: Vec<String>) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Vec<Vec<f32>>, String>> + Send + 'a>>;
    }
    pub struct HttpEmbedder { pub cfg: AiConfig, pub api_key: Option<String> }
    ```
    并为 `HttpEmbedder` 实现 Embedder（调 `embed`）。

- [ ] **Step 1: 实现 provider.rs**

```rust
// OpenAI 兼容客户端：/chat/completions 流式 SSE、/embeddings、/models。
// Ollama 与云端各厂均走同一协议；Key 经 Authorization: Bearer（Ollama 忽略）。
use super::config::AiConfig;
use serde::Serialize;
use std::collections::BTreeMap;
use std::future::Future;
use std::pin::Pin;
use std::time::Instant;
use tokio_stream::StreamExt;

pub struct ChatMsg {
    pub role: String,
    pub content: String,
}

#[derive(Serialize)]
struct ToolSchema<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    function: ToolFunction<'a>,
}
#[derive(Serialize)]
struct ToolFunction<'a> {
    name: &'a str,
    description: &'a str,
    parameters: &'a serde_json::Value,
}

pub struct ToolSpec {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}

#[derive(Clone, Debug, PartialEq)]
pub enum StreamEv {
    Delta(String),
    ToolFrag { index: i64, id: String, name: String, args: String },
}

#[derive(Clone, Debug, PartialEq)]
pub struct ToolAcc {
    pub id: String,
    pub name: String,
    pub args: String,
}

pub struct ToolCall {
    pub index: i64,
    pub id: String,
    pub name: String,
    pub args: String,
}

/// 跨 chunk 累积 delta.tool_calls（按 index 拼碎片）。
pub struct SseState {
    tools: BTreeMap<i64, ToolAcc>,
}

impl SseState {
    pub fn new() -> Self {
        SseState { tools: BTreeMap::new() }
    }

    /// 喂入一条 SSE data 负载（不含 "data:" 前缀）。"[DONE]" 与空串直接 Ok。
    pub fn feed(
        &mut self,
        data: &str,
        on: &mut impl FnMut(StreamEv),
    ) -> Result<(), String> {
        let data = data.trim();
        if data.is_empty() || data == "[DONE]" {
            return Ok(());
        }
        let v: serde_json::Value =
            serde_json::from_str(data).map_err(|e| format!("SSE JSON 解析失败: {e}; raw={data}"))?;
        let Some(delta) = v.pointer("/choices/0/delta") else {
            return Ok(()); // 非内容帧（如 role-only 首帧）忽略
        };
        if let Some(content) = delta.get("content").and_then(|x| x.as_str()) {
            if !content.is_empty() {
                on(StreamEv::Delta(content.to_string()));
            }
        }
        if let Some(arr) = delta.get("tool_calls").and_then(|x| x.as_array()) {
            for tc in arr {
                let index = tc.get("index").and_then(|x| x.as_i64()).unwrap_or(0);
                let entry = self.tools.entry(index).or_insert(ToolAcc {
                    id: String::new(),
                    name: String::new(),
                    args: String::new(),
                });
                if let Some(id) = tc.get("id").and_then(|x| x.as_str()) {
                    if !id.is_empty() {
                        entry.id = id.to_string();
                    }
                }
                if let Some(name) = tc.pointer("/function/name").and_then(|x| x.as_str()) {
                    if !name.is_empty() {
                        entry.name = name.to_string();
                    }
                }
                if let Some(frag) = tc.pointer("/function/arguments").and_then(|x| x.as_str()) {
                    entry.args.push_str(frag);
                    on(StreamEv::ToolFrag {
                        index,
                        id: entry.id.clone(),
                        name: entry.name.clone(),
                        args: frag.to_string(),
                    });
                }
            }
        }
        Ok(())
    }

    pub fn finish_tools(&self) -> Vec<ToolCall> {
        self.tools
            .iter()
            .map(|(i, a)| ToolCall {
                index: *i,
                id: a.id.clone(),
                name: a.name.clone(),
                args: a.args.clone(),
            })
            .collect()
    }
}

fn endpoint(cfg: &AiConfig, path: &str) -> String {
    format!("{}{}", cfg.base_url.trim_end_matches('/'), path)
}

fn auth_header(api_key: &Option<String>) -> Option<(&'static str, String)> {
    match api_key {
        Some(k) if !k.trim().is_empty() => Some(("Authorization", format!("Bearer {k}"))),
        _ => None,
    }
}

fn check_status(resp: reqwest::Response) -> Result<reqwest::Response, String> {
    let status = resp.status();
    if status.is_success() {
        Ok(resp)
    } else {
        let code = status.as_u16();
        let hint = match code {
            401 => "鉴权失败（401）：请检查云端 API Key",
            404 => "接口不存在（404）：请检查 base_url 与模型名",
            429 => "请求过多（429）：触发限流，请稍后再试",
            s if s >= 500 => "模型服务端错误（5xx）",
            _ => "HTTP 错误",
        };
        Err(format!("{hint}（{code}）"))
    }
}

/// 流式对话。on 回调实时收到文本增量与工具参数碎片；工具组装用 SseState。
pub async fn chat_stream(
    cfg: &AiConfig,
    api_key: &Option<String>,
    msgs: &[ChatMsg],
    tools: &[ToolSpec],
    on: &mut impl FnMut(StreamEv),
) -> Result<Vec<ToolCall>, String> {
    let messages: Vec<serde_json::Value> = msgs
        .iter()
        .map(|m| serde_json::json!({ "role": m.role, "content": m.content }))
        .collect();
    let tool_schemas: Vec<ToolSchema> = tools
        .iter()
        .map(|t| ToolSchema {
            kind: "function",
            function: ToolFunction {
                name: &t.name,
                description: &t.description,
                parameters: &t.parameters,
            },
        })
        .collect();
    let mut body = serde_json::json!({
        "model": cfg.chat_model,
        "messages": messages,
        "temperature": cfg.temperature,
        "stream": true,
    });
    if !tool_schemas.is_empty() {
        body["tools"] = serde_json::to_value(&tool_schemas).map_err(|e| e.to_string())?;
    }

    let client = reqwest::Client::builder()
        .user_agent("TickGold-AI/1.9")
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = client.post(endpoint(cfg, "/chat/completions")).json(&body);
    if let Some((k, v)) = auth_header(api_key) {
        req = req.header(k, v);
    }
    let resp = tokio::time::timeout(std::time::Duration::from_secs(60), req.send())
        .await
        .map_err(|_| "连接模型超时（60s）：请确认 Ollama 已启动或网络可达".to_string())?
        .map_err(|e| format!("请求模型失败: {e}"))?;
    let resp = check_status(resp)?;

    let mut state = SseState::new();
    let mut buf = String::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| format!("读取模型流失败: {e}"))?;
        buf.push_str(&String::from_utf8_lossy(&bytes));
        while let Some(pos) = buf.find('\n') {
            let line: String = buf.drain(..=pos).collect();
            let line = line.trim();
            if let Some(rest) = line.strip_prefix("data:") {
                state.feed(rest, on)?;
            }
        }
    }
    // 尾部残余
    if let Some(rest) = buf.trim().strip_prefix("data:") {
        state.feed(rest, on)?;
    }
    // 返回本轮组装好的工具调用（空 Vec = 无工具调用 = 终轮）
    Ok(state.finish_tools())
}

pub struct ModelInfo {
    pub latency_ms: i64,
    pub models: Vec<String>,
}

pub async fn list_models(
    cfg: &AiConfig,
    api_key: &Option<String>,
) -> Result<ModelInfo, String> {
    let client = reqwest::Client::new();
    let mut req = client.get(endpoint(cfg, "/models"));
    if let Some((k, v)) = auth_header(api_key) {
        req = req.header(k, v);
    }
    let started = Instant::now();
    let resp = tokio::time::timeout(std::time::Duration::from_secs(10), req.send())
        .await
        .map_err(|_| "连接超时（10s）：请确认 Ollama 已启动（默认 http://127.0.0.1:11434）".to_string())?
        .map_err(|e| format!("请求失败: {e}"))?;
    let resp = check_status(resp)?;
    let v: serde_json::Value = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        resp.json::<serde_json::Value>(),
    )
    .await
    .map_err(|_| "读取响应超时".to_string())?
    .map_err(|e| format!("响应解析失败: {e}"))?;
    let mut models = vec![];
    if let Some(arr) = v.get("data").and_then(|x| x.as_array()) {
        for m in arr {
            if let Some(id) = m.get("id").and_then(|x| x.as_str()) {
                models.push(id.to_string());
            }
        }
    }
    models.sort();
    Ok(ModelInfo {
        latency_ms: started.elapsed().as_millis() as i64,
        models,
    })
}

/// 批量嵌入，返回与入参同序的向量。
pub async fn embed(
    cfg: &AiConfig,
    api_key: &Option<String>,
    texts: &[String],
) -> Result<Vec<Vec<f32>>, String> {
    if texts.is_empty() {
        return Ok(vec![]);
    }
    let client = reqwest::Client::new();
    let body = serde_json::json!({ "model": cfg.embed_model, "input": texts });
    let mut req = client.post(endpoint(cfg, "/embeddings")).json(&body);
    if let Some((k, v)) = auth_header(api_key) {
        req = req.header(k, v);
    }
    let resp = tokio::time::timeout(std::time::Duration::from_secs(30), req.send())
        .await
        .map_err(|_| "嵌入服务超时（30s）".to_string())?
        .map_err(|e| format!("嵌入请求失败: {e}"))?;
    let resp = check_status(resp)?;
    let v: serde_json::Value = resp.json().await.map_err(|e| format!("嵌入响应解析失败: {e}"))?;
    let mut out: Vec<(i64, Vec<f32>)> = vec![];
    let Some(arr) = v.get("data").and_then(|x| x.as_array()) else {
        return Err("嵌入响应缺少 data 字段".to_string());
    };
    for item in arr {
        let index = item.get("index").and_then(|x| x.as_i64()).unwrap_or(0);
        let Some(emb) = item.get("embedding").and_then(|x| x.as_array()) else {
            return Err("嵌入向量字段缺失".to_string());
        };
        let vec: Vec<f32> = emb
            .iter()
            .map(|n| n.as_f64().map(|x| x as f32).unwrap_or(0.0))
            .collect();
        out.push((index, vec));
    }
    out.sort_by_key(|(i, _)| *i);
    Ok(out.into_iter().map(|(_, v)| v).collect())
}

pub trait Embedder: Send + Sync {
    fn embed<'a>(
        &'a self,
        texts: Vec<String>,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<Vec<f32>>, String>> + Send + 'a>>;
}

pub struct HttpEmbedder {
    pub cfg: AiConfig,
    pub api_key: Option<String>,
}
impl Embedder for HttpEmbedder {
    fn embed<'a>(
        &'a self,
        texts: Vec<String>,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<Vec<f32>>, String>> + Send + 'a>> {
        Box::pin(async move { embed(&self.cfg, &self.api_key, &texts).await })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_deltas_accumulate() {
        let mut st = SseState::new();
        let mut got = String::new();
        st.feed(
            r#"{"choices":[{"delta":{"role":"assistant","content":"今日"}}]}"#,
            |e| if let StreamEv::Delta(s) = e { got.push_str(&s) },
        )
        .unwrap();
        st.feed(
            r#"{"choices":[{"delta":{"content":"涨停 72 家"}}]}"#,
            |e| if let StreamEv::Delta(s) = e { got.push_str(&s) },
        )
        .unwrap();
        st.feed("[DONE]", |_| {}).unwrap();
        assert_eq!(got, "今日涨停 72 家");
        assert!(st.finish_tools().is_empty());
    }

    #[test]
    fn tool_call_fragments_assemble_by_index() {
        let mut st = SseState::new();
        let frames = [
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"market_overview","arguments":""}}]}}]}"#,
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"date\":"}}]}}]}"#,
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":" \"2026-09-30\"}"}}]}}]}"#,
        ];
        let mut frags = 0;
        for f in frames {
            st.feed(f, |e| {
                if let StreamEv::ToolFrag { .. } = e {
                    frags += 1;
                }
            })
            .unwrap();
        }
        assert_eq!(frags, 2);
        let calls = st.finish_tools();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].id, "call_1");
        assert_eq!(calls[0].name, "market_overview");
        let args: serde_json::Value = serde_json::from_str(&calls[0].args).unwrap();
        assert_eq!(args["date"], "2026-09-30");
    }

    #[test]
    fn embed_response_decodes_in_input_order() {
        let raw = serde_json::json!({
            "data": [
                {"index":1,"embedding":[0.0,1.0]},
                {"index":0,"embedding":[1.0,0.0]}
            ]
        });
        let mut out: Vec<(i64, Vec<f32>)> = vec![];
        for item in raw["data"].as_array().unwrap() {
            let index = item["index"].as_i64().unwrap();
            let v = item["embedding"].as_array().unwrap().iter()
                .map(|n| n.as_f64().unwrap() as f32).collect();
            out.push((index, v));
        }
        out.sort_by_key(|(i, _)| *i);
        let ordered: Vec<Vec<f32>> = out.into_iter().map(|(_, v)| v).collect();
        assert_eq!(ordered[0], vec![1.0, 0.0]);
        assert_eq!(ordered[1], vec![0.0, 1.0]);
    }

    /// 手写最小 HTTP mock（无外部依赖）：返回固定 SSE 文本，验证端到端流读取。
    #[tokio::test]
    async fn chat_stream_end_to_end_against_mock_http() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let sse = concat!(
            "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"你好\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"，世界\"}}]}\n\n",
            "data: [DONE]\n\n",
        );
        tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut req = vec![0u8; 1024];
            let _ = sock.read(&mut req).await;
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\n\r\n{}",
                sse.len(),
                sse
            );
            sock.write_all(resp.as_bytes()).await.unwrap();
        });
        let cfg = AiConfig {
            provider: "ollama".into(),
            base_url: format!("http://127.0.0.1:{port}/v1"),
            chat_model: "m".into(),
            embed_model: "e".into(),
            temperature: 0.3,
            enable_auto_index: true,
        };
        let mut text = String::new();
        let calls = chat_stream(&cfg, &None, &[], &[], |e| {
            if let StreamEv::Delta(s) = e {
                text.push_str(&s);
            }
        })
        .await
        .unwrap();
        assert_eq!(text, "你好，世界");
        // 纯文本流返回空工具集
        assert!(calls.is_empty());
    }
}
```

- [ ] **Step 2: 跑测试**

```powershell
$env:PATH="$env:USERPROFILE\.cargo\bin;$env:PATH"
cargo test --manifest-path src-tauri/Cargo.toml --lib ai::provider
```

Expected：4 个测试 PASS（含 1 个 mock HTTP）。

- [ ] **Step 3: 提交**

```bash
git add src-tauri/src/ai/provider.rs
git commit -m "feat(ai): OpenAI 兼容 provider（SSE 流式 chat/embeddings/models）"
```

---

### Task 4: 边车库 CRUD、向量编码与余弦检索

**Files:**
- Modify: `src-tauri/src/ai/vectordb.rs`（在现有文件追加，不改动迁移块）

**Interfaces:**
- Produces:
  - `fn encode_f32(v:&[f32])->Vec<u8>` / `fn decode_f32(b:&[u8])->Vec<f32>`（小端）
  - `struct NewChunk<'a> { text, source_type, source_ref, title: &'a str, chunk_index:i64, content_hash:&'a str, model_hash:&'a str, embedding:Option<&'a [f32]> }`
  - `fn insert_chunk_ignore(c:&Connection,n:&NewChunk)->Result<bool,String>`（true=新插入；dim 与 embedded 由 embedding 推导）
  - `struct ChunkHit { id:i64, text:String, source_type:String, source_ref:String, title:String, chunk_index:i64, score:f32 }`
  - `fn search(c:&Connection,q:&[f32],k:i64,source_type:Option<&str>)->Result<Vec<ChunkHit>,String>`（仅 embedded=1 且 dim 一致；按余弦降序）
  - `fn delete_by_source_ref(c,source_type:&str,source_ref:&str)->Result<usize,String>`
  - `fn list_sources(c,source_type:&str)->Result<Vec<(String,i64)>,String>`（source_ref, 分块数；手动文档管理用）
  - `struct KbStats { total:i64, embedded:i64, bytes_estimate:i64, by_type:Vec<(String,i64)> }`；`fn stats(c)->Result<KbStats,String>`
  - `struct PendingChunk { id:i64, text:String }`；`fn list_pending(c,limit:i64)->Result<Vec<PendingChunk>,String>`
  - `fn set_embedding(c,id:i64,model_hash:&str,v:&[f32])->Result<(),String>`
  - 会话：`fn create_session(c,title:&str)->Result<i64,String>`；`fn touch_session(c,id:i64,title:&str)->Result<(),String>`；`fn list_sessions(c)->Result<Vec<SessionRow>,String>`；`fn delete_session(c,id:i64)->Result<(),String>`（连带消息）
  - `struct SessionRow { id, title, created_at, last_at }`
  - `struct MsgRow { id:i64, role:String, content:String, tool_calls:String, refs:String, created_at:i64 }`
  - `fn insert_message(c,session:i64,role:&str,content:&str,tool_calls:&str,refs:&str)->Result<i64,String>`；`fn list_messages(c,session:i64,limit:i64)->Result<Vec<MsgRow>,String>`（按 id 升序返回最近 limit 条）
  - 索引游标：`fn get_cursor(c,source_type,source_ref)->Result<Option<String>,String>`；`fn set_cursor(c,source_type,source_ref,cursor_hash)->Result<(),String>`

- [ ] **Step 1: 在 vectordb.rs 的 `#[cfg(test)]` 之前追加实现**

```rust
use serde::Serialize;

#[derive(Serialize)]
pub struct KbStats {
    pub total: i64,
    pub embedded: i64,
    pub bytes_estimate: i64,
    pub by_type: Vec<(String, i64)>,
}

pub fn encode_f32(v: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(v.len() * 4);
    for x in v {
        out.extend_from_slice(&x.to_le_bytes());
    }
    out
}
pub fn decode_f32(b: &[u8]) -> Vec<f32> {
    b.chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

fn cosine(a: &[f32], b: &[f32]) -> f32 {
    let mut dot = 0.0f32;
    let mut na = 0.0f32;
    let mut nb = 0.0f32;
    for i in 0..a.len() {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if na == 0.0 || nb == 0.0 {
        return 0.0;
    }
    dot / (na.sqrt() * nb.sqrt())
}

pub struct NewChunk<'a> {
    pub text: &'a str,
    pub source_type: &'a str,
    pub source_ref: &'a str,
    pub title: &'a str,
    pub chunk_index: i64,
    pub content_hash: &'a str,
    pub model_hash: &'a str,
    pub embedding: Option<&'a [f32]>,
}

pub fn insert_chunk_ignore(c: &Connection, n: &NewChunk) -> Result<bool, String> {
    let (dim, blob, embedded) = match n.embedding {
        Some(v) if !v.is_empty() => (v.len() as i64, Some(encode_f32(v)), 1),
        _ => (0, None, 0),
    };
    let affected = c
        .execute(
            "INSERT OR IGNORE INTO kb_chunk
             (text,source_type,source_ref,title,chunk_index,content_hash,model_hash,dim,embedding,embedded,created_at)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
            rusqlite::params![
                n.text,
                n.source_type,
                n.source_ref,
                n.title,
                n.chunk_index,
                n.content_hash,
                n.model_hash,
                dim,
                blob,
                embedded,
                crate::ai::now_millis()
            ],
        )
        .map_err(|e| e.to_string())?;
    Ok(affected > 0)
}

pub struct ChunkHit {
    pub id: i64,
    pub text: String,
    pub source_type: String,
    pub source_ref: String,
    pub title: String,
    pub chunk_index: i64,
    pub score: f32,
}

/// 暴力余弦 top-k（万级分块毫秒级）；只搜 dim 与查询一致且已嵌入的行。
pub fn search(
    c: &Connection,
    q: &[f32],
    k: i64,
    source_type: Option<&str>,
) -> Result<Vec<ChunkHit>, String> {
    if q.is_empty() {
        return Ok(vec![]);
    }
    let mut sql = String::from(
        "SELECT id,text,source_type,source_ref,title,chunk_index,embedding
         FROM kb_chunk WHERE embedded=1 AND dim=?1",
    );
    if source_type.is_some() {
        sql.push_str(" AND source_type=?2");
    }
    let mut stmt = c.prepare(&sql).map_err(|e| e.to_string())?;
    let mapper = |row: &rusqlite::Row| {
        let blob: Vec<u8> = row.get(6)?;
        Ok((
            ChunkHit {
                id: row.get(0)?,
                text: row.get(1)?,
                source_type: row.get(2)?,
                source_ref: row.get(3)?,
                title: row.get(4)?,
                chunk_index: row.get(5)?,
                score: 0.0,
            },
            blob,
        ))
    };
    let rows: Vec<(ChunkHit, Vec<u8>)> = match source_type {
        Some(t) => stmt
            .query_map(rusqlite::params![q.len() as i64, t], mapper)
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?,
        None => stmt
            .query_map(rusqlite::params![q.len() as i64], mapper)
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?,
    };
    let mut scored: Vec<ChunkHit> = rows
        .into_iter()
        .map(|(mut h, blob)| {
            h.score = cosine(q, &decode_f32(&blob));
            h
        })
        .collect();
    scored.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(k.max(1) as usize);
    Ok(scored)
}

pub fn delete_by_source_ref(
    c: &Connection,
    source_type: &str,
    source_ref: &str,
) -> Result<usize, String> {
    c.execute(
        "DELETE FROM kb_chunk WHERE source_type=?1 AND source_ref=?2",
        rusqlite::params![source_type, source_ref],
    )
    .map_err(|e| e.to_string())
}

pub fn list_sources(
    c: &Connection,
    source_type: &str,
) -> Result<Vec<(String, i64)>, String> {
    let mut stmt = c
        .prepare(
            "SELECT source_ref, count(*) FROM kb_chunk WHERE source_type=?1
             GROUP BY source_ref ORDER BY max(created_at) DESC",
        )
        .map_err(|e| e.to_string())?;
    stmt.query_map(rusqlite::params![source_type], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
    })
    .map_err(|e| e.to_string())?
    .collect::<Result<_, _>>()
    .map_err(|e| e.to_string())
}

pub fn stats(c: &Connection) -> Result<KbStats, String> {
    let total: i64 = c.query_row("SELECT count(*) FROM kb_chunk", [], |r| r.get(0)).unwrap_or(0);
    let embedded: i64 =
        c.query_row("SELECT count(*) FROM kb_chunk WHERE embedded=1", [], |r| r.get(0)).unwrap_or(0);
    let bytes_estimate: i64 = c
        .query_row("SELECT COALESCE(sum(length(embedding)),0) FROM kb_chunk", [], |r| r.get(0))
        .unwrap_or(0);
    let mut stmt = c
        .prepare("SELECT source_type, count(*) FROM kb_chunk GROUP BY source_type")
        .map_err(|e| e.to_string())?;
    let by_type = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    Ok(KbStats { total, embedded, bytes_estimate, by_type })
}

pub struct PendingChunk {
    pub id: i64,
    pub text: String,
}
pub fn list_pending(c: &Connection, limit: i64) -> Result<Vec<PendingChunk>, String> {
    let mut stmt = c
        .prepare("SELECT id,text FROM kb_chunk WHERE embedded=0 ORDER BY id LIMIT ?1")
        .map_err(|e| e.to_string())?;
    stmt.query_map(rusqlite::params![limit], |r| {
        Ok(PendingChunk { id: r.get(0)?, text: r.get(1)? })
    })
    .map_err(|e| e.to_string())?
    .collect::<Result<_, _>>()
    .map_err(|e| e.to_string())
}

pub fn set_embedding(
    c: &Connection,
    id: i64,
    model_hash: &str,
    v: &[f32],
) -> Result<(), String> {
    c.execute(
        "UPDATE kb_chunk SET embedding=?1, dim=?2, model_hash=?3, embedded=1 WHERE id=?4",
        rusqlite::params![encode_f32(v), v.len() as i64, model_hash, id],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

// ===== 会话 / 消息 =====
#[derive(Serialize)]
pub struct SessionRow {
    pub id: i64,
    pub title: String,
    pub created_at: i64,
    pub last_at: i64,
}

pub fn create_session(c: &Connection, title: &str) -> Result<i64, String> {
    let now = crate::ai::now_millis();
    c.execute(
        "INSERT INTO ai_session(title,created_at,last_at) VALUES(?1,?2,?2)",
        rusqlite::params![title, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(c.last_insert_rowid())
}

pub fn touch_session(c: &Connection, id: i64, title: &str) -> Result<(), String> {
    c.execute(
        "UPDATE ai_session SET last_at=?1, title=CASE WHEN title='' THEN ?2 ELSE title END WHERE id=?3",
        rusqlite::params![crate::ai::now_millis(), title, id],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

pub fn list_sessions(c: &Connection) -> Result<Vec<SessionRow>, String> {
    let mut stmt = c
        .prepare("SELECT id,title,created_at,last_at FROM ai_session ORDER BY last_at DESC")
        .map_err(|e| e.to_string())?;
    stmt.query_map([], |r| {
        Ok(SessionRow { id: r.get(0)?, title: r.get(1)?, created_at: r.get(2)?, last_at: r.get(3)? })
    })
    .map_err(|e| e.to_string())?
    .collect::<Result<_, _>>()
    .map_err(|e| e.to_string())
}

pub fn delete_session(c: &Connection, id: i64) -> Result<(), String> {
    c.execute("DELETE FROM ai_message WHERE session_id=?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    c.execute("DELETE FROM ai_session WHERE id=?1", rusqlite::params![id])
        .map(|_| ())
        .map_err(|e| e.to_string())
}

pub struct MsgRow {
    pub id: i64,
    pub role: String,
    pub content: String,
    pub tool_calls: String,
    pub refs: String,
    pub created_at: i64,
}

pub fn insert_message(
    c: &Connection,
    session: i64,
    role: &str,
    content: &str,
    tool_calls: &str,
    refs: &str,
) -> Result<i64, String> {
    let now = crate::ai::now_millis();
    c.execute(
        "INSERT INTO ai_message(session_id,role,content,tool_calls,refs,created_at)
         VALUES(?1,?2,?3,?4,?5,?6)",
        rusqlite::params![session, role, content, tool_calls, refs, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(c.last_insert_rowid())
}

pub fn list_messages(c: &Connection, session: i64, limit: i64) -> Result<Vec<MsgRow>, String> {
    let mut stmt = c
        .prepare(
            "SELECT id,role,content,tool_calls,refs,created_at FROM ai_message
             WHERE session_id=?1 ORDER BY id DESC LIMIT ?2",
        )
        .map_err(|e| e.to_string())?;
    let mut rows: Vec<MsgRow> = stmt
        .query_map(rusqlite::params![session, limit], |r| {
            Ok(MsgRow {
                id: r.get(0)?, role: r.get(1)?, content: r.get(2)?,
                tool_calls: r.get(3)?, refs: r.get(4)?, created_at: r.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    rows.reverse();
    Ok(rows)
}

// ===== 入库游标 =====
pub fn get_cursor(
    c: &Connection,
    source_type: &str,
    source_ref: &str,
) -> Result<Option<String>, String> {
    c.query_row(
        "SELECT cursor_hash FROM ai_index_state WHERE source_type=?1 AND source_ref=?2",
        rusqlite::params![source_type, source_ref],
        |r| r.get(0),
    )
    .ok()
    .transpose()
    .map_err(|e: rusqlite::Error| e.to_string())
}

pub fn set_cursor(
    c: &Connection,
    source_type: &str,
    source_ref: &str,
    cursor_hash: &str,
) -> Result<(), String> {
    c.execute(
        "INSERT INTO ai_index_state(source_type,source_ref,cursor_hash,updated_at)
         VALUES(?1,?2,?3,?4)
         ON CONFLICT(source_type,source_ref) DO UPDATE SET cursor_hash=?3, updated_at=?4",
        rusqlite::params![source_type, source_ref, cursor_hash, crate::ai::now_millis()],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}
```

- [ ] **Step 2: 在 tests 模块追加用例（在现有 `migrate_to_v4_and_idempotent` 之后）**

```rust
    #[test]
    fn chunk_dedupe_and_cosine_ranking() {
        let db = tmp_db("cosine");
        // 二维空间：q=(1,0)；a=(1,0) 最近、b=(0,1) 正交
        let h1 = crate::ai::fnv1a_hex("文档A");
        let h2 = crate::ai::fnv1a_hex("文档B");
        assert!(insert_chunk_ignore(
            &db.0,
            &NewChunk {
                text: "正交文档", source_type: "manual_doc", source_ref: "b.md",
                title: "B", chunk_index: 0, content_hash: &h2,
                model_hash: "m1", embedding: Some(&[0.0, 1.0]),
            }
        )
        .unwrap());
        assert!(insert_chunk_ignore(
            &db.0,
            &NewChunk {
                text: "同向文档", source_type: "manual_doc", source_ref: "a.md",
                title: "A", chunk_index: 0, content_hash: &h1,
                model_hash: "m1", embedding: Some(&[1.0, 0.0]),
            }
        )
        .unwrap());
        // 同 hash 再插：忽略
        assert!(!insert_chunk_ignore(
            &db.0,
            &NewChunk {
                text: "同向文档", source_type: "manual_doc", source_ref: "a.md",
                title: "A", chunk_index: 0, content_hash: &h1,
                model_hash: "m1", embedding: Some(&[1.0, 0.0]),
            }
        )
        .unwrap());

        let hits = search(&db.0, &[1.0, 0.0], 5, Some("manual_doc")).unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].source_ref, "a.md");
        assert!(hits[0].score > 0.99);
        assert!(hits[1].score.abs() < 1e-6);

        // 维度不一致的嵌入必须被过滤
        let h3 = crate::ai::fnv1a_hex("三维文档");
        insert_chunk_ignore(
            &db.0,
            &NewChunk {
                text: "三维", source_type: "catalyst", source_ref: "x", title: "",
                chunk_index: 0, content_hash: &h3, model_hash: "m1",
                embedding: Some(&[1.0, 0.0, 0.0]),
            },
        )
        .unwrap();
        let hits2 = search(&db.0, &[1.0, 0.0], 5, None).unwrap();
        assert_eq!(hits2.len(), 2);
    }

    #[test]
    fn pending_embed_set_and_stats() {
        let db = tmp_db("pending");
        let h = crate::ai::fnv1a_hex("待嵌入");
        insert_chunk_ignore(
            &db.0,
            &NewChunk {
                text: "hello", source_type: "catalyst", source_ref: "cat:1", title: "",
                chunk_index: 0, content_hash: &h, model_hash: "", embedding: None,
            },
        )
        .unwrap();
        let pend = list_pending(&db.0, 10).unwrap();
        assert_eq!(pend.len(), 1);
        set_embedding(&db.0, pend[0].id, "m1", &[0.5, 0.5]).unwrap();
        assert_eq!(list_pending(&db.0, 10).unwrap().len(), 0);
        let st = stats(&db.0).unwrap();
        assert_eq!(st.total, 1);
        assert_eq!(st.embedded, 1);
        assert_eq!(st.bytes_estimate, 8);
    }

    #[test]
    fn sessions_and_messages_cascade_delete() {
        let db = tmp_db("sess");
        let sid = create_session(&db.0, "").unwrap();
        insert_message(&db.0, sid, "user", "你好", "[]", "[]").unwrap();
        insert_message(&db.0, sid, "assistant", "在的", "[]", "[]").unwrap();
        touch_session(&db.0, sid, "你好").unwrap();
        let msgs = list_messages(&db.0, sid, 20).unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].role, "user"); // 升序返回
        let sessions = list_sessions(&db.0).unwrap();
        assert_eq!(sessions[0].title, "你好");
        delete_session(&db.0, sid).unwrap();
        assert_eq!(list_sessions(&db.0).unwrap().len(), 0);
        assert_eq!(list_messages(&db.0, sid, 20).unwrap().len(), 0);
    }

    #[test]
    fn source_listing_and_delete() {
        let db = tmp_db("docs");
        for (i, txt) in ["x", "y"].iter().enumerate() {
            let h = crate::ai::fnv1a_hex(txt);
            insert_chunk_ignore(
                &db.0,
                &NewChunk {
                    text: txt, source_type: "manual_doc", source_ref: "战法.md", title: "战法",
                    chunk_index: i as i64, content_hash: &h, model_hash: "", embedding: None,
                },
            )
            .unwrap();
        }
        let srcs = list_sources(&db.0, "manual_doc").unwrap();
        assert_eq!(srcs, vec![("战法.md".to_string(), 2)]);
        assert_eq!(delete_by_source_ref(&db.0, "manual_doc", "战法.md").unwrap(), 2);
        assert_eq!(stats(&db.0).unwrap().total, 0);
    }
```

- [ ] **Step 3: 跑测试**

```powershell
$env:PATH="$env:USERPROFILE\.cargo\bin;$env:PATH"
cargo test --manifest-path src-tauri/Cargo.toml --lib ai::vectordb
```

Expected：原 1 个 + 新 4 个 = 5 个测试 PASS。

- [ ] **Step 4: 提交**

```bash
git add src-tauri/src/ai/vectordb.rs
git commit -m "feat(ai): 边车库分块/会话/游标 CRUD 与 f32 余弦检索"
```

---

### Task 5: 主库只读旁路与 8 个只读工具

**Files:**
- Create: `src-tauri/src/ai/maindb.rs`
- Create: `src-tauri/src/ai/tools.rs`

**Interfaces:**
- Produces:
  - `maindb::open_readonly(dir:&Path)->Result<Connection,String>`
  - `tools::FactRef { kind:String, card:Option<String>, code:Option<String>, date:Option<String>, url:Option<String>, title:Option<String> }`（Serialize camelCase）
  - `tools::ToolOut { content:String, refs:Vec<FactRef> }`
  - `tools::ToolCtx<'a> { data_dir:&'a Path, embedder:&'a dyn crate::ai::provider::Embedder }`
  - `tools::specs()->Vec<crate::ai::provider::ToolSpec>`（8 个）
  - `tools::dispatch(name:&str,args:serde_json::Value,ctx:&ToolCtx<'_>)->Pin<Box<dyn Future<Output=Result<ToolOut,String>> + Send + '_>>`
  - 工具名：market_overview / list_themes / theme_detail / query_catalysts / stock_profile / list_limit_ups / semantic_search / paper_positions

- [ ] **Step 1: maindb.rs**

```rust
// 主库 stock-dock.db 只读旁路：AI 永不写入主库。
use rusqlite::Connection;
use std::path::{Path, PathBuf};

pub fn main_db_path(dir: &Path) -> PathBuf {
    dir.join("stock-dock.db")
}

pub fn open_readonly(dir: &Path) -> Result<Connection, String> {
    let p = main_db_path(dir);
    if !p.exists() {
        return Err("本地主库尚不存在，请先在应用中初始化行情数据".to_string());
    }
    // FULLMUTEX 保证 Connection: Send（dispatch 的 Future 要求 Send）；
    // WAL 已由应用主连接持有（-wal/-shm 存在），只读可直接打开。
    Connection::open_with_flags(
        &p,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_FULLMUTEX,
    )
    .map_err(|e| format!("只读打开主库失败: {e}"))
}
```

- [ ] **Step 2: tools.rs（实现 + 测试同文件）**

```rust
// 只读工具注册表：8 个工具覆盖市场/题材/催化/个股/语义/持仓。
// 入参手工校验；输出 JSON 文本（喂给模型）+ FactRef（前端证据跳转）。
use crate::ai::maindb::open_readonly;
use crate::ai::provider::{Embedder, ToolSpec};
use crate::ai::vectordb::{self, AiDb};
use serde::Serialize;
use serde_json::json;
use std::future::Future;
use std::path::Path;
use std::pin::Pin;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FactRef {
    pub kind: String, // "card" | "url"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub card: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

impl FactRef {
    pub fn card(card: &str, code: Option<&str>, date: Option<&str>) -> Self {
        FactRef {
            kind: "card".into(),
            card: Some(card.into()),
            code: code.map(String::from),
            date: date.map(String::from),
            url: None,
            title: None,
        }
    }
    pub fn url(url: &str, title: &str) -> Self {
        FactRef {
            kind: "url".into(),
            card: None,
            code: None,
            date: None,
            url: Some(url.into()),
            title: Some(title.into()),
        }
    }
}

pub struct ToolOut {
    pub content: String,
    pub refs: Vec<FactRef>,
}

pub struct ToolCtx<'a> {
    pub data_dir: &'a Path,
    pub embedder: &'a dyn Embedder,
}

const MAX_OUT: usize = 4000;

fn truncate(mut s: String) -> String {
    if s.chars().count() > MAX_OUT {
        let keep: String = s.chars().take(MAX_OUT).collect();
        s = format!("{keep}\n……（结果已截断，请缩小查询条件）");
    }
    s
}

fn valid_code(s: &str) -> bool {
    s.len() == 6 && s.bytes().all(|b| b.is_ascii_digit())
}
fn valid_date(s: &str) -> bool {
    let mut parts = s.split('-');
    let (y, m, d) = match (parts.next(), parts.next(), parts.next(), parts.next()) {
        (Some(y), Some(m), Some(d), None) => (y, m, d),
        _ => return false,
    };
    y.len() == 4
        && m.len() == 2
        && d.len() == 2
        && y.chars().chain(m.chars()).chain(d.chars()).all(|c| c.is_ascii_digit())
}
fn arg_str(v: &serde_json::Value, key: &str) -> Option<String> {
    v.get(key).and_then(|x| x.as_str()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}
fn arg_i64(v: &serde_json::Value, key: &str, d: i64) -> i64 {
    v.get(key).and_then(|x| x.as_i64()).unwrap_or(d)
}

pub fn specs() -> Vec<ToolSpec> {
    vec![
        ToolSpec {
            name: "market_overview".into(),
            description: "查询某交易日（默认最近有数据的交易日）的市场情绪概览：涨停数、炸板数、最高连板、平均连板、首板晋级率。无参数则取最近交易日。".into(),
            parameters: json!({
                "type":"object",
                "properties":{"date":{"type":"string","description":"YYYY-MM-DD"}},
                "additionalProperties":false
            }),
        },
        ToolSpec {
            name: "list_themes".into(),
            description: "列出题材库题材（阶段、级别、活跃日期、在册成分数）。可按生命周期阶段过滤与关键词搜索。".into(),
            parameters: json!({
                "type":"object",
                "properties":{
                    "stage":{"type":"string","enum":["萌芽","发酵","高潮","退潮"]},
                    "q":{"type":"string","description":"题材名关键词"},
                    "limit":{"type":"integer","minimum":1,"maximum":50}
                },
                "additionalProperties":false
            }),
        },
        ToolSpec {
            name: "theme_detail".into(),
            description: "按题材 id 或名称查询题材详情：在册成分股及其龙头角色、最近催化剂。".into(),
            parameters: json!({
                "type":"object",
                "properties":{"themeId":{"type":"integer"},"name":{"type":"string"}},
                "additionalProperties":false
            }),
        },
        ToolSpec {
            name: "query_catalysts".into(),
            description: "查询催化剂/公告/互动易问答：可按股票代码、题材名、关键词、类型、日期区间过滤。".into(),
            parameters: json!({
                "type":"object",
                "properties":{
                    "code":{"type":"string","description":"6 位股票代码"},
                    "theme":{"type":"string"},
                    "keyword":{"type":"string"},
                    "kind":{"type":"string","enum":["policy","industry","company","order","earnings","price","event"]},
                    "from":{"type":"string","description":"YYYY-MM-DD"},
                    "to":{"type":"string","description":"YYYY-MM-DD"},
                    "limit":{"type":"integer","minimum":1,"maximum":30}
                },
                "additionalProperties":false
            }),
        },
        ToolSpec {
            name: "stock_profile".into(),
            description: "查询单只个股的题材档案：行业/概念、在题材中的角色、近期涨停定格、最近催化剂时间线。".into(),
            parameters: json!({
                "type":"object",
                "required":["code"],
                "properties":{"code":{"type":"string","description":"6 位股票代码"}},
                "additionalProperties":false
            }),
        },
        ToolSpec {
            name: "list_limit_ups".into(),
            description: "查询涨停定格记录：可按日期（默认最近交易日）、最低连板数、股票代码过滤。".into(),
            parameters: json!({
                "type":"object",
                "properties":{
                    "date":{"type":"string","description":"YYYY-MM-DD"},
                    "minBoards":{"type":"integer","minimum":1},
                    "code":{"type":"string"},
                    "limit":{"type":"integer","minimum":1,"maximum":50}
                },
                "additionalProperties":false
            }),
        },
        ToolSpec {
            name: "semantic_search".into(),
            description: "在本地知识库（战法文档、催化剂、互动问答、题材资料）中做语义检索，返回最相关的 k 段原文。需要已配置可用的嵌入模型。".into(),
            parameters: json!({
                "type":"object",
                "required":["query"],
                "properties":{
                    "query":{"type":"string"},
                    "topK":{"type":"integer","minimum":1,"maximum":10},
                    "sourceType":{"type":"string","enum":["manual_doc","catalyst","irm","theme","limitup"]}
                },
                "additionalProperties":false
            }),
        },
        ToolSpec {
            name: "paper_positions".into(),
            description: "查询当前模拟盘持仓（代码、名称、持仓量、可用量、成本金额）。无参数。".into(),
            parameters: json!({"type":"object","properties":{},"additionalProperties":false}),
        },
    ]
}

fn latest_date(c: &rusqlite::Connection) -> Result<String, String> {
    c.query_row("SELECT trade_date FROM limit_up_record ORDER BY trade_date DESC LIMIT 1", [], |r| {
        r.get::<_, String>(0)
    })
    .map_err(|_| "暂无涨停定格数据（可能尚未完成过收盘归因）".to_string())
}

fn market_overview(c: &rusqlite::Connection, args: &serde_json::Value) -> Result<ToolOut, String> {
    let date = arg_str(args, "date").unwrap_or_else(|| latest_date(c).unwrap_or_default());
    if date.is_empty() {
        return Ok(ToolOut { content: "暂无涨停定格数据".into(), refs: vec![] });
    }
    if !valid_date(&date) {
        return Err("date 必须为 YYYY-MM-DD".into());
    }
    let total: i64 = c
        .query_row("SELECT count(*) FROM limit_up_record WHERE trade_date=?1", [&date], |r| r.get(0))
        .unwrap_or(0);
    let broken: i64 = c
        .query_row(
            "SELECT count(*) FROM limit_up_record WHERE trade_date=?1 AND broken>0",
            [&date],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let max_boards: i64 = c
        .query_row("SELECT COALESCE(max(boards),0) FROM limit_up_record WHERE trade_date=?1", [&date], |r| r.get(0))
        .unwrap_or(0);
    let avg_boards: f64 = c
        .query_row("SELECT COALESCE(avg(boards),0) FROM limit_up_record WHERE trade_date=?1", [&date], |r| r.get(0))
        .unwrap_or(0.0);
    // 晋级率：今日 boards=2 且昨日 boards=1 的数量 / 昨日首板数量
    let prev: Option<String> = c
        .query_row(
            "SELECT trade_date FROM limit_up_record WHERE trade_date<?1 GROUP BY trade_date ORDER BY trade_date DESC LIMIT 1",
            [&date],
            |r| r.get(0),
        )
        .ok();
    let promotion = if let Some(pd) = prev {
        let y_first: i64 = c
            .query_row("SELECT count(*) FROM limit_up_record WHERE trade_date=?1 AND boards=1", [&pd], |r| r.get(0))
            .unwrap_or(0);
        let promoted: i64 = c
            .query_row(
                "SELECT count(*) FROM limit_up_record t JOIN limit_up_record y
                 ON y.code=t.code AND y.trade_date=?1
                 WHERE t.trade_date=?2 AND t.boards=2 AND y.boards=1",
                rusqlite::params![pd, date],
                |r| r.get(0),
            )
            .unwrap_or(0);
        if y_first > 0 {
            Some(promoted as f64 / y_first as f64)
        } else {
            None
        }
    } else {
        None
    };
    let content = serde_json::to_string_pretty(&json!({
        "date": date,
        "limitUpCount": total,
        "brokenCount": broken,
        "maxBoards": max_boards,
        "avgBoards": ((avg_boards * 100.0).round() / 100.0),
        "firstBoardPromotionRate": promotion.map(|p| ((p * 1000.0).round() / 10.0)),
        "note": "firstBoardPromotionRate 为百分比；null=缺少前一交易日数据"
    }))
    .map_err(|e| e.to_string())?;
    Ok(ToolOut {
        content,
        refs: vec![FactRef::card("limitpool", None, Some(&date))],
    })
}

fn list_themes(c: &rusqlite::Connection, args: &serde_json::Value) -> Result<ToolOut, String> {
    let stage = arg_str(args, "stage");
    let q = arg_str(args, "q");
    let limit = arg_i64(args, "limit", 20).clamp(1, 50);
    let mut sql = String::from(
        "SELECT t.id,t.name,t.level,t.stage,t.last_active_date,
                (SELECT count(*) FROM theme_stock ts WHERE ts.theme_id=t.id AND ts.left_date IS NULL) AS members
         FROM theme t WHERE 1=1",
    );
    // 动态位置参数：只绑定实际出现的占位符（多余命名参数会被 rusqlite 拒绝）
    let mut params: Vec<Box<dyn rusqlite::ToSql>> = vec![];
    if let Some(s) = &stage {
        sql.push_str(" AND t.stage=?");
        params.push(Box::new(s.clone()));
    }
    if let Some(s) = &q {
        sql.push_str(" AND (t.name LIKE ? OR t.aliases LIKE ?)");
        let like = format!("%{s}%");
        params.push(Box::new(like.clone()));
        params.push(Box::new(like));
    }
    sql.push_str(" ORDER BY members DESC, t.last_active_date DESC LIMIT ?");
    params.push(Box::new(limit));
    let mut stmt = c.prepare(&sql).map_err(|e| e.to_string())?;
    let mut rows = stmt
        .query_map(rusqlite::params_from_iter(params.iter()), |r| {
                Ok(json!({
                    "themeId": r.get::<_,i64>(0)?,
                    "name": r.get::<_,String>(1)?,
                    "level": r.get::<_,String>(2)?,
                    "stage": r.get::<_,String>(3)?,
                    "lastActiveDate": r.get::<_,Option<String>>(4)?,
                    "memberCount": r.get::<_,i64>(5)?,
                }))
            },
        )
        .map_err(|e| e.to_string())?;
    let mut items = vec![];
    while let Some(r) = rows.next() {
        items.push(r.map_err(|e| e.to_string())?);
    }
    Ok(ToolOut {
        content: truncate(serde_json::to_string_pretty(&json!({"themes": items})).unwrap()),
        refs: vec![FactRef::card("themelib", None, None)],
    })
}

fn theme_detail(c: &rusqlite::Connection, args: &serde_json::Value) -> Result<ToolOut, String> {
    let id = args.get("themeId").and_then(|x| x.as_i64());
    let name = arg_str(args, "name");
    if id.is_none() && name.is_none() {
        return Err("theme_detail 需要 themeId 或 name".into());
    }
    let theme: Option<(i64, String, String, String, String)> = c
        .query_row(
            "SELECT id,name,level,stage,intro FROM theme WHERE id=?1 OR name=?2",
            rusqlite::params![id.unwrap_or(-1), name.unwrap_or_default()],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .ok();
    let Some((tid, tname, level, stage, intro)) = theme else {
        return Ok(ToolOut { content: json!({"found":false}).to_string(), refs: vec![] });
    };
    let mut members = vec![];
    {
        let mut stmt = c
            .prepare(
                "SELECT code,name,role,role_score FROM theme_stock
                 WHERE theme_id=?1 AND left_date IS NULL ORDER BY role_score DESC",
            )
            .map_err(|e| e.to_string())?;
        let mut rs = stmt
            .query_map(rusqlite::params![tid], |r| {
                Ok(json!({
                    "code": r.get::<_,String>(0)?, "name": r.get::<_,String>(1)?,
                    "role": r.get::<_,String>(2)?, "roleScore": r.get::<_,f64>(3)?,
                }))
            })
            .map_err(|e| e.to_string())?;
        while let Some(r) = rs.next() {
            members.push(r.map_err(|e| e.to_string())?);
        }
    }
    let mut catalysts = vec![];
    {
        let mut stmt = c
            .prepare(
                "SELECT kind,title,direction,published_at FROM catalyst
                 WHERE theme_id=?1 ORDER BY COALESCE(published_at,collected_at) DESC LIMIT 10",
            )
            .map_err(|e| e.to_string())?;
        let mut rs = stmt
            .query_map(rusqlite::params![tid], |r| {
                Ok(json!({
                    "kind": r.get::<_,String>(0)?, "title": r.get::<_,String>(1)?,
                    "direction": r.get::<_,String>(2)?, "publishedAt": r.get::<_,Option<i64>>(3)?,
                }))
            })
            .map_err(|e| e.to_string())?;
        while let Some(r) = rs.next() {
            catalysts.push(r.map_err(|e| e.to_string())?);
        }
    }
    Ok(ToolOut {
        content: truncate(
            serde_json::to_string_pretty(&json!({
                "found": true, "themeId": tid, "name": tname,
                "level": level, "stage": stage, "intro": intro,
                "members": members, "recentCatalysts": catalysts
            }))
            .unwrap(),
        ),
        refs: vec![FactRef::card("themelib", None, None)],
    })
}

fn query_catalysts(c: &rusqlite::Connection, args: &serde_json::Value) -> Result<ToolOut, String> {
    let code = arg_str(args, "code");
    if let Some(cd) = &code {
        if !valid_code(cd) {
            return Err("code 必须为 6 位数字".into());
        }
    }
    for k in ["from", "to"] {
        if let Some(d) = arg_str(args, k) {
            if !valid_date(&d) {
                return Err(format!("{k} 必须为 YYYY-MM-DD"));
            }
        }
    }
    let theme = arg_str(args, "theme");
    let keyword = arg_str(args, "keyword");
    let kind = arg_str(args, "kind");
    let from = arg_str(args, "from");
    let to = arg_str(args, "to");
    let limit = arg_i64(args, "limit", 20).clamp(1, 30);

    let day_ms = |d: &str, end: bool| -> i64 {
        // YYYY-MM-DD → 北京时间毫秒
        let p: Vec<i64> = d.split('-').filter_map(|x| x.parse().ok()).collect();
        if p.len() != 3 { return 0; }
        let days = civil_days(p[0], p[1], p[2]) + if end { 1 } else { 0 };
        (days * 86400 - 8 * 3600) * 1000
    };
    let mut sql = String::from(
        "SELECT c.kind,c.title,c.summary,c.direction,c.code,c.source_url,
                COALESCE(c.published_at,c.collected_at) AS ts, t.name AS theme_name
         FROM catalyst c LEFT JOIN theme t ON t.id=c.theme_id WHERE 1=1",
    );
    // 动态位置参数，顺序与拼接条件一致
    let mut params: Vec<Box<dyn rusqlite::ToSql>> = vec![];
    if let Some(cd) = &code {
        sql.push_str(" AND c.code=?");
        params.push(Box::new(cd.clone()));
    }
    if let Some(th) = &theme {
        sql.push_str(" AND t.name LIKE ?");
        params.push(Box::new(format!("%{th}%")));
    }
    if let Some(kw) = &keyword {
        sql.push_str(" AND (c.title LIKE ? OR c.summary LIKE ?)");
        let like = format!("%{kw}%");
        params.push(Box::new(like.clone()));
        params.push(Box::new(like));
    }
    if let Some(kd) = &kind {
        sql.push_str(" AND c.kind=?");
        params.push(Box::new(kd.clone()));
    }
    if let Some(fd) = &from {
        sql.push_str(" AND ts>=?");
        params.push(Box::new(day_ms(fd, false)));
    }
    if let Some(td) = &to {
        sql.push_str(" AND ts<=?");
        params.push(Box::new(day_ms(td, true)));
    }
    sql.push_str(" ORDER BY ts DESC LIMIT ?");
    params.push(Box::new(limit));

    let mut stmt = c.prepare(&sql).map_err(|e| e.to_string())?;
    let mut rs = stmt
        .query_map(rusqlite::params_from_iter(params.iter()), |r| {
            let url: String = r.get(5).unwrap_or_default();
            Ok((
                json!({
                    "kind": r.get::<_,String>(0)?, "title": r.get::<_,String>(1)?,
                    "summary": r.get::<_,String>(2)?, "direction": r.get::<_,String>(3)?,
                    "code": r.get::<_,Option<String>>(4)?,
                    "publishedAt": r.get::<_,i64>(6)?,
                    "theme": r.get::<_,Option<String>>(7)?,
                    "url": if url.is_empty() { serde_json::Value::Null } else { json!(url) },
                }),
                url,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut items = vec![];
    let mut refs = vec![];
    while let Some(r) = rs.next() {
        let (v, url) = r.map_err(|e| e.to_string())?;
        if !url.is_empty() {
            refs.push(FactRef::url(&url, v["title"].as_str().unwrap_or("原文")));
        }
        items.push(v);
    }
    Ok(ToolOut {
        content: truncate(serde_json::to_string_pretty(&json!({"catalysts": items})).unwrap()),
        refs,
    })
}

/// 公历（年月日）→ 自 1970-01-01 天数（Howard Hinnant）。
fn civil_days(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

fn stock_profile(c: &rusqlite::Connection, args: &serde_json::Value) -> Result<ToolOut, String> {
    let code = arg_str(args, "code").ok_or("stock_profile 需要 code")?;
    if !valid_code(&code) {
        return Err("code 必须为 6 位数字".into());
    }
    let latest: Option<(String, String, i64, i64, String, String)> = c
        .query_row(
            "SELECT trade_date,name,boards,first_seal,industry,concepts FROM limit_up_record
             WHERE code=?1 ORDER BY trade_date DESC LIMIT 1",
            [&code],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
        )
        .ok();
    let mut themes = vec![];
    {
        let mut stmt = c
            .prepare(
                "SELECT t.name,ts.role FROM theme_stock ts JOIN theme t ON t.id=ts.theme_id
                 WHERE ts.code=?1",
            )
            .map_err(|e| e.to_string())?;
        let mut rs = stmt.query_map([&code], |r| {
            Ok(json!({"theme": r.get::<_,String>(0)?, "role": r.get::<_,String>(1)?}))
        }).map_err(|e| e.to_string())?;
        while let Some(r) = rs.next() { themes.push(r.map_err(|e| e.to_string())?); }
    }
    let mut catalysts = vec![];
    {
        let mut stmt = c
            .prepare(
                "SELECT kind,title,direction,COALESCE(published_at,collected_at)
                 FROM catalyst WHERE code=?1 ORDER BY collected_at DESC LIMIT 10",
            )
            .map_err(|e| e.to_string())?;
        let mut rs = stmt.query_map([&code], |r| {
            Ok(json!({
                "kind": r.get::<_,String>(0)?, "title": r.get::<_,String>(1)?,
                "direction": r.get::<_,String>(2)?, "publishedAt": r.get::<_,i64>(3)?,
            }))
        }).map_err(|e| e.to_string())?;
        while let Some(r) = rs.next() { catalysts.push(r.map_err(|e| e.to_string())?); }
    }
    let v = match latest {
        Some((date, name, boards, first_seal, industry, concepts)) => json!({
            "code": code, "name": name,
            "latestLimitUp": {
                "date": date, "boards": boards, "firstSeal": first_seal,
                "industry": industry, "concepts": concepts
            },
            "themes": themes, "recentCatalysts": catalysts
        }),
        None => json!({"code": code, "name": serde_json::Value::Null,
            "note": "本地无该股票涨停定格；以下为题材/催化资料", "themes": themes, "recentCatalysts": catalysts}),
    };
    Ok(ToolOut {
        content: truncate(serde_json::to_string_pretty(&v).unwrap()),
        refs: vec![FactRef::card("chart", Some(&code), None), FactRef::card("f10", Some(&code), None)],
    })
}

fn list_limit_ups(c: &rusqlite::Connection, args: &serde_json::Value) -> Result<ToolOut, String> {
    let mut date = arg_str(args, "date").unwrap_or_else(|| latest_date(c).unwrap_or_default());
    if date.is_empty() {
        return Ok(ToolOut { content: "暂无涨停定格数据".into(), refs: vec![] });
    }
    if !valid_date(&date) {
        return Err("date 必须为 YYYY-MM-DD".into());
    }
    if let Some(cd) = arg_str(args, "code") {
        if !valid_code(&cd) {
            return Err("code 必须为 6 位数字".into());
        }
    }
    let min_boards = arg_i64(args, "minBoards", 1).max(1);
    let limit = arg_i64(args, "limit", 30).clamp(1, 50);
    let code = arg_str(args, "code");
    let mut sql = String::from(
        "SELECT code,name,boards,first_seal,broken,seal_fund,industry,concepts
         FROM limit_up_record WHERE trade_date=:date AND boards>=:mb",
    );
    if code.is_some() {
        sql.push_str(" AND code=:code");
    }
    sql.push_str(" ORDER BY boards DESC, first_seal LIMIT :limit");
    let mut stmt = c.prepare(&sql).map_err(|e| e.to_string())?;
    let mut rs = stmt
        .query_map(
            rusqlite::named_params! {
                ":date": date, ":mb": min_boards, ":limit": limit,
                ":code": code.clone().unwrap_or_default()
            },
            |r| {
                Ok(json!({
                    "code": r.get::<_,String>(0)?, "name": r.get::<_,String>(1)?,
                    "boards": r.get::<_,i64>(2)?, "firstSeal": r.get::<_,Option<i64>>(3)?,
                    "broken": r.get::<_,i64>(4)?, "sealFund": r.get::<_,f64>(5)?,
                    "industry": r.get::<_,String>(6)?, "concepts": r.get::<_,String>(7)?,
                }))
            },
        )
        .map_err(|e| e.to_string())?;
    let mut items = vec![];
    while let Some(r) = rs.next() { items.push(r.map_err(|e| e.to_string())?); }
    Ok(ToolOut {
        content: truncate(serde_json::to_string_pretty(&json!({"date": date, "limitUps": items})).unwrap()),
        refs: vec![FactRef::card("limitpool", None, Some(&date))],
    })
}

async fn semantic_search(
    ctx: &ToolCtx<'_>,
    args: &serde_json::Value,
) -> Result<ToolOut, String> {
    let query = arg_str(args, "query").ok_or("semantic_search 需要 query")?;
    let k = arg_i64(args, "topK", 5).clamp(1, 10);
    let source_type = arg_str(args, "sourceType");
    let vecs = ctx.embedder.embed(vec![query.clone()]).await?;
    let q = vecs.into_iter().next().ok_or("嵌入服务返回空向量")?;
    let ai_path = ctx.data_dir.join("ai.db");
    let db: AiDb = vectordb::open(&ai_path)?;
    let hits = vectordb::search(&db.0, &q, k, source_type.as_deref())?;
    if hits.is_empty() {
        return Ok(ToolOut {
            content: "知识库中没有可匹配的已索引内容（可能尚未完成嵌入）。可提示用户先在设置→AI 大脑导入文档或等待自动入库。".into(),
            refs: vec![],
        });
    }
    let items: Vec<serde_json::Value> = hits
        .iter()
        .map(|h| {
            json!({
                "score": ((h.score * 1000.0).round() / 1000.0),
                "sourceType": h.source_type, "sourceRef": h.source_ref,
                "title": h.title, "chunkIndex": h.chunk_index, "text": h.text
            })
        })
        .collect();
    Ok(ToolOut {
        content: truncate(serde_json::to_string_pretty(&json!({"matches": items})).unwrap()),
        refs: vec![],
    })
}

fn paper_positions(c: &rusqlite::Connection) -> Result<ToolOut, String> {
    let mut stmt = c
        .prepare("SELECT code,name,vol,avail_vol,cost_amount FROM paper_position WHERE vol>0 ORDER BY code")
        .map_err(|e| e.to_string())?;
    let items: Vec<serde_json::Value> = stmt
        .query_map([], |r| {
            Ok(json!({
                "code": r.get::<_,String>(0)?, "name": r.get::<_,String>(1)?,
                "vol": r.get::<_,i64>(2)?, "availVol": r.get::<_,i64>(3)?,
                "costAmount": r.get::<_,f64>(4)?,
            }))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    Ok(ToolOut {
        content: serde_json::to_string_pretty(&json!({"positions": items})).unwrap(),
        refs: vec![FactRef::card("trade", None, None)],
    })
}

pub fn dispatch<'a>(
    name: &'a str,
    args: serde_json::Value,
    ctx: &'a ToolCtx<'a>,
) -> Pin<Box<dyn Future<Output = Result<ToolOut, String>> + Send + 'a>> {
    Box::pin(async move {
        if name == "semantic_search" {
            return semantic_search(ctx, &args).await;
        }
        let c = open_readonly(ctx.data_dir)?;
        match name {
            "market_overview" => market_overview(&c, &args),
            "list_themes" => list_themes(&c, &args),
            "theme_detail" => theme_detail(&c, &args),
            "query_catalysts" => query_catalysts(&c, &args),
            "stock_profile" => stock_profile(&c, &args),
            "list_limit_ups" => list_limit_ups(&c, &args),
            "paper_positions" => paper_positions(&c),
            other => Err(format!("未知工具: {other}")),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::provider::Embedder;
    use std::future::Future;
    use std::pin::Pin;

    /// 固定向量假 Embedder：含「战法」字样返回 (1,0)，否则 (0,1)。
    struct MockEmbedder;
    impl Embedder for MockEmbedder {
        fn embed<'a>(
            &'a self,
            texts: Vec<String>,
        ) -> Pin<Box<dyn Future<Output = Result<Vec<Vec<f32>>, String>> + Send + 'a>> {
            Box::pin(async move {
                Ok(texts
                    .into_iter()
                    .map(|t| if t.contains("战法") { vec![1.0, 0.0] } else { vec![0.0, 1.0] })
                    .collect())
            })
        }
    }

    /// 在 tempdir 构造一个含主库表结构与样例数据的 data_dir。
    fn seeded_dir() -> tempfile_like_dir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("tickgold-ai-tools-{}", crate::ai::now_millis()));
        std::fs::create_dir_all(&dir).unwrap();
        let c = rusqlite::Connection::open(dir.join("stock-dock.db")).unwrap();
        c.execute_batch(
            "CREATE TABLE limit_up_record(trade_date TEXT,code TEXT,name TEXT DEFAULT '',
                boards INTEGER DEFAULT 1,first_seal INTEGER,last_seal INTEGER,seal_fund REAL DEFAULT 0,
                broken INTEGER DEFAULT 0,turnover REAL DEFAULT 0,industry TEXT DEFAULT '',concepts TEXT DEFAULT '');
             CREATE UNIQUE INDEX idx_lu ON limit_up_record(trade_date,code);
             CREATE TABLE theme(id INTEGER PRIMARY KEY,name TEXT UNIQUE,aliases TEXT DEFAULT '',
                level TEXT DEFAULT '分支',stage TEXT DEFAULT '萌芽',intro TEXT DEFAULT '',logic TEXT DEFAULT '',
                logic_version INTEGER DEFAULT 1,first_seen_date TEXT,last_active_date TEXT,
                created_at INTEGER,updated_at INTEGER);
             CREATE TABLE theme_stock(id INTEGER PRIMARY KEY,theme_id INTEGER,code TEXT,name TEXT DEFAULT '',
                role TEXT DEFAULT '跟风',role_score REAL DEFAULT 0,joined_date TEXT,left_date TEXT);
             CREATE TABLE catalyst(id INTEGER PRIMARY KEY,kind TEXT,title TEXT,summary TEXT DEFAULT '',
                source TEXT,source_url TEXT DEFAULT '',published_at INTEGER,direction TEXT DEFAULT '中性',
                theme_id INTEGER,code TEXT,fresh_score REAL DEFAULT 1,content_hash TEXT UNIQUE,collected_at INTEGER);
             CREATE TABLE paper_position(code TEXT PRIMARY KEY,name TEXT DEFAULT '',vol INTEGER DEFAULT 0,
                avail_vol INTEGER DEFAULT 0,cost_amount REAL DEFAULT 0,updated_at INTEGER);",
        )
        .unwrap();
        c.execute(
            "INSERT INTO limit_up_record(trade_date,code,name,boards,first_seal,broken,industry,concepts)
             VALUES('2026-09-29','300001','甲',1,93500,0,'机械','机器人'),
                   ('2026-09-30','300001','甲',2,93100,0,'机械','机器人'),
                   ('2026-09-30','300002','乙',1,94000,1,'电子','芯片')",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO theme(name,stage,last_active_date,created_at,updated_at)
             VALUES('机器人','发酵','2026-09-30',0,0)",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO theme_stock(theme_id,code,name,role,role_score,joined_date)
             VALUES(1,'300001','甲','龙一',90,'2026-09-29')",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO catalyst(kind,title,source,published_at,direction,theme_id,code,content_hash,collected_at)
             VALUES('order','甲公司签订大单','cninfo',1727600000000,'利好',1,'300001','h1',1727600000000)",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO paper_position(code,name,vol,avail_vol,cost_amount,updated_at)
             VALUES('300001','甲',1000,1000,120000,0)",
            [],
        )
        .unwrap();
        dir
    }

    // 占位返回类型辅助：签名仅用 PathBuf
    type tempfile_like_dir = std::path::PathBuf;

    #[tokio::test]
    async fn market_overview_aggregates_and_promotion() {
        let dir = seeded_dir();
        let c = open_readonly(&dir).unwrap();
        let out = market_overview(&c, &json!({"date":"2026-09-30"})).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out.content).unwrap();
        assert_eq!(v["limitUpCount"], 2);
        assert_eq!(v["brokenCount"], 1);
        assert_eq!(v["maxBoards"], 2);
        // 昨日首板 1 只，今日晋级 1 只 → 100%
        assert_eq!(v["firstBoardPromotionRate"], 100.0);
        assert_eq!(out.refs[0].card.as_deref(), Some("limitpool"));
    }

    #[tokio::test]
    async fn theme_detail_and_catalyst_linking() {
        let dir = seeded_dir();
        let c = open_readonly(&dir).unwrap();
        let out = theme_detail(&c, &json!({"name":"机器人"})).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out.content).unwrap();
        assert_eq!(v["stage"], "发酵");
        assert_eq!(v["members"][0]["role"], "龙一");
        assert_eq!(v["recentCatalysts"][0]["title"], "甲公司签订大单");
    }

    #[tokio::test]
    async fn semantic_search_via_mock_embedder() {
        let dir = seeded_dir();
        {
            let db = vectordb::open(&dir.join("ai.db")).unwrap();
            let h = crate::ai::fnv1a_hex("战法文档块");
            vectordb::insert_chunk_ignore(
                &db.0,
                &vectordb::NewChunk {
                    text: "龙头战法要点：只做主线最强。", source_type: "manual_doc",
                    source_ref: "龙头战法.md", title: "龙头战法", chunk_index: 0,
                    content_hash: &h, model_hash: "m1", embedding: Some(&[1.0, 0.0]),
                },
            )
            .unwrap();
        }
        let ctx = ToolCtx { data_dir: &dir, embedder: &MockEmbedder };
        let out = dispatch("semantic_search", json!({"query":"战法怎么用","topK":3}), &ctx).await.unwrap();
        let v: serde_json::Value = serde_json::from_str(&out.content).unwrap();
        assert_eq!(v["matches"][0]["sourceRef"], "龙头战法.md");
    }

    #[tokio::test]
    async fn paper_positions_and_validation() {
        let dir = seeded_dir();
        let c = open_readonly(&dir).unwrap();
        let out = paper_positions(&c).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out.content).unwrap();
        assert_eq!(v["positions"][0]["vol"], 1000);
        assert!(stock_profile(&c, &json!({"code":"12"})).is_err());
        assert!(market_overview(&c, &json!({"date":"2026/09/30"})).is_err());
    }

    #[tokio::test]
    async fn dispatch_unknown_tool_errors() {
        let dir = seeded_dir();
        let ctx = ToolCtx { data_dir: &dir, embedder: &MockEmbedder };
        assert!(dispatch("nope", json!({}), &ctx).await.is_err());
    }
}
```

- [ ] **Step 3: 跑测试**

```powershell
$env:PATH="$env:USERPROFILE\.cargo\bin;$env:PATH"
cargo test --manifest-path src-tauri/Cargo.toml --lib ai::tools
```

Expected：5 个测试 PASS。

- [ ] **Step 4: 提交**

```bash
git add src-tauri/src/ai/maindb.rs src-tauri/src/ai/tools.rs
git commit -m "feat(ai): 主库只读旁路与 8 个只读工具（含 FactRef 证据）"
```

---

### Task 6: Agent 循环（多轮工具、流式事件、中止）

**Files:**
- Create: `src-tauri/src/ai/agent.rs`
- Modify: `src-tauri/src/lib.rs`（仅本任务不改，命令在 Task 7 注册；agent 需可被命令调用，故函数签名先用 AppHandle）

**Interfaces:**
- Produces:
  - 事件（`app.emit`，payload camelCase）：
    - `"ai://token"` → `{sessionId:i64, text:String}`
    - `"ai://tool"` → `{sessionId, callId:String, name:String, args:Value, status:"running"|"ok"|"error", elapsedMs:i64}`
    - `"ai://done"` → `{sessionId, messageId:i64, refs:Vec<FactRef>, aborted:bool}`
    - `"ai://error"` → `{sessionId, message:String}`
  - `async fn run_turn(app:&tauri::AppHandle, data_dir:&Path, registry:&AbortRegistry, cfg:&AiConfig, api_key:Option<String>, session_id:i64, user_text:String)->Result<(),String>`
  - 系统铁律常量 `SYSTEM_PROMPT`（含"只能引用工具数字/必须附证据/不知道就说不知道/内容不构成投资建议"）。
  - 工具循环上限 `const MAX_ROUNDS: usize = 6`。

- [ ] **Step 1: agent.rs**

```rust
// Agent 循环：装配历史 → 流式 chat → 工具调用 → 回灌 → 直到无工具调用或达 6 轮。
use crate::ai::config::AiConfig;
use crate::ai::provider::{self, ChatMsg, Embedder, HttpEmbedder, StreamEv, ToolCall};
use crate::ai::tools::{self, FactRef, ToolCtx};
use crate::ai::vectordb;
use crate::ai::AbortRegistry;
use std::path::Path;
use std::time::Instant;
use tauri::Emitter;

pub const MAX_ROUNDS: usize = 6;

pub const SYSTEM_PROMPT: &str = "\
你是 TickGold 的盘后研究助手「慢脑」，服务 A 股短线交易者。铁律：\
1. 只能引用工具返回的数字与事实，禁止编造行情、公告或题材信息；\
2. 工具没有的数据直接说不知道，并建议用户先完成收盘归因或检查数据中心；\
3. 关键结论后用【证据】标注来源（涨停池/题材库/公告原文等）；\
4. 回答用简洁中文，先结论后要点；涉及日期明确写出；\
5. 不预测涨跌、不给确定性承诺；末尾固定附一句「以上内容不构成投资建议」。";

fn beijing_today() -> String {
    // 复用 market::today_yyyymmdd（YYYYMMDD）转 YYYY-MM-DD
    let c = crate::market::today_yyyymmdd();
    format!("{}-{}-{}", &c[0..4], &c[4..6], &c[6..8])
}

struct TurnAgent<'a> {
    app: &'a tauri::AppHandle,
    cfg: &'a AiConfig,
    api_key: Option<String>,
    embedder: HttpEmbedder,
}

pub async fn run_turn(
    app: &tauri::AppHandle,
    data_dir: &Path,
    registry: &AbortRegistry,
    cfg: &AiConfig,
    api_key: Option<String>,
    session_id: i64,
    user_text: String,
) -> Result<(), String> {
    let ai_path = data_dir.join("ai.db");
    // 1) 持久化用户消息 + 会话标题/时间
    {
        let db = vectordb::open(&ai_path)?;
        vectordb::insert_message(&db.0, session_id, "user", &user_text, "[]", "[]")?;
        let title: String = user_text.chars().take(16).collect();
        vectordb::touch_session(&db.0, session_id, &title)?;
    }
    registry.clear(session_id);

    let agent = TurnAgent {
        app,
        cfg,
        api_key: api_key.clone(),
        embedder: HttpEmbedder { cfg: cfg.clone(), api_key },
    };

    let result = agent.loop_until_done(data_dir, registry, session_id).await;
    match result {
        Ok((text, refs, aborted)) => {
            let db = vectordb::open(&ai_path)?;
            let refs_json = serde_json::to_string(&refs).map_err(|e| e.to_string())?;
            let final_text = if text.trim().is_empty() {
                "已达到工具调用轮数上限，暂未能形成完整结论，请缩小问题范围后重试。".to_string()
            } else {
                text
            };
            let mid = vectordb::insert_message(
                &db.0, session_id, "assistant", &final_text, "[]", &refs_json,
            )?;
            let _ = app.emit(
                "ai://done",
                serde_json::json!({
                    "sessionId": session_id, "messageId": mid,
                    "refs": refs, "aborted": aborted,
                }),
            );
            Ok(())
        }
        Err(e) => {
            let _ = app.emit("ai://error", serde_json::json!({"sessionId": session_id, "message": e}));
            Err(e)
        }
    }
}

impl<'a> TurnAgent<'a> {
    async fn loop_until_done(
        &self,
        data_dir: &Path,
        registry: &AbortRegistry,
        session_id: i64,
    ) -> Result<(String, Vec<FactRef>, bool), String> {
        // 历史：最近 20 条（含工具记录），顺序升序
        let history = {
            let db = vectordb::open(&data_dir.join("ai.db"))?;
            vectordb::list_messages(&db.0, session_id, 20)?
        };
        let mut msgs: Vec<ChatMsg> = Vec::with_capacity(history.len() + 1);
        msgs.push(ChatMsg { role: "system".into(), content: format!("{SYSTEM_PROMPT}\n今天是：{}", beijing_today()) });
        for m in history {
            // tool 记录不回送 API：缺少对应 assistant tool_calls 与 tool_call_id 会报错；
            // 它们仅留库审计，工具得到的信息已由最终 assistant 回答承载
            if m.role == "tool" {
                continue;
            }
            msgs.push(ChatMsg { role: m.role, content: m.content });
        }

        let tool_specs = tools::specs();
        let mut answer = String::new();
        let mut refs_all: Vec<FactRef> = vec![];
        let mut aborted = false;

        for _round in 0..MAX_ROUNDS {
            if registry.take_abort(session_id) {
                aborted = true;
                break;
            }
            let app = self.app;
            let sid = session_id;
            // chat_stream 内部累积工具碎片并返回组装结果；空 Vec=终轮
            let calls: Vec<ToolCall> = provider::chat_stream(
                self.cfg,
                &self.api_key,
                &msgs,
                &tool_specs,
                &mut |ev| {
                    if let StreamEv::Delta(s) = ev {
                        answer.push_str(&s);
                        let _ = app.emit("ai://token", serde_json::json!({"sessionId": sid, "text": s}));
                    }
                },
            )
            .await?;
            if calls.is_empty() {
                break; // 无工具调用 = 终轮回答
            }
            // 工具前的零碎文本丢弃（属于工具调用前的思考，不入库）
            answer.clear();
            let ctx = ToolCtx { data_dir, embedder: &self.embedder };
            for call in calls {
                if registry.take_abort(session_id) {
                    aborted = true;
                    break;
                }
                let call_id = if call.id.is_empty() { format!("call_{}", call.index) } else { call.id.clone() };
                let args: serde_json::Value = serde_json::from_str(&call.args).unwrap_or(serde_json::json!({}));
                let _ = self.app.emit(
                    "ai://tool",
                    serde_json::json!({
                        "sessionId": session_id, "callId": call_id,
                        "name": call.name, "args": args, "status": "running", "elapsedMs": 0,
                    }),
                );
                let started = Instant::now();
                let outcome = tools::dispatch(&call.name, args.clone(), &ctx).await;
                let elapsed = started.elapsed().as_millis() as i64;
                let (status, tool_content) = match outcome {
                    Ok(out) => {
                        for r in &out.refs {
                            if !refs_all.iter().any(|x| x == *r) {
                                refs_all.push(r.clone());
                            }
                        }
                        ("ok", out.content)
                    }
                    Err(e) => ("error", format!("工具执行失败: {e}")),
                };
                let _ = self.app.emit(
                    "ai://tool",
                    serde_json::json!({
                        "sessionId": session_id, "callId": call_id,
                        "name": call.name, "args": args, "status": status, "elapsedMs": elapsed,
                    }),
                );
                msgs.push(ChatMsg {
                    role: "tool".into(),
                    content: format!("[{} 结果]\n{}", call.name, tool_content),
                });
                // 工具消息同步落库（刷新页面后历史可追溯）
                let db = vectordb::open(&data_dir.join("ai.db"))?;
                vectordb::insert_message(
                    &db.0, session_id, "tool",
                    &format!("[{} 结果]\n{}", call.name, tool_content), "[]", "[]",
                )?;
            }
            if aborted {
                break;
            }
        }
        Ok((answer, refs_all, aborted))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_contains_compliance_and_evidence_rules() {
        assert!(SYSTEM_PROMPT.contains("不构成投资建议"));
        assert!(SYSTEM_PROMPT.contains("证据"));
        assert_eq!(MAX_ROUNDS, 6);
    }

    #[test]
    fn beijing_date_format() {
        let d = beijing_today();
        assert_eq!(d.len(), 10);
        assert_eq!(d.as_bytes()[4], b'-');
        assert_eq!(d.as_bytes()[7], b'-');
    }
}
```

- [ ] **Step 2: 为 FactRef 加 PartialEq（agent 去重需要）**

在 `src-tauri/src/ai/tools.rs` 的 `#[derive(Serialize, Clone, Debug)]` 改为：

```rust
#[derive(Serialize, Clone, Debug, PartialEq)]
```

- [ ] **Step 3: 编译与测试**

```powershell
$env:PATH="$env:USERPROFILE\.cargo\bin;$env:PATH"
cargo test --manifest-path src-tauri/Cargo.toml --lib ai::agent
```

Expected：2 个测试 PASS（循环端到端由 Task 7 的 mock 命令测试覆盖——agent 依赖 AppHandle，命令层测试用 mock server 在 Task 7 Step 中给出）。

- [ ] **Step 4: 提交**

```bash
git add src-tauri/src/ai/agent.rs src-tauri/src/ai/tools.rs
git commit -m "feat(ai): Agent 多轮工具循环（6 轮上限/流式事件/中止/证据聚合）"
```

---

### Task 7: Tauri 命令、日度自动入库与连接测试

**Files:**
- Create: `src-tauri/src/ai/ingest.rs`
- Modify: `src-tauri/src/lib.rs`（14 个命令 + invoke_handler 注册）
- Modify: `src/composables/useCollector.ts`（归因成功钩子）

**Interfaces:**
- Rust 命令（参数名 camelCase 由 Tauri 自动映射，Rust 侧用 snake_case 形参）：
  - `ai_get_config() -> AiConfig`；`ai_save_config(cfg: AiConfig) -> ()`
  - `ai_get_cloud_key_set() -> bool`；`ai_set_cloud_key(secret:String) -> ()`；`ai_clear_cloud_key() -> ()`
  - `ai_test_connection() -> ModelInfo JSON`（camelCase：`{latencyMs, models}`）
  - `ai_new_session() -> i64`；`ai_list_sessions() -> Vec<SessionRow>`；`ai_load_session(session_id:i64) -> Vec<MsgRow>`；`ai_delete_session(session_id:i64) -> ()`
  - `ai_chat_send(session_id:i64, text:String) -> ()`（spawn 后台跑 run_turn）
  - `ai_chat_abort(session_id:i64) -> ()`
  - `ai_kb_stats() -> KbStats`
  - `ai_list_docs() -> Vec<(String,i64)>`（已导入手动文档：文件名+分块数）
  - `ai_import_docs() -> Vec<String>`（rfd 多选 md/txt；返回入库的文件名）
  - `ai_delete_doc(file_name:String) -> usize`
  - `ai_reindex() -> usize`（对所有 embedded=0 分块批量补嵌；返回补嵌条数）
  - `ai_index_daily(trade_date:String) -> usize`（返回新增分块数）
- ingest.rs 产出：
  - `split_markdown(text:&str)->Vec<String>`、`split_plain(text:&str)->Vec<String>`（目标 400 字符、重叠 50；围栏代码块整块不拆）
  - `struct IngestReport { inserted: usize }`
  - `async fn index_day(dir:&Path,cfg:&AiConfig,embedder:&dyn Embedder,trade_date:&str,app:Option<&tauri::AppHandle>)->Result<usize,String>`
  - `async fn embed_pending(dir:&Path,cfg:&AiConfig,embedder:&dyn Embedder,app:Option<&tauri::AppHandle>,limit:usize)->Result<usize,String>`

- [ ] **Step 1: ingest.rs（切块器 + 日度入库 + 补嵌，含测试）**

```rust
// 知识库入库：采集记录渲染为中文文本块 → FNV 去重 → 批量嵌入（≤32/批）。
use crate::ai::config::AiConfig;
use crate::ai::provider::Embedder;
use crate::ai::vectordb::{self, NewChunk};
use crate::ai::fnv1a_hex;
use std::path::Path;
use tauri::Emitter;

pub const TARGET_CHARS: usize = 400;
pub const OVERLAP_CHARS: usize = 50;
pub const EMBED_BATCH: usize = 32;

/// Markdown 切块：围栏代码块整块保留；标题/段落聚合成块；尾块与下一块重叠 50 字符。
pub fn split_markdown(text: &str) -> Vec<String> {
    let mut blocks: Vec<String> = Vec::new();
    let lines: Vec<&str> = text.lines().collect();
    let mut i = 0;
    let mut prose = String::new();
    while i < lines.len() {
        let line = lines[i];
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") {
            if !prose.trim().is_empty() {
                blocks.push(std::mem::take(&mut prose));
            }
            let mut fence = String::from(line);
            fence.push('\n');
            i += 1;
            while i < lines.len() && !lines[i].trim_start().starts_with("```") {
                fence.push_str(lines[i]);
                fence.push('\n');
                i += 1;
            }
            if i < lines.len() {
                fence.push_str(lines[i]); // 收尾围栏
                i += 1;
            }
            blocks.push(fence.trim_end().to_string());
        } else {
            if trimmed.starts_with('#') && !prose.trim().is_empty() {
                blocks.push(std::mem::take(&mut prose));
            }
            prose.push_str(line);
            prose.push('\n');
            i += 1;
        }
    }
    if !prose.trim().is_empty() {
        blocks.push(prose.trim().to_string());
    }
    pack_blocks(blocks)
}

pub fn split_plain(text: &str) -> Vec<String> {
    let paras: Vec<String> = text
        .split("\n\n")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    pack_blocks(paras)
}

/// 把段落块打包到约 TARGET_CHARS；超长单块硬切并保留 OVERLAP_CHARS 重叠。
fn pack_blocks(blocks: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    let mut cur = String::new();
    for b in blocks {
        if b.chars().count() > TARGET_CHARS {
            if !cur.trim().is_empty() {
                out.push(std::mem::take(&mut cur));
            }
            let hard = hard_split(&b);
            out.extend(hard);
            continue;
        }
        if cur.chars().count() + b.chars().count() + 1 > TARGET_CHARS && !cur.is_empty() {
            out.push(std::mem::take(&mut cur));
        }
        if !cur.is_empty() {
            cur.push('\n');
        }
        cur.push_str(&b);
    }
    if !cur.trim().is_empty() {
        out.push(cur);
    }
    out.into_iter().filter(|s| !s.trim().is_empty()).collect()
}

fn hard_split(s: &str) -> Vec<String> {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= TARGET_CHARS {
        return vec![s.to_string()];
    }
    let mut out = vec![];
    let mut start = 0usize;
    while start < chars.len() {
        let end = (start + TARGET_CHARS).min(chars.len());
        out.push(chars[start..end].iter().collect::<String>());
        if end == chars.len() {
            break;
        }
        start = end.saturating_sub(OVERLAP_CHARS);
    }
    out
}

/// 对未嵌入分块批量补嵌；返回成功补嵌条数。
pub async fn embed_pending(
    dir: &Path,
    cfg: &AiConfig,
    embedder: &dyn Embedder,
    app: Option<&tauri::AppHandle>,
    limit: usize,
) -> Result<usize, String> {
    let model_hash = format!("{}:{}", cfg.provider, cfg.embed_model);
    let pending = {
        let db = vectordb::open(&dir.join("ai.db"))?;
        vectordb::list_pending(&db.0, limit as i64)?
    };
    let mut done = 0usize;
    for batch in pending.chunks(EMBED_BATCH) {
        let texts: Vec<String> = batch.iter().map(|p| p.text.clone()).collect();
        let vecs = match embedder.embed(texts).await {
            Ok(v) => v,
            Err(e) => {
                // 嵌入不可用：保留 embedded=0，下次补嵌；不阻断
                if let Some(a) = app {
                    let _ = a.emit(
                        "ai://index_progress",
                        serde_json::json!({"phase":"embed","done":done,"total":pending.len(),"error":e}),
                    );
                }
                return Ok(done);
            }
        };
        let db = vectordb::open(&dir.join("ai.db"))?;
        for (p, v) in batch.iter().zip(vecs.into_iter()) {
            vectordb::set_embedding(&db.0, p.id, &model_hash, &v)?;
            done += 1;
        }
        if let Some(a) = app {
            let _ = a.emit(
                "ai://index_progress",
                serde_json::json!({"phase":"embed","done":done,"total":pending.len()}),
            );
        }
    }
    Ok(done)
}

/// 日度增量入库：新增催化剂、在册题材、指定日涨停定格（去重在 Rust 侧完成）。

```rust
pub async fn index_day(
    dir: &Path,
    cfg: &AiConfig,
    embedder: &dyn Embedder,
    trade_date: &str,
    app: Option<&tauri::AppHandle>,
) -> Result<usize, String> {
    let main = crate::ai::maindb::open_readonly(dir)?;

    // 候选：新增催化剂（最近 500）+ 在册题材 + 指定日涨停定格
    let mut candidates: Vec<(String, String, String, String, String)> = vec![];
    {
        let mut st = main
            .prepare(
                "SELECT 'cat:'||id, title, COALESCE(summary,title), content_hash, 'catalyst'
                 FROM catalyst ORDER BY id DESC LIMIT 500",
            )
            .map_err(|e| e.to_string())?;
        let rs = st
            .query_map([], |r| {
                Ok((r.get::<_,String>(0)?, r.get::<_,String>(1)?, r.get::<_,String>(2)?,
                    r.get::<_,String>(3)?, r.get::<_,String>(4)?))
            })
            .map_err(|e| e.to_string())?;
        for r in rs { candidates.push(r.map_err(|e| e.to_string())?); }
    }
    {
        let mut st = main
            .prepare(
                "SELECT 'theme:'||id, name, COALESCE(NULLIF(logic,''), NULLIF(intro,''), name),
                        'theme:'||id||'#'||COALESCE(logic_version,1), 'theme'
                 FROM theme",
            )
            .map_err(|e| e.to_string())?;
        let rs = st
            .query_map([], |r| {
                Ok((r.get::<_,String>(0)?, r.get::<_,String>(1)?, r.get::<_,String>(2)?,
                    r.get::<_,String>(3)?, r.get::<_,String>(4)?))
            })
            .map_err(|e| e.to_string())?;
        for r in rs { candidates.push(r.map_err(|e| e.to_string())?); }
    }
    {
        let mut st = main
            .prepare(
                "SELECT 'lu:'||trade_date||':'||code,
                        name||' '||boards||'连板',
                        '日期 '||trade_date||'；'||name||'('||code||') '||boards||' 连板，'
                        ||'首次封板 '||COALESCE(first_seal,0)||'，炸板 '||broken||' 次，'
                        ||'行业 '||industry||'；概念 '||concepts,
                        trade_date||':'||code||':'||COALESCE(boards,1)||':'||COALESCE(first_seal,0),
                        'limitup'
                 FROM limit_up_record WHERE trade_date=?1",
            )
            .map_err(|e| e.to_string())?;
        let rs = st
            .query_map(rusqlite::params![trade_date], |r| {
                Ok((r.get::<_,String>(0)?, r.get::<_,String>(1)?, r.get::<_,String>(2)?,
                    r.get::<_,String>(3)?, r.get::<_,String>(4)?))
            })
            .map_err(|e| e.to_string())?;
        for r in rs { candidates.push(r.map_err(|e| e.to_string())?); }
    }
    drop(main);

    let db = vectordb::open(&dir.join("ai.db"))?;
    let mut inserted = 0usize;
    for (source_ref, title, body, dedupe_basis, source_type) in candidates {
        let text = if source_type == "catalyst" || source_type == "limitup" {
            body.clone()
        } else {
            body.clone() // theme body 已是自然语言
        };
        let hash = fnv1a_hex(&format!("{source_type}:{source_ref}:{dedupe_basis}"));
        let is_new = vectordb::insert_chunk_ignore(
            &db.0,
            &NewChunk {
                text: &text,
                source_type: &source_type,
                source_ref: &source_ref,
                title: &title,
                chunk_index: 0,
                content_hash: &hash,
                model_hash: "",
                embedding: None,
            },
        )?;
        if is_new {
            inserted += 1;
        }
    }
    drop(db);

    if let Some(a) = app {
        let _ = a.emit(
            "ai://index_progress",
            serde_json::json!({"phase":"collect","done":inserted,"total":inserted}),
        );
    }
    if cfg.enable_auto_index {
        let _ = Box::pin(embed_pending(dir, cfg, embedder, app, 500)).await?;
    }
    Ok(inserted)
}

/// 导入一篇文档文本（调用方负责选文件/读文件）；返回新增分块数。
pub fn ingest_document(
    dir: &Path,
    file_name: &str,
    content: &str,
    markdown: bool,
) -> Result<usize, String> {
    let chunks = if markdown { split_markdown(content) } else { split_plain(content) };
    let db = vectordb::open(&dir.join("ai.db"))?;
    let mut n = 0;
    for (i, ch) in chunks.iter().enumerate() {
        let hash = fnv1a_hex(&format!("manual_doc:{file_name}:{i}:{}", ch.chars().take(64).collect::<String>()));
        let new = vectordb::insert_chunk_ignore(
            &db.0,
            &NewChunk {
                text: ch,
                source_type: "manual_doc",
                source_ref: file_name,
                title: file_name,
                chunk_index: i as i64,
                content_hash: &hash,
                model_hash: "",
                embedding: None,
            },
        )?;
        if new {
            n += 1;
        }
    }
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_keeps_code_fence_whole() {
        let md = "# 标题\n\n这是一段普通文字，介绍龙头战法的基本要点，".to_string()
            + &"字".repeat(300)
            + "\n\n```rust\nfn main() {\n    println!(\"code\");\n}\n```\n\n尾段。";
        let chunks = split_markdown(&md);
        assert!(chunks.len() >= 2);
        // 代码块完整落在某一个块中
        assert!(chunks.iter().any(|c| c.contains("```rust") && c.contains("fn main()") && c.contains("```")));
    }

    #[test]
    fn hard_split_overlaps_50_chars() {
        let s: String = "字".repeat(450);
        let chunks = hard_split(&s);
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].chars().count(), 400);
        // 第二块 = 末 50 + 后 50 = 100 字
        assert_eq!(chunks[1].chars().count(), 100);
    }

    #[test]
    fn plain_packs_paragraphs() {
        let p1 = "短段一".to_string();
        let p2 = "短段二".to_string();
        let chunks = split_plain(&format!("{p1}\n\n{p2}\n\n  \n\n"));
        assert_eq!(chunks, vec![format!("{p1}\n{p2}")]);
    }

    #[test]
    fn headings_split_sections() {
        let md = "# 一\n内容甲\n# 二\n内容乙";
        let chunks = split_markdown(md);
        assert!(chunks.iter().any(|c| c.contains("内容甲") && c.contains("# 一")));
        assert!(chunks.iter().any(|c| c.contains("内容乙")));
    }
}
```

注意：上述 `use tauri::Emitter;` 是 `AppHandle::emit` 在 Tauri 2 中必需的 trait 导入；以 `cargo test` 零警告为准，不留死导入。

- [ ] **Step 2: 在 lib.rs 实现命令**

在 `get_irm_latest` 命令之后（约 172 行后）插入以下命令块（`use` 引用在函数体内全限定，避免修改顶部 use 区）：

```rust
// ===== v1.9 AI 慢脑命令 =====
#[tauri::command]
fn ai_get_config(state: tauri::State<ai::AiState>) -> Result<ai::config::AiConfig, String> {
    let db = ai::vectordb::open(&state.dir().join("ai.db"))?;
    ai::config::load_config(&db.0)
}

#[tauri::command]
fn ai_save_config(
    state: tauri::State<ai::AiState>,
    cfg: ai::config::AiConfig,
) -> Result<(), String> {
    let db = ai::vectordb::open(&state.dir().join("ai.db"))?;
    ai::config::save_config(&db.0, &cfg)
}

fn cloud_secret() -> ai::config::KeyringSecret {
    ai::config::KeyringSecret {
        service: "tickgold.ai.cloud-key".to_string(),
        user: "default".to_string(),
    }
}

#[tauri::command]
fn ai_get_cloud_key_set() -> bool {
    matches!(cloud_secret().get(), Ok(Some(_)))
}

#[tauri::command]
fn ai_set_cloud_key(secret: String) -> Result<(), String> {
    cloud_secret().set(secret.trim())
}

#[tauri::command]
fn ai_clear_cloud_key() -> Result<(), String> {
    cloud_secret().erase()
}

#[tauri::command]
async fn ai_test_connection(
    state: tauri::State<'_, ai::AiState>,
) -> Result<serde_json::Value, String> {
    let cfg = {
        let db = ai::vectordb::open(&state.dir().join("ai.db"))?;
        ai::config::load_config(&db.0)?
    };
    let key = if cfg.provider == "cloud" {
        cloud_secret().get()?
    } else {
        None
    };
    let info = ai::provider::list_models(&cfg, &key).await?;
    Ok(serde_json::json!({"latencyMs": info.latency_ms, "models": info.models}))
}

#[tauri::command]
fn ai_new_session(state: tauri::State<ai::AiState>) -> Result<i64, String> {
    let db = ai::vectordb::open(&state.dir().join("ai.db"))?;
    ai::vectordb::create_session(&db.0, "")
}

#[tauri::command]
fn ai_list_sessions(
    state: tauri::State<ai::AiState>,
) -> Result<Vec<ai::vectordb::SessionRow>, String> {
    let db = ai::vectordb::open(&state.dir().join("ai.db"))?;
    ai::vectordb::list_sessions(&db.0)
}

#[tauri::command]
fn ai_load_session(
    state: tauri::State<ai::AiState>,
    session_id: i64,
) -> Result<Vec<ai::vectordb::MsgRow>, String> {
    let db = ai::vectordb::open(&state.dir().join("ai.db"))?;
    ai::vectordb::list_messages(&db.0, session_id, 100)
}

#[tauri::command]
fn ai_delete_session(state: tauri::State<ai::AiState>, session_id: i64) -> Result<(), String> {
    let db = ai::vectordb::open(&state.dir().join("ai.db"))?;
    ai::vectordb::delete_session(&db.0, session_id)
}

#[tauri::command]
async fn ai_chat_send(
    app: tauri::AppHandle,
    state: tauri::State<'_, ai::AiState>,
    registry: tauri::State<'_, ai::AbortRegistry>,
    session_id: i64,
    text: String,
) -> Result<(), String> {
    let (cfg, key, data_dir) = {
        let db = ai::vectordb::open(&state.dir().join("ai.db"))?;
        let cfg = ai::config::load_config(&db.0)?;
        let key = if cfg.provider == "cloud" {
            cloud_secret().get()?
        } else {
            None
        };
        (cfg, key, state.dir().clone())
    };
    // flags 是 Arc<Mutex<HashSet>>：克隆 Arc 与 spawn 共享，中止命令可即时置位
    let reg = ai::AbortRegistry {
        flags: registry.flags.clone(),
    };
    tauri::async_runtime::spawn(async move {
        if let Err(e) =
            ai::agent::run_turn(&app, &data_dir, &reg, &cfg, key, session_id, text).await
        {
            log::error!("AI 对话失败: {e}");
        }
    });
    Ok(())
}

#[tauri::command]
fn ai_chat_abort(
    registry: tauri::State<ai::AbortRegistry>,
    session_id: i64,
) -> Result<(), String> {
    registry.abort(session_id);
    Ok(())
}

#[tauri::command]
fn ai_kb_stats(state: tauri::State<ai::AiState>) -> Result<ai::vectordb::KbStats, String> {
    let db = ai::vectordb::open(&state.dir().join("ai.db"))?;
    ai::vectordb::stats(&db.0)
}

#[tauri::command]
fn ai_list_docs(state: tauri::State<ai::AiState>) -> Result<Vec<(String, i64)>, String> {
    let db = ai::vectordb::open(&state.dir().join("ai.db"))?;
    ai::vectordb::list_sources(&db.0, "manual_doc")
}

#[tauri::command]
async fn ai_import_docs(
    state: tauri::State<'_, ai::AiState>,
) -> Result<Vec<String>, String> {
    let files = rfd::AsyncFileDialog::new()
        .add_filter("文本文档", &["md", "txt"])
        .pick_files()
        .await
        .ok_or_else(|| "已取消选择".to_string())?;
    let mut imported = vec![];
    for f in files {
        let name = f.file_name();
        let is_md = name.to_lowercase().ends_with(".md");
        let bytes = tokio::fs::read(f.path()).await.map_err(|e| e.to_string())?;
        let content = String::from_utf8(bytes)
            .map_err(|_| format!("{name} 不是 UTF-8 文本，请转码后再导入"))?;
        let n = ai::ingest::ingest_document(&state.dir(), &name, &content, is_md)?;
        if n > 0 {
            imported.push(name);
        }
    }
    Ok(imported)
}

#[tauri::command]
fn ai_delete_doc(
    state: tauri::State<ai::AiState>,
    file_name: String,
) -> Result<usize, String> {
    let db = ai::vectordb::open(&state.dir().join("ai.db"))?;
    ai::vectordb::delete_by_source_ref(&db.0, "manual_doc", &file_name)
}

#[tauri::command]
async fn ai_reindex(state: tauri::State<'_, ai::AiState>) -> Result<usize, String> {
    let cfg = {
        let db = ai::vectordb::open(&state.dir().join("ai.db"))?;
        ai::config::load_config(&db.0)?
    };
    let key = if cfg.provider == "cloud" { cloud_secret().get()? } else { None };
    let embedder = ai::provider::HttpEmbedder { cfg: cfg.clone(), api_key: key };
    ai::ingest::embed_pending(&state.dir(), &cfg, &embedder, None, 100_000).await
}

#[tauri::command]
async fn ai_index_daily(
    state: tauri::State<'_, ai::AiState>,
    trade_date: String,
) -> Result<usize, String> {
    let cfg = {
        let db = ai::vectordb::open(&state.dir().join("ai.db"))?;
        ai::config::load_config(&db.0)?
    };
    let key = if cfg.provider == "cloud" { cloud_secret().get()? } else { None };
    let embedder = ai::provider::HttpEmbedder { cfg: cfg.clone(), api_key: key };
    ai::ingest::index_day(&state.dir(), &cfg, &embedder, &trade_date, None).await
}
```

- [ ] **Step 3: 注册命令**

在 `lib.rs` 的 `invoke_handler` 列表中 `restore_latest_backup` 之后追加：

```rust
            ,
            ai_get_config,
            ai_save_config,
            ai_get_cloud_key_set,
            ai_set_cloud_key,
            ai_clear_cloud_key,
            ai_test_connection,
            ai_new_session,
            ai_list_sessions,
            ai_load_session,
            ai_delete_session,
            ai_chat_send,
            ai_chat_abort,
            ai_kb_stats,
            ai_list_docs,
            ai_import_docs,
            ai_delete_doc,
            ai_reindex,
            ai_index_daily
```

（把现有 `restore_latest_backup` 行末加逗号后接续；保持列表语法合法。）

- [ ] **Step 4: 前端归因成功钩子**

修改 `src/composables/useCollector.ts`：

顶部 import 区加：

```ts
import { invoke } from "@tauri-apps/api/core";
```

在 `runAttribution` 函数体（`return r.themes;` 之前）加入 fire-and-forget 入库钩子：

```ts
  // v1.9：归因成功后触发 AI 知识库日度增量（独立失败，不阻断归因）
  void invoke<number>("ai_index_daily", { tradeDate: date })
    .then((n) => {
      if (n > 0) console.info(`[ai] 日度入库新增分块 ${n}（${date}）`);
    })
    .catch((e) => console.warn("[ai] 日度入库跳过：", e));
```

（date 为该函数已有的 `date: string` 形参。）

- [ ] **Step 5: Rust 测试 + 编译**

```powershell
$env:PATH="$env:USERPROFILE\.cargo\bin;$env:PATH"
cargo test --manifest-path src-tauri/Cargo.toml --lib ai::
```

Expected：全部 ai 测试 PASS（含 ingest 4 个新增）。

- [ ] **Step 6: 提交**

```bash
git add src-tauri/src/ai/ingest.rs src-tauri/src/lib.rs src/composables/useCollector.ts
git commit -m "feat(ai): Tauri 命令全集、md/txt 入库切块、日度自动入库与补嵌"
```

---

### Task 8: 前端 AI 类型、API 封装与流式会话状态机

**Files:**
- Create: `src/ai/types.ts`
- Create: `src/ai/streamReducer.ts`（零 Tauri 依赖，纯函数）
- Create: `src/ai/api.ts`（18 个 invoke 封装）
- Create: `src/composables/useAiChat.ts`
- Test: `tests/unit/ai-chat.test.ts`

**Interfaces:**
- types.ts 产出（全部 export）：`ProviderKind`、`AiConfig`、`SessionInfo`、`MessageInfo`、`ToolState`、`ToolStatus`、`FactRef`、`KbStats`、`ConnTest`、`IndexProgress`
- api.ts 产出：`getAiConfig/saveAiConfig/getCloudKeySet/setCloudKey/clearCloudKey/testConnection/newSession/listSessions/loadSession/deleteSession/chatSend/chatAbort/kbStats/importDocs/deleteDoc/reindex/indexDaily`
- useAiChat 产出：单例 `useAiChat()`（模块级 reactive 状态）返回 `{ configured, sessions, currentId, messages, streaming, error, ensureInit, selectSession, startNewSession, removeSession, send, abort }`；事件在首次 ensureInit 时订阅一次。

- [ ] **Step 1: src/ai/types.ts**

```ts
// AI 慢脑域类型：字段名与 Rust serde camelCase 输出一致。
export type ProviderKind = "ollama" | "cloud";

export interface AiConfig {
  provider: ProviderKind;
  baseUrl: string;
  chatModel: string;
  embedModel: string;
  temperature: number;
  enableAutoIndex: boolean;
}

export interface SessionInfo {
  id: number;
  title: string;
  createdAt: number;
  lastAt: number;
}

export type MessageRole = "user" | "assistant" | "tool";

export interface MessageInfo {
  id: number;
  role: MessageRole;
  content: string;
  toolCalls: string;
  refs: string;
  createdAt: number;
}

export type ToolStatus = "running" | "ok" | "error";

export interface ToolState {
  callId: string;
  name: string;
  args: unknown;
  status: ToolStatus;
  elapsedMs: number;
}

/** 前端流式消息（未落库的临时态；done 后补 messageId/refs）。 */
export interface StreamMessage extends MessageInfo {
  toolCalls: string;
  tools: ToolState[];
  refs: string;
  factRefs: FactRef[];
  streaming?: boolean;
}

export interface FactRef {
  kind: "card" | "url";
  card?: string;
  code?: string;
  date?: string;
  url?: string;
  title?: string;
}

export interface KbStats {
  total: number;
  embedded: number;
  bytesEstimate: number;
  byType: Array<[string, number]>;
}

export interface ConnTest {
  latencyMs: number;
  models: string[];
}

export interface IndexProgress {
  phase: string;
  done: number;
  total: number;
  error?: string;
}
```

- [ ] **Step 2: src/ai/api.ts**

```ts
// AI 命令封装（风格对齐 src/api/kb.ts）。
import { invoke } from "@tauri-apps/api/core";
import type { AiConfig, ConnTest, KbStats, MessageInfo, SessionInfo } from "./types";

export function getAiConfig(): Promise<AiConfig> {
  return invoke<AiConfig>("ai_get_config");
}
export function saveAiConfig(cfg: AiConfig): Promise<void> {
  return invoke("ai_save_config", { cfg });
}
export function getCloudKeySet(): Promise<boolean> {
  return invoke<boolean>("ai_get_cloud_key_set");
}
export function setCloudKey(secret: string): Promise<void> {
  return invoke("ai_set_cloud_key", { secret });
}
export function clearCloudKey(): Promise<void> {
  return invoke("ai_clear_cloud_key");
}
export function testConnection(): Promise<ConnTest> {
  return invoke<ConnTest>("ai_test_connection");
}
export function newSession(): Promise<number> {
  return invoke<number>("ai_new_session");
}
export function listSessions(): Promise<SessionInfo[]> {
  return invoke<SessionInfo[]>("ai_list_sessions");
}
export function loadSession(sessionId: number): Promise<MessageInfo[]> {
  return invoke<MessageInfo[]>("ai_load_session", { sessionId });
}
export function deleteSession(sessionId: number): Promise<void> {
  return invoke("ai_delete_session", { sessionId });
}
export function chatSend(sessionId: number, text: string): Promise<void> {
  return invoke("ai_chat_send", { sessionId, text });
}
export function chatAbort(sessionId: number): Promise<void> {
  return invoke("ai_chat_abort", { sessionId });
}
export function kbStats(): Promise<KbStats> {
  return invoke<KbStats>("ai_kb_stats");
}
export function listDocs(): Promise<Array<[string, number]>> {
  return invoke<Array<[string, number]>>("ai_list_docs");
}
/** 弹出原生多选框导入 md/txt；返回实际产生新分块的文件名。 */
export function importDocs(): Promise<string[]> {
  return invoke<string[]>("ai_import_docs");
}
export function deleteDoc(fileName: string): Promise<number> {
  return invoke<number>("ai_delete_doc", { fileName });
}
export function reindex(): Promise<number> {
  return invoke<number>("ai_reindex");
}
export function indexDaily(tradeDate: string): Promise<number> {
  return invoke<number>("ai_index_daily", { tradeDate });
}
```

- [ ] **Step 3: src/ai/streamReducer.ts（零 Tauri 依赖的纯函数）**

```ts
// 流式事件 reducer：把 ai://* 事件应用到消息列表，按 sessionId 过滤。
// 零 Tauri/Vue 依赖，node 环境直接单测。
import type {
  FactRef, MessageInfo, StreamMessage, ToolState,
} from "./types";

export function toStream(m: MessageInfo): StreamMessage {
  let factRefs: FactRef[] = [];
  try {
    const parsed = JSON.parse(m.refs || "[]");
    if (Array.isArray(parsed)) factRefs = parsed as FactRef[];
  } catch { /* ignore */ }
  return { ...m, tools: [], factRefs, streaming: false };
}

/** 处理 token 事件：返回是否属于当前会话。 */
export function applyToken(
  list: StreamMessage[],
  sessionId: number,
  ev: { sessionId: number; text: string },
): boolean {
  if (ev.sessionId !== sessionId) return false;
  const last = list[list.length - 1];
  if (!last || last.role !== "assistant" || !last.streaming) {
    list.push({
      id: -1, role: "assistant", content: ev.text, toolCalls: "[]", tools: [],
      refs: "[]", factRefs: [], createdAt: Date.now(), streaming: true,
    });
  } else {
    last.content += ev.text;
  }
  return true;
}

export function applyTool(
  list: StreamMessage[],
  sessionId: number,
  ev: {
    sessionId: number; callId: string; name: string; args: unknown;
    status: ToolState["status"]; elapsedMs: number;
  },
): boolean {
  if (ev.sessionId !== sessionId) return false;
  const last = list[list.length - 1];
  if (!last || last.role !== "assistant") return true; // 工具条挂在当前回答上
  const existing = last.tools.find((t) => t.callId === ev.callId);
  if (existing) {
    existing.status = ev.status;
    existing.elapsedMs = ev.elapsedMs;
  } else {
    last.tools.push({
      callId: ev.callId, name: ev.name, args: ev.args,
      status: ev.status, elapsedMs: ev.elapsedMs,
    });
  }
  return true;
}

export function applyDone(
  list: StreamMessage[],
  sessionId: number,
  ev: { sessionId: number; messageId: number; refs: FactRef[]; aborted: boolean },
): boolean {
  if (ev.sessionId !== sessionId) return false;
  const last = list[list.length - 1];
  if (last && last.role === "assistant") {
    last.streaming = false;
    last.id = ev.messageId;
    last.factRefs = ev.refs ?? [];
    last.refs = JSON.stringify(ev.refs ?? []);
  }
  return true;
}
```

- [ ] **Step 3b: useAiChat.ts（订阅事件 + 调 reducer）**

```ts
// AI 流式会话状态机：订阅 ai://* 事件并转发给 streamReducer 纯函数。
import { ref } from "vue";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { FactRef, SessionInfo, StreamMessage, ToolState } from "../ai/types";
import { applyDone, applyTool, applyToken, toStream } from "../ai/streamReducer";
import * as api from "../ai/api";

let unlisten: UnlistenFn[] | null = null;

const sessions = ref<SessionInfo[]>([]);
const currentId = ref<number | null>(null);
const messages = ref<StreamMessage[]>([]);
const streaming = ref(false);
const error = ref("");

async function refreshSessions(keepCurrent = true) {
  sessions.value = await api.listSessions();
  if ((!keepCurrent || currentId.value === null) && sessions.value.length > 0) {
    currentId.value = sessions.value[0].id;
    await loadCurrent();
  }
}

async function loadCurrent() {
  if (currentId.value === null) {
    messages.value = [];
    return;
  }
  const rows = await api.loadSession(currentId.value);
  messages.value = rows.map(toStream);
}

export async function ensureInit(): Promise<void> {
  if (!unlisten) {
    unlisten = [];
    unlisten.push(await listen<{ sessionId: number; text: string }>("ai://token", (e) => {
      applyToken(messages.value, currentId.value ?? -1, e.payload);
    }));
    unlisten.push(await listen<{ sessionId: number; callId: string; name: string; args: unknown; status: ToolState["status"]; elapsedMs: number }>("ai://tool", (e) => {
      applyTool(messages.value, currentId.value ?? -1, e.payload);
    }));
    unlisten.push(await listen<{ sessionId: number; messageId: number; refs: FactRef[]; aborted: boolean }>("ai://done", (e) => {
      applyDone(messages.value, currentId.value ?? -1, e.payload);
      streaming.value = false;
      void refreshSessions();
    }));
    unlisten.push(await listen<{ sessionId: number; message: string }>("ai://error", (e) => {
      if (e.payload.sessionId === (currentId.value ?? -1)) {
        error.value = e.payload.message;
        streaming.value = false;
        const last = messages.value[messages.value.length - 1];
        if (last?.role === "assistant") last.streaming = false;
      }
    }));
  }
  await refreshSessions(false);
  if (currentId.value === null) {
    currentId.value = await api.newSession();
    messages.value = [];
  }
}

export async function selectSession(id: number): Promise<void> {
  currentId.value = id;
  error.value = "";
  await loadCurrent();
}

export async function startNewSession(): Promise<void> {
  currentId.value = await api.newSession();
  messages.value = [];
  error.value = "";
  await refreshSessions(true);
}

export async function removeSession(id: number): Promise<void> {
  await api.deleteSession(id);
  if (currentId.value === id) currentId.value = null;
  await refreshSessions(false);
  if (currentId.value === null) {
    currentId.value = await api.newSession();
    messages.value = [];
  }
}

export async function send(text: string): Promise<void> {
  const t = text.trim();
  if (!t || streaming.value || currentId.value === null) return;
  error.value = "";
  messages.value.push({
    id: -1, role: "user", content: t, toolCalls: "[]", tools: [],
    refs: "[]", factRefs: [], createdAt: Date.now(),
  });
  streaming.value = true;
  try {
    await api.chatSend(currentId.value, t);
  } catch (e) {
    streaming.value = false;
    error.value = e instanceof Error ? e.message : String(e);
  }
}

export async function abort(): Promise<void> {
  if (currentId.value !== null) await api.chatAbort(currentId.value);
}

export function useAiChat() {
  return {
    sessions, currentId, messages, streaming, error,
    ensureInit, selectSession, startNewSession, removeSession, send, abort,
  };
}
```

- [ ] **Step 4: tests/unit/ai-chat.test.ts**

```ts
import { describe, expect, it } from "vitest";
import type { StreamMessage } from "../../src/ai/types";
import { applyDone, applyToken, applyTool } from "../../src/ai/streamReducer";

function assistant(text = ""): StreamMessage {
  return {
    id: -1, role: "assistant", content: text, toolCalls: "[]", tools: [],
    refs: "[]", factRefs: [], createdAt: 1, streaming: true,
  };
}

describe("AI 流式状态机", () => {
  it("忽略其他会话的 token", () => {
    const list: StreamMessage[] = [];
    expect(applyToken(list, 9, { sessionId: 8, text: "x" })).toBe(false);
    expect(list).toHaveLength(0);
  });

  it("首个 token 建消息，后续增量拼接", () => {
    const list: StreamMessage[] = [];
    applyToken(list, 3, { sessionId: 3, text: "今日" });
    applyToken(list, 3, { sessionId: 3, text: "涨停" });
    expect(list).toHaveLength(1);
    expect(list[0].content).toBe("今日涨停");
    expect(list[0].streaming).toBe(true);
  });

  it("工具事件先 running 后 ok 并更新同一 callId", () => {
    const list = [assistant("正在查询")];
    applyTool(list, 1, { sessionId: 1, callId: "c1", name: "market_overview", args: { date: "2026-09-30" }, status: "running", elapsedMs: 0 });
    applyTool(list, 1, { sessionId: 1, callId: "c1", name: "market_overview", args: { date: "2026-09-30" }, status: "ok", elapsedMs: 42 });
    expect(list[0].tools).toHaveLength(1);
    expect(list[0].tools[0].status).toBe("ok");
    expect(list[0].tools[0].elapsedMs).toBe(42);
  });

  it("done 落定消息 id、refs 并停止流式", () => {
    const list = [assistant("结论")];
    applyDone(list, 2, { sessionId: 2, messageId: 55, refs: [{ kind: "card", card: "limitpool" }], aborted: false });
    expect(list[0].id).toBe(55);
    expect(list[0].streaming).toBe(false);
    expect(list[0].factRefs[0].card).toBe("limitpool");
  });

  it("done 的会话不匹配时不改动", () => {
    const list = [assistant("x")];
    expect(applyDone(list, 7, { sessionId: 8, messageId: 1, refs: [], aborted: false })).toBe(false);
    expect(list[0].streaming).toBe(true);
  });
});
```

- [ ] **Step 5: 跑测试**

```powershell
$env:TEMP="$PWD\.tmp";$env:TMP="$PWD\.tmp"
pnpm vitest run tests/unit/ai-chat.test.ts
```

Expected：5 个测试 PASS。

- [ ] **Step 6: 提交**

```bash
git add src/ai src/composables/useAiChat.ts tests/unit/ai-chat.test.ts
git commit -m "feat(ai-web): AI 类型/API/事件 reducer 与流式会话状态机（含单测）"
```

---

### Task 9: AI 助手卡、卡片注册与场景 72 格重排

**Files:**
- Create: `src/components/AiAssistant.vue`
- Modify: `src/components/CardContent.vue`
- Modify: `src/lib/cards.ts`
- Modify: `src/lib/dock.ts`
- Modify: `src/lib/layout.ts`
- Modify: `src/lib/scenes.ts`
- Modify: `tests/unit/scenes.test.ts`
- Modify: `package.json`（加 markdown-it + @types/markdown-it）

**Interfaces:**
- cards.ts：`CardId` 联合加 `"aiassistant"`；`CARD_META` 加 `aiassistant: { title: "AI 助手", accent: "#7c9bff", kind: "chart" }`
- layout.ts：`WIDE_ORDER` 末尾加 `"aiassistant"`；`DEFAULT_SIZE` 加 `aiassistant: { w: 6, h: 3 }`；`FREE_SIZE` 加 `aiassistant: { w: 8, h: 5 }`
- dock.ts：新增分组「AI 助手」，单卡 aiassistant（star: true）
- scenes.ts：review 场景改为 5 卡 72 格（见 Step 5）
- CardContent.vue：import 并加分支 `<AiAssistant v-else-if="id === 'aiassistant'" />`

- [ ] **Step 1: 安装 markdown-it**

```powershell
$env:TEMP="$PWD\.tmp";$env:TMP="$PWD\.tmp"
pnpm add markdown-it@14
pnpm add -D @types/markdown-it@14
```

Expected：package.json dependencies 出现 `markdown-it`，devDependencies 出现 `@types/markdown-it`。

- [ ] **Step 1b: src/ai/markdown.ts**

```ts
// 统一 markdown 渲染入口。html:false：LLM 输出中的原始 HTML 标签全部转义，
// 杜绝 XSS（v-html 只渲染此函数输出）。链接仍可经 opener 外链打开。
import MarkdownIt from "markdown-it";

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

export function renderMarkdown(text: string): string {
  return md.render(text || "");
}
```

- [ ] **Step 2: AiAssistant.vue**

```vue
<script setup lang="ts">
// AI 问数助手卡：会话切换 + 流式消息 + 工具折叠条 + 证据跳转 + 快捷提问。
import { computed, onMounted, ref } from "vue";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useWorkbench } from "../composables/useWorkbench";
import { useMarketContext } from "../composables/useMarketContext";
import { useAiChat } from "../composables/useAiChat";
import { renderMarkdown } from "../ai/markdown";
import type { FactRef, StreamMessage, ToolState } from "../ai/types";

const bench = useWorkbench();
const market = useMarketContext();
// 解构到顶层：模板只对顶层 ref 自动解包（chat.sessions.value 在模板中不成立）
const {
  sessions, currentId, messages, streaming, error,
  ensureInit, selectSession, startNewSession, removeSession, send, abort,
} = useAiChat();

// 渲染统一走 src/ai/markdown.ts（html:false，原始 HTML 一律转义）
const render = renderMarkdown;

const input = ref("");
const showSessions = ref(false);

const QUICK_PROMPTS = [
  "今天市场情绪怎么样？",
  "当前有哪些发酵中的题材？",
  "我的持仓有什么催化？",
  "知识库里龙头战法的要点是什么？",
];

onMounted(() => {
  ensureInit().catch((e) => console.warn("[ai]", e));
});

async function submit(prompt?: string) {
  const text = (prompt ?? input.value).trim();
  if (!text) return;
  input.value = "";
  await send(text);
}

function toolLabel(t: ToolState): string {
  const map: Record<string, string> = {
    market_overview: "市场情绪", list_themes: "题材列表", theme_detail: "题材详情",
    query_catalysts: "催化查询", stock_profile: "个股档案", list_limit_ups: "涨停记录",
    semantic_search: "知识库检索", paper_positions: "模拟持仓",
  };
  return map[t.name] ?? t.name;
}

function toolArgs(t: ToolState): string {
  try {
    return JSON.stringify(t.args);
  } catch {
    return "";
  }
}

async function gotoRef(ref: FactRef) {
  if (ref.kind === "url" && ref.url) {
    await openUrl(ref.url);
    return;
  }
  if (ref.card) {
    bench.open(ref.card as never);
    bench.focus(ref.card as never);
  }
  if (ref.code) market.select(ref.code);
}

const currentTitle = computed(() => {
  const s = sessions.value.find((x) => x.id === currentId.value);
  return s?.title || "新会话";
});
</script>

<template>
  <div class="ai-card">
    <div class="ai-head">
      <button class="ai-sess-toggle" @click="showSessions = !showSessions" title="会话列表">☰</button>
      <span class="ai-title">{{ currentTitle }}</span>
      <button class="ai-new" @click="startNewSession()" title="新会话">＋</button>
    </div>

    <div v-if="showSessions" class="ai-sessions">
      <div
        v-for="s in sessions"
        :key="s.id"
        class="ai-session"
        :class="{ on: s.id === currentId }"
        @click="selectSession(s.id).then(() => (showSessions = false))"
      >
        <span class="as-title">{{ s.title || "未命名会话" }}</span>
        <button class="as-del" title="删除" @click.stop="removeSession(s.id)">✕</button>
      </div>
    </div>

    <div class="ai-msgs">
      <div v-if="messages.length === 0 && !streaming" class="ai-empty">
        <div class="ai-empty-title">慢脑问数助手</div>
        <div class="ai-empty-sub">提问市场情绪、题材逻辑、个股催化；答案附证据可点击核对</div>
      </div>
      <template v-for="(m, i) in messages" :key="m.id < 0 ? `tmp-${i}` : m.id">
        <!-- 工具结果记录不直接展示（折叠到其上方回答的工具条里，历史回看以灰色行呈现） -->
        <div v-if="m.role === 'tool'" class="ai-tool-record">· {{ m.content.slice(0, 60) }}…</div>
        <div v-else class="ai-msg" :class="m.role">
          <div v-if="m.role === 'user'" class="ai-user-text">{{ m.content }}</div>
          <template v-else>
            <div class="ai-toolbar" v-if="m.tools && m.tools.length">
              <div v-for="t in m.tools" :key="t.callId" class="ai-tool" :class="t.status">
                <span class="at-dot"></span>{{ toolLabel(t) }}
                <span class="at-args">{{ toolArgs(t) }}</span>
                <span class="at-ms">{{ t.elapsedMs }}ms</span>
              </div>
            </div>
            <div class="ai-md" v-html="render(m.content)"></div>
            <div v-if="m.factRefs && m.factRefs.length" class="ai-refs">
              <button
                v-for="(r, ri) in m.factRefs"
                :key="ri"
                class="ai-ref"
                @click="gotoRef(r)"
              >
                {{ r.kind === "url" ? (r.title || "公告原文 ↗") : `证据：${r.card}${r.code ? " " + r.code : ""}` }}
              </button>
            </div>
            <span v-if="m.streaming" class="ai-cursor">▍</span>
          </template>
        </div>
      </template>
      <div v-if="error" class="ai-error">⚠ {{ error }}</div>
    </div>

    <div class="ai-quick">
      <button
        v-for="q in QUICK_PROMPTS"
        :key="q"
        class="ai-q"
        :disabled="streaming"
        @click="submit(q)"
      >{{ q }}</button>
    </div>

    <div class="ai-input">
      <textarea
        v-model="input"
        rows="1"
        placeholder="向慢脑提问…（Enter 发送，Shift+Enter 换行）"
        @keydown.enter.exact.prevent="submit()"
      ></textarea>
      <button v-if="streaming" class="ai-stop" @click="abort()">中止</button>
      <button v-else class="ai-send" :disabled="!input.trim()" @click="submit()">发送</button>
    </div>
  </div>
</template>

<style scoped>
.ai-card { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 6px; padding: 4px 2px; }
.ai-head { display: flex; align-items: center; gap: 8px; }
.ai-title { font-size: 12px; font-weight: 700; color: var(--text); flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ai-head button {
  border: 1px solid var(--border); background: var(--bg-card); color: var(--text);
  border-radius: 7px; width: 24px; height: 24px; cursor: pointer; font-size: 13px;
}
.ai-sessions {
  max-height: 138px; overflow: auto; border: 1px solid var(--border); border-radius: 9px;
  display: flex; flex-direction: column;
}
.ai-session {
  display: flex; align-items: center; justify-content: space-between;
  padding: 6px 10px; font-size: 12px; cursor: pointer;
}
.ai-session + .ai-session { border-top: 1px solid var(--border); }
.ai-session.on { background: rgba(124, 155, 255, 0.12); }
.as-title { color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.as-del { border: none; background: transparent; color: var(--text-dim); cursor: pointer; }
.ai-msgs { flex: 1; min-height: 80px; overflow: auto; display: flex; flex-direction: column; gap: 8px; padding-right: 4px; }
.ai-empty { margin: auto; text-align: center; color: var(--text-dim); }
.ai-empty-title { font-size: 14px; font-weight: 700; color: var(--text); margin-bottom: 6px; }
.ai-empty-sub { font-size: 11px; max-width: 280px; line-height: 1.6; }
.ai-msg.user { display: flex; justify-content: flex-end; }
.ai-user-text {
  background: rgba(124, 155, 255, 0.16); border: 1px solid rgba(124, 155, 255, 0.35);
  padding: 6px 10px; border-radius: 10px 10px 2px 10px; font-size: 12px; max-width: 86%;
  white-space: pre-wrap;
}
.ai-msg.assistant { font-size: 12px; line-height: 1.7; color: var(--text); }
.ai-md :deep(table) { border-collapse: collapse; margin: 4px 0; }
.ai-md :deep(td), .ai-md :deep(th) { border: 1px solid var(--border); padding: 2px 6px; font-size: 11px; }
.ai-md :deep(ul), .ai-md :deep(ol) { padding-left: 18px; margin: 4px 0; }
.ai-md :deep(a) { color: #7c9bff; }
.ai-toolbar { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 4px; }
.ai-tool {
  display: inline-flex; align-items: center; gap: 5px; font-size: 10px;
  border: 1px solid var(--border); border-radius: 999px; padding: 2px 8px; color: var(--text-dim);
}
.ai-tool.running .at-dot { animation: ai-blink 1s infinite; }
.ai-tool.error { border-color: rgba(224, 69, 90, 0.5); color: #ff8a96; }
.at-dot { width: 5px; height: 5px; border-radius: 50%; background: currentColor; display: inline-block; }
.at-args { max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.at-ms { opacity: 0.7; }
@keyframes ai-blink { 50% { opacity: 0.25; } }
.ai-tool-record { font-size: 10px; color: var(--text-dim); opacity: 0.6; padding-left: 8px; }
.ai-refs { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 5px; }
.ai-ref {
  font-size: 10px; border: 1px solid rgba(124, 155, 255, 0.4); background: transparent;
  color: #9db4ff; border-radius: 6px; padding: 2px 7px; cursor: pointer;
}
.ai-ref:hover { background: rgba(124, 155, 255, 0.14); }
.ai-cursor { animation: ai-blink 1s infinite; color: #7c9bff; }
.ai-error { font-size: 11px; color: #ff8a96; border: 1px solid rgba(224,69,90,.35); border-radius: 8px; padding: 6px 9px; }
.ai-quick { display: flex; flex-wrap: wrap; gap: 4px; }
.ai-q {
  font-size: 10px; border: 1px solid var(--border); background: var(--bg-card);
  color: var(--text-dim); border-radius: 999px; padding: 3px 9px; cursor: pointer;
}
.ai-q:disabled { opacity: 0.5; cursor: default; }
.ai-input { display: flex; gap: 6px; align-items: flex-end; }
.ai-input textarea {
  flex: 1; resize: none; max-height: 72px; border-radius: 9px; border: 1px solid var(--border);
  background: var(--bg-card); color: var(--text); font-size: 12px; padding: 7px 10px; font-family: inherit;
}
.ai-send, .ai-stop {
  border: none; border-radius: 9px; padding: 8px 14px; font-size: 12px; cursor: pointer;
  background: #7c9bff; color: #0c1020; font-weight: 700;
}
.ai-stop { background: #e0455a; color: #fff; }
.ai-send:disabled { opacity: 0.5; cursor: default; }
</style>
```

- [ ] **Step 3: cards.ts / dock.ts / layout.ts / CardContent.vue 注册**

`src/lib/cards.ts`：`CardId` 联合在 `"trades"` 之前加一行：

```ts
  | "aiassistant"
```

`CARD_META` 在 `trades:` 行之前加：

```ts
  aiassistant: { title: "AI 助手", accent: "#7c9bff", kind: "chart" },
```

`src/lib/dock.ts`：在 `DOCK_GROUPS` 数组最后一个分组（交易工具）对象之后追加新分组：

```ts
  {
    name: "AI 助手",
    icon: "M12 2a10 10 0 100 20 10 10 0 000-20zm1 15h-2v-2h2zm0-4h-2V7h2z",
    items: [
      { id: "aiassistant", label: "AI 问数助手", icon: "M12 2a10 10 0 100 20 10 10 0 000-20zm1 15h-2v-2h2zm0-4h-2V7h2z", desc: "自然语言问市场/题材/催化，答案附证据", star: true },
    ],
  },
```

`src/lib/layout.ts`：
- `WIDE_ORDER` 数组末尾 `"dragon", "themelib"` 之后、`]` 之前加 `"aiassistant"`；
- `DEFAULT_SIZE` 中 `themelib: { w: 6, h: 3 },` 行后加 `aiassistant: { w: 6, h: 3 },`；
- `FREE_SIZE` 中 `themelib: { w: 8, h: 5 },` 行后加 `aiassistant: { w: 8, h: 5 },`。

`src/components/CardContent.vue`：
- import 区（`import TradeTape` 行之前）加：

```ts
import AiAssistant from "./AiAssistant.vue";
```

- 模板中 `<TradeTape v-else-if="id === 'trades'" ... />` 之前加：

```vue
    <AiAssistant v-else-if="id === 'aiassistant'" />
```

- [ ] **Step 4: scenes.ts review 场景重排（仍精确 72 格）**

把 review 场景整段替换为：

```ts
  { id: "review", label: "盘后复盘", icon: "M12 4a8 8 0 108 8h-2a6 6 0 11-6-6v3l4-4-4-4v3z",
    cards: ["aiassistant", "chart", "themelib", "reviewtimeline", "news"],
    // 12×6=72 精确铺满：AI 助手/图表 6×3，题材库/复盘时间线 6×2，快讯整行垫底
    size: { aiassistant: { w: 6, h: 3 }, chart: { w: 6, h: 3 }, themelib: { w: 6, h: 2 }, reviewtimeline: { w: 6, h: 2 }, news: { w: 12, h: 1 } } },
```

- [ ] **Step 5: 跑场景守卫与前端构建**

```powershell
$env:TEMP="$PWD\.tmp";$env:TMP="$PWD\.tmp"
pnpm vitest run tests/unit/scenes.test.ts
pnpm build
```

Expected：场景测试 PASS（含 AI 卡的 review 场景格数=72）；vue-tsc + vite 构建通过。

- [ ] **Step 6: 提交**

```bash
git add package.json pnpm-lock.yaml src/ai/markdown.ts src/components/AiAssistant.vue src/components/CardContent.vue src/lib src/lib/scenes.ts
git commit -m "feat(ai-web): AI 助手卡与卡片注册，review 场景重排保持 72 格"
```

（若 `tests/unit/scenes.test.ts` 无需改动则不暂存它；守卫是参数化遍历所有场景，新场景自动被覆盖。）

---

### Task 10: 设置「AI 大脑」分区、版本号与全量验收

**Files:**
- Modify: `src/components/SettingsDialog.vue`
- Modify: `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json`（1.8.0 → 1.9.0）
- Modify: `README.md`（版本号字符串，若存在）
- Test: `tests/unit/ai-markdown.test.ts`（markdown 安全渲染：HTML 转义/链接化）

**Interfaces:**
- SettingsDialog 新增 Tab `"ai"`；调用 Task 8 的 `src/ai/api.ts`；不新建后端。

- [ ] **Step 1: markdown 安全渲染测试**

创建 `tests/unit/ai-markdown.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../../src/ai/markdown";

describe("renderMarkdown 安全渲染", () => {
  it("原始 HTML/脚本标签被转义，不产生可执行节点", () => {
    const html = renderMarkdown('<script>alert(1)</script><img src=x onerror=alert(2)>');
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("onerror=");
    expect(html).toContain("&lt;script&gt;");
  });

  it("正常 markdown 与自动链接可用", () => {
    const html = renderMarkdown("# 标题\n\n- 要点一\n\n见 https://example.com/a");
    expect(html).toContain("<h1>标题</h1>");
    expect(html).toContain("<li>要点一</li>");
    expect(html).toContain('href="https://example.com/a"');
  });

  it("空输入渲染为空字符串", () => {
    expect(renderMarkdown("")).toBe("");
  });
});
```

- [ ] **Step 2: SettingsDialog.vue 脚本部分**

在 `<script setup lang="ts">` 顶部 import 区加：

```ts
import {
  getAiConfig, saveAiConfig, getCloudKeySet, setCloudKey, clearCloudKey,
  testConnection, kbStats, listDocs, importDocs, deleteDoc, reindex,
} from "../ai/api";
import type { AiConfig, ProviderKind } from "../ai/types";
```

在 `type Tab = ...` 一行把类型改为：

```ts
type Tab = "appearance" | "data" | "ai" | "logs" | "about";
```

在 `function fmtTime` 之后加 AI 设置状态与方法：

```ts
// ===== AI 大脑设置 =====
const aiCfg = ref<AiConfig | null>(null);
const keySet = ref(false);
const keyInput = ref("");
const connMsg = ref("");
const connBusy = ref(false);
const kbMsg = ref("");
const kbBusy = ref(false);
const kbInfo = ref<{ total: number; embedded: number; byType: Array<[string, number]> } | null>(null);
const aiDocs = ref<Array<[string, number]>>([]);

async function loadAi() {
  try {
    aiCfg.value = await getAiConfig();
    keySet.value = await getCloudKeySet();
    kbInfo.value = await kbStats();
  } catch (e) {
    connMsg.value = `读取 AI 配置失败：${e}`;
  }
}
function onProvider(p: ProviderKind) {
  if (aiCfg.value) aiCfg.value.provider = p;
}
async function saveAi() {
  if (!aiCfg.value) return;
  connMsg.value = "保存中…";
  try {
    await saveAiConfig(aiCfg.value);
    connMsg.value = "已保存";
  } catch (e) {
    connMsg.value = `保存失败：${e}`;
  }
}
async function saveKey() {
  if (!keyInput.value.trim()) return;
  try {
    await setCloudKey(keyInput.value.trim());
    keySet.value = true;
    keyInput.value = "";
    connMsg.value = "Key 已存入系统凭据箱";
  } catch (e) {
    connMsg.value = `Key 保存失败：${e}`;
  }
}
async function eraseKey() {
  await clearCloudKey();
  keySet.value = false;
  connMsg.value = "已清除 Key";
}
async function testAi() {
  connBusy.value = true;
  connMsg.value = "测试中…";
  try {
    const r = await testConnection();
    connMsg.value = `连接正常：${r.latencyMs}ms，可用模型 ${r.models.length} 个（${r.models.slice(0, 4).join("、")}${r.models.length > 4 ? "…" : ""}）`;
  } catch (e) {
    connMsg.value = `连接失败：${e}`;
  } finally {
    connBusy.value = false;
  }
}
async function refreshKb() {
  kbInfo.value = await kbStats();
  aiDocs.value = await listDocs();
}
async function doImport() {
  kbBusy.value = true;
  kbMsg.value = "";
  try {
    const files = await importDocs();
    kbMsg.value = files.length ? `已导入 ${files.length} 个文件，正在后台嵌入…` : "没有新内容（可能与现有文档重复）";
    await refreshKb();
  } catch (e) {
    kbMsg.value = `导入失败：${e}`;
  } finally {
    kbBusy.value = false;
  }
}
async function doDeleteDoc(name: string) {
  await deleteDoc(name);
  kbMsg.value = `已删除 ${name}`;
  await refreshKb();
}
async function doReindex() {
  kbBusy.value = true;
  kbMsg.value = "补嵌中…";
  try {
    const n = await reindex();
    kbMsg.value = `完成补嵌 ${n} 个分块`;
    await refreshKb();
  } catch (e) {
    kbMsg.value = `补嵌失败：${e}`;
  } finally {
    kbBusy.value = false;
  }
}
const KB_TYPE_LABEL: Record<string, string> = {
  catalyst: "催化剂", irm: "互动问答", theme: "题材资料", limitup: "涨停定格", manual_doc: "我的文档",
};
```

在 tab 切换函数 `pickTab`（若不存在则搜索现有的 tab 赋值处；文件中导航按钮使用内联 `@click="pickTab(...)"`，但脚本目前只有 `tab` ref。若没有 `pickTab`，在 tab ref 旁新增）：

```ts
function pickTab(id: Tab) {
  tab.value = id;
  if (id === "ai") void loadAi();
}
```

把三个 nav 按钮上的 `@click="pickTab('appearance')"` 等保持不变（它们已经调用 pickTab——若实际文件用的是 `tab = ...` 内联写法，统一改为 pickTab；以当前文件 grep 结果为准，Step 中导航按钮已写 `pickTab`，所以该函数必须存在）。

- [ ] **Step 3: SettingsDialog.vue 模板：导航按钮**

在「数据中心」导航按钮之后插入：

```html
            <button class="nav-item" :class="{ on: tab === 'ai' }" @click="pickTab('ai')">
              <svg viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M12 2a10 10 0 100 20 10 10 0 000-20zm0 4a2.5 2.5 0 110 5 2.5 2.5 0 010-5zm0 12.5c-2.4 0-4.5-1.2-5.5-3 .2-1.8 3.7-2.8 5.5-2.8s5.3 1 5.5 2.8c-1 1.8-3.1 3-5.5 3z" /></svg>
              AI 大脑
            </button>
```

- [ ] **Step 4: SettingsDialog.vue 模板：AI 面板**

在数据中心面板 `</div>`（`v-else-if="tab === 'data'"` 对应闭合）之后、诊断日志面板之前插入：

```html
            <!-- AI 大脑：慢脑模型 + 知识库 -->
            <div v-else-if="tab === 'ai' && aiCfg" class="ai-settings">
              <div class="section-title">模型供应</div>
              <div class="startup-row">
                <div class="seg">
                  <button type="button" class="seg-btn" :class="{ on: aiCfg.provider === 'ollama' }" @click="onProvider('ollama')">本地 Ollama</button>
                  <button type="button" class="seg-btn" :class="{ on: aiCfg.provider === 'cloud' }" @click="onProvider('cloud')">云端 Key</button>
                </div>
                <span class="section-sub">{{ aiCfg.provider === 'ollama' ? "数据不出本机 · 需本地运行 Ollama" : "数据将发送至所填端点 · Key 存系统凭据箱" }}</span>
              </div>

              <div class="startup-row" style="margin-top:10px">
                <div class="startup-info"><div class="startup-name">接口地址 Base URL</div></div>
                <input v-model="aiCfg.baseUrl" class="ai-input-ctl" placeholder="http://127.0.0.1:11434/v1" />
              </div>
              <div class="startup-row">
                <div class="startup-info"><div class="startup-name">对话模型</div></div>
                <input v-model="aiCfg.chatModel" class="ai-input-ctl" />
              </div>
              <div class="startup-row">
                <div class="startup-info"><div class="startup-name">嵌入模型</div></div>
                <input v-model="aiCfg.embedModel" class="ai-input-ctl" />
              </div>
              <div class="startup-row">
                <div class="startup-info">
                  <div class="startup-name">采集后自动入库</div>
                  <div class="section-sub" style="margin:3px 0 0">收盘归因后自动把催化/题材/涨停定格切块嵌入</div>
                </div>
                <button type="button" class="switch" :class="{ on: aiCfg.enableAutoIndex }" @click="aiCfg.enableAutoIndex = !aiCfg.enableAutoIndex"><span class="knob"></span></button>
              </div>

              <div v-if="aiCfg.provider === 'cloud'" class="startup-row" style="margin-top:10px">
                <div class="startup-info">
                  <div class="startup-name">云端 API Key</div>
                  <div class="section-sub" style="margin:3px 0 0">{{ keySet ? "已配置（系统凭据箱，不回显）" : "未配置" }}</div>
                </div>
                <div style="display:flex;gap:6px">
                  <input v-model="keyInput" type="password" class="ai-input-ctl" placeholder="粘贴 Key 后保存" />
                  <button type="button" class="logs-btn" @click="saveKey">保存</button>
                  <button type="button" class="logs-btn" @click="eraseKey" :disabled="!keySet">清除</button>
                </div>
              </div>

              <div class="skin-bar" style="margin-top:12px">
                <button type="button" class="logs-btn primary" :disabled="connBusy" @click="testAi">测试连接</button>
                <button type="button" class="logs-btn" @click="saveAi">保存配置</button>
                <span class="skin-msg">{{ connMsg }}</span>
              </div>

              <div class="section-title" style="margin-top:22px">本地知识库</div>
              <div class="dc-stats" v-if="kbInfo">
                <div class="dc-stat"><b>{{ kbInfo.total }}</b><span>分块总数</span></div>
                <div class="dc-stat"><b>{{ kbInfo.embedded }}</b><span>已嵌入</span></div>
                <div class="dc-stat" v-for="([t, n]) in kbInfo.byType" :key="t"><b>{{ n }}</b><span>{{ KB_TYPE_LABEL[t] ?? t }}</span></div>
              </div>
              <div class="skin-bar" style="margin-top:10px">
                <button type="button" class="logs-btn" :disabled="kbBusy" @click="doImport">导入 md/txt</button>
                <button type="button" class="logs-btn" :disabled="kbBusy" @click="doReindex">重建嵌入</button>
                <button type="button" class="logs-btn" @click="refreshKb">刷新</button>
                <span class="skin-msg">{{ kbMsg }}</span>
              </div>
              <div v-if="aiDocs.length" class="dc-note" style="margin-top:8px;display:flex;flex-wrap:wrap;gap:6px">
                已导入文档：
                <button
                  v-for="[name, n] in aiDocs"
                  :key="name"
                  type="button"
                  class="logs-btn"
                  @click="doDeleteDoc(name)"
                >{{ name }}（{{ n }} 块）✕</button>
              </div>
              <div class="dc-note" style="margin-top:8px">
                向量保存在本机 ai.db；删除文档会级联删除其分块。外部资料仅存摘要与原文链接。
              </div>
            </div>
```

- [ ] **Step 5: 数据中心增加「AI 知识库」行**

在数据中心面板的 `dc-rows` 中「题材归因」行之后加：

```html
                <div class="dc-row"><span class="dr-k">AI 知识库</span><span class="dr-v">{{ kbInfo ? kbInfo.total + ' 块 · 已嵌入 ' + kbInfo.embedded : 'AI 未就绪' }}</span></div>
```

为让数据中心页也能拿到 kbInfo，在脚本中让 `loadAi()` 不依赖切 tab：在文件末尾（现有 `void loadAutoStart();` 旁）加 `void loadAi();`（失败静默，connMsg 不影响数据中心）。

样式补充（`<style scoped>` 末尾，若已有 `.ai-input-ctl` 则跳过）：

```css
.ai-input-ctl {
  min-width: 220px; border: 1px solid var(--border); border-radius: 8px;
  background: var(--bg-card); color: var(--text); font-size: 12px; padding: 6px 9px;
}
```

- [ ] **Step 6: 版本号 1.8.0 → 1.9.0（四处）**

逐个替换（仅版本号字段，不动其他内容）：
- `package.json` 第 4 行 `"version": "1.8.0"` → `"1.9.0"`
- `src-tauri/Cargo.toml` 第 3 行 `version = "1.8.0"` → `1.9.0`
- `src-tauri/tauri.conf.json` 第 4 行 `"version": "1.8.0"` → `"1.9.0"`
- `README.md`：搜索 `1.8.0`，存在则同步替换为 `1.9.0`；无则跳过。

- [ ] **Step 7: 全量前端测试 + 构建**

```powershell
$env:TEMP="$PWD\.tmp";$env:TMP="$PWD\.tmp"
pnpm test
pnpm build
```

Expected：全部单测 PASS（新增 ai-chat 5 + ai-chunker 2，原有不回归）；vue-tsc/vite 通过。

- [ ] **Step 8: Rust 全量测试 + 整包构建**

```powershell
$env:PATH="$env:USERPROFILE\.cargo\bin;$env:PATH"
cargo test --manifest-path src-tauri/Cargo.toml --lib
$env:TEMP="$PWD\.tmp";$env:TMP="$PWD\.tmp"
pnpm tauri build --no-bundle
```

Expected：Rust lib 测试全绿（ai::* 约 28 个）；Tauri no-bundle 成功（链接器偶发 LNK1105/1224 时原样重试一次）。

- [ ] **Step 9: 提交**

```bash
git add src/components/SettingsDialog.vue package.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json README.md tests/unit/ai-markdown.test.ts
git commit -m "feat(ai-web): 设置 AI 大脑分区（模型/Key/知识库）与 v1.9.0 版本号，全量验收"
```

---

## 验收对照（Definition of Done · v1.9.0）

- [ ] 应用内 AI 助手卡：流式问答、工具调用折叠条可见、证据 chip 可点击（卡聚焦/选码/外链）。
- [ ] Ollama 与云端双通道可在设置切换、保存、测试连接（延迟+模型清单）；云 Key 存系统凭据箱、不回显。
- [ ] 归因成功后 `ai_index_daily` 自动触发；催化剂/题材/涨停定格入 ai.db；嵌入失败降级 embedded=0 不阻断。
- [ ] md/txt 多选导入：标题切块、代码块整块、400/50 规则；按文件删除级联；重建嵌入可用。
- [ ] 主库 stock-dock.db 零迁移；Rust 只读旁路；CSP 未放开外网域名。
- [ ] 8 个工具全部只读、入参校验、4000 字符截断；非法代码/日期返回错误并回灌模型。
- [ ] Agent 最多 6 轮工具调用；中止按钮即时生效；错误文案区分 401/404/429/5xx/超时/未启动。
- [ ] review 场景含 AI 卡且总格数 = 72；`pnpm test` / `pnpm build` / `cargo test --lib` / `pnpm tauri build --no-bundle` 全绿。
- [ ] 版本号四处 1.9.0；全程保留「不构成投资建议」。

## 用户手动联调（本环境无法覆盖，需用户网络）

1. 启动 Ollama（`ollama serve`，拉取 `qwen2.5:7b` 与 `nomic-embed-text`）→ 设置 → AI 大脑 → 测试连接成功。
2. AI 卡问「今天市场情绪怎么样」：出现 market_overview 工具条 + 数字回答 + 涨停池证据 chip，点击跳到涨停池卡。
3. 导入一篇战法 md → 问相关问题 → semantic_search 命中文档原文。
4. 云端渠道填 DeepSeek/其他 OpenAI 兼容 Key → 一轮问答成功；重启 App 后 Key 仍显示「已配置」。
5. 收盘归因后看数据中心「AI 知识库」分块数增长；设置页分类型计数正确。
6. Ollama 未启动时提问：错误提示包含安装/启动指引，App 不崩溃。
