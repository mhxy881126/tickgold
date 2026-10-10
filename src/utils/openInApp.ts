/**
 * 统一的外链打开入口：所有 http(s) 外链（AI 回复、资讯卡片、更新下载等）
 * 一律在应用内置浏览器窗口中打开，绝不拉起系统外部浏览器。
 *
 * 窗口由 Rust 端 `open_in_app_browser` 命令创建（单例 label=app-browser），
 * Rust 侧同时拦截窗口内再次产生的 target=_blank 跳转，保证全程不离开应用。
 */
import { invoke } from "@tauri-apps/api/core";

export const APP_BROWSER_LABEL = "app-browser";

export function isExternalHttpUrl(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in window;
}

/**
 * 在内置浏览器窗口打开外链。
 * @param rawUrl 目标 http(s) 地址
 * @param _title 预留标题参数（实际标题由 Rust 端取主机名并在页面加载后同步文档标题）
 */
export async function openInAppBrowser(rawUrl: string, _title?: string): Promise<void> {
  const href = rawUrl.trim();
  if (!isExternalHttpUrl(href)) return;

  // 非 Tauri 环境（纯浏览器预览/单测）回退到新标签页
  if (!isTauriRuntime()) {
    window.open(href, "_blank", "noopener,noreferrer");
    return;
  }

  try {
    await invoke("open_in_app_browser", { url: href });
  } catch (e) {
    console.error("[openInApp] 内置浏览器打开失败:", e);
  }
}

/**
 * 全局拦截当前文档内所有 http(s) 外链点击（捕获阶段，先于各组件自身处理器）。
 * - 同源链接（dev server / tauri 协议）保持默认行为
 * - 非 Tauri 环境不拦截
 * 在每个窗口（main / island / pip）启动时安装一次。
 */
export function installExternalLinkGuard(): void {
  if (typeof document === "undefined" || !isTauriRuntime()) return;

  document.addEventListener(
    "click",
    (ev: MouseEvent) => {
      if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) {
        return;
      }
      const anchor = (ev.target as Element | null)?.closest?.("a[href]") as
        | HTMLAnchorElement
        | null;
      if (!anchor) return;
      const href = anchor.href || anchor.getAttribute("href") || "";
      if (!isExternalHttpUrl(href)) return;
      // 同源（前端路由/开发服务器）放行
      try {
        const u = new URL(href, window.location.href);
        if (u.origin === window.location.origin) return;
      } catch {
        return;
      }
      ev.preventDefault();
      ev.stopPropagation();
      void openInAppBrowser(href);
    },
    true
  );
}
