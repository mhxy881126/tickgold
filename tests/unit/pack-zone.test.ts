import { describe, it, expect } from "vitest";
import { packZone } from "../../src/lib/layout";

describe("packZone 分区域均匀装箱", () => {
  it("空卡片：不写入任何样式", () => {
    const out: Record<string, Record<string, string>> = {};
    packZone([], 0, 12, out);
    expect(out).toEqual({});
  });

  it("2 张卡铺满 12 列：各宽 6、占满 6 行", () => {
    const out: Record<string, Record<string, string>> = {};
    packZone(["radar", "news"], 0, 12, out);
    expect(out.radar.gridColumn).toBe("1 / 7");
    expect(out.news.gridColumn).toBe("7 / 13");
    expect(out.radar.gridRow).toBe("1 / 7");
    expect(out.news.gridRow).toBe("1 / 7");
  });

  it("colStart 偏移：列坐标整体右移", () => {
    // Lw=8，2 张 → k=2，各宽 4；colStart=3
    const out: Record<string, Record<string, string>> = {};
    packZone(["radar", "news"], 3, 8, out);
    expect(out.radar.gridColumn).toBe("4 / 8");
    expect(out.news.gridColumn).toBe("8 / 12");
  });

  it("末行不满时拉伸铺满、无右侧空洞", () => {
    // n=5,Lw=12 → k=3,m=2：第一行 3 张各宽 4，末行 2 张各拉伸为宽 6
    const out: Record<string, Record<string, string>> = {};
    packZone(["radar", "news", "watch", "rank", "alert"], 0, 12, out);
    // 第一行
    expect(out.radar.gridColumn).toBe("1 / 5");
    expect(out.news.gridColumn).toBe("5 / 9");
    expect(out.watch.gridColumn).toBe("9 / 13");
    // 末行两张：宽 6，铺满到第 13 条网格线
    expect(out.rank.gridColumn).toBe("1 / 7");
    expect(out.alert.gridColumn).toBe("7 / 13");
    expect(out.rank.gridRow).toBe("4 / 7");
    expect(out.alert.gridRow).toBe("4 / 7");
  });
});
