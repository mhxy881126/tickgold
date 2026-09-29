// 卡片皮肤协议：在「配色主题」之上的卡片渲染层（不替换全局 15 个 CSS 变量）。
// 三级合并：全局皮肤 → 场景皮肤 → 单卡 CardCustom（按字段深合并，单卡手色最高）。
// 本文件为纯函数模块，不依赖 Vue / DB，便于单测。
import type { CardCustom } from "./cards";

export const SKIN_SCHEMA = "tickgold-skin/1";

// ===== Token 结构（所有字段可选；缺字段回落主题/默认）=====
export interface SkinTokens {
  surface: {
    bg?: string;
    bg2?: string;
    opacity?: number; // 0.6..1
    radius?: number; // 6..18
    innerShine?: boolean;
  };
  border: {
    color?: string;
    width?: number; // 0..2
    hoverColor?: string;
  };
  glow: {
    accent?: string;
    rest?: { color?: string; strength?: number }; // strength 0..1
    breathe?: boolean;
    breatheSec?: number;
    focus?: { color?: string; strength?: number };
  };
  leftBar: {
    from?: string;
    to?: string;
    width?: number; // 2..6 px
    glow?: boolean;
  };
  typography: {
    fontFamily?: string;
    numFont?: string;
    titleColor?: string;
    titleWeight?: number; // 400..800
  };
  motion: {
    easeEnter?: string;
    easeMove?: string;
    flashUp?: string;
    flashDown?: string;
  };
}

export type PartialTokens = {
  [K in keyof SkinTokens]?: Partial<SkinTokens[K]>;
};

export interface SkinSpec {
  schema: typeof SKIN_SCHEMA;
  id: string;
  name: string;
  version: number;
  tokens: PartialTokens;
}

const TOKEN_GROUPS: (keyof SkinTokens)[] = [
  "surface",
  "border",
  "glow",
  "leftBar",
  "typography",
  "motion",
];

// ===== 深合并（仅合并已知两层结构；数组不出现）=====
export function mergeTokens(layers: PartialTokens[]): PartialTokens {
  const out: PartialTokens = {};
  for (const layer of layers) {
    if (!layer || typeof layer !== "object") continue;
    for (const g of TOKEN_GROUPS) {
      const src = layer[g];
      if (!src || typeof src !== "object") continue;
      if (g === "glow") {
        // glow.rest / glow.focus 需第三层深合并；其余字段浅合并
        const { rest, focus, ...shallow } = src as Partial<SkinTokens["glow"]>;
        const og = { ...(out.glow ?? {}), ...shallow };
        if (rest) og.rest = { ...og.rest, ...rest };
        if (focus) og.focus = { ...og.focus, ...focus };
        out.glow = og;
      } else {
        out[g] = { ...(out[g] ?? {}), ...src };
      }
    }
  }
  return out;
}

// 把单卡 CardCustom 映射为 token 层（合并优先级最高）
export function tokensFromCustom(cu: CardCustom | undefined): PartialTokens {
  if (!cu) return {};
  const t: PartialTokens = {};
  if (cu.color) t.glow = { accent: cu.color };
  if (cu.opacity !== undefined) t.surface = { opacity: cu.opacity };
  if (cu.radius !== undefined) t.surface = { ...t.surface, radius: cu.radius };
  if (cu.borderWidth !== undefined) t.border = { width: cu.borderWidth };
  // 本卡辉光开关：关闭即把常驻强度归零
  if (cu.glow === false) t.glow = { ...t.glow, rest: { strength: 0 } };
  // 左条辉光开关
  if (cu.barGlow === false) t.leftBar = { glow: false };
  return t;
}

export interface ResolveArgs {
  global?: SkinSpec | null;
  scene?: SkinSpec | null;
  custom?: CardCustom;
}
// 三级合并入口
export function resolveTokens({ global, scene, custom }: ResolveArgs): PartialTokens {
  return mergeTokens([
    global?.tokens ?? {},
    scene?.tokens ?? {},
    tokensFromCustom(custom),
  ]);
}

// ===== 导入校验 =====
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const ID_RE = /^[a-z0-9][a-z0-9-_]{0,31}$/;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function num(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}
function asColor(v: unknown): string | null {
  return typeof v === "string" && HEX.test(v) ? v : null;
}
// 递归按字段白名单清洗一个 token 组；非法字段直接丢弃
function sanitizeTokens(raw: unknown): PartialTokens {
  const out: PartialTokens = {};
  if (!isObj(raw)) throw new Error("tokens 必须是对象");
  for (const g of TOKEN_GROUPS) {
    const grp = raw[g];
    if (grp === undefined) continue;
    if (!isObj(grp)) throw new Error(`tokens.${g} 必须是对象`);
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(grp)) {
      if (v === null || v === undefined) continue;
      // 颜色字段
      if (
        ["bg", "bg2", "color", "hoverColor", "accent", "from", "to", "titleColor",
          "flashUp", "flashDown"].includes(k)
      ) {
        const c = asColor(v);
        if (k === "flashUp" || k === "flashDown") {
          // 语义动画色允许非颜色的缓动？这里仅接受颜色
        }
        if (!c) throw new Error(`tokens.${g}.${k} 颜色非法（需 #rgb/#rrggbb）`);
        clean[k] = c;
      } else if (["opacity", "strength"].includes(k)) {
        if (!num(v) || v < 0 || v > 1) throw new Error(`tokens.${g}.${k} 需在 0..1`);
        clean[k] = v;
      } else if (k === "radius" || k === "width" || k === "breatheSec" || k === "titleWeight") {
        if (!num(v) || v < 0) throw new Error(`tokens.${g}.${k} 需为非负数`);
        clean[k] = v;
      } else if (k === "innerShine" || k === "breathe" || k === "glow") {
        if (typeof v !== "boolean") throw new Error(`tokens.${g}.${k} 需为布尔值`);
        clean[k] = v;
      } else if (k === "fontFamily" || k === "numFont" ||
                 k === "easeEnter" || k === "easeMove") {
        if (typeof v !== "string" || v.length > 120)
          throw new Error(`tokens.${g}.${k} 需为 ≤120 字符的字符串`);
        clean[k] = v;
      } else if (k === "rest" || k === "focus") {
        if (!isObj(v)) throw new Error(`tokens.glow.${k} 必须是对象`);
        const sub: Record<string, unknown> = {};
        for (const [sk, sv] of Object.entries(v)) {
          if (sk === "color") {
            const c = asColor(sv);
            if (!c) throw new Error(`tokens.glow.${k}.color 颜色非法`);
            sub.color = c;
          } else if (sk === "strength") {
            if (!num(sv) || sv < 0 || sv > 1)
              throw new Error(`tokens.glow.${k}.strength 需在 0..1`);
            sub.strength = sv;
          } else {
            throw new Error(`tokens.glow.${k}.${sk} 非白名单字段`);
          }
        }
        clean[k] = sub;
      } else {
        throw new Error(`tokens.${g}.${k} 非白名单字段`);
      }
    }
    if (Object.keys(clean).length) (out as Record<string, unknown>)[g] = clean;
  }
  return out;
}

// 解析并严格校验一份皮肤 JSON；任何非法字段抛错
export function parseSkinSpec(input: unknown): SkinSpec {
  if (!isObj(input)) throw new Error("皮肤必须是 JSON 对象");
  if (input.schema !== SKIN_SCHEMA)
    throw new Error(`schema 标识无效（需 ${SKIN_SCHEMA}）`);
  if (typeof input.id !== "string" || !ID_RE.test(input.id))
    throw new Error("id 需为 1..32 位小写字母/数字/连字符");
  if (typeof input.name !== "string" || !input.name || input.name.length > 40)
    throw new Error("name 需为 1..40 字符");
  if (input.version !== undefined && (!num(input.version) || input.version < 1))
    throw new Error("version 需为 ≥1 的数字");
  const tokens = sanitizeTokens(input.tokens);
  return {
    schema: SKIN_SCHEMA,
    id: input.id,
    name: input.name,
    version: num(input.version) ? input.version : 1,
    tokens,
  };
}

// 把合并后的 token 转换为注入卡片根元素的 CSS 变量（仅出现的字段）
export function skinCssVars(t: PartialTokens): Record<string, string> {
  const v: Record<string, string> = {};
  const put = (k: string, val: string | number | undefined) => {
    if (val !== undefined) v[k] = String(val);
  };
  if (t.surface) {
    put("--card-bg", t.surface.bg);
    put("--card-bg2", t.surface.bg2);
    put("--card-surface-opacity", t.surface.opacity);
    put("--card-skin-radius", t.surface.radius !== undefined ? `${t.surface.radius}px` : undefined);
    if (t.surface.innerShine !== undefined)
      put("--inner-shine", t.surface.innerShine ? "1" : "0");
  }
  if (t.border) {
    put("--card-border-color", t.border.color);
    put("--card-hover-color", t.border.hoverColor);
    put("--card-skin-border", t.border.width !== undefined ? `${t.border.width}px` : undefined);
  }
  if (t.glow) {
    put("--card-glow", t.glow.accent ?? t.glow.rest?.color);
    put("--card-glow-strength", t.glow.rest?.strength);
    if (t.glow.breathe !== undefined) put("--card-breathe-name", t.glow.breathe ? "breatheGlow" : "none");
    put("--card-breathe-sec", t.glow.breatheSec);
    put("--card-focus-glow", t.glow.focus?.color);
    put("--card-focus-strength", t.glow.focus?.strength);
  }
  if (t.leftBar) {
    put("--bar-from", t.leftBar.from);
    put("--bar-to", t.leftBar.to);
    put("--bar-width", t.leftBar.width !== undefined ? `${t.leftBar.width}px` : undefined);
    if (t.leftBar.glow !== undefined) put("--bar-glow", t.leftBar.glow ? "1" : "0");
  }
  if (t.typography) {
    put("--card-font-family", t.typography.fontFamily);
    put("--card-num-font", t.typography.numFont);
    put("--title-color", t.typography.titleColor);
    put("--title-weight", t.typography.titleWeight);
  }
  return v;
}
