import { describe, expect, it } from "vitest";
import { useBattleFlag, type FlagStorage } from "../../src/components/battle/useBattleFlag";

function memStorage(init: Record<string, string> = {}): FlagStorage & { map: Map<string, string> } {
  const map = new Map(Object.entries(init));
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => { map.set(k, v); },
  };
}

describe("useBattleFlag", () => {
  it("默认开启，关闭后写入存储", () => {
    const s = memStorage();
    const f = useBattleFlag(s);
    expect(f.enabled.value).toBe(true);
    f.set(false);
    expect(s.map.get("battle_station_v2")).toBe("off");
    expect(f.enabled.value).toBe(false);
  });

  it("存储为 off 时默认关闭", () => {
    const f = useBattleFlag(memStorage({ battle_station_v2: "off" }));
    expect(f.enabled.value).toBe(false);
  });
});
