# -*- coding: utf-8 -*-
"""
真・外部机器人 - 离线蜘蛛游走演示
=================================
用已有的 TickGold 截图作为输入，模拟蜘蛛逐行爬取：
  1. 加载 raw_*.png 截图
  2. OCR 识别所有自选股行
  3. 逐帧生成蜘蛛游走标注（蜘蛛从第一行爬到最后一行）
  4. 保存为 GIF 动画
"""
from __future__ import annotations

import re
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

BOT_DIR = Path(__file__).resolve().parent
SHOT_DIR = BOT_DIR / "screenshots"

# ---------- OCR ----------
CODE_RE = re.compile(r"(60\d{4}|00\d{4}|30\d{4}|68\d{4}|8\d{5}|4\d{5})")
PRICE_RE = re.compile(r"^\d{1,4}\.\d{2}$")
WATCHLIST_Y_MIN = 500

def ocr_rows(img):
    import numpy as np
    from rapidocr_onnxruntime import RapidOCR
    ocr = RapidOCR()
    result, _ = ocr(np.array(img))
    if not result:
        return []
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

# ---------- 画单帧 ----------
def draw_frame(img, rows, step):
    """step: 0..len(rows)-1，蜘蛛当前爬到第几步"""
    canvas = img.copy()
    draw = ImageDraw.Draw(canvas, "RGBA")
    try:
        font = ImageFont.truetype(r"C:\Windows\Fonts\msyh.ttc", 16)
        font_big = ImageFont.truetype(r"C:\Windows\Fonts\msyh.ttc", 20)
    except:
        font = None
        font_big = None

    centers = []
    for i, r in enumerate(rows):
        box = r["box"]
        x0 = min(p[0] for p in box) - 6
        x1 = max(p[0] for p in box) + 6
        y0 = min(p[1] for p in box) - 3
        y1 = max(p[1] for p in box) + 3
        cx, cy = (x0+x1)/2, (y0+y1)/2
        centers.append((cx, cy))

        if i == step:
            # 当前行：亮青色框 + 发光
            draw.rectangle([x0, y0, x1, y1], outline=(0, 255, 220, 255), width=3)
            draw.rectangle([x0, y0, x1, y1], fill=(0, 255, 220, 50))
        elif i < step:
            # 已爬过：暗蓝色框
            draw.rectangle([x0, y0, x1, y1], outline=(80, 160, 255, 200), width=1)
            draw.rectangle([x0, y0, x1, y1], fill=(80, 160, 255, 20))
        else:
            # 未爬：灰色框
            draw.rectangle([x0, y0, x1, y1], outline=(120, 120, 120, 100), width=1)

        # 标注代码和价格
        if font:
            label = f'{r["code"]}  {r["price"]}'
            draw.text((x0+6, y0-18), label, fill=(255, 230, 0, 255), font=font)

    # 轨迹线：连接已爬过的行
    for i in range(min(step, len(centers)-1)):
        draw.line([centers[i], centers[i+1]], fill=(0, 255, 220, 200), width=3)

    # 蜘蛛发光点（当前行）
    if 0 <= step < len(centers):
        cx, cy = centers[step]
        # 多层发光
        for r, a in [(25, 30), (18, 60), (12, 120), (7, 200)]:
            draw.ellipse([cx-r, cy-r, cx+r, cy+r], fill=(0, 255, 220, a))
        # 蜘蛛身体
        draw.ellipse([cx-6, cy-6, cx+6, cy+6], fill=(0, 255, 220, 255))
        draw.ellipse([cx-3, cy-3, cx+3, cy+3], fill=(255, 255, 255, 255))

    # 顶部状态栏
    draw.rectangle([0, 0, img.size[0], 40], fill=(0, 0, 0, 200))
    if font_big:
        draw.text((15, 8), f"🕷 SPIDER BOT  -  正在扫描第 {step+1}/{len(rows)} 行",
                  fill=(0, 255, 220, 255), font=font_big)

    return canvas

# ---------- 主 ----------
def main():
    print(">>> 真・外部机器人 - 离线蜘蛛游走演示\n")

    # 用指定的完整主窗口截图（有自选股列表的那张）
    raw_path = SHOT_DIR / "raw_20261006_170617.png"
    if not raw_path.exists():
        # 找不到就用最新的
        raw_files = sorted(SHOT_DIR.glob("raw_*.png"))
        if not raw_files:
            print("[ERR] 没找到 raw_*.png 截图")
            return
        raw_path = raw_files[-1]
    print(f"[OK] 使用截图: {raw_path.name}")

    img = Image.open(raw_path)
    print(f"[OK] 图片大小: {img.size}")

    # OCR 找股票行
    print("[INFO] OCR 识别股票行...")
    rows = ocr_rows(img)
    print(f"[OK] 识别到 {len(rows)} 只自选股：")
    for i, r in enumerate(rows):
        print(f"   {i+1}. {r['code']}  y={r['cy']:.0f}  price={r['price']}")

    if not rows:
        print("[ERR] 没识别到股票行")
        return

    # 生成逐帧标注
    print("\n[INFO] 生成蜘蛛游走帧...")
    frames = []
    for step in range(len(rows)):
        frame = draw_frame(img, rows, step)
        frames.append(frame)
        print(f"   帧 {step+1}/{len(rows)}")

    # 最后停在最后一行，多留几帧
    for _ in range(5):
        frames.append(draw_frame(img, rows, len(rows)-1))

    # 保存 GIF
    gif_path = SHOT_DIR / "spider_crawl.gif"
    frames[0].save(
        gif_path,
        save_all=True,
        append_images=frames[1:],
        duration=800,  # 每帧 800ms
        loop=0,
        disposal=2,
    )
    print(f"\n[OK] GIF 已保存: {gif_path}")
    print(">>> 完成！用图片查看器打开 spider_crawl.gif 看蜘蛛游走效果。")

if __name__ == "__main__":
    main()
