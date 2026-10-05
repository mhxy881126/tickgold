const { chromium } = require('playwright');
const path = require('path');

const files = [
  ['revamp-overview.html', 'revamp-overview.png', 1280, 1400],
  ['revamp-A-dock.html', 'revamp-A-dock.png', 1500, 900],
  ['revamp-B-superbar.html', 'revamp-B-superbar.png', 1500, 900],
  ['revamp-C-canvas.html', 'revamp-C-canvas.png', 1500, 900],
  ['revamp-D-splitter.html', 'revamp-D-splitter.png', 1500, 900],
];

(async () => {
  const browser = await chromium.launch();
  const shotsDir = path.join(__dirname, '_shots');
  for (const [html, png, w, h] of files) {
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    const url = 'file:///' + path.join(__dirname, html).replace(/\\/g, '/');
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(shotsDir, png), fullPage: png.includes('overview') });
    console.log('shot:', png);
    await page.close();
  }
  await browser.close();
})();
