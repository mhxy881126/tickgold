// =====================================================================
// Level-2 数据源插件 · 开发骨架（v2.32 试点）
//
// 你需要做的：
//   1) 把 plugin.json 里的 https://api.example-level2-vendor.com/* 换成
//      你数据商真实接口的「协议 + 域名 + 路径前缀」白名单；
//   2) 在 buildBookRequest 里按数据商文档拼接 URL / 查询参数 / 请求体；
//   3) 在 parseBookResponse 里把数据商返回的字段映射成统一的 asks/bids；
//   4) 在应用「设置 → 插件」里为本插件录入数据商 API Key。
//
// 重要安全边界（无需你处理，也无法绕过）：
//   - JS 运行在 QuickJS 沙箱内，没有网络 / 文件 / 定时器能力；
//   - 本文件只「描述请求」和「解析响应」，真正的 HTTP 由 Rust 代发；
//   - API Key 保存在系统凭据箱，由 Rust 取出后注入 Authorization 请求头，
//     永远不会传入本 JS，因此你无法（也不必）在代码里读取密钥。
//
// 合规：是否有权接收、使用该 Level-2 数据，由你与数据商的协议决定，
//   TickGold 不内置任何 Level-2 凭证，相关责任由插件使用者自行承担。
// =====================================================================

// A 股代码 → 数据商所需的市场 / 交易所标识（示例映射，按数据商文档调整）。
function marketOf(code) {
  if (/^(60|68|11|13|50|51|56|58)/.test(code)) return "SH";
  if (/^(8|4|920)/.test(code)) return "BJ";
  return "SZ";
}

registerLevel2({
  id: "l2",

  // 入参：{ code }（六证券代码）。
  // 出参：请求描述。url 必填；method 默认 GET；可带普通 headers 与 body。
  // 注意：不要、也无法在这里设置 Authorization——它由 Rust 注入真实 Key。
  buildBookRequest: function (params) {
    var code = params && params.code;
    if (!code) throw new Error("buildBookRequest 缺少 code");

    var market = marketOf(code);
    var url =
      "https://api.example-level2-vendor.com/v1/quote/depth" +
      "?market=" + encodeURIComponent(market) +
      "&code=" + encodeURIComponent(code) +
      "&depth=10";

    return {
      url: url,
      method: "GET",
      // 可在此声明非鉴权类请求头（可选）：
      headers: { Accept: "application/json" },
    };
  },

  // 入参：{ status, body }（body 为响应文本，JSON 需自行 parse）。
  // 出参：{ asks: [...], bids: [...] }，每档为 { price, vol }（vol 单位与免费源
  // 一致，使用「手」；若数据商返回股数，请自行 /100）。
  // asks 为卖盘（价格升序，卖一最靠近现价），bids 为买盘（价格降序，买一最高）。
  parseBookResponse: function (resp) {
    if (!resp || resp.status < 200 || resp.status >= 300) {
      throw new Error("数据源返回 HTTP " + (resp && resp.status));
    }
    var data;
    try {
      data = JSON.parse(resp.body);
    } catch (e) {
      throw new Error("响应不是合法 JSON：" + e);
    }

    // —— 按你的数据商实际结构改写下面的字段路径 ——
    // 示例假设：data = { sell: [{ p, v } ...], buy: [{ p, v } ...] }
    var rawAsks = data.sell || data.asks || [];
    var rawBids = data.buy || data.bids || [];

    function mapLevel(r) {
      var price = Number(r && (r.p != null ? r.p : r.price));
      // 示例数据商以「股」计，这里换算成「手」。
      var vol = Number(r && (r.v != null ? r.v : r.vol)) / 100;
      if (!(price > 0) || !(vol >= 0)) return null;
      return { price: price, vol: vol };
    }

    var asks = [];
    for (var i = 0; i < rawAsks.length; i++) {
      var a = mapLevel(rawAsks[i]);
      if (a) asks.push(a);
    }
    var bids = [];
    for (var j = 0; j < rawBids.length; j++) {
      var b = mapLevel(rawBids[j]);
      if (b) bids.push(b);
    }
    if (!asks.length || !bids.length) {
      throw new Error("响应中缺少有效的 asks/bids");
    }
    return { asks: asks, bids: bids };
  },
});
