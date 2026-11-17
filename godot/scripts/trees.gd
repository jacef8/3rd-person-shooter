## Real 3D trees built in code, the same four kinds as the web client (client/trees3d.js): a tapered,
## leaning trunk with bark, branches, and clumps of leaves or pine needles at their ends, fixed in the
## world. Each kind comes as a full build (close by) and a light one (further off), unit height (base at
## 0, top at 1), scaled per tree. Textures (bark, and leaves / needles / Spanish moss) are drawn in code.
extends RefCounted

const KINDS := { "pine": ["longleaf", "slash"], "tree": ["live_oak", "round_oak"] }
const WIDE := { "longleaf": 0.32, "slash": 0.45, "live_oak": 1.3, "round_oak": 0.62 }
const VARIANTS := { "longleaf": 2, "slash": 2, "live_oak": 1, "round_oak": 1 }
const BARK := { "pine": Color(0.62, 0.42, 0.32), "oak": Color(0.42, 0.38, 0.34), "gum": Color(0.5, 0.46, 0.42) }
const GREEN := { "pine": Color(0.86, 0.9, 0.7), "oak": Color(0.9, 0.95, 0.8), "live": Color(0.8, 0.88, 0.7) }
const CELL_LEAF := 0
const CELL_NEEDLE := 1
const CELL_MOSS := 2

var builds := {}         # kind -> [ { name, wide, full: [wood, leaves], lite: [wood, leaves] } ]
var wood_mat: StandardMaterial3D
var leaf_mat: StandardMaterial3D

var _s := 1

func _init() -> void:
	wood_mat = StandardMaterial3D.new()
	wood_mat.albedo_texture = ImageTexture.create_from_image(_bark_image())
	wood_mat.vertex_color_use_as_albedo = true
	wood_mat.roughness = 0.95
	wood_mat.texture_filter = BaseMaterial3D.TEXTURE_FILTER_LINEAR_WITH_MIPMAPS_ANISOTROPIC
	leaf_mat = StandardMaterial3D.new()
	leaf_mat.albedo_texture = ImageTexture.create_from_image(_foliage_image())
	leaf_mat.vertex_color_use_as_albedo = true
	leaf_mat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA_SCISSOR
	leaf_mat.alpha_scissor_threshold = 0.45
	leaf_mat.alpha_antialiasing_mode = BaseMaterial3D.ALPHA_ANTIALIASING_ALPHA_TO_COVERAGE
	leaf_mat.cull_mode = BaseMaterial3D.CULL_DISABLED
	leaf_mat.roughness = 0.9
	leaf_mat.texture_filter = BaseMaterial3D.TEXTURE_FILTER_LINEAR_WITH_MIPMAPS
	for kind in KINDS:
		builds[kind] = []
		for ni in KINDS[kind].size():
			var name: String = KINDS[kind][ni]
			for v in VARIANTS[name]:
				var seed: int = 1000 + ni * 97 + v * 31 + (0 if kind == "pine" else 500)
				builds[kind].append({ "name": name, "wide": WIDE[name], "full": _build(name, seed, false), "lite": _build(name, seed, true) })

## Which build a tree uses (always the same for the same tree) and how wide it's drawn.
func pick(kind: String, id: int, h: float) -> Array:
	var list: Array = builds[kind]
	var v: Dictionary = list[(id * 7 + 3) % list.size()]
	var w := minf(h, 12.0 * pow(h / 12.0, 0.72))
	var sx := minf(w, 22.0 / v.wide) * (0.9 + float((id * 13) % 7) * 0.035)
	return [v, sx]

# ---------------------------------------------------------------- random numbers (the same every run)
func _seed(s: int) -> void:
	_s = s if s != 0 else 1
func _r() -> float:
	_s = (_s * 1103515245 + 12345) & 0x7fffffff
	return float(_s) / 2147483648.0

# ---------------------------------------------------------------- textures
func _bark_image() -> Image:
	var img := Image.create(128, 256, true, Image.FORMAT_RGBA8)
	img.fill(Color(0.54, 0.54, 0.54))
	_seed(7)
	for i in 900:
		var v := 0.4 + _r() * 0.27
		img.fill_rect(Rect2i(int(_r() * 128), int(_r() * 256), 2 + int(_r() * 10), 2 + int(_r() * 14)), Color(v, v, v))
	for i in 16:   # furrows running up the trunk
		var px := _r() * 128.0
		var wdt := 1 + int(_r() * 3)
		for y in 256:
			if y % 16 == 0: px += (_r() - 0.5) * 10.0
			for k in wdt: img.set_pixel(int(px + k) % 128, y, Color(0.1, 0.1, 0.1))
	img.generate_mipmaps()
	return img

## Three cells side by side: broad leaves, pine needle tufts, Spanish moss. Ragged, so the sky shows through.
func _foliage_image() -> Image:
	var S := 256
	var img := Image.create(S * 3, S, false, Image.FORMAT_RGBA8)
	img.fill(Color(0, 0, 0, 0))
	_seed(11)
	for i in 1300:   # leaves, thicker in the middle of the clump
		var a := _r() * TAU; var d := sqrt(_r()) * S * 0.46
		var cx := S * 0.5 + cos(a) * d; var cy := S * 0.5 + sin(a) * d * 0.9
		var g := (120.0 + _r() * 80.0) / 255.0; var sh := 1.0 - d / (S * 1.1)
		var col := Color(g * 0.6 * sh + 0.06, g * sh + 0.1, g * 0.38 * sh + 0.04)
		var rx := 4.0 + _r() * 4.0; var ry := 2.0 + _r() * 2.2; var rot := _r() * PI
		_ellipse(img, cx, cy, rx, ry, rot, col)
	for b in 12:   # needles bursting out from a few points
		var cx := S + S * (0.25 + _r() * 0.5); var cy := S * (0.25 + _r() * 0.5)
		for i in 90:
			var a := _r() * TAU; var l := S * (0.12 + _r() * 0.2); var g := (115.0 + _r() * 75.0) / 255.0
			_line(img, Vector2(cx, cy), Vector2(cx + cos(a) * l, cy + sin(a) * l + l * 0.15), Color(g * 0.62, g + 0.06, g * 0.4), 1 + int(_r() * 1.4), S, S * 2)
	for i in 160:    # moss hanging down
		var px := S * 2 + S * (0.15 + _r() * 0.7); var py := _r() * S * 0.15; var l := S * (0.3 + _r() * 0.6); var v := (120.0 + _r() * 50.0) / 255.0
		var y := 0.0
		while y < l:
			px += (_r() - 0.5) * 4.0
			_line(img, Vector2(px, py + y), Vector2(px, py + y + 8), Color(v - 0.04, v + 0.02, v - 0.08), 1 + int(_r() * 1.5), S * 2, S * 3)
			y += 8.0
	img.generate_mipmaps()
	return img

func _ellipse(img: Image, cx: float, cy: float, rx: float, ry: float, rot: float, col: Color) -> void:
	var c := cos(rot); var s := sin(rot); var r := int(ceil(maxf(rx, ry)))
	for y in range(-r, r + 1):
		for x in range(-r, r + 1):
			var u := (x * c + y * s) / rx; var v := (-x * s + y * c) / ry
			if u * u + v * v <= 1.0:
				var px := int(cx) + x; var py := int(cy) + y
				if px >= 0 and py >= 0 and px < img.get_width() and py < img.get_height(): img.set_pixel(px, py, col)

func _line(img: Image, a: Vector2, b: Vector2, col: Color, w: int, xmin: int, xmax: int) -> void:
	var n := int(a.distance_to(b)) + 1
	for i in n + 1:
		var p := a.lerp(b, float(i) / n)
		for k in w:
			var px := int(p.x) + k; var py := int(p.y)
			if px >= xmin and px < xmax and py >= 0 and py < img.get_height(): img.set_pixel(px, py, col)

# ---------------------------------------------------------------- geometry
class Buf:
	var p := PackedVector3Array()
	var n := PackedVector3Array()
	var u := PackedVector2Array()
	var c := PackedColorArray()
	var i := PackedInt32Array()
	func mesh() -> ArrayMesh:
		var a := []
		a.resize(Mesh.ARRAY_MAX)
		a[Mesh.ARRAY_VERTEX] = p; a[Mesh.ARRAY_NORMAL] = n; a[Mesh.ARRAY_TEX_UV] = u; a[Mesh.ARRAY_COLOR] = c; a[Mesh.ARRAY_INDEX] = i
		var m := ArrayMesh.new()
		m.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, a)
		return m

## A tapered tube along pts ([x, y, z, radius]...).
func _tube(b: Buf, pts: Array, sides: int, col: Color) -> void:
	var o := b.p.size()
	var along := 0.0
	for k in pts.size():
		var cur: Array = pts[k]; var pa: Array = pts[maxi(0, k - 1)]; var pc: Array = pts[mini(pts.size() - 1, k + 1)]
		var T := Vector3(pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]).normalized()
		var N := (Vector3.RIGHT if absf(T.y) > 0.95 else Vector3.UP).cross(T).normalized()
		var B := T.cross(N)
		if k > 0: along += Vector3(cur[0], cur[1], cur[2]).distance_to(Vector3(pa[0], pa[1], pa[2]))
		var dark := 0.75 + 0.25 * minf(1.0, cur[1] * 3.0)
		for s in sides + 1:
			var ang := float(s) / sides * TAU
			var nv := N * cos(ang) + B * sin(ang)
			b.p.append(Vector3(cur[0], cur[1], cur[2]) + nv * cur[3]); b.n.append(nv)
			b.u.append(Vector2(float(s) / sides * maxf(1.0, round(cur[3] * 160.0)), along * 18.0))
			b.c.append(Color(col.r * dark, col.g * dark, col.b * dark))
	for k in pts.size() - 1:
		for s in sides:
			var a := o + k * (sides + 1) + s; var c := a + sides + 1
			b.i.append_array([a, a + 1, c, a + 1, c + 1, c])

## A clump of foliage cards through `at`, lit as part of a rounded crown (normals out from `centre`).
func _clump(b: Buf, at: Vector3, size: float, cell: int, centre: Vector3, tint: Color, planes := 3, hang := false) -> void:
	var nrm := Vector3(at.x - centre.x, (at.y - centre.y) * 1.4 + 0.7, at.z - centre.z).normalized()
	var shade := 0.82 + 0.18 * clampf((at.y - centre.y) / 0.25 + 0.6, 0.0, 1.0)
	var u0 := cell / 3.0; var u1 := (cell + 1) / 3.0
	for q in planes:
		var basis: Basis
		if hang: basis = Basis.from_euler(Vector3(0, _r() * PI, 0))
		else: basis = Basis.from_euler(Vector3((_r() - 0.5) * 1.6, q * PI / planes + _r() * 0.6, (_r() - 0.5) * 1.6))
		var A := basis * Vector3(size * 0.5, 0, 0)
		var Bv := basis * Vector3(0, size if hang else size * 0.5, 0)
		var cy := at.y - size * 0.5 if hang else at.y
		var o := b.p.size()
		for cr in [[-1.0, -1.0, u0, 1.0], [1.0, -1.0, u1, 1.0], [1.0, 1.0, u1, 0.0], [-1.0, 1.0, u0, 0.0]]:
			var by: float = (cr[1] + 1.0) * 0.5 - 0.5 if hang else cr[1]
			b.p.append(Vector3(at.x, cy, at.z) + A * cr[0] + Bv * by)
			b.n.append(nrm); b.u.append(Vector2(cr[2], cr[3]))
			b.c.append(Color(tint.r * shade, tint.g * shade, tint.b * shade))
		b.i.append_array([o, o + 2, o + 1, o, o + 3, o + 2])

func _along(pts: Array, t: float) -> Array:
	var f := t * (pts.size() - 1)
	var k := mini(pts.size() - 2, int(floor(f))); var u := f - k
	var a: Array = pts[k]; var c: Array = pts[k + 1]
	return [lerpf(a[0], c[0], u), lerpf(a[1], c[1], u), lerpf(a[2], c[2], u), lerpf(a[3], c[3], u)]
func _v(p: Array) -> Vector3: return Vector3(p[0], p[1], p[2])

func _trunk(top: float, base: float, tip: float, steps: int, wob: float) -> Array:
	var out := []
	var x := 0.0; var z := 0.0
	for k in steps + 1:
		var t := float(k) / steps
		if k > 0: x += (_r() - 0.5) * wob; z += (_r() - 0.5) * wob
		out.append([x, t * top, z, base * (1.0 - t) + tip * t + (base * 0.35 if k == 0 else 0.0)])
	return out

func _branch(from: Array, dir: Vector3, len: float, r0: float, bend: float, steps := 3) -> Array:
	var out := [[from[0], from[1], from[2], r0]]
	var p := _v(from); var d := dir.normalized()
	for k in range(1, steps + 1):
		d.y += bend / steps; d.x += (_r() - 0.5) * 0.25; d.z += (_r() - 0.5) * 0.25; d = d.normalized()
		p += d * len / steps
		out.append([p.x, p.y, p.z, r0 * (1.0 - float(k) / steps * 0.8)])
	return out

func _build(name: String, seed: int, lite: bool) -> Array:
	_seed(seed)
	var wood := Buf.new(); var leaves := Buf.new()
	match name:
		"longleaf", "slash":
			var slashy := name == "slash"
			var trunk := _trunk(1.0, 0.017 if slashy else 0.016, 0.004, 4 if lite else 8, 0.016 if slashy else 0.012)
			_tube(wood, trunk, 5 if lite else 8, BARK.pine)
			var top: Array = trunk[trunk.size() - 1]
			var crown0 := (0.45 + _r() * 0.1) if slashy else (0.66 + _r() * 0.08)
			var centre := Vector3(top[0], 0.74 if slashy else 0.85, top[2])
			var n := (8 if slashy else 6) if lite else ((16 + int(_r() * 5)) if slashy else (11 + int(_r() * 4)))
			for k in n:
				var t := crown0 + float(k) / n * ((0.98 if slashy else 0.97) - crown0)
				var at := _along(trunk, t); var a := k * 2.4 + _r() * 0.5
				var len: float
				if slashy: len = (0.1 + 0.13 * sin(PI * minf(1.0, float(k + 2) / (n + 1)))) * (1.05 - (t - crown0)) + _r() * 0.03
				else: len = 0.05 + 0.09 * sin(PI * float(k + 1) / (n + 1)) + _r() * 0.03
				var pts := _branch(at, Vector3(cos(a), (-0.05 + _r() * 0.35) if slashy else (0.15 + _r() * 0.3), sin(a)), len, 0.004 if slashy else 0.0035, 0.2 if slashy else 0.25, 2)
				if not lite: _tube(wood, pts, 4, BARK.pine)
				var tip := _v(pts[pts.size() - 1])
				_clump(leaves, tip, (0.18 if lite else 0.13) if slashy else (0.15 if lite else 0.11), CELL_NEEDLE, centre, GREEN.pine, 2 if lite else 3)
				if not lite:
					_clump(leaves, _v(_along(pts, 0.5)), 0.1 if slashy else 0.085, CELL_NEEDLE, centre, GREEN.pine, 2)
					if not slashy: _clump(leaves, _v(_along(pts, 0.25)), 0.07, CELL_NEEDLE, centre, GREEN.pine, 2)
			_clump(leaves, _v(top), 0.09 if slashy else (0.1 if lite else 0.07), CELL_NEEDLE, centre, GREEN.pine, 3)
		"live_oak":
			var split := 0.22 + _r() * 0.08
			var trunk := _trunk(split, 0.04, 0.028, 3, 0.01)
			_tube(wood, trunk, 6 if lite else 9, BARK.oak)
			var top: Array = trunk[trunk.size() - 1]
			var centre := Vector3(0, 0.62, 0)
			var limbs := 4 if lite else 5 + int(_r() * 2)
			for k in limbs:
				var a := float(k) / limbs * TAU + _r() * 0.6; var rise := 0.35 + _r() * 0.5
				var limb := _branch([top[0], top[1] - 0.02, top[2]], Vector3(cos(a), rise, sin(a)), 0.5 + _r() * 0.2, 0.024, -0.25, 3 if lite else 5)
				_tube(wood, limb, 5 if lite else 7, BARK.oak)
				for s in (1 if lite else 3):
					var at := _along(limb, 0.4 + s * 0.2); var b2 := a + (_r() - 0.5) * 1.6
					var sub := _branch(at, Vector3(cos(b2), 0.5 + _r() * 0.5, sin(b2)), 0.18 + _r() * 0.12, 0.01, 0.1, 2)
					if not lite: _tube(wood, sub, 4, BARK.oak)
					_clump(leaves, _v(sub[sub.size() - 1]), 0.2, CELL_LEAF, centre, GREEN.live, 3)
					_clump(leaves, _v(_along(sub, 0.5)), 0.16, CELL_LEAF, centre, GREEN.live, 2)
				for t in ([0.7, 1.0] if lite else [0.45, 0.65, 0.85, 1.0]):
					var at := _v(_along(limb, t)) + Vector3(0, 0.05, 0)
					_clump(leaves, at, 0.3 if lite else 0.22, CELL_LEAF, centre, GREEN.live, 2 if lite else 3)
				if not lite:
					for m in 2:
						var at2 := _v(_along(limb, 0.35 + _r() * 0.5)) - Vector3(0, 0.01, 0)
						_clump(leaves, at2, 0.12 + _r() * 0.08, CELL_MOSS, centre, Color(1, 1, 1), 2, true)
		"round_oak":
			var trunk := _trunk(0.62, 0.03, 0.012, 3 if lite else 6, 0.012)
			_tube(wood, trunk, 5 if lite else 8, BARK.gum)
			var centre := Vector3(0, 0.66, 0)
			var n := 4 if lite else 7
			for k in n:
				var at := _along(trunk, 0.5 + float(k) / n * 0.45); var a := k * 2.4 + _r() * 0.5
				var pts := _branch(at, Vector3(cos(a), 0.9 + _r() * 0.5, sin(a)), 0.22 + _r() * 0.1, 0.012, 0.0, 3)
				if not lite: _tube(wood, pts, 5, BARK.gum)
			for k in (14 if lite else 34):
				var u := _r() * 2.0 - 1.0; var a := _r() * TAU; var s := sqrt(1.0 - u * u); var d := 0.55 + 0.45 * pow(_r(), 1.0 / 3.0)
				_clump(leaves, Vector3(cos(a) * s * 0.3 * d, 0.68 + u * 0.27 * d, sin(a) * s * 0.3 * d), 0.24 if lite else 0.17, CELL_LEAF, centre, GREEN.oak, 2 if lite else 3)
	return [wood.mesh(), leaves.mesh()]
