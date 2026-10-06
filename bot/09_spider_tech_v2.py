# -*- coding: utf-8 -*-
"""
科技感蜘蛛爬虫 v2 - 调整版
=========================
调整：
  - 腿更密：连所有 OCR 识别到的文字块（不只股票）
  - 腿弯曲更大：偏移量加大
  - 身体更大：方块加大 + 发光更明显
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

def draw_tech_spider_leg(draw, bx, by, tx, ty, color=(0, 200, 255, 200), width=2, bend=40):
    """
    科技感蜘蛛腿：多关节折线
    bend: 弯曲幅度（越大越弯）
    """
    dx = tx - bx
    dy = ty - by
    dist = math.sqrt(dx*dx + dy*dy)
    if dist < 1:
        return

    # 生成 5 个中间点（更弯曲）
    points = [(bx, by)]
    for i in range(1, 6):
        t = i / 6
        px = bx + dx * t
        py = by + dy * t
        # 加一点垂直偏移，让腿弯弯曲曲（更大幅度）
        offset = math.sin(t * math.pi) * bend * (1 if i % 2 == 0 else -1)
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

def draw_tech_spider_body(draw, bx, by, size=18):
    """科技感蜘蛛身体：更大的蓝色方块 + 发光"""
    # 外发光（更大范围）
    for r, a in [(size+20, 15), (size+14, 30), (size+8, 60), (size+4, 100)]:
        draw.ellipse([bx-r, by-r, bx+r, by+r], fill=(0, 150, 255, a))
    # 方块本体（更大）
    draw.rectangle([bx-size, by-size, bx+size, by+size], fill=(0, 100, 255, 220))
    draw.rectangle([bx-size+3, by-size+3, bx+size-3, by+size-3], fill=(50, 180, 255, 255))
    # 中心点（更大）
    draw.ellipse([bx-4, by-4, bx+4, by+4], fill=(255, 255, 255, 255))

def draw_pink_highlight(draw, row, color=(255, 60, 150, 100)):
    """粉红色高亮长条"""
    x0 = row["x"] - 10
    y0 = row["y"] - 5
    x1 = row["x"] + row["w"] + 150
    y1 = row["y"] + row["h"] + 5
    draw.rectangle([x0, y0, x1, y1], fill=color)
    draw.rectangle([x0, y0, x1, y1], outline=(255, 100, 180, 200), width=1)

def main():
    print("=" * 50)
    print("  科技感蜘蛛 v2 - 调整版")
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
    all_blocks = ocr_all(img)
    stocks = find_stock_rows(all_blocks)
    print(f"      识别到 {len(stocks)} 只自选股")
    print(f"      总共 {len(all_blocks)} 个文字块")

    if not stocks:
        print("[ERR] 没识别到股票")
        return

    # 选择要连接的点：股票 + 一些重要的文字块（顶部指数、五档盘口）
    # 让腿更密
    target_points = []
    # 1. 所有股票代码
    for s in stocks:
        target_points.append({"cx": s["cx"], "cy": s["cy"], "type": "stock"})
    # 2. 顶部指数（找几个关键的）
    for b in all_blocks:
        if b["cy"] < H * 0.1:  # 顶部区域
            target_points.append({"cx": b["cx"], "cy": b["cy"], "type": "index"})
    # 3. 五档盘口的价格（右边区域）
    for b in all_blocks:
        if b["cx"] > W * 0.6 and b["cy"] > H * 0.2 and b["cy"] < H * 0.6:
            target_points.append({"cx": b["cx"], "cy": b["cy"], "type": "price"})

    print(f"      连接 {len(target_points)} 个点（腿更密）")

    try:
        font = ImageFont.truetype(r"C:\Windows\Fonts\msyh.ttc", 14)
        font_big = ImageFont.truetype(r"C:\Windows\Fonts\msyh.ttc", 20)
    except:
        font = None
        font_big = None

    print("\n[3/3] 生成调整版蜘蛛图...")
    canvas = img.copy()
    draw = ImageDraw.Draw(canvas, "RGBA")

    bx, by = W * 0.45, H * 0.35

    # 画所有腿（暗一点，更密）
    for pt in target_points:
        draw_tech_spider_leg(draw, bx, by, pt["cx"], pt["cy"],
                            color=(0, 150, 200, 80), width=1, bend=45)
        # 腿尖粉色光点
        for r, a in [(5, 30), (3, 80), (2, 180)]:
            draw.ellipse([pt["cx"]-r, pt["cy"]-r, pt["cx"]+r, pt["cy"]+r],
                        fill=(255, 80, 150, a))

    # 蜘蛛身体（更大）
    draw_tech_spider_body(draw, bx, by, size=18)

    # 标注股票
    for s in stocks:
        if font:
            draw.text((s["cx"] + 12, s["cy"] - 8), f'{s["code"]} {s["price"]}',
                      fill=(255, 255, 100, 230), font=font)

    out_path = SHOT_DIR / "spider_tech_v2.png"
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
        for pt in target_points:
            draw_tech_spider_leg(d, bx, by, pt["cx"], pt["cy"],
                                color=(0, 150, 200, 60), width=1, bend=45)
            d.ellipse([pt["cx"]-2, pt["cy"]-2, pt["cx"]+2, pt["cy"]+2],
                     fill=(255, 80, 150, 120))
        draw_tech_spider_body(d, bx, by, size=18)
        frames.append(frame)

    # 阶段2：逐行扫描股票
    for i in range(len(stocks)):
        frame = img.copy()
        d = ImageDraw.Draw(frame, "RGBA")
        bx, by = W * 0.45, H * 0.35

        # 所有腿（暗）
        for pt in target_points:
            draw_tech_spider_leg(d, bx, by, pt["cx"], pt["cy"],
                                color=(0, 120, 160, 50), width=1, bend=45)
            d.ellipse([pt["cx"]-2, pt["cy"]-2, pt["cx"]+2, pt["cy"]+2],
                     fill=(255, 80, 150, 80))

        # 当前股票行（亮）+ 粉色高亮框
        current = stocks[i]
        draw_pink_highlight(d, current, color=(255, 60, 150, 80))
        draw_tech_spider_leg(d, bx, by, current["cx"], current["cy"],
                            color=(0, 220, 255, 255), width=2, bend=45)
        # 腿尖亮粉
        for r, a in [(10, 60), (7, 120), (4, 220), (2, 255)]:
            d.ellipse([current["cx"]-r, current["cy"]-r, current["cx"]+r, current["cy"]+r],
                     fill=(255, 80, 150, a))

        # 蜘蛛身体（更大）
        draw_tech_spider_body(d, bx, by, size=18)

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

    gif_path = SHOT_DIR / "spider_tech_v2_crawl.gif"
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
