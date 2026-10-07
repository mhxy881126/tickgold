// Agent 循环：装配历史 → 流式 chat → 工具调用 → 回填 → 直到无工具调用或达 6 轮。
use crate::ai::config::AiConfig;
use crate::ai::provider::{
    self, AssistantToolCall, AssistantToolFn, ChatMsg, HttpEmbedder, StreamEv, ToolCall,
};
use crate::ai::tools::{self, FactRef, ToolCtx};
use crate::ai::vectordb;
use crate::ai::AbortRegistry;
use std::path::Path;
use std::time::Instant;
use tauri::Emitter;

pub const MAX_ROUNDS: usize = 6;

pub const SYSTEM_PROMPT: &str = "\
你是 TickGold 的智能投研助手「慢脑」，一位资深 A 股短线交易专家，专注于涨停板、题材炒作、龙头战法。

## 你的能力：
1. **市场分析**：解读大盘情绪、涨停结构、资金流向、主线题材
2. **个股诊断**：分析K线形态、量价关系、支撑压力位、买卖信号
3. **题材梳理**：梳理当天主线题材、分支发酵、龙头股、补涨机会
4. **交易复盘**：对比计划 vs 实际交易，找出偏差，总结经验
5. **策略建议**：基于技术指标和市场情绪，给出操作思路（不构成投资建议）

## 铁律：
1. 只能引用工具返回的数字与事实，禁止编造行情、公告或题材信息
2. 工具没有的数据直接说不知道，并建议用户先完成收盘归因或检查数据中心
3. 关键结论后用【证据】标注来源（涨停池/题材库/公告原文等）
4. 回答用简洁中文，先结论后要点；涉及日期明确写出
5. 不预测涨跌、不给确定性承诺；末尾固定附一句「以上内容不构成投资建议」

## 回答风格：
- 先给结论，再给 2-3 个要点
- 用大白话，不要太专业
- 适当用 emoji 让回答更生动
- 如果用户问的问题超出能力范围，直接说不知道，不要硬编";

fn beijing_today() -> String {
    // 复用 market::today_yyyymmdd（YYYYMMDD）转 YYYY-MM-DD
    let c = crate::market::today_yyyymmdd();
    format!("{}-{}-{}", &c[0..4], &c[4..6], &c[6..8])
}

struct TurnAgent<'a> {
    app: &'a tauri::AppHandle,
    cfg: &'a AiConfig,
    api_key: Option<String>,
    embedder: HttpEmbedder,
}

pub async fn run_turn(
    app: &tauri::AppHandle,
    data_dir: &Path,
    registry: &AbortRegistry,
    cfg: &AiConfig,
    api_key: Option<String>,
    session_id: i64,
    user_text: String,
) -> Result<(), String> {
    let ai_path = data_dir.join("ai.db");
    // 1) 持久化用户消息 + 会话标题/时间
    {
        let db = vectordb::open(&ai_path)?;
        vectordb::insert_message(&db.0, session_id, "user", &user_text, "[]", "[]")?;
        let title: String = user_text.chars().take(16).collect();
        vectordb::touch_session(&db.0, session_id, &title)?;
    }
    registry.clear(session_id);

    let agent = TurnAgent {
        app,
        cfg,
        api_key: api_key.clone(),
        embedder: HttpEmbedder {
            cfg: cfg.clone(),
            api_key,
        },
    };

    let result = agent.loop_until_done(data_dir, registry, session_id).await;
    match result {
        Ok((text, refs, aborted)) => {
            let db = vectordb::open(&ai_path)?;
            let refs_json = serde_json::to_string(&refs).map_err(|e| e.to_string())?;
            let final_text = if !text.trim().is_empty() {
                text
            } else if aborted {
                "已手动中止本次回答。".to_string()
            } else {
                // 非中止空文本：6 轮工具调用耗尽仍未形成结论
                "已达到工具调用轮数上限，暂未能形成完整结论，请缩小问题范围后重试。".to_string()
            };
            let mid = vectordb::insert_message(
                &db.0,
                session_id,
                "assistant",
                &final_text,
                "[]",
                &refs_json,
            )?;
            let _ = app.emit(
                "ai://done",
                serde_json::json!({
                    "sessionId": session_id, "messageId": mid,
                    "refs": refs, "aborted": aborted,
                }),
            );
            Ok(())
        }
        Err(e) => {
            let _ = app.emit(
                "ai://error",
                serde_json::json!({"sessionId": session_id, "message": e}),
            );
            Err(e)
        }
    }
}

impl<'a> TurnAgent<'a> {
    async fn loop_until_done(
        &self,
        data_dir: &Path,
        registry: &AbortRegistry,
        session_id: i64,
    ) -> Result<(String, Vec<FactRef>, bool), String> {
        // 历史：最近 20 条（含工具记录），顺序升序
        let history = {
            let db = vectordb::open(&data_dir.join("ai.db"))?;
            vectordb::list_messages(&db.0, session_id, 20)?
        };
        let mut msgs: Vec<ChatMsg> = Vec::with_capacity(history.len() + 1);
        msgs.push(ChatMsg {
            role: "system".into(),
            content: format!("{SYSTEM_PROMPT}\n今天是：{}", beijing_today()),
            tool_calls: None,
            tool_call_id: None,
        });
        for m in history {
            // tool 记录不回送 API：缺少对应 assistant tool_calls 与 tool_call_id 会报错；
            // 它们仅留库审计，工具得到的信息已由最终 assistant 回答承载
            if m.role == "tool" {
                continue;
            }
            msgs.push(ChatMsg {
                role: m.role,
                content: m.content,
                tool_calls: None,
                tool_call_id: None,
            });
        }

        let tool_specs = tools::specs();
        let mut answer = String::new();
        let mut refs_all: Vec<FactRef> = vec![];
        let mut aborted = false;

        for _round in 0..MAX_ROUNDS {
            if registry.take_abort(session_id) {
                aborted = true;
                break;
            }
            let app = self.app;
            let sid = session_id;
            // chat_stream 内部累积工具碎片并返回组装结果；空 Vec=终轮
            let calls: Vec<ToolCall> = provider::chat_stream(
                self.cfg,
                &self.api_key,
                &msgs,
                &tool_specs,
                &mut |ev| {
                    if let StreamEv::Delta(s) = ev {
                        answer.push_str(&s);
                        let _ =
                            app.emit("ai://token", serde_json::json!({"sessionId": sid, "text": s}));
                    }
                },
            )
            .await?;
            if calls.is_empty() {
                break; // 无工具调用 = 终轮回答
            }
            // 工具前的零碎文本丢弃（属于工具调用前的思考，不入库）
            answer.clear();
            // 协议配对（OpenAI 兼容）：先规整本回合全部调用——
            // id 缺省补 call_{index}；arguments 非法时回送 "{}" 保证合法 JSON。
            struct PlannedCall {
                call_id: String,
                name: String,
                arguments: String,
                args: serde_json::Value,
            }
            let planned: Vec<PlannedCall> = calls
                .into_iter()
                .map(|call| {
                    let call_id = if call.id.is_empty() {
                        format!("call_{}", call.index)
                    } else {
                        call.id
                    };
                    let (arguments, args) =
                        match serde_json::from_str::<serde_json::Value>(&call.args) {
                            Ok(v) => (call.args, v),
                            Err(_) => ("{}".to_string(), serde_json::json!({})),
                        };
                    PlannedCall {
                        call_id,
                        name: call.name,
                        arguments,
                        args,
                    }
                })
                .collect();
            // 先 push assistant 消息（content 为空，build_api_messages 输出 null + tool_calls），
            // 其后每条 role:"tool" 消息带同一 tool_call_id，二者 id 必须完全一致。
            msgs.push(ChatMsg {
                role: "assistant".into(),
                content: String::new(),
                tool_calls: Some(
                    planned
                        .iter()
                        .map(|c| AssistantToolCall {
                            id: c.call_id.clone(),
                            kind: "function".into(),
                            function: AssistantToolFn {
                                name: c.name.clone(),
                                arguments: c.arguments.clone(),
                            },
                        })
                        .collect(),
                ),
                tool_call_id: None,
            });
            let ctx = ToolCtx {
                data_dir,
                embedder: &self.embedder,
            };
            for pc in &planned {
                if registry.take_abort(session_id) {
                    aborted = true;
                    break;
                }
                let call_id = pc.call_id.clone();
                let _ = self.app.emit(
                    "ai://tool",
                    serde_json::json!({
                        "sessionId": session_id, "callId": call_id,
                        "name": pc.name, "args": pc.args, "status": "running", "elapsedMs": 0,
                    }),
                );
                let started = Instant::now();
                let outcome = tools::dispatch(&pc.name, pc.args.clone(), &ctx).await;
                let elapsed = started.elapsed().as_millis() as i64;
                let (status, tool_content) = match outcome {
                    Ok(out) => {
                        for r in &out.refs {
                            if !refs_all.iter().any(|x| x == r) {
                                refs_all.push(r.clone());
                            }
                        }
                        ("ok", out.content)
                    }
                    Err(e) => ("error", format!("工具执行失败: {e}")),
                };
                let _ = self.app.emit(
                    "ai://tool",
                    serde_json::json!({
                        "sessionId": session_id, "callId": call_id,
                        "name": pc.name, "args": pc.args, "status": status, "elapsedMs": elapsed,
                    }),
                );
                let tool_msg = format!("[{} 结果]\n{}", pc.name, tool_content);
                msgs.push(ChatMsg {
                    role: "tool".into(),
                    content: tool_msg.clone(),
                    tool_calls: None,
                    tool_call_id: Some(call_id.clone()),
                });
                // 工具消息同步落库（刷新页面后历史可溯源）
                let db = vectordb::open(&data_dir.join("ai.db"))?;
                vectordb::insert_message(&db.0, session_id, "tool", &tool_msg, "[]", "[]")?;
            }
            if aborted {
                break;
            }
        }
        Ok((answer, refs_all, aborted))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_contains_compliance_and_evidence_rules() {
        assert!(SYSTEM_PROMPT.contains("不构成投资建议"));
        assert!(SYSTEM_PROMPT.contains("证据"));
        assert_eq!(MAX_ROUNDS, 6);
    }

    #[test]
    fn beijing_date_format() {
        let d = beijing_today();
        assert_eq!(d.len(), 10);
        assert_eq!(d.as_bytes()[4], b'-');
        assert_eq!(d.as_bytes()[7], b'-');
    }
}
