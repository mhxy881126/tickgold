# -*- coding: utf-8 -*-
"""
蜘蛛机器人 v3 - 参考视频效果
============================
特点（参考微博视频）：
  - 蜘蛛身体：小方块（蓝紫色）
  - 腿尖光点：绿色/青色小圆点
  - 被扫描的行：彩色高亮框（当前行亮红，其他行暗蓝）
  - 腿：多关节折线（3 个弯）
  - 整体效果：像蜘蛛在页面上爬，逐个点过去
"""
from __future__ import annotations

import re
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

BOT_DIR = Path(__file__).resolve().parent
SHOT_DIR = BOT_DIR / "screenshots"

CODE_RE = re.compile(r"(60\d{4}|00\d{4}|30\d{4}|68\d{4}|8\d{5}|4\d{5})")
PRICE_RE = re.compile(r"^\d{1,4}\.\d{2}$")

def ocr_all(img):
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
    rows = []
    code_blocks = [b for b in blocks if CODE_RE.search(b["text"].replace(" ", ""))]
    for cb in code_blocks:
        code = CODE_RE.search(cb["text"].replace(" ", "")).group(1)
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

def draw_spider_leg(draw, bx, by, tx, ty, color=(0, 220, 180, 200), width=2):
    """3 个关节的蜘蛛腿：身体 → 膝1 → 膝2 → 膝3 → 脚尖"""
    dx = tx - bx
    dy = ty - by
    # 关节1
    k1x = bx + dx * 0.25
    k1y = by + dy * 0.25 - 20
    # 关节2
    k2x = bx + dx * 0.55
    k2y = by + dy * 0.55 + 15
    # 关节3
    k3x = bx + dx * 0.8
    k3y = by + dy * 0.8 - 10

    draw.line([bx, by, k1x, k1y], fill=color, width=width)
    draw.line([k1x, k1y, k2x, k2y], fill=color, width=width)
    draw.line([k2x, k2y, k3x, k3y], fill=color, width=width)
    draw.line([k3x, k3y, tx, ty], fill=color, width=width)

    # 关节小点
    r = 2
    for kx, ky in [(k1x, k1y), (k2x, k2y), (k3x, k3y)]:
        draw.ellipse([kx-r, ky-r, kx+r, ky+r], fill=color)

def draw_highlight_box(draw, row, color=(255, 60, 80, 120)):
    """给股票行画高亮框"""
    x0 = row["x"] - 10
    y0 = row["y"] - 5
    x1 = row["x"] + row["w"] + 100  # 往右延伸一点，包含价格
    y1 = row["y"] + row["h"] + 5
    draw.rectangle([x0, y0, x1, y1], outline=color, width=2)
    draw.rectangle([x0, y0, x1, y1], fill=color)

def main():
    print("=" * 50)
    print("  蜘蛛机器人 v3 - 参考视频效果")
    print("=" * 50)

    raw_path = SHOT_DIR / "raw_20261006_170617.png"
    if not raw_path.exists():
        raw_files = sorted(SHOT_DIR.glob("raw_*.png"))
        if not raw_files:
            print("[ERR] 没找到截图")
            return
        raw_path = raw_files[-1]

    print(f"\n[1/3] 加载截图: {raw_path.name}")
    img = Image.open(raw_path)
    W, H = img.size

    print("\n[2/3] OCR 识别...")
    blocks = ocr_all(img)
    stocks = find_stock_rows(blocks)
    print(f"      识别到 {len(stocks)} 只自选股")

    if not stocks:
        print("[ERR] 没识别到股票")
        return

    try:
        font = ImageFont.truetype(r"C:\Windows\Fonts\msyh.ttc", 14)
        font_big = ImageFont.truetype(r"C:\Windows\Fonts\msyh.ttc", 20)
    except:
        font = None
        font_big = None

    # ===== 生成静态标注图 =====
    print("\n[3/3] 生成标注图...")
    canvas = img.copy()
    draw = ImageDraw.Draw(canvas, "RGBA")

    bx, by = W * 0.45, H * 0.35

    # 先画所有腿（暗一点）
    for pt in stocks:
        draw_spider_leg(draw, bx, by, pt["cx"], pt["cy"], color=(0, 150, 120, 100), width=1)
        # 腿尖绿色光点
        for r, a in [(6, 30), (4, 80), (2.5, 200)]:
            draw.ellipse([pt["cx"]-r, pt["cy"]-r, pt["cx"]+r, pt["cy"]+r], fill=(0, 255, 180, a))

    # 蜘蛛身体（小方块，蓝紫色）
    draw.rectangle([bx-8, by-8, bx+8, by+8], fill=(100, 100, 255, 220))
    draw.rectangle([bx-5, by-5, bx+5, by+5], fill=(150, 150, 255, 255))
    draw.rectangle([bx-2, by-2, bx+2, by+2], fill=(255, 255, 255, 255))

    # 标注文字
    for pt in stocks:
        if font:
            draw.text((pt["cx"] + 12, pt["cy"] - 8), f'{pt["code"]} {pt["price"]}',
                      fill=(255, 255, 100, 230), font=font)

    out_path = SHOT_DIR / "spider_v3.png"
    canvas.save(out_path)
    print(f"      静态图: {out_path.name}")

    # ===== 生成动画 =====
    print("\n生成动画...")
    frames = []

    # 阶段1：蜘蛛从左上角爬过来
    for step in range(8):
        bx = W * (0.1 + 0.35 * step / 8)
        by = H * (0.15 + 0.2 * step / 8)
        frame = img.copy()
        d = ImageDraw.Draw(frame, "RGBA")
        # 画腿
        for pt in stocks:
            draw_spider_leg(d, bx, by, pt["cx"], pt["cy"], color=(0, 150, 120, 80), width=1)
            d.ellipse([pt["cx"]-3, pt["cy"]-3, pt["cx"]+3, pt["cy"]+3], fill=(0, 255, 180, 150))
        # 画身体
        d.rectangle([bx-6, by-6, bx+6, by+6], fill=(100, 100, 255, 220))
        frames.append(frame)

    # 阶段2：逐行扫描（当前行高亮）
    for i in range(len(stocks)):
        frame = img.copy()
        d = ImageDraw.Draw(frame, "RGBA")
        bx, by = W * 0.45, H * 0.35

        # 其他行（暗）
        for j, pt in enumerate(stocks):
            if j == i:
                continue
            draw_spider_leg(d, bx, by, pt["cx"], pt["cy"], color=(0, 100, 80, 60), width=1)
            d.ellipse([pt["cx"]-3, pt["cy"]-3, pt["cx"]+3, pt["cy"]+3], fill=(0, 180, 120, 100))

        # 当前行（亮）+ 高亮框
        current = stocks[i]
        draw_highlight_box(d, current, color=(255, 60, 80, 80))  # 红色半透明框
        draw_spider_leg(d, bx, by, current["cx"], current["cy"], color=(0, 255, 180, 255), width=2)
        # 腿尖亮绿光
        for r, a in [(10, 60), (7, 120), (4, 220), (2, 255)]:
            d.ellipse([current["cx"]-r, current["cy"]-r, current["cx"]+r, current["cy"]+r], fill=(0, 255, 180, a))
        if font:
            d.text((current["cx"] + 12, current["cy"] - 8), f'{current["code"]} {current["price"]}',
                   fill=(255, 255, 100, 255), font=font)

        # 蜘蛛身体
        d.rectangle([bx-6, by-6, bx+6, by+6], fill=(100, 100, 255, 220))
        d.rectangle([bx-3, by-3, bx+3, by+3], fill=(150, 150, 255, 255))

        # 顶部状态栏
        d.rectangle([0, 0, W, 40], fill=(0, 0, 0, 200))
        if font_big:
            d.text((15, 8), f"🕷 爬虫机器人  -  扫描第 {i+1}/{len(stocks)} 行  {current['code']} {current['price']}",
                   fill=(0, 255, 180, 255), font=font_big)

        frames.append(frame)

    # 最后多留几帧
    for _ in range(6):
        frames.append(frames[-1])

    gif_path = SHOT_DIR / "spider_v3_crawl.gif"
    frames[0].save(
        gif_path,
        save_all=True,
        append_images=frames[1:],
        duration=500,
        loop=0,
        disposal=2,
    )
    print(f"      动画: {gif_path.name}")
    print("\n完成！")

if __name__ == "__main__":
    main()
