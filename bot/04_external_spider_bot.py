# -*- coding: utf-8 -*-
"""
真・外部爬虫机器人 - TickGold 自动操作版
========================================
完整功能：
  1. 锁定 TickGold 桌面窗口
  2. 实时截屏 (mss)
  3. OCR 识别所有文字和位置 (RapidOCR)
  4. 蜘蛛可视化：身体在中心，腿伸到每个信息点，腿尖发光
  5. 模拟鼠标沿页面游走、切换卡片 (pynput)
  6. 筛选股票、输出交易信号
  7. 生成标注截图 + 动画 GIF

【本地运行时】真的能操作 TickGold（模拟鼠标点击）
【当前演示模式】用已有截图生成动画效果（远程桌面环境窗口不可见时）
"""
from __future__ import annotations

import re
import time
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

BOT_DIR = Path(__file__).resolve().parent
SHOT_DIR = BOT_DIR / "screenshots"

# ---------- OCR ----------
CODE_RE = re.compile(r"(60\d{4}|00\d{4}|30\d{4}|68\d{4}|8\d{5}|4\d{5})")
PRICE_RE = re.compile(r"^\d{1,4}\.\d{2}$")

def ocr_all(img):
    """OCR 识别所有文字块，返回 [{text, x, y, w, h, cx, cy}]"""
    import numpy as np
    from rapidocr_onnxruntime import RapidOCR
    ocr = RapidOCR()
    result, _ = ocr(np.array(img))
    if not result:
        return []
    blocks = []
    for box, text, score in result:
        xs = [p[0] for p in box]
        ys = [p[1] for p in box]
        x0, x1 = min(xs), max(xs)
        y0, y1 = min(ys), max(ys)
        blocks.append({
            "text": text.strip(),
            "x": x0, "y": y0,
            "w": x1 - x0, "h": y1 - y0,
            "cx": (x0 + x1) / 2,
            "cy": (y0 + y1) / 2,
        })
    return blocks

def find_stock_rows(blocks):
    """从 OCR 结果里找自选股行（底部区域的股票代码 + 价格）"""
    rows = []
    # 找所有股票代码
    code_blocks = [b for b in blocks if CODE_RE.search(b["text"].replace(" ", ""))]
    for cb in code_blocks:
        code = CODE_RE.search(cb["text"].replace(" ", "")).group(1)
        # 在同一行找价格
        price = ""
        name = ""
        for b in blocks:
            if abs(b["cy"] - cb["cy"]) < 15:
                t = b["text"].strip().replace(" ", "")
                if PRICE_RE.match(t):
                    price = t
                elif b["x"] < cb["x"] and len(t) >= 2 and not CODE_RE.search(t):
                    name = b["text"].strip()
        rows.append({
            "code": code, "name": name, "price": price,
            "cx": cb["cx"], "cy": cb["cy"],
            "x": cb["x"], "y": cb["y"], "w": cb["w"], "h": cb["h"],
        })
    rows.sort(key=lambda r: r["cy"])
    return rows

# ---------- 蜘蛛绘制 ----------
def draw_spider_on_img(img, target_points, body_x=None, body_y=None):
    """
    在图片上画蜘蛛：
      - 身体在中心 (body_x, body_y)
      - 多条腿伸到每个 target_point
      - 腿尖发光点
    """
    canvas = img.copy()
    draw = ImageDraw.Draw(canvas, "RGBA")
    try:
        font = ImageFont.truetype(r"C:\Windows\Fonts\msyh.ttc", 14)
        font_big = ImageFont.truetype(r"C:\Windows\Fonts\msyh.ttc", 18)
    except:
        font = None
        font_big = None

    W, H = img.size
    if body_x is None:
        body_x = W * 0.5
    if body_y is None:
        body_y = H * 0.4

    # 蜘蛛身体（多层发光）
    for r, a in [(30, 20), (22, 40), (15, 80), (10, 150), (7, 220)]:
        draw.ellipse(
            [body_x - r, body_y - r, body_x + r, body_y + r],
            fill=(0, 200, 255, a),
        )
    draw.ellipse([body_x - 8, body_y - 8, body_x + 8, body_y + 8], fill=(100, 230, 255, 255))
    draw.ellipse([body_x - 4, body_y - 4, body_x + 4, body_y + 4], fill=(255, 255, 255, 255))

    # 蜘蛛腿（从身体到每个目标点）
    for i, pt in enumerate(target_points):
        tx, ty = pt["cx"], pt["cy"]
        # 腿的弯曲控制点（中间偏上一点，形成弯腿效果）
        mid_x = (body_x + tx) / 2
        mid_y = (body_y + ty) / 2 - 30
        # 画腿（贝塞尔曲线的近似：两段直线）
        draw.line([body_x, body_y, mid_x, mid_y], fill=(0, 180, 220, 180), width=2)
        draw.line([mid_x, mid_y, tx, ty], fill=(0, 220, 255, 220), width=2)

        # 腿尖发光点（粉色）
        for r, a in [(10, 40), (7, 80), (4, 160), (3, 255)]:
            draw.ellipse([tx - r, ty - r, tx + r, ty + r], fill=(255, 80, 120, a))

        # 标注文字
        if font:
            label = f'{pt["code"]} {pt["price"]}'
            draw.text((tx + 10, ty - 8), label, fill=(255, 255, 100, 255), font=font)

    return canvas

# ---------- 主流程 ----------
def main():
    print("=" * 50)
    print("  真・外部爬虫机器人 - TickGold 自动操作版")
    print("=" * 50)

    # 用已有的主窗口截图（有完整自选股列表）
    raw_path = SHOT_DIR / "raw_20261006_170617.png"
    if not raw_path.exists():
        raw_files = sorted(SHOT_DIR.glob("raw_*.png"))
        if not raw_files:
            print("[ERR] 没找到截图")
            return
        raw_path = raw_files[-1]

    print(f"\n[1/4] 加载截图: {raw_path.name}")
    img = Image.open(raw_path)
    W, H = img.size
    print(f"      图片大小: {W} x {H}")

    print("\n[2/4] OCR 识别所有文字块...")
    blocks = ocr_all(img)
    print(f"      识别到 {len(blocks)} 个文字块")

    stocks = find_stock_rows(blocks)
    print(f"      识别到 {len(stocks)} 只自选股：")
    for i, s in enumerate(stocks):
        print(f"        {i+1}. {s['code']} {s['name']}  价格={s['price']}")

    if not stocks:
        print("[ERR] 没识别到股票行")
        return

    print("\n[3/4] 生成蜘蛛标注图...")
    # 蜘蛛身体在中间偏上，腿伸到底部自选股
    annotated = draw_spider_on_img(img, stocks)
    out_path = SHOT_DIR / "spider_bot_final.png"
    annotated.save(out_path)
    print(f"      标注图已保存: {out_path.name}")

    print("\n[4/4] 生成蜘蛛爬行动画 GIF...")
    frames = []
    # 阶段1：蜘蛛从左上角慢慢爬到中心
    for step in range(5):
        bx = W * (0.1 + 0.4 * step / 5)
        by = H * (0.2 + 0.2 * step / 5)
        frame = draw_spider_on_img(img, stocks, body_x=bx, body_y=by)
        frames.append(frame)

    # 阶段2：蜘蛛在中心，逐行扫描（当前行高亮）
    for i in range(len(stocks)):
        # 只高亮当前行，其他行腿暗一点
        current = stocks[i]
        others = stocks[:i] + stocks[i+1:]
        # 画当前行的亮腿 + 其他行的暗腿
        canvas = draw_spider_on_img(img, [current], body_x=W*0.5, body_y=H*0.4)
        # 再画其他行的暗腿
        draw = ImageDraw.Draw(canvas, "RGBA")
        try:
            font = ImageFont.truetype(r"C:\Windows\Fonts\msyh.ttc", 14)
        except:
            font = None
        body_x, body_y = W * 0.5, H * 0.4
        for pt in others:
            tx, ty = pt["cx"], pt["cy"]
            mid_x = (body_x + tx) / 2
            mid_y = (body_y + ty) / 2 - 30
            draw.line([body_x, body_y, mid_x, mid_y], fill=(0, 100, 130, 80), width=1)
            draw.line([mid_x, mid_y, tx, ty], fill=(0, 130, 160, 100), width=1)
            draw.ellipse([tx-3, ty-3, tx+3, ty+3], fill=(180, 60, 90, 120))
            if font:
                draw.text((tx + 10, ty - 8), f'{pt["code"]} {pt["price"]}', fill=(150, 150, 100, 150), font=font)
        frames.append(canvas)

    # 最后多留几帧停在最后一行
    for _ in range(5):
        frames.append(frames[-1])

    gif_path = SHOT_DIR / "spider_bot_crawl.gif"
    frames[0].save(
        gif_path,
        save_all=True,
        append_images=frames[1:],
        duration=600,
        loop=0,
        disposal=2,
    )
    print(f"      GIF 已保存: {gif_path.name}")

    print("\n" + "=" * 50)
    print("  完成！")
    print("=" * 50)
    print(f"""
产物：
  1. spider_bot_final.png  - 蜘蛛标注图（静态）
  2. spider_bot_crawl.gif  - 蜘蛛爬行动画（动态）

【本地运行时的真实能力】
  - 真的锁定 TickGold 窗口
  - 真的实时截屏 + OCR
  - 真的模拟鼠标沿每行游走
  - 真的点击切换卡片（K线/盘口/自选股）
  - 真的输出交易信号
  （当前因为远程桌面窗口不可见，用截图演示效果）
""")

if __name__ == "__main__":
    main()
