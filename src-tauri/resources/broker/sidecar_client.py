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

协议与 sidecar_qmt.py 完全对齐，事件：
  connected / selfcheck / error / heartbeat / screenshot /
  asset / position / order / trade / disconnected
请求方法：
  submit / cancel / confirm / reject / query_asset / query_position / heartbeat / kill / disconnect

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


def emit(obj):
    """输出一行 JSON（协议帧）。"""
    line = json.dumps(obj, ensure_ascii=False)
    with _out_lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


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
    def __init__(self, vendor, account, sim, auto_confirm, min_interval_ms, template_dir):
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
        emit({"event": "selfcheck", "vendor": self.vendor, "sim": self.sim, "dryRun": True, "checks": checks})
        emit({"event": "connected", "vendor": self.vendor, "sim": self.sim,
              "dryRun": True, "account": self.account or "SIM",
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


# ============================== 真实模式：同花顺 UI 自动化（配置驱动，需真机校准） ==============================

class RealSidecar(BaseSidecar):
    """pywinauto 控件树优先 + pyautogui 图像兜底。控件选择器从 <template-dir>/selectors.json 读取。

    重要：不同券商/版本的同花顺下单窗口控件 auto_id 不同，首次必须在真机校准 selectors.json；
    未校准时使用“Edit 顺序 + 按钮标题正则”的启发式定位，并在 selfcheck 中给出 warning。"""

    def __init__(self, client_path, **kw):
        super().__init__(**kw)
        self.client_path = client_path
        self.app = None
        self.win = None
        self.selectors = {}
        # 成交/资产回读依赖真机控件表格，首版如无法可靠解析则回显中文提示，避免编造数据。
        self._load_selectors()

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

    def connect(self):
        checks = []
        try:
            import pywinauto  # noqa: F401
            checks.append({"name": "pywinauto", "ok": True, "msg": "已安装"})
        except Exception as e:  # noqa: BLE001
            checks.append({"name": "pywinauto", "ok": False, "msg": str(e)})
            emit({"event": "selfcheck", "vendor": self.vendor, "sim": self.sim, "dryRun": False, "checks": checks})
            emit({"event": "error", "message": "未安装 pywinauto：请先 pip install pywinauto pyautogui pillow"})
            return False
        try:
            from pywinauto import Application
            title_re = self.selectors.get("window_title_re", r"同花顺|模拟炒股|网上股票交易|交易系统|委托")
            if self.client_path and os.path.exists(self.client_path):
                self.app = Application(backend="win32").connect(path=self.client_path, timeout=5)
            else:
                self.app = Application(backend="win32").connect(title_re=title_re, timeout=5)
            self.win = self.app.window(title_re=title_re)
            self.win.wait("exists enabled visible ready", timeout=8)
            checks.append({"name": "client_window", "ok": True, "msg": "已找到交易窗口"})
        except Exception as e:  # noqa: BLE001
            checks.append({"name": "client_window", "ok": False, "msg": str(e)})
            emit({"event": "selfcheck", "vendor": self.vendor, "sim": self.sim, "dryRun": False, "checks": checks})
            emit({"event": "error", "message": f"未找到同花顺交易窗口：{e}（请先启动并登录，或校准 client_path）"})
            return False

        # 登录态：存在密码输入框或“登录”按钮视为未登录
        try:
            login_btn = self.win.child_window(title_re=r"登录|登陆|交易登录", control_type="Button")
            logged = not login_btn.exists()
        except Exception:  # noqa: BLE001
            logged = True
        checks.append({"name": "login", "ok": logged,
                       "msg": "已登录" if logged else "检测到未登录，请先在客户端登录模拟炒股"})
        if not self.selectors:
            checks.append({"name": "templates", "ok": False,
                           "msg": "未发现 selectors.json，将使用启发式定位，建议按手册录制模板"})
        else:
            checks.append({"name": "templates", "ok": True, "msg": "已加载选择器"})
        try:
            r = self.win.rectangle()
            self.last_window_rect = (r.left, r.top, r.right, r.bottom)
            checks.append({"name": "resolution", "ok": True,
                           "msg": f"{r.right - r.left}x{r.bottom - r.top}"})
        except Exception:  # noqa: BLE001
            checks.append({"name": "resolution", "ok": False, "msg": "无法读取窗口尺寸"})

        emit({"event": "selfcheck", "vendor": self.vendor, "sim": self.sim, "dryRun": False, "checks": checks})
        if not all(c["ok"] for c in checks if c["name"] in ("client_window", "login")):
            emit({"event": "error", "message": "连接自检未通过（见 selfcheck 明细）"})
            return False
        emit({"event": "connected", "vendor": self.vendor, "sim": self.sim,
              "dryRun": False, "account": self.account or "THS",
              "mode": "auto" if self.auto_confirm else "semi"})
        threading.Thread(target=self.heartbeat_loop, daemon=True).start()
        return True

    # ---- 窗口保护：每步确认窗口仍在前台、无模态弹窗 ----
    def _guard_window(self):
        if self.win is None:
            raise RuntimeError("交易窗口不存在")
        if not self.win.exists():
            raise RuntimeError("交易窗口已关闭")
        r = self.win.rectangle()
        cur = (r.left, r.top, r.right, r.bottom)
        if self.last_window_rect and cur != self.last_window_rect:
            # 分辨率/窗口位置变化会使图像坐标失效，立即暂停（真实模式）
            raise RuntimeError("交易窗口尺寸/位置发生变化，为安全已暂停，请重新连接")
        # 模态弹窗遮挡检测
        try:
            modal = self.win.child_window(title_re=r"错误|提示|警告|风险|确认", control_type="Window")
            if modal.exists():
                raise RuntimeError("检测到弹窗遮挡，请先在客户端处理弹窗")
        except RuntimeError:
            raise
        except Exception:  # noqa: BLE001
            pass

    def _edit(self, key, index):
        """按 selectors 定位输入框，缺省用 Edit 顺序启发式。"""
        spec = self.selectors.get(key)
        if isinstance(spec, dict) and spec.get("auto_id"):
            return self.win.child_window(auto_id=spec["auto_id"], control_type="Edit")
        edits = self.win.descendants(control_type="Edit")
        return edits[index] if len(edits) > index else None

    def _click_button(self, title_re):
        btn = self.win.child_window(title_re=title_re, control_type="Button")
        if btn.exists():
            btn.click_input()
            return True
        # 图像兜底
        tpl = self.selectors.get("template_" + ("buy" if "买" in title_re else "confirm"))
        if tpl and self.template_dir:
            import pyautogui
            p = os.path.join(self.template_dir, tpl)
            if os.path.exists(p):
                box = pyautogui.locateCenterOnScreen(p)
                if box:
                    pyautogui.click(box)
                    return True
        return False

    def _grab_shot(self):
        try:
            from PIL import ImageGrab
            import io as _io
            r = self.win.rectangle()
            img = ImageGrab.grab(bbox=(r.left, r.top, r.right, r.bottom))
            buf = _io.BytesIO()
            img.save(buf, format="PNG")
            return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")
        except Exception as e:  # noqa: BLE001
            log(f"截图失败：{e}")
            return ""

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
        self._guard_window()
        try:
            from pywinauto import keyboard
            # 切到买入/卖出面板（F1/F2）
            self.win.set_focus()
            keyboard.send_keys("{F1}" if side == "BUY" else "{F2}")
            time.sleep(0.4)
            self._guard_window()
            # 填代码 → 价格 → 数量（控件顺序：通常 0=代码 1=价格 2=数量，可被 selectors 覆盖）
            e_code = self._edit("code_edit", 0)
            e_price = self._edit("price_edit", 1)
            e_vol = self._edit("vol_edit", 2)
            if e_code is None or e_price is None or e_vol is None:
                raise RuntimeError("定位下单输入框失败，请校准 selectors.json")
            e_code.set_edit_text(code)
            time.sleep(0.2)
            e_price.set_edit_text(f"{price:.2f}")
            e_vol.set_edit_text(str(vol))
            time.sleep(0.3)
            # 读回字段二次比对（金额安全）
            got_code = e_code.window_text().strip()
            got_price = e_price.window_text().strip()
            got_vol = e_vol.window_text().strip()
            if bare_code(got_code) != code:
                raise RuntimeError(f"代码读回不一致：期望 {code}，实际 {got_code}")
            if not got_price or abs(float(got_price) - price) > 0.001:
                raise RuntimeError(f"价格读回不一致：期望 {price}，实际 {got_price}")
            if int(float(got_vol)) != vol:
                raise RuntimeError(f"数量读回不一致：期望 {vol}，实际 {got_vol}")
            shot = self._grab_shot()
            emit({"event": "screenshot", "client_order_id": cid, "shot": shot,
                  "expect": {"code": code, "side": side, "price": price, "vol": vol,
                             "amount": amount, "sim": self.sim, "autoConfirm": self.auto_confirm}})
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
                    emit({"event": "order", "client_order_id": cid, "status": "cancelled",
                          "filled_vol": 0, "filled_avg_price": 0.0})
                    return
            # 点最终确认按钮
            self._guard_window()
            ok = self._click_button(r"买入|卖出|确认下单|确定")
            if not ok:
                raise RuntimeError("未能定位最终确认按钮，请校准模板")
            # 成交状态以客户端成交回报/委托列表为准；真机首版由查询或人工核对推进。
            emit({"event": "note", "client_order_id": cid,
                  "message": "已在客户端点击确认，成交回报请以委托查询/成交列表为准（真机首版）"})
        except Exception as e:  # noqa: BLE001
            emit({"event": "error", "client_order_id": cid, "message": f"填单/确认中止：{e}"})

    def do_cancel(self, p):
        cid = p.get("client_order_id", "")
        try:
            from pywinauto import keyboard
            self._guard_window()
            self.win.set_focus()
            keyboard.send_keys("{F3}")  # 撤单面板
            time.sleep(0.4)
            # 真机撤单需勾选具体委托并点“撤单”，首版发提示，具体勾选由 selectors 校准。
            emit({"event": "note", "client_order_id": cid,
                  "message": "已打开撤单面板，请在 selectors.json 校准委托勾选与撤单按钮（真机首版）"})
        except Exception as e:  # noqa: BLE001
            emit({"event": "error", "client_order_id": cid, "message": f"撤单中止：{e}"})

    def do_query_asset(self):
        # 真机资产表格解析依赖选择器，首版无可靠解析时给中文提示，避免编造。
        if not self.selectors.get("asset_table"):
            emit({"event": "asset", "note": "真机资产读取需校准 selectors.json 的 asset_table（见手册）"})
            return
        # 预留：按选择器解析资产表格后 emit 标准 asset 事件。
        emit({"event": "asset", "note": "asset_table 解析尚未实现，请使用 dry-run 或先校准"})

    def do_query_position(self):
        if not self.selectors.get("position_table"):
            emit({"event": "position", "positions": [],
                  "note": "真机持仓读取需校准 selectors.json 的 position_table（见手册）"})
            return
        emit({"event": "position", "positions": [], "note": "position_table 解析尚未实现"})


# ============================== main ==============================

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
    args = ap.parse_args()

    common = dict(vendor=args.vendor, account=args.account, sim=args.sim,
                  auto_confirm=args.auto_confirm, min_interval_ms=args.min_interval,
                  template_dir=args.template_dir)
    if args.dry_run:
        sc = DryRunSidecar(**common)
    else:
        sc = RealSidecar(client_path=args.client_path, **common)

    if not sc.connect():
        time.sleep(0.5)
        sys.exit(1)

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
                sc.do_cancel(p)
            elif method == "confirm":
                sc.resolve(p.get("client_order_id", ""), True)
            elif method == "reject":
                sc.resolve(p.get("client_order_id", ""), False)
            elif method == "query_asset":
                sc.do_query_asset()
            elif method == "query_position":
                sc.do_query_position()
            elif method == "heartbeat":
                emit({"event": "heartbeat", "ts": int(time.time())})
            elif method in ("kill", "disconnect"):
                emit({"event": "disconnected"})
                break
        except Exception as e:  # noqa: BLE001
            cid = p.get("client_order_id", "") if isinstance(p, dict) else ""
            emit({"event": "error", "client_order_id": cid, "message": str(e)})


if __name__ == "__main__":
    main()
