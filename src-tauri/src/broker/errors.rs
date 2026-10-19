// P2-a 失败可解释：下单 / 提交路径的原始英文错误统一映射为中文。
// 只做文案包装，不改变提交、风控与审计逻辑；未命中的错误保留原文（仅去除首尾空白）。
// 调用方：broker_submit / broker_confirm_submit / broker_quick_order 的 Err 出口。
//
// 映射顺序按「最具体 → 最宽泛」排列：先 UNIQUE / no rows，再库忙，再超时，最后未连接。

/// 把常见原始错误映射为可读中文；未命中的保留原文（仅去除首尾空白）。
pub fn friendly(e: &str) -> String {
    let raw = e.trim();
    // 英文错误大小写不稳定（rusqlite / sidecar / Python 各有风格），统一按小写匹配。
    let lower = raw.to_ascii_lowercase();
    if lower.contains("unique constraint failed") {
        "重复提交：同方向票据已存在".to_string()
    } else if lower.contains("query returned no rows") {
        "未找到对应记录，请刷新后重试".to_string()
    } else if lower.contains("database is locked") || lower.contains("sqlite_busy") {
        "本地库忙，请稍后重试".to_string()
    } else if lower.contains("timeout") || lower.contains("timed out") || lower.contains("超时") {
        "券商通道超时，请检查连接".to_string()
    } else if lower.contains("not connected") {
        "券商未连接".to_string()
    } else {
        raw.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::friendly;

    #[test]
    fn errors_unique_constraint_is_duplicate_submit() {
        assert_eq!(
            friendly("UNIQUE constraint failed: signal_ticket.sig_id"),
            "重复提交：同方向票据已存在"
        );
    }

    #[test]
    fn errors_no_rows_asks_refresh() {
        assert_eq!(
            friendly("Query returned no rows"),
            "未找到对应记录，请刷新后重试"
        );
    }

    #[test]
    fn errors_db_locked_is_busy() {
        assert_eq!(friendly("database is locked"), "本地库忙，请稍后重试");
        assert_eq!(
            friendly("rusqlite: SQLITE_BUSY: database is locked"),
            "本地库忙，请稍后重试"
        );
    }

    #[test]
    fn errors_timeout_is_channel_timeout() {
        assert_eq!(friendly("request timeout"), "券商通道超时，请检查连接");
        assert_eq!(friendly("operation timed out"), "券商通道超时，请检查连接");
        assert_eq!(friendly("券商请求超时"), "券商通道超时，请检查连接");
    }

    #[test]
    fn errors_not_connected_is_disconnected() {
        assert_eq!(friendly("not connected"), "券商未连接");
        assert_eq!(friendly("Broker Not Connected"), "券商未连接");
    }

    #[test]
    fn errors_unknown_returns_trimmed_original() {
        assert_eq!(friendly("  下单失败：未知错误\n"), "下单失败：未知错误");
        assert_eq!(friendly(""), "");
    }
}
