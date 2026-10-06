# -*- coding: utf-8 -*-
"""
TickGold 自动盯盘机器人 - 最小原型 01
=====================================
功能链路：
  1. 锁定 "TickGold Island" 窗口
  2. 把它提到前台、拿到窗口坐标
  3. mss 高速截屏（只截这个窗口，不截全屏）
  4. RapidOCR 识别截图中的文字（中文+数字）
  5. 从 OCR 结果里抽取"股票行"（6位数字代码 + 名称 + 价格）
  6. 用 PIL 在截图上画出"蜘蛛爬取"标注：
       - 当前被抓取的行用高亮蓝框圈住
       - 蜘蛛光点沿行中心从上到下游走
       - 轨迹用细线连起来（形成你给的参考图里的网状效果）
  7. 保存原始截图 + 标注截图，控制台打印行情表

容错：
  - 找不到窗口：报错并列出所有可见窗口标题，便于人工确认
  - OCR 库没装 / 模型加载失败：退化为"只截屏+标注"，不崩溃
"""
from __future__ import annotations

import ctypes
import os
import re
import sys
import time
import traceback
from ctypes import wintypes
from datetime import datetime
from pathlib import Path

# ---------- Win32 窗口枚举（替代 pygetwindow，兼容 Python 3.14） ----------
_user32 = ctypes.windll.user32

# 枚举所有顶层可见窗口，返回 [(hwnd, title, (left, top, right, bottom))]
def enum_visible_windows():
    results = []
    WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    def _cb(hwnd, lparam):
        if not _user32.IsWindowVisible(hwnd):
            return True
        length = _user32.GetWindowTextLengthW(hwnd)
        if length == 0:
            return True
        buf = ctypes.create_unicode_buffer(length + 1)
        _user32.GetWindowTextW(hwnd, buf, length + 1)
        title = buf.value
        rect = wintypes.RECT()
        _user32.GetWindowRect(hwnd, ctypes.byref(rect))
        results.append((hwnd, title, (rect.left, rect.top, rect.right, rect.bottom)))
        return True

    _user32.EnumWindows(WNDENUMPROC(_cb), 0)
    return results

# ---------- 路径 ----------
BOT_DIR = Path(__file__).resolve().parent
SHOT_DIR = BOT_DIR / "screenshots"
SHOT_DIR.mkdir(parents=True, exist_ok=True)

# ---------- 1. 锁定窗口 ----------
def find_tickgold_window():
    """返回 (hwnd, title, (left, top, right, bottom))。"""
    wins = enum_visible_windows()
    candidates = [w for w in wins if "tickgold" in w[1].lower()]
    if not candidates:
        print("[ERR] 没找到 TickGold 窗口。当前所有可见窗口标题：")
        for hwnd, title, rect in wins:
            print("   -", repr(title))
        sys.exit(1)
    # 主窗口面积最大（"TickGold Island" 灵动岛小窗只有 320x52，要排除）
    candidates.sort(
        key=lambda w: -((w[2][2]-w[2][0]) * (w[2][3]-w[2][1]))
    )
    hwnd, title, rect = candidates[0]
    left, top, right, bottom = rect
    area = (right - left) * (bottom - top)
    print(f"[OK] 锁定窗口: {title!r}  hwnd={hwnd}  ({left},{top} {right-left}x{bottom-top}, area={area})")
    return hwnd, title, rect


def activate_window(hwnd):
    """把窗口提到前台。最小化时先还原。"""
    try:
        # 最小化则还原
        SW_RESTORE = 9
        if _user32.IsIconic(hwnd):
            _user32.ShowWindow(hwnd, SW_RESTORE)
            time.sleep(0.4)
        # 前台化（AttachThreadInput 绕开"前台锁"）
        fg = _user32.GetForegroundWindow()
        cur_tid = ctypes.windll.kernel32.GetCurrentThreadId()
        fg_tid = _user32.GetWindowThreadProcessId(fg, None)
        _user32.AttachThreadInput(cur_tid, fg_tid, True)
        _user32.SetForegroundWindow(hwnd)
        _user32.AttachThreadInput(cur_tid, fg_tid, False)
        time.sleep(0.6)
    except Exception as e:
        print(f"[WARN] activate 失败（不影响截屏）: {e}")


# ---------- 2. 截屏 ----------
def grab_window(rect):
    """mss 截指定窗口客户区，返回 PIL.Image。"""
    import mss
    from PIL import Image
    left, top, right, bottom = rect
    bbox = {"left": left, "top": top, "width": right - left, "height": bottom - top}
    with mss.MSS() as sct:
        raw = sct.grab(bbox)
        img = Image.frombytes("RGB", raw.size, raw.bgra, "raw", "BGRX")
    print(f"[OK] 截屏完成: {img.size[0]}x{img.size[1]}")
    return img


# ---------- 3. OCR ----------
def run_ocr(img):
    """返回 [[box(4点), text, score], ...]。失败返回 []。"""
    try:
        from rapidocr_onnxruntime import RapidOCR
    except Exception as e:
        print(f"[WARN] 未安装 rapidocr-onnxruntime，跳过 OCR: {e}")
        return []

    import numpy as np
    ocr = RapidOCR()
    result, _ = ocr(np.array(img))
    if not result:
        print("[WARN] OCR 没识别到任何文字")
        return []
    print(f"[OK] OCR 识别到 {len(result)} 个文本块")
    return result


# ---------- 4. 从 OCR 结果里抽取股票行 ----------
# A 股代码：6 位数字，60/00/30/68/8/4 开头（从文本块中提取，不要求整块=代码）
CODE_RE = re.compile(r"(60\d{4}|00\d{4}|30\d{4}|68\d{4}|8\d{5}|4\d{5})")
# 价格：如 11.57 / 1258.62
PRICE_RE = re.compile(r"^\d{1,4}\.\d{2}$")
# 涨跌幅：如 +1.94% / -1.60%
PCT_RE = re.compile(r"^[+-]?\d+\.\d+%$")
# 自选股列表在窗口底部，y 阈值（截图高度约 839，列表从 ~660 开始）
WATCHLIST_Y_MIN = 640


def extract_stock_rows(ocr_result):
    """
    1. 从每个文本块里用正则提取 6 位股票代码（块常是"平安银行000001"合并形态）。
    2. 只保留 y > WATCHLIST_Y_MIN 的块（排除 K 线标题、盘口等区域）。
    3. 同行（y 差 < 20px）找价格、涨跌幅。
    """
    if not ocr_result:
        return []

    code_blocks = []
    for box, text, score in ocr_result:
        t = text.strip().replace(" ", "")
        m = CODE_RE.search(t)
        if not m:
            continue
        cy = sum(p[1] for p in box) / 4
        if cy < WATCHLIST_Y_MIN:
            continue  # 排除 K 线标题、盘口卖买价等
        code = m.group(1)
        name = t.replace(code, "").strip()
        code_blocks.append({
            "code": code,
            "name": name,
            "cy": cy,
            "box": box,
        })

    rows = []
    for cb in code_blocks:
        price, pct = "", ""
        for box, text, score in ocr_result:
            t = text.strip().replace(" ", "")
            cy = sum(p[1] for p in box) / 4
            if abs(cy - cb["cy"]) > 20:
                continue
            if PRICE_RE.match(t) and not price:
                price = t
            elif PCT_RE.match(t):
                pct = t
        rows.append({**cb, "price": price, "pct": pct})

    rows.sort(key=lambda r: r["cy"])
    return rows


# ---------- 5. 画"蜘蛛爬取"标注 ----------
def draw_spider_annotation(img, rows, ocr_result):
    """
    在截图上画：
      - 每个股票行：蓝色高亮框（从第一个块到最后一个块的 x 范围）
      - 蜘蛛光点：沿每行中心从上到下移动
      - 轨迹线：连接所有行中心（半透明青色细线）
    """
    from PIL import Image, ImageDraw

    canvas = img.copy()
    draw = ImageDraw.Draw(canvas, "RGBA")

    # 尝试加载中文字体
    font = None
    for fp in [r"C:\Windows\Fonts\msyh.ttc", r"C:\Windows\Fonts\simhei.ttf"]:
        if os.path.exists(fp):
            try:
                from PIL import ImageFont
                font = ImageFont.truetype(fp, 14)
                break
            except Exception:
                pass

    if not rows:
        # 没有股票行时，画几个采样框证明标注层能工作
        print("[INFO] 无股票行可标注，仅在截图中心画一个示例蜘蛛标记")
        cx, cy = img.size[0] // 2, img.size[1] // 2
        draw.ellipse([cx-10, cy-10, cx+10, cy+10], fill=(0, 200, 255, 220))
        draw.text((cx+14, cy-8), "SPIDER", fill=(0, 200, 255, 255), font=font)
        return canvas

    # 1) 行高亮框 + 轨迹点
    centers = []
    for r in rows:
        # 找这一行所有块的 x 范围
        sib_boxes = [
            b for b, txt, sc in ocr_result
            if abs(sum(p[1] for p in b) / 4 - r["cy"]) < 20
        ] if ocr_result else [r["box"]]

        if sib_boxes:
            x0 = min(min(p[0] for p in b) for b in sib_boxes) - 4
            x1 = max(max(p[0] for p in b) for b in sib_boxes) + 4
            y0 = min(min(p[1] for p in b) for b in sib_boxes) - 2
            y1 = max(max(p[1] for p in b) for b in sib_boxes) + 2
        else:
            x0, y0, x1, y1 = r["box"][0][0]-4, r["box"][0][1]-2, r["box"][2][0]+4, r["box"][2][1]+2

        # 蓝色半透明高亮框
        draw.rectangle([x0, y0, x1, y1], outline=(80, 160, 255, 255), width=2)
        draw.rectangle([x0, y0, x1, y1], fill=(80, 160, 255, 30))

        # 行内中心点（蜘蛛落脚处）
        centers.append(((x0 + x1) / 2, (y0 + y1) / 2))

        # 在框左侧标注代码
        if font:
            draw.text((x0 + 4, y0 - 16), f'{r["code"]} {r["name"]} {r["price"]}',
                      fill=(255, 230, 0, 255), font=font)

    # 2) 蜘蛛轨迹线：把所有中心点连起来
    if len(centers) >= 2:
        for i in range(len(centers) - 1):
            draw.line([centers[i], centers[i+1]], fill=(0, 220, 220, 160), width=2)

    # 3) 蜘蛛光点：在最后一行（当前爬取位置）画一个发光圆
    if centers:
        cx, cy = centers[-1]
        # 外发光
        for r, a in [(18, 60), (12, 120), (7, 220)]:
            draw.ellipse([cx-r, cy-r, cx+r, cy+r], fill=(0, 255, 255, a))
        draw.ellipse([cx-4, cy-4, cx+4, cy+4], fill=(255, 255, 255, 255))

    return canvas


# ---------- 6. 打印行情表 ----------
def print_table(rows):
    print("\n" + "=" * 60)
    print(f"{'代码':<8}{'名称':<10}{'最新价':<10}{'涨跌幅':<10}")
    print("-" * 60)
    if not rows:
        print("(没识别到股票行——请确认自选股表在窗口底部可见)")
    for r in rows:
        print(f"{r['code']:<8}{r['name']:<10}{r['price']:<10}{r['pct']:<10}")
    print("=" * 60 + "\n")


# ---------- main ----------
def main():
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    print(f"\n>>> TickGold 盯盘机器人原型 01  @ {ts}\n")

    hwnd, title, rect = find_tickgold_window()
    activate_window(hwnd)
    img = grab_window(rect)

    raw_path = SHOT_DIR / f"raw_{ts}.png"
    img.save(raw_path)
    print(f"[OK] 原始截图已保存: {raw_path}")

    ocr_result = run_ocr(img)
    rows = extract_stock_rows(ocr_result)
    print_table(rows)

    annotated = draw_spider_annotation(img, rows, ocr_result)
    ann_path = SHOT_DIR / f"annotated_{ts}.png"
    annotated.save(ann_path)
    print(f"[OK] 蜘蛛标注截图已保存: {ann_path}")
    print("\n>>> 完成。用图片查看器打开 annotated_*.png 看效果。")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc()
        input("\n按回车退出...")
