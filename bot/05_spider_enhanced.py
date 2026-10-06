# -*- coding: utf-8 -*-
"""
真・外部爬虫机器人 - 蜘蛛效果增强版
==================================
参考维基百科蜘蛛图改进：
  - 蜘蛛身体：头胸部 + 腹部（两个圆）
  - 蜘蛛腿：8 条，每条有 2-3 个关节弯曲
  - 腿尖：粉色发光点（多层光晕）
  - 整体效果：像一只真的蜘蛛趴在页面上
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
        })
    rows.sort(key=lambda r: r["cy"])
    return rows

def draw_spider_leg(draw, bx, by, tx, ty, color=(0, 200, 255, 200), width=2):
    """
    画一条蜘蛛腿（有 2 个关节弯曲）：
    身体 → 膝盖1 → 膝盖2 → 脚尖
    """
    # 计算两个关节点
    dx = tx - bx
    dy = ty - by
    # 关节1：身体往外一点
    k1x = bx + dx * 0.3
    k1y = by + dy * 0.3 - 15  # 往上弯
    # 关节2：再往外一点
    k2x = bx + dx * 0.7
    k2y = by + dy * 0.7 + 10  # 再往下弯

    # 画三段腿
    draw.line([bx, by, k1x, k1y], fill=color, width=width)
    draw.line([k1x, k1y, k2x, k2y], fill=color, width=width)
    draw.line([k2x, k2y, tx, ty], fill=color, width=width)

    # 关节小圆点
    r = 2
    draw.ellipse([k1x-r, k1y-r, k1x+r, k1y+r], fill=color)
    draw.ellipse([k2x-r, k2y-r, k2x+r, k2y+r], fill=color)

def draw_spider(draw, bx, by, target_points, font=None):
    """
    画完整的蜘蛛：
      - 身体：头胸部 + 腹部
      - 8 条腿（左右各 4）
      - 腿尖：粉色发光点
    """
    # ===== 蜘蛛身体 =====
    # 腹部（后面那个大圆）
    for r, a in [(18, 30), (14, 60), (10, 120), (8, 200)]:
        draw.ellipse([bx-r, by-r+5, bx+r, by+r+5], fill=(0, 180, 230, a))
    # 头胸部（前面那个小圆）
    draw.ellipse([bx-6, by-10, bx+6, by+2], fill=(80, 220, 255, 255))
    # 身体高光
    draw.ellipse([bx-3, by-8, bx+1, by-2], fill=(200, 250, 255, 200))

    # ===== 蜘蛛腿 =====
    # 8 条腿，左右各 4 条，分别连到不同的目标点
    n = min(len(target_points), 8)
    for i in range(n):
        pt = target_points[i]
        tx, ty = pt["cx"], pt["cy"]
        # 根据位置调整腿的弯曲方向
        side = -1 if tx < bx else 1
        color = (0, 200, 255, 180)
        draw_spider_leg(draw, bx, by, tx, ty, color=color, width=2)

        # ===== 腿尖发光点（粉色） =====
        for r, a in [(10, 40), (7, 80), (4, 160), (2.5, 255)]:
            draw.ellipse([tx-r, ty-r, tx+r, ty+r], fill=(255, 80, 140, a))

        # 标注文字
        if font:
            label = f'{pt["code"]} {pt["price"]}'
            draw.text((tx + 12, ty - 8), label, fill=(255, 255, 100, 230), font=font)

def main():
    print("=" * 50)
    print("  增强版蜘蛛机器人")
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

    print("\n[3/3] 生成增强版蜘蛛图...")
    canvas = img.copy()
    draw = ImageDraw.Draw(canvas, "RGBA")

    try:
        font = ImageFont.truetype(r"C:\Windows\Fonts\msyh.ttc", 14)
    except:
        font = None

    # 蜘蛛身体在中间偏上
    bx = W * 0.45
    by = H * 0.35

    draw_spider(draw, bx, by, stocks, font)

    out_path = SHOT_DIR / "spider_enhanced.png"
    canvas.save(out_path)
    print(f"      已保存: {out_path.name}")

    # ===== 生成动画：蜘蛛从左上角爬过来 =====
    print("\n生成爬行动画...")
    frames = []
    # 阶段1：蜘蛛从左上角慢慢爬到中心位置
    for step in range(8):
        bx = W * (0.1 + 0.35 * step / 8)
        by = H * (0.15 + 0.2 * step / 8)
        frame = img.copy()
        d = ImageDraw.Draw(frame, "RGBA")
        draw_spider(d, bx, by, stocks, font)
        frames.append(frame)

    # 阶段2：在中心停住，逐行扫描
    for i in range(len(stocks)):
        # 当前行高亮，其他行暗一点
        frame = img.copy()
        d = ImageDraw.Draw(frame, "RGBA")
        bx, by = W * 0.45, H * 0.35

        # 画其他行（暗）
        for j, pt in enumerate(stocks):
            if j == i:
                continue
            draw_spider_leg(d, bx, by, pt["cx"], pt["cy"], color=(0, 100, 130, 80), width=1)
            d.ellipse([pt["cx"]-3, pt["cy"]-3, pt["cx"]+3, pt["cy"]+3], fill=(180, 60, 90, 100))

        # 画当前行（亮）
        current = stocks[i]
        draw_spider_leg(d, bx, by, current["cx"], current["cy"], color=(0, 255, 255, 255), width=3)
        for r, a in [(14, 60), (10, 120), (6, 200), (4, 255)]:
            d.ellipse([current["cx"]-r, current["cy"]-r, current["cx"]+r, current["cy"]+r], fill=(255, 100, 160, a))
        if font:
            d.text((current["cx"] + 12, current["cy"] - 8), f'{current["code"]} {current["price"]}', fill=(255, 255, 100, 255), font=font)

        # 画蜘蛛身体
        for r, a in [(18, 30), (14, 60), (10, 120), (8, 200)]:
            d.ellipse([bx-r, by-r+5, bx+r, by+r+5], fill=(0, 180, 230, a))
        d.ellipse([bx-6, by-10, bx+6, by+2], fill=(80, 220, 255, 255))

        frames.append(frame)

    # 最后多留几帧
    for _ in range(6):
        frames.append(frames[-1])

    gif_path = SHOT_DIR / "spider_enhanced_crawl.gif"
    frames[0].save(
        gif_path,
        save_all=True,
        append_images=frames[1:],
        duration=500,
        loop=0,
        disposal=2,
    )
    print(f"      动画已保存: {gif_path.name}")
    print("\n完成！")

if __name__ == "__main__":
    main()
