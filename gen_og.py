"""OGP画像生成: 1200x630 PNG (og.png)
実行: python gen_og.py
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).parent
W, H = 1200, 630
OUT = ROOT / "og.png"

# ----- 背景: 紫グラデーション -----
img = Image.new("RGB", (W, H))
top = (79, 70, 229)        # brand-600 #4f46e5
bottom = (124, 58, 237)    # violet-600 #7c3aed
for y in range(H):
    ratio = y / H
    r = int(top[0] * (1 - ratio) + bottom[0] * ratio)
    g = int(top[1] * (1 - ratio) + bottom[1] * ratio)
    b = int(top[2] * (1 - ratio) + bottom[2] * ratio)
    for x in range(W):
        img.putpixel((x, y), (r, g, b))

# ----- 装飾円 (decorative blobs) -----
draw = ImageDraw.Draw(img, "RGBA")
draw.ellipse((900, -100, 1300, 300), fill=(255, 255, 255, 25))
draw.ellipse((-100, 400, 350, 750), fill=(255, 255, 255, 18))

# ----- ロゴアイコン 円角四角 + S -----
logo_x, logo_y, logo_size = 80, 80, 90
draw.rounded_rectangle((logo_x, logo_y, logo_x + logo_size, logo_y + logo_size), radius=22, fill=(255, 255, 255))

def find_jp_font(size):
    candidates = [
        "C:/Windows/Fonts/YuGothB.ttc",
        "C:/Windows/Fonts/meiryob.ttc",
        "C:/Windows/Fonts/meiryo.ttc",
        "C:/Windows/Fonts/yugothic.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVu-Sans-Bold.ttf",
    ]
    for c in candidates:
        try:
            return ImageFont.truetype(c, size)
        except Exception:
            continue
    return ImageFont.load_default()

font_logo = find_jp_font(60)
font_brand = find_jp_font(46)
font_h1 = find_jp_font(78)
font_sub = find_jp_font(34)
font_url = find_jp_font(26)
font_tag = find_jp_font(22)

# ロゴ内 "S"
bbox = draw.textbbox((0, 0), "S", font=font_logo)
sw = bbox[2] - bbox[0]
sh = bbox[3] - bbox[1]
draw.text(
    (logo_x + (logo_size - sw) / 2 - bbox[0], logo_y + (logo_size - sh) / 2 - bbox[1]),
    "S",
    fill=(79, 70, 229),
    font=font_logo,
)

# ブランド名
draw.text((logo_x + logo_size + 24, logo_y + 20), "Shifty", fill=(255, 255, 255), font=font_brand)

# ----- メインコピー -----
draw.text((80, 230), "飲食店のシフト作成、", fill=(255, 255, 255), font=font_h1)
draw.text((80, 320), "AI で 5 分。", fill=(255, 255, 255), font=font_h1)

# サブコピー
draw.text((80, 440), "希望収集 → AI生成 → 確定通知 まで完全自動化。", fill=(230, 230, 250), font=font_sub)

# タグ
draw.rounded_rectangle((80, 510, 220, 555), radius=8, fill=(255, 255, 255, 50))
draw.text((100, 518), "AI 最適化", fill=(255, 255, 255), font=font_tag)
draw.rounded_rectangle((240, 510, 410, 555), radius=8, fill=(255, 255, 255, 50))
draw.text((260, 518), "14日間無料", fill=(255, 255, 255), font=font_tag)
draw.rounded_rectangle((430, 510, 610, 555), radius=8, fill=(255, 255, 255, 50))
draw.text((450, 518), "クレカ不要", fill=(255, 255, 255), font=font_tag)

# URL
draw.text((80, 580), "shifty.in-dx.jp", fill=(220, 220, 240), font=font_url)

img.save(OUT, "PNG", optimize=True)
print(f"Saved {OUT} ({OUT.stat().st_size // 1024} KB)")
