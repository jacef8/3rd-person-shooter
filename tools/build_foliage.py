# Builds client/textures/foliage.png: three 512 px cells (broad leaves, pine needles, Spanish moss)
# from Poly Haven photo scans (CC0): tree_small_02 leaf sprays and pine_tree_01 needle sprigs.
import sys, math, random
from PIL import Image, ImageFilter
src, out = sys.argv[1], sys.argv[2]
random.seed(7)
S = 512
def cut(name, a, b, box):
    c = Image.open(f'{src}/{name}_{a}.jpg').convert('RGB'); m = Image.open(f'{src}/{name}_{b}.jpg').convert('L')
    W, H = c.size; bx = (int(box[0]*W), int(box[1]*H), int(box[2]*W), int(box[3]*H))
    c = c.crop(bx); m = m.crop(bx)
    m = m.point(lambda v: 255 if v > 185 else 0)
    im = c.convert('RGBA'); im.putalpha(m)
    return im.crop(im.getbbox())
leafA = cut('tree_small_02', 'leaves_diff', 'leaves_alpha', (0.53, 0.03, 0.83, 0.33))
leafB = cut('tree_small_02', 'leaves_diff', 'leaves_alpha', (0.55, 0.3, 0.84, 0.6))
leafC = cut('tree_small_02', 'leaves_diff', 'leaves_alpha', (0.53, 0.03, 0.84, 0.6))
pineA = cut('pine_tree_01', 'twig_diff', 'twig_alpha', (0.05, 0.05, 0.185, 0.43))
pineB = cut('pine_tree_01', 'twig_diff', 'twig_alpha', (0.675, 0.335, 0.935, 0.5))

def stamp(cell, piece, cx, cy, size, ang, shade=1.0):
    k = size / max(piece.size)
    p = piece.resize((max(1, int(piece.size[0]*k)), max(1, int(piece.size[1]*k))), Image.LANCZOS).rotate(ang, expand=True, resample=Image.BICUBIC)
    if shade != 1.0:
        r, g, b, a = p.split(); r = r.point(lambda v: int(v*shade)); g = g.point(lambda v: int(v*shade)); b = b.point(lambda v: int(v*shade)); p = Image.merge('RGBA', (r, g, b, a))
    cell.alpha_composite(p, (int(cx - p.size[0]/2), int(cy - p.size[1]/2)))

leaf = Image.new('RGBA', (S, S), (0, 0, 0, 0))
for i in range(26):   # inner (darker) first, the outside ones over them
    t = i / 26; r = (0.08 + 0.26 * math.sqrt(t)) * S; a = random.random() * math.tau
    stamp(leaf, random.choice([leafA, leafB, leafC]), S/2 + math.cos(a)*r, S/2 + math.sin(a)*r*0.9, S*(0.32 + random.random()*0.12), random.random()*360, 0.62 + 0.45*t)
needle = Image.new('RGBA', (S, S), (0, 0, 0, 0))
for i in range(14):   # sprigs bursting out from the middle, tips outward
    a = i / 14 * 360 + random.random()*14; piece = random.choice([pineA, pineB])
    rad = math.radians(a); r = S*0.17
    stamp(needle, piece, S/2 + math.cos(rad)*r, S/2 - math.sin(rad)*r, S*(0.42 + random.random()*0.12), a - 90 + random.uniform(-15, 15), 0.75 + random.random()*0.35)
moss = Image.new('RGBA', (S, S), (0, 0, 0, 0))   # Spanish moss: grey-green strands hanging down
from PIL import ImageDraw
d = ImageDraw.Draw(moss)
for i in range(320):
    x = S*(0.12 + random.random()*0.76); y = random.random()*S*0.12; l = S*(0.3 + random.random()*0.62); v = 120 + random.randint(0, 50)
    pts = [(x, y)]
    while y < l: x += random.uniform(-3, 3); y += 10; pts.append((x, y))
    d.line(pts, fill=(v - 10, v + 6, v - 22, 235), width=random.choice([1, 2, 2, 3]))
sheet = Image.new('RGBA', (S*3, S), (0, 0, 0, 0))
for i, c in enumerate([leaf, needle, moss]): sheet.paste(c, (i*S, 0))
# Bleed colour into the transparent edges (no dark fringes when the texture is filtered).
rgb = sheet.convert('RGB'); a = sheet.split()[3]
blur = Image.composite(rgb, rgb.filter(ImageFilter.GaussianBlur(6)), a)
fill = Image.composite(rgb, blur.filter(ImageFilter.MaxFilter(9)), a.point(lambda v: 255 if v > 0 else 0))
final = fill.convert('RGBA'); final.putalpha(a)
final.save(out, optimize=True)
print('ok', final.size)
