// 安全 GFM 子集渲染器（零依赖、纯函数，可在 node 环境直接单测）。
// 安全原则：所有来自模型/工具的文本先经 HTML 转义；代码块与行内代码整体转义、不做内联解析；
// 链接仅允许 http(s)/相对/锚点，拒绝 javascript:、data: 等；最终 HTML 不含任何未转义的外部输入。
// 覆盖：围栏代码块、标题、引用、分隔线、无序/有序列表、表格（含对齐）、
// 加粗、斜体、删除线、行内代码、链接、换行。

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 链接白名单：仅 http(s)、以 / 或 # 开头且不含危险字符的相对地址。 */
function safeUrl(u: string): boolean {
  if (/^https?:\/\//i.test(u)) return true;
  if (/^[/#]/.test(u) && !/[<>"'`\s]/.test(u)) return true;
  return false;
}

interface LinkHold {
  txt: string;
  url: string;
}

/** 行内渲染：输入原始文本，内部完成转义与标记替换。 */
function inline(raw: string): string {
  const codes: string[] = [];
  const links: LinkHold[] = [];

  // 1) 先提取行内代码（内部不再解析任何标记）
  let s = raw.replace(/`([^`]+)`/g, (_m, c) => {
    codes.push(`<code class="md-ic">${escapeHtml(c)}</code>`);
    return `\u0001C${codes.length - 1}\u0001`;
  });

  // 2) 提取链接（在转义前，分别处理文本与地址；不安全则保留原文稍后转义）
  s = s.replace(
    /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    (m, txt: string, url: string) => {
      if (!safeUrl(url)) return m;
      links.push({ txt, url });
      return `\u0001L${links.length - 1}\u0001`;
    }
  );

  // 3) 整体转义（控制字符占位 \u0001 不受影响）
  s = escapeHtml(s);

  // 4) 加粗 / 斜体 / 删除线（标记符号不受转义影响）
  s = s
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/(^|[\n(])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/(^|[\n(])_([^_\n]+)_/g, "$1<em>$2</em>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>");

  // 5) 回填占位
  s = s.replace(/\u0001C(\d+)\u0001/g, (_m, k) => codes[Number(k)]);
  s = s.replace(/\u0001L(\d+)\u0001/g, (_m, k) => {
    const { txt, url } = links[Number(k)];
    return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(txt)}</a>`;
  });
  return s;
}

/** 拆分表格行为单元格数组（去掉首尾的 |）。 */
function splitTableRow(line: string): string[] {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|") && !t.endsWith("\\|")) t = t.slice(0, -1);
  return t.split("|").map((c) => c.trim());
}

function isTableSep(line: string | undefined): boolean {
  if (!line || !line.includes("-")) return false;
  const cells = splitTableRow(line);
  return (
    cells.length > 0 &&
    cells.every((c) => /^:?-+:?$/.test(c.replace(/\s/g, "")))
  );
}

type Align = "left" | "center" | "right";

function alignOf(c: string): Align {
  const l = c.startsWith(":"),
    r = c.endsWith(":");
  if (l && r) return "center";
  if (r) return "right";
  return "left";
}

function alignStyle(a: Align): string {
  return a === "left" ? "" : ` style="text-align:${a}"`;
}

function renderTable(head: string[], aligns: Align[], rows: string[][]): string {
  const th = head
    .map((c, k) => `<th${alignStyle(aligns[k])}>${inline(c)}</th>`)
    .join("");
  const tb = rows
    .map(
      (r) =>
        "<tr>" +
        r.map((c, k) => `<td${alignStyle(aligns[k])}>${inline(c)}</td>`).join("") +
        "</tr>"
    )
    .join("");
  return `<div class="md-table"><table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table></div>`;
}

/** 判断某行是否为块级起始（用于段落收束）。 */
function blockStart(line: string, next: string | undefined): boolean {
  if (/^#{1,6}\s+/.test(line)) return true;
  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) return true;
  if (/^\s*[-*+]\s+/.test(line)) return true;
  if (/^\s*\d+\.\s+/.test(line)) return true;
  if (/^\s*>\s?/.test(line)) return true;
  if (line.includes("|") && isTableSep(next)) return true;
  return false;
}

/** 渲染 Markdown 为安全 HTML。 */
export function renderMarkdown(src: string): string {
  if (!src) return "";
  const blocks: string[] = [];
  const hold = (html: string): string => {
    blocks.push(html);
    return `\u0000B${blocks.length - 1}\u0000`;
  };

  // 1) 提取围栏代码块（连同可选语言标识），整体转义保护
  let text = src.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_m, code: string) =>
    hold(`<pre><code>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`)
  );

  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // 空行
    if (line.trim() === "") {
      i++;
      continue;
    }
    // 围栏代码块占位（单独成行，直接输出不包 <p>）
    if (/^\u0000B\d+\u0000$/.test(line.trim())) {
      out.push(line.trim());
      i++;
      continue;
    }
    // 标题
    const hm = /^(#{1,6})\s+(.*)$/.exec(line);
    if (hm) {
      const lv = hm[1].length;
      out.push(`<h${lv}>${inline(hm[2])}</h${lv}>`);
      i++;
      continue;
    }
    // 表格（表头 + 分隔行）
    if (line.includes("|") && isTableSep(lines[i + 1])) {
      const head = splitTableRow(line);
      const aligns = splitTableRow(lines[i + 1]).map(alignOf);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        rows.push(splitTableRow(lines[i]));
        i++;
      }
      out.push(renderTable(head, aligns, rows));
      continue;
    }
    // 分隔线（在表格判定之后）
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push("<hr>");
      i++;
      continue;
    }
    // 引用块
    if (/^\s*>\s?/.test(line)) {
      const q: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        q.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      out.push(`<blockquote>${q.map(inline).join("<br>")}</blockquote>`);
      continue;
    }
    // 无序列表
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(`<li>${inline(lines[i].replace(/^\s*[-*+]\s+/, ""))}</li>`);
        i++;
      }
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }
    // 有序列表
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(`<li>${inline(lines[i].replace(/^\s*\d+\.\s+/, ""))}</li>`);
        i++;
      }
      out.push(`<ol>${items.join("")}</ol>`);
      continue;
    }
    // 普通段落：收束连续非空、非块起始行
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !blockStart(lines[i], lines[i + 1])
    ) {
      para.push(lines[i]);
      i++;
    }
    out.push(`<p>${para.map(inline).join("<br>")}</p>`);
  }

  let html = out.join("\n");
  // 回填围栏代码块
  html = html.replace(/\u0000B(\d+)\u0000/g, (_m, k) => blocks[Number(k)]);
  return html;
}
