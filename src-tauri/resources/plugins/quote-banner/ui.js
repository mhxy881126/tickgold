// 报价大字条（内置示例·UI 插件）。
// 演示：iframe 沙箱 + 父侧推送的实时行情（TickGold.onQuote），不直接访问网络。
(function () {
  var style = document.createElement("style");
  style.textContent =
    ".banner{height:100%;display:flex;align-items:center;justify-content:space-between;" +
    "gap:10px;padding:6px 12px;box-sizing:border-box;}" +
    ".b-price{font-size:26px;font-weight:800;line-height:1;font-variant-numeric:tabular-nums;}" +
    ".b-pct{font-size:14px;font-weight:700;font-variant-numeric:tabular-nums;}" +
    ".up{color:#f23645;}.down{color:#08db94;}";
  document.head.appendChild(style);

  var app = document.getElementById("app");
  app.innerHTML =
    '<div class="banner">' +
    '<span class="b-price">--</span>' +
    '<span class="b-pct">--</span>' +
    "</div>";
  var priceEl = app.querySelector(".b-price");
  var pctEl = app.querySelector(".b-pct");

  function draw(q) {
    if (!q) return;
    var up = (q.pct || 0) >= 0;
    priceEl.textContent = q.price != null ? Number(q.price).toFixed(2) : "--";
    priceEl.className = "b-price " + (up ? "up" : "down");
    pctEl.textContent = q.pct != null ? (up ? "+" : "") + Number(q.pct).toFixed(2) + "%" : "--";
    pctEl.className = "b-pct " + (up ? "up" : "down");
  }

  TickGold.onQuote(draw);
  draw(TickGold.currentQuote());
})();
