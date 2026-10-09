// 一次性诊断：打开 1430，收集控制台错误/页面异常/失败请求
import { chromium } from "@playwright/test";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const logs = [];
page.on("console", (m) => logs.push(`[console.${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}\n${e.stack || ""}`));
page.on("requestfailed", (r) =>
  logs.push(`[requestfailed] ${r.url()} :: ${r.failure()?.errorText}`));

await page.goto("http://127.0.0.1:1430/", { waitUntil: "load", timeout: 20000 }).catch((e) =>
  logs.push(`[goto error] ${e.message}`));
await page.waitForTimeout(5000);

const appHtml = await page.evaluate(() => {
  const el = document.querySelector("#app");
  return {
    childCount: el?.childElementCount ?? -1,
    textLen: (el?.innerText || "").length,
    snippet: (el?.innerText || "").slice(0, 300),
  };
});

console.log(logs.filter((l) => /error|fail/i.test(l)).join("\n") || "(无 error/fail 日志)");
console.log("\n=== #app 状态 ===");
console.log(JSON.stringify(appHtml, null, 2));

await page.screenshot({ path: "screenshots/diag-1430.png" });
await browser.close();
