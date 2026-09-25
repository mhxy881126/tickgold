// Rust 端分级日志：内存环形缓冲（最近 500 条），可经命令读取 / 清空 / 动态调级，供前端合并导出。
use log::{Level, LevelFilter, Log, Metadata, Record};
use serde::Serialize;
use std::collections::VecDeque;
use std::sync::Mutex;
use std::sync::OnceLock;

const CAP: usize = 500;

#[derive(Serialize, Clone)]
pub struct LogItem {
    pub ts: i64, // epoch ms
    pub level: String,
    pub target: String,
    pub msg: String,
}

struct MemLogger {
    buf: Mutex<VecDeque<LogItem>>,
}

static LOGGER: OnceLock<&'static MemLogger> = OnceLock::new();

pub fn init() {
    let logger: &'static MemLogger = Box::leak(Box::new(MemLogger {
        buf: Mutex::new(VecDeque::with_capacity(CAP)),
    }));
    if LOGGER.set(logger).is_ok() {
        log::set_logger(logger).expect("logger already set");
        log::set_max_level(LevelFilter::Info);
    }
}

impl Log for MemLogger {
    fn enabled(&self, metadata: &Metadata) -> bool {
        metadata.level() <= log::max_level()
    }

    fn log(&self, record: &Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let item = LogItem {
            ts: now_ms(),
            level: record.level().as_str().to_string(),
            target: record.target().to_string(),
            msg: record.args().to_string(),
        };
        let mut buf = self.buf.lock().unwrap();
        buf.push_back(item);
        while buf.len() > CAP {
            buf.pop_front();
        }
    }

    fn flush(&self) {}
}

/// 返回 min_level 及其以上（更严重）的日志；min_level 缺省返回全部。
pub fn records(min_level: Option<String>) -> Vec<LogItem> {
    let Some(&logger) = LOGGER.get() else {
        return vec![];
    };
    let threshold = min_level.and_then(|s| parse_level(&s));
    let buf = logger.buf.lock().unwrap();
    buf.iter()
        .filter(|i| match (&threshold, parse_level(&i.level)) {
            (Some(t), Some(l)) => l <= *t,
            (None, _) => true,
            _ => false,
        })
        .cloned()
        .collect()
}

pub fn clear() {
    if let Some(&logger) = LOGGER.get() {
        logger.buf.lock().unwrap().clear();
    }
}

pub fn set_level(level: &str) -> bool {
    if let Some(f) = parse_level_filter(level) {
        log::set_max_level(f);
        true
    } else {
        false
    }
}

fn parse_level(s: &str) -> Option<Level> {
    match s.to_lowercase().as_str() {
        "error" => Some(Level::Error),
        "warn" => Some(Level::Warn),
        "info" => Some(Level::Info),
        "debug" => Some(Level::Debug),
        "trace" => Some(Level::Trace),
        _ => None,
    }
}

fn parse_level_filter(s: &str) -> Option<LevelFilter> {
    match s.to_lowercase().as_str() {
        "off" => Some(LevelFilter::Off),
        "error" => Some(LevelFilter::Error),
        "warn" => Some(LevelFilter::Warn),
        "info" => Some(LevelFilter::Info),
        "debug" => Some(LevelFilter::Debug),
        "trace" => Some(LevelFilter::Trace),
        _ => None,
    }
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
