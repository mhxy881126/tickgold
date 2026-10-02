// v1.9 慢脑：知识库边车库 + OpenAI 兼容慢脑 + 只读工具 Agent。
pub mod agent;
pub mod config;
pub mod decision;
pub mod ingest;
pub mod maindb;
pub mod plan;
pub mod provider;
pub mod review;
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

    /// setup 阶段写入 data_dir。
    // brief/plan 原文在 lib.rs 直接写私有字段 `.0`，跨模块访问触发 E0616
    //（私有字段仅在定义模块及其后代可见），故以此 pub 方法封装最小偏离。
    pub fn set_dir(&self, dir: PathBuf) {
        *self.0.lock().unwrap() = dir;
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

/// FNV-1a 32-bit，8 位十六进制；按 UTF-16 码元迭代，与前端 src/kb/hash.ts 同口径。
pub fn fnv1a_hex(s: &str) -> String {
    let mut h: u32 = 0x811c9dc5;
    for cu in s.encode_utf16() {
        h ^= cu as u32;
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
        assert_eq!(fnv1a_hex("中"), "28619638");
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
