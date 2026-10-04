// 插件运行时注册编排（v2.6）。
// 启动时扫描 + 为已启用插件的 widgets 动态注册微件定义；监听 plugin:event 增量
// 注册 / 注销。插件微件组件统一包装 PluginWidgetHost（iframe 沙箱）。
import { defineComponent, h, markRaw } from "vue";
import { listen } from "@tauri-apps/api/event";
import PluginWidgetHost from "../components/widgets/PluginWidgetHost.vue";
import {
  addWidgetDef,
  removeWidgetDef,
} from "../components/widgets/registry";
import type { WidgetBinding } from "../lib/widgets";
import {
  pluginList,
  pluginReadAsset,
  pluginScan,
  type PluginManifest,
} from "./api";

export const defId = (pluginId: string, widgetId: string) =>
  `plugin:${pluginId}:${widgetId}`;

function makeComponent(pluginId: string, widgetId: string) {
  return markRaw(
    defineComponent({
      name: `plug-${pluginId}-${widgetId}`,
      props: { bind: { type: String, default: null } },
      setup(props) {
        return () =>
          h(PluginWidgetHost, { pluginId, widgetId, bind: props.bind });
      },
    }),
  );
}

function registerWidgets(pluginId: string, m: PluginManifest) {
  for (const w of m.widgets ?? []) {
    addWidgetDef({
      id: defId(pluginId, w.id),
      title: `${m.name} · ${w.title}`,
      component: makeComponent(pluginId, w.id),
      minW: w.minW,
      minH: w.minH,
      defaultW: w.defaultW,
      defaultH: w.defaultH,
      binding: (w.binding as WidgetBinding) || "none",
    });
  }
}

function unregisterWidgets(pluginId: string, m: PluginManifest) {
  for (const w of m.widgets ?? []) removeWidgetDef(defId(pluginId, w.id));
}

const manifests = new Map<string, PluginManifest>();

async function loadManifest(pluginId: string): Promise<PluginManifest | null> {
  try {
    const text = await pluginReadAsset(pluginId, "plugin.json");
    return JSON.parse(text) as PluginManifest;
  } catch {
    return null;
  }
}

/** 应用启动时调用：扫描、注册已启用插件、订阅变更事件。 */
export async function initPluginSystem(): Promise<void> {
  try {
    await pluginScan();
  } catch {
    /* 无内置目录或读取失败时忽略 */
  }
  const rows = await pluginList();
  for (const r of rows) {
    const m = await loadManifest(r.pluginId);
    if (!m) continue;
    manifests.set(r.pluginId, m);
    if (r.enabled) registerWidgets(r.pluginId, m);
  }

  await listen("plugin:event", async (ev) => {
    const p = ev.payload as {
      pluginId?: string;
      enabled?: boolean;
      removed?: boolean;
    };
    const id = p.pluginId;
    if (!id) return;
    if (p.removed) {
      const m = manifests.get(id);
      if (m) unregisterWidgets(id, m);
      manifests.delete(id);
      return;
    }
    if (p.enabled) {
      let m = manifests.get(id);
      if (!m) {
        m = (await loadManifest(id)) ?? undefined;
        if (m) manifests.set(id, m);
      }
      if (m) registerWidgets(id, m);
    } else {
      const m = manifests.get(id);
      if (m) unregisterWidgets(id, m);
    }
  });
}
