import { ref } from "vue";

const KEY = "battle_station_v2";

export interface FlagStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function useBattleFlag(storage: FlagStorage = localStorage) {
  const enabled = ref(storage.getItem(KEY) !== "off");
  function set(v: boolean) {
    enabled.value = v;
    storage.setItem(KEY, v ? "on" : "off");
  }
  return { enabled, set };
}
