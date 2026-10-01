// OpenAI 兼容客户端：/chat/completions 流式 SSE、embeddings、models。
// Ollama 与云端各厂均走同一协议；Key 组 Authorization: Bearer（Ollama 忽略）。
use super::config::AiConfig;
use serde::Serialize;
use std::collections::BTreeMap;
use std::future::Future;
use std::pin::Pin;
use std::time::Instant;

pub struct ChatMsg {
    pub role: String,
    pub content: String,
}

#[derive(Serialize)]
struct ToolSchema<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    function: ToolFunction<'a>,
}
#[derive(Serialize)]
struct ToolFunction<'a> {
    name: &'a str,
    description: &'a str,
    parameters: &'a serde_json::Value,
}

pub struct ToolSpec {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}

#[derive(Clone, Debug, PartialEq)]
pub enum StreamEv {
    Delta(String),
    ToolFrag {
        index: i64,
        id: String,
        name: String,
        args: String,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub struct ToolAcc {
    pub id: String,
    pub name: String,
    pub args: String,
}

pub struct ToolCall {
    pub index: i64,
    pub id: String,
    pub name: String,
    pub args: String,
}

/// 跨 chunk 累积 delta.tool_calls（按 index 拼碎片）。
pub struct SseState {
    tools: BTreeMap<i64, ToolAcc>,
}

impl SseState {
    pub fn new() -> Self {
        SseState {
            tools: BTreeMap::new(),
        }
    }

    /// 喂入一条 SSE data 负载（不含 "data:" 前缀）。"[DONE]" 与空串直接 Ok。
    pub fn feed(&mut self, data: &str, on: &mut impl FnMut(StreamEv)) -> Result<(), String> {
        let data = data.trim();
        if data.is_empty() || data == "[DONE]" {
            return Ok(());
        }
        let v: serde_json::Value =
            serde_json::from_str(data).map_err(|e| format!("SSE JSON 解析失败: {e}; raw={data}"))?;
        let Some(delta) = v.pointer("/choices/0/delta") else {
            return Ok(()); // 非内容帧（如 role-only 首帧）忽略
        };
        if let Some(content) = delta.get("content").and_then(|x| x.as_str()) {
            if !content.is_empty() {
                on(StreamEv::Delta(content.to_string()));
            }
        }
        if let Some(arr) = delta.get("tool_calls").and_then(|x| x.as_array()) {
            for tc in arr {
                let index = tc.get("index").and_then(|x| x.as_i64()).unwrap_or(0);
                let entry = self.tools.entry(index).or_insert(ToolAcc {
                    id: String::new(),
                    name: String::new(),
                    args: String::new(),
                });
                if let Some(id) = tc.get("id").and_then(|x| x.as_str()) {
                    if !id.is_empty() {
                        entry.id = id.to_string();
                    }
                }
                if let Some(name) = tc.pointer("/function/name").and_then(|x| x.as_str()) {
                    if !name.is_empty() {
                        entry.name = name.to_string();
                    }
                }
                if let Some(frag) = tc.pointer("/function/arguments").and_then(|x| x.as_str()) {
                    // 与 content 分支一致：空 arguments 碎片（常见于首帧）不发事件，
                    // 否则测试期望 frags=2 实测=3（brief 代码与其测试矛盾，偏离见报告）。
                    if !frag.is_empty() {
                        entry.args.push_str(frag);
                        on(StreamEv::ToolFrag {
                            index,
                            id: entry.id.clone(),
                            name: entry.name.clone(),
                            args: frag.to_string(),
                        });
                    }
                }
            }
        }
        Ok(())
    }

    pub fn finish_tools(&self) -> Vec<ToolCall> {
        self.tools
            .iter()
            .map(|(i, a)| ToolCall {
                index: *i,
                id: a.id.clone(),
                name: a.name.clone(),
                args: a.args.clone(),
            })
            .collect()
    }
}

fn endpoint(cfg: &AiConfig, path: &str) -> String {
    format!("{}{}", cfg.base_url.trim_end_matches('/'), path)
}

fn auth_header(api_key: &Option<String>) -> Option<(&'static str, String)> {
    match api_key {
        Some(k) if !k.trim().is_empty() => Some(("Authorization", format!("Bearer {k}"))),
        _ => None,
    }
}

fn check_status(resp: reqwest::Response) -> Result<reqwest::Response, String> {
    let status = resp.status();
    if status.is_success() {
        Ok(resp)
    } else {
        let code = status.as_u16();
        let hint = match code {
            401 => "鉴权失败（401）：请检查云端 API Key",
            404 => "接口不存在（404）：请检查 base_url 与模型名",
            429 => "请求过多（429）：触发限流，请稍后再试",
            s if s >= 500 => "模型服务端错误（5xx）",
            _ => "HTTP 错误",
        };
        Err(format!("{hint}（{code}）"))
    }
}

/// 流式对话。on 回调实时收到文本增量与工具参数碎片；工具组装由 SseState。
pub async fn chat_stream(
    cfg: &AiConfig,
    api_key: &Option<String>,
    msgs: &[ChatMsg],
    tools: &[ToolSpec],
    on: &mut impl FnMut(StreamEv),
) -> Result<Vec<ToolCall>, String> {
    let messages: Vec<serde_json::Value> = msgs
        .iter()
        .map(|m| serde_json::json!({ "role": m.role, "content": m.content }))
        .collect();
    let tool_schemas: Vec<ToolSchema> = tools
        .iter()
        .map(|t| ToolSchema {
            kind: "function",
            function: ToolFunction {
                name: &t.name,
                description: &t.description,
                parameters: &t.parameters,
            },
        })
        .collect();
    let mut body = serde_json::json!({
        "model": cfg.chat_model,
        "messages": messages,
        "temperature": cfg.temperature,
        "stream": true,
    });
    if !tool_schemas.is_empty() {
        body["tools"] = serde_json::to_value(&tool_schemas).map_err(|e| e.to_string())?;
    }

    let client = reqwest::Client::builder()
        .user_agent("TickGold-AI/1.9")
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = client
        .post(endpoint(cfg, "/chat/completions"))
        .json(&body);
    if let Some((k, v)) = auth_header(api_key) {
        req = req.header(k, v);
    }
    let resp = tokio::time::timeout(std::time::Duration::from_secs(60), req.send())
        .await
        .map_err(|_| "连接模型超时（60s）：请确认 Ollama 已启动或网络可达".to_string())?
        .map_err(|e| format!("请求模型失败: {e}"))?;
    let mut resp = check_status(resp)?;

    let mut state = SseState::new();
    let mut buf = String::new();
    // reqwest 未启用 stream feature（Cargo.toml 仅 json/rustls-tls），
    // 故用核心 API chunk() 逐块读取（brief 原写 bytes_stream，偏离见报告）。
    while let Some(bytes) = resp
        .chunk()
        .await
        .map_err(|e| format!("读取模型流失败: {e}"))?
    {
        buf.push_str(&String::from_utf8_lossy(&bytes));
        while let Some(pos) = buf.find('\n') {
            let line: String = buf.drain(..=pos).collect();
            let line = line.trim();
            if let Some(rest) = line.strip_prefix("data:") {
                state.feed(rest, on)?;
            }
        }
    }
    // 尾部残余
    if let Some(rest) = buf.trim().strip_prefix("data:") {
        state.feed(rest, on)?;
    }
    // 返回本轮组装好的工具调用（空 Vec = 无工具调用 = 终轮）
    Ok(state.finish_tools())
}

pub struct ModelInfo {
    pub latency_ms: i64,
    pub models: Vec<String>,
}

pub async fn list_models(
    cfg: &AiConfig,
    api_key: &Option<String>,
) -> Result<ModelInfo, String> {
    let client = reqwest::Client::new();
    let mut req = client.get(endpoint(cfg, "/models"));
    if let Some((k, v)) = auth_header(api_key) {
        req = req.header(k, v);
    }
    let started = Instant::now();
    let resp = tokio::time::timeout(std::time::Duration::from_secs(10), req.send())
        .await
        .map_err(|_| {
            "连接超时（10s）：请确认 Ollama 已启动（默认 http://127.0.0.1:11434）".to_string()
        })?
        .map_err(|e| format!("请求失败: {e}"))?;
    let resp = check_status(resp)?;
    let v: serde_json::Value = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        resp.json::<serde_json::Value>(),
    )
    .await
    .map_err(|_| "读取响应超时".to_string())?
    .map_err(|e| format!("响应解析失败: {e}"))?;
    let mut models = vec![];
    if let Some(arr) = v.get("data").and_then(|x| x.as_array()) {
        for m in arr {
            if let Some(id) = m.get("id").and_then(|x| x.as_str()) {
                models.push(id.to_string());
            }
        }
    }
    models.sort();
    Ok(ModelInfo {
        latency_ms: started.elapsed().as_millis() as i64,
        models,
    })
}

/// 批量嵌入，返回与入参同序的向量。
pub async fn embed(
    cfg: &AiConfig,
    api_key: &Option<String>,
    texts: &[String],
) -> Result<Vec<Vec<f32>>, String> {
    if texts.is_empty() {
        return Ok(vec![]);
    }
    let client = reqwest::Client::new();
    let body = serde_json::json!({ "model": cfg.embed_model, "input": texts });
    let mut req = client.post(endpoint(cfg, "/embeddings")).json(&body);
    if let Some((k, v)) = auth_header(api_key) {
        req = req.header(k, v);
    }
    let resp = tokio::time::timeout(std::time::Duration::from_secs(30), req.send())
        .await
        .map_err(|_| "嵌入服务超时（30s）".to_string())?
        .map_err(|e| format!("嵌入请求失败: {e}"))?;
    let resp = check_status(resp)?;
    let v: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("嵌入响应解析失败: {e}"))?;
    let mut out: Vec<(i64, Vec<f32>)> = vec![];
    let Some(arr) = v.get("data").and_then(|x| x.as_array()) else {
        return Err("嵌入响应缺少 data 字段".to_string());
    };
    for item in arr {
        let index = item.get("index").and_then(|x| x.as_i64()).unwrap_or(0);
        let Some(emb) = item.get("embedding").and_then(|x| x.as_array()) else {
            return Err("嵌入向量字段缺失".to_string());
        };
        let vec: Vec<f32> = emb
            .iter()
            .map(|n| n.as_f64().map(|x| x as f32).unwrap_or(0.0))
            .collect();
        out.push((index, vec));
    }
    out.sort_by_key(|(i, _)| *i);
    Ok(out.into_iter().map(|(_, v)| v).collect())
}

pub trait Embedder: Send + Sync {
    fn embed<'a>(
        &'a self,
        texts: Vec<String>,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<Vec<f32>>, String>> + Send + 'a>>;
}

pub struct HttpEmbedder {
    pub cfg: AiConfig,
    pub api_key: Option<String>,
}
impl Embedder for HttpEmbedder {
    fn embed<'a>(
        &'a self,
        texts: Vec<String>,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<Vec<f32>>, String>> + Send + 'a>> {
        Box::pin(async move { embed(&self.cfg, &self.api_key, &texts).await })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_deltas_accumulate() {
        let mut st = SseState::new();
        let mut got = String::new();
        st.feed(
            r#"{"choices":[{"delta":{"role":"assistant","content":"今日"}}]}"#,
            &mut |e| if let StreamEv::Delta(s) = e { got.push_str(&s) },
        )
        .unwrap();
        st.feed(
            r#"{"choices":[{"delta":{"content":"涨停 72 家"}}]}"#,
            &mut |e| if let StreamEv::Delta(s) = e { got.push_str(&s) },
        )
        .unwrap();
        st.feed("[DONE]", &mut |_| {}).unwrap();
        assert_eq!(got, "今日涨停 72 家");
        assert!(st.finish_tools().is_empty());
    }

    #[test]
    fn tool_call_fragments_assemble_by_index() {
        let mut st = SseState::new();
        let frames = [
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"market_overview","arguments":""}}]}}]}"#,
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"date\":"}}]}}]}"#,
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":" \"2026-09-30\"}"}}]}}]}"#,
        ];
        let mut frags = 0;
        for f in frames {
            st.feed(f, &mut |e| {
                if let StreamEv::ToolFrag { .. } = e {
                    frags += 1;
                }
            })
            .unwrap();
        }
        assert_eq!(frags, 2);
        let calls = st.finish_tools();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].id, "call_1");
        assert_eq!(calls[0].name, "market_overview");
        let args: serde_json::Value = serde_json::from_str(&calls[0].args).unwrap();
        assert_eq!(args["date"], "2026-09-30");
    }

    #[test]
    fn embed_response_decodes_in_input_order() {
        let raw = serde_json::json!({
            "data": [
                {"index":1,"embedding":[0.0,1.0]},
                {"index":0,"embedding":[1.0,0.0]}
            ]
        });
        let mut out: Vec<(i64, Vec<f32>)> = vec![];
        for item in raw["data"].as_array().unwrap() {
            let index = item["index"].as_i64().unwrap();
            let v = item["embedding"]
                .as_array()
                .unwrap()
                .iter()
                .map(|n| n.as_f64().unwrap() as f32)
                .collect();
            out.push((index, v));
        }
        out.sort_by_key(|(i, _)| *i);
        let ordered: Vec<Vec<f32>> = out.into_iter().map(|(_, v)| v).collect();
        assert_eq!(ordered[0], vec![1.0, 0.0]);
        assert_eq!(ordered[1], vec![0.0, 1.0]);
    }

    /// 手写最小 HTTP mock（无外部依赖）：返回固定 SSE 文本，验证端到端流读取。
    #[tokio::test]
    async fn chat_stream_end_to_end_against_mock_http() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let sse = concat!(
            "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"你好\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"，世界\"}}]}\n\n",
            "data: [DONE]\n\n",
        );
        tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut req = vec![0u8; 1024];
            let _ = sock.read(&mut req).await;
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\n\r\n{}",
                sse.len(),
                sse
            );
            sock.write_all(resp.as_bytes()).await.unwrap();
        });
        let cfg = AiConfig {
            provider: "ollama".into(),
            base_url: format!("http://127.0.0.1:{port}/v1"),
            chat_model: "m".into(),
            embed_model: "e".into(),
            temperature: 0.3,
            enable_auto_index: true,
        };
        let mut text = String::new();
        let calls = chat_stream(&cfg, &None, &[], &[], &mut |e| {
            if let StreamEv::Delta(s) = e {
                text.push_str(&s);
            }
        })
        .await
        .unwrap();
        assert_eq!(text, "你好，世界");
        // 纯文本流返回空工具集
        assert!(calls.is_empty());
    }
}
