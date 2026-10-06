# -*- coding: utf-8 -*-
"""
TickGold 真・外部机器人 - 动态蜘蛛游走版
=========================================
效果：
  1. 锁定 TickGold 窗口，OCR 识别所有自选股行
  2. 模拟鼠标逐行移动（真的动鼠标）
  3. 实时截屏 + PIL 画蜘蛛标注（蓝色高亮框 + 青色轨迹 + 发光蜘蛛点）
  4. OpenCV 窗口实时显示
  5. 循环游走，按 ESC 退出

视觉效果 = 你给的维基百科蜘蛛参考图：
  - 当前爬的行：亮蓝色框 + 发光蜘蛛点
  - 已爬过的行：暗蓝色框
  - 轨迹：青色细线把已爬的行连起来
"""
from __future__ import annotations

import ctypes
import re
import sys
import time
from ctypes import wintypes
from pathlib import Path

import cv2
import mss
import numpy as np
from PIL import Image, ImageDraw, ImageFont

# ---------- Win32 窗口 ----------
_user32 = ctypes.windll.user32

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
        rect = wintypes.RECT()
        _user32.GetWindowRect(hwnd, ctypes.byref(rect))
        results.append((hwnd, buf.value, (rect.left, rect.top, rect.right, rect.bottom)))
        return True
    _user32.EnumWindows(WNDENUMPROC(_cb), 0)
    return results

def find_tickgold():
    wins = enum_visible_windows()
    cands = [w for w in wins if "tickgold" in w[1].lower()]
    if not cands:
        print("[ERR] 没找到 TickGold 窗口")
        sys.exit(1)
    cands.sort(key=lambda w: -((w[2][2]-w[2][0]) * (w[2][3]-w[2][1])))
    hwnd, title, rect = cands[0]
    print(f"[OK] 锁定窗口: {title!r}  ({rect[0]},{rect[1]} {rect[2]-rect[0]}x{rect[3]-rect[1]})")
    return hwnd, rect

def activate(hwnd):
    try:
        if _user32.IsIconic(hwnd):
            _user32.ShowWindow(hwnd, 9)
            time.sleep(0.3)
        fg = _user32.GetForegroundWindow()
        cur_tid = ctypes.windll.kernel32.GetCurrentThreadId()
        fg_tid = _user32.GetWindowThreadProcessId(fg, None)
        _user32.AttachThreadInput(cur_tid, fg_tid, True)
        _user32.SetForegroundWindow(hwnd)
        _user32.AttachThreadInput(cur_tid, fg_tid, False)
        time.sleep(0.4)
    except Exception as e:
        print(f"[WARN] activate: {e}")

# ---------- 截屏 ----------
def grab(rect):
    left, top, right, bottom = rect
    bbox = {"left": left, "top": top, "width": right-left, "height": bottom-top}
    with mss.MSS() as sct:
        raw = sct.grab(bbox)
    return Image.frombytes("RGB", raw.size, raw.bgra, "raw", "BGRX")

# ---------- OCR ----------
CODE_RE = re.compile(r"(60\d{4}|00\d{4}|30\d{4}|68\d{4}|8\d{5}|4\d{5})")
PRICE_RE = re.compile(r"^\d{1,4}\.\d{2}$")
WATCHLIST_Y_MIN = 600

def ocr_rows(img):
    from rapidocr_onnxruntime import RapidOCR
    ocr = RapidOCR()
    result, _ = ocr(np.array(img))
    if not result:
        return []
    # 找股票代码块
    code_blocks = []
    for box, text, score in result:
        t = text.strip().replace(" ", "")
        m = CODE_RE.search(t)
        if not m:
            continue
        cy = sum(p[1] for p in box) / 4
        if cy < WATCHLIST_Y_MIN:
            continue
        code_blocks.append({"code": m.group(1), "cy": cy, "box": box})
    # 找同行的价格
    rows = []
    for cb in code_blocks:
        price = ""
        for box, text, score in result:
            t = text.strip().replace(" ", "")
            cy = sum(p[1] for p in box) / 4
            if abs(cy - cb["cy"]) < 20 and PRICE_RE.match(t):
                price = t
                break
        rows.append({**cb, "price": price})
    rows.sort(key=lambda r: r["cy"])
    return rows

# ---------- 画蜘蛛标注 ----------
def draw_spider(img, rows, current_idx):
    canvas = img.copy()
    draw = ImageDraw.Draw(canvas, "RGBA")
    try:
        font = ImageFont.truetype(r"C:\Windows\Fonts\msyh.ttc", 13)
    except:
        font = None

    centers = []
    for i, r in enumerate(rows):
        box = r["box"]
        x0 = min(p[0] for p in box) - 4
        x1 = max(p[0] for p in box) + 4
        y0 = min(p[1] for p in box) - 2
        y1 = max(p[1] for p in box) + 2
        cx, cy = (x0+x1)/2, (y0+y1)/2
        centers.append((cx, cy))

        if i == current_idx:
            # 当前行：亮蓝色框 + 发光
            draw.rectangle([x0, y0, x1, y1], outline=(0, 200, 255, 255), width=3)
            draw.rectangle([x0, y0, x1, y1], fill=(0, 200, 255, 40))
        elif i < current_idx:
            # 已爬过：暗蓝色框
            draw.rectangle([x0, y0, x1, y1], outline=(80, 160, 255, 180), width=1)
            draw.rectangle([x0, y0, x1, y1], fill=(80, 160, 255, 15))
        else:
            # 未爬：灰色框
            draw.rectangle([x0, y0, x1, y1], outline=(100, 100, 100, 120), width=1)

        # 标注文字
        if font:
            label = f'{r["code"]} {r["price"]}'
            draw.text((x0+4, y0-16), label, fill=(255, 230, 0, 255), font=font)

    # 轨迹线：连接已爬过的行
    for i in range(min(current_idx, len(centers)-1)):
        draw.line([centers[i], centers[i+1]], fill=(0, 255, 220, 180), width=2)

    # 蜘蛛发光点（当前行）
    if 0 <= current_idx < len(centers):
        cx, cy = centers[current_idx]
        for r, a in [(20, 40), (14, 90), (8, 180)]:
            draw.ellipse([cx-r, cy-r, cx+r, cy+r], fill=(0, 255, 220, a))
        draw.ellipse([cx-5, cy-5, cx+5, cy+5], fill=(255, 255, 255, 255))
        # 蜘蛛身体（小蜘蛛图标感）
        draw.ellipse([cx-3, cy-3, cx+3, cy+3], fill=(0, 255, 220, 255))

    # 顶部状态栏
    draw.rectangle([0, 0, img.size[0], 30], fill=(0, 0, 0, 180))
    if font:
        draw.text((10, 8), f"🕷 SPIDER BOT - 正在扫描第 {current_idx+1}/{len(rows)} 行 | 按 ESC 退出",
                  fill=(0, 255, 220, 255), font=font)

    return canvas

# ---------- 主循环 ----------
def main():
    print("\n>>> 真・外部机器人 - 动态蜘蛛游走版\n")
    hwnd, rect = find_tickgold()
    activate(hwnd)

    print("[INFO] 第一次截屏 + OCR 定位自选股行...")
    img = grab(rect)
    rows = ocr_rows(img)
    print(f"[OK] 识别到 {len(rows)} 只自选股：")
    for r in rows:
        print(f"   {r['code']}  y={r['cy']:.0f}  price={r['price']}")

    if not rows:
        print("[ERR] 没识别到股票行，退出")
        return

    # 鼠标控制
    from pynput.mouse import Controller
    mouse = Controller()

    left, top, _, _ = rect
    idx = 0
    print("\n[INFO] 开始游走... 按 OpenCV 窗口里的 ESC 退出\n")

    while True:
        # 1. 计算当前行的屏幕坐标
        r = rows[idx]
        box = r["box"]
        x0 = min(p[0] for p in box)
        x1 = max(p[0] for p in box)
        cy = (min(p[1] for p in box) + max(p[1] for p in box)) / 2
        # 转成绝对屏幕坐标
        screen_x = left + (x0 + x1) / 2
        screen_y = top + cy

        # 2. 模拟鼠标移动过去
        mouse.position = (int(screen_x), int(screen_y))

        # 3. 截屏 + 画标注
        frame = grab(rect)
        annotated = draw_spider(frame, rows, idx)

        # 4. OpenCV 显示（PIL -> BGR）
        frame_bgr = cv2.cvtColor(np.array(annotated), cv2.COLOR_RGB2BGR)
        cv2.imshow("Spider Bot - TickGold Crawler", frame_bgr)

        # 5. 等待 600ms，检测 ESC
        key = cv2.waitKey(600) & 0xFF
        if key == 27:  # ESC
            break

        # 6. 下一行（循环）
        idx = (idx + 1) % len(rows)

    cv2.destroyAllWindows()
    print("\n>>> 已退出。")

if __name__ == "__main__":
    main()
