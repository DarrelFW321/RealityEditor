"""
Sit the hero on the app's background colour, and stop shipping the part of it that is
only background.

Three steps, and each one exists because the model got something nearly right.

SIZE. It returns whatever it feels like — 1280 one time, 4096 the next. Downscaling
first is not only about file size: averaging four pixels into one removes the render's
speckle, and speckle is what makes the two steps below miss.

COLOUR. It is asked for a hex value and returns something near it: #0A111B against the
#0C1420 it was given, and #090F1F the next time. Ten units of constant offset shows as a
rectangle of slightly-wrong dark behind the diorama. Near-background pixels are BLENDED
towards the target rather than shifted by a constant, because the surround is not flat —
there is a vignette — and a constant shift moves a gradient without flattening it.

CROP. The model composes small: the diorama occupies about two thirds of the frame, so a
third of the picture is background the PAGE can supply for free. Cutting it makes the
room half again as large at the same layout size, and moves what surround remains inside
the diorama's own glow, where JPEG's unit of wobble is a unit of gradient rather than
mottling on a flat field.
"""
import sys
from PIL import Image

src, out, target_hex = sys.argv[1], sys.argv[2], sys.argv[3]
target = tuple(int(target_hex[i:i + 2], 16) for i in (1, 3, 5))

im = Image.open(src).convert('RGB')
if max(im.size) > 1400:
    scale = 1400 / max(im.size)
    im = im.resize((round(im.size[0] * scale), round(im.size[1] * scale)), Image.LANCZOS)
w, h = im.size
pixels = im.load()

# The surround, read from the border rather than from one corner: a vignetted frame has
# no single background colour, and the darkest corner is not representative of it.
border = [pixels[x, y] for x in range(0, w, 7) for y in (0, h - 1)]
border += [pixels[x, y] for y in range(0, h, 7) for x in (0, w - 1)]
border.sort(key=sum)
field = border[len(border) // 2]

# Wide enough to take the whole surround, narrow enough to leave the diorama's own dark
# walls alone — they are within about 60 of the field, and this is well under that.
REACH = 38.0
for y in range(h):
    for x in range(w):
        r, g, b = pixels[x, y]
        far = abs(r - field[0]) + abs(g - field[1]) + abs(b - field[2])
        if far >= REACH:
            continue
        weight = 1.0 - far / REACH
        pixels[x, y] = tuple(
            max(0, min(255, round(c + (t - c) * weight))) for c, t in zip((r, g, b), target)
        )

# Everything that is not the field. Below about 8 this catches the render's own faint
# vignette, which reaches all four edges, and finds nothing to remove.
GLOW = 10
box = None
for y in range(h):
    for x in range(w):
        r, g, b = pixels[x, y]
        if abs(r - target[0]) + abs(g - target[1]) + abs(b - target[2]) > GLOW:
            box = (x, y, x + 1, y + 1) if box is None else (
                min(box[0], x), min(box[1], y), max(box[2], x + 1), max(box[3], y + 1))
if box:
    # Breathing room, not just a safe cut. At 3.5% the diorama ends up filling 93% of
    # its frame, and a full-bleed hero then runs the room into both screen edges and
    # reads as a crop rather than as a picture of something. This sits it at about 80%.
    pad = round(max(box[2] - box[0], box[3] - box[1]) * 0.125)
    box = (max(0, box[0] - pad), max(0, box[1] - pad), min(w, box[2] + pad), min(h, box[3] + pad))
    im = im.crop(box)
    print(f'cropped {w}x{h} -> {im.size[0]}x{im.size[1]}')

im.save(out, 'JPEG', quality=95, subsampling=0)

check = Image.open(out).convert('RGB')
cw, ch = check.size
edges = [check.getpixel(p) for p in
         [(x, y) for x in range(1, cw, 40) for y in (1, ch - 2)] +
         [(x, y) for y in range(1, ch, 40) for x in (1, cw - 2)]]
worst = max(sum(abs(c - t) for c, t in zip(e, target)) for e in edges)
mean = sum(sum(abs(c - t) for c, t in zip(e, target)) for e in edges) / len(edges)
print(f'field {"#%02x%02x%02x" % field} -> {len(edges)} edge samples, mean {mean:.1f}, worst {worst}, of {target_hex}')
