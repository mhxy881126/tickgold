// 巨潮资讯公告查询：www.cninfo.com.cn/new/hisAnnouncement/query（公开 POST 表单，JSON 响应）。
// 只保留标题/时间/原文链接，不下载 PDF。
use crate::market::http;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
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

/// 跨页 / 跨板块防御性合并：同 announcementId 只保留首次出现。
fn merge_unique(acc: &mut Vec<AnnounceItem>, seen: &mut HashSet<String>, rows: Vec<AnnounceItem>) {
    for item in rows {
        if seen.insert(item.id.clone()) {
            acc.push(item);
        }
    }
}

/// 单页公告请求（column 留空=全市场；plate 分 sh/sz/bj；20s 超时，保留既有请求头）。
async fn announcements_page(
    se_date: &str,
    plate: &str,
    page_no: u32,
    page_size: u32,
) -> Result<Vec<AnnounceItem>, String> {
    // 实测（2026-10-01）：column 留空时服务端确实返回全市场（含港股 5 位代码与沪深京 A 股），
    // 但默认排序把港股排在最前面、且 pageSize 被服务端硬截为 30（传 50/100 同样 30 行），
    // 裸翻前 10 页全是港股、零 A 股。改用 plate=sh/sz/bj 三个全 A 股分片翻页，各分片
    // 首行实测分别为 688xxx/300xxx/920xxx，纯净覆盖沪 / 深 / 北交所。
    let body = format!(
        "pageNum={}&pageSize={}&column=&tabName=fulltext&plate={}&stock=&searchkey=&secid=&category=&trade=&seDate={}&sortName=&sortType=&isHLtitle=true",
        page_no, page_size, plate, se_date
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

pub async fn announcements(date: String, page_size: u32) -> Result<Vec<AnnounceItem>, String> {
    // date 形如 2026-09-30；接口 seDate 支持单日区间 a~a
    let se_date = format!("{}~{}", date, date);
    // 服务端单页硬上限 30（pageSize=50/100 均被截为 30），调用方传 100 也夹到 30
    let want = page_size.clamp(1, 30);
    // 每板块最多 10 页（≤300 行），三分片合计上限约 900 行；到短页（末页）即停
    const MAX_PAGES_PER_PLATE: u32 = 10;

    let mut all: Vec<AnnounceItem> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut last_err = String::new();
    let mut ok_any = false;

    for plate in ["sh", "sz", "bj"] {
        for page_no in 1..=MAX_PAGES_PER_PLATE {
            match announcements_page(&se_date, plate, page_no, want).await {
                Ok(rows) => {
                    ok_any = true;
                    let got = rows.len() as u32;
                    merge_unique(&mut all, &mut seen, rows);
                    // 短页 = 该板块已翻到末页
                    if got < want {
                        break;
                    }
                }
                Err(e) => {
                    // 单页失败不致命：记录后直接结束本板块翻页（避免在错误页上空转）
                    log::warn!("公告 {plate} 第 {page_no} 页拉取失败: {e}");
                    last_err = e;
                    break;
                }
            }
        }
    }

    // 三个分片全部失败才报错；部分成功则返回已拿到的部分
    if !ok_any {
        Err(if last_err.is_empty() {
            "公告拉取失败".to_string()
        } else {
            last_err
        })
    } else {
        Ok(all)
    }
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

    #[test]
    fn merge_unique_dedupes_by_id_across_pages() {
        let mk = |id: &str| AnnounceItem {
            id: id.to_string(),
            code: "600001".to_string(),
            ..Default::default()
        };
        let mut acc: Vec<AnnounceItem> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        // 第一页 a,b；第二页 b(重复),c
        merge_unique(&mut acc, &mut seen, vec![mk("a"), mk("b")]);
        merge_unique(&mut acc, &mut seen, vec![mk("b"), mk("c")]);
        assert_eq!(acc.iter().map(|x| x.id.clone()).collect::<Vec<_>>(), vec!["a", "b", "c"]);
    }
}
