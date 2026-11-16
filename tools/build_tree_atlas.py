"""Cut the trees out of the two tree pictures (a longleaf pine on a transparent background, and a
sheet of five Florida trees on a blue sky) and pack them into client/textures/trees.webp, with their
places in client/textures/trees.json. Usage: python3 tools/build_tree_atlas.py <single.webp> <sheet.webp>"""
import json, sys
import numpy as np
from PIL import Image
from scipy import ndimage

single, sheet = sys.argv[1], sys.argv[2]
OUT = 'client/textures/'
trees = []   # (name, kind, RGBA image)

def smooth(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)

# 1. The lone longleaf pine already has its background cut away.
im = Image.open(single).convert('RGBA')
a = np.array(im)
ys, xs = np.nonzero(a[..., 3] > 20)
trees.append(('longleaf', 'pine', Image.fromarray(a[ys.min():ys.max() + 1, xs.min():xs.max() + 1])))

# 2. The sheet: five trees standing on a strip of ground under a blue sky (top half; the bottom
#    half is the same trees from above, not used). Key out the sky by how much bluer than green
#    and red it is; each pixel goes to the nearest trunk.
s = np.array(Image.open(sheet).convert('RGB')).astype(float)
TOP = 626                                  # just above the bare ground strip
s = s[:TOP]
r, g, b = s[..., 0], s[..., 1], s[..., 2]
score = b - np.maximum(r, g)
alpha = 1 - smooth(6, 26, score)
alpha[TOP - 10:] *= np.linspace(1, 0.0, 10)[:, None]   # grass tufts fade out at the bottom edge
# trunks and how wide each crown reaches (pixels in the 1536-wide sheet)
TRUNKS = [('pine1', 'pine', 150, 150), ('pine2', 'pine', 414, 150), ('liveoak', 'tree', 760, 250), ('oak', 'tree', 1154, 220), ('slash', 'pine', 1428, 110)]
xs = np.arange(s.shape[1])[None, :].repeat(s.shape[0], 0)
dist = np.stack([np.abs(xs - tx) / hw for _, _, tx, hw in TRUNKS])
owner = dist.argmin(0)
# blue spill on the edges of the leaves
bb = np.minimum(b, np.maximum(r, g) + 4)
rgb = np.stack([r, g, np.where(alpha < 0.98, bb, b)], -1)
for k, (name, kind, tx, hw) in enumerate(TRUNKS):
    m = (owner == k) & (alpha > 0.05)
    lab, n = ndimage.label(m)
    if n:   # keep the pieces joined to the tree itself, not stray bits of a neighbour's crown
        sizes = ndimage.sum(m, lab, range(1, n + 1))
        keep = np.isin(lab, [i + 1 for i, sz in enumerate(sizes) if sz > 400])
        m &= keep
    ys, xs2 = np.nonzero(m)
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs2.min(), xs2.max() + 1
    a8 = (alpha * m * 255).clip(0, 255).astype(np.uint8)[y0:y1, x0:x1]
    img = np.dstack([rgb[y0:y1, x0:x1].clip(0, 255).astype(np.uint8), a8])
    trees.append((name, kind, Image.fromarray(img, 'RGBA')))

# 3. Pack: every tree 500 px tall, in rows across a 2048-wide sheet.
H, W = 500, 2048
placed, x, y = [], 0, 0
for name, kind, img in trees:
    w = round(img.width * H / img.height)
    if x + w > W: x, y = 0, y + H + 4
    placed.append((name, kind, img.resize((w, H), Image.LANCZOS), x, y))
    x += w + 4
atlasH = 1
while atlasH < y + H: atlasH *= 2
atlas = Image.new('RGBA', (W, atlasH), (0, 0, 0, 0))
info = []
for name, kind, img, px, py in placed:
    atlas.alpha_composite(img, (px, py))
    info.append({'name': name, 'kind': kind, 'u': px / W, 'v': 1 - (py + H) / atlasH, 'w': img.width / W, 'h': H / atlasH, 'aspect': img.width / H})
# The see-through pixels take the colour of the leaves next to them, so the edges don't go dark
# when the picture is shrunk for distant trees.
arr = np.array(atlas).astype(float)
solid = arr[..., 3] > 128
idx = ndimage.distance_transform_edt(~solid, return_distances=False, return_indices=True)
for c in range(3): arr[..., c] = np.where(solid, arr[..., c], arr[..., c][idx[0], idx[1]])
Image.fromarray(arr.astype(np.uint8), 'RGBA').save(OUT + 'trees.webp', 'WEBP', quality=88, method=6)
json.dump({'trees': info}, open(OUT + 'trees.json', 'w'), indent=1)
print(json.dumps(info, indent=1))
