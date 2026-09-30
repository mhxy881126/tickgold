// 互动易（深市 irm.cninfo.com.cn）与上证 e 互动（sns.sseinfo.com）增量。
// 两源均无稳定 SLA，故各自独立失败、整体降级为空/部分结果，绝不阻断盘后作业。
use crate::market::{http, now_millis};
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
    pub time: i64, // 毫秒
    pub url: String,
}

// ===== 上证 e 互动：端点校准后休眠（dormant since 2026-09）=====
// 2026-10-01 活探证据：
//   1) GET sns.sseinfo.com/ajax/feeds.do?type=10... 返回 200 但 Content-Type 为 text/html，
//      体为服务端渲染的 <div class="m_feed_item"> 片段，并非旧解析器假定的 JSON /data/feeds；
//      且时间仅有「昨天 17:02」「5分钟前」等相对中文串，没有毫秒时间戳；
//   2) /common/getMoreFeeds.do 返回 404。
// 在找到稳定 JSON（含可定位时间）前不再假装解析：fetch_sse 恒返回空，避免脏数据进盘后归因。
// 恢复时需重新校准：HTML 片段可解析（scraper 可用）但需把相对时间换算为毫秒并补测试。
pub const SSE_SOURCE_DORMANT: bool = true;

async fn fetch_sse() -> Vec<IrmItem> {
    // endpoints under calibration, dormant since 2026-09.
    // SSE_SOURCE_DORMANT=false 时在此恢复抓取（需先重新校准端点与相对时间换算）。
    if SSE_SOURCE_DORMANT {
        Vec::new()
    } else {
        Vec::new()
    }
}

// ===== 互动易（深市）：newircs/index/search 表单 POST，2026-10-01 活探校准 =====
// 前端 SPA（app.8d98be51335810b9edbf.js）真实调用：POST /newircs/index/search，
// sendType=formdata（application/x-www-form-urlencoded），query 带 _t=秒级时间戳；
// searchTypes: "1,11"=全部 "11"=已回复 "1"=未回复；响应 {results:[...], totalRecord}。
// 行内 pubDate / attachedPubDate 为「字符串毫秒」（如 "1790737453000"），需字符串转 i64。
fn ms_value(v: &Value) -> i64 {
    v.as_str()
        .and_then(|s| s.trim().parse::<i64>().ok())
        .or_else(|| v.as_i64())
        .unwrap_or(0)
}

fn parse_irm(json_str: &str) -> Vec<IrmItem> {
    let v: Value = match serde_json::from_str(json_str) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let rows = match v.get("results").and_then(|x| x.as_array()) {
        Some(rows) => rows,
        None => return Vec::new(),
    };
    let pick = |r: &Value, key: &str| -> String {
        r.get(key).and_then(|x| x.as_str()).unwrap_or("").trim().to_string()
    };
    let mut out = Vec::new();
    for r in rows {
        let code = pick(r, "stockCode");
        if code.is_empty() {
            continue;
        }
        let id = pick(r, "indexId");
        let answer = pick(r, "attachedContent");
        // 时间：已回复取回复时间，未回复取提问时间
        let answer_time = ms_value(&r.get("attachedPubDate").cloned().unwrap_or(Value::Null));
        let ask_time = ms_value(&r.get("pubDate").cloned().unwrap_or(Value::Null));
        let time = if answer_time > 0 { answer_time } else { ask_time };
        out.push(IrmItem {
            platform: "irm".to_string(),
            code,
            name: pick(r, "companyShortName"),
            question: pick(r, "mainContent"),
            answer,
            time,
            url: format!(
                "https://irm.cninfo.com.cn/ircs/question/questionDetail?questionId={}",
                id
            ),
        });
    }
    out
}

async fn fetch_irm() -> Vec<IrmItem> {
    // 逗号按 qs.stringify 行为编码为 %2C；_t 为秒级防缓存参数（SPA 拦截器自动附加）
    let url = format!(
        "https://irm.cninfo.com.cn/newircs/index/search?_t={}",
        now_millis() / 1000
    );
    let body = "pageNo=1&pageSize=20&searchTypes=1%2C11&highLight=true";
    let result = tokio::time::timeout(
        Duration::from_secs(15),
        http()
            .post(&url)
            .header("Referer", "https://irm.cninfo.com.cn/")
            .header("Origin", "https://irm.cninfo.com.cn")
            .header("X-Requested-With", "XMLHttpRequest")
            .header("Pragma", "no-cache")
            .header("Content-Type", "application/x-www-form-urlencoded")
            .body(body)
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

/// 合并两源：并发拉取；任一失败只丢自己的部分。SSE 当前休眠（恒空），仅互动易有数据。
pub async fn irm_latest() -> Vec<IrmItem> {
    let (a, b) = tokio::join!(fetch_irm(), fetch_sse());
    let mut all = a;
    all.extend(b);
    all
}

#[cfg(test)]
mod tests {
    use super::*;

    // 取自 2026-10-01 真实响应结构（字段 / 类型 / 字符串毫秒均为真）；
    // 个人信息（authorName/author 等）一律不含，问答文案为脱敏示意。
    const IRM_FIXTURE: &str = r#"{"pageNo":1,"pageSize":3,"totalRecord":66674,"totalPage":22225,"results":[
      {"indexId":"2370834430923747328","contentType":11,
       "stockCode":"300188","companyShortName":"国投智能",
       "mainContent":"董秘您好，请问截至 9 月 30 日公司股东人数是多少？",
       "attachedContent":"您好，截至 2026 年 9 月 30 日收盘，公司股东总户数为 42,501 户。",
       "pubDate":"1790737453000","attachedPubDate":"1790773505000"},
      {"indexId":"2360000000000000001","contentType":1,
       "stockCode":"000001","companyShortName":"平安银行",
       "mainContent":"请问公司下一步经营规划？",
       "attachedContent":"","pubDate":"1790600000000","attachedPubDate":null},
      {"indexId":"2360000000000000002","contentType":11,
       "companyShortName":"无代码公司","mainContent":"应被跳过",
       "attachedContent":"无代码","pubDate":"1790600001000","attachedPubDate":"1790600002000"}
    ]}"#;

    #[test]
    fn parses_irm_real_shape_string_ms() {
        let out = parse_irm(IRM_FIXTURE);
        assert_eq!(out.len(), 2, "缺 stockCode 的行应跳过");
        let r0 = &out[0];
        assert_eq!(r0.platform, "irm");
        assert_eq!(r0.code, "300188");
        assert_eq!(r0.name, "国投智能");
        assert!(r0.question.contains("股东人数"));
        assert!(r0.answer.contains("42,501"));
        // 字符串毫秒；已回复取 attachedPubDate
        assert_eq!(r0.time, 1790773505000);
        assert!(r0.url.contains("questionDetail?questionId=2370834430923747328"));

        // 未回复（attachedPubDate=null、answer 空）回退提问时间
        let r1 = &out[1];
        assert_eq!(r1.code, "000001");
        assert_eq!(r1.answer, "");
        assert_eq!(r1.time, 1790600000000);
    }

    #[test]
    fn ms_value_accepts_string_and_number() {
        assert_eq!(ms_value(&serde_json::json!("1790773505000")), 1790773505000);
        assert_eq!(ms_value(&serde_json::json!(1790773505000_i64)), 1790773505000);
        assert_eq!(ms_value(&serde_json::json!(null)), 0);
        assert_eq!(ms_value(&serde_json::json!("")), 0);
        assert_eq!(ms_value(&serde_json::json!("abc")), 0);
    }

    #[test]
    fn bad_input_yields_empty() {
        assert!(parse_irm("x").is_empty());
        assert!(parse_irm("{}").is_empty());
        assert!(parse_irm(r#"{"results":[]}"#).is_empty());
    }

    #[test]
    fn sse_source_marked_dormant() {
        assert!(SSE_SOURCE_DORMANT);
    }
}
