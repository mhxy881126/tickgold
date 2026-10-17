import { describe, it, expect, vi, beforeEach } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invokeMock(...a),
}));

import {
  brokerClientQueryTrades,
  brokerClientQueryPending,
  brokerClientCancelAll,
  brokerClientPositionOrder,
  brokerClientCheckApp,
  brokerClientCurrentPage,
  brokerClientSendKey,
  brokerClientClick,
  brokerClientCaptchaInput,
  brokerClientConfirm,
  brokerSetConfig,
} from "../../../src/broker/api";

beforeEach(() => {
  vi.resetAllMocks();
  invokeMock.mockResolvedValue("ok");
});

describe("P7 同花顺客户端命令封装", () => {
  it("当日成交 / 挂单 / 自检为无参命令", async () => {
    await brokerClientQueryTrades();
    expect(invokeMock).toHaveBeenCalledWith("broker_client_query_trades");
    await brokerClientQueryPending();
    expect(invokeMock).toHaveBeenCalledWith("broker_client_query_pending");
    await brokerClientCheckApp();
    expect(invokeMock).toHaveBeenCalledWith("broker_client_check_app");
    await brokerClientCurrentPage();
    expect(invokeMock).toHaveBeenCalledWith("broker_client_current_page");
  });

  it("一键撤单传 kind（A/X/C）", async () => {
    await brokerClientCancelAll("A");
    expect(invokeMock).toHaveBeenCalledWith("broker_client_cancel_all", { kind: "A" });
    await brokerClientCancelAll("X");
    expect(invokeMock).toHaveBeenCalledWith("broker_client_cancel_all", { kind: "X" });
  });

  it("仓位下单用 camelCase 透传 refPrice 与档位", async () => {
    await brokerClientPositionOrder("600519", "BUY", 2, 1689.5);
    expect(invokeMock).toHaveBeenCalledWith("broker_client_position_order", {
      code: "600519",
      side: "BUY",
      position: 2,
      refPrice: 1689.5,
    });
  });

  it("高级调试：键盘序列 / 点击坐标 / 验证码透传", async () => {
    await brokerClientSendKey("F4");
    expect(invokeMock).toHaveBeenCalledWith("broker_client_send_key", { key: "F4" });
    await brokerClientClick(120, 240);
    expect(invokeMock).toHaveBeenCalledWith("broker_client_click", { x: 120, y: 240 });
    await brokerClientCaptchaInput("1234");
    expect(invokeMock).toHaveBeenCalledWith("broker_client_captcha_input", { text: "1234" });
  });

  it("人工确认把截图 cid 作为 client_order_id 透传给 confirm/reject", async () => {
    await brokerClientConfirm("CA1700000000A", true);
    expect(invokeMock).toHaveBeenCalledWith("broker_client_confirm", {
      sigId: "CA1700000000A",
      approved: true,
    });
  });

  it("brokerSetConfig 透传 tesseract 路径", async () => {
    await brokerSetConfig({ clientTesseract: "C:/ths/tesseract.exe" });
    expect(invokeMock).toHaveBeenCalledWith(
      "broker_set_config",
      expect.objectContaining({ clientTesseract: "C:/ths/tesseract.exe" }),
    );
  });
});
