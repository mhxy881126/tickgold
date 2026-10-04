// 权限匹配：scope 校验 + HTTP host/路径白名单 + 私网拦截。
use reqwest::Url;

/// 是否拥有某个命名 scope。
pub fn has_scope(perms: &[String], scope: &str) -> bool {
    perms.iter().any(|p| p == scope)
}

/// 判断 host 是否为本地 / 私有 / 链路本地（禁止插件访问内网与本机）。
fn is_blocked_host(url: &Url) -> bool {
    match url.host() {
        None => true,
        Some(url::Host::Domain(d)) => {
            let d = d.to_ascii_lowercase();
            d == "localhost" || d.ends_with(".localhost") || d.ends_with(".local")
        }
        Some(url::Host::Ipv4(ip)) => {
            ip.is_loopback()
                || ip.is_private()
                || ip.is_link_local()
                || ip.is_broadcast()
                || ip.is_documentation()
                || ip.is_unspecified()
        }
        Some(url::Host::Ipv6(ip)) => ip.is_loopback() || ip.is_unspecified() || ip.is_multicast(),
    }
}

/// 校验目标 URL 是否被某条 http(s) 权限覆盖；同时拦截私网/本机。
pub fn check_http(perms: &[String], raw_url: &str) -> Result<(), String> {
    let url = Url::parse(raw_url).map_err(|e| format!("非法 URL：{e}"))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("仅允许 http/https".to_string());
    }
    if is_blocked_host(&url) {
        return Err("禁止访问本机 / 内网 / 链路本地地址".to_string());
    }
    for pat in perms.iter().filter(|p| p.starts_with("http://") || p.starts_with("https://")) {
        let purl = Url::parse(pat.trim_end_matches('*'))
            .map_err(|e| format!("权限条目非法：{pat}（{e}）"))?;
        let same_origin = purl.scheme() == url.scheme()
            && purl.host_str() == url.host_str()
            && purl.port_or_known_default() == url.port_or_known_default();
        if !same_origin {
            continue;
        }
        let pat_path = purl.path();
        // 无 '*'：要求路径完全相等或位于其目录下；有 '*'：前缀匹配。
        let ok = if pat.ends_with('*') {
            url.path().starts_with(pat_path)
        } else {
            url.path() == pat_path
        };
        if ok {
            return Ok(());
        }
    }
    Err(format!("未授权访问该地址：{raw_url}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn perms(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn scope_check() {
        let p = perms(&["quotes:read", "store"]);
        assert!(has_scope(&p, "store"));
        assert!(!has_scope(&p, "signal:create"));
    }

    #[test]
    fn http_allows_authorized_host() {
        let p = perms(&["https://api.example.com/*"]);
        assert!(check_http(&p, "https://api.example.com/v1/a").is_ok());
        assert!(check_http(&p, "https://evil.com/v1/a").is_err());
    }

    #[test]
    fn http_blocks_private_and_localhost() {
        let p = perms(&["http://127.0.0.1/*", "http://192.168.1.1/*", "http://localhost/*"]);
        assert!(check_http(&p, "http://127.0.0.1/x").is_err());
        assert!(check_http(&p, "http://192.168.1.1/x").is_err());
        assert!(check_http(&p, "http://localhost/x").is_err());
    }

    #[test]
    fn http_prevends_host_suffix_spoof() {
        // a.com 的授权不得覆盖 a.com.evil.com
        let p = perms(&["https://a.com/*"]);
        assert!(check_http(&p, "https://a.com.evil.com/x").is_err());
    }

    #[test]
    fn http_exact_path_without_wildcard() {
        let p = perms(&["https://h.com/data"]);
        assert!(check_http(&p, "https://h.com/data").is_ok());
        assert!(check_http(&p, "https://h.com/data/2").is_err());
    }
}
