# -*- coding: utf-8 -*-
"""
科技感蜘蛛爬虫 - 参考图效果
==========================
特点（完全按参考图）：
  - 蜘蛛身体：蓝色小方块（中心节点）
  - 蜘蛛腿：青色线条，多关节折线（3-4 个弯）
  - 腿尖光点：粉色/红色小圆点
  - 高亮框：粉红色长条（当前扫描的行）
  - 整体：数据网络感，像蜘蛛在网页上爬
"""
from __future__ import annotations

import re
import math
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

def draw_tech_spider_leg(draw, bx, by, tx, ty, color=(0, 200, 255, 200), width=2):
    """
    科技感蜘蛛腿：多关节折线（4 个关节，5 段）
    像参考图那样，弯弯曲曲的
    """
    dx = tx - bx
    dy = ty - by
    dist = math.sqrt(dx*dx + dy*dy)
    if dist < 1:
        return

    # 生成 4 个中间点（随机弯曲，但有规律）
    points = [(bx, by)]
    for i in range(1, 5):
        t = i / 5
        px = bx + dx * t
        py = by + dy * t
        # 加一点垂直偏移，让腿弯弯曲曲
        offset = math.sin(t * math.pi) * 25 * (1 if i % 2 == 0 else -1)
        # 垂直于方向的偏移
        nx = -dy / dist
        ny = dx / dist
        px += nx * offset
        py += ny * offset
        points.append((px, py))
    points.append((tx, ty))

    # 画折线
    for i in range(len(points) - 1):
        draw.line([points[i], points[i+1]], fill=color, width=width)

    # 关节小圆点
    r = 2
    for p in points[1:-1]:
        draw.ellipse([p[0]-r, p[1]-r, p[0]+r, p[1]+r], fill=color)

def draw_tech_spider_body(draw, bx, by, size=10):
    """科技感蜘蛛身体：蓝色小方块 + 发光"""
    # 外发光
    for r, a in [(size+10, 20), (size+6, 40), (size+3, 80)]:
        draw.ellipse([bx-r, by-r, bx+r, by+r], fill=(0, 150, 255, a))
    # 方块本体
    draw.rectangle([bx-size, by-size, bx+size, by+size], fill=(0, 100, 255, 220))
    draw.rectangle([bx-size+2, by-size+2, bx+size-2, by+size-2], fill=(50, 180, 255, 255))
    # 中心点
    draw.ellipse([bx-2, by-2, bx+2, by+2], fill=(255, 255, 255, 255))

def draw_pink_highlight(draw, row, color=(255, 60, 150, 100)):
    """粉红色高亮长条（像参考图那样）"""
    x0 = row["x"] - 10
    y0 = row["y"] - 5
    x1 = row["x"] + row["w"] + 150  # 长一点
    y1 = row["y"] + row["h"] + 5
    draw.rectangle([x0, y0, x1, y1], fill=color)
    draw.rectangle([x0, y0, x1, y1], outline=(255, 100, 180, 200), width=1)

def main():
    print("=" * 50)
    print("  科技感蜘蛛爬虫")
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

    print("\n[3/3] 生成科技感蜘蛛图...")
    canvas = img.copy()
    draw = ImageDraw.Draw(canvas, "RGBA")

    bx, by = W * 0.45, H * 0.35

    # 画所有腿（暗一点）
    for pt in stocks:
        draw_tech_spider_leg(draw, bx, by, pt["cx"], pt["cy"], color=(0, 150, 200, 100), width=1)
        # 腿尖粉色光点
        for r, a in [(6, 40), (4, 100), (2.5, 200)]:
            draw.ellipse([pt["cx"]-r, pt["cy"]-r, pt["cx"]+r, pt["cy"]+r], fill=(255, 80, 150, a))

    # 蜘蛛身体（蓝色方块）
    draw_tech_spider_body(draw, bx, by, size=10)

    # 标注文字
    for pt in stocks:
        if font:
            draw.text((pt["cx"] + 12, pt["cy"] - 8), f'{pt["code"]} {pt["price"]}',
                      fill=(255, 255, 100, 230), font=font)

    out_path = SHOT_DIR / "spider_tech.png"
    canvas.save(out_path)
    print(f"      静态图: {out_path.name}")

    # ===== 生成动画 =====
    print("\n生成动画...")
    frames = []

    # 阶段1：蜘蛛从左上角爬过来
    for step in range(10):
        bx = W * (0.1 + 0.35 * step / 10)
        by = H * (0.15 + 0.2 * step / 10)
        frame = img.copy()
        d = ImageDraw.Draw(frame, "RGBA")
        for pt in stocks:
            draw_tech_spider_leg(d, bx, by, pt["cx"], pt["cy"], color=(0, 150, 200, 80), width=1)
            d.ellipse([pt["cx"]-3, pt["cy"]-3, pt["cx"]+3, pt["cy"]+3], fill=(255, 80, 150, 150))
        draw_tech_spider_body(d, bx, by, size=10)
        frames.append(frame)

    # 阶段2：逐行扫描（当前行高亮 + 粉色框）
    for i in range(len(stocks)):
        frame = img.copy()
        d = ImageDraw.Draw(frame, "RGBA")
        bx, by = W * 0.45, H * 0.35

        # 其他行（暗）
        for j, pt in enumerate(stocks):
            if j == i:
                continue
            draw_tech_spider_leg(d, bx, by, pt["cx"], pt["cy"], color=(0, 120, 160, 60), width=1)
            d.ellipse([pt["cx"]-3, pt["cy"]-3, pt["cx"]+3, pt["cy"]+3], fill=(255, 80, 150, 100))

        # 当前行（亮）+ 粉色高亮框
        current = stocks[i]
        draw_pink_highlight(d, current, color=(255, 60, 150, 80))
        draw_tech_spider_leg(d, bx, by, current["cx"], current["cy"], color=(0, 220, 255, 255), width=2)
        # 腿尖亮粉
        for r, a in [(10, 60), (7, 120), (4, 220), (2, 255)]:
            d.ellipse([current["cx"]-r, current["cy"]-r, current["cx"]+r, current["cy"]+r], fill=(255, 80, 150, a))

        # 蜘蛛身体
        draw_tech_spider_body(d, bx, by, size=10)

        if font:
            d.text((current["cx"] + 12, current["cy"] - 8), f'{current["code"]} {current["price"]}',
                   fill=(255, 255, 100, 255), font=font)

        # 顶部状态栏
        d.rectangle([0, 0, W, 40], fill=(0, 0, 0, 200))
        if font_big:
            d.text((15, 8), f"🕷 爬虫机器人  -  扫描第 {i+1}/{len(stocks)} 行  {current['code']} {current['price']}",
                   fill=(0, 220, 255, 255), font=font_big)

        frames.append(frame)

    # 最后多留几帧
    for _ in range(6):
        frames.append(frames[-1])

    gif_path = SHOT_DIR / "spider_tech_crawl.gif"
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
