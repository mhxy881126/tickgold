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


if __name__ == "__main__":
    unittest.main(verbosity=2)
