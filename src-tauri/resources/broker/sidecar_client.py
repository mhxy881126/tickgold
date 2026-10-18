#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
TickGold 客户端自动化 sidecar（P3）：以 stdio NDJSON(JSON-RPC) 操控桌面交易客户端。
由 Tauri 侧 broker::sidecar 启动 / 监控 / 退出。

  stdin  : 一行一个请求   {"id","method","params"}
  stdout : 一行一个回报/事件 {"event", ...}
  stderr : 仅日志

当前支持厂商：
  --vendor ths   同花顺（默认；同花顺模拟炒股为虚拟资金，不碰真钱）

协议事件：
  connected / selfcheck / error / heartbeat / screenshot / note /
  asset / position / trades / pending / order / trade /
  current_page / app_state / disconnected
请求方法：
  submit / position_order / cancel / cancel_all /
  confirm / reject / captcha_input /
  query_asset / query_position / query_trades / query_pending /
  check_app / current_page / send_key / click /
  heartbeat / kill / disconnect

两种下单模式：
  --auto-confirm   全自动：自动填单并点确认（模拟环境默认）
  半自动（不传）   ：仅自动填单，发 screenshot 后挂起，等待 stdin 的 confirm/reject。

安全护栏：
  * 相邻下单限速（--min-interval，默认 1200ms）；
  * 下单前截图回传（screenshot 事件）；
  * 读回客户端控件字段与期望逐字段比对，不一致立即 abort；
  * 窗口保护：未登录 / 弹窗遮挡 / 多开 / 分辨率变化 / 失焦即暂停；
  * kill 立即停止一切动作。

无客户端 / 开发机验证：
  --dry-run   不导入 pywinauto、不连接真实客户端，内置虚拟账户模拟整套事件，
              用于在没有同花顺的环境端到端验证 Tauri 链路。

依赖（仅真实模式需要）：pywinauto、pyautogui、pillow（pip install pywinauto pyautogui pillow）。
注意：真实模式控件选择器随客户端版本变化，需在 <template-dir>/selectors.json 校准（见真机手册）。
"""
import argparse
import base64
import contextlib
import json
import os
import re
import struct
import sys
import threading
import time
import zlib

# stdout 帧写锁
_out_lock = threading.Lock()

# HTTP API 事件捕获器：{"type": str, "box": dict, "done": threading.Event} 或 None。
# 查询类方法只 emit 不返回值，API 线程通过它同步取回查询结果。
_api_capture = None


def emit(obj):
    """输出一行 JSON（协议帧）；若有 API 捕获器且事件类型匹配，则旁路取回。"""
    line = json.dumps(obj, ensure_ascii=False)
    with _out_lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()
    cap = _api_capture
    if cap is not None:
        ev = obj.get("event")
        if ev == cap["type"] or cap["type"] == "*":
            cap["box"].update(obj)
            cap["done"].set()


def log(msg):
    sys.stderr.write(str(msg) + "\n")
    sys.stderr.flush()


# ============================== 纯标准库占位截图（dry-run 用） ==============================

def _png_shot(width, height, header_rgb, title=""):
    """无 PIL 时生成一张“下单窗口”风格占位 PNG（深灰底 + 顶部买卖色标题栏），返回 data URL。"""
    bg = (24, 26, 32)
    panel = (38, 41, 50)
    grid = (52, 56, 68)
    white = (210, 214, 224)

    def px(x, y):
        if y < 46:  # 标题栏
            return header_rgb
        if y < 60:  # 标题栏下分隔
            return grid
        # 面板边框
        if 78 <= y < 300 and (x < 18 or x > width - 18):
            return panel
        # 几条字段横线
        for gy in (110, 150, 190, 230):
            if gy <= y < gy + 2 and 40 < x < width - 40:
                return grid
        # 底部确认按钮区
        if y > height - 64 and 60 < x < width - 60:
            return (24, 80, 60) if header_rgb[1] > 100 else (96, 34, 40)
        return bg

    raw = bytearray()
    for y in range(height):
        raw.append(0)  # filter type 0
        for x in range(width):
            raw.extend(bytes(px(x, y)))

    def chunk(typ, data):
        c = typ + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)  # 8-bit RGB
    idat = zlib.compress(bytes(raw), 9)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")
    return "data:image/png;base64," + base64.b64encode(png).decode("ascii")


# ============================== 费用（dry-run 自洽口径，与主应用近似） ==============================

def calc_fee(amount, side):
    """万 1 佣金（最低 5 元）；卖出千 1 印花税。返回 (commission, stamp)。"""
    commission = max(round(amount * 0.0001, 2), 5.0)
    stamp = round(amount * 0.001, 2) if side == "SELL" else 0.0
    return commission, stamp


def bare_code(code):
    """同花顺下单框输入 6 位裸码；去掉交易所后缀（600519.SH -> 600519）。"""
    return str(code).split(".")[0].strip()


# ============================== Sidecar 基类 ==============================

class BaseSidecar:
    def __init__(self, vendor, account, sim, auto_confirm, min_interval_ms, template_dir,
                 whitelist=None, max_amount=0.0, max_daily=0.0):
        self.vendor = vendor
        self.account = account
        self.sim = sim
        self.auto_confirm = auto_confirm
        self.min_interval = max(0.0, min_interval_ms) / 1000.0
        self.template_dir = template_dir
        self.last_submit_ts = 0.0
        self.last_window_rect = None
        # 半自动待确认：cid -> {"event":Event, "approved":bool}
        self.pending = {}
        self.pending_lock = threading.Lock()
        # P4 真实模式独立护栏（RealSidecar 真实账户置 True；dry-run / 模拟恒为 False）
        self.live_guarded = False
        self.whitelist = set(whitelist or [])
        self.max_amount = float(max_amount or 0.0)
        self.max_daily = float(max_daily or 0.0)
        self.live_bought_today = 0.0

    # 子类实现
    def connect(self):
        raise NotImplementedError

    def do_submit(self, p):
        raise NotImplementedError

    def do_cancel(self, p):
        raise NotImplementedError

    def do_query_asset(self):
        raise NotImplementedError

    def do_query_position(self):
        raise NotImplementedError

    # 限速 + 基础校验（两种模式共用）
    def pre_check(self, p):
        code = bare_code(p.get("code", ""))
        side = p.get("side", "BUY")
        try:
            price = float(p.get("price", 0))
            vol = int(p.get("vol", 0))
        except (TypeError, ValueError):
            return None, "价格或数量不是有效数字"
        cid = p.get("client_order_id", "")
        if not re.fullmatch(r"\d{6}", code):
            return None, f"证券代码非法：{code}（应为 6 位数字）"
        if side not in ("BUY", "SELL"):
            return None, f"买卖方向非法：{side}"
        if price <= 0:
            return None, f"价格必须大于 0：{price}"
        if vol <= 0 or vol % 100 != 0:
            return None, f"数量必须为 100 的正整数倍：{vol}"
        now = time.time()
        if self.min_interval > 0 and self.last_submit_ts and now - self.last_submit_ts < self.min_interval:
            wait = self.min_interval - (now - self.last_submit_ts)
            return None, f"下单限速冷却中，请 {wait:.1f}s 后再试"
        self.last_submit_ts = now
        # P4 真实模式 sidecar 独立护栏（与 Rust 武装闸门纵深，任一被绕过都不下单）
        if self.live_guarded:
            amount = price * vol
            if self.whitelist and code not in self.whitelist:
                return None, f"真实模式拦截：标的 {code} 不在实盘白名单（sidecar 兜底）"
            if self.max_amount and amount > self.max_amount + 1e-6:
                return None, f"真实模式拦截：金额 {amount:.0f} 超过单笔上限 {self.max_amount:.0f}（sidecar 兜底）"
            if side == "BUY" and self.max_daily and self.live_bought_today + amount > self.max_daily + 1e-6:
                return None, (f"真实模式拦截：单日累计买入将达 {self.live_bought_today + amount:.0f}，"
                              f"超过上限 {self.max_daily:.0f}（sidecar 兜底）")
        return {"code": code, "side": side, "price": price, "vol": vol, "cid": cid}, ""

    # 提交（后台线程执行，避免阻塞 stdin 读循环，保证半自动可收到 confirm）
    def submit(self, p):
        t = threading.Thread(target=self._submit_guard, args=(p,), daemon=True)
        t.start()

    def _submit_guard(self, p):
        cid = p.get("client_order_id", "")
        try:
            self.do_submit(p)
        except Exception as e:  # noqa: BLE001
            log(f"submit 异常：{e}")
            emit({"event": "error", "client_order_id": cid, "message": f"客户端下单失败：{e}"})

    def resolve(self, cid, approved):
        """半自动确认/拒绝（由 stdin confirm/reject 调用）。"""
        with self.pending_lock:
            slot = self.pending.get(cid)
        if not slot:
            log(f"confirm/reject 未找到待确认委托：{cid}")
            return
        slot["approved"] = bool(approved)
        slot["event"].set()

    def heartbeat_loop(self):
        while True:
            time.sleep(5)
            emit({"event": "heartbeat", "ts": int(time.time())})


# ============================== dry-run：内置虚拟账户 ==============================

class DryRunSidecar(BaseSidecar):
    """不连接真实客户端，模拟同花顺模拟炒股的事件与账户，用于链路验证。"""

    def __init__(self, **kw):
        super().__init__(**kw)
        self.cash = 1_000_000.0
        # code -> {"vol":int,"avail":int,"cost":float}
        self.positions = {}
        # 当日成交流水（供 query_trades 回读）
        self.trades = []
        self.lock = threading.Lock()

    def connect(self):
        checks = [
            {"name": "python", "ok": True, "msg": sys.version.split()[0]},
            {"name": "pywinauto", "ok": True, "msg": "dry-run 无需 pywinauto"},
            {"name": "client_window", "ok": True, "msg": "dry-run 虚拟客户端"},
            {"name": "login", "ok": True, "msg": "模拟炒股已登录"},
            {"name": "templates", "ok": True, "msg": "dry-run 内置模板"},
            {"name": "resolution", "ok": True, "msg": "1920x1080@100%"},
        ]
        emit({"event": "selfcheck", "vendor": self.vendor, "sim": self.sim, "dryRun": True,
              "window_sim": None, "checks": checks})
        emit({"event": "connected", "vendor": self.vendor, "sim": self.sim,
              "dryRun": True, "window_sim": None, "account": self.account or "SIM",
              "mode": "auto" if self.auto_confirm else "semi"})
        threading.Thread(target=self.heartbeat_loop, daemon=True).start()
        return True

    def _shot(self, side, code, price, vol):
        rgb = (242, 54, 69) if side == "BUY" else (8, 219, 151)
        return _png_shot(480, 340, rgb)

    def do_submit(self, p):
        parsed, err = self.pre_check(p)
        cid = p.get("client_order_id", "")
        if err:
            emit({"event": "error", "client_order_id": cid, "message": err})
            return
        code, side, price, vol = parsed["code"], parsed["side"], parsed["price"], parsed["vol"]
        amount = round(price * vol, 2)
        # 填单前预校验资金/持仓，不足直接拒绝（避免“先提交再报错”）；成交时再做一次并发兜底。
        commission0, _stamp0 = calc_fee(amount, side)
        with self.lock:
            if side == "BUY" and self.cash < amount + commission0:
                emit({"event": "error", "client_order_id": cid,
                      "message": f"可用资金不足：需 {amount + commission0:.2f}，可用 {self.cash:.2f}"})
                return
            if side == "SELL":
                _pos = self.positions.get(code)
                _avail = _pos["avail"] if _pos else 0
                if _avail < vol:
                    emit({"event": "error", "client_order_id": cid,
                          "message": f"可用持仓不足：需 {vol}，可用 {_avail}"})
                    return
        broker_oid = f"DRY{int(time.time()*1000) % 10**8}"
        emit({"event": "order", "client_order_id": cid, "broker_order_id": broker_oid,
              "status": "submitting", "filled_vol": 0, "filled_avg_price": 0.0})

        # 模拟填单耗时
        time.sleep(0.4)
        shot = self._shot(side, code, price, vol)
        emit({"event": "screenshot", "client_order_id": cid, "shot": shot,
              "expect": {"code": code, "side": side, "price": price, "vol": vol,
                         "amount": amount, "sim": self.sim, "autoConfirm": self.auto_confirm}})
        emit({"event": "order", "client_order_id": cid, "status": "submitted",
              "filled_vol": 0, "filled_avg_price": 0.0})

        # 半自动：挂起等 confirm/reject
        if not self.auto_confirm:
            slot = {"event": threading.Event(), "approved": False}
            with self.pending_lock:
                self.pending[cid] = slot
            slot["event"].wait(timeout=120)
            with self.pending_lock:
                self.pending.pop(cid, None)
            if not slot["approved"]:
                emit({"event": "order", "client_order_id": cid, "status": "cancelled",
                      "filled_vol": 0, "filled_avg_price": 0.0})
                emit({"event": "note", "client_order_id": cid, "message": "人工已拒绝，未提交委托"})
                return
            time.sleep(0.2)

        # 资金/持仓校验（二次）
        with self.lock:
            if side == "BUY":
                commission, _ = calc_fee(amount, side)
                if self.cash < amount + commission:
                    emit({"event": "error", "client_order_id": cid,
                          "message": f"可用资金不足：需 {amount + commission:.2f}，可用 {self.cash:.2f}"})
                    emit({"event": "order", "client_order_id": cid, "status": "error",
                          "filled_vol": 0, "filled_avg_price": 0.0})
                    return
                self.cash -= amount + commission
                pos = self.positions.setdefault(code, {"vol": 0, "avail": 0, "cost": 0.0})
                new_vol = pos["vol"] + vol
                pos["cost"] = (pos["cost"] * pos["vol"] + amount) / new_vol
                pos["vol"] = new_vol
                pos["avail"] = new_vol  # dry-run 简化 T+1，保证卖出可立即演示
            else:
                pos = self.positions.get(code)
                if not pos or pos["avail"] < vol:
                    avail = pos["avail"] if pos else 0
                    emit({"event": "error", "client_order_id": cid,
                          "message": f"可用持仓不足：需 {vol}，可用 {avail}"})
                    emit({"event": "order", "client_order_id": cid, "status": "error",
                          "filled_vol": 0, "filled_avg_price": 0.0})
                    return
                commission, stamp = calc_fee(amount, side)
                self.cash += amount - commission - stamp
                pos["vol"] -= vol
                pos["avail"] -= vol
                if pos["vol"] <= 0:
                    self.positions.pop(code, None)

        time.sleep(0.3)
        emit({"event": "order", "client_order_id": cid, "broker_order_id": broker_oid,
              "status": "filled", "filled_vol": vol, "filled_avg_price": price})
        emit({"event": "trade", "client_order_id": cid, "broker_order_id": broker_oid,
              "filled_vol": vol, "filled_avg_price": price})
        with self.lock:
            self.trades.append({"code": code, "name": "", "side": side,
                                "price": price, "vol": vol,
                                "time": time.strftime("%H:%M:%S"), "status": "已成"})
        self.do_query_asset()
        self.do_query_position()

    def do_cancel(self, p):
        cid = p.get("client_order_id", "")
        # dry-run 无真实在途（提交即成交），直接回执
        emit({"event": "order", "client_order_id": cid, "status": "cancelled",
              "filled_vol": 0, "filled_avg_price": 0.0})

    def do_query_asset(self):
        with self.lock:
            market_value = round(sum(q["vol"] * q["cost"] for q in self.positions.values()), 2)
            total = round(self.cash + market_value, 2)
        emit({"event": "asset", "cash": round(self.cash, 2), "frozenCash": 0.0,
              "marketValue": market_value, "totalAsset": total,
              "floatPnl": 0.0, "dayPnl": 0.0, "source": "dry-run"})

    def do_query_position(self):
        with self.lock:
            out = [{"code": c, "vol": q["vol"], "avail": q["avail"],
                    "cost": round(q["cost"], 3), "marketValue": round(q["vol"] * q["cost"], 2)}
                   for c, q in self.positions.items()]
        emit({"event": "position", "positions": out, "full": True, "source": "dry-run"})

    # ---- P7：与真实通道对齐的查询 / 撤单 / 仓位 / 探测，便于无客户端端到端验证 ----
    def do_query_trades(self):
        with self.lock:
            trades = [dict(t) for t in self.trades]
        emit({"event": "trades", "trades": trades, "full": True, "source": "dry-run"})

    def do_query_pending(self):
        # dry-run 提交即成交，无在途挂单
        emit({"event": "pending", "orders": [], "full": True, "source": "dry-run",
              "note": "dry-run 提交即成交，无在途挂单"})

    def do_cancel_all(self, p):
        cid = p.get("client_order_id", "")
        ctype = (p.get("type") or "A").upper()
        label = {"A": "全部撤单", "X": "撤买", "C": "撤卖"}.get(ctype, "全部撤单")
        emit({"event": "note", "client_order_id": cid,
              "message": f"dry-run 无在途挂单，已模拟执行{label}"})

    def do_position_order(self, p):
        cid = p.get("client_order_id", "")
        code = bare_code(p.get("code", ""))
        side = p.get("side", "BUY")
        position = int(p.get("position", 0) or 0)
        ref_price = p.get("ref_price", p.get("refPrice", 0))
        if not re.fullmatch(r"\d{6}", code):
            emit({"event": "error", "client_order_id": cid, "message": f"证券代码非法：{code}"})
            return
        if side not in ("BUY", "SELL"):
            emit({"event": "error", "client_order_id": cid, "message": f"买卖方向非法：{side}"})
            return
        if position not in (0, 1, 2, 3, 4):
            emit({"event": "error", "client_order_id": cid, "message": "仓位档只能是 1(全仓)/2(半仓)/3(1/3)/4(1/4)/0(满仓)"})
            return
        try:
            price = float(ref_price or 0)
        except (TypeError, ValueError):
            price = 0.0
        if price <= 0:
            emit({"event": "error", "client_order_id": cid, "message": "仓位下单需提供参考价 ref_price"})
            return
        with self.lock:
            if side == "BUY":
                budget = self.cash if position in (0, 1) else self.cash / position
                vol = int(budget // (price * 100)) * 100
            else:
                pos = self.positions.get(code)
                avail = pos["avail"] if pos else 0
                vol = avail if position in (0, 1) else (avail // position // 100) * 100
        if vol < 100:
            emit({"event": "error", "client_order_id": cid, "message": f"按仓位计算后不足 100 股（{vol}），无法下单"})
            return
        # 换算为固定数量后复用标准下单（含半自动确认、费用、资金/持仓更新）
        self.do_submit({"client_order_id": cid, "code": code, "side": side,
                        "price": price, "vol": vol})

    def do_check_app(self):
        emit({"event": "app_state", "running": True,
              "page": {"found": True, "title": "网上股票交易系统5.0（dry-run）",
                       "className": "DryRun", "running": True}})

    def do_current_page(self):
        emit({"event": "current_page", "found": True, "hwnd": 0, "pid": 0,
              "title": "网上股票交易系统5.0（dry-run）", "className": "DryRun",
              "rect": None, "isMinimized": False, "isMaximized": False, "running": True})

    def do_send_key(self, p):
        emit({"event": "note", "message": f"dry-run 已模拟发送按键：{p.get('key', '')}"})

    def do_click(self, p):
        emit({"event": "note", "message": f"dry-run 已模拟点击坐标 ({p.get('x')},{p.get('y')})"})

    def resolve_captcha(self, text):
        emit({"event": "note", "message": f"dry-run 无需验证码，已忽略输入：{text}"})


# ============================== 同花顺表格解析（移植自 THSAutoTrader，纯函数可单测） ==============================

def parse_tabular_data(table_data, required_headers=()):
    """把同花顺“复制表格”得到的 TSV 文本解析为 list[dict]。

    严格规则（与 THSAutoTrader table_parser 一致）：
      * 第一行为表头，字段名即同花顺原始表头；
      * 表头不允许空字段或重复字段；
      * 每个数据行列数必须与表头一致（末尾空列会先被剥离），否则报错；
      * 证券代码等前导零由调用方在取值时原样保留（此处不做数值化）。
    """
    if not isinstance(table_data, str) or not table_data.strip():
        raise ValueError("表格内容为空或不是文本")
    lines = table_data.splitlines()
    headers = lines[0].rstrip("\t").split("\t")
    if not all(headers) or len(set(headers)) != len(headers):
        raise ValueError("表格表头包含空字段或重复字段")
    missing = [h for h in required_headers if h not in headers]
    if missing:
        raise ValueError(f"表格缺少必要字段: {', '.join(missing)}")
    rows = []
    for line_no, line in enumerate(lines[1:], start=2):
        if not line.strip():
            continue
        values = line.split("\t")
        while len(values) > len(headers) and values[-1] == "":
            values.pop()
        if len(values) != len(headers):
            raise ValueError(f"表格第{line_no}行列数与表头不一致")
        rows.append(dict(zip(headers, values)))
    return rows


def _num(text):
    """把同花顺文本数字清洗为 float；去千分位逗号、货币符号、空白；无法解析返回 None。"""
    if text is None:
        return None
    s = str(text).strip().replace(",", "").replace("，", "")
    s = s.replace("元", "").replace("%", "").replace(" ", "")
    if s in ("", "--", "-", "—"):
        return None
    try:
        return float(s)
    except ValueError:
        return None


def _int(text):
    n = _num(text)
    return int(n) if n is not None else None


def _pick(row, aliases):
    """按候选中文表头依次取第一个存在且非空的原始值。"""
    for key in aliases:
        if key in row and str(row[key]).strip() not in ("", "--"):
            return row[key]
    return None


# 中文表头 → TickGold 协议字段的别名（不同同花顺版本表头略有差异，全部兼容）。
_CODE_ALIASES = ("证券代码", "股票代码", "代码")
_NAME_ALIASES = ("证券名称", "股票名称", "名称")
_VOL_ALIASES = ("股票余额", "持仓数量", "数量", "股东余额")
_AVAIL_ALIASES = ("可用余额", "可用数量", "可用股数", "可用")
_COST_ALIASES = ("成本价", "买入成本", "持仓成本")
_PRICE_ALIASES = ("市价", "最新价", "成交价格", "当前价", "价格")
_MV_ALIASES = ("市值", "股票市值", "参考市值")
_PNL_ALIASES = ("盈亏", "浮动盈亏", "持仓盈亏")
_DAYPNL_ALIASES = ("当日盈亏", "今日盈亏")
_TIME_ALIASES = ("成交时间", "委托时间", "时间")
_SIDE_ALIASES = ("买卖方向", "操作", "方向", "买卖")
_ORDER_VOL_ALIASES = ("委托数量", "申报数量", "数量")
_FILLED_VOL_ALIASES = ("成交数量", "成交股数", "已成数量")
_ORDER_PRICE_ALIASES = ("委托价格", "申报价格", "委托均价")
_STATUS_ALIASES = ("状态", "备注")


def normalize_position(rows):
    """持仓表 dict 列表 → 协议 position 项（代码保留前导零）。"""
    out = []
    for r in rows:
        code = _pick(r, _CODE_ALIASES)
        if code is None:
            continue
        code = str(code).strip()
        out.append({
            "code": code,
            "name": (_pick(r, _NAME_ALIASES) or "").strip(),
            "vol": _int(_pick(r, _VOL_ALIASES)) or 0,
            "avail": _int(_pick(r, _AVAIL_ALIASES)) or 0,
            "cost": _num(_pick(r, _COST_ALIASES)) or 0.0,
            "price": _num(_pick(r, _PRICE_ALIASES)) or 0.0,
            "marketValue": _num(_pick(r, _MV_ALIASES)) or 0.0,
            "pnl": _num(_pick(r, _PNL_ALIASES)),
            "dayPnl": _num(_pick(r, _DAYPNL_ALIASES)),
        })
    return out


def normalize_trade(row):
    """当日成交行 → 协议 trade 项。"""
    code = _pick(row, _CODE_ALIASES)
    if code is None:
        return None
    side_raw = (_pick(row, _SIDE_ALIASES) or "").strip()
    side = "SELL" if ("卖" in side_raw) else ("BUY" if "买" in side_raw else "")
    return {
        "code": str(code).strip(),
        "name": (_pick(row, _NAME_ALIASES) or "").strip(),
        "side": side,
        "price": _num(_pick(row, (*_PRICE_ALIASES, *_ORDER_PRICE_ALIASES))) or 0.0,
        "vol": _int(_pick(row, (*_FILLED_VOL_ALIASES, *_ORDER_VOL_ALIASES))) or 0,
        "time": (_pick(row, _TIME_ALIASES) or "").strip(),
        "status": (_pick(row, _STATUS_ALIASES) or "").strip(),
    }


def normalize_pending(row):
    """挂单（委托）行 → 协议 pending 项。"""
    code = _pick(row, _CODE_ALIASES)
    if code is None:
        return None
    side_raw = (_pick(row, _SIDE_ALIASES) or "").strip()
    side = "SELL" if ("卖" in side_raw) else ("BUY" if "买" in side_raw else "")
    return {
        "code": str(code).strip(),
        "name": (_pick(row, _NAME_ALIASES) or "").strip(),
        "side": side,
        "price": _num(_pick(row, (*_ORDER_PRICE_ALIASES, *_PRICE_ALIASES))) or 0.0,
        "vol": _int(_pick(row, _ORDER_VOL_ALIASES)) or 0,
        "filledVol": _int(_pick(row, _FILLED_VOL_ALIASES)) or 0,
        "time": (_pick(row, _TIME_ALIASES) or "").strip(),
        "status": (_pick(row, _STATUS_ALIASES) or "").strip(),
    }


def normalize_balance(fields):
    """资金控件字典（中文键）→ 协议 asset 字段。缺项为 None，由前端显示占位。"""
    return {
        "cash": _num(fields.get("资金余额")),
        "frozenCash": _num(fields.get("冻结金额")),
        "availableCash": _num(fields.get("可用金额")),
        "withdrawableCash": _num(fields.get("可取金额")),
        "marketValue": _num(fields.get("股票市值")),
        "totalAsset": _num(fields.get("总资产")),
        "floatPnl": _num(fields.get("持仓盈亏")),
        "dayPnl": _num(fields.get("当日盈亏")),
        "dayPnlRatio": _num(fields.get("当日盈亏比")),
    }


# ============================== 真实模式：同花顺 UI 自动化（移植 THSAutoTrader 键盘精灵引擎） ==============================

class GuiBusyError(RuntimeError):
    """GUI 互斥锁 30s 抢锁失败（同花顺窗口是唯一共享资源，操作必须串行）。"""


class CaptchaRequiredError(RuntimeError):
    """复制表格弹出验证码且本机无法自动 OCR，需要人工输入。携带验证码截图 data URL。"""

    def __init__(self, message, shot=""):
        super().__init__(message)
        self.shot = shot


# 同花顺网上股票交易系统 5.0 控件 AutomationId（移植自 THSAutoTrader，随版本可能需校准）。
CID_LIST = 1047            # 表格内容区：点击后 Ctrl+C 复制整张表
CID_CAPTCHA_IMG = 2405     # 复制验证码图片
CID_CAPTCHA_INPUT = 2404   # 验证码输入框
CID_CAPTCHA_ERR = 2406     # 验证码错误提示（存在即代表输入错误）
CID_CAPTCHA_OK = 1         # 验证码确认按钮
CID_CAPTCHA_CANCEL = 2     # 验证码取消按钮
CID_CANCEL_ALL = 30001     # 全撤
CID_CANCEL_BUY = 30002     # 撤买
CID_CANCEL_SELL = 30003    # 撤卖
CID_ORDER_AMT = 1034       # 下单数量 / 可用数量
CID_REFRESH_AVAIL = 1528   # 刷新可用数量
CID_ORDER_CONFIRM = 1006   # 买入/卖出确认
CID_QUERY_TREE_ROOT = 200  # 左侧查询树根
# 仓位档：1=全仓 2=半仓 1/3 1/4（对应同花顺四个快捷按钮 12092~12095）
POSITION_BUTTON_BASE = 12092
BALANCE_FIELDS = {
    "资金余额": 1012, "冻结金额": 1013, "可用金额": 1016, "可取金额": 1017,
    "股票市值": 1014, "总资产": 1015, "持仓盈亏": 1027, "当日盈亏": 1026, "当日盈亏比": 1029,
}
DIALOG_CLASS = "#32770"    # 闪电下单确认弹窗是标准 Win32 对话框
MAIN_TITLE = "网上股票交易系统5.0"


class ThsGuiEngine:
    """同花顺键盘精灵 GUI 引擎（移植自 THSAutoTrader，仅 Windows、真实模式需要）。

    所有 Windows 专用依赖（pywinauto / pywin32 / psutil / pyautogui / pytesseract）
    均在方法内 import，使本文件在 dry-run / 非 Windows 环境无需安装即可运行。
    """

    def __init__(self, client_path="", title_re="", tesseract_cmd="", log_fn=None):
        self.client_path = client_path or ""
        self.title_re = title_re or r"网上股票交易系统|同花顺|模拟炒股|交易系统"
        self.tesseract_cmd = tesseract_cmd
        self.log = log_fn or (lambda m: None)
        self.main_win = None
        # GUI 全局互斥锁：同花顺窗口焦点/当前页面是唯一共享资源，所有操作串行。
        self.gui_lock = threading.Lock()
        self.gui_lock_timeout = 30.0

    # ---------- 依赖自检 ----------
    def dependency_checks(self):
        """返回真实模式依赖自检结果（缺库给出明确 pip 提示）。"""
        checks = []
        try:
            import pywinauto  # noqa: F401
            import win32api  # noqa: F401
            checks.append({"name": "pywinauto", "ok": True, "msg": "已安装"})
        except Exception as e:  # noqa: BLE001
            checks.append({"name": "pywinauto", "ok": False,
                           "msg": f"{e}；请 pip install pywinauto pywin32"})
        try:
            import psutil  # noqa: F401
            checks.append({"name": "psutil", "ok": True, "msg": "已安装"})
        except Exception:  # noqa: BLE001
            checks.append({"name": "psutil", "ok": False, "msg": "未安装，进程探测将降级；pip install psutil"})
        try:
            import pyautogui  # noqa: F401
            checks.append({"name": "pyautogui", "ok": True, "msg": "已安装"})
        except Exception:  # noqa: BLE001
            checks.append({"name": "pyautogui", "ok": False, "msg": "未安装，坐标点击不可用；pip install pyautogui"})
        ocr_ok, ocr_msg = self._ocr_available()
        checks.append({"name": "ocr", "ok": ocr_ok, "msg": ocr_msg})
        return checks

    def _ocr_available(self):
        try:
            import pytesseract  # noqa: F401
            if self.tesseract_cmd and not os.path.exists(self.tesseract_cmd):
                return False, f"tesseract.exe 不存在：{self.tesseract_cmd}（验证码将转人工）"
            return True, "Tesseract OCR 可用"
        except Exception:  # noqa: BLE001
            return False, "未安装 pytesseract，复制验证码将转人工输入；pip install pytesseract pillow"

    # ---------- 互斥锁 ----------
    @contextlib.contextmanager
    def locked(self):
        got = self.gui_lock.acquire(timeout=self.gui_lock_timeout)
        if not got:
            raise GuiBusyError("同花顺窗口正被占用（GUI 操作串行），请稍后重试")
        try:
            yield
        finally:
            self.gui_lock.release()

    # ---------- 进程 / 窗口 ----------
    def check_process(self):
        """纯进程探测：下单程序（默认 xiadan.exe）是否在运行。psutil 缺失时返回 None=未知。"""
        target = os.path.basename(self.client_path).lower() if self.client_path else "xiadan.exe"
        try:
            import psutil
            for proc in psutil.process_iter(["name"]):
                try:
                    name = proc.info["name"]
                    if name and name.lower() == target:
                        return True
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    continue
            return False
        except Exception:  # noqa: BLE001
            return None

    def _find_window(self, **params):
        from pywinauto import Desktop
        dialogs = Desktop(backend="uia").windows(**params)
        return dialogs[0] if dialogs else None

    def find_main_window(self, retries=3, delay=0.5):
        """查找主交易窗口（网上股票交易系统5.0 / 模拟）。"""
        import re as _re
        last = None
        for _ in range(retries):
            # 优先精确标题，其次正则（模拟窗口标题可能含“模拟”）。
            win = self._find_window(title=MAIN_TITLE)
            if win is None:
                try:
                    for w in self._find_window(title_re=".*") and __import__("pywinauto").Desktop(backend="uia").windows():
                        t = w.window_text() or ""
                        if _re.search(self.title_re, t):
                            win = w
                            break
                except Exception as e:  # noqa: BLE001
                    last = e
            if win is not None:
                return win
            time.sleep(delay)
        if last:
            self.log(f"窗口查找降级异常：{last}")
        return None

    def find_dialog(self, retries=6, delay=0.5):
        """闪电下单确认弹窗（标准 #32770 对话框）。"""
        for _ in range(retries):
            win = self._find_window(class_name=DIALOG_CLASS)
            if win is not None:
                try:
                    if win.is_visible():
                        return win
                except Exception:  # noqa: BLE001
                    return win
            time.sleep(delay)
        return None

    def activate(self, win=None):
        """激活交易窗口到前台（最小化先还原，SetForegroundWindow 失败则 pywinauto 兜底）。"""
        import win32con
        import win32gui
        target = win if win is not None else self.find_main_window()
        if target is None:
            raise RuntimeError("未找到交易窗口，请先启动并登录同花顺独立交易端（非精简模式）")
        target.click_input()
        try:
            hwnd = target.handle
            if win32gui.IsIconic(hwnd):
                win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
            try:
                win32gui.SetForegroundWindow(hwnd)
            except Exception:  # noqa: BLE001
                target.set_focus()
        except Exception:  # noqa: BLE001
            try:
                target.set_focus()
            except Exception:  # noqa: BLE001
                pass
        time.sleep(0.3)
        return target

    def window_info(self):
        """当前主窗口状态（对应 THSAutoTrader /current_page）。"""
        import ctypes
        import win32gui
        import win32process
        win = self.find_main_window(retries=1)
        if win is None:
            return {"found": False, "title": "", "running": self.check_process()}
        hwnd = win.handle
        l, t, r, b = win32gui.GetWindowRect(hwnd)
        _, pid = win32process.GetWindowThreadProcessId(hwnd)
        return {
            "found": True,
            "hwnd": hwnd,
            "pid": pid,
            "title": win32gui.GetWindowText(hwnd),
            "className": win32gui.GetClassName(hwnd),
            "rect": {"left": l, "top": t, "right": r, "bottom": b,
                     "width": r - l, "height": b - t},
            "isMinimized": bool(win32gui.IsIconic(hwnd)),
            "isMaximized": bool(ctypes.windll.user32.IsZoomed(hwnd)),
            "running": self.check_process(),
        }

    # ---------- 键盘精灵 ----------
    def _vk(self, key):
        import win32con
        table = {
            "ENTER": win32con.VK_RETURN, "ESC": win32con.VK_ESCAPE,
            "TAB": win32con.VK_TAB, "F1": win32con.VK_F1, "F2": win32con.VK_F2,
            "F3": win32con.VK_F3, "F4": win32con.VK_F4, "F5": win32con.VK_F5,
            "F6": win32con.VK_F6, "F7": win32con.VK_F7, "F8": win32con.VK_F8,
            "F9": win32con.VK_F9, "F10": win32con.VK_F10, "F11": win32con.VK_F11,
            "F12": win32con.VK_F12, "CTRL": win32con.VK_CONTROL, "ALT": win32con.VK_MENU,
            "SHIFT": win32con.VK_SHIFT, "DEL": win32con.VK_DELETE, "INSERT": win32con.VK_INSERT,
            "HOME": win32con.VK_HOME, "END": win32con.VK_END,
            "PAGEUP": win32con.VK_PRIOR, "PAGEDOWN": win32con.VK_NEXT,
            "UP": win32con.VK_UP, "DOWN": win32con.VK_DOWN,
            "LEFT": win32con.VK_LEFT, "RIGHT": win32con.VK_RIGHT,
        }
        return table.get(key.upper())

    def _tap(self, vk):
        import win32api
        import win32con
        win32api.keybd_event(vk, 0, 0, 0)
        win32api.keybd_event(vk, 0, win32con.KEYEVENTF_KEYUP, 0)
        time.sleep(0.05)

    def _combo(self, combo):
        """CTRL+C 这类组合键（+ 连接）。"""
        import win32api
        parts = [p.strip().upper() for p in combo.split("+")]
        vks = []
        for p in parts:
            vk = self._vk(p) if len(p) > 1 else ord(p.upper())
            if vk is None:
                raise RuntimeError(f"无效按键：{p}")
            vks.append(vk)
        for vk in vks[:-1]:
            win32api.keybd_event(vk, 0, 0, 0)
            time.sleep(0.05)
        self._tap(vks[-1])
        for vk in reversed(vks[:-1]):
            self._release(vk)

    def _release(self, vk):
        import win32api
        import win32con
        win32api.keybd_event(vk, 0, win32con.KEYEVENTF_KEYUP, 0)
        time.sleep(0.05)

    def send_key(self, keys):
        """发送键盘精灵序列。空格=0.5s 停顿；花括号 {CTRL+C} 为组合键；其余逐键。

        例：'600000 ENTER 21 ENTER'、'F3'、'{CTRL+C}'。
        """
        import win32api
        for token in keys.split(" "):
            t = token.strip()
            if t == "":
                time.sleep(0.5)
                continue
            if t.startswith("{") and t.endswith("}"):
                self._combo(t[1:-1])
                continue
            vk = self._vk(t)
            if vk is not None:
                self._tap(vk)
            elif len(t) == 1:
                self._tap(ord(t.upper()))
            else:
                for ch in t:
                    self._tap(ord(ch.upper()))

    def click_xy(self, x, y):
        """屏幕绝对坐标点击（高级调试用，pyautogui）。"""
        import pyautogui
        pyautogui.click(int(x), int(y))

    # ---------- 控件 ----------
    def find_id(self, win, cid):
        for el in win.descendants():
            try:
                if el.control_id() == cid:
                    return el
            except Exception:  # noqa: BLE001
                continue
        return None

    def find_ids(self, win, cids):
        want = set(cids)
        out = {}
        for el in win.descendants():
            try:
                cid = el.control_id()
                if cid in want:
                    out[cid] = el
                    if len(out) == len(want):
                        break
            except Exception:  # noqa: BLE001
                continue
        return out

    def click_id(self, win, cid, retries=3, delay=0.5):
        last = None
        for _ in range(retries):
            el = self.find_id(win, cid)
            if el is not None:
                el.click_input()
                return True
            last = f"未找到控件 {cid}"
            time.sleep(delay)
        raise RuntimeError(last or f"未找到控件 {cid}")

    def input_id(self, win, cid, text, delay=0.3):
        el = self.find_id(win, cid)
        if el is None:
            raise RuntimeError(f"未找到输入控件 {cid}")
        el.set_focus()
        time.sleep(delay)
        el.type_keys(text)
        return True

    def text_id(self, win, cid):
        el = self.find_id(win, cid)
        return el.window_text().strip() if el is not None else None

    def tree_path(self, win, root_cid, names):
        """在树形控件中按路径逐级查找（如 200 → 查询[F4] → 当日成交）。"""
        cur = self.find_id(win, root_cid)
        if cur is None:
            return None
        for name in names:
            nxt = None
            for coll in (cur.children(), cur.descendants()):
                for child in coll:
                    try:
                        if child.window_text() == name:
                            nxt = child
                            break
                    except Exception:  # noqa: BLE001
                        continue
                if nxt is not None:
                    break
            if nxt is None:
                return None
            cur = nxt
        return cur

    # ---------- 剪贴板表格 ----------
    def clear_clipboard(self):
        import win32clipboard
        win32clipboard.OpenClipboard()
        try:
            win32clipboard.EmptyClipboard()
        finally:
            win32clipboard.CloseClipboard()

    def get_clipboard(self, retries=3, delay=0.1):
        from pywinauto.clipboard import GetData
        last = None
        for _ in range(retries):
            try:
                data = GetData()
                if data:
                    return data
            except Exception as e:  # noqa: BLE001
                last = e
            time.sleep(delay)
        if last:
            raise RuntimeError(f"读取剪贴板失败：{last}")
        return None

    def _element_shot(self, el):
        try:
            import io as _io
            img = el.capture_as_image()
            buf = _io.BytesIO()
            img.save(buf, format="PNG")
            return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")
        except Exception:  # noqa: BLE001
            return ""

    def handle_captcha(self, win, captcha_el):
        """处理复制验证码弹窗：优先 Tesseract OCR；不可用/失败抛 CaptchaRequiredError 转人工。"""
        captcha_win = captcha_el.parent()
        input_el = self.find_id(captcha_win, CID_CAPTCHA_INPUT)
        ok_btn = self.find_id(captcha_win, CID_CAPTCHA_OK)
        if input_el is None or ok_btn is None:
            raise RuntimeError("无法定位验证码输入框或确认按钮")
        shot = self._element_shot(captcha_el)
        text = self._ocr_captcha(captcha_el)
        if not text:
            raise CaptchaRequiredError("验证码自动识别失败，需要人工输入", shot)
        self._submit_captcha(captcha_win, input_el, ok_btn, text)

    def submit_manual_captcha(self, win, text):
        """人工在确认桥输入验证码后，填入并提交。win 为主窗口（内部重新定位弹窗）。"""
        captcha_el = self.find_id(win, CID_CAPTCHA_IMG)
        if captcha_el is None:
            raise RuntimeError("未发现验证码弹窗，可能已关闭")
        captcha_win = captcha_el.parent()
        input_el = self.find_id(captcha_win, CID_CAPTCHA_INPUT)
        ok_btn = self.find_id(captcha_win, CID_CAPTCHA_OK)
        self._submit_captcha(captcha_win, input_el, ok_btn, text)

    def _submit_captcha(self, captcha_win, input_el, ok_btn, text):
        input_el.set_focus()
        time.sleep(0.2)
        input_el.type_keys("^a{BACKSPACE}" + str(text))
        time.sleep(0.3)
        ok_btn.click()
        time.sleep(0.3)
        err = self.find_id(captcha_win, CID_CAPTCHA_ERR)
        if err is not None:
            try:
                cancel = self.find_id(captcha_win, CID_CAPTCHA_CANCEL)
                if cancel is not None:
                    cancel.click()
            except Exception:  # noqa: BLE001
                pass
            raise RuntimeError("验证码输入错误")

    def _ocr_captcha(self, captcha_el):
        try:
            import pytesseract
            if self.tesseract_cmd:
                pytesseract.pytesseract.tesseract_cmd = self.tesseract_cmd
            img = captcha_el.capture_as_image()
            txt = pytesseract.image_to_string(img, config="--psm 6 digits")
            return "".join(filter(str.isdigit, txt or ""))
        except Exception as e:  # noqa: BLE001
            self.log(f"OCR 不可用/失败：{e}")
            return ""

    def copy_table(self, win, list_cid=CID_LIST, wait=3.0):
        """点击表格内容区→清剪贴板→Ctrl+C→轮询读取 TSV，期间自动处理验证码。

        返回 TSV 文本；读不到抛错（不能据此判断“无数据”）。
        """
        self.click_id(win, list_cid)
        self.clear_clipboard()
        self.send_key("{CTRL+C}")
        deadline = time.monotonic() + wait
        captcha_done = False
        last_err = None
        while time.monotonic() < deadline:
            if not captcha_done:
                img_el = self.find_id(win, CID_CAPTCHA_IMG)
                if img_el is not None:
                    try:
                        if img_el.is_visible():
                            self.handle_captcha(win, img_el)
                            captcha_done = True
                            deadline = time.monotonic() + wait
                    except CaptchaRequiredError:
                        raise
                    except Exception as e:  # noqa: BLE001
                        last_err = e
            try:
                data = self.get_clipboard(retries=1)
                if isinstance(data, str) and data.strip():
                    return data
            except Exception as e:  # noqa: BLE001
                last_err = e
            time.sleep(0.1)
        msg = "未复制到表格文本，请确认处于正确页面（不能据此判断无数据）"
        if last_err:
            msg += f"；最后错误：{last_err}"
        raise RuntimeError(msg)


class RealSidecar(BaseSidecar):
    """同花顺键盘精灵真实通道（移植自 THSAutoTrader）。

    下单走键盘精灵闪电下单（21 买 / 23 卖），查询走 Ctrl+C 复制表格 + TSV 解析，
    撤单走 F3/F5 + 全撤/撤买/撤卖控件；所有 GUI 操作在引擎互斥锁内串行。
    P4 安全护栏（白名单/单笔/单日/强制半自动/红色确认桥）全部保留。
    """

    def __init__(self, client_path, tesseract_cmd="", **kw):
        super().__init__(**kw)
        self.client_path = client_path
        self.selectors = {}
        self._load_selectors()
        title_re = self.selectors.get("window_title_re", r"网上股票交易系统|同花顺|模拟炒股|交易系统")
        tess = tesseract_cmd or self.selectors.get("tesseract_cmd", "")
        self.engine = ThsGuiEngine(client_path=client_path, title_re=title_re,
                                   tesseract_cmd=tess, log_fn=log)
        self.main_win = None
        # 复制验证码人工输入闭环：{"event":Event, "text":str}
        self.captcha_slot = None
        self.captcha_lock = threading.Lock()
        # P4 真实资金模式（非模拟）：打开 sidecar 纵深护栏，并强制半自动（忽略 --auto-confirm）。
        self.live_guarded = not self.sim
        if self.live_guarded:
            if self.auto_confirm:
                log("真实资金模式：强制半自动，已忽略 --auto-confirm")
                self.auto_confirm = False
            log("!! 真实资金模式已启用：sidecar 将操控真实同花顺账户下单，白名单 / 单笔 / 单日限额独立生效 !!")

    def _load_selectors(self):
        if self.template_dir:
            sp = os.path.join(self.template_dir, "selectors.json")
            if os.path.exists(sp):
                try:
                    with open(sp, "r", encoding="utf-8") as f:
                        self.selectors = json.load(f)
                    log(f"已加载控件选择器：{sp}")
                except Exception as e:  # noqa: BLE001
                    log(f"selectors.json 解析失败：{e}")

    # ---------- 连接 / 自检 ----------
    def connect(self):
        checks = self.engine.dependency_checks()
        running = self.engine.check_process()
        if running is False:
            checks.append({"name": "client_process", "ok": False,
                           "msg": "未检测到下单程序进程（xiadan.exe），请先启动同花顺独立交易端"})
        else:
            checks.append({"name": "client_process", "ok": True,
                           "msg": "下单进程运行中" if running else "进程探测降级（未装 psutil）"})
        try:
            self.main_win = self.engine.find_main_window()
            if self.main_win is None:
                raise RuntimeError("未找到「网上股票交易系统5.0」窗口")
            checks.append({"name": "client_window", "ok": True, "msg": "已找到交易窗口"})
            try:
                win_title = self.main_win.window_text() or ""
            except Exception:  # noqa: BLE001
                win_title = ""
            sim_window = "模拟" in win_title
            # P12-2 通道识别：窗口标题含「模拟」判为模拟炒股窗口，否则真实交易窗口；标题未知则上报 None。
            window_sim = bool(sim_window) if win_title else None
            # P4 账户类型交叉校验：模拟配置必须连模拟窗口，真实配置必须连真实窗口，防止误操作真钱。
            if self.sim and not sim_window:
                checks.append({"name": "account_type", "ok": False,
                               "msg": f"模拟模式却连接到非模拟窗口「{win_title}」，已拒绝"})
                self._fail_connect(checks, "模拟模式检测到真实交易窗口，已中止（请打开同花顺「模拟炒股」）")
                return False
            if self.live_guarded and sim_window:
                checks.append({"name": "account_type", "ok": False,
                               "msg": f"真实模式却连接到模拟炒股窗口「{win_title}」，已拒绝"})
                self._fail_connect(checks, "真实模式检测到模拟炒股窗口，已中止（请打开真实交易客户端）")
                return False
            checks.append({"name": "account_type", "ok": True,
                           "msg": "模拟炒股窗口" if self.sim else "真实交易窗口"})
            try:
                rect = self.main_win.rectangle()
                checks.append({"name": "resolution", "ok": True,
                               "msg": f"{rect.right - rect.left}x{rect.bottom - rect.top}"})
            except Exception:  # noqa: BLE001
                checks.append({"name": "resolution", "ok": False, "msg": "无法读取窗口尺寸"})
        except Exception as e:  # noqa: BLE001
            checks.append({"name": "client_window", "ok": False, "msg": str(e)})
            self._fail_connect(checks, f"未找到同花顺交易窗口：{e}（请先启动并登录独立交易端，勿用精简模式）")
            return False

        page = self.safe_page()
        emit({"event": "selfcheck", "vendor": self.vendor, "sim": self.sim,
              "live": self.live_guarded, "dryRun": False, "window_sim": window_sim,
              "checks": checks, "page": page})
        if not all(c["ok"] for c in checks if c["name"] in ("client_window",)):
            emit({"event": "error", "message": "连接自检未通过（见 selfcheck 明细）"})
            return False
        emit({"event": "connected", "vendor": self.vendor, "sim": self.sim,
              "live": self.live_guarded, "dryRun": False, "window_sim": window_sim,
              "account": self.account or "THS",
              "mode": "auto" if self.auto_confirm else "semi", "page": page})
        threading.Thread(target=self.heartbeat_loop, daemon=True).start()
        return True

    def _fail_connect(self, checks, message):
        emit({"event": "selfcheck", "vendor": self.vendor, "sim": self.sim,
              "live": self.live_guarded, "dryRun": False, "checks": checks})
        emit({"event": "error", "message": message})

    def safe_page(self):
        try:
            return self.engine.window_info()
        except Exception as e:  # noqa: BLE001
            return {"found": False, "error": str(e)}

    def _win(self):
        """每次操作重新定位主窗口，避免句柄失效。"""
        win = self.engine.find_main_window(retries=2)
        if win is None:
            raise RuntimeError("交易窗口不存在或已关闭，请重新连接")
        self.main_win = win
        return win

    def _win_shot(self, win):
        try:
            from PIL import ImageGrab
            import io as _io
            r = win.rectangle()
            img = ImageGrab.grab(bbox=(r.left, r.top, r.right, r.bottom))
            buf = _io.BytesIO()
            img.save(buf, format="PNG")
            return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")
        except Exception as e:  # noqa: BLE001
            log(f"截图失败：{e}")
            return ""

    # ---------- 验证码人工闭环 ----------
    def _copy_with_captcha(self, win):
        """复制表格，验证码无法自动 OCR 时挂起等待人工输入（stdin captcha_input）。"""
        try:
            return self.engine.copy_table(win)
        except CaptchaRequiredError as cre:
            slot = {"event": threading.Event(), "text": ""}
            with self.captcha_lock:
                self.captcha_slot = slot
            emit({"event": "screenshot", "client_order_id": "captcha", "shot": cre.shot,
                  "expect": {"captcha": True}, "message": "复制表格需要验证码，请在确认框输入图中数字"})
            slot["event"].wait(timeout=120)
            with self.captcha_lock:
                self.captcha_slot = None
            text = slot["text"].strip()
            if not text:
                raise RuntimeError("验证码未输入，已取消复制")
            self.engine.submit_manual_captcha(win, text)
            time.sleep(0.4)
            return self.engine.copy_table(win)  # 人工通过后重试一次

    def resolve_captcha(self, text):
        with self.captcha_lock:
            slot = self.captcha_slot
        if not slot:
            log("captcha_input：当前无等待中的验证码")
            return
        slot["text"] = str(text or "")
        slot["event"].set()

    # ---------- 闪电下单（固定数量） ----------
    def do_submit(self, p):
        parsed, err = self.pre_check(p)
        cid = p.get("client_order_id", "")
        if err:
            emit({"event": "error", "client_order_id": cid, "message": err})
            return
        code, side, price, vol = parsed["code"], parsed["side"], parsed["price"], parsed["vol"]
        amount = round(price * vol, 2)
        emit({"event": "order", "client_order_id": cid, "status": "submitting",
              "filled_vol": 0, "filled_avg_price": 0.0})
        try:
            with self.engine.locked():
                win = self._win()
                self.engine.activate(win)
                # 键盘精灵：代码回车选中个股 → 21 闪电买入 / 23 闪电卖出
                self.engine.send_key(f"{code} ENTER 21 ENTER" if side == "BUY"
                                     else f"{code} ENTER 23 ENTER")
                dialog = self.engine.find_dialog()
                if dialog is None:
                    raise RuntimeError("未弹出闪电下单确认窗口（#32770），请确认已在同花顺开启快捷下单")
                self.engine.input_id(dialog, CID_ORDER_AMT, str(vol))
                time.sleep(0.25)
                got = self.engine.text_id(dialog, CID_ORDER_AMT)
                try:
                    if got is not None and int(float(str(got).replace(",", ""))) != vol:
                        raise RuntimeError(f"数量读回不一致：期望 {vol}，实际 {got}")
                except ValueError:
                    pass
                shot = self._win_shot(dialog)
                emit({"event": "screenshot", "client_order_id": cid, "shot": shot,
                      "expect": {"code": code, "side": side, "price": price, "vol": vol,
                                 "amount": amount, "lightning": True, "sim": self.sim,
                                 "autoConfirm": self.auto_confirm},
                      "message": "闪电下单按客户端盘口价，请核对截图中的代码/方向/数量/价格"})
                emit({"event": "order", "client_order_id": cid, "status": "submitted",
                      "filled_vol": 0, "filled_avg_price": 0.0})
                if not self.auto_confirm:
                    slot = {"event": threading.Event(), "approved": False}
                    with self.pending_lock:
                        self.pending[cid] = slot
                    slot["event"].wait(timeout=300)
                    with self.pending_lock:
                        self.pending.pop(cid, None)
                    if not slot["approved"]:
                        # 人工拒绝：按 ESC 关闭弹窗，避免误下
                        try:
                            self.engine.send_key("ESC")
                        except Exception:  # noqa: BLE001
                            pass
                        emit({"event": "order", "client_order_id": cid, "status": "cancelled",
                              "filled_vol": 0, "filled_avg_price": 0.0})
                        emit({"event": "note", "client_order_id": cid, "message": "人工已拒绝，已关闭下单弹窗"})
                        return
                self.engine.click_id(dialog, CID_ORDER_CONFIRM)
                if self.live_guarded and side == "BUY":
                    # 按提交参考价预占单日额度（闪电实际盘口价以成交回报为准，Rust 侧为权威）。
                    self.live_bought_today += amount
                emit({"event": "note", "client_order_id": cid,
                      "message": "已通过键盘精灵提交闪电下单，成交状态请以“当日成交/挂单”查询为准"})
        except GuiBusyError as e:
            emit({"event": "error", "client_order_id": cid, "message": str(e)})
        except Exception as e:  # noqa: BLE001
            emit({"event": "error", "client_order_id": cid, "message": f"闪电下单中止：{e}"})

    # ---------- 仓位下单（1/2/3/4 档，0/不传=满仓） ----------
    def do_position_order(self, p):
        cid = p.get("client_order_id", "")
        code = bare_code(p.get("code", ""))
        side = p.get("side", "BUY")
        position = int(p.get("position", 0) or 0)
        ref_price = p.get("ref_price", p.get("refPrice", 0))
        if not re.fullmatch(r"\d{6}", code):
            emit({"event": "error", "client_order_id": cid, "message": f"证券代码非法：{code}"})
            return
        if side not in ("BUY", "SELL"):
            emit({"event": "error", "client_order_id": cid, "message": f"买卖方向非法：{side}"})
            return
        if position not in (0, 1, 2, 3, 4):
            emit({"event": "error", "client_order_id": cid, "message": "仓位档只能是 1(全仓)/2(半仓)/3(1/3)/4(1/4)/0(满仓)"})
            return
        if self.live_guarded and self.whitelist and code not in self.whitelist:
            emit({"event": "error", "client_order_id": cid,
                  "message": f"真实模式拦截：{code} 不在实盘白名单（sidecar 兜底）"})
            return
        try:
            with self.engine.locked():
                win = self._win()
                self.engine.activate(win)
                self.engine.send_key(f"{code} ENTER 21 ENTER" if side == "BUY"
                                     else f"{code} ENTER 23 ENTER")
                dialog = self.engine.find_dialog()
                if dialog is None:
                    raise RuntimeError("未弹出闪电下单确认窗口")
                self.engine.click_id(dialog, CID_REFRESH_AVAIL)  # 刷新可用数量
                time.sleep(0.3)
                avail_txt = self.engine.text_id(dialog, CID_ORDER_AMT)
                avail = int(float(str(avail_txt).replace(",", ""))) if avail_txt else 0
                if not avail:
                    raise RuntimeError("可用数量为 0，无法按仓位下单")
                if position in (1, 2, 3, 4):
                    order_vol = (avail // position // 100) * 100
                    if order_vol < 100:
                        raise RuntimeError(f"按仓位计算后不足 100 股（{order_vol}），无法下单")
                    self.engine.click_id(dialog, POSITION_BUTTON_BASE + position - 1)
                    time.sleep(0.2)
                else:
                    order_vol = avail
                got_txt = self.engine.text_id(dialog, CID_ORDER_AMT)
                try:
                    order_vol = int(float(str(got_txt).replace(",", ""))) or order_vol
                except (TypeError, ValueError):
                    pass
                est = round(order_vol * float(ref_price or 0), 2)
                if self.live_guarded and side == "BUY" and self.max_amount and est and est > self.max_amount + 1e-6:
                    raise RuntimeError(f"仓位下单估算金额 {est:.0f} 超单笔上限 {self.max_amount:.0f}")
                shot = self._win_shot(dialog)
                pos_label = {0: "满仓", 1: "全仓", 2: "1/2 仓", 3: "1/3 仓", 4: "1/4 仓"}[position]
                emit({"event": "screenshot", "client_order_id": cid, "shot": shot,
                      "expect": {"code": code, "side": side, "vol": order_vol, "position": pos_label,
                                 "lightning": True, "sim": self.sim, "autoConfirm": self.auto_confirm},
                      "message": f"仓位下单（{pos_label}）：可用 {avail}，拟下单 {order_vol} 股，请核对"})
                # 真实模式强制半自动；模拟 auto-confirm 才直接提交
                approved = self.auto_confirm
                if not approved:
                    slot = {"event": threading.Event(), "approved": False}
                    with self.pending_lock:
                        self.pending[cid] = slot
                    slot["event"].wait(timeout=300)
                    with self.pending_lock:
                        self.pending.pop(cid, None)
                    approved = slot["approved"]
                if not approved:
                    try:
                        self.engine.send_key("ESC")
                    except Exception:  # noqa: BLE001
                        pass
                    emit({"event": "order", "client_order_id": cid, "status": "cancelled",
                          "filled_vol": 0, "filled_avg_price": 0.0})
                    emit({"event": "note", "client_order_id": cid, "message": "人工已拒绝仓位下单"})
                    return
                self.engine.click_id(dialog, CID_ORDER_CONFIRM)
                if self.live_guarded and side == "BUY" and est:
                    self.live_bought_today += est
                emit({"event": "order", "client_order_id": cid, "status": "submitted",
                      "filled_vol": 0, "filled_avg_price": 0.0, "vol": order_vol})
                emit({"event": "note", "client_order_id": cid,
                      "message": f"已提交{pos_label}闪电下单 {order_vol} 股，成交以查询为准"})
        except GuiBusyError as e:
            emit({"event": "error", "client_order_id": cid, "message": str(e)})
        except Exception as e:  # noqa: BLE001
            emit({"event": "error", "client_order_id": cid, "message": f"仓位下单中止：{e}"})

    # ---------- 撤单 ----------
    def do_cancel_all(self, p):
        cid = p.get("client_order_id", "")
        ctype = (p.get("type") or "A").upper()
        if ctype not in ("A", "X", "C"):
            emit({"event": "error", "client_order_id": cid, "message": "撤单类型只能是 A(全撤)/X(撤买)/C(撤卖)"})
            return
        btn = {"A": CID_CANCEL_ALL, "X": CID_CANCEL_BUY, "C": CID_CANCEL_SELL}[ctype]
        label = {"A": "全部撤单", "X": "撤买", "C": "撤卖"}[ctype]
        try:
            with self.engine.locked():
                win = self._win()
                self.engine.activate(win)
                self.engine.send_key("F5")   # 先刷新
                time.sleep(0.3)
                self.engine.send_key("F3")   # 撤单页
                time.sleep(0.4)
                self.engine.click_id(win, btn)
                time.sleep(0.2)
                shot = self._win_shot(win)
                emit({"event": "note", "client_order_id": cid, "message": f"已执行{label}", "shot": shot})
        except GuiBusyError as e:
            emit({"event": "error", "client_order_id": cid, "message": str(e)})
        except Exception as e:  # noqa: BLE001
            emit({"event": "error", "client_order_id": cid, "message": f"{label}中止：{e}"})

    def do_cancel(self, p):
        # 闪电通道无“单笔精确撤单”（委托列表不含我们的 client_order_id），安全起见打开撤单页由人工/全撤处理。
        cid = p.get("client_order_id", "")
        try:
            with self.engine.locked():
                win = self._win()
                self.engine.activate(win)
                self.engine.send_key("F5")
                time.sleep(0.3)
                self.engine.send_key("F3")
                time.sleep(0.4)
                shot = self._win_shot(win)
                emit({"event": "screenshot", "client_order_id": cid, "shot": shot,
                      "expect": {"cancelPage": True},
                      "message": "已打开撤单页：单笔请在客户端勾选该委托后撤单，或使用“全撤/撤买/撤卖”"})
                emit({"event": "order", "client_order_id": cid, "status": "cancelled",
                      "filled_vol": 0, "filled_avg_price": 0.0})
        except Exception as e:  # noqa: BLE001
            emit({"event": "error", "client_order_id": cid, "message": f"打开撤单页中止：{e}"})

    # ---------- 查询 ----------
    def do_query_asset(self):
        try:
            with self.engine.locked():
                win = self._win()
                self.engine.activate(win)
                self.engine.send_key("F5")
                time.sleep(0.3)
                self.engine.send_key("F4")
                time.sleep(0.4)
                els = self.engine.find_ids(win, list(BALANCE_FIELDS.values()))
                raw = {}
                for name, cidv in BALANCE_FIELDS.items():
                    el = els.get(cidv)
                    raw[name] = el.window_text().strip() if el is not None else None
                asset = normalize_balance(raw)
                asset.update({"event": "asset", "full": True, "source": "ths", "raw": raw})
                emit(asset)
        except Exception as e:  # noqa: BLE001
            emit({"event": "asset", "note": f"资金读取失败：{e}"})

    def do_query_position(self):
        try:
            with self.engine.locked():
                win = self._win()
                self.engine.activate(win)
                self.engine.send_key("F5")
                time.sleep(0.3)
                self.engine.send_key("F4")   # F4 后默认持仓页
                time.sleep(0.4)
                tsv = self._copy_with_captcha(win)
                rows = parse_tabular_data(tsv, required_headers=("证券代码",))
                positions = normalize_position(rows)
                emit({"event": "position", "positions": positions, "full": True, "source": "ths"})
        except Exception as e:  # noqa: BLE001
            emit({"event": "position", "positions": [], "full": True, "note": f"持仓读取失败：{e}"})

    def do_query_trades(self):
        try:
            with self.engine.locked():
                win = self._win()
                self.engine.activate(win)
                self.engine.send_key("F4")
                time.sleep(0.3)
                node = self.engine.tree_path(win, CID_QUERY_TREE_ROOT, ["查询[F4]", "当日成交"])
                if node is None:
                    raise RuntimeError("未找到“查询[F4] → 当日成交”")
                node.click_input()
                time.sleep(0.3)
                self.engine.send_key("F5")
                time.sleep(0.3)
                tsv = self._copy_with_captcha(win)
                rows = parse_tabular_data(tsv, required_headers=("证券代码",))
                trades = [t for t in (normalize_trade(r) for r in rows) if t]
                emit({"event": "trades", "trades": trades, "full": True, "source": "ths"})
        except Exception as e:  # noqa: BLE001
            emit({"event": "trades", "trades": [], "full": True, "note": f"当日成交读取失败：{e}"})

    def do_query_pending(self):
        try:
            with self.engine.locked():
                win = self._win()
                self.engine.activate(win)
                self.engine.send_key("F3")
                time.sleep(0.3)
                self.engine.send_key("F5")
                time.sleep(0.3)
                tsv = self._copy_with_captcha(win)
                rows = parse_tabular_data(tsv, required_headers=("证券代码",))
                orders = [o for o in (normalize_pending(r) for r in rows) if o]
                emit({"event": "pending", "orders": orders, "full": True, "source": "ths"})
        except Exception as e:  # noqa: BLE001
            emit({"event": "pending", "orders": [], "full": True, "note": f"挂单读取失败：{e}"})

    # ---------- 探测 / 透传（高级调试） ----------
    def do_check_app(self):
        running = self.engine.check_process()
        page = self.safe_page()
        emit({"event": "app_state", "running": running, "page": page})

    def do_current_page(self):
        emit({"event": "current_page", **self.safe_page()})

    def do_send_key(self, p):
        key = str(p.get("key", ""))
        if not key.strip():
            emit({"event": "note", "message": "send_key 缺少 key 参数"})
            return
        try:
            with self.engine.locked():
                win = self._win()
                self.engine.activate(win)
                self.engine.send_key(key)
                time.sleep(0.15)
                emit({"event": "note", "message": f"已发送按键：{key}"})
        except Exception as e:  # noqa: BLE001
            emit({"event": "note", "message": f"按键发送失败：{e}"})

    def do_click(self, p):
        try:
            x = int(p.get("x"))
            y = int(p.get("y"))
        except (TypeError, ValueError):
            emit({"event": "note", "message": "click 需要整数 x / y"})
            return
        try:
            with self.engine.locked():
                win = self._win()
                self.engine.activate(win)
                self.engine.click_xy(x, y)
                emit({"event": "note", "message": f"已点击坐标 ({x},{y})"})
        except Exception as e:  # noqa: BLE001
            emit({"event": "note", "message": f"点击失败：{e}"})


# ============================== main ==============================

# ============================== HTTP API 服务（P10-1，对齐 THSAutoTrader 接口） ==============================

class ApiServer:
    """标准库 ThreadingHTTPServer，把引擎命令映射为 REST 接口。

    与 THSAutoTrader 保持一致的调用习惯：
      /xiadan?code=600000&status=1&amount=100     闪电下单（amount 可选）
      /confirm_order?position=2                    用最近一次 /xiadan 上下文按仓位下单
      /position /today_trades /pending_orders /balance  表格与资金查询
      /cancel_all_orders?type=A|X|C  /send_key?key=  /click?x=&y=
      /health /check_trading_app /current_page     探测
    查询类只读（互斥锁内串行，与 GUI 窗口操作互斥）；下单类不绕过任何护栏。
    """

    def __init__(self, sc, port=0, token=""):
        self.sc = sc
        self.token = token
        self._lock = threading.Lock()  # 同一时刻只处理一个 API 请求（窗口互斥，与 README 一致）
        self._ctx = {}  # 最近一次 /xiadan 上下文：code/side/price

    # ---------- 请求处理 ----------
    def handle(self, path, query):
        global _api_capture
        with self._lock:
            try:
                return self._dispatch(path, query, _api_capture)
            except GuiBusyError:
                return {"status": "busy", "message": "GUI 操作繁忙，请稍后重试"}
            except Exception as e:  # noqa: BLE001
                return {"status": "error", "message": str(e)}

    def _dispatch(self, path, query, cap_holder):
        p = path.lstrip("/").split("?")[0].strip()
        q = {}
        for k, v in query.items():
            q[k] = v[0] if isinstance(v, list) else v
        if p == "health":
            return {"status": "success", "timestamp": time.time()}
        if p == "check_trading_app":
            box = self._call_event("app_state", self.sc.do_check_app)
            return {"status": "success", "running": bool(box.get("running", box.get("page", {}).get("running", False)))}
        if p == "current_page":
            box = self._call_event("current_page", self.sc.do_current_page)
            data = {k: box.get(k) for k in ("found", "hwnd", "pid", "title", "className", "rect",
                                            "isMinimized", "isMaximized", "running")}
            return {"status": "success", "data": data}
        if p == "position":
            box = self._call_event("position", self.sc.do_query_position)
            return {"status": "success", "data": box.get("positions", [])}
        if p == "today_trades":
            box = self._call_event("trades", self.sc.do_query_trades)
            return {"status": "success", "data": box.get("trades", [])}
        if p == "pending_orders":
            box = self._call_event("pending", self.sc.do_query_pending)
            return {"status": "success", "data": box.get("orders", [])}
        if p == "balance":
            box = self._call_event("asset", self.sc.do_query_asset)
            data = {k: box.get(k) for k in ("cash", "frozenCash", "marketValue", "totalAsset",
                                            "floatPnl", "dayPnl", "source")}
            return {"status": "success", "data": data}
        if p == "xiadan":
            return self._xiadan(q)
        if p == "confirm_order":
            return self._confirm_order(q)
        if p == "cancel_all_orders":
            ctype = (q.get("type") or "A").upper()
            self._run_cmd("cancel_all", {"type": ctype})
            return {"status": "success", "message": f"撤单指令已执行（{ctype}）",
                    "data": {"operation": {"A": "全部撤单", "X": "撤买", "C": "撤卖"}.get(ctype, "全部撤单"), "type": ctype}}
        if p == "send_key":
            key = q.get("key", "")
            if not key:
                return {"status": "error", "message": "缺少 key 参数"}
            self._run_cmd("send_key", {"key": key})
            return {"status": "success", "message": f"已发送按键：{key}"}
        if p == "click":
            try:
                x, y = int(q.get("x", "")), int(q.get("y", ""))
            except (TypeError, ValueError):
                return {"status": "error", "message": "x/y 必须为整数坐标"}
            self._run_cmd("click", {"x": x, "y": y})
            return {"status": "success", "message": f"坐标点击成功: ({x}, {y})"}
        return {"status": "error", "message": f"未知接口：/{p}"}

    # ---------- 下单 ----------
    def _xiadan(self, q):
        code = q.get("code", "")
        status = q.get("status", "1")
        side = "BUY" if str(status) == "1" else "SELL"
        amount = q.get("amount", "")
        try:
            price = float(q.get("price", "") or 0)
        except (TypeError, ValueError):
            price = 0.0
        if not code:
            return {"status": "error", "message": "缺少 code 参数"}
        self._ctx = {"code": code, "side": side, "price": price}
        cid = "api" + str(int(time.time() * 1000))
        if str(amount).strip():
            try:
                vol = int(amount)
            except (TypeError, ValueError):
                return {"status": "error", "message": f"amount 必须为整数股数：{amount}"}
            if vol <= 0 or vol % 100 != 0:
                return {"status": "error", "message": f"数量必须为 100 的正整数倍：{vol}"}
            if price <= 0:
                # dry-run 缺省价（真实模式应显式传 price，否则由客户端窗口带出）
                price = 10.0
            p = {"client_order_id": cid, "code": code, "side": side,
                 "price": price, "vol": vol}
            if self.sc.auto_confirm:
                box = self._call_order_terminal(p)
                if box.get("event") == "error" or box.get("status") == "error":
                    return {"status": "error",
                            "message": box.get("message", "下单失败（引擎返回 error 事件）")}
                return {"status": "success",
                        "message": f"已成交 {vol} 股 {code}（{side} @ {price}）",
                        "data": {"code": code, "side": side, "vol": vol,
                                 "price": price, "status": box.get("status", "filled")}}
            self._run_cmd("submit", p)
            return {"status": "success",
                    "message": f"已提交委托 {code}（{side} {vol} 股），等待人工确认（可在应用确认桥确认，或开启自动确认）",
                    "data": {"code": code, "side": side, "vol": vol, "client_order_id": cid}}
        # 未给 amount：记录上下文，等待 /confirm_order 按仓位下单（与 THSAutoTrader 用法一致）
        return {"status": "success",
                "message": f"闪电下单窗口已就绪：{code}（{side}），请调用 /confirm_order?position=",
                "data": {"code": code, "side": side}}

    def _confirm_order(self, q):
        if not self._ctx or not self._ctx.get("code"):
            return {"status": "error", "message": "请先调用 /xiadan 建立下单上下文"}
        try:
            position = int(q.get("position", "") or 0)
        except (TypeError, ValueError):
            position = 0
        if position not in (0, 1, 2, 3, 4):
            return {"status": "error", "message": "position 只能为 1(全仓)/2(半仓)/3(1/3)/4(1/4)/0(满仓)"}
        price = self._ctx.get("price") or 10.0
        p = {"client_order_id": "apipos" + str(int(time.time() * 1000)),
             "code": self._ctx["code"], "side": self._ctx["side"],
             "position": position, "ref_price": price}
        if self.sc.auto_confirm:
            box = self._call_order_terminal(p, position_order=True)
            if box.get("event") == "error" or box.get("status") == "error":
                return {"status": "error",
                        "message": box.get("message", "下单失败（引擎返回 error 事件）")}
            return {"status": "success",
                    "message": f"仓位下单已成交：{self._ctx['code']}（{self._ctx['side']}，仓位{position or 1}）",
                    "data": box}
        self._run_cmd("position_order", p)
        return {"status": "success",
                "message": f"已按仓位提交委托：{self._ctx['code']}（仓位{position or 1}），等待人工确认",
                "data": {"code": self._ctx["code"], "side": self._ctx["side"], "position": position or 1}}

    # ---------- 同步执行辅助 ----------
    def _call_event(self, event_type, fn):
        """调用只 emit 的查询方法，同步捕获其事件 payload。"""
        cap = {"type": event_type, "box": {}, "done": threading.Event()}
        global _api_capture
        _api_capture = cap
        try:
            fn()
            cap["done"].wait(timeout=30)
        finally:
            _api_capture = None
        return cap["box"]

    def _call_order_terminal(self, p, position_order=False):
        """auto_confirm 模式下同步等到订单终态（filled/cancelled/error）。

        捕获器持续接收 order / error 事件（submitting→submitted→filled…），
        直到出现终态才返回；超时则返回最后一次事件快照。
        """
        cap = {"type": "*", "box": {}, "done": threading.Event()}
        global _api_capture
        _api_capture = cap
        try:
            self._run_cmd("position_order" if position_order else "submit", p)
            deadline = time.monotonic() + 45
            while time.monotonic() < deadline:
                st = cap["box"].get("status")
                if st in ("filled", "cancelled", "error") or cap["box"].get("event") == "error":
                    break
                cap["done"].wait(0.5)
        finally:
            _api_capture = None
        return cap["box"]

    def _run_cmd(self, method, params):
        fn = getattr(self.sc, {"submit": "submit", "cancel_all": "do_cancel_all",
                               "position_order": "do_position_order",
                               "send_key": "do_send_key", "click": "do_click"}[method], None)
        if fn is None:
            raise RuntimeError(f"当前模式不支持 {method}")
        fn(params)


def _make_api_server(sc, port, token):
    import http.server

    class Handler(http.server.BaseHTTPRequestHandler):
        server_version = "TickGoldAPI/1.0"

        def _respond(self, obj, status=200):
            body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body)

        def _auth_ok(self):
            tok = self.headers.get("Authorization", "")
            if tok.startswith("Bearer "):
                tok = tok[7:]
            return (not api.token) or (tok == api.token)

        def _serve(self):
            from urllib.parse import urlparse, parse_qs
            u = urlparse(self.path)
            q = parse_qs(u.query)
            header_tok = self.headers.get("Authorization", "")
            if header_tok.startswith("Bearer "):
                header_tok = header_tok[7:]
            qtok = q.get("token", [""])[0]
            tok = header_tok or qtok
            if api.token and tok != api.token:
                self._respond({"status": "error", "message": "API 令牌无效"}, 401)
                return
            q.pop("token", None)
            self._respond(api.handle(u.path, q))

        def do_GET(self):  # noqa: N802
            try:
                self._serve()
            except Exception as e:  # noqa: BLE001
                self._respond({"status": "error", "message": str(e)}, 500)

        def log_message(self, fmt, *args):  # noqa: A003
            log("[api] " + (fmt % args))

    class S(http.server.ThreadingHTTPServer):
        daemon_threads = True

    api = ApiServer(sc, port, token)
    sc.api = api
    srv = S(("127.0.0.1", port), Handler)
    return srv


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--vendor", default="ths", choices=["ths", "eastmoney"])
    ap.add_argument("--client-path", default="", help="客户端/下单程序路径（真实模式）")
    ap.add_argument("--template-dir", default="", help="控件/图像模板目录")
    ap.add_argument("--account", default="", help="账号（模拟环境可留空）")
    ap.add_argument("--sim", action="store_true", help="模拟炒股（虚拟资金，不碰真钱）")
    ap.add_argument("--auto-confirm", action="store_true", help="全自动：自动填单并确认")
    ap.add_argument("--dry-run", action="store_true", help="不连真实客户端，内置模拟")
    ap.add_argument("--min-interval", type=int, default=1200, help="下单限速毫秒")
    ap.add_argument("--whitelist", default="", help="真实模式标的白名单（逗号分隔 6 位代码）")
    ap.add_argument("--max-amount", type=float, default=0.0, help="真实模式单笔金额硬上限（0=不额外限制）")
    ap.add_argument("--max-daily", type=float, default=0.0, help="真实模式单日累计买入硬上限（0=不额外限制）")
    ap.add_argument("--tesseract", default="", help="tesseract.exe 路径（验证码 OCR，留空则复制时转人工）")
    ap.add_argument("--api-port", type=int, default=0, help="HTTP API 服务端口（0=关闭，默认 5000 语义）")
    ap.add_argument("--api-token", default="", help="HTTP API 访问令牌（留空=本机免密）")
    args = ap.parse_args()

    wl = [bare_code(x) for x in args.whitelist.split(",") if bare_code(x)]
    common = dict(vendor=args.vendor, account=args.account, sim=args.sim,
                  auto_confirm=args.auto_confirm, min_interval_ms=args.min_interval,
                  template_dir=args.template_dir,
                  whitelist=wl, max_amount=args.max_amount, max_daily=args.max_daily)
    if args.dry_run:
        sc = DryRunSidecar(**common)
    else:
        sc = RealSidecar(client_path=args.client_path, tesseract_cmd=args.tesseract, **common)

    if not sc.connect():
        time.sleep(0.5)
        sys.exit(1)

    # P10-1：HTTP API 服务（默认关闭；开启后仅绑定 127.0.0.1，可选令牌）
    api_port = args.api_port or 0
    if api_port > 0:
        try:
            srv = _make_api_server(sc, api_port, args.api_token)
            threading.Thread(target=srv.serve_forever, daemon=True).start()
            emit({"event": "note",
                  "message": f"HTTP API 服务已就绪：http://127.0.0.1:{api_port}"
                             + ("（令牌保护）" if args.api_token else "")})
            log(f"[api] listening on 127.0.0.1:{api_port}")
        except Exception as e:  # noqa: BLE001
            log(f"[api] 启动失败：{e}")
            emit({"event": "error", "message": f"HTTP API 服务启动失败：{e}"})

    # 复制表格 / OCR / 控件操作较慢，GUI 方法统一在守护线程执行，避免阻塞 stdin 读循环，
    # 保证 confirm/reject/captcha_input 等人工响应能被即时处理。
    # 值为 (可调用对象, 是否接收 params)；查询/探测类无参，置 False。
    gui_methods = {
        "submit": (sc.submit, True),
        "cancel": (sc.do_cancel, True),
        "position_order": (getattr(sc, "do_position_order", None), True),
        "cancel_all": (getattr(sc, "do_cancel_all", None), True),
        "send_key": (getattr(sc, "do_send_key", None), True),
        "click": (getattr(sc, "do_click", None), True),
        "query_asset": (sc.do_query_asset, False),
        "query_position": (sc.do_query_position, False),
        "query_trades": (getattr(sc, "do_query_trades", None), False),
        "query_pending": (getattr(sc, "do_query_pending", None), False),
        "check_app": (getattr(sc, "do_check_app", None), False),
        "current_page": (getattr(sc, "do_current_page", None), False),
    }

    def run_bg(fn, params, takes_params):
        def worker():
            try:
                fn(params) if takes_params else fn()
            except Exception as e:  # noqa: BLE001
                cid = params.get("client_order_id", "") if isinstance(params, dict) else ""
                emit({"event": "error", "client_order_id": cid, "message": str(e)})
        threading.Thread(target=worker, daemon=True).start()

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
        cid = p.get("client_order_id", "") if isinstance(p, dict) else ""
        try:
            if method in gui_methods and gui_methods[method][0] is not None:
                fn, takes_params = gui_methods[method]
                run_bg(fn, p, takes_params)
            elif method == "confirm":
                sc.resolve(cid, True)
            elif method == "reject":
                sc.resolve(cid, False)
            elif method == "captcha_input":
                resolver = getattr(sc, "resolve_captcha", None)
                if resolver is not None:
                    resolver(p.get("text", ""))
            elif method == "heartbeat":
                emit({"event": "heartbeat", "ts": int(time.time())})
            elif method in ("kill", "disconnect"):
                emit({"event": "disconnected"})
                break
        except Exception as e:  # noqa: BLE001
            emit({"event": "error", "client_order_id": cid, "message": str(e)})


if __name__ == "__main__":
    main()
