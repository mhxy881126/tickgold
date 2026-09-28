// 注册内置动作：打开卡片、场景模板切换、窗口操作。
// 命令面板与快捷键共用同一份动作表；在 App setup 调用一次。
import type { Scene } from "../lib/scenes";
import { SCENES } from "../lib/scenes";
import { DOCK_GROUPS } from "../lib/dock";
import { useActions } from "./useActions";

interface Deps {
  toggleCard: (id: import("../lib/cards").CardId) => void;
  applyScene: (s: Scene) => void;
  winMinimize: () => void;
  winToggleMax: () => void;
  winClose: () => void;
}

export function useBuiltinActions(deps: Deps) {
  const { register } = useActions();

  // 打开卡片（复用顶部导航 dock 的图标 / 描述 / 分组）
  for (const g of DOCK_GROUPS) {
    for (const it of g.items) {
      register({
        id: `card.${it.id}`,
        title: it.label,
        desc: it.desc,
        icon: it.icon,
        category: g.name,
        keywords: `卡片 ${it.id} ${it.label}`,
        run: () => deps.toggleCard(it.id),
      });
    }
  }

  // 场景模板一键切换
  for (const s of SCENES) {
    register({
      id: `scene.${s.id}`,
      title: s.label,
      desc: "一键切换整套盯盘布局",
      icon: s.icon,
      category: "场景模板",
      keywords: `场景 ${s.id} ${s.label}`,
      run: () => deps.applyScene(s),
    });
  }

  // 窗口操作
  register({
    id: "window.minimize", title: "最小化", desc: "最小化当前窗口", category: "窗口",
    icon: "M6 18h12v2H6z", run: deps.winMinimize,
  });
  register({
    id: "window.toggleMax", title: "最大化 / 还原", desc: "切换窗口最大化", category: "窗口",
    icon: "M4 4h16v16H4z", run: deps.winToggleMax,
  });
  register({
    id: "window.close", title: "关闭窗口", desc: "退出当前窗口", category: "窗口",
    icon: "M6 6l12 12M18 6L6 18", run: deps.winClose,
  });
}
