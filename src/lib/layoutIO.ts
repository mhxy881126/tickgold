// 布局 / 打法模板导入导出：JSON 文件，零额外插件（Blob 下载 + 本地文件选择读取）。
// 文件口径与 layout 表的 cards 字段一致（工作台序列化快照），可跨设备迁移。

export interface LayoutFile {
  kind: "tickgold-layout";
  version: number;
  name: string;
  cards: string;
  exportedAt: number;
}

export function buildLayoutFile(name: string, cards: string): LayoutFile {
  return { kind: "tickgold-layout", version: 1, name, cards, exportedAt: Date.now() };
}

function fileStamp(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/** 导出为 .json 下载（WebView 下载通道） */
export function downloadLayoutFile(f: LayoutFile) {
  const blob = new Blob([JSON.stringify(f, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `TickGold布局-${f.name}-${fileStamp(f.exportedAt)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** 选择并解析一个布局 JSON；格式不符返回 null */
export function pickLayoutFile(): Promise<LayoutFile | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.style.display = "none";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const obj = JSON.parse(String(reader.result));
          if (obj?.kind === "tickgold-layout" && typeof obj.cards === "string")
            resolve(obj as LayoutFile);
          else resolve(null);
        } catch {
          resolve(null);
        }
      };
      reader.onerror = () => resolve(null);
      reader.readAsText(file);
    };
    document.body.appendChild(input);
    input.click();
    input.remove();
  });
}
