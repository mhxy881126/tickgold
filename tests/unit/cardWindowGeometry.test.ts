import { describe, it, expect } from "vitest";
import { loadGeometry, saveGeometry } from "../../src/lib/cardWindowGeometry";

function memStore(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage;
}

describe("卡片窗几何持久化", () => {
  it("无记录返回默认", () => {
    const g = loadGeometry("chart", memStore());
    expect(g.width).toBe(960);
    expect(g.height).toBe(640);
  });
  it("保存后按 id 读取", () => {
    const s = memStore();
    saveGeometry("chart", { width: 800, height: 500, x: 10, y: 20 }, s);
    expect(loadGeometry("chart", s)).toMatchObject({ width: 800, height: 500, x: 10, y: 20 });
    // 不影响其他卡片
    expect(loadGeometry("order", s).width).toBe(960);
  });
  it("损坏 JSON 回退默认", () => {
    const s = memStore();
    s.setItem("tickgold.card-window.v1", "not-json");
    expect(loadGeometry("chart", s).width).toBe(960);
  });
  it("过小几何回退默认", () => {
    const s = memStore();
    saveGeometry("chart", { width: 50, height: 50 }, s);
    expect(loadGeometry("chart", s).width).toBe(960);
  });
});
