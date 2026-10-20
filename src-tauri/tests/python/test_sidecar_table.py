# -*- coding: utf-8 -*-
"""P7 sidecar_client 纯逻辑层单元测试（不依赖同花顺客户端 / pywinauto）。

覆盖 THSAutoTrader 剪贴板读表移植的核心：
- parse_tabular_data：同花顺 Ctrl+C 复制表格 TSV 解析（空列/列数不一致/重复表头防御）
- normalize_position / normalize_trade / normalize_pending：中文字段别名 → 统一结构
- normalize_balance：资金控件文本数字清洗（逗号/空白/百分比）

运行：python -m unittest discover -s src-tauri/tests/python
或：  python src-tauri/tests/python/test_sidecar_table.py
"""
import importlib.util
import io
import os
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_SIDECAR = os.path.normpath(os.path.join(_HERE, "..", "..", "resources", "broker", "sidecar_client.py"))


def _load_sidecar():
    spec = importlib.util.spec_from_file_location("sidecar_client", _SIDECAR)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TableParserTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.m = _load_sidecar()

    def test_position_with_trailing_empty_column(self):
        tsv = (
            "证券代码\t证券名称\t股票余额\t可用余额\t成本价\t市价\t市值\t盈亏\t当日盈亏\t\n"
            "600519\t贵州茅台\t1000\t1000\t1500.00\t1600.00\t1600000.00\t100000.00\t5000.00\t\n"
        )
        rows = self.m.parse_tabular_data(tsv, required_headers=("证券代码",))
        p = self.m.normalize_position(rows)[0]
        self.assertEqual(p["code"], "600519")
        self.assertEqual(p["name"], "贵州茅台")
        self.assertEqual(p["vol"], 1000)
        self.assertEqual(p["avail"], 1000)
        self.assertEqual(p["cost"], 1500.0)
        self.assertEqual(p["price"], 1600.0)
        self.assertEqual(p["marketValue"], 1600000.0)
        self.assertEqual(p["pnl"], 100000.0)
        self.assertEqual(p["dayPnl"], 5000.0)

    def test_trade_buy(self):
        tsv = (
            "证券代码\t证券名称\t买卖方向\t成交价格\t成交数量\t成交时间\t状态\n"
            "600519\t贵州茅台\t买入\t1600.00\t100\t10:20:30\t已成\n"
        )
        rows = self.m.parse_tabular_data(tsv, required_headers=("证券代码",))
        t = self.m.normalize_trade(rows[0])
        self.assertEqual(t["code"], "600519")
        self.assertEqual(t["side"], "BUY")
        self.assertEqual(t["price"], 1600.0)
        self.assertEqual(t["vol"], 100)
        self.assertEqual(t["time"], "10:20:30")
        self.assertEqual(t["status"], "已成")

    def test_pending_sell(self):
        tsv = (
            "证券代码\t证券名称\t买卖方向\t委托价格\t委托数量\t成交数量\t委托时间\t状态\n"
            "000001\t平安银行\t卖出\t12.50\t2000\t0\t09:35:00\t已报\n"
        )
        rows = self.m.parse_tabular_data(tsv, required_headers=("证券代码",))
        q = self.m.normalize_pending(rows[0])
        self.assertEqual(q["code"], "000001")
        self.assertEqual(q["side"], "SELL")
        self.assertEqual(q["price"], 12.5)
        self.assertEqual(q["vol"], 2000)
        self.assertEqual(q["filledVol"], 0)
        self.assertEqual(q["time"], "09:35:00")

    def test_balance_cleans_comma_and_percent(self):
        bal = self.m.normalize_balance({
            "资金余额": "12,345.67", "冻结金额": "0.00", "可用金额": "12345.67",
            "可取金额": "10000.00", "股票市值": "200,000.00", "总资产": "212,345.67",
            "持仓盈亏": "5,000.00", "当日盈亏": "1,200.00", "当日盈亏比": "0.57",
        })
        self.assertEqual(bal["cash"], 12345.67)
        self.assertEqual(bal["availableCash"], 12345.67)
        self.assertEqual(bal["withdrawableCash"], 10000.0)
        self.assertEqual(bal["marketValue"], 200000.0)
        self.assertEqual(bal["totalAsset"], 212345.67)
        self.assertEqual(bal["floatPnl"], 5000.0)
        self.assertEqual(bal["dayPnl"], 1200.0)

    def test_malformed_header_rejected(self):
        for bad in ("\t\t\n", "a\tb\n1\n", "a\ta\n1\t2\n"):
            with self.assertRaises(Exception):
                self.m.parse_tabular_data(bad)



class CancelReadbackTest(unittest.TestCase):
    """P0-3 撤单读回确认：只有目标消失才 cancelled；仍在/读回失败均为非终态。"""

    @classmethod
    def setUpClass(cls):
        cls.m = _load_sidecar()

    def _pending(self, tsv):
        rows = self.m.parse_tabular_data(tsv, required_headers=("证券代码",))
        return [o for o in (self.m.normalize_pending(r) for r in rows) if o]

    def test_gone_returns_cancelled(self):
        # 目标委托已从挂单表消失 → cancelled
        pending = self._pending(
            "证券代码\t证券名称\t买卖方向\t委托价格\t委托数量\t成交数量\t委托时间\t状态\n"
            "000001\t平安银行\t卖出\t12.50\t2000\t0\t09:35:00\t已报\n"
        )
        status, note = self.m.classify_cancel_readback(
            {"code": "600519", "side": "BUY", "vol": 100, "price": 1600.0}, pending)
        self.assertEqual(status, "cancelled")
        self.assertIn("确认撤销", note)

    def test_still_present_returns_cancel_pending(self):
        pending = self._pending(
            "证券代码\t证券名称\t买卖方向\t委托价格\t委托数量\t成交数量\t委托时间\t状态\n"
            "600519\t贵州茅台\t买入\t1600.00\t100\t0\t09:36:00\t已报\n"
        )
        # price 仅 ±1% 软匹配，轻微偏差不改变“仍在”的硬判定
        status, _ = self.m.classify_cancel_readback(
            {"code": "600519", "side": "BUY", "vol": 100, "price": 1600.5}, pending)
        self.assertEqual(status, "cancel_pending")
        self.assertNotEqual(status, "cancelled")

    def test_readback_failed_none_returns_cancel_opened(self):
        status, _ = self.m.classify_cancel_readback(
            {"code": "600519", "side": "BUY", "vol": 100}, None)
        self.assertEqual(status, "cancel_opened")
        self.assertNotEqual(status, "cancelled")

    def test_missing_identity_fails_safe_nonterminal(self):
        # 目标标识不足（Rust cancel 仅带 client_order_id）→ fail-safe 非终态，绝不报 cancelled
        status, _ = self.m.classify_cancel_readback({}, [])
        self.assertEqual(status, "cancel_opened")
        self.assertNotEqual(status, "cancelled")


class FillModeAuthoritativeTest(unittest.TestCase):
    """P0-2：market（盘口价）不产生权威限价金额；limit 才产生。"""

    @classmethod
    def setUpClass(cls):
        cls.m = _load_sidecar()

    def test_market_has_no_authoritative_limit_amount(self):
        self.assertFalse(self.m.order_amount_is_authoritative({"fillMode": "market"}))

    def test_limit_is_authoritative(self):
        self.assertTrue(self.m.order_amount_is_authoritative({"fillMode": "limit"}))
        # 缺省按限价处理
        self.assertTrue(self.m.order_amount_is_authoritative({}))




class ReadFrameFlagTest(unittest.TestCase):
    """P0-6：读取失败语义显式化——ok:false 才是失败，缺 ok 旧帧按成功处理。"""

    @classmethod
    def setUpClass(cls):
        cls.m = _load_sidecar()

    def test_failure_frame_ok_false_empty_data_with_note_not_disguised_success(self):
        # 四类失败帧：ok:false、数据键为空、带明确失败原因；绝不是空仓/无成交的成功帧
        failure_frames = [
            {"event": "asset", "ok": False, "ts": 1700000000.0,
             "note": "资金读取失败：timeout"},
            {"event": "position", "positions": [], "full": True, "ok": False,
             "ts": 1700000000.0, "note": "持仓读取失败：timeout"},
            {"event": "trades", "trades": [], "full": True, "ok": False,
             "ts": 1700000000.0, "note": "当日成交读取失败：timeout"},
            {"event": "pending", "orders": [], "full": True, "ok": False,
             "ts": 1700000000.0, "note": "挂单读取失败：timeout"},
        ]
        for fr in failure_frames:
            self.assertTrue(self.m.read_is_failure(fr), f"应为失败帧：{fr}")
            self.assertTrue(fr["note"], "失败帧必须带明确失败原因")
            # 数据键为空：失败帧不得靠携带数据伪装成功
            for key in ("positions", "trades", "orders"):
                if key in fr:
                    self.assertEqual(fr[key], [], f"{fr['event']} 失败帧 {key} 应为空")
            if fr["event"] == "asset":
                self.assertNotIn("cash", fr, "资产失败帧不得携带成功资金字段")

    def test_success_empty_frame_ok_true_not_failure(self):
        # 成功但空（无成交 / 无挂单）：ok:true、note 空串，不得被判失败
        trades_empty = {"event": "trades", "trades": [], "full": True,
                        "source": "ths", "ok": True, "ts": 1700000000.0, "note": ""}
        pending_empty = {"event": "pending", "orders": [], "full": True,
                         "source": "ths", "ok": True, "ts": 1700000000.0, "note": ""}
        self.assertFalse(self.m.read_is_failure(trades_empty))
        self.assertFalse(self.m.read_is_failure(pending_empty))

    def test_missing_ok_legacy_frame_defaults_success(self):
        # 缺 ok 的旧帧（QMT / 旧 sidecar）按成功处理，向后兼容；note 不再是失败启发式
        legacy = {"event": "position", "positions": [], "full": True,
                  "note": "暂无持仓"}
        self.assertFalse(self.m.read_is_failure(legacy))

    def test_ok_false_even_with_data_key_still_failure(self):
        # ok:false 即便携带数据键（含空列表）仍判失败，失败帧不得靠数据键伪装成功
        fr = {"event": "trades", "trades": [], "ok": False,
              "note": "当日成交读取失败：timeout"}
        self.assertTrue(self.m.read_is_failure(fr))


class P04OperationQueueTest(unittest.TestCase):
    """P0-4：有界串行队列 / 10s 硬截止 fail-safe（注入时钟，无真实线程 / sleep）。"""

    @classmethod
    def setUpClass(cls):
        cls.m = _load_sidecar()

    def _make_q(self, cap=16, timeout=10.0, sink=None):
        t = [0.0]
        q = self.m.OperationQueue(capacity=cap, job_timeout=timeout,
                                 clock=lambda: t[0], event_sink=sink or (lambda ev: None))
        return q, t

    def test_enqueue_fifo_order_and_success(self):
        sink = []
        q, _t = self._make_q(sink=sink.append)
        s1, j1 = q.enqueue("query_asset", {}, "c1")
        s2, j2 = q.enqueue("query_position", {}, "c2")
        self.assertEqual(s1, "queued")
        self.assertEqual(s2, "queued")
        a = q.try_start_next()
        self.assertEqual(a.job_id, j1.job_id)
        q.finish_success(a, "ok1")
        self.assertEqual(a.state, "success")
        b = q.try_start_next()
        self.assertEqual(b.job_id, j2.job_id)
        q.finish_success(b, "ok2")
        self.assertEqual(b.state, "success")
        self.assertIsNone(q.try_start_next())

    def test_full_capacity_rejects_no_unbounded_growth(self):
        sink = []
        q, _t = self._make_q(cap=2, sink=sink.append)
        self.assertEqual(q.enqueue("a")[0], "queued")
        self.assertEqual(q.enqueue("b")[0], "queued")
        status, job = q.enqueue("c")
        self.assertEqual(status, "rejected_full")
        self.assertEqual(job.state, "rejected_full")
        self.assertEqual(q.pending_count(), 2)
        self.assertTrue(any(e.get("state") == "rejected_full" for e in sink))

    def test_timeout_marks_failed_only_error_never_cancel_or_filled_and_continues(self):
        sink = []
        q, t = self._make_q(timeout=10.0, sink=sink.append)
        _st, ja = q.enqueue("submit", {"client_order_id": "A"}, "A")
        a = q.try_start_next()
        self.assertEqual(a.state, "running")
        # 注入时钟推进越过 10s 硬截止
        t[0] = 11.0
        timed = q.sweep_timeouts()
        self.assertEqual(len(timed), 1)
        self.assertEqual(a.state, "timeout_failed")
        self.assertIsNone(q.active)
        # fail-safe：只出 error，绝无 cancelled / filled
        events = [e.get("event") for e in sink]
        self.assertIn("error", events)
        self.assertNotIn("cancelled", events)
        self.assertNotIn("filled", events)
        self.assertTrue(any(e.get("state") == "timeout_failed" for e in sink))
        self.assertEqual(sink[-1]["message"], self.m.QUEUE_TIMEOUT_MESSAGE)
        # 超时释放槽位后，后续作业继续执行
        _st, jb = q.enqueue("query_asset", {}, "B")
        b = q.try_start_next()
        self.assertEqual(b.job_id, jb.job_id)
        q.finish_success(b)
        self.assertEqual(b.state, "success")

    def test_late_success_after_timeout_is_suppressed(self):
        q, t = self._make_q()
        _st, ja = q.enqueue("x", {}, "A")
        a = q.try_start_next()
        t[0] = 20.0
        q.sweep_timeouts()
        q.finish_success(a, "late")  # 已超时，不得回写 success
        self.assertEqual(a.state, "timeout_failed")

    def test_error_terminal_state_emits_error(self):
        sink = []
        q, _t = self._make_q(sink=sink.append)
        _st, ja = q.enqueue("x", {}, "A")
        a = q.try_start_next()
        q.finish_error(a, RuntimeError("boom"))
        self.assertEqual(a.state, "error")
        self.assertTrue(any(e.get("state") == "error" for e in sink))


    def test_interactive_job_exempt_never_times_out(self):
        # 交互作业（budget=None）：时钟推进到 999s 仍保持 running，不发 error、不进 completed
        sink = []
        q, t = self._make_q(sink=sink.append)
        _st, ja = q.enqueue("submit", {"client_order_id": "A"}, "A", timeout_budget=None)
        a = q.try_start_next()
        self.assertEqual(a.state, "running")
        t[0] = 999.0
        timed = q.sweep_timeouts()
        self.assertEqual(timed, [])
        self.assertEqual(a.state, "running")
        self.assertIs(q.active, a)
        self.assertEqual(sink, [])
        self.assertNotIn(a, q.completed)

    def test_generous_budget_not_false_failed_at_10s(self):
        # 180s 宽裕预算：10s 时不被误判 timeout_failed（区别于纯自动化10s fail-safe）
        sink = []
        q, t = self._make_q(sink=sink.append)
        _st, ja = q.enqueue("cancel", {"client_order_id": "C"}, "C", timeout_budget=180.0)
        a = q.try_start_next()
        t[0] = 10.0
        self.assertEqual(q.sweep_timeouts(), [])
        self.assertEqual(a.state, "running")
        self.assertNotEqual(a.state, "timeout_failed")


class P04BackoffReconnectTest(unittest.TestCase):
    """P0-4：退避序列 1,2,4,8,16…封顶30s，成功重置。"""

    @classmethod
    def setUpClass(cls):
        cls.m = _load_sidecar()

    def test_sequence_doubles_then_caps_at_30(self):
        p = self.m.BackoffReconnectPolicy()
        seq = [p.next_delay() for _ in range(7)]
        self.assertEqual(seq, [1.0, 2.0, 4.0, 8.0, 16.0, 30.0, 30.0])

    def test_success_resets_attempts_to_base(self):
        p = self.m.BackoffReconnectPolicy()
        p.next_delay()
        p.next_delay()
        p.next_delay()
        self.assertEqual(p.attempts, 3)
        p.record_success()
        self.assertEqual(p.attempts, 0)
        self.assertEqual(p.next_delay(), 1.0)


class P04ActivityMonitorTest(unittest.TestCase):
    """P0-4：活性 / 停滞看门狗，注入时钟判定悬挂。"""

    @classmethod
    def setUpClass(cls):
        cls.m = _load_sidecar()

    def test_stale_detection_then_clear_on_end(self):
        t = [0.0]
        mon = self.m.ActivityMonitor(threshold=10.0, clock=lambda: t[0])
        mon.mark_start(1)
        self.assertFalse(mon.is_stale())
        t[0] = 12.0
        self.assertTrue(mon.is_stale())
        rep = mon.stale_report()
        self.assertTrue(rep["stale"])
        self.assertEqual(len(rep["stale_jobs"]), 1)
        self.assertEqual(rep["threshold"], 10.0)
        mon.mark_end(1)
        self.assertFalse(mon.is_stale())


if __name__ == "__main__":
    unittest.main(verbosity=2)
