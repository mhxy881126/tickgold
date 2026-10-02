// 主库 stock-dock.db 连接旁路：默认只读；v2.0 复盘/计划经 open_readwrite 仅写 AI 决策新表。
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
        // rusqlite 0.32 常量名为 SQLITE_OPEN_FULL_MUTEX（brief 写作 SQLITE_OPEN_FULLMUTEX，最小偏离）。
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_FULL_MUTEX,
    )
    .map_err(|e| format!("只读打开主库失败: {e}"))
}

/// 读写打开主库：仅供 AI 复盘/计划写 ai_review、plan、plan_instruction 等 v2.0 新表。
/// 与前端 plugin-sql 主连接并存，SQLite 库级写锁串行短事务即可（不改 journal 模式）。
pub fn open_readwrite(dir: &Path) -> Result<Connection, String> {
    let p = main_db_path(dir);
    if !p.exists() {
        return Err("本地主库尚不存在，请先在应用中初始化行情数据".to_string());
    }
    Connection::open_with_flags(
        &p,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_FULL_MUTEX,
    )
    .map_err(|e| format!("读写打开主库失败: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_db_returns_chinese_error() {
        let dir = std::env::temp_dir().join(format!("tickgold-maindb-missing-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let err = open_readonly(&dir).unwrap_err();
        assert!(err.contains("本地主库尚不存在"), "实际: {err}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
