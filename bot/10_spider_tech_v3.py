# -*- coding: utf-8 -*-
"""
科技感蜘蛛爬虫 v3 - 优化版
=========================
调整：
  - 腿减少到 10 个（选最重要的点）
  - 动画更顺畅：增加中间帧，蜘蛛平滑移动
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
    """科技感蜘蛛腿：多关节折线"""
    dx = tx - bx
    dy = ty - by
    dist = math.sqrt(dx*dx + dy*dy)
    if dist < 1:
        return

    points = [(bx, by)]
    for i in range(1, 5):
        t = i / 5
        px = bx + dx * t
        py = by + dy * t
        offset = math.sin(t * math.pi) * bend * (1 if i % 2 == 0 else -1)
        nx = -dy / dist
        ny = dx / dist
        px += nx * offset
        py += ny * offset
        points.append((px, py))
    points.append((tx, ty))

    for i in range(len(points) - 1):
        draw.line([points[i], points[i+1]], fill=color, width=width)

    r = 2
    for p in points[1:-1]:
        draw.ellipse([p[0]-r, p[1]-r, p[0]+r, p[1]+r], fill=color)

def draw_tech_spider_body(draw, bx, by, size=16):
    """科技感蜘蛛身体：蓝色方块 + 发光"""
    for r, a in [(size+15, 20), (size+10, 40), (size+5, 80)]:
        draw.ellipse([bx-r, by-r, bx+r, by+r], fill=(0, 150, 255, a))
    draw.rectangle([bx-size, by-size, bx+size, by+size], fill=(0, 100, 255, 220))
    draw.rectangle([bx-size+2, by-size+2, bx+size-2, by+size-2], fill=(50, 180, 255, 255))
    draw.ellipse([bx-3, by-3, bx+3, by+3], fill=(255, 255, 255, 255))

def draw_pink_highlight(draw, row, color=(255, 60, 150, 100)):
    """粉红色高亮长条"""
    x0 = row["x"] - 10
    y0 = row["y"] - 5
    x1 = row["x"] + row["w"] + 150
    y1 = row["y"] + row["h"] + 5
    draw.rectangle([x0, y0, x1, y1], fill=color)
    draw.rectangle([x0, y0, x1, y1], outline=(255, 100, 180, 200), width=1)

def select_target_points(all_blocks, stocks, max_count=10):
    """选最重要的 10 个点"""
    points = []

    # 1. 所有股票（6 只）
    for s in stocks:
        points.append({"cx": s["cx"], "cy": s["cy"], "type": "stock"})

    # 2. 顶部 2 个指数（上证指数 + 沪深300）
    for b in all_blocks:
        if b["cy"] < all_blocks[0]["cy"] + 30 and len(points) < max_count:
            points.append({"cx": b["cx"], "cy": b["cy"], "type": "index"})

    # 3. 右边五档盘口 2 个价格
    for b in all_blocks:
        if b["cx"] > 1000 and b["cy"] > 300 and b["cy"] < 500 and len(points) < max_count:
            points.append({"cx": b["cx"], "cy": b["cy"], "type": "price"})

    return points[:max_count]

def make_frame(img, bx, by, target_points, current_stock=None, stocks=[], font=None, font_big=None, W=0, H=0):
    """生成一帧"""
    frame = img.copy()
    draw = ImageDraw.Draw(frame, "RGBA")

    # 画所有腿（暗）
    for pt in target_points:
        is_current = current_stock and abs(pt["cx"] - current_stock["cx"]) < 5
        if is_current:
            color = (0, 220, 255, 255)
            width = 2
        else:
            color = (0, 150, 200, 100)
            width = 1
        draw_tech_spider_leg(draw, bx, by, pt["cx"], pt["cy"], color=color, width=width, bend=40)

        # 腿尖光点
        if is_current:
            for r, a in [(10, 60), (7, 120), (4, 220), (2, 255)]:
                draw.ellipse([pt["cx"]-r, pt["cy"]-r, pt["cx"]+r, pt["cy"]+r], fill=(255, 80, 150, a))
        else:
            for r, a in [(5, 30), (3, 80), (2, 180)]:
                draw.ellipse([pt["cx"]-r, pt["cy"]-r, pt["cx"]+r, pt["cy"]+r], fill=(255, 80, 150, a))

    # 当前股票高亮框
    if current_stock:
        draw_pink_highlight(draw, current_stock, color=(255, 60, 150, 80))

    # 蜘蛛身体
    draw_tech_spider_body(draw, bx, by, size=16)

    # 标注股票
    for s in stocks:
        if font:
            draw.text((s["cx"] + 12, s["cy"] - 8), f'{s["code"]} {s["price"]}',
                      fill=(255, 255, 100, 230), font=font)

    # 顶部状态栏
    if current_stock and font_big:
        draw.rectangle([0, 0, W, 40], fill=(0, 0, 0, 200))
        draw.text((15, 8), f"🕷 爬虫机器人  -  {current_stock['code']} {current_stock['price']}",
                  fill=(0, 220, 255, 255), font=font_big)

    return frame

def main():
    print("=" * 50)
    print("  科技感蜘蛛 v3 - 优化版")
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
    target_points = select_target_points(all_blocks, stocks, max_count=10)
    print(f"      {len(stocks)} 只股票，选了 {len(target_points)} 个连接点")

    if not stocks:
        print("[ERR] 没识别到股票")
        return

    try:
        font = ImageFont.truetype(r"C:\Windows\Fonts\msyh.ttc", 14)
        font_big = ImageFont.truetype(r"C:\Windows\Fonts\msyh.ttc", 20)
    except:
        font = None
        font_big = None

    print("\n[3/3] 生成动画（顺畅版）...")
    frames = []

    # 阶段1：蜘蛛从左上角平滑爬到中心（插值，更顺畅）
    start_bx, start_by = W * 0.1, H * 0.15
    end_bx, end_by = W * 0.45, H * 0.35
    for step in range(15):  # 15 帧，更平滑
        t = step / 14
        # 缓动函数（先慢后快再慢）
        ease = t * t * (3 - 2 * t)  # smoothstep
        bx = start_bx + (end_bx - start_bx) * ease
        by = start_by + (end_by - start_by) * ease
        frame = make_frame(img, bx, by, target_points, font=font, font_big=font_big, W=W, H=H)
        frames.append(frame)

    # 阶段2：逐行扫描（蜘蛛从当前行移到下一行，平滑移动）
    current_bx, current_by = end_bx, end_by
    for i in range(len(stocks)):
        target_stock = stocks[i]
        # 蜘蛛稍微向当前股票方向移动一点
        target_bx = current_bx + (target_stock["cx"] - current_bx) * 0.15
        target_by = current_by + (target_stock["cy"] - current_by) * 0.15

        # 插值移动（5 帧，顺畅）
        for step in range(5):
            t = step / 4
            ease = t * t * (3 - 2 * t)
            bx = current_bx + (target_bx - current_bx) * ease
            by = current_by + (target_by - current_by) * ease
            frame = make_frame(img, bx, by, target_points,
                             current_stock=target_stock, stocks=stocks,
                             font=font, font_big=font_big, W=W, H=H)
            frames.append(frame)

        current_bx, current_by = target_bx, target_by

    # 最后多留几帧
    for _ in range(10):
        frames.append(frames[-1])

    gif_path = SHOT_DIR / "spider_tech_v3_crawl.gif"
    frames[0].save(
        gif_path,
        save_all=True,
        append_images=frames[1:],
        duration=80,  # 每帧 80ms，更顺畅
        loop=0,
        disposal=2,
    )
    print(f"      动画: {gif_path.name}")
    print(f"      总帧数: {len(frames)}")
    print("\n完成！")

if __name__ == "__main__":
    main()
