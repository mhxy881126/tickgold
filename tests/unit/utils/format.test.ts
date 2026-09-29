import { describe, it, expect } from "vitest";
import {
  fmtPrice, fmtPct, fmtAmount, fmtMoney, fmtVolume, isNum,
} from "../../../src/utils/format";

describe("isNum", () => {
  it("识别有限数字", () => {
    expect(isNum(1)).toBe(true);
    expect(isNum(0)).toBe(true);
    expect(isNum(-1.5)).toBe(true);
  });
  it("拒绝非数字 / NaN / Infinity / null", () => {
    expect(isNum(NaN)).toBe(false);
    expect(isNum(Infinity)).toBe(false);
    expect(isNum(null)).toBe(false);
    expect(isNum(undefined)).toBe(false);
    expect(isNum("1")).toBe(false);
  });
});

describe("fmtPrice", () => {
  it("默认两位小数", () => {
    expect(fmtPrice(1686)).toBe("1686.00");
    expect(fmtPrice(1.5)).toBe("1.50");
  });
  it("自定义位数", () => {
    expect(fmtPrice(1.23456, 3)).toBe("1.235");
  });
  it("空值为 --", () => {
    expect(fmtPrice(null)).toBe("--");
    expect(fmtPrice(undefined)).toBe("--");
    expect(fmtPrice(NaN)).toBe("--");
  });
});

describe("fmtPct", () => {
  it("正数带 +", () => {
    expect(fmtPct(1.82)).toBe("+1.82%");
  });
  it("负数自带 -", () => {
    expect(fmtPct(-0.64)).toBe("-0.64%");
  });
  it("零不带符号", () => {
    expect(fmtPct(0)).toBe("0.00%");
  });
  it("空值为 --", () => {
    expect(fmtPct(null)).toBe("--");
  });
});

describe("fmtAmount", () => {
  it("亿", () => {
    expect(fmtAmount(1.23e8)).toBe("1.23亿");
    expect(fmtAmount(5e9)).toBe("50.00亿");
  });
  it("万", () => {
    expect(fmtAmount(5e4)).toBe("5万");
    expect(fmtAmount(123456)).toBe("12万");
  });
  it("原值", () => {
    expect(fmtAmount(999)).toBe("999");
  });
  it("空值为 --", () => {
    expect(fmtAmount(undefined)).toBe("--");
  });
});

describe("fmtMoney", () => {
  it("正数带 +", () => {
    expect(fmtMoney(2.41e8)).toBe("+2.41亿");
  });
  it("负数带 -", () => {
    expect(fmtMoney(-3e7)).toBe("-3000万");
  });
  it("零不带符号", () => {
    expect(fmtMoney(0)).toBe("0");
  });
  it("空值为 --", () => {
    expect(fmtMoney(null)).toBe("--");
  });
});

describe("fmtVolume", () => {
  it("与 fmtAmount 一致", () => {
    expect(fmtVolume(1e8)).toBe("1.00亿");
    expect(fmtVolume(null)).toBe("--");
  });
});
