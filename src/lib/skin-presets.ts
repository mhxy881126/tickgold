// 内置皮肤：鎏金专业版（首发）。spec 单一数据源，启动幂等 seed 到 skin 表。
import { SKIN_SCHEMA } from "./skin";
import type { SkinSpec } from "./skin";

export const GOLD_SKIN_ID = "gold-pro";

export const GOLD_SKIN: SkinSpec = {
  schema: SKIN_SCHEMA,
  id: GOLD_SKIN_ID,
  name: "鎏金专业版",
  version: 1,
  tokens: {
    surface: {
      bg: "#171b24",
      bg2: "#12151d",
      opacity: 1,
      radius: 11,
      innerShine: true,
    },
    border: {
      color: "#3a3320",
      width: 1,
      hoverColor: "#b98f3e",
    },
    glow: {
      accent: "#d4af37",
      rest: { color: "#d4af37", strength: 0.22 },
      breathe: true,
      breatheSec: 4.5,
      focus: { color: "#f3dd9e", strength: 0.9 },
    },
    leftBar: {
      from: "#f3dd9e",
      to: "#b98f3e",
      width: 3,
      glow: true,
    },
    typography: {
      titleColor: "#ecd9a0",
      titleWeight: 650,
    },
  },
};

export const BUILTIN_SKINS: SkinSpec[] = [GOLD_SKIN];
