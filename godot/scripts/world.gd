## The county, from the game server (/gmap/, server/gmap.js: the very map the world runs on, map editor
## fixes and all), cached on disk between runs; the copy baked into the game (map/) if the server can't
## be reached. Ground heights and colours, every building and solid object, every road, and real 3D
## trees streamed in around you. Detail is built in tiles around the player as they move; a coarse
## version of the whole county sits underneath for the long view. Walls near the player get collision.
extends Node3D

const Trees = preload("res://scripts/trees.gd")
const TREE_R := 520.0       # trees are drawn this far out
const TREE_FULL := 90.0     # the full build of a tree within this distance, the light one beyond
var loaded := false
var base_http := ""
var meta_sum := ""
var nature_tile := 128.0
var trees                    # the tree builds (trees.gd)
var tree_tiles := {}         # tile key -> Node3D (or null while it's being fetched)
var tree_busy := false

const TILE := 320.0          # one detail tile, metres
const NEAR_TILES := 4        # tiles in each direction drawn in detail (about 1.4 km)
const CELL := 400.0          # buildings and roads are built per cell
const CELL_RANGE := 1600.0
const COLLIDE_R := 70.0

var size := 30000.0
var half := 15000.0
var step := 10.0
var n := 0
var heights := PackedFloat32Array()
var colors: Image
var boxes: Array = []
var roads: Array = []
var types: Array = []
var towns: Array = []

var box_cells := {}      # cell key -> [box index]
var road_cells := {}     # cell key -> [road index]
var tiles := {}          # tile key -> MeshInstance3D
var cells := {}          # cell key -> Node3D
var collide_at := Vector2(INF, INF)
var collider: StaticBody3D

var ground_mat: ShaderMaterial
var box_mat: StandardMaterial3D
var road_mat: StandardMaterial3D

const TYPE_COLOR := {
	"home": Color(0.62, 0.57, 0.5), "farmhouse": Color(0.55, 0.45, 0.33), "barn": Color(0.5, 0.25, 0.2),
	"civic": Color(0.62, 0.38, 0.3), "warehouse": Color(0.55, 0.56, 0.58), "building": Color(0.5, 0.52, 0.55),
	"hangar": Color(0.62, 0.64, 0.66), "car": Color(0.45, 0.15, 0.15), "vehiclebody": Color(0.84, 0.8, 0.66),
	"tank": Color(0.87, 0.89, 0.91), "solar": Color(0.17, 0.23, 0.36), "tower": Color(0.6, 0.6, 0.62),
	"rail": Color(0.4, 0.38, 0.35), "deckslab": Color(0.66, 0.66, 0.64), "boulder": Color(0.42, 0.4, 0.38),
	"rockwall": Color(0.55, 0.45, 0.35), "logwall": Color(0.36, 0.24, 0.14), "plankwall": Color(0.48, 0.37, 0.24),
	"fence": Color(0.5, 0.42, 0.3), "pole": Color(0.35, 0.3, 0.25),
}

func _ready() -> void:
	collider = StaticBody3D.new()
	add_child(collider)

## Load the map (from `base` = the server's http(s) address) and build the long view. Awaitable.
func start(base: String) -> void:
	base_http = base
	trees = Trees.new()
	await _load()
	_materials()
	_far_ground()
	_water()
	loaded = true

## A file from the server (empty on failure).
func _fetch(path: String) -> PackedByteArray:
	var req := HTTPRequest.new()
	req.accept_gzip = true
	req.body_size_limit = 64 * 1024 * 1024
	req.timeout = 180.0
	add_child(req)
	if req.request(base_http + path) != OK:
		req.queue_free(); return PackedByteArray()
	var res: Array = await req.request_completed
	req.queue_free()
	return res[3] if int(res[0]) == HTTPRequest.RESULT_SUCCESS and int(res[1]) == 200 else PackedByteArray()

func _load() -> void:
	# The server's map, cached: meta every time (it says which map it is), heights and colours only
	# when the map has changed since last time.
	var meta_txt := ""
	var hraw := PackedByteArray(); var craw := PackedByteArray()
	if base_http != "":
		var mb := await _fetch("/gmap/meta.json")
		if mb.size() > 0:
			meta_txt = mb.get_string_from_utf8()
	var cache := "user://gmap"
	if meta_txt != "":
		var m0 = JSON.parse_string(meta_txt)
		var sum := str(m0.get("sum", ""))
		DirAccess.make_dir_recursive_absolute(cache)
		if sum != "" and FileAccess.get_file_as_string(cache + "/sum.txt") == sum:
			hraw = FileAccess.get_file_as_bytes(cache + "/heights.d16.gz"); craw = FileAccess.get_file_as_bytes(cache + "/colors.rgb.gz")
		if hraw.size() == 0 or craw.size() == 0:
			hraw = await _fetch("/gmap/heights.d16.gz"); craw = await _fetch("/gmap/colors.rgb.gz")
			if hraw.size() > 0 and craw.size() > 0:
				var f := FileAccess.open(cache + "/heights.d16.gz", FileAccess.WRITE); f.store_buffer(hraw); f.close()
				f = FileAccess.open(cache + "/colors.rgb.gz", FileAccess.WRITE); f.store_buffer(craw); f.close()
				f = FileAccess.open(cache + "/sum.txt", FileAccess.WRITE); f.store_string(sum); f.close()
		if hraw.size() == 0 or craw.size() == 0: meta_txt = ""
	if meta_txt == "":   # no server: the copy that ships with the game
		meta_txt = FileAccess.get_file_as_string("res://map/meta.json")
		hraw = FileAccess.get_file_as_bytes("res://map/heights.d16.gz"); craw = FileAccess.get_file_as_bytes("res://map/colors.rgb.gz")
		base_http = ""
	var meta = JSON.parse_string(meta_txt)
	size = meta.size; half = meta.half; step = meta.step; n = int(meta.n)
	boxes = meta.boxes; roads = meta.roads; types = meta.types; towns = meta.towns
	meta_sum = str(meta.get("sum", "")); nature_tile = float(meta.get("natureTile", 128))
	# Heights: each row stored as differences from the point before, in 10 cm steps above -40 m.
	var raw := hraw.decompress_dynamic(-1, FileAccess.COMPRESSION_GZIP)
	heights.resize(n * n)
	for j in n:
		var v := 0
		for i in n:
			var k := j * n + i
			var d := raw.decode_s16(k * 2)
			v = d + 32768 if i == 0 else v + d
			heights[k] = v * meta.heightScale + meta.heightBase
	var rgb := craw.decompress_dynamic(-1, FileAccess.COMPRESSION_GZIP)
	colors = Image.create_from_data(n, n, false, Image.FORMAT_RGB8, rgb)
	for bi in boxes.size():
		var b = boxes[bi]
		var key := _cell_key((b[0] + b[2]) * 0.5, (b[1] + b[3]) * 0.5)
		if not box_cells.has(key): box_cells[key] = []
		box_cells[key].append(bi)
	for ri in roads.size():
		var r = roads[ri]
		var a := Vector2(r[0], r[1]); var c := Vector2(r[2], r[3])
		var segs := maxi(1, int(a.distance_to(c) / CELL))
		var seen := {}
		for s in segs + 1:
			var p := a.lerp(c, float(s) / segs)
			var key := _cell_key(p.x, p.y)
			if seen.has(key): continue
			seen[key] = true
			if not road_cells.has(key): road_cells[key] = []
			road_cells[key].append(ri)

func _cell_key(x: float, z: float) -> Vector2i:
	return Vector2i(int(floor(x / CELL)), int(floor(z / CELL)))

## Ground height, the same 10 m grid the map was baked on, bilinear.
func height(x: float, z: float) -> float:
	if n < 2: return 0.0
	var fx := (x + half) / step; var fz := (z + half) / step
	var i := clampi(int(floor(fx)), 0, n - 2); var j := clampi(int(floor(fz)), 0, n - 2)
	var u := clampf(fx - i, 0, 1); var v := clampf(fz - j, 0, 1)
	var h00 := heights[j * n + i]; var h10 := heights[j * n + i + 1]
	var h01 := heights[(j + 1) * n + i]; var h11 := heights[(j + 1) * n + i + 1]
	return lerpf(lerpf(h00, h10, u), lerpf(h01, h11, u), v)

## Which way the ground faces at (x, z): straight from the slope (always up-ish, whatever the winding).
func _slope_normal(x: float, z: float, d := 10.0) -> Vector3:
	return Vector3(height(x - d, z) - height(x + d, z), 2.0 * d, height(x, z - d) - height(x, z + d)).normalized()

## The land-cover map's woods colour (60, 60, 34).
func _is_woods(c: Color) -> bool:
	return absf(c.r8 - 60) <= 6 and absf(c.g8 - 60) <= 6 and absf(c.b8 - 34) <= 6

func ground_color(x: float, z: float) -> Color:
	var i := clampi(int(round((x + half) / step)), 0, n - 1); var j := clampi(int(round((z + half) / step)), 0, n - 1)
	return colors.get_pixel(i, j)

func _materials() -> void:
	var sh := Shader.new()
	sh.code = """
shader_type spatial;
render_mode cull_back;
uniform sampler2D grass : source_color, filter_linear_mipmap_anisotropic, repeat_enable;
uniform sampler2D litter : source_color, filter_linear_mipmap_anisotropic, repeat_enable;
varying vec3 wp;
void vertex() { wp = (MODEL_MATRIX * vec4(VERTEX, 1.0)).xyz; }
void fragment() {
	vec3 base = COLOR.rgb;
	vec3 tA = texture(grass, wp.xz / 3.2).rgb, tB = texture(grass, mat2(vec2(0.8, 0.6), vec2(-0.6, 0.8)) * wp.xz / 10.5 + 0.37).rgb;
	vec3 tc = tA * 0.62 + tB * 0.38;
	// Relative to the photo's own average colour (its smallest mip), so it works in any colour space:
	// the ground keeps its real brightness and tint, the photo adds its blades, light and shade.
	vec3 avg = max(textureLod(grass, vec2(0.5), 12.0).rgb, vec3(0.02));
	vec3 rel = tc / avg;
	float tl = dot(rel, vec3(0.3, 0.59, 0.11));
	float grassy = smoothstep(0.015, 0.05, base.g - max(base.r, base.b) * 0.9);
	vec3 detail = base * mix(1.0, tl, 0.45);
	vec3 real = base * mix(vec3(tl), rel, 0.55);
	ALBEDO = mix(detail, real, grassy * 0.85);
	// The woods floor (dark olive on the land-cover map): pine straw and leaves, a little brighter.
	float wd = 1.0 - COLOR.a;   // woods (marked per vertex)
	vec3 lit = texture(litter, wp.xz / 4.0).rgb * 0.62 + texture(litter, wp.xz / 13.0 + 0.41).rgb * 0.38;
	ALBEDO = mix(ALBEDO, lit * vec3(0.7, 0.62, 0.5), wd);
	ROUGHNESS = 1.0;
}
"""
	ground_mat = ShaderMaterial.new()
	ground_mat.shader = sh
	ground_mat.set_shader_parameter("grass", load("res://textures/grass.jpg"))
	ground_mat.set_shader_parameter("litter", load("res://textures/forest.jpg"))
	box_mat = StandardMaterial3D.new()
	box_mat.vertex_color_use_as_albedo = true
	box_mat.roughness = 0.9
	road_mat = StandardMaterial3D.new()
	road_mat.vertex_color_use_as_albedo = true
	road_mat.roughness = 0.95

## One detail tile of ground: a 10 m grid, coloured by the real land cover (linear colours).
func _build_tile(tx: int, tz: int) -> MeshInstance3D:
	var st := SurfaceTool.new()
	st.begin(Mesh.PRIMITIVE_TRIANGLES)
	var q := int(TILE / step)
	var x0 := tx * TILE; var z0 := tz * TILE
	for j in q + 1:
		for i in q + 1:
			var x := x0 + i * step; var z := z0 + j * step
			var gc := ground_color(x, z)
			var lc := gc.srgb_to_linear()
			lc.a = 0.0 if _is_woods(gc) else 1.0   # alpha marks the woods floor for the ground shader
			st.set_color(lc)
			st.set_normal(_slope_normal(x, z))
			st.add_vertex(Vector3(x, height(x, z), z))
	for j in q:
		for i in q:
			var a := j * (q + 1) + i
			st.add_index(a); st.add_index(a + 1); st.add_index(a + q + 1)
			st.add_index(a + 1); st.add_index(a + q + 2); st.add_index(a + q + 1)
	# (normals from the slope, set per vertex above)
	var mi := MeshInstance3D.new()
	mi.mesh = st.commit()
	mi.material_override = ground_mat
	add_child(mi)
	return mi

## The whole county at 100 m, a hair lower than the detail tiles so they win where both are.
func _far_ground() -> void:
	var st := SurfaceTool.new()
	st.begin(Mesh.PRIMITIVE_TRIANGLES)
	var fs := 100.0
	var m := int(size / fs) + 1
	for j in m:
		for i in m:
			var x := -half + i * fs; var z := -half + j * fs
			st.set_color(ground_color(x, z).srgb_to_linear())
			st.set_normal(_slope_normal(x, z, fs))
			st.add_vertex(Vector3(x, height(x, z) - 0.35, z))
	for j in m - 1:
		for i in m - 1:
			var a := j * m + i
			st.add_index(a); st.add_index(a + 1); st.add_index(a + m)
			st.add_index(a + 1); st.add_index(a + m + 1); st.add_index(a + m)
	# (normals from the slope)
	var mi := MeshInstance3D.new()
	mi.mesh = st.commit()
	# Only out past the detailed ground: close by, this coarse one (a point every 100 m) would poke up
	# through it wherever the ground dips.
	var sh := Shader.new()
	sh.code = """
shader_type spatial;
render_mode cull_back;
varying vec3 wp;
void vertex() { wp = (MODEL_MATRIX * vec4(VERTEX, 1.0)).xyz; }
void fragment() {
	if (distance(wp.xz, CAMERA_POSITION_WORLD.xz) < 1200.0) discard;
	ALBEDO = COLOR.rgb;
	ROUGHNESS = 1.0;
}
"""
	var mat := ShaderMaterial.new()
	mat.shader = sh
	mi.material_override = mat
	add_child(mi)

func _water() -> void:
	var sh := Shader.new()
	sh.code = """
shader_type spatial;
render_mode blend_mix, cull_disabled;
varying vec3 wp;
void vertex() { wp = (MODEL_MATRIX * vec4(VERTEX, 1.0)).xyz; }
void fragment() {
	vec2 q = wp.xz;
	float t = TIME;
	vec2 g = vec2(cos(dot(q, vec2(0.52, 0.18)) + t * 1.6), cos(dot(q, vec2(-0.25, 0.62)) + t * 2.1)) * 0.06
	       + vec2(cos(dot(q, vec2(1.2, -1.2)) + t * 2.9), cos(dot(q, vec2(-1.5, -0.4)) + t * 3.7)) * 0.025;
	NORMAL = normalize((VIEW_MATRIX * vec4(-g.x, 1.0, -g.y, 0.0)).xyz);
	float fres = pow(1.0 - clamp(dot(NORMAL, VIEW), 0.0, 1.0), 4.0);
	ALBEDO = mix(vec3(0.07, 0.2, 0.26), vec3(0.55, 0.68, 0.8), fres * 0.8);
	ROUGHNESS = 0.08;
	METALLIC = 0.05;
	ALPHA = 0.86;
}
"""
	var mat := ShaderMaterial.new()
	mat.shader = sh
	var plane := PlaneMesh.new()
	plane.size = Vector2(size + 4000, size + 4000)
	var mi := MeshInstance3D.new()
	mi.mesh = plane
	mi.material_override = mat
	mi.position.y = -0.25   # land is above 0, river beds below
	add_child(mi)

## Buildings and solid objects of one cell as one mesh; roads of one cell as strips on the ground.
func _build_cell(key: Vector2i) -> Node3D:
	var node := Node3D.new()
	var list: Array = box_cells.get(key, [])
	if list.size() > 0:
		var st := SurfaceTool.new()
		st.begin(Mesh.PRIMITIVE_TRIANGLES)
		for bi in list:
			_add_box(st, boxes[bi])
		st.generate_normals()
		var mi := MeshInstance3D.new()
		mi.mesh = st.commit()
		mi.material_override = box_mat
		node.add_child(mi)
	var rl: Array = road_cells.get(key, [])
	if rl.size() > 0:
		var rs := SurfaceTool.new()
		rs.begin(Mesh.PRIMITIVE_TRIANGLES)
		var lo := Vector2(key.x * CELL, key.y * CELL)
		for ri in rl:
			_add_road(rs, roads[ri], lo)
		rs.generate_normals()
		var rm := MeshInstance3D.new()
		rm.mesh = rs.commit()
		rm.material_override = road_mat
		node.add_child(rm)
	add_child(node)
	return node

func _box_corners(b) -> Array:
	if b.size() > 7:
		var a: float = b[7]; var cx: float = b[8]; var cz: float = b[9]; var hw: float = b[10]; var hd: float = b[11]
		var ca := cos(a); var sa := sin(a)
		var out := []
		for c in [Vector2(-hw, -hd), Vector2(hw, -hd), Vector2(hw, hd), Vector2(-hw, hd)]:
			out.append(Vector2(cx + c.x * ca - c.y * sa, cz + c.x * sa + c.y * ca))
		return out
	return [Vector2(b[0], b[1]), Vector2(b[2], b[1]), Vector2(b[2], b[3]), Vector2(b[0], b[3])]

func _add_box(st: SurfaceTool, b) -> void:
	var t: String = types[int(b[6])]
	var col: Color = TYPE_COLOR.get(t, Color(0.5, 0.5, 0.52))
	var y0: float = b[4]; var y1: float = b[4] + b[5]
	var c := _box_corners(b)
	var cl := col.srgb_to_linear()
	# Walls go a little below the ground so slopes don't show a gap under them.
	var yb := y0 - 0.6
	for k in 4:
		var p: Vector2 = c[k]; var q: Vector2 = c[(k + 1) % 4]
		var shade := 0.8 + 0.2 * float(k % 2)
		st.set_color(cl * shade)
		st.add_vertex(Vector3(p.x, yb, p.y)); st.add_vertex(Vector3(q.x, y1, q.y)); st.add_vertex(Vector3(q.x, yb, q.y))
		st.add_vertex(Vector3(p.x, yb, p.y)); st.add_vertex(Vector3(p.x, y1, p.y)); st.add_vertex(Vector3(q.x, y1, q.y))
	var roof := cl * (0.62 if t in ["home", "farmhouse", "barn", "civic"] else 0.85)
	st.set_color(roof)
	st.add_vertex(Vector3(c[0].x, y1, c[0].y)); st.add_vertex(Vector3(c[2].x, y1, c[2].y)); st.add_vertex(Vector3(c[1].x, y1, c[1].y))
	st.add_vertex(Vector3(c[0].x, y1, c[0].y)); st.add_vertex(Vector3(c[3].x, y1, c[3].y)); st.add_vertex(Vector3(c[2].x, y1, c[2].y))

func _add_road(st: SurfaceTool, r, lo: Vector2) -> void:
	var a := Vector2(r[0], r[1]); var c := Vector2(r[2], r[3])
	var w: float = r[4]
	var kind: int = int(r[5])
	var col := Color(0.55, 0.45, 0.31) if kind == 1 else (Color(0.25, 0.26, 0.28) if kind == 2 else Color(0.27, 0.28, 0.3))
	var len := a.distance_to(c)
	if len < 0.5: return
	var dir := (c - a) / len
	var nrm := Vector2(-dir.y, dir.x) * (w * 0.5)
	var hi := lo + Vector2(CELL, CELL)
	var steps := maxi(1, int(len / 8.0))
	st.set_color(col.srgb_to_linear())
	for s in steps:
		var p := a.lerp(c, float(s) / steps); var q := a.lerp(c, float(s + 1) / steps)
		var mid := (p + q) * 0.5
		if mid.x < lo.x or mid.y < lo.y or mid.x >= hi.x or mid.y >= hi.y: continue   # this cell's piece only
		var hp := height(p.x, p.y) + 0.12; var hq := height(q.x, q.y) + 0.12
		var p1 := p + nrm; var p2 := p - nrm; var q1 := q + nrm; var q2 := q - nrm
		st.add_vertex(Vector3(p1.x, height(p1.x, p1.y) + 0.12, p1.y)); st.add_vertex(Vector3(q1.x, height(q1.x, q1.y) + 0.12, q1.y)); st.add_vertex(Vector3(p2.x, hp, p2.y))
		st.add_vertex(Vector3(q1.x, height(q1.x, q1.y) + 0.12, q1.y)); st.add_vertex(Vector3(q2.x, hq, q2.y)); st.add_vertex(Vector3(p2.x, hp, p2.y))

## Called every frame with where the player is: builds what's near, drops what's far, a little at a time.
func update(px: float, pz: float) -> void:
	if not loaded: return
	_update_trees(px, pz)
	var tx := int(floor(px / TILE)); var tz := int(floor(pz / TILE))
	var want := {}
	var todo := []
	for dz in range(-NEAR_TILES, NEAR_TILES + 1):
		for dx in range(-NEAR_TILES, NEAR_TILES + 1):
			var key := Vector2i(tx + dx, tz + dz)
			want[key] = true
			if not tiles.has(key): todo.append(key)
	# Nearest first, a few a frame.
	todo.sort_custom(func(a, b): return (a - Vector2i(tx, tz)).length_squared() < (b - Vector2i(tx, tz)).length_squared())
	for key in todo.slice(0, 3):
		tiles[key] = _build_tile(key.x, key.y)
	var built := 0
	for key in tiles.keys():
		if not want.has(key):
			tiles[key].queue_free(); tiles.erase(key)
	var ck := _cell_key(px, pz)
	var cr := int(CELL_RANGE / CELL)
	var wantc := {}
	built = 0
	for dz in range(-cr, cr + 1):
		for dx in range(-cr, cr + 1):
			var key := Vector2i(ck.x + dx, ck.y + dz)
			if Vector2(dx, dz).length() > cr + 0.5: continue
			wantc[key] = true
			if not cells.has(key) and built < 2:
				cells[key] = _build_cell(key)
				built += 1
	for key in cells.keys():
		if not wantc.has(key):
			cells[key].queue_free(); cells.erase(key)
	if Vector2(px, pz).distance_to(collide_at) > 20.0:
		_rebuild_collision(px, pz)

## Box colliders for everything solid within reach (the player walks into walls, not through them).
func _rebuild_collision(px: float, pz: float) -> void:
	collide_at = Vector2(px, pz)
	for ch in collider.get_children(): ch.queue_free()
	var ck := _cell_key(px, pz)
	for dz in range(-1, 2):
		for dx in range(-1, 2):
			for bi in box_cells.get(Vector2i(ck.x + dx, ck.y + dz), []):
				var b = boxes[bi]
				var cx: float = (b[0] + b[2]) * 0.5; var cz: float = (b[1] + b[3]) * 0.5
				if absf(cx - px) > COLLIDE_R or absf(cz - pz) > COLLIDE_R: continue
				var shape := BoxShape3D.new()
				var cs := CollisionShape3D.new()
				var y0: float = b[4]; var h: float = b[5]
				if b.size() > 7:
					shape.size = Vector3(b[10] * 2.0, h, b[11] * 2.0)
					cs.transform = Transform3D(Basis(Vector3.UP, -float(b[7])), Vector3(b[8], y0 + h * 0.5, b[9]))
				else:
					shape.size = Vector3(b[2] - b[0], h, b[3] - b[1])
					cs.position = Vector3(cx, y0 + h * 0.5, cz)
				cs.shape = shape
				collider.add_child(cs)

## How far along a ray the ground is (up to max_d), by stepping.
func ray_ground(o: Vector3, d: Vector3, max_d: float) -> float:
	var t := 0.5
	while t < max_d:
		var p := o + d * t
		if p.y < height(p.x, p.z): return t
		t += 1.5
	return INF

# ---------------------------------------------------------------- trees
## Trees in 128 m tiles around you, asked of the server a batch at a time; drawn as instanced meshes,
## each build twice (full close by, light further out, by distance from the camera).
func _update_trees(px: float, pz: float) -> void:
	if base_http == "": return
	var T := nature_tile
	var r := int(ceil(TREE_R / T))
	var cx := int(floor((px + half) / T)); var cz := int(floor((pz + half) / T))
	var want := {}
	var need := []
	for dz in range(-r, r + 1):
		for dx in range(-r, r + 1):
			var k := Vector2i(cx + dx, cz + dz)
			var mx := -half + (k.x + 0.5) * T; var mz := -half + (k.y + 0.5) * T
			if Vector2(mx - px, mz - pz).length() > TREE_R + T: continue
			want[k] = true
			if not tree_tiles.has(k): need.append(k)
	for k in tree_tiles.keys():
		if not want.has(k) and tree_tiles[k] != null:
			tree_tiles[k].queue_free(); tree_tiles.erase(k)
	if tree_busy or need.is_empty(): return
	need.sort_custom(func(a, b): return (a - Vector2i(cx, cz)).length_squared() < (b - Vector2i(cx, cz)).length_squared())
	_fetch_trees(need.slice(0, 24))

func _fetch_trees(keys: Array) -> void:
	tree_busy = true
	for k in keys: tree_tiles[k] = null
	var q := ";".join(keys.map(func(k): return "%d,%d" % [k.x, k.y]))
	var body := await _fetch("/gmap/nature?t=" + q)
	tree_busy = false
	if body.size() == 0:
		for k in keys: tree_tiles.erase(k)   # try again later
		return
	var got = JSON.parse_string(body.get_string_from_utf8())
	var tiles: Dictionary = got.get("tiles", {}) if got is Dictionary else {}
	for k in keys:
		var list = tiles.get("%d,%d" % [k.x, k.y], [])
		if not tree_tiles.has(k): continue   # walked away meanwhile
		tree_tiles[k] = _build_trees(list)

func _build_trees(list: Array) -> Node3D:
	var node := Node3D.new()
	add_child(node)
	var groups := {}   # build -> [transform...]
	for t in list:
		if int(t[6]) == 1: continue   # cut down
		var kind := "pine" if int(t[4]) == 1 else "tree"
		var pk: Array = trees.pick(kind, int(t[5]), float(t[3]))
		var v: Dictionary = pk[0]; var sx: float = pk[1]
		var yaw := fmod(float(t[5]) * 2.399, TAU)
		var xf := Transform3D(Basis(Vector3.UP, yaw).scaled(Vector3(sx, float(t[3]), sx)), Vector3(t[0], float(t[2]) + 0.15, t[1]))
		if not groups.has(v): groups[v] = []
		groups[v].append(xf)
	for v in groups:
		var xfs: Array = groups[v]
		for which in ["full", "lite"]:
			for part in 2:
				var mm := MultiMesh.new()
				mm.transform_format = MultiMesh.TRANSFORM_3D
				mm.mesh = v[which][part]
				mm.instance_count = xfs.size()
				for i in xfs.size(): mm.set_instance_transform(i, xfs[i])
				var mi := MultiMeshInstance3D.new()
				mi.multimesh = mm
				mi.material_override = trees.wood_mat if part == 0 else trees.leaf_mat
				if which == "full": mi.visibility_range_end = TREE_FULL
				else: mi.visibility_range_begin = TREE_FULL
				mi.visibility_range_end_margin = 10.0 if which == "full" else 0.0
				mi.visibility_range_begin_margin = 10.0 if which == "lite" else 0.0
				mi.visibility_range_fade_mode = GeometryInstance3D.VISIBILITY_RANGE_FADE_DISABLED
				node.add_child(mi)
	return node
