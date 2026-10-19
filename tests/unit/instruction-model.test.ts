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
