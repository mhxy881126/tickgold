#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
TickGold QMT sidecar：以 stdio NDJSON(JSON-RPC) 对接 miniQMT + xtquant。
由 Tauri 侧 broker::sidecar 启动 / 监控 / 退出。
  stdin  : 一行一个请求   {"id","method","params"}
  stdout : 一行一个回报/事件 {"event", ...}
  stderr : 仅日志
依赖：xtquant（以 QMT 客户端自带为准；Python 版本建议 3.8–3.12）。
"""
import argparse
import json
import sys
import threading
import time

# stdout 帧写锁（xtquant 回调线程 + 主线程可能并发输出）
_out_lock = threading.Lock()


def emit(obj):
    """输出一行 JSON（协议帧）。"""
    line = json.dumps(obj, ensure_ascii=False)
    with _out_lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def log(msg):
    sys.stderr.write(str(msg) + "\n")
    sys.stderr.flush()


# QMT 委托状态码 → TickGold 状态
_QMT_STATUS = {
    48: "submitting",  # 未报
    49: "submitting",  # 待报
    50: "submitted",   # 已报
    51: "submitted",   # 已报待撤
    52: "part_filled", # 部成待撤
    53: "cancelled",   # 部撤
    54: "cancelled",   # 已撤
    55: "part_filled", # 部成
    56: "filled",      # 已成
    57: "error",       # 废单
}


class Sidecar:
    def __init__(self, qmt_path, account_id):
        self.qmt_path = qmt_path
        self.account_id = account_id
        self.trader = None
        self.account = None
        # xtquant seq/order_id → client_order_id(sig_id)
        self.order_map = {}
        self.map_lock = threading.Lock()

    # ----- 生命周期 -----
    def connect(self):
        try:
            from xtquant.xttrader import XtQuantTrader
            from xtquant.xttype import StockAccount
        except Exception as e:  # noqa: BLE001
            emit({"event": "error", "message": f"无法导入 xtquant：{e}"})
            return False

        # session_id 用进程相关随机值，避免与其他实例冲突
        session = int(time.time()) % 1_000_000
        self.trader = XtQuantTrader(self.qmt_path, session)
        self.trader.register_callback(_Callback(self))
        self.account = StockAccount(self.account_id)
        self.trader.start()
        rc = self.trader.connect()
        if rc != 0:
            emit({"event": "error", "message": f"连接 miniQMT 失败（code={rc}），请确认客户端已极简模式登录"})
            return False
        self.trader.subscribe(self.account)
        emit({"event": "connected", "account": self.account_id,
              "version": "xtquant"})
        # 心跳线程
        t = threading.Thread(target=self._heartbeat_loop, daemon=True)
        t.start()
        return True

    def _heartbeat_loop(self):
        while True:
            time.sleep(5)
            emit({"event": "heartbeat", "ts": int(time.time())})

    # ----- 交易 -----
    def submit(self, p):
        from xtquant import xtconstant
        code = p.get("code", "")
        side = p.get("side", "BUY")
        price = float(p.get("price", 0))
        vol = int(p.get("vol", 0))
        cid = p.get("client_order_id", "")
        order_type = xtconstant.STOCK_BUY if side == "BUY" else xtconstant.STOCK_SELL
        seq = self.trader.order_stock(
            self.account, code, order_type, vol,
            xtconstant.FIX_PRICE, price,
        )
        if seq is None or seq < 0:
            emit({"event": "error", "client_order_id": cid,
                  "message": f"order_stock 被拒（seq={seq}）"})
            return
        with self.map_lock:
            self.order_map[int(seq)] = cid

    def cancel(self, p):
        # 优先用 broker_order_id；否则用 client_order_id 反查 seq
        boid = p.get("broker_order_id", "")
        if boid:
            order_id = int(boid)
        else:
            cid = p.get("client_order_id", "")
            order_id = None
            with self.map_lock:
                for seq, c in self.order_map.items():
                    if c == cid:
                        order_id = seq
            if order_id is None:
                emit({"event": "error", "client_order_id": cid, "message": "未找到委托，无法撤单"})
                return
        self.trader.cancel_order_stock(self.account, order_id)

    def _pnl_from_positions(self, ps):
        """根据持仓计算浮动盈亏与当日参考盈亏。
        浮动盈亏 = Σ(市值 − 持仓量×开仓均价)；
        当日参考盈亏 = Σ 持仓量×(最新价−昨收)，昨收经 xtdata 全推行情获取，失败则返回 None。"""
        float_pnl = 0.0
        codes = [p.stock_code for p in ps if p.volume > 0]
        ticks = {}
        if codes:
            try:
                from xtquant import xtdata
                ticks = xtdata.get_full_tick(codes) or {}
            except Exception as e:  # noqa: BLE001
                log(f"get_full_tick 获取昨收失败：{e}")
        day_pnl = 0.0
        have_prev = False
        for p in ps:
            if p.volume <= 0:
                continue
            cost = p.volume * (p.open_price or 0.0)
            float_pnl += (p.market_value or 0.0) - cost
            t = ticks.get(p.stock_code) or {}
            last_close = t.get("lastClose") or 0.0
            last_price = t.get("lastPrice") or 0.0
            if last_close > 0 and last_price > 0:
                have_prev = True
                day_pnl += p.volume * (last_price - last_close)
        return round(float_pnl, 2), (round(day_pnl, 2) if have_prev else None)

    def _emit_asset(self, a):
        ps = self.trader.query_stock_positions(self.account) or []
        float_pnl, day_pnl = self._pnl_from_positions(ps)
        out = {"event": "asset", "cash": a.cash, "frozenCash": a.frozen_cash,
               "marketValue": a.market_value, "totalAsset": a.total_asset,
               "floatPnl": float_pnl}
        if day_pnl is not None:
            out["dayPnl"] = day_pnl
        emit(out)

    def query_asset(self):
        a = self.trader.query_stock_asset(self.account)
        if a is None:
            emit({"event": "asset", "note": "暂无资产数据"})
            return
        self._emit_asset(a)

    def query_position(self):
        ps = self.trader.query_stock_positions(self.account) or []
        out = []
        for p in ps:
            out.append({"code": p.stock_code, "vol": p.volume,
                        "avail": p.can_use_volume, "cost": p.open_price,
                        "marketValue": p.market_value})
        emit({"event": "position", "positions": out})

    # ----- 回报分发（由回调调用）-----
    def on_order(self, order):
        with self.map_lock:
            cid = self.order_map.get(int(order.order_id), "")
        status = _QMT_STATUS.get(int(order.order_status), "submitted")
        avg = getattr(order, "traded_price", 0.0) or 0.0
        emit({"event": "order", "client_order_id": cid,
              "broker_order_id": str(order.order_id), "status": status,
              "filled_vol": int(getattr(order, "traded_volume", 0) or 0),
              "filled_avg_price": float(avg)})

    def on_trade(self, trade):
        with self.map_lock:
            cid = self.order_map.get(int(trade.order_id), "")
        emit({"event": "trade", "client_order_id": cid,
              "broker_order_id": str(trade.order_id),
              "filled_vol": int(trade.traded_volume),
              "filled_avg_price": float(trade.traded_price)})

    def on_disconnected(self):
        emit({"event": "disconnected"})


try:
    import xtquant.xttrader as _xt_trader

    class _Callback(_xt_trader.XtQuantTraderCallback):
        def __init__(self, sc):
            super().__init__()
            self.sc = sc

        def on_disconnected(self):
            self.sc.on_disconnected()

        def on_stock_order(self, order):
            self.sc.on_order(order)

        def on_stock_trade(self, trade):
            self.sc.on_trade(trade)

        def on_stock_asset(self, asset):
            self.sc._emit_asset(asset)

        def on_stock_position(self, position):
            emit({"event": "position", "positions": [{
                "code": position.stock_code, "vol": position.volume,
                "avail": position.can_use_volume}]})

        def on_order_error(self, order_error):
            emit({"event": "error", "message": str(getattr(order_error, "error_msg", order_error))})

        def on_cancel_error(self, cancel_error):
            emit({"event": "error", "message": str(getattr(cancel_error, "error_msg", cancel_error))})
except Exception as e:  # noqa: BLE001
    # 定义一个兜底回调类，保证脚本可启动并通过 error 事件上报
    class _Callback:  # type: ignore
        def __init__(self, sc):
            self.sc = sc


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--qmt", required=True)
    ap.add_argument("--account", required=True)
    args = ap.parse_args()

    sc = Sidecar(args.qmt, args.account)
    if not sc.connect():
        # 连接失败：短暂等待后退出，Rust 侧通过进程退出感知
        time.sleep(0.5)
        sys.exit(1)

    # stdin 命令循环
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            req = json.loads(raw)
        except Exception:  # noqa: BLE001
            continue
        method = req.get("method", "")
        p = req.get("params", {}) or {}
        try:
            if method == "submit":
                sc.submit(p)
            elif method == "cancel":
                sc.cancel(p)
            elif method == "query_asset":
                sc.query_asset()
            elif method == "query_position":
                sc.query_position()
            elif method == "heartbeat":
                emit({"event": "heartbeat", "ts": int(time.time())})
            elif method in ("kill", "disconnect"):
                break
        except Exception as e:  # noqa: BLE001
            cid = p.get("client_order_id", "")
            emit({"event": "error", "client_order_id": cid, "message": str(e)})


if __name__ == "__main__":
    main()
