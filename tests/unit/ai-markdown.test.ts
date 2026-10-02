import { describe, it, expect } from "vitest";
import { renderMarkdown } from "../../src/ai/markdown";

describe("renderMarkdown 安全（XSS 防护）", () => {
  it("转义原始 HTML，不生成可执行标签", () => {
    const html = renderMarkdown('<script>alert(1)</script>');
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("围栏代码块内容整体转义，不解析内联标签", () => {
    const html = renderMarkdown("```js\n<b>hi</b>\n```");
    expect(html).toContain("<pre><code>");
    expect(html).toContain("&lt;b&gt;hi&lt;/b&gt;");
    expect(html).not.toContain("<b>hi</b>");
  });

  it("行内代码中的尖括号被转义", () => {
    const html = renderMarkdown("用 `a<b && b>c` 判断");
    expect(html).toContain('<code class="md-ic">a&lt;b &amp;&amp; b&gt;c</code>');
  });

  it("拒绝 javascript:/data: 链接，不生成可执行 href", () => {
    const js = renderMarkdown("[x](javascript:alert(1))");
    expect(js).not.toMatch(/<a[^>]*href="javascript:/i);
    const data = renderMarkdown("[x](data:text/html,<script>alert(1)</script>)");
    expect(data).not.toMatch(/<a[^>]*href="data:/i);
  });

  it("放行 http(s) 与相对链接", () => {
    expect(renderMarkdown("[ok](https://example.com/a)")).toContain(
      'href="https://example.com/a"'
    );
    expect(renderMarkdown("[rel](/docs#x)")).toContain('href="/docs#x"');
  });
});

describe("renderMarkdown GFM 子集", () => {
  it("空输入返回空串", () => {
    expect(renderMarkdown("")).toBe("");
  });

  it("渲染标题", () => {
    expect(renderMarkdown("# 标题")).toBe("<h1>标题</h1>");
    expect(renderMarkdown("## 二级")).toBe("<h2>二级</h2>");
  });

  it("渲染加粗 / 删除线", () => {
    expect(renderMarkdown("**粗**")).toContain("<strong>粗</strong>");
    expect(renderMarkdown("~~删~~")).toContain("<del>删</del>");
  });

  it("渲染无序 / 有序列表", () => {
    expect(renderMarkdown("- a\n- b")).toBe("<ul><li>a</li><li>b</li></ul>");
    expect(renderMarkdown("1. a\n2. b")).toBe("<ol><li>a</li><li>b</li></ol>");
  });

  it("渲染表格（表头、单元格）", () => {
    const html = renderMarkdown("| 名称 | 值 |\n| --- | ---: |\n| 甲 | 1 |");
    expect(html).toContain("md-table");
    expect(html).toContain("<th>名称</th>");
    expect(html).toContain('<th style="text-align:right">值</th>');
    expect(html).toContain("<td>甲</td>");
    expect(html).toContain('<td style="text-align:right">1</td>');
  });

  it("渲染引用块与分隔线", () => {
    expect(renderMarkdown("> 引用")).toContain("<blockquote>引用</blockquote>");
    expect(renderMarkdown("---")).toContain("<hr>");
  });
});
