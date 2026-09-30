// 巨潮资讯公告查询：www.cninfo.com.cn/new/hisAnnouncement/query（公开 POST 表单，JSON 响应）。
// 只保留标题/时间/原文链接，不下载 PDF。
use crate::market::http;
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AnnounceItem {
    pub id: String,
    pub code: String,
    pub name: String,
    pub title: String,
    pub time: i64, // 毫秒
    pub url: String,
    pub category: String,
}

#[derive(Deserialize, Default, Debug)]
struct RawAnnouncement {
    #[serde(rename = "announcementId")] announcement_id: Option<String>,
    #[serde(rename = "secCode")] sec_code: Option<String>,
    #[serde(rename = "secName")] sec_name: Option<String>,
    #[serde(rename = "announcementTitle")] title: Option<String>,
    #[serde(rename = "announcementTime")] announcement_time: Option<i64>,
    #[serde(rename = "adjunctUrl")] adjunct_url: Option<String>,
    #[serde(rename = "announcementTypeName")] category: Option<String>,
}

#[derive(Deserialize, Default, Debug)]
struct AnnounceResp {
    announcements: Option<Vec<RawAnnouncement>>,
}

fn parse_announcements(json_str: &str) -> Vec<AnnounceItem> {
    let j: AnnounceResp = match serde_json::from_str(json_str) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    j.announcements
        .unwrap_or_default()
        .iter()
        .filter_map(|r| {
            let id = r.announcement_id.clone()?;
            let url = format!(
                "https://static.cninfo.com.cn/{}",
                r.adjunct_url.clone().unwrap_or_default()
            );
            Some(AnnounceItem {
                id,
                code: r.sec_code.clone().unwrap_or_default(),
                name: r.sec_name.clone().unwrap_or_default(),
                title: r.title.clone().unwrap_or_default(),
                time: r.announcement_time.unwrap_or(0),
                url,
                category: r.category.clone().unwrap_or_default(),
            })
        })
        .collect()
}

pub async fn announcements(date: String, page_size: u32) -> Result<Vec<AnnounceItem>, String> {
    // date 形如 2026-09-30；接口 seDate 支持单日区间 a~a
    let se_date = format!("{}~{}", date, date);
    let body = format!(
        "pageNum=1&pageSize={}&column=szse&tabName=fulltext&plate=&stock=&searchkey=&secid=&category=&trade=&seDate={}&sortName=&sortType=&isHLtitle=true",
        page_size, se_date
    );
    let resp = tokio::time::timeout(
        Duration::from_secs(20),
        http()
            .post("https://www.cninfo.com.cn/new/hisAnnouncement/query")
            .header("Accept", "application/json, text/javascript, */*; q=0.01")
            .header("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8")
            .header("Origin", "https://www.cninfo.com.cn")
            .header("Referer", "https://www.cninfo.com.cn/new/commonUrl/pageOfSearch?url=disclosure/list/search")
            .header("X-Requested-With", "XMLHttpRequest")
            .body(body)
            .send(),
    )
    .await
    .map_err(|_| "请求超时".to_string())?
    .map_err(|e| e.to_string())?;
    let text = resp.text().await.map_err(|e| e.to_string())?;
    Ok(parse_announcements(&text))
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = r#"{
      "announcements": [{
        "announcementId": "123", "secCode": "300001", "secName": "示例公司",
        "announcementTitle": "关于签订重大合同的公告", "announcementTime": 1780000000000,
        "adjunctUrl": "finalpage/2026-09-30/123.PDF", "announcementTypeName": "重大合同"
      }, {
        "announcementId": null, "secCode": null, "secName": null,
        "announcementTitle": null, "announcementTime": null,
        "adjunctUrl": null, "announcementTypeName": null
      }]
    }"#;

    #[test]
    fn parses_valid_rows_and_skips_incomplete() {
        let out = parse_announcements(FIXTURE);
        assert_eq!(out.len(), 1, "缺 id 的行应跳过");
        assert_eq!(out[0].code, "300001");
        assert_eq!(out[0].title, "关于签订重大合同的公告");
        assert!(out[0].url.starts_with("https://static.cninfo.com.cn/finalpage/"));
        assert_eq!(out[0].category, "重大合同");
    }

    #[test]
    fn returns_empty_for_bad_json() {
        assert!(parse_announcements("not json").is_empty());
        assert!(parse_announcements("{}").is_empty());
    }
}
