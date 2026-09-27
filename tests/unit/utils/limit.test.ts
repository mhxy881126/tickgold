import { describe, it, expect } from "vitest";
import { limitPrices } from "../../../src/utils/limit";

describe("limitPrices 涨跌停价", () => {
  it("主板 10%", () => {
    const [up, dn] = limitPrices("600519", "贵州茅台", 100);
    expect(up).toBe(110);
    expect(dn).toBe(90);
  });

  it("ST 5%", () => {
    const [up, dn] = limitPrices("600001", "ST某某", 10);
    expect(up).toBe(10.5);
    expect(dn).toBe(9.5);
  });

  it("科创/创业板 20%", () => {
    expect(limitPrices("688981", "中芯国际", 100)[0]).toBe(120);
    expect(limitPrices("300750", "宁德时代", 100)[0]).toBe(120);
    expect(limitPrices("301001", "新股", 100)[0]).toBe(120);
  });

  it("北交所 30%", () => {
    expect(limitPrices("430001", "北交股", 10)[0]).toBe(13);
    expect(limitPrices("830001", "北交股", 10)[0]).toBe(13);
    expect(limitPrices("920001", "北交股", 10)[0]).toBe(13);
  });

  it("四舍五入到分", () => {
    const [up, dn] = limitPrices("600519", "贵州茅台", 10.05);
    expect(up).toBe(11.06);
    expect(dn).toBe(9.05);
  });
});
