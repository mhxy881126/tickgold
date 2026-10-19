import { describe, expect, it } from "vitest";
import {
  stateMeta,
  triggerHint,
  emptyTriggerForm,
  ruleToForm,
  formToRule,
  validateForm,
  directionHint,
  triggerJsonToRule,
  orderStatusLabel,
  submitBlockReason,
  canEditInstruction,
  canSubmitInstruction,
  instructionActions,
  instructionStatusMeta,
  submitActionLabel,
  type InstructionGate,
  type TriggerForm,
} from "../../src/components/battle/instructionModel";

describe("instructionModel", () => {
  it("状态文案与色调", () => {
    expect(stateMeta("pending").label).toBe("待触发");
    expect(stateMeta("triggered").label).toBe("已触发");
    expect(stateMeta("submitted").label).toBe("已下单");
    expect(stateMeta("filled").label).toBe("已成交");
    expect(stateMeta("cancelled").label).toBe("已取消");
    expect(stateMeta("expired").label).toBe("已过期");
    expect(stateMeta("watch").label).toBe("仅观察");
    expect(stateMeta("unknown").label).toBe("仅观察");
    expect(stateMeta("pending").tone).toBe("info");
    expect(stateMeta("filled").tone).toBe("up");
  });

  it("触发提示解析", () => {
    const json = JSON.stringify([
      { field: "price", op: "gte", value: 10.5 },
      { field: "pct", op: "gte", value: 3 },
      { field: "volumeRatio", op: "gte", value: 2 },
    ]);
    const hint = triggerHint(json);
    expect(hint).toContain("≥10.50");
    expect(hint).toContain("涨幅≥3%");
    expect(hint).toContain("量比≥2");
    expect(triggerHint("")).toBe("");
    expect(triggerHint("not-json")).toBe("");
  });

  it("回踩方向与换手/成交额提示", () => {
    const json = JSON.stringify([
      { field: "price", op: "lte", value: 9.5 },
      { field: "turnover", op: "lte", value: 5.5 },
      { field: "amount", op: "gte", value: 2 },
    ]);
    expect(triggerHint(json)).toBe("≤9.50 · 换手≤5.5% · 成交额≥2");
    // 非数组 / 未知字段 / 非数值：跳过而不是抛错。
    expect(triggerHint('{"field":"price"}')).toBe("");
    expect(triggerHint(JSON.stringify([{ field: "wat", op: "gte", value: 1 }]))).toBe("");
    expect(triggerHint(JSON.stringify([{ field: "price", op: "gte", value: "x" }]))).toBe("");
  });
});

describe("指令编辑表单模型（P1-b）", () => {
  it("ruleToForm 从 alertRule 回填", () => {
    const f = ruleToForm({
      upPrice: 1680,
      upPct: 5,
      downPct: -5,
      minVolumeRatio: 2,
      minTurnover: 3.5,
      minAmount: 2,
      riseSpeed: 1.2,
      speedWindowSec: 120,
      side: "SELL",
      vol: 300,
      autoConfirm: false,
    });
    expect(f.upPrice).toBe("1680");
    expect(f.upPct).toBe("5");
    expect(f.downPct).toBe("-5");
    expect(f.minVolumeRatio).toBe("2");
    expect(f.minTurnover).toBe("3.5");
    expect(f.minAmount).toBe("2");
    expect(f.riseSpeed).toBe("1.2");
    expect(f.speedWindowSec).toBe("120");
    expect(f.downPrice).toBe("");
    expect(f.side).toBe("SELL");
    expect(f.vol).toBe("300");
    expect(f.autoConfirm).toBe(false);
  });

  it("ruleToForm 缺省值与非法输入兜底", () => {
    const d = ruleToForm({});
    expect(d.side).toBe("BUY");
    expect(d.vol).toBe("100");
    expect(d.autoConfirm).toBe(true);
    expect(d.upPrice).toBe("");
    // JSON 字符串（workflow 返回的 alertRule 是文本）
    expect(ruleToForm('{"upPct":3}').upPct).toBe("3");
    expect(ruleToForm("not-json").upPct).toBe("");
    expect(ruleToForm(null).upPct).toBe("");
    expect(ruleToForm({ side: "hold" }).side).toBe("BUY");
    expect(ruleToForm({ vol: -100 }).vol).toBe("100");
  });

  it("formToRule 映射数值/方向/autoConfirm，空值省略", () => {
    const form = {
      ...emptyTriggerForm(),
      upPrice: "1700",
      minVolumeRatio: "2",
      side: "BUY",
      vol: "200",
      autoConfirm: false,
    };
    const rule = formToRule(form);
    expect(rule.upPrice).toBe(1700);
    expect(rule.minVolumeRatio).toBe(2);
    expect(rule.side).toBe("BUY");
    expect(rule.vol).toBe(200);
    expect(rule.autoConfirm).toBe(false);
    // 空字段不落盘：键不存在（后端合并时保留旧值由「清空」路径显式给 null）。
    expect("downPrice" in rule).toBe(false);
    expect("upPct" in rule).toBe(false);
    expect("riseSpeed" in rule).toBe(false);
  });

  it("formToRule 0 视为清空值，方向归一", () => {
    const zero = formToRule({ ...emptyTriggerForm(), upPrice: "0", vol: "" });
    expect(zero.upPrice).toBe(0);
    expect("vol" in zero).toBe(false);
    expect(formToRule({ ...emptyTriggerForm(), upPct: "3", side: "sell" }).side).toBe("SELL");
  });

  it("formToRule 清空旧条件时显式给 null（否则后端合并会保留）", () => {
    const rule = formToRule(
      { ...emptyTriggerForm(), upPct: "3" },
      { upPrice: 1680, upPct: 5, downPct: -5, speedWindowSec: 120 },
    );
    expect(rule.upPrice).toBeNull();
    expect(rule.downPct).toBeNull();
    expect(rule.speedWindowSec).toBeNull();
    expect(rule.upPct).toBe(3);
  });

  it("formToRule 兼容 input[type=number] 回传的数字（v-model 自动转数字）", () => {
    const rule = formToRule({
      ...emptyTriggerForm(),
      upPrice: 1700,
      minVolumeRatio: 2,
      vol: 200,
    });
    expect(rule.upPrice).toBe(1700);
    expect(rule.minVolumeRatio).toBe(2);
    expect(rule.vol).toBe(200);
    expect(validateForm({ ...emptyTriggerForm(), upPct: 5 })).toBe("");
    expect(directionHint({ ...emptyTriggerForm(), upPct: 5, downPct: -5 })).toBe(
      "突破优先：回撤条件不会触发",
    );
    expect(validateForm({ ...emptyTriggerForm(), upPct: 5, vol: 150 })).toBe(
      "委托数量须为 100 股整数倍",
    );
  });

  it("formToRule 非法数量/方向/非数字报中文错误", () => {
    expect(() => formToRule({ ...emptyTriggerForm(), upPct: "3", vol: "150" })).toThrow(
      "委托数量须为 100 股整数倍",
    );
    expect(() => formToRule({ ...emptyTriggerForm(), upPct: "3", vol: "-100" })).toThrow(
      "委托数量须为 100 股整数倍",
    );
    expect(() => formToRule({ ...emptyTriggerForm(), upPct: "3", vol: "0" })).toThrow(
      "委托数量须为 100 股整数倍",
    );
    expect(() => formToRule({ ...emptyTriggerForm(), upPct: "3", side: "HOLD" })).toThrow(
      "方向只能是 BUY 或 SELL",
    );
    expect(() => formToRule({ ...emptyTriggerForm(), upPct: "abc" })).toThrow("涨幅须为数字");
  });

  it("validateForm 校验中文提示", () => {
    expect(validateForm(emptyTriggerForm())).toBe("至少设置一个触发条件");
    expect(validateForm({ ...emptyTriggerForm(), upPct: "3" })).toBe("");
    expect(validateForm({ ...emptyTriggerForm(), downPct: "-5" })).toBe("");
    // 只填方向和数量不算触发条件。
    expect(validateForm({ ...emptyTriggerForm(), side: "SELL", vol: "200" })).toBe(
      "至少设置一个触发条件",
    );
    expect(validateForm({ ...emptyTriggerForm(), upPct: "3", vol: "150" })).toBe(
      "委托数量须为 100 股整数倍",
    );
    expect(validateForm({ ...emptyTriggerForm(), upPct: "3", side: "HOLD" })).toBe(
      "方向只能是 BUY 或 SELL",
    );
    // 只有窗口/数量不算触发条件；0 也不算（与后端「0 视为未设置」一致）。
    expect(validateForm({ ...emptyTriggerForm(), speedWindowSec: "120", vol: "200" })).toBe(
      "至少设置一个触发条件",
    );
    expect(validateForm({ ...emptyTriggerForm(), upPrice: "0" })).toBe("至少设置一个触发条件");
  });

  it("directionHint 提示突破优先，回撤侧不会触发", () => {
    expect(directionHint({ ...emptyTriggerForm(), upPrice: "1680", downPrice: "1600" })).toBe(
      "突破优先：回撤条件不会触发",
    );
    expect(directionHint({ ...emptyTriggerForm(), upPct: "5", downPct: "-5" })).toBe(
      "突破优先：回撤条件不会触发",
    );
    expect(directionHint({ ...emptyTriggerForm(), upPct: "5" })).toBe("");
    expect(directionHint({ ...emptyTriggerForm(), downPct: "-5" })).toBe("");
    expect(directionHint(emptyTriggerForm())).toBe("");
  });

  it("triggerJsonToRule 从物化叶子回填（无 alertRule 时的兜底）", () => {
    const rule = triggerJsonToRule(
      JSON.stringify([
        { field: "price", op: "gte", value: 1680 },
        { field: "riseSpeed", op: "gte", value: 1.2, params: { windowSec: 120 } },
        { field: "sealUp", op: "gte", value: 1 },
      ]),
    );
    expect(rule.upPrice).toBe(1680);
    expect(rule.riseSpeed).toBe(1.2);
    expect(rule.speedWindowSec).toBe(120);
    expect(rule.sealLimitUp).toBe(1);
    expect(triggerJsonToRule("")).toEqual({});
    expect(triggerJsonToRule("not-json")).toEqual({});
    expect(ruleToForm(triggerJsonToRule('[{"field":"price","op":"gte","value":9.5}]')).upPrice).toBe(
      "9.5",
    );
  });

  it("委托状态文案", () => {
    expect(orderStatusLabel("filled")).toBe("已成交");
    expect(orderStatusLabel("part_filled")).toBe("部分成交");
    expect(orderStatusLabel("rejected")).toBe("已拒绝");
    expect(orderStatusLabel("cancelled")).toBe("已撤销");
    expect(orderStatusLabel("submitted")).toBe("已下单");
    expect(orderStatusLabel("submitting")).toBe("提交中");
    expect(orderStatusLabel("")).toBe("已下单");
  });

  it("提交闸门复用下单条状态判断", () => {
    const sim = {
      kind: "mock",
      liveEnabled: false,
      connected: true,
      killSwitch: false,
      clientSim: false,
      windowSim: null,
    };
    expect(submitBlockReason(sim)).toBe("");
    expect(submitBlockReason(null)).toContain("未知");
    expect(submitBlockReason({ ...sim, killSwitch: true })).toContain("熔断");
    expect(submitBlockReason({ ...sim, connected: false })).toContain("未连接");
    expect(
      submitBlockReason({
        kind: "client",
        liveEnabled: false,
        connected: true,
        killSwitch: false,
        clientSim: false,
        windowSim: false,
      }),
    ).toContain("实盘未启用");
    expect(
      submitBlockReason({
        kind: "client",
        liveEnabled: true,
        connected: true,
        killSwitch: false,
        clientSim: false,
        windowSim: false,
      }),
    ).toBe("");
    // 同花顺模拟窗口 / 客户端模拟都算模拟通道，不要求实盘开关。
    expect(
      submitBlockReason({
        kind: "client",
        liveEnabled: false,
        connected: true,
        killSwitch: false,
        clientSim: true,
        windowSim: null,
      }),
    ).toBe("");
  });
});

describe("指令编辑表单 round-trip（P1-b 补测）", () => {
  it("formToRule ↔ ruleToForm 覆盖后端 16 个可编辑键", () => {
    const form: TriggerForm = {
      ...emptyTriggerForm(),
      upPrice: "1680",
      downPrice: "1600",
      upPct: "5",
      downPct: "-5",
      minVolumeRatio: "2",
      minTurnover: "3.5",
      minAmount: "2",
      riseSpeed: "1.2",
      speedWindowSec: "120",
      downSpeed: "0.8",
      sealLimitUp: "1",
      sealLimitDown: "0",
      brokenLimit: "1",
      side: "SELL",
      vol: "300",
      autoConfirm: false,
    };
    const rule = formToRule(form);
    expect(rule).toEqual({
      upPrice: 1680,
      downPrice: 1600,
      upPct: 5,
      downPct: -5,
      minVolumeRatio: 2,
      minTurnover: 3.5,
      minAmount: 2,
      riseSpeed: 1.2,
      speedWindowSec: 120,
      downSpeed: 0.8,
      sealLimitUp: 1,
      sealLimitDown: 0,
      brokenLimit: 1,
      side: "SELL",
      vol: 300,
      autoConfirm: false,
    });
    // 回填后与原始表单逐键一致（含回踩 / 封板 / 涨速窗口等面板不直接编辑的键）。
    expect(ruleToForm(rule)).toEqual(form);
  });

  it("triggerJsonToRule 的 lte 叶子映射到 downPrice / downPct", () => {
    const rule = triggerJsonToRule(
      JSON.stringify([
        { field: "price", op: "lte", value: 1600 },
        { field: "pct", op: "lte", value: -3 },
        { field: "turnover", op: "gte", value: 2 },
      ]),
    );
    expect(rule.downPrice).toBe(1600);
    expect(rule.downPct).toBe(-3);
    expect(rule.minTurnover).toBe(2);
    expect(rule.upPrice).toBeUndefined();
    expect(rule.upPct).toBeUndefined();
  });
});

describe("指令行状态徽标（P1-b 文案一致性）", () => {
  function row(patch: Partial<InstructionGate> = {}): InstructionGate {
    return {
      state: "submitted",
      ticketStatus: "confirmed",
      hasOrder: false,
      orderStatus: "",
      ticketId: 2,
      ...patch,
    };
  }

  it("票 confirmed 但无委托显示「待提交」，不显示「已下单」", () => {
    expect(instructionStatusMeta(row()).label).toBe("待提交");
    expect(instructionStatusMeta(row()).tone).toBe("gold");
  });

  it("票 rejected 显示「已拒绝」，不落到「已取消」", () => {
    const meta = instructionStatusMeta(row({ state: "cancelled", ticketStatus: "rejected" }));
    expect(meta.label).toBe("已拒绝");
    expect(meta.label).not.toBe(stateMeta("cancelled").label);
  });

  it("票 done 显示「已成交」，pending 显示「已触发」", () => {
    expect(instructionStatusMeta(row({ state: "filled", ticketStatus: "done" })).label).toBe("已成交");
    expect(instructionStatusMeta(row({ state: "triggered", ticketStatus: "pending" })).label).toBe(
      "已触发",
    );
  });

  it("已有委托时按 orderStatus 映射", () => {
    expect(instructionStatusMeta(row({ hasOrder: true, orderStatus: "filled" })).label).toBe("已成交");
    expect(instructionStatusMeta(row({ hasOrder: true, orderStatus: "submitted" })).label).toBe(
      "已下单",
    );
    expect(instructionStatusMeta(row({ hasOrder: true, orderStatus: "part_filled" })).label).toBe(
      "部分成交",
    );
    expect(instructionStatusMeta(row({ hasOrder: true, orderStatus: "rejected" })).label).toBe(
      "已拒绝",
    );
    expect(instructionStatusMeta(row({ hasOrder: true, orderStatus: "error" })).label).toBe("已失败");
    expect(instructionStatusMeta(row({ hasOrder: true, orderStatus: "cancelled" })).label).toBe(
      "已撤销",
    );
  });

  it("无票时回执行状态", () => {
    const noTicket = { ticketStatus: "", orderStatus: "" };
    expect(instructionStatusMeta(row({ ...noTicket, state: "watch" })).label).toBe("仅观察");
    expect(instructionStatusMeta(row({ ...noTicket, state: "pending" })).label).toBe("待触发");
    expect(instructionStatusMeta(row({ ...noTicket, state: "cancelled" })).label).toBe("已取消");
    expect(instructionStatusMeta(row({ ...noTicket, state: "expired" })).label).toBe("已过期");
  });
});

describe("指令可操作性规则（P1-b 安全门控下沉）", () => {
  function row(patch: Partial<InstructionGate> = {}): InstructionGate {
    return {
      state: "triggered",
      ticketStatus: "pending",
      hasOrder: false,
      orderStatus: "",
      ticketId: 2,
      ...patch,
    };
  }
  const sim = {
    kind: "mock",
    liveEnabled: false,
    connected: true,
    killSwitch: false,
    clientSim: false,
    windowSim: null,
  };

  it("pending 可提交；confirmed + 无委托可重试提交", () => {
    expect(canSubmitInstruction(row())).toBe(true);
    expect(submitActionLabel(row())).toBe("确认下单");
    const retry = row({ state: "submitted", ticketStatus: "confirmed" });
    expect(canSubmitInstruction(retry)).toBe(true);
    expect(submitActionLabel(retry)).toBe("重试提交");
  });

  it("已有委托 / 无票据 id / 终态不可提交", () => {
    expect(canSubmitInstruction(row({ hasOrder: true, orderStatus: "submitted" }))).toBe(false);
    expect(canSubmitInstruction(row({ ticketId: 0 }))).toBe(false);
    expect(canSubmitInstruction(row({ state: "filled", ticketStatus: "done" }))).toBe(false);
    expect(canSubmitInstruction(row({ state: "cancelled", ticketStatus: "rejected" }))).toBe(false);
    expect(canSubmitInstruction(row({ state: "expired" }))).toBe(false);
    expect(canSubmitInstruction(row({ ticketStatus: "done" }))).toBe(false);
    expect(canSubmitInstruction(row({ ticketStatus: "" }))).toBe(false);
  });

  it("watch / pending 可编辑；triggered / filled / expired 不可编辑", () => {
    expect(canEditInstruction(row({ state: "watch", ticketStatus: "" }))).toBe(true);
    expect(canEditInstruction(row({ state: "pending", ticketStatus: "" }))).toBe(true);
    expect(canEditInstruction(row({ state: "triggered" }))).toBe(false);
    expect(canEditInstruction(row({ state: "submitted" }))).toBe(false);
    expect(canEditInstruction(row({ state: "filled" }))).toBe(false);
    expect(canEditInstruction(row({ state: "expired" }))).toBe(false);
  });

  it("instructionActions 汇总动作与闸门原因（kill / 未连接 / 实盘未启用）", () => {
    expect(instructionActions(row({ state: "watch", ticketStatus: "" }), sim)).toEqual({
      canEdit: true,
      canSubmit: false,
      submitLabel: "确认下单",
      blockReason: "",
    });
    expect(instructionActions(row(), sim)).toMatchObject({ canEdit: false, canSubmit: true });
    expect(instructionActions(row(), null).blockReason).toContain("未知");
    expect(instructionActions(row(), { ...sim, killSwitch: true }).blockReason).toContain("熔断");
    expect(instructionActions(row(), { ...sim, connected: false }).blockReason).toContain("未连接");
    expect(
      instructionActions(row(), {
        ...sim,
        kind: "client",
        clientSim: false,
        windowSim: false,
      }).blockReason,
    ).toContain("实盘未启用");
  });
});
