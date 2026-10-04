// BIAS 乖离率（内置示例·逻辑插件）。
// 演示同步纯函数指标：ctx.kline 由 Rust 在调用前取好并注入，compute 不做任何异步操作。
// BIAS(n) = (收盘价 - N 日均价) / N 日均价 * 100。
function sma(closes, n) {
  if (closes.length < n) return null;
  var s = 0;
  for (var i = closes.length - n; i < closes.length; i++) s += closes[i];
  return s / n;
}

function makeCompute(n) {
  return function (ctx) {
    var k = (ctx && ctx.kline) || [];
    var closes = k.map(function (b) {
      return b.close;
    });
    var last = closes[closes.length - 1];
    var m = sma(closes, n);
    if (m == null || m === 0 || last == null) {
      return { n: n, price: last || null, ma: m, bias: null };
    }
    return { n: n, price: last, ma: m, bias: ((last - m) / m) * 100 };
  };
}

registerIndicator({ id: "bias6", name: "BIAS6", compute: makeCompute(6) });
registerIndicator({ id: "bias12", name: "BIAS12", compute: makeCompute(12) });
registerIndicator({ id: "bias24", name: "BIAS24", compute: makeCompute(24) });
