// 统一错误类型（v2.27）：替代各域 Result<T, String> 混用。
// 命令层直接返回 AppError：对前端序列化为字符串（与旧 String 错误体感一致），
// 域内可用变体匹配做"下钻"（downcast 等价物）。
// 存量命令按域逐步接入（v2.27 先接入 market::history），新代码一律用 AppError。
use serde::{Serialize, Serializer};
use std::fmt;

#[allow(dead_code)] // 随各域接入启用（v2.27 先接 history）
pub type AppResult<T> = Result<T, AppError>;

#[allow(dead_code)] // 变体按域逐步接入（v2.27 先接 history），全量接入后移除
#[derive(Debug)]
pub enum AppError {
    /// SQLite / 事务失败
    Db(String),
    /// 网络请求：状态码 + 信息
    Http { code: Option<u16>, msg: String },
    /// 报文/字段解析失败
    Parse(String),
    /// 配置读写或校验失败
    Config(String),
    /// 资源不存在（表/文件/标的）
    NotFound(String),
    /// 业务规则拒绝（参数非法、状态冲突等）
    Business(String),
    /// 第三方库 / 未归类错误
    External(String),
}

#[allow(dead_code)] // kind/http/parse 随各域接入启用
impl AppError {
    /// 域标签：供日志归类与跨域"下钻"。
    pub fn kind(&self) -> &'static str {
        match self {
            AppError::Db(_) => "db",
            AppError::Http { .. } => "http",
            AppError::Parse(_) => "parse",
            AppError::Config(_) => "config",
            AppError::NotFound(_) => "not_found",
            AppError::Business(_) => "business",
            AppError::External(_) => "external",
        }
    }

    pub fn http(code: u16, msg: impl Into<String>) -> Self {
        AppError::Http { code: Some(code), msg: msg.into() }
    }

    pub fn parse(msg: impl Into<String>) -> Self {
        AppError::Parse(msg.into())
    }

    pub fn business(msg: impl Into<String>) -> Self {
        AppError::Business(msg.into())
    }
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AppError::Db(m)
            | AppError::Parse(m)
            | AppError::Config(m)
            | AppError::NotFound(m)
            | AppError::Business(m)
            | AppError::External(m) => f.write_str(m),
            AppError::Http { code: Some(c), msg } => write!(f, "HTTP {c}: {msg}"),
            AppError::Http { code: None, msg } => write!(f, "HTTP: {msg}"),
        }
    }
}

impl std::error::Error for AppError {}

// 对前端序列化为纯字符串，invoke 侧 catch 得到的仍是错误文案。
impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

/// 存量 API 多返回 Result<_, String>：统一按业务错误收口。
impl From<String> for AppError {
    fn from(m: String) -> Self {
        AppError::Business(m)
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        AppError::Db(e.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        AppError::Parse(e.to_string())
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::External(e.to_string())
    }
}

impl From<tauri::Error> for AppError {
    fn from(e: tauri::Error) -> Self {
        AppError::External(e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_and_kind() {
        let e = AppError::Db("boom".into());
        assert_eq!(e.kind(), "db");
        assert_eq!(e.to_string(), "boom");
        let h = AppError::http(503, "down");
        assert_eq!(h.kind(), "http");
        assert_eq!(h.to_string(), "HTTP 503: down");
    }

    #[test]
    fn serializes_as_plain_string() {
        let e = AppError::business("拒绝");
        let json = serde_json::to_string(&e).unwrap();
        assert_eq!(json, "\"拒绝\"");
    }

    #[test]
    fn converts_from_rusqlite_and_downcasts_by_variant() {
        let src = rusqlite::Error::InvalidQuery;
        let e: AppError = src.into();
        // 跨域下钻：按变体匹配域
        assert!(matches!(e, AppError::Db(_)));
        assert_eq!(e.kind(), "db");
    }

    #[test]
    fn question_mark_operator_works() {
        fn inner() -> AppResult<i64> {
            let n: i64 = serde_json::from_str("123")?;
            Ok(n)
        }
        assert_eq!(inner().unwrap(), 123);

        fn fails() -> AppResult<i64> {
            let n: i64 = serde_json::from_str("not-a-number")?;
            Ok(n)
        }
        assert!(matches!(fails().unwrap_err(), AppError::Parse(_)));
    }
}
