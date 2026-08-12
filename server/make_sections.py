#!/usr/bin/env python3
"""
Build one "where is it on the truck" image per catalogue section.

The base drawing is the truck line-art from the CTP logo (Logo Main.svg),
isolated to its navy ink and cropped — a side view of the tractor unit,
front facing LEFT. For each category we dim the whole truck and light up the
region that category lives in, so a card on the home page answers "which bit
of the lorry is this?" before anyone reads a word.

ZONES below are normalized (0-1) boxes over that drawing: (x0, y0, x1, y1),
plus an optional shape hint. They are the only thing to edit if a highlight
sits wrong — nothing else in this file knows about trucks.
"""
import os
from PIL import Image, ImageDraw, ImageFilter

MASK = "truck_mask.png"          # ink alpha, produced from Logo Main.svg
OUT = "sections"
# The canvas deliberately matches the drawing's own proportions (1083x874),
# so the truck fills its frame instead of floating in letterbox bars. The home
# page shows these two-up in near-square tiles; anything wider wasted the width.
W, H = 1080, 880
SUFFIX = "_v2"                   # bucket keys are immutable + SW-cached: a
                                 # changed image needs a NEW key, never a
                                 # silent overwrite. Bump this on every redraw.

DIM = (86, 100, 116)             # unlit line colour
HOT = (255, 138, 31)             # CTP amber — the lit region
GLOW = (255, 138, 31)

# code: (x0, y0, x1, y1, shape)   shape: "e" ellipse (default) | "r" rounded box
ZONES = {
    "BMP": (0.00, 0.68, 0.20, 0.95, "r"),   # front bumper — very front, low
    "LGT": (0.02, 0.70, 0.19, 0.88, "e"),   # headlamps — in the bumper face
    "FWL": (0.01, 0.16, 0.10, 0.64, "r"),   # front wall — leading face of the cab
    "WPR": (0.01, 0.44, 0.12, 0.57, "e"),   # wipers — base of the windscreen
    "MRR": (0.00, 0.38, 0.10, 0.60, "e"),   # mirrors — front edge of the door
    "DOR": (0.06, 0.23, 0.30, 0.64, "r"),   # front door — window + door skin
    "INT": (0.09, 0.24, 0.47, 0.60, "r"),   # cab interior — inside the box
    "CBY": (0.03, 0.02, 0.56, 0.64, "r"),   # cab body — the whole shell
    "DEF": (0.33, 0.00, 0.57, 0.10, "r"),   # roof deflector — the fin on top
    "ACU": (0.44, 0.06, 0.57, 0.48, "r"),   # a/c — rear cab wall / roof unit
    "FND": (0.14, 0.60, 0.44, 0.75, "e"),   # fender — the wheel arch
    "MUD": (0.17, 0.70, 0.47, 0.98, "e"),   # mudguard — around/behind the wheel
    "STP": (0.04, 0.66, 0.20, 0.92, "r"),   # steps & trim — under the door
    "SUS": (0.38, 0.66, 0.58, 0.83, "e"),   # cab suspension — under the cab
    "CHX": (0.45, 0.70, 0.92, 0.93, "r"),   # chassis — the frame rails
    "TBX": (0.55, 0.77, 0.75, 0.94, "r"),   # side toolbox — on the rail
}


def zone_mask(size, box, shape):
    """Soft mask for the lit region."""
    w, h = size
    x0, y0, x1, y1 = [box[0] * w, box[1] * h, box[2] * w, box[3] * h]
    m = Image.new("L", size, 0)
    d = ImageDraw.Draw(m)
    if shape == "r":
        d.rounded_rectangle([x0, y0, x1, y1], radius=min(w, h) * 0.06, fill=255)
    else:
        d.ellipse([x0, y0, x1, y1], fill=255)
    return m.filter(ImageFilter.GaussianBlur(min(w, h) * 0.018))


def tint(mask, colour, scale=1.0):
    """Colour an alpha mask."""
    layer = Image.new("RGBA", mask.size, colour + (0,))
    a = mask if scale == 1.0 else mask.point(lambda v: int(v * scale))
    layer.putalpha(a)
    return layer


def build(code, box):
    ink = Image.open(MASK).convert("L")
    # fit the drawing into the card with a little breathing room
    canvas = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    pad = 0.03
    fit = min(W * (1 - 2 * pad) / ink.width, H * (1 - 2 * pad) / ink.height)
    iw, ih = int(ink.width * fit), int(ink.height * fit)
    ink = ink.resize((iw, ih), Image.LANCZOS)
    ox, oy = (W - iw) // 2, (H - ih) // 2

    shape = box[4] if len(box) > 4 else "e"
    zm_small = zone_mask((iw, ih), box, shape)
    zm = Image.new("L", (W, H), 0)
    zm.paste(zm_small, (ox, oy))

    inkfull = Image.new("L", (W, H), 0)
    inkfull.paste(ink, (ox, oy))

    # 1. glow pool under everything
    glow = zm.filter(ImageFilter.GaussianBlur(min(W, H) * 0.05)).point(lambda v: int(v * 0.42))
    canvas.alpha_composite(tint(glow, GLOW))

    # 2. the truck, dimmed
    canvas.alpha_composite(tint(inkfull, DIM, 0.85))

    # 3. the lit region: same lines, amber, only inside the zone
    lit = Image.new("L", (W, H), 0)
    lit.paste(inkfull, (0, 0), zm)
    canvas.alpha_composite(tint(lit, HOT))
    # a second pass makes the hot lines read as genuinely brighter, not tinted
    canvas.alpha_composite(tint(lit.filter(ImageFilter.GaussianBlur(2)), HOT, 0.55))

    os.makedirs(OUT, exist_ok=True)
    path = f"{OUT}/{code}{SUFFIX}.png"
    canvas.save(path, "PNG", optimize=True)
    return path, os.path.getsize(path)


if __name__ == "__main__":
    total = 0
    for code, box in ZONES.items():
        p, n = build(code, box)
        total += n
        print(f"{code:5s} {n/1024:6.0f} KB  {p}")
    print(f"\n{len(ZONES)} images, {total/1024/1024:.1f} MB total")
