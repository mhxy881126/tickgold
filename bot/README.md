# TickGold 自动盯盘机器人 - 最小原型

目标：锁定 TickGold Island 窗口 → 截屏 → OCR 读出行情 → 画出"蜘蛛爬取"标注。

## 安装依赖（在本目录下执行）

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

> 注：OCR 依赖 `rapidocr-onnxruntime`，首次运行会自动下载模型（约 10~15MB）。
> 如果 Python 3.14 装不上 onnxruntime，可退化为"只截屏+标注"模式（脚本会自动跳过 OCR 不崩溃）。

## 运行

```powershell
python 01_lock_screenshot_ocr.py
```

运行前请：
1. 先把 TickGold Island 窗口**摆到屏幕上、行情列表可见**（不要最小化）。
2. 脚本会自动把它提到前台，截一张图，OCR 识别后打印行情表，并在截图上画出蜘蛛爬取轨迹。

## 输出

- `screenshots/raw_*.png`：原始截屏
- `screenshots/annotated_*.png`：带蜘蛛标注的截屏（你要的"爬取标记沿页面移动"效果的静态定格）
- 控制台：识别出的股票行情表

## 下一步（后续原型）

- 02：循环截屏（每 2 秒一次），蜘蛛真的在屏幕上**实时游走**（透明 PyQt 叠加层）
- 03：通过 CDP 9222 端口直连 DOM，跳过 OCR，直接读 Pinia store 里的行情（精准 10 倍）
- 04：筛选规则 + 自动下单
