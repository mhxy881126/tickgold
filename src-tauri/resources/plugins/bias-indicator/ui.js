// BIAS 乖离率面板（内置示例·UI 侧）。
// 演示端到端：iframe → plugin_rpc(indicator.compute) → Rust 取 K 线 → QuickJS 同步 compute → 回传。
(function () {
  var style = document.createElement("style");
  style.textContent =
    ".bias{height:100%;display:flex;flex-direction:column;padding:8px 11px;box-sizing:border-box;gap:5px;}" +
    ".b-title{font-size:11px;font-weight:700;}" +
    ".b-rows{flex:1;display:flex;flex-direction:column;justify-content:center;gap:7px;}" +
    ".br{display:flex;align-items:baseline;justify-content:space-between;gap:8px;}" +
    ".br label{font-size:10px;color:#9aa0aa;}" +
    ".br b{font-size:12px;font-weight:700;font-variant-numeric:tabular-nums;}" +
    ".up{color:#f23645;}.down{color:#08db94;}";
  document.head.appendChild(style);

  var app = document.getElementById("app");
  app.innerHTML =
    '<div class="bias"><div class="b-title">BIAS 乖离率</div><div class="b-rows">' +
    '<div class="br"><label>BIAS6</label><b id="bias6">--</b></div>' +
    '<div class="br"><label>BIAS12</label><b id="bias12">--</b></div>' +
    '<div class="br"><label>BIAS24</label><b id="bias24">--</b></div>' +
    "</div></div>";

  function setVal(n, v) {
    var el = app.querySelector("#bias" + n);
    if (v && v.bias != null) {
      var up = v.bias >= 0;
      el.textContent = (up ? "+" : "") + Number(v.bias).toFixed(2) + "%";
      el.className = up ? "up" : "down";
    }
  }

  async function refresh() {
    var code = TickGold.code();
    if (!code) return;
    [6, 12, 24].forEach(function (n) {
      TickGold.computeIndicator("bias" + n, { code: code, period: 5, count: n + 6 })
        .then(function (v) {
          setVal(n, v);
        })
        .catch(function () {});
    });
  }

  refresh();
  TickGold.onQuote(refresh);
})();
