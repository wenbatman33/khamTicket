from PIL import Image, ImageDraw

RED   = (200, 16, 46, 255)      # 寬宏紅 #c8102e
WHITE = (255, 255, 255, 255)
CLEAR = (0, 0, 0, 0)
SS = 4                           # 超取樣倍率，換取抗鋸齒


def draw_icon(level='full'):
    """full  ：傾斜票 + 撕線 + 細閃電，給 48px 以上
       simple：正放的票 + 粗閃電，無撕線，給 32px
       tiny  ：只留票形，16px 放不下第二個元素"""
    detail = (level == 'full')
    S = 512 * SS
    base = Image.new('RGBA', (S, S), CLEAR)
    ImageDraw.Draw(base).rounded_rectangle((0, 0, S - 1, S - 1), radius=112 * SS, fill=RED)

    TW, TH = 420 * SS, 320 * SS
    cx, cy = TW // 2, TH // 2
    tk = Image.new('RGBA', (TW, TH), CLEAR)
    t = ImageDraw.Draw(tk)

    if level == 'full':
        hw, hh, notch, radius = 160, 104, 38, 26
    elif level == 'simple':
        hw, hh, notch, radius = 176, 116, 46, 30      # 票放大、缺口加大，縮圖後才看得出來
    else:
        hw, hh, notch, radius = 196, 132, 58, 34      # 16px：票再放大，缺口要夠深才咬得出形狀

    t.rounded_rectangle((cx - hw * SS, cy - hh * SS, cx + hw * SS, cy + hh * SS),
                        radius=radius * SS, fill=WHITE)

    # 左右撕票缺口：挖成透明
    for ox in (-hw, hw):
        r = notch * SS
        ex, ey = cx + ox * SS, cy
        t.ellipse((ex - r, ey - r, ex + r, ey + r), fill=CLEAR)

    if detail:
        # 撕線（垂直虛線）
        lx = cx + 58 * SS
        seg, gap, w = 16 * SS, 20 * SS, 9 * SS
        y = cy - 74 * SS
        while y < cy + 74 * SS:
            y2 = min(y + seg, cy + 74 * SS)
            t.rounded_rectangle((lx - w // 2, y, lx + w // 2, y2), radius=w // 2, fill=RED)
            y += seg + gap
        bolt = [(-14, -72), (-96, 14), (-34, 14), (-52, 76), (30, -12), (-32, -12)]
    else:
        # 簡化版：一道置中的粗閃電，縮到 16px 仍看得出形狀
        bolt = [(34, -84), (-74, 16), (-8, 16), (-34, 84), (74, -16), (8, -16)]

    if level != 'tiny':
        t.polygon([(cx + x * SS, cy + y * SS) for x, y in bolt], fill=RED)

    if detail:
        tk = tk.rotate(10, resample=Image.BICUBIC, expand=False)
    base.alpha_composite(tk, ((S - TW) // 2, (S - TH) // 2))
    return base.resize((512, 512), Image.LANCZOS)


full = draw_icon('full')
full.save('icon_master.png')
for n in (128, 48):
    full.resize((n, n), Image.LANCZOS).save(f'icon{n}.png')
draw_icon('simple').resize((32, 32), Image.LANCZOS).save('icon32.png')
draw_icon('tiny').resize((16, 16), Image.LANCZOS).save('icon16.png')
print('done')
