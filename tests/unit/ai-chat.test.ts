import { describe, expect, it } from "vitest";
import type { StreamMessage } from "../../src/ai/types";
import { applyDone, applyToken, applyTool } from "../../src/ai/streamReducer";

function assistant(text = ""): StreamMessage {
  return {
    id: -1,
    role: "assistant",
    content: text,
    toolCalls: "[]",
    tools: [],
    refs: "[]",
    factRefs: [],
    createdAt: 1,
    streaming: true,
  };
}

const toolEvent = (
  overrides: Partial<{
    sessionId: number;
    callId: string;
    name: string;
    args: unknown;
    status: "running" | "ok" | "error";
    elapsedMs: number;
  }> = {},
) => ({
  sessionId: 1,
  callId: "c1",
  name: "market_overview",
  args: { date: "2026-09-30" },
  status: "running" as const,
  elapsedMs: 0,
  ...overrides,
});

describe("AI 流式状态机", () => {
  it("忽略其他会话的 token", () => {
    const list: StreamMessage[] = [];
    expect(applyToken(list, 9, { sessionId: 8, text: "x" })).toBe(false);
    expect(list).toHaveLength(0);
  });

  it("首个 token 建消息，后续增量拼接", () => {
    const list: StreamMessage[] = [];
    applyToken(list, 3, { sessionId: 3, text: "今日" });
    applyToken(list, 3, { sessionId: 3, text: "涨停" });
    expect(list).toHaveLength(1);
    expect(list[0].content).toBe("今日涨停");
    expect(list[0].streaming).toBe(true);
  });

  it("工具事件先 running 后 ok 并更新同一 callId", () => {
    const list = [assistant("正在查询")];
    applyTool(list, 1, toolEvent());
    applyTool(list, 1, toolEvent({ status: "ok", elapsedMs: 42 }));
    expect(list[0].tools).toHaveLength(1);
    expect(list[0].tools[0].status).toBe("ok");
    expect(list[0].tools[0].elapsedMs).toBe(42);
  });

  it("done 落定消息 id、refs 并停止流式", () => {
    const list = [assistant("结论")];
    applyDone(list, 2, {
      sessionId: 2,
      messageId: 55,
      refs: [{ kind: "card", card: "limitpool" }],
      aborted: false,
    });
    expect(list[0].id).toBe(55);
    expect(list[0].streaming).toBe(false);
    expect(list[0].factRefs[0].card).toBe("limitpool");
    expect(list[0].refs).toBe(JSON.stringify([{ kind: "card", card: "limitpool" }]));
  });

  it("done 的会话不匹配时不改动", () => {
    const list = [assistant("x")];
    expect(
      applyDone(list, 7, { sessionId: 8, messageId: 1, refs: [], aborted: false }),
    ).toBe(false);
    expect(list[0].streaming).toBe(true);
  });

  it("工具批次首个 running 作废此前的思考碎片，最终 token 重新拼接并由 done 落定", () => {
    const list: StreamMessage[] = [];

    // 1. 工具调用前模型吐出的零碎思考已经到达前端
    applyToken(list, 1, { sessionId: 1, text: "思考" });
    expect(list).toHaveLength(1);
    expect(list[0].content).toBe("思考");

    // 2. 新工具批次首个 running：清空思考碎片并挂上 running 工具条
    applyTool(list, 1, toolEvent());
    expect(list[0].content).toBe("");
    expect(list[0].tools).toHaveLength(1);
    expect(list[0].tools[0].status).toBe("running");

    // 3. 同一 callId 的 ok 只更新状态，不清工具、不新增条目
    applyTool(list, 1, toolEvent({ status: "ok", elapsedMs: 42 }));
    expect(list[0].tools).toHaveLength(1);
    expect(list[0].tools[0].status).toBe("ok");
    expect(list[0].tools[0].elapsedMs).toBe(42);

    // 4. 工具返回后模型重新吐字，拼到同一条 assistant 消息上
    applyToken(list, 1, { sessionId: 1, text: "最终结论" });
    expect(list).toHaveLength(1);
    expect(list[0].content).toBe("最终结论");

    // 5. done 走完全程：补正式 id、停止流式、落定证据
    applyDone(list, 1, {
      sessionId: 1,
      messageId: 9,
      refs: [{ kind: "card", card: "limitpool" }],
      aborted: false,
    });
    expect(list[0].id).toBe(9);
    expect(list[0].streaming).toBe(false);
    expect(list[0].factRefs).toEqual([{ kind: "card", card: "limitpool" }]);
  });

  it("tool 事件先于 token 到达时自动建空 assistant 占位", () => {
    const list: StreamMessage[] = [];
    const applied = applyTool(list, 1, toolEvent());
    expect(applied).toBe(true);
    expect(list).toHaveLength(1);
    expect(list[0].role).toBe("assistant");
    expect(list[0].streaming).toBe(true);
    expect(list[0].id).toBe(-1);
    expect(list[0].content).toBe("");
    expect(list[0].tools).toHaveLength(1);
    expect(list[0].tools[0].callId).toBe("c1");
    expect(list[0].tools[0].status).toBe("running");

    // 占位建好后，迟到的 token 仍拼进同一条消息
    applyToken(list, 1, { sessionId: 1, text: "补答" });
    expect(list).toHaveLength(1);
    expect(list[0].content).toBe("补答");
  });
});
