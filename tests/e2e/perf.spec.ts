// 性能基线：全量 28 张卡片同屏，采样帧率与 JS 堆，作为性能回归门禁。
// 说明：headless chromium（含软件合成）下测得，真机 GPU 通常更优；4h 长时间内存用
// PERF_SOAK_SECONDS 环境变量启用「浸泡」测试，真机验收步骤见 docs/开发路线.md。
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "fs";
import { boot, openAllCards, mountAll, cardCount } from "./support/helpers";

test.use({
  viewport: { width: 2560, height: 1440 },
  launchOptions: { args: ["--expose-gc", "--enable-precise-memory-info"] },
});

// GC 后读取 usedJSHeapSize（字节）
async function heap(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const w = window as unknown as { gc?: () => void };
    w.gc?.();
    await new Promise((r) => setTimeout(r, 120));
    w.gc?.();
    const m = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    return Math.round(m?.usedJSHeapSize ?? -1);
  });
}
// requestAnimationFrame 采样，返回平均 fps 与最差帧间隔
async function sampleFps(page: Page, ms: number) {
  return page.evaluate((dur) => new Promise<{ fps: number; worst: number }>((resolve) => {
    let frames = 0; const start = performance.now(); let last = start; let worst = 0;
    function tick(now: number) {
      worst = Math.max(worst, now - last); last = now; frames++;
      if (now - start >= dur) resolve({ fps: frames / ((now - start) / 1000), worst });
      else requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }), ms);
}

test("全量卡片同屏：帧率 ≥50fps、内存无明显增长", async ({ page }) => {
  test.setTimeout(180000);
  mkdirSync("screenshots", { recursive: true });
  await boot(page);
  await openAllCards(page);
  await mountAll(page);
  await page.waitForTimeout(800);

  expect(await cardCount(page)).toBe(28);
  const stats = await page.evaluate(() => ({
    nodes: document.querySelectorAll("*").length,
    canvases: document.querySelectorAll("canvas").length,
  }));

  const heap0 = await heap(page);
  const fps = await sampleFps(page, 8000);
  const heap1 = await heap(page);
  const growth = (heap1 - heap0) / heap0;

  // 验收断言（本机实测 fps≈60、worst≈33ms、8s 增长≈9%，留裕量）。
  // worst 阈值 150ms：CI 软件合成 Chromium 偶发单帧 GC/调度尖峰（实测 100~117ms），
  // fps 仍 ≥50、内存无增长，放宽以容忍慢机噪声，同时拦住秒级真卡顿。
  expect(fps.fps).toBeGreaterThanOrEqual(50);
  expect(fps.worst).toBeLessThan(150);
  expect(growth).toBeLessThan(0.2);

  writeFileSync(
    "screenshots/perf.txt",
    [
      "cards 28",
      `dom nodes ${stats.nodes}, canvases ${stats.canvases}`,
      `fps ${fps.fps.toFixed(1)} (worst frame ${fps.worst.toFixed(0)} ms)`,
      `heap ${(heap0 / 1048576).toFixed(1)}MB -> ${(heap1 / 1048576).toFixed(1)}MB, growth ${(growth * 100).toFixed(1)}% over 8s`,
    ].join("\n"),
    "utf8"
  );
});

// 长时间内存浸泡：默认跳过；以 PERF_SOAK_SECONDS=<秒> 启用（4h=14400）。
test("长时间内存浸泡（PERF_SOAK_SECONDS 启用）", async ({ page }) => {
  const soak = Number(process.env.PERF_SOAK_SECONDS ?? 0);
  test.skip(!soak, "set PERF_SOAK_SECONDS to run the soak test");
  test.setTimeout((soak + 180) * 1000);
  mkdirSync("screenshots", { recursive: true });

  await boot(page);
  await openAllCards(page);
  await mountAll(page);

  const samples: { t: number; heap: number }[] = [];
  const start = Date.now();
  while (Date.now() - start < soak * 1000) {
    await page.waitForTimeout(30000);
    samples.push({ t: Math.round((Date.now() - start) / 1000), heap: await heap(page) });
  }
  writeFileSync(
    "screenshots/perf-soak.csv",
    "t_s,heap_mb\n" + samples.map((s) => `${s.t},${(s.heap / 1048576).toFixed(2)}`).join("\n"),
    "utf8"
  );

  // 后半段堆均值相对前半段增长 <15%（无持续单调上升）
  const half = Math.max(1, Math.floor(samples.length / 2));
  const avg = (a: typeof samples) => a.reduce((s, x) => s + x.heap, 0) / a.length;
  const drift = (avg(samples.slice(half)) - avg(samples.slice(0, half))) / avg(samples.slice(0, half));
  expect(drift).toBeLessThan(0.15);
});
