// 插件生态前端 API（v2.6）。
import { invoke } from "@tauri-apps/api/core";

export interface PluginRow {
  pluginId: string;
  name: string;
  version: string;
  apiVersion: number;
  builtin: boolean;
  sourcePath: string;
  enabled: boolean;
  signed: boolean;
  hash: string;
  permissions: string[];
  status: string;
  errorMsg: string;
}

export interface WidgetDecl {
  id: string;
  title: string;
  minW: number;
  minH: number;
  defaultW: number;
  defaultH: number;
  binding: string;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  apiVersion: number;
  permissions: string[];
  main?: string;
  ui?: string;
  widgets: WidgetDecl[];
}

export const pluginList = () => invoke<PluginRow[]>("plugin_list");
export const pluginScan = () => invoke<number>("plugin_scan");
export const pluginInstall = (fromPath: string) =>
  invoke<string>("plugin_install", { fromPath });
export const pluginEnable = (pluginId: string) =>
  invoke("plugin_enable", { pluginId });
export const pluginDisable = (pluginId: string) =>
  invoke("plugin_disable", { pluginId });
export const pluginUninstall = (pluginId: string) =>
  invoke("plugin_uninstall", { pluginId });
export const pluginRpc = <T = unknown>(
  pluginId: string,
  method: string,
  params: unknown,
) => invoke<T>("plugin_rpc", { pluginId, method, params });
export const pluginGetDevMode = () => invoke<boolean>("plugin_get_dev_mode");
export const pluginSetDevMode = (on: boolean) =>
  invoke("plugin_set_dev_mode", { on });
export const pluginReload = (pluginId: string) =>
  invoke("plugin_reload", { pluginId });

/** 读取插件目录内的白名单文本资源（ui.js / plugin.json / icon.svg）。 */
export const pluginReadAsset = (pluginId: string, relPath: string) =>
  invoke<string>("plugin_read_asset", { pluginId, relPath });

// ===== v2.32 Level-2 数据源试点 =====

export interface L2ProviderInfo {
  pluginId: string;
  name: string;
  providers: string[];
  keySet: boolean;
}

/** 发现已启用、声明 level2:read 且注册了 provider 的数据源。 */
export const pluginL2Providers = () =>
  invoke<L2ProviderInfo[]>("plugin_l2_providers");

/** 为某 Level-2 插件录入数据商 API Key（存系统凭据箱，不落 JS/库）。 */
export const pluginL2SetKey = (pluginId: string, key: string) =>
  invoke<void>("plugin_l2_set_key", { pluginId, key });

export const pluginL2KeySet = (pluginId: string) =>
  invoke<boolean>("plugin_l2_key_set", { pluginId });

export const pluginL2ClearKey = (pluginId: string) =>
  invoke<void>("plugin_l2_clear_key", { pluginId });

/**
 * 取插件 Level-2 深度盘口。返回与免费源一致的 OrderBook（asks/bids 可能为十档）。
 * 失败由调用方安全降级回免费五档。
 */
export const pluginL2Book = (pluginId: string, code: string, provider: string) =>
  pluginRpc<import("../api/types").OrderBook>(pluginId, "level2.book", { code, provider });
