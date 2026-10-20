// v3.14 P0-5 急停统一确认 helper 纯逻辑单测：mock confirmDialog，不测组件挂载。
import { describe, it, expect, vi, beforeEach } from "vitest";

const confirmDialogMock = vi.hoisted(() => vi.fn());
vi.mock("../../src/composables/useDialog", () => ({
  confirmDialog: (...args: unknown[]) => confirmDialogMock(...args),
}));

import {
  confirmEmergencyHalt,
  formatEmergencyHaltResult,
  EMERGENCY_HALT_DIALOG,
  markDialogHostMounted,
} from "../../src/composables/emergencyHalt";

beforeEach(() => {
  vi.clearAllMocks();
  // 每个用例默认回到「无弹窗宿主」状态，并清掉伪造的 window。
  markDialogHostMounted(false);
  delete (globalThis as Record<string, unknown>).window;
});

describe("confirmEmergencyHalt（有 AppDialog 宿主）", () => {
  it("取消 → 返回 false，并把统一文案/危险色交给 confirmDialog，不调任何底层", async () => {
    markDialogHostMounted(true);
    confirmDialogMock.mockResolvedValue(false);

    const ok = await confirmEmergencyHalt();

    expect(ok).toBe(false);
    expect(confirmDialogMock).toHaveBeenCalledTimes(1);
    const arg = confirmDialogMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.title).toBe(EMERGENCY_HALT_DIALOG.title);
    expect(arg.confirmText).toBe(EMERGENCY_HALT_DIALOG.confirmText);
    expect(arg.cancelText).toBe(EMERGENCY_HALT_DIALOG.cancelText);
    expect(arg.danger).toBe(true);
    expect(arg.message).toBe(EMERGENCY_HALT_DIALOG.message);
    // helper 本身不触碰底层急停接口：除 confirmDialog 外没有别的调用。
    expect(confirmDialogMock).toHaveBeenCalledTimes(1);
  });

  it("确认 → 返回 true", async () => {
    markDialogHostMounted(true);
    confirmDialogMock.mockResolvedValue(true);

    await expect(confirmEmergencyHalt()).resolves.toBe(true);
    expect(confirmDialogMock).toHaveBeenCalledTimes(1);
  });
});

describe("confirmEmergencyHalt（无宿主窗口兜底，如灵动岛独立 Webview）", () => {
  it("无 window → 返回 false，不抛错、不挂起", async () => {
    await expect(confirmEmergencyHalt()).resolves.toBe(false);
    expect(confirmDialogMock).not.toHaveBeenCalled();
  });

  it("回退原生 window.confirm，文案与共享常量一致；确认返回 true", async () => {
    const nativeConfirm = vi.fn(() => true);
    (globalThis as Record<string, unknown>).window = { confirm: nativeConfirm };

    await expect(confirmEmergencyHalt()).resolves.toBe(true);
    expect(nativeConfirm).toHaveBeenCalledTimes(1);
    const text = nativeConfirm.mock.calls[0]![0] as string;
    expect(text).toContain(EMERGENCY_HALT_DIALOG.title);
    expect(text).toContain("封死全部新委托");
    expect(text).toContain("停止自动执行");
    expect(text).toContain("撤销全部条件单");
    expect(text).toContain("撤销全部在途委托");
  });

  it("原生 confirm 取消 → 返回 false", async () => {
    const nativeConfirm = vi.fn(() => false);
    (globalThis as Record<string, unknown>).window = { confirm: nativeConfirm };

    await expect(confirmEmergencyHalt()).resolves.toBe(false);
  });
});

describe("统一文案常量四条后果要点", () => {
  it("message 覆盖封新委托/停自动执行(含条件单物化)/撤条件单/撤在途并断通道 + 不可撤销恢复说明", () => {
    const m = EMERGENCY_HALT_DIALOG.message;
    expect(m).toContain("封死全部新委托");
    expect(m).toContain("停止自动执行");
    expect(m).toContain("条件单物化");
    expect(m).toContain("撤销全部条件单");
    expect(m).toContain("撤销全部在途委托");
    expect(m).toContain("断开券商通道");
    expect(m).toContain("不可撤销");
    expect(m).toContain("手动解除");
    expect(m).toContain("重连");
    expect(m).toContain("重启自动执行");
    expect(EMERGENCY_HALT_DIALOG.danger).toBe(true);
    expect(EMERGENCY_HALT_DIALOG.confirmText).toBe("立即急停");
  });
});

describe("formatEmergencyHaltResult 统一成功反馈", () => {
  it("复用 coCount / orderCount 拼出统一文案", () => {
    expect(formatEmergencyHaltResult({ coCount: 3, orderCount: 2 })).toBe(
      "已急停：撤销条件单 3 个、在途委托 2 笔",
    );
    expect(formatEmergencyHaltResult({ coCount: 0, orderCount: 0 })).toBe(
      "已急停：撤销条件单 0 个、在途委托 0 笔",
    );
  });
});
