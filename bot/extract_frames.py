import cv2
import os

video = r"C:\Users\Administrator\Desktop\QQ20261006-191856.mp4"
out_dir = r"D:\Doubao-pek\股票盯盘系统·灵动岛版\bot\screenshots\video_frames"
os.makedirs(out_dir, exist_ok=True)

cap = cv2.VideoCapture(video)
total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
fps = cap.get(cv2.CAP_PROP_FPS)
print(f"总帧数: {total}, FPS: {fps:.1f}, 时长: {total/fps:.1f}s")

# 均匀抽 6 帧
step = max(1, total // 6)
for i in range(6):
    idx = i * step
    cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
    ret, frame = cap.read()
    if ret:
        path = os.path.join(out_dir, f"frame_{i:02d}.png")
        cv2.imwrite(path, frame)
        print(f"保存: {path}")
    else:
        print(f"帧 {idx} 读取失败")

cap.release()
print("完成")
