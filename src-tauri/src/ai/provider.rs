// OpenAI 兼容客户端：/chat/completions 流式 SSE、embeddings、models。
// Ollama 与云端各厂均走同一协议；Key 组 Authorization: Bearer（Ollama 忽略）。
use super::config::AiConfig;
use serde::Serialize;
use std::collections::BTreeMap;
use std::future::Future;
use std::pin::Pin;
use std::time::Instant;

/// 回送 assistant 工具回合时 function.arguments 必须为 JSON 字符串（而非对象）。
#[derive(Serialize)]
pub struct AssistantToolFn {
    pub name: String,
    pub arguments: String,
}

/// assistant 消息中的单个 tool_calls 条目，形状严格对齐 OpenAI 协议。
#[derive(Serialize)]
pub struct AssistantToolCall {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String, // 恒为 "function"
    pub function: AssistantToolFn,
}

#[derive(Serialize)]
pub struct ChatMsg {
    pub role: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<AssistantToolCall>>,
    #[serde(rename = "tool_call_id", skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
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

/// 判断 URL 是否指向回环地址（localhost / 127.* / ::1）。
fn is_loopback_url(u: &url::Url) -> bool {
    matches!(u.host_str(), Some(h) if {
        let h = h.trim_start_matches('[').trim_end_matches(']');
        h.eq_ignore_ascii_case("localhost") || h == "::1" || h.starts_with("127.")
    })
}

/// 规范化 base_url：回环主机的 localhost 统一改写为 127.0.0.1，
/// 规避 Windows 上 localhost 先解析到 ::1、而本地服务只监听 IPv4 导致的连接失败。
fn normalize_base(raw: &str) -> String {
    let raw = raw.trim().trim_end_matches('/');
    if let Ok(mut u) = url::Url::parse(raw) {
        if is_loopback_url(&u) && u.host_str() != Some("127.0.0.1") {
            // set_host 只改主机，端口与路径保持不变
            let _ = u.set_host(Some("127.0.0.1"));
        }
        return u.as_str().trim_end_matches('/').to_string();
    }
    raw.to_string()
}

fn endpoint(cfg: &AiConfig, path: &str) -> String {
    format!("{}{}", normalize_base(&cfg.base_url), path)
}

/// 构建 reqwest 客户端。
/// - no_proxy=true：回环地址直连，绕过系统代理（代理软件残留配置是本地连接失败的常见原因）。
/// - no_proxy=false：沿用系统代理（公司网络 / 科学上网访问云端 API 时需要）。
fn build_client(no_proxy: bool) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder().user_agent("TickGold-AI/2.0");
    if no_proxy {
        builder = builder.no_proxy();
    }
    builder
        .build()
        .map_err(|e| format!("HTTP 客户端初始化失败: {e}"))
}

/// 字符串 URL 是否回环地址（解析失败按非回环处理）。
fn is_loopback_str(url: &str) -> bool {
    url::Url::parse(url).map(|u| is_loopback_url(&u)).unwrap_or(false)
}

/// 该目标 URL 应使用的代理策略：回环仅直连；远程先系统代理、再直连兜底。
fn proxy_modes_for(url: &str) -> Vec<bool> {
    if is_loopback_str(url) {
        vec![true]
    } else {
        vec![false, true]
    }
}

/// 请求层失败 → 中文可操作提示（reqwest 默认 error sending request 没有任何排查线索）。
fn friendly_request_err(e: reqwest::Error, url: &str) -> String {
    if e.is_connect() {
        format!(
            "无法连接到 {url}：请确认服务已启动、地址与端口正确（本地服务如 Ollama 是否运行；或代理/防火墙拦截了连接）"
        )
    } else if e.is_timeout() {
        format!("连接 {url} 超时：网络不可达或服务响应过慢")
    } else if e.is_request() {
        format!(
            "无法向 {url} 发出请求：{e}（若开启了代理软件，请关闭代理或将该地址加入直连后重试）"
        )
    } else {
        format!("请求失败: {e}")
    }
}

/// 解析模型列表，兼容两种主流形状：
/// - OpenAI 兼容 /models：`{"data":[{"id":"gpt-4o"}, ...]}`
/// - Ollama 原生 /api/tags：`{"models":[{"name":"qwen2.5:7b"}, ...]}`
fn parse_models(v: &serde_json::Value) -> Vec<String> {
    let mut models: Vec<String> = vec![];
    if let Some(arr) = v.get("data").and_then(|x| x.as_array()) {
        for m in arr {
            if let Some(id) = m.get("id").and_then(|x| x.as_str()) {
                if !id.is_empty() {
                    models.push(id.to_string());
                }
            }
        }
    } else if let Some(arr) = v.get("models").and_then(|x| x.as_array()) {
        for m in arr {
            if let Some(name) = m
                .get("name")
                .or_else(|| m.get("model"))
                .and_then(|x| x.as_str())
            {
                if !name.is_empty() {
                    models.push(name.to_string());
                }
            }
        }
    }
    models.sort();
    models.dedup();
    models
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
            401 => "鉴权失败（401）：请检查云端 API Key 是否正确",
            402 => "API 账户余额不足或配额已用尽（402）：请充值、更换 API Key 或联系服务商",
            404 => "接口不存在（404）：请检查 base_url 与模型名",
            429 => "请求过多（429）：触发限流，请稍后再试",
            s if s >= 500 => "模型服务端错误（5xx）",
            _ => "HTTP 错误",
        };
        Err(format!("{hint}（{code}）"))
    }
}

/// 把对话消息装配为 OpenAI /chat/completions 请求体的 messages 数组（纯函数，便于单测）。
/// 多轮工具调用协议要求严格配对：assistant 先带 tool_calls（此时 content 为 null），
/// 随后每条工具结果 role:"tool" 且带 tool_call_id；三者缺一则第 2 轮起云端 400。
/// Ollama 同样兼容此形状。
fn build_api_messages(msgs: &[ChatMsg]) -> Vec<serde_json::Value> {
    msgs.iter()
        .map(|m| {
            let mut v = serde_json::Map::new();
            v.insert("role".into(), serde_json::Value::String(m.role.clone()));
            match &m.tool_calls {
                // 工具回合的 assistant 消息：content 必须是 JSON null 而非空字符串，
                // 并附完整 tool_calls（id/type/function{name,arguments 字符串}）。
                Some(calls) => {
                    let content = if m.content.is_empty() {
                        serde_json::Value::Null
                    } else {
                        serde_json::Value::String(m.content.clone())
                    };
                    v.insert("content".into(), content);
                    v.insert(
                        "tool_calls".into(),
                        serde_json::to_value(calls).expect("AssistantToolCall 序列化不会失败"),
                    );
                }
                // 普通消息（system/user/assistant 文本/tool 结果）：content 恒为字符串。
                None => {
                    v.insert("content".into(), serde_json::Value::String(m.content.clone()));
                }
            }
            // role:"tool" 消息必须带与其前 assistant tool_calls 中相同的 id。
            if let Some(id) = &m.tool_call_id {
                v.insert(
                    "tool_call_id".into(),
                    serde_json::Value::String(id.clone()),
                );
            }
            serde_json::Value::Object(v)
        })
        .collect()
}

/// 流式对话。on 回调实时收到文本增量与工具参数碎片；工具组装由 SseState。
pub async fn chat_stream(
    cfg: &AiConfig,
    api_key: &Option<String>,
    msgs: &[ChatMsg],
    tools: &[ToolSpec],
    on: &mut impl FnMut(StreamEv),
) -> Result<Vec<ToolCall>, String> {
    let messages: Vec<serde_json::Value> = build_api_messages(msgs);
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

    let chat_url = endpoint(cfg, "/chat/completions");
    // 回环地址（本地 Ollama/网关）直连并绕过系统代理；远程沿用系统代理
    let client = build_client(is_loopback_str(&chat_url))?;
    let mut req = client.post(&chat_url).json(&body);
    if let Some((k, v)) = auth_header(api_key) {
        req = req.header(k, v);
    }
    let resp = tokio::time::timeout(std::time::Duration::from_secs(60), req.send())
        .await
        .map_err(|_| "连接模型超时（60s）：请确认 Ollama 已启动或网络可达".to_string())?
        .map_err(|e| friendly_request_err(e, &chat_url))?;
    let mut resp = check_status(resp)?;

    let mut state = SseState::new();
    // 字节缓冲（不是 String）：多字节 UTF-8（如中文）可能被 TCP 切到两个 chunk，
    // 若对每块直接 from_utf8_lossy 会产生永久 U+FFFD。必须先按 \n 切出完整行，
    // 再对整行做严格 UTF-8 解码；无换行的尾部残余可能是不完整字符，留给下一块。
    let mut buf: Vec<u8> = Vec::new();
    // reqwest 未启用 stream feature（Cargo.toml 仅 json/rustls-tls），
    // 故用核心 API chunk() 逐块读取（brief 原写 bytes_stream，偏离见报告）。
    loop {
        // 读空闲超时：每收到一块即重置（不是整轮总超时）。
        let chunk = tokio::time::timeout(std::time::Duration::from_secs(60), resp.chunk())
            .await
            .map_err(|_| "读取模型流超时（60s 无数据）".to_string())?
            .map_err(|e| format!("读取模型流失败: {e}"))?;
        let Some(bytes) = chunk else { break };
        buf.extend_from_slice(&bytes);
        while let Some(pos) = buf.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = buf.drain(..=pos).collect();
            if line.starts_with(b"data:") {
                let rest = std::str::from_utf8(&line[5..])
                    .map_err(|e| format!("SSE UTF-8 解析失败: {e}"))?;
                state.feed(rest.trim(), on)?;
            }
            // 非 data 行（注释/空行/事件行）忽略
        }
    }
    // 流结束后的尾部残余：正常情况下其中已无换行（完整行在上面都已 drain）。
    while let Some(pos) = buf.iter().position(|b| *b == b'\n') {
        let line: Vec<u8> = buf.drain(..=pos).collect();
        if line.starts_with(b"data:") {
            let rest = std::str::from_utf8(&line[5..])
                .map_err(|e| format!("SSE UTF-8 解析失败: {e}"))?;
            state.feed(rest.trim(), on)?;
        }
    }
    // 容忍服务端最后一帧不带尾换行：残余本身是一帧 data: 时解码一次。
    if buf.starts_with(b"data:") {
        let rest = std::str::from_utf8(&buf[5..])
            .map_err(|e| format!("SSE UTF-8 解析失败: {e}"))?;
        let rest = rest.trim();
        if !rest.is_empty() {
            state.feed(rest, on)?;
        }
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
    // 多候选端点：
    // - 标准 OpenAI 兼容：{base}/models（base 通常以 /v1 结尾）
    // - 用户漏填 /v1：补试 {base}/v1/models
    // - Ollama 原生服务（无 /v1）：{base}/api/tags，返回 models[].name
    let base = normalize_base(&cfg.base_url);
    let mut candidates: Vec<String> = vec![];
    if cfg.provider == "ollama" {
        if base.ends_with("/v1") {
            candidates.push(format!("{base}/models"));
        } else {
            candidates.push(format!("{base}/v1/models"));
            candidates.push(format!("{base}/api/tags"));
        }
    } else {
        candidates.push(format!("{base}/models"));
        if !base.ends_with("/v1") {
            candidates.push(format!("{base}/v1/models"));
            // 本地 OpenAI 兼容网关 / Ollama 形状服务的最后兜底
            candidates.push(format!("{base}/api/tags"));
        }
    }

    let started = Instant::now();
    let mut last_err = "未知错误".to_string();

    'next_candidate: for url in &candidates {
        // 回环仅直连（绕过代理）；远程先系统代理再直连兜底，覆盖代理软件残留导致的失败
        for no_proxy in proxy_modes_for(url) {
            let client = build_client(no_proxy)?;
            let mut req = client.get(url);
            if let Some((k, v)) = auth_header(api_key) {
                req = req.header(k, v);
            }
            let resp =
                match tokio::time::timeout(std::time::Duration::from_secs(8), req.send()).await {
                    Err(_) => {
                        last_err = format!("连接超时（8s）：{url}");
                        continue;
                    }
                    Ok(Err(e)) => {
                        last_err = friendly_request_err(e, url);
                        continue; // 连接层失败：换代理策略后重试
                    }
                    Ok(Ok(resp)) => resp,
                };
            // 404 = 路径不对（如 Ollama 无 /models），换下一个候选端点
            if resp.status() == reqwest::StatusCode::NOT_FOUND {
                last_err = format!("接口不存在（404）：{url}");
                continue 'next_candidate;
            }
            // 401/402/429/5xx 等属于确定性错误，直接把中文提示返回（不再试其他路径）
            let resp = check_status(resp)?;
            let v: serde_json::Value =
                match tokio::time::timeout(std::time::Duration::from_secs(8), async {
                    resp.json::<serde_json::Value>().await
                })
                .await
                {
                    Ok(Ok(v)) => v,
                    Ok(Err(e)) => {
                        last_err = format!("响应解析失败: {e}");
                        continue;
                    }
                    Err(_) => {
                        last_err = "读取响应超时（8s）".to_string();
                        continue;
                    }
                };
            let models = parse_models(&v);
            if models.is_empty() {
                last_err = format!("模型列表为空或响应格式无法识别：{url}");
                continue;
            }
            return Ok(ModelInfo {
                latency_ms: started.elapsed().as_millis() as i64,
                models,
            });
        }
    }

    Err(format!(
        "拉取模型列表失败：{last_err}；请检查 Base URL（OpenAI 兼容路径通常以 /v1 结尾，Ollama 默认 http://127.0.0.1:11434/v1）与 API Key"
    ))
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
    let embed_url = endpoint(cfg, "/embeddings");
    // 回环地址直连并绕过系统代理；远程沿用系统代理
    let client = build_client(is_loopback_str(&embed_url))?;
    let body = serde_json::json!({ "model": cfg.embed_model, "input": texts });
    let mut req = client.post(&embed_url).json(&body);
    if let Some((k, v)) = auth_header(api_key) {
        req = req.header(k, v);
    }
    let resp = tokio::time::timeout(std::time::Duration::from_secs(30), req.send())
        .await
        .map_err(|_| "嵌入服务超时（30s）".to_string())?
        .map_err(|e| friendly_request_err(e, &embed_url))?;
    let resp = check_status(resp)?;
    let v: serde_json::Value = tokio::time::timeout(std::time::Duration::from_secs(30), async {
        resp.json::<serde_json::Value>().await
    })
    .await
    .map_err(|_| "读取嵌入响应超时（30s）".to_string())?
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
        // 数据完整性：非数字元素不能静默置 0.0（会造成向量静默错位/污染）。
        let mut vec: Vec<f32> = Vec::with_capacity(emb.len());
        for n in emb {
            let x = n
                .as_f64()
                .ok_or_else(|| "嵌入向量含非数字元素".to_string())?;
            vec.push(x as f32);
        }
        out.push((index, vec));
    }
    out.sort_by_key(|(i, _)| *i);
    // 排序后再比条数：服务端少返回/多返回都属于数据完整性错误，不可静默截断或补零。
    if out.len() != texts.len() {
        return Err(format!(
            "嵌入返回条数 {} 与请求 {} 不符",
            out.len(),
            texts.len()
        ));
    }
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

    /// M1：工具回合消息必须严格按 OpenAI 协议配对——
    /// assistant(content=null + tool_calls) → tool(tool_call_id) → 下一轮 user。
    #[test]
    fn tool_round_messages_serialize_openai_shape() {
        let msgs = vec![
            ChatMsg {
                role: "assistant".into(),
                content: String::new(),
                tool_calls: Some(vec![AssistantToolCall {
                    id: "call_9".into(),
                    kind: "function".into(),
                    function: AssistantToolFn {
                        name: "market_overview".into(),
                        arguments: r#"{"date":"2026-09-30"}"#.into(),
                    },
                }]),
                tool_call_id: None,
            },
            ChatMsg {
                role: "tool".into(),
                content: "[market_overview 结果]\n涨停 72 家".into(),
                tool_calls: None,
                tool_call_id: Some("call_9".into()),
            },
            ChatMsg {
                role: "user".into(),
                content: "继续".into(),
                tool_calls: None,
                tool_call_id: None,
            },
        ];
        let v = serde_json::to_value(&build_api_messages(&msgs)).unwrap();
        let arr = v.as_array().unwrap();
        assert_eq!(arr.len(), 3);

        // assistant：content === null（不是空串），tool_calls 形状完整
        let a = &arr[0];
        assert_eq!(a["role"], "assistant");
        assert!(a["content"].is_null(), "工具回合 assistant content 必须为 null");
        assert_eq!(a["tool_calls"].as_array().unwrap().len(), 1);
        let tc = &a["tool_calls"][0];
        assert_eq!(tc["id"], "call_9");
        assert_eq!(tc["type"], "function");
        assert_eq!(tc["function"]["name"], "market_overview");
        assert!(
            tc["function"]["arguments"].is_string(),
            "function.arguments 必须是 JSON 字符串而非对象"
        );
        let args: serde_json::Value =
            serde_json::from_str(tc["function"]["arguments"].as_str().unwrap()).unwrap();
        assert_eq!(args["date"], "2026-09-30");

        // tool：带同一 tool_call_id，且不得带 tool_calls 键
        let t = &arr[1];
        assert_eq!(t["role"], "tool");
        assert_eq!(t["content"], "[market_overview 结果]\n涨停 72 家");
        assert_eq!(t["tool_call_id"], "call_9");
        assert!(t.get("tool_calls").is_none(), "tool 消息不得带 tool_calls");

        // 普通 user：恰好只有 role/content 两个键
        let u = &arr[2];
        assert_eq!(u["role"], "user");
        assert_eq!(u["content"], "继续");
        let keys: std::collections::BTreeSet<&String> =
            u.as_object().unwrap().keys().collect();
        assert_eq!(
            keys,
            [&"role".to_string(), &"content".to_string()]
                .into_iter()
                .collect()
        );
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

    /// 手写最小 HTTP mock（仅 127.0.0.1 回环，不触外网）。
    /// shard=Some(n) 时把响应体按每 n 字节 write+flush 分片（片间 sleep 1ms）。
    async fn spawn_loopback_mock(content_type: &str, body: String, shard: Option<usize>) -> u16 {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let content_type = content_type.to_string();
        tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut req = vec![0u8; 4096];
            let _ = sock.read(&mut req).await;
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\n\r\n",
                body.len()
            );
            sock.write_all(head.as_bytes()).await.unwrap();
            match shard {
                Some(n) => {
                    for part in body.as_bytes().chunks(n) {
                        sock.write_all(part).await.unwrap();
                        sock.flush().await.unwrap();
                        tokio::time::sleep(std::time::Duration::from_millis(1)).await;
                    }
                }
                None => {
                    sock.write_all(body.as_bytes()).await.unwrap();
                }
            }
        });
        port
    }

    fn test_cfg(port: u16) -> AiConfig {
        AiConfig {
            provider: "ollama".into(),
            base_url: format!("http://127.0.0.1:{port}/v1"),
            chat_model: "m".into(),
            embed_model: "e".into(),
            temperature: 0.3,
            enable_auto_index: true,
        }
    }

    /// I-1 回归：中文多字节字符被 TCP 按每 3 字节切到不同 chunk 时，
    /// 字节缓冲必须拼回完整 UTF-8，不得出现 U+FFFD。
    #[tokio::test]
    async fn chat_stream_chinese_split_across_byte_chunks() {
        const CONTENT: &str = "今日涨停 72 家，情绪回暖";
        let sse = format!(
            "data: {{\"choices\":[{{\"delta\":{{\"role\":\"assistant\",\"content\":\"{CONTENT}\"}}}}]}}\n\ndata: [DONE]\n\n"
        );
        // 前置 ASCII（SSE 帧头 + JSON 键）使 3 字节边界必然切中多字节中文字符。
        let port = spawn_loopback_mock("text/event-stream", sse, Some(3)).await;
        let cfg = test_cfg(port);
        let mut text = String::new();
        let calls = chat_stream(&cfg, &None, &[], &[], &mut |e| {
            if let StreamEv::Delta(s) = e {
                text.push_str(&s);
            }
        })
        .await
        .unwrap();
        assert_eq!(text, CONTENT, "中文跨 chunk 后必须逐字相等");
        assert!(
            !text.contains('\u{FFFD}'),
            "不得出现 U+FFFD 替换字符，实际: {text}"
        );
        assert!(calls.is_empty(), "纯文本流不应产生工具调用");
    }

    /// M-4：embed 按响应 index 还原为请求顺序（index 1 在前后 0 在前）。
    #[tokio::test]
    async fn embed_end_to_end_reorders_by_index() {
        let body = serde_json::json!({
            "object": "list",
            "model": "e",
            "data": [
                {"index": 1, "embedding": [0.25, 0.5]},
                {"index": 0, "embedding": [0.75, 1.0]}
            ]
        })
        .to_string();
        let port = spawn_loopback_mock("application/json", body, None).await;
        let cfg = test_cfg(port);
        let out = embed(
            &cfg,
            &None,
            &["a".to_string(), "b".to_string()],
        )
        .await
        .unwrap();
        assert_eq!(out.len(), 2);
        // a（index 0）→ [0.75, 1.0]；b（index 1）→ [0.25, 0.5]
        assert_eq!(out[0], vec![0.75_f32, 1.0_f32]);
        assert_eq!(out[1], vec![0.25_f32, 0.5_f32]);
    }

    /// M-4：返回条数与请求不符必须报错，不得静默截断。
    #[tokio::test]
    async fn embed_count_mismatch_is_error() {
        let body = serde_json::json!({
            "object": "list",
            "model": "e",
            "data": [
                {"index": 0, "embedding": [0.75, 1.0]}
            ]
        })
        .to_string();
        let port = spawn_loopback_mock("application/json", body, None).await;
        let cfg = test_cfg(port);
        let err = embed(
            &cfg,
            &None,
            &["a".to_string(), "b".to_string()],
        )
        .await
        .unwrap_err();
        assert!(
            err.contains("嵌入返回条数 1 与请求 2 不符"),
            "条数不符错误信息不匹配: {err}"
        );
    }

    #[test]
    fn normalize_base_rewrites_localhost_to_ipv4_and_keeps_remote() {
        // localhost → 127.0.0.1，端口与路径保留
        assert_eq!(
            normalize_base("http://localhost:11434/"),
            "http://127.0.0.1:11434"
        );
        assert_eq!(
            normalize_base("http://localhost:11434/v1/"),
            "http://127.0.0.1:11434/v1"
        );
        // 已经是 IPv4 / 远程地址 / 非法地址保持原样（仅去空白与尾斜杠）
        assert_eq!(
            normalize_base("http://127.0.0.1:11434/v1"),
            "http://127.0.0.1:11434/v1"
        );
        assert_eq!(
            normalize_base("https://api.deepseek.com/v1/"),
            "https://api.deepseek.com/v1"
        );
        assert_eq!(normalize_base("not-a-url/"), "not-a-url");
    }

    #[test]
    fn parse_models_supports_openai_and_ollama_shapes() {
        let openai = serde_json::json!({
            "object": "list",
            "data": [{"id": "gpt-4o"}, {"id": "gpt-4o-mini"}, {"id": "gpt-4o"}]
        });
        let mut got = parse_models(&openai);
        got.sort();
        assert_eq!(got, vec!["gpt-4o", "gpt-4o-mini"]); // 去重 + 排序

        let ollama = serde_json::json!({
            "models": [
                {"name": "qwen2.5:7b", "model": "qwen2.5:7b"},
                {"name": "llama3.1:8b"}
            ]
        });
        assert_eq!(parse_models(&ollama), vec!["llama3.1:8b", "qwen2.5:7b"]);

        assert!(parse_models(&serde_json::json!({"unexpected": []})).is_empty());
    }

    /// 路由型 mock：/models 与 /v1/models 返回 404，仅 hit_path 命中时返回 200 + body。
    async fn spawn_routing_mock(hit_path: &str, body: String) -> u16 {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let hit_path = hit_path.to_string();
        tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            // list_models 会顺序尝试多个候选端点，需要接受多次连接
            loop {
                let Ok((mut sock, _)) = listener.accept().await else { break };
                let mut req = vec![0u8; 4096];
                let n = sock.read(&mut req).await.unwrap_or(0);
                if n == 0 { continue; }
                let head = String::from_utf8_lossy(&req[..n]);
                let req_line = head.lines().next().unwrap_or("");
                let path = req_line.split_whitespace().nth(1).unwrap_or("/");
                let resp = if path == hit_path {
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    )
                } else {
                    "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string()
                };
                let _ = sock.write_all(resp.as_bytes()).await;
                let _ = sock.flush().await;
            }
        });
        port
    }

    /// 用户漏填 /v1：/models 返回 404 时必须自动回退到 /v1/models 拉到列表。
    #[tokio::test]
    async fn list_models_falls_back_to_v1_suffix() {
        let body = serde_json::json!({"data":[{"id":"deepseek-chat"},{"id":"deepseek-reasoner"}]}).to_string();
        let port = spawn_routing_mock("/v1/models", body).await;
        let cfg = AiConfig {
            provider: "cloud".into(),
            // 故意用 localhost 且不带 /v1
            base_url: format!("http://localhost:{port}"),
            chat_model: "deepseek-chat".into(),
            embed_model: String::new(),
            temperature: 0.3,
            enable_auto_index: false,
        };
        let info = list_models(&cfg, &Some("sk-test".into())).await.unwrap();
        assert_eq!(info.models, vec!["deepseek-chat", "deepseek-reasoner"]);
    }

    /// Ollama 原生服务（无 /v1）：/v1/models 404 后回退 /api/tags，解析 models[].name。
    #[tokio::test]
    async fn list_models_falls_back_to_ollama_native_tags() {
        let body = serde_json::json!({
            "models": [{"name":"qwen2.5:7b"},{"name":"llama3.1:8b"}]
        })
        .to_string();
        let port = spawn_routing_mock("/api/tags", body).await;
        let cfg = AiConfig {
            provider: "ollama".into(),
            base_url: format!("http://127.0.0.1:{port}"),
            chat_model: "qwen2.5:7b".into(),
            embed_model: String::new(),
            temperature: 0.3,
            enable_auto_index: false,
        };
        let info = list_models(&cfg, &None).await.unwrap();
        assert_eq!(info.models, vec!["llama3.1:8b", "qwen2.5:7b"]);
    }
}
