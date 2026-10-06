# -*- coding: utf-8 -*-
"""
真实版蜘蛛机器人 - 画一只逼真的蜘蛛
====================================
特点：
  - 真实蜘蛛外形：头胸部 + 腹部 + 8 条腿 + 眼睛
  - 深棕色身体，带阴影渐变
  - 腿自然弯曲，有关节
  - 腿尖连到各个股票点，发光
"""
from __future__ import annotations

import re
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageFilter

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

def draw_real_spider(draw, cx, cy, scale=1.0, color=(60, 40, 30, 255)):
    """
    画一只真实的蜘蛛：
      - 腹部（后面大圆）
      - 头胸部（前面小圆）
      - 8 条腿（左右各 4 条）
      - 眼睛（2 只）
    """
    s = scale

    # ===== 8 条腿（左右各 4 条） =====
    # 每条腿：从身体伸出去，有 3 个关节
    leg_color = (50, 35, 25, 220)
    leg_width = max(2, int(3 * s))

    for side in [-1, 1]:  # 左/右
        for i in range(4):  # 每条侧 4 条腿
            # 腿的起点（身体边缘）
            start_x = cx + side * 10 * s
            start_y = cy - 15 * s + i * 10 * s

            # 腿的方向角度（往外展开）
            angle_base = -60 + i * 40  # -60, -20, 20, 60 度
            angle = math.radians(angle_base * side)

            # 关节点（3 个关节，越往外越长）
            joints = []
            jx, jy = start_x, start_y
            for j in range(4):
                length = (30 + j * 25) * s
                jx += math.cos(angle) * length
                jy += math.sin(angle) * length * 0.5  # 往下弯一点
                angle += math.radians(15 * side)  # 逐渐往外撇
                joints.append((jx, jy))

            # 画腿（从身体到脚尖）
            prev = (start_x, start_y)
            for jp in joints:
                draw.line([prev, jp], fill=leg_color, width=leg_width)
                prev = jp

    # ===== 腹部（后面大圆，深棕色） =====
    abdomen_cx = cx
    abdomen_cy = cy + 12 * s
    abdomen_r = 15 * s

    # 腹部阴影
    for r, a in [(abdomen_r+2, 30), (abdomen_r+1, 60), (abdomen_r, 200)]:
        draw.ellipse([
            abdomen_cx - r, abdomen_cy - r,
            abdomen_cx + r, abdomen_cy + r
        ], fill=(40, 25, 15, a))

    # 腹部高光
    draw.ellipse([
        abdomen_cx - abdomen_r*0.5, abdomen_cy - abdomen_r*0.6,
        abdomen_cx + abdomen_r*0.2, abdomen_cy - abdomen_r*0.2
    ], fill=(80, 55, 35, 150))

    # ===== 头胸部（前面小圆） =====
    thorax_cx = cx
    thorax_cy = cy - 8 * s
    thorax_r = 9 * s

    for r, a in [(thorax_r+1, 50), (thorax_r, 220)]:
        draw.ellipse([
            thorax_cx - r, thorax_cy - r,
            thorax_cx + r, thorax_cy + r
        ], fill=(50, 35, 25, a))

    # ===== 眼睛（2 只小黑点） =====
    eye_r = 1.5 * s
    eye_offset_x = 4 * s
    eye_offset_y = -2 * s
    draw.ellipse([
        thorax_cx - eye_offset_x - eye_r, thorax_cy + eye_offset_y - eye_r,
        thorax_cx - eye_offset_x + eye_r, thorax_cy + eye_offset_y + eye_r
    ], fill=(20, 10, 5, 255))
    draw.ellipse([
        thorax_cx + eye_offset_x - eye_r, thorax_cy + eye_offset_y - eye_r,
        thorax_cx + eye_offset_x + eye_r, thorax_cy + eye_offset_y + eye_r
    ], fill=(20, 10, 5, 255))

    # 眼睛高光
    draw.ellipse([
        thorax_cx - eye_offset_x - 0.5, thorax_cy + eye_offset_y - 0.5,
        thorax_cx - eye_offset_x + 0.5, thorax_cy + eye_offset_y + 0.5
    ], fill=(255, 255, 255, 200))

def draw_leg_to_point(draw, spider_cx, spider_cy, target_x, target_y, color=(0, 255, 180, 200)):
    """
    从蜘蛛身体伸出一条"数据腿"连到目标点（股票）
    这条腿和真蜘蛛的腿不一样，是用来表示抓取的数据的
    """
    # 起点在蜘蛛身体边缘
    dx = target_x - spider_cx
    dy = target_y - spider_cy
    dist = math.sqrt(dx*dx + dy*dy)
    if dist < 1:
        return

    # 从蜘蛛身体边缘开始
    start_x = spider_cx + dx * 15 / dist
    start_y = spider_cy + dy * 15 / dist

    # 弯曲的腿（2 个关节）
    mid1_x = start_x + dx * 0.3
    mid1_y = start_y + dy * 0.3 - 20
    mid2_x = start_x + dx * 0.7
    mid2_y = start_y + dy * 0.7 + 15

    draw.line([start_x, start_y, mid1_x, mid1_y], fill=color, width=2)
    draw.line([mid1_x, mid1_y, mid2_x, mid2_y], fill=color, width=2)
    draw.line([mid2_x, mid2_y, target_x, target_y], fill=color, width=2)

    # 腿尖光点（绿色发光）
    for r, a in [(8, 40), (5, 100), (3, 200), (2, 255)]:
        draw.ellipse([
            target_x - r, target_y - r,
            target_x + r, target_y + r
        ], fill=(0, 255, 180, a))

def main():
    print("=" * 50)
    print("  真实版蜘蛛机器人")
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

    print("\n[3/3] 生成真实蜘蛛图...")
    canvas = img.copy()
    draw = ImageDraw.Draw(canvas, "RGBA")

    # 蜘蛛位置（中间偏上）
    bx, by = W * 0.45, H * 0.35

    # 先画"数据腿"（从蜘蛛连到股票）
    for pt in stocks:
        draw_leg_to_point(draw, bx, by, pt["cx"], pt["cy"])

    # 再画真蜘蛛（盖在腿上面）
    draw_real_spider(draw, bx, by, scale=1.5)

    # 标注文字
    for pt in stocks:
        if font:
            draw.text((pt["cx"] + 12, pt["cy"] - 8), f'{pt["code"]} {pt["price"]}',
                      fill=(255, 255, 100, 230), font=font)

    out_path = SHOT_DIR / "spider_real.png"
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
            draw_leg_to_point(d, bx, by, pt["cx"], pt["cy"], color=(0, 180, 130, 100))
        draw_real_spider(d, bx, by, scale=1.5)
        frames.append(frame)

    # 阶段2：逐行扫描
    for i in range(len(stocks)):
        frame = img.copy()
        d = ImageDraw.Draw(frame, "RGBA")
        bx, by = W * 0.45, H * 0.35

        # 其他行（暗）
        for j, pt in enumerate(stocks):
            if j == i:
                continue
            draw_leg_to_point(d, bx, by, pt["cx"], pt["cy"], color=(0, 120, 80, 80))

        # 当前行（亮）+ 高亮框
        current = stocks[i]
        # 高亮框
        x0 = current["x"] - 10
        y0 = current["y"] - 5
        x1 = current["x"] + current["w"] + 100
        y1 = current["y"] + current["h"] + 5
        d.rectangle([x0, y0, x1, y1], outline=(255, 60, 80, 200), width=2)
        d.rectangle([x0, y0, x1, y1], fill=(255, 60, 80, 60))

        draw_leg_to_point(d, bx, by, current["cx"], current["cy"], color=(0, 255, 180, 255))

        # 真蜘蛛
        draw_real_spider(d, bx, by, scale=1.5)

        if font:
            d.text((current["cx"] + 12, current["cy"] - 8), f'{current["code"]} {current["price"]}',
                   fill=(255, 255, 100, 255), font=font)

        # 顶部状态栏
        d.rectangle([0, 0, W, 40], fill=(0, 0, 0, 200))
        if font_big:
            d.text((15, 8), f"🕷 爬虫机器人  -  扫描第 {i+1}/{len(stocks)} 行  {current['code']} {current['price']}",
                   fill=(0, 255, 180, 255), font=font_big)

        frames.append(frame)

    # 最后多留几帧
    for _ in range(6):
        frames.append(frames[-1])

    gif_path = SHOT_DIR / "spider_real_crawl.gif"
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
