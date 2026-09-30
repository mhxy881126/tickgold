// 互动易（深市 irm.cninfo.com.cn）与上证 e 互动（sns.sseinfo.com）增量。
// 两源均无稳定 SLA，故各自独立失败、整体降级为空/部分结果，绝不阻断盘后作业。
use crate::market::http;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct IrmItem {
    pub platform: String, // "sse" | "irm"
    pub code: String,
    pub name: String,
    pub question: String,
    pub answer: String,
    pub time: i64,
    pub url: String,
}

// ===== 上证 e 互动：feeds.do AJAX（JSON）=====
fn parse_sse(json_str: &str) -> Vec<IrmItem> {
    let v: Value = match serde_json::from_str(json_str) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let feeds = v.pointer("/data/feeds").and_then(|x| x.as_array());
    let mut out = Vec::new();
    if let Some(feeds) = feeds {
        for f in feeds {
            let code = f.pointer("/question/stockCode").and_then(|x| x.as_str()).unwrap_or("");
            if code.is_empty() {
                continue;
            }
            let id = f.get("id").and_then(|x| x.as_i64()).unwrap_or(0);
            out.push(IrmItem {
                platform: "sse".to_string(),
                code: code.to_string(),
                name: f.pointer("/question/stockName").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                question: f.pointer("/question/content").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                answer: f.get("replyContent").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                time: f.get("pubDate").and_then(|x| x.as_i64()).unwrap_or(0),
                url: format!("https://sns.sseinfo.com/detail-{}", id),
            });
        }
    }
    out
}

async fn fetch_sse() -> Vec<IrmItem> {
    let url = "https://sns.sseinfo.com/ajax/feeds.do?type=10&pageSize=20&lastid=-1&show=1&page=1";
    let result = tokio::time::timeout(
        Duration::from_secs(15),
        http().get(url).header("Referer", "https://sns.sseinfo.com/").send(),
    )
    .await;
    match result {
        Ok(Ok(resp)) => match resp.text().await {
            Ok(text) => parse_sse(&text),
            Err(_) => Vec::new(),
        },
        _ => Vec::new(),
    }
}

// ===== 互动易（深市）：JSON 列表，字段宽容提取 =====
fn parse_irm(json_str: &str) -> Vec<IrmItem> {
    let v: Value = match serde_json::from_str(json_str) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    // 兼容两种包裹：{"data":{"rows":[...]}} 或 {"rows":[...]}
    let rows = v
        .pointer("/data/rows")
        .or_else(|| v.pointer("/rows"))
        .or_else(|| v.pointer("/data/list"))
        .and_then(|x| x.as_array());
    let mut out = Vec::new();
    if let Some(rows) = rows {
        for r in rows {
            let pick = |keys: &[&str]| -> String {
                for k in keys {
                    if let Some(s) = r.get(*k).and_then(|x| x.as_str()) {
                        return s.to_string();
                    }
                }
                String::new()
            };
            let code = pick(&["stockCode", "secCode", "code"]);
            if code.is_empty() {
                continue;
            }
            let id = pick(&["questionId", "id"]);
            out.push(IrmItem {
                platform: "irm".to_string(),
                code,
                name: pick(&["stockName", "secName", "shortName"]),
                question: pick(&["questionContent", "content", "question"]),
                answer: pick(&["replyContent", "answer", "reply"]),
                time: r
                    .get("pubTime")
                    .or_else(|| r.get("time"))
                    .and_then(|x| x.as_i64())
                    .unwrap_or(0),
                url: format!("https://irm.cninfo.com.cn/detail/{}", id),
            });
        }
    }
    out
}

async fn fetch_irm() -> Vec<IrmItem> {
    let url = "https://irm.cninfo.com.cn/newircs/index/questionList?pageNo=1&pageSize=20";
    let result = tokio::time::timeout(
        Duration::from_secs(15),
        http()
            .get(url)
            .header("Referer", "https://irm.cninfo.com.cn/")
            .header("X-Requested-With", "XMLHttpRequest")
            .send(),
    )
    .await;
    match result {
        Ok(Ok(resp)) => match resp.text().await {
            Ok(text) => parse_irm(&text),
            Err(_) => Vec::new(),
        },
        _ => Vec::new(),
    }
}

/// 合并两源：并发拉取；任一失败只丢自己的部分。
pub async fn irm_latest() -> Vec<IrmItem> {
    let (a, b) = tokio::join!(fetch_sse(), fetch_irm());
    let mut all = a;
    all.extend(b);
    all
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_sse_feeds() {
        let j = r#"{"data":{"feeds":[
          {"id":9, "pubDate": 1780000000000,
           "question":{"stockCode":"600001","stockName":"示例","content":"订单情况？"},
           "replyContent":"正常推进"}
        ]}}"#;
        let out = parse_sse(j);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].platform, "sse");
        assert_eq!(out[0].code, "600001");
        assert_eq!(out[0].answer, "正常推进");
        assert!(out[0].url.contains("detail-9"));
    }

    #[test]
    fn parses_irm_rows_and_skips_without_code() {
        let j = r#"{"data":{"rows":[
          {"questionId":"55","stockCode":"300001","stockName":"深示例",
           "questionContent":"产能？","replyContent":"扩产中","pubTime":1780000000000},
          {"questionId":"56"}
        ]}}"#;
        let out = parse_irm(j);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].platform, "irm");
        assert_eq!(out[0].code, "300001");
    }

    #[test]
    fn bad_input_yields_empty() {
        assert!(parse_sse("x").is_empty());
        assert!(parse_irm("x").is_empty());
    }
}
