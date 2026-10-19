import { describe, expect, it } from "vitest";
import {
  RECON_LABEL_BAD,
  RECON_LABEL_NONE,
  RECON_LABEL_OK,
  RECON_LABEL_STALE,
  RECON_STALE_MS,
  reconChip,
} from "../../src/broker/reconChip";
import type { ReconReport, ReconStatus } from "../../src/broker/api";

const NOW = 1_760_000_000_000;
const MIN = 60_000;

function makeReport(patch: Partial<ReconReport> = {}): ReconReport {
  return {
    kind: "intraday",
    matched: true,
    baseline: true,
    checked: 3,
    at: NOW,
    diffs: [],
    ...patch,
  };
}

function makeStatus(patch: Partial<ReconStatus> = {}, report: ReconReport | null = makeReport()): ReconStatus {
  return {
    conflict: false,
    connected: true,
    kind: "client",
    report,
    ...patch,
  };
}

describe("reconChip", () => {
  it("无状态 / 无报告 → 未对账 muted", () => {
    expect(reconChip(null, NOW)).toEqual({ label: RECON_LABEL_NONE, tone: "muted", stale: false });
    expect(reconChip(undefined, NOW)).toEqual({ label: RECON_LABEL_NONE, tone: "muted", stale: false });
    expect(reconChip(makeStatus({}, null), NOW)).toEqual({
      label: RECON_LABEL_NONE,
      tone: "muted",
      stale: false,
    });
  });

  it("空对象报告（旧后端 / fake）按无报告处理", () => {
    const status = makeStatus({ report: {} as ReconReport });
    expect(reconChip(status, NOW)).toEqual({ label: RECON_LABEL_NONE, tone: "muted", stale: false });
  });

  it("报告匹配 → 对账正常 · N 分钟前（green）", () => {
    const status = makeStatus({}, makeReport({ at: NOW - 3 * MIN }));
    expect(reconChip(status, NOW)).toEqual({
      label: `${RECON_LABEL_OK} · 3 分钟前`,
      tone: "ok",
      stale: false,
    });
  });

  it("不足 1 分钟显示「刚刚」，未来时间不出现负数", () => {
    expect(reconChip(makeStatus({}, makeReport({ at: NOW - 30_000 })), NOW).label).toBe(
      `${RECON_LABEL_OK} · 刚刚`,
    );
    expect(reconChip(makeStatus({}, makeReport({ at: NOW + 5 * MIN })), NOW).label).toBe(
      `${RECON_LABEL_OK} · 刚刚`,
    );
  });

  it("30 分钟整未过期，超过 30 分钟 → 对账已过期 muted", () => {
    const edge = reconChip(makeStatus({}, makeReport({ at: NOW - RECON_STALE_MS })), NOW);
    expect(edge).toEqual({ label: `${RECON_LABEL_OK} · 30 分钟前`, tone: "ok", stale: false });

    const stale = reconChip(makeStatus({}, makeReport({ at: NOW - RECON_STALE_MS - 1 })), NOW);
    expect(stale).toEqual({ label: RECON_LABEL_STALE, tone: "muted", stale: true });
  });

  it("报告未匹配 → 账实不符 bad", () => {
    const status = makeStatus({ conflict: true }, makeReport({ matched: false, diffs: [{ code: "600000", localVol: 100, brokerVol: 200 }] }));
    expect(reconChip(status, NOW)).toEqual({ label: RECON_LABEL_BAD, tone: "bad", stale: false });
  });

  it("未匹配且过期仍优先显示账实不符，stale=true", () => {
    const status = makeStatus(
      { conflict: true },
      makeReport({ matched: false, at: NOW - 2 * RECON_STALE_MS }),
    );
    expect(reconChip(status, NOW)).toEqual({ label: RECON_LABEL_BAD, tone: "bad", stale: true });
  });

  it("后端冲突标记优先：报告缺失 / 报告仍 matched 都显示账实不符", () => {
    expect(reconChip(makeStatus({ conflict: true }, null), NOW)).toEqual({
      label: RECON_LABEL_BAD,
      tone: "bad",
      stale: false,
    });
    expect(reconChip(makeStatus({ conflict: true }, makeReport()), NOW)).toEqual({
      label: RECON_LABEL_BAD,
      tone: "bad",
      stale: false,
    });
  });

  it("now 非法时用当前时间兜底（不抛错）", () => {
    const r = reconChip(makeStatus({}, makeReport({ at: Date.now() - MIN })), Number.NaN);
    expect(r.tone).toBe("ok");
    expect(r.label).toContain(RECON_LABEL_OK);
  });
});
