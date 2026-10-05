// 灵动岛皮肤预设（Island.vue 与 SettingsDialog 共用）
export type IslandSkinId = "gold" | "onyx" | "glass" | "jade";

export interface IslandSkin {
  id: IslandSkinId;
  label: string;
  desc: string;
  vars: Record<string, string>;
}

export const ISLAND_SKINS: IslandSkin[] = [
  {
    id: "gold",
    label: "金睛",
    desc: "默认金色，与主窗口一致",
    vars: {
      "--bg-from": "#1a1f2e",
      "--bg-to": "#0d1018",
      "--border": "rgba(212,175,55,.35)",
      "--accent": "#d4af37",
      "--accent-soft": "#e8c96a",
      "--avatar-from": "#d4af37",
      "--avatar-to": "#8a6d1f",
    },
  },
  {
    id: "onyx",
    label: "曜石",
    desc: "纯黑极简，无彩色边框",
    vars: {
      "--bg-from": "#1a1a1a",
      "--bg-to": "#000000",
      "--border": "rgba(255,255,255,.12)",
      "--accent": "#e8eaed",
      "--accent-soft": "#ffffff",
      "--avatar-from": "#e8eaed",
      "--avatar-to": "#8a919e",
    },
  },
  {
    id: "glass",
    label: "玻璃",
    desc: "蓝色磨砂玻璃质感",
    vars: {
      "--bg-from": "rgba(20,24,32,.72)",
      "--bg-to": "rgba(10,13,19,.72)",
      "--border": "rgba(78,161,255,.35)",
      "--accent": "#4ea1ff",
      "--accent-soft": "#8ec5ff",
      "--avatar-from": "#4ea1ff",
      "--avatar-to": "#1a5fbf",
    },
  },
  {
    id: "jade",
    label: "翡翠",
    desc: "墨绿护眼，适合长时间盯盘",
    vars: {
      "--bg-from": "#0f1f1a",
      "--bg-to": "#050d0a",
      "--border": "rgba(8,219,148,.35)",
      "--accent": "#08db94",
      "--accent-soft": "#7fffd0",
      "--avatar-from": "#08db94",
      "--avatar-to": "#0a8a5f",
    },
  },
];

const KEY = "island-skin";

export function getIslandSkin(): IslandSkinId {
  const v = localStorage.getItem(KEY);
  if (v === "gold" || v === "onyx" || v === "glass" || v === "jade") return v;
  return "gold";
}

export function setIslandSkin(id: IslandSkinId) {
  localStorage.setItem(KEY, id);
}

export function applyIslandSkin() {
  const id = getIslandSkin();
  const skin = ISLAND_SKINS.find((s) => s.id === id) ?? ISLAND_SKINS[0];
  // 设在 .island 元素上（不是 documentElement），因为 Island.vue 的 scoped style
  // 在 .island 上硬编码了默认变量值，会覆盖 root 上的
  const el = document.querySelector(".island") as HTMLElement | null;
  if (el) {
    Object.entries(skin.vars).forEach(([k, val]) => el.style.setProperty(k, val));
  } else {
    // 兜底：也设在 root 上（主窗口 SettingsDialog 里用）
    const root = document.documentElement;
    Object.entries(skin.vars).forEach(([k, val]) => root.style.setProperty(k, val));
  }
}

// 主窗口切换皮肤后，通过 event 通知灵动岛窗口
export const ISLAND_SKIN_EVENT = "island:skin-changed";

