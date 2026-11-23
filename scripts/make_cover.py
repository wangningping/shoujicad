"""生成公众号封面图（900x383）。用法：python scripts/make_cover.py"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "screenshots" / "封面.png"
SHOT = ROOT / "screenshots" / "浅色看图.png"

W, H = 900, 383
BG = "#F5F7FA"
CARD = "#FFFFFF"
INK = "#1F2937"
BLUE = "#2563EB"
MUTED = "#6B7280"

BOLD = "C:/Windows/Fonts/msyhbd.ttc"
REGULAR = "C:/Windows/Fonts/msyh.ttc"


def main() -> None:
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    # 右侧白色圆角卡片 + 真机截图（不放阴影、不加设备边框）
    d.rounded_rectangle((690, 16, 882, 367), radius=14, fill=CARD)
    with Image.open(SHOT) as raw:
        shot = raw.convert("RGB")
        target_h = 330
        target_w = round(shot.width * target_h / shot.height)
        shot = shot.resize((target_w, target_h), Image.Resampling.LANCZOS)
        img.paste(shot, (690 + (192 - target_w) // 2, 26))

    # 左侧文字
    d.rounded_rectangle((56, 72, 100, 76), radius=2, fill=BLUE)

    f_title = ImageFont.truetype(BOLD, 44)
    f_sub = ImageFont.truetype(REGULAR, 19)
    f_note = ImageFont.truetype(REGULAR, 16)

    d.text((56, 98), "手机上也能看", font=f_title, fill=INK)
    d.text((56, 158), "DWG 了", font=f_title, fill=INK)
    d.text((56, 240), "纯前端 · 可离线 · 只看图", font=f_sub, fill=BLUE)
    d.text((56, 288), "DXF / DWG 移动端查看器", font=f_note, fill=MUTED)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    img.save(OUT, optimize=True)
    print(f"已生成 {OUT} ({img.width}x{img.height})")


if __name__ == "__main__":
    main()
