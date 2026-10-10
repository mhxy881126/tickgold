// 内置浏览器专用本地 HTTP/HTTPS 代理。
// WebView2 在部分 Windows 环境（安全软件过滤）下无法直接访问外网，
// 通过本代理（127.0.0.1 回环）转发所有请求，走 reqwest/TcpStream 出站。
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::thread;

/// 启动本地代理，返回监听端口。
pub fn start_proxy() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| format!("代理端口绑定失败: {e}"))?;
    let port = listener.local_addr().map_err(|e| format!("获取代理端口失败: {e}"))?.port();

    thread::Builder::new()
        .name("tg-http-proxy".to_string())
        .spawn(move || {
            for incoming in listener.incoming() {
                match incoming {
                    Ok(client) => {
                        thread::spawn(move || {
                            if let Err(e) = handle_client(client) {
                                log::debug!("代理连接处理结束: {e}");
                            }
                        });
                    }
                    Err(e) => log::warn!("代理接受连接失败: {e}"),
                }
            }
        })
        .map_err(|e| format!("代理线程启动失败: {e}"))?;

    log::info!("内置浏览器代理已启动: 127.0.0.1:{port}");
    Ok(port)
}

fn handle_client(mut client: TcpStream) -> Result<(), String> {
    client.set_read_timeout(Some(std::time::Duration::from_secs(30))).ok();
    client.set_write_timeout(Some(std::time::Duration::from_secs(30))).ok();

    // 读取请求行 + 头部
    let mut buf = [0u8; 8192];
    let n = client.read(&mut buf).map_err(|e| e.to_string())?;
    if n == 0 {
        return Err("空请求".to_string());
    }
    let request_text = String::from_utf8_lossy(&buf[..n]).to_string();
    let first_line = request_text.lines().next().unwrap_or("");
    let parts: Vec<&str> = first_line.split_whitespace().collect();
    if parts.len() < 2 {
        return Err(format!("非法请求行: {first_line}"));
    }
    let method = parts[0];
    let target = parts[1];

    if method.eq_ignore_ascii_case("CONNECT") {
        // HTTPS 隧道
        let addr = if target.contains(':') {
            target.to_string()
        } else {
            format!("{target}:443")
        };
        match TcpStream::connect(&addr) {
            Ok(mut remote) => {
                remote.set_read_timeout(Some(std::time::Duration::from_secs(120))).ok();
                remote.set_write_timeout(Some(std::time::Duration::from_secs(120))).ok();
                let _ = client.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n");
                // 双向转发
                let mut client_clone = client.try_clone().map_err(|e| e.to_string())?;
                let mut remote_clone = remote.try_clone().map_err(|e| e.to_string())?;
                let h1 = thread::spawn(move || {
                    let _ = std::io::copy(&mut client_clone, &mut remote_clone);
                });
                let _ = std::io::copy(&mut remote, &mut client);
                let _ = h1.join();
                Ok(())
            }
            Err(e) => {
                let _ = client.write_all(format!("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n").as_bytes());
                Err(format!("连接 {addr} 失败: {e}"))
            }
        }
    } else {
        // HTTP 明文转发
        let url = if target.starts_with("http://") {
            target.to_string()
        } else {
            // 从 Host 头补全
            let host = request_text
                .lines()
                .find(|l| l.to_lowercase().starts_with("host:"))
                .and_then(|l| l.split_once(':'))
                .map(|(_, v)| v.trim())
                .unwrap_or("");
            if host.is_empty() {
                return Err("HTTP 请求缺少 Host 头".to_string());
            }
            format!("http://{host}{target}")
        };

        match reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(60))
            .build()
        {
            Ok(http_client) => {
                let mut req_builder = match method {
                    "GET" => http_client.get(&url),
                    "POST" => http_client.post(&url),
                    "PUT" => http_client.put(&url),
                    "DELETE" => http_client.delete(&url),
                    "HEAD" => http_client.head(&url),
                    "PATCH" => http_client.patch(&url),
                    _ => http_client.get(&url),
                };
                // 转发头部（跳过 hop-by-hop）
                for line in request_text.lines().skip(1) {
                    if let Some((k, v)) = line.split_once(':') {
                        let kl = k.to_lowercase();
                        if !matches!(kl.as_str(), "host" | "proxy-connection" | "content-length" | "connection") {
                            req_builder = req_builder.header(k.trim(), v.trim());
                        }
                    }
                }
                // 转发 body（如果有）
                if let Some(body_start) = request_text.find("\r\n\r\n") {
                    let body = &request_text[body_start + 4..];
                    if !body.is_empty() {
                        req_builder = req_builder.body(body.to_string());
                    }
                }

                match req_builder.send() {
                    Ok(resp) => {
                        let status = resp.status();
                        let mut resp_text = format!("HTTP/1.1 {} {}\r\n", status.as_u16(), status.canonical_reason().unwrap_or(""));
                        for (k, v) in resp.headers() {
                            let kl = k.as_str().to_lowercase();
                            if !matches!(kl.as_str(), "transfer-encoding" | "connection" | "content-encoding") {
                                if let Ok(vv) = v.to_str() {
                                    resp_text.push_str(&format!("{}: {}\r\n", k.as_str(), vv));
                                }
                            }
                        }
                        let body = resp.bytes().unwrap_or_default();
                        resp_text.push_str(&format!("Content-Length: {}\r\n\r\n", body.len()));
                        let _ = client.write_all(resp_text.as_bytes());
                        let _ = client.write_all(&body);
                        Ok(())
                    }
                    Err(e) => {
                        let _ = client.write_all(format!("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n").as_bytes());
                        Err(format!("上游请求失败: {e}"))
                    }
                }
            }
            Err(e) => {
                let _ = client.write_all(format!("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n").as_bytes());
                Err(format!("HTTP 客户端构建失败: {e}"))
            }
        }
    }
}
