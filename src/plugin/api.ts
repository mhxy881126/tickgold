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
