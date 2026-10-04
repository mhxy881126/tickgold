// 插件 manifest（plugin.json）解析与校验。
use serde::Deserialize;

/// 当前宿主支持的插件 API 大版本。不兼容则拒绝加载。
pub const CURRENT_API_VERSION: i64 = 1;

#[allow(dead_code)] // 协议字段：author/description/ui 等供前端与未来版本使用，Rust 端未必读取
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default = "default_api_version")]
    pub api_version: i64,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default)]
    pub main: Option<String>,
    #[serde(default)]
    pub ui: Option<String>,
    #[serde(default)]
    pub widgets: Vec<WidgetDecl>,
}

fn default_api_version() -> i64 {
    CURRENT_API_VERSION
}

#[allow(dead_code)] // 微件几何字段由前端解析使用，Rust 端不读取
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetDecl {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub min_w: i64,
    #[serde(default)]
    pub min_h: i64,
    #[serde(default)]
    pub default_w: i64,
    #[serde(default)]
    pub default_h: i64,
    #[serde(default = "default_binding")]
    pub binding: String, // stock / none
}

fn default_binding() -> String {
    "stock".to_string()
}

fn valid_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 80
        && s.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-')
}

impl Manifest {
    /// 结构 + 语义校验。返回所有问题（用于安装/启用时报错）。
    pub fn validate(&self) -> Result<(), String> {
        if !valid_id(&self.id) {
            return Err(format!("非法插件 id：{:?}（仅允许小写字母/数字/点/连字符）", self.id));
        }
        if self.name.trim().is_empty() {
            return Err("插件 name 不能为空".to_string());
        }
        if self.api_version != CURRENT_API_VERSION {
            return Err(format!(
                "插件 apiVersion={} 与宿主支持的 {} 不兼容",
                self.api_version, CURRENT_API_VERSION
            ));
        }
        for w in &self.widgets {
            if !valid_id(&w.id) {
                return Err(format!("插件 {} 含非法微件 id：{:?}", self.id, w.id));
            }
            if w.default_w <= 0 || w.default_h <= 0 {
                return Err(format!("插件 {} 微件 {} 尺寸必须为正", self.id, w.id));
            }
        }
        // 权限条目基本格式（具体 host 匹配在 permission.rs）
        for p in &self.permissions {
            let is_http = p.starts_with("http://") || p.starts_with("https://");
            let known = matches!(
                p.as_str(),
                "quotes:read"
                    | "kline:read"
                    | "watchlist:read"
                    | "signal:create"
                    | "store"
                    | "log"
                    | "dev:reload"
            );
            if !is_http && !known {
                return Err(format!("插件 {} 含未知权限条目：{p}", self.id));
            }
        }
        Ok(())
    }
}

/// 从 plugin.json 文本解析并校验。
pub fn parse_manifest(text: &str) -> Result<Manifest, String> {
    let m: Manifest =
        serde_json::from_str(text).map_err(|e| format!("plugin.json 解析失败: {e}"))?;
    m.validate()?;
    Ok(m)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_minimal_manifest() {
        let m = parse_manifest(
            r#"{"id":"com.x.y","name":"示例","version":"1.0.0","permissions":["quotes:read"]}"#,
        )
        .unwrap();
        assert_eq!(m.api_version, 1);
        assert!(m.validate().is_ok());
    }

    #[test]
    fn rejects_bad_id_and_version() {
        assert!(parse_manifest(r#"{"id":"Bad_Id","name":"x","version":"1"}"#).is_err());
        assert!(parse_manifest(r#"{"id":"a.b","name":"x","version":"1","apiVersion":9}"#).is_err());
    }

    #[test]
    fn rejects_unknown_scope() {
        assert!(parse_manifest(r#"{"id":"a.b","name":"x","version":"1","permissions":["root"]}"#).is_err());
    }
}
