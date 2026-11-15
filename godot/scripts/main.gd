## Deadzone in Godot, milestone 1: sign in, drop into the real county, walk and run it, see everyone
## else (players and Rogues) live from the same server the web game uses, and shoot.
## Phone: left half is the move stick (push to the edge to sprint), drag on the right half to look,
## FIRE / AIM / RELOAD buttons. Computer: WASD, mouse to look (click to grab it), left click fire,
## right click aim, Shift sprint, R reload, Esc lets go of the mouse.
extends Node3D

const World = preload("res://scripts/world.gd")
const Net = preload("res://scripts/net.gd")

const WALK := 5.4
const SPRINT := 8.6
const AIM_SPEED := 2.9
const STAND_EYE := 1.6
const SMOOTH_MS := 110.0

var world
var net
var player: CharacterBody3D
var body_vis: Node3D
var cam_yaw_node: Node3D
var cam_pitch_node: Node3D
var arm: SpringArm3D
var cam: Camera3D

var my_id := ""
var tp := 0
var yaw := 0.0
var pitch := 0.0
var aiming := false
var firing := false
var fired_this_press := false
var last_shot := 0.0
var last_send := 0.0
var me := {}
var arsenal := {}
var in_game := false
var others := {}        # id -> { node, buf: [ {t, x, z, yaw} ], kind }
var tracers := []       # [node, life]

# touch
var stick_id := -1
var stick_origin := Vector2.ZERO
var stick_vec := Vector2.ZERO
var look_id := -1
var look_last := Vector2.ZERO
var mouse_captured := false

# UI
var ui: CanvasLayer
var start_panel: PanelContainer
var name_edit: LineEdit
var status: Label
var toast_label: Label
var hp_bar: ProgressBar
var ammo_label: Label
var cross: Label
var respawn_btn: Button
var stick_draw: Control
var btn_fire: Button
var btn_aim: Button
var btn_reload: Button
var toast_until := 0.0

func _ready() -> void:
	arsenal = JSON.parse_string(FileAccess.get_file_as_string("res://map/arsenal.json")).archetypes
	_environment()
	world = World.new()
	add_child(world)
	_player()
	net = Net.new()
	add_child(net)
	net.message.connect(_on_message)
	net.opened.connect(_on_open)
	net.closed.connect(func(): _status("Connection lost — reconnecting…"); in_game = false; await get_tree().create_timer(2.0).timeout; net.connect_to_world(1))
	_build_ui()
	if OS.get_environment("DEADZONE_AUTOPLAY") == "1" or (OS.has_feature("web") and str(JavaScriptBridge.eval("location.search")).contains("autoplay")):   # tests: skip the start screen
		_on_play.call_deferred()

# ------------------------------------------------------------------ scene
func _environment() -> void:
	var env := Environment.new()
	env.background_mode = Environment.BG_SKY
	var sky := Sky.new()
	var mat := ProceduralSkyMaterial.new()
	mat.sky_top_color = Color(0.25, 0.47, 0.78)
	mat.sky_horizon_color = Color(0.72, 0.82, 0.9)
	mat.ground_horizon_color = Color(0.6, 0.66, 0.6)
	mat.ground_bottom_color = Color(0.3, 0.32, 0.28)
	mat.sun_angle_max = 30.0
	sky.sky_material = mat
	env.sky = sky
	env.ambient_light_source = Environment.AMBIENT_SOURCE_SKY
	env.ambient_light_energy = 1.25
	env.tonemap_mode = Environment.TONE_MAPPER_ACES
	env.tonemap_exposure = 1.15
	env.fog_enabled = true
	env.fog_light_color = Color(0.72, 0.8, 0.88)
	env.fog_density = 0.00012
	env.fog_aerial_perspective = 0.6
	var we := WorldEnvironment.new()
	we.environment = env
	add_child(we)
	var sun := DirectionalLight3D.new()
	sun.rotation_degrees = Vector3(-42, -55, 0)
	sun.light_energy = 1.6
	sun.shadow_enabled = true
	sun.directional_shadow_max_distance = 120.0
	add_child(sun)

func _player() -> void:
	player = CharacterBody3D.new()
	var cs := CollisionShape3D.new()
	var cap := CapsuleShape3D.new()
	cap.radius = 0.4; cap.height = 1.8
	cs.shape = cap
	cs.position.y = 0.9
	player.add_child(cs)
	add_child(player)
	body_vis = _make_person(Color(0.18, 0.37, 0.55))
	player.add_child(body_vis)
	cam_yaw_node = Node3D.new()
	cam_yaw_node.position.y = STAND_EYE + 0.2
	player.add_child(cam_yaw_node)
	cam_pitch_node = Node3D.new()
	cam_yaw_node.add_child(cam_pitch_node)
	arm = SpringArm3D.new()
	arm.spring_length = 4.2
	arm.margin = 0.25
	arm.add_excluded_object(player.get_rid())
	cam_pitch_node.add_child(arm)
	cam = Camera3D.new()
	cam.fov = 70
	cam.far = 9000
	arm.add_child(cam)

## A stand-in person (animated models come next): legs, body, vest, head, a gun.
func _make_person(vest: Color) -> Node3D:
	var root := Node3D.new()
	var mk := func(mesh: Mesh, col: Color, pos: Vector3) -> MeshInstance3D:
		var mi := MeshInstance3D.new()
		mi.mesh = mesh
		var m := StandardMaterial3D.new(); m.albedo_color = col; m.roughness = 0.85
		mi.material_override = m
		mi.position = pos
		root.add_child(mi)
		return mi
	var leg := CapsuleMesh.new(); leg.radius = 0.09; leg.height = 0.9
	mk.call(leg, Color(0.24, 0.25, 0.27), Vector3(0.1, 0.45, 0))
	mk.call(leg, Color(0.24, 0.25, 0.27), Vector3(-0.1, 0.45, 0))
	var torso := CapsuleMesh.new(); torso.radius = 0.2; torso.height = 0.75
	mk.call(torso, Color(0.33, 0.36, 0.24), Vector3(0, 1.2, 0))
	var v := BoxMesh.new(); v.size = Vector3(0.44, 0.36, 0.3)
	mk.call(v, vest, Vector3(0, 1.28, 0))
	var head := SphereMesh.new(); head.radius = 0.13; head.height = 0.28
	mk.call(head, Color(0.85, 0.66, 0.5), Vector3(0, 1.72, 0))
	var gun := BoxMesh.new(); gun.size = Vector3(0.06, 0.1, 0.7)
	mk.call(gun, Color(0.1, 0.1, 0.11), Vector3(-0.24, 1.3, 0.3))
	return root

# ------------------------------------------------------------------ network
func _on_open() -> void:
	_status("Connected — joining…")
	net.send({ "t": "join", "name": _profile().name, "token": _profile().token })

func _profile() -> Dictionary:
	var p := {}
	if FileAccess.file_exists("user://profile.json"):
		p = JSON.parse_string(FileAccess.get_file_as_string("user://profile.json"))
	if not p.has("token"):
		var hex := ""
		var c := Crypto.new()
		for b in c.generate_random_bytes(16): hex += "%02x" % b
		p.token = hex
	if not p.has("name"): p.name = "Agent%d" % (randi() % 9000 + 1000)
	return p

func _save_profile(name: String) -> void:
	var p := _profile()
	p.name = name
	var f := FileAccess.open("user://profile.json", FileAccess.WRITE)
	f.store_string(JSON.stringify(p))

func _on_message(m: Dictionary) -> void:
	match m.get("t", ""):
		"welcome":
			my_id = m.id
			player.position = Vector3(m.x, world.height(m.x, m.z), m.z)
			yaw = m.get("yaw", 0.0)
			if m.get("firstDeploy", false):
				net.send({ "t": "deploy", "kind": "lz", "id": randi() % 25 })
			elif m.get("deploy") != null:
				_show_respawn(true)
			in_game = true
			_status("")
		"deployed":
			_show_respawn(false)
			_toast("Deployed — 10 seconds of spawn protection")
		"correct":
			player.position.x = m.x; player.position.z = m.z
			player.position.y = world.height(m.x, m.z)
			if m.get("force", false): tp = int(m.get("tp", tp))
		"you":
			me = m
			hp_bar.max_value = m.get("maxHp", 100); hp_bar.value = m.get("hp", 0)
			ammo_label.text = "%d / %d" % [m.get("mag", 0), m.get("ammo", 0)]
			if m.get("dead", false): _show_respawn(true)
		"died":
			_show_respawn(true)
			_toast("Killed by %s" % m.get("by", "?"))
		"toast":
			_toast(m.text)
		"snap":
			_on_snap(m)
			if OS.get_environment("DEADZONE_AUTOPLAY") == "1" and Engine.get_process_frames() % 40 == 0:
				print("SNAP players=%d bots=%d me=%s tiles=%d cells=%d" % [m.get("players", []).size(), m.get("bots", []).size(), player.position, world.tiles.size(), world.cells.size()])
		"shot":
			_on_shot(m)

func _on_snap(m: Dictionary) -> void:
	var now := Time.get_ticks_msec()
	var seen := {}
	for p in m.get("players", []):
		if p.id == my_id: continue
		seen[p.id] = true
		_track(p, "player", now)
	for b in m.get("bots", []):
		seen[b.id] = true
		_track(b, "animal" if b.get("kind", "") in ["deer", "hog", "boar", "gator"] else "bot", now)
	for id in others.keys():
		if not seen.has(id):
			others[id].node.queue_free(); others.erase(id)

func _track(p: Dictionary, kind: String, now: int) -> void:
	if not others.has(p.id):
		var col := Color(0.6, 0.31, 0.13) if kind == "player" else (Color(0.45, 0.35, 0.25) if kind == "animal" else Color(0.14, 0.12, 0.17))
		var node := _make_person(col)
		var label := Label3D.new()
		label.text = str(p.get("name", ""))
		label.position.y = 2.3
		label.billboard = BaseMaterial3D.BILLBOARD_ENABLED
		label.font_size = 48
		label.pixel_size = 0.004
		label.modulate = Color(1, 0.55, 0.45) if kind == "bot" else Color(1, 0.75, 0.5)
		node.add_child(label)
		add_child(node)
		others[p.id] = { "node": node, "buf": [], "kind": kind, "data": p }
	var o = others[p.id]
	o.data = p
	o.buf.append({ "t": now, "x": float(p.x), "z": float(p.z), "yaw": float(p.get("yaw", 0.0)) })
	if o.buf.size() > 12: o.buf.pop_front()
	o.node.visible = not p.get("dead", false)

func _on_shot(m: Dictionary) -> void:
	var o: Array = m.o
	for h in m.hits:
		var a := Vector3(o[0], o[1], o[2])
		var b := Vector3(h[0], h[1], h[2])
		if m.get("from", "") == my_id:
			a = player.global_position + Vector3(0, 1.3, 0) + (b - a).normalized() * 0.8
		var len := a.distance_to(b)
		if len < 0.5: continue
		var mi := MeshInstance3D.new()
		var bm := BoxMesh.new(); bm.size = Vector3(0.03, 0.03, len)
		mi.mesh = bm
		var mat := StandardMaterial3D.new()
		mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
		mat.albedo_color = Color(1, 0.88, 0.6)
		mi.material_override = mat
		add_child(mi)
		mi.look_at_from_position((a + b) * 0.5, b, Vector3.UP)
		tracers.append([mi, 0.08])

# ------------------------------------------------------------------ frame
func _physics_process(dt: float) -> void:
	if not in_game:
		return
	var dead: bool = me.get("dead", false)
	# Move: stick or keys, relative to where you look.
	var mv := stick_vec
	if Input.is_physical_key_pressed(KEY_W): mv.y += 1
	if Input.is_physical_key_pressed(KEY_S): mv.y -= 1
	if Input.is_physical_key_pressed(KEY_A): mv.x -= 1
	if Input.is_physical_key_pressed(KEY_D): mv.x += 1
	if mv.length() > 1.0: mv = mv.normalized()
	var sprint := (stick_id >= 0 and stick_vec.length() > 0.95) or Input.is_physical_key_pressed(KEY_SHIFT)
	sprint = sprint and not aiming and mv.y > 0.3
	var speed := AIM_SPEED if aiming else (SPRINT if sprint else WALK)
	var fwd := Vector3(sin(yaw), 0, cos(yaw))
	var right := Vector3(-cos(yaw), 0, sin(yaw))
	var want := (fwd * mv.y + right * mv.x) * speed
	if dead: want = Vector3.ZERO
	var v := player.velocity
	var k := minf(1.0, dt * (11.0 if mv.length() > 0.05 else 9.0))
	v.x += (want.x - v.x) * k; v.z += (want.z - v.z) * k; v.y = 0
	player.velocity = v
	player.move_and_slide()
	player.position.y = world.height(player.position.x, player.position.z)
	# Camera: over the shoulder, closer and zoomed while aiming.
	cam_yaw_node.rotation.y = yaw + PI
	cam_pitch_node.rotation.x = pitch
	arm.spring_length = lerpf(arm.spring_length, 1.4 if aiming else 4.2, minf(1.0, dt * 10))
	arm.position.x = lerpf(arm.position.x, 0.55 if aiming else 0.85, minf(1.0, dt * 10))
	cam.fov = lerpf(cam.fov, 45.0 if aiming else (76.0 if sprint else 70.0), minf(1.0, dt * 8))
	body_vis.rotation.y = yaw
	world.update(player.position.x, player.position.z)
	# Fire.
	if firing and not dead: _try_fire()
	if not firing: fired_this_press = false
	# Tell the server where you are, 20 times a second.
	var now := Time.get_ticks_msec() / 1000.0
	if now - last_send > 0.05 and not dead:
		last_send = now
		net.send({ "t": "state", "tp": tp, "x": snappedf(player.position.x, 0.001), "z": snappedf(player.position.z, 0.001), "yaw": yaw, "pitch": pitch, "crouch": false, "prone": false, "aim": aiming, "sprint": sprint })

func _process(dt: float) -> void:
	# Everyone else, drawn a tenth of a second behind, gliding between updates.
	var t := Time.get_ticks_msec() - SMOOTH_MS
	for id in others:
		var o = others[id]
		var b: Array = o.buf
		if b.is_empty(): continue
		var x: float = b[-1].x; var z: float = b[-1].z; var y: float = b[-1].yaw
		if b.size() >= 2 and t < b[-1].t:
			var i := b.size() - 2
			while i > 0 and b[i].t > t: i -= 1
			var a = b[i]; var c = b[i + 1]
			var f := clampf((t - a.t) / maxf(1.0, c.t - a.t), 0, 1)
			x = lerpf(a.x, c.x, f); z = lerpf(a.z, c.z, f); y = lerp_angle(a.yaw, c.yaw, f)
		o.node.position = Vector3(x, world.height(x, z), z)
		o.node.rotation.y = y
	for i in range(tracers.size() - 1, -1, -1):
		tracers[i][1] -= dt
		if tracers[i][1] <= 0:
			tracers[i][0].queue_free(); tracers.remove_at(i)
	if toast_until > 0 and Time.get_ticks_msec() > toast_until:
		toast_label.text = ""; toast_until = 0

func _try_fire() -> void:
	var w = me.get("inv", {}).get(me.get("active", "primary"))
	if w == null: return
	var a = arsenal.get(w.archetype, {})
	var semi: bool = a.get("semi", false)
	if semi and fired_this_press: return
	var now := Time.get_ticks_msec() / 1000.0
	if now - last_shot < 60.0 / float(a.get("rpm", 600)): return
	if int(me.get("mag", 0)) <= 0:
		if not fired_this_press: net.send({ "t": "reload" })
		fired_this_press = true
		return
	last_shot = now
	fired_this_press = true
	# Aim point: what the crosshair is on (walls, ground, people), from the camera.
	var o := cam.global_position
	var d := -cam.global_transform.basis.z
	var best := 400.0
	var tid = null
	var space := get_world_3d().direct_space_state
	var q := PhysicsRayQueryParameters3D.create(o, o + d * 400.0)
	q.exclude = [player.get_rid()]
	var hit := space.intersect_ray(q)
	if hit: best = o.distance_to(hit.position)
	best = minf(best, world.ray_ground(o, d, best))
	for id in others:
		var p: Vector3 = others[id].node.position
		var t := (p - o).dot(d)
		if t <= 0 or t > best: continue
		var c := o + d * t
		if Vector2(c.x - p.x, c.z - p.z).length() < 0.45 and c.y > p.y and c.y < p.y + 1.9:
			best = t; tid = id
	var at := o + d * best
	var eye := player.position + Vector3(0, STAND_EYE, 0)
	var dir := (at - eye).normalized()
	var msg := { "t": "shoot", "dir": [dir.x, dir.y, dir.z], "at": [snappedf(at.x, 0.01), snappedf(at.y, 0.01), snappedf(at.z, 0.01)] }
	if tid != null: msg.tid = tid
	net.send(msg)
	me.mag = int(me.get("mag", 1)) - 1
	ammo_label.text = "%d / %d" % [me.mag, me.get("ammo", 0)]
	pitch = clampf(pitch + 0.012, -1.2, 1.2)   # a little kick

# ------------------------------------------------------------------ input
func _unhandled_input(e: InputEvent) -> void:
	if not in_game: return
	if e is InputEventScreenTouch:
		if e.pressed:
			if e.position.x < get_viewport().get_visible_rect().size.x * 0.5 and stick_id < 0:
				stick_id = e.index; stick_origin = e.position; stick_vec = Vector2.ZERO
			elif look_id < 0 or true:
				look_id = e.index; look_last = e.position
		else:
			if e.index == stick_id: stick_id = -1; stick_vec = Vector2.ZERO
			if e.index == look_id: look_id = -1
		stick_draw.queue_redraw()
	elif e is InputEventScreenDrag:
		if e.index == stick_id:
			var dv: Vector2 = (e.position - stick_origin) / 70.0
			stick_vec = Vector2(dv.x, -dv.y).limit_length(1.2)
			stick_draw.queue_redraw()
		elif e.index == look_id:
			_look(e.position - look_last, 0.006)
			look_last = e.position
	elif e is InputEventMouseButton:
		if not mouse_captured and e.pressed:
			Input.mouse_mode = Input.MOUSE_MODE_CAPTURED; mouse_captured = true
			return
		if e.button_index == MOUSE_BUTTON_LEFT: firing = e.pressed
		if e.button_index == MOUSE_BUTTON_RIGHT: aiming = e.pressed
	elif e is InputEventMouseMotion and mouse_captured:
		_look(e.relative, 0.0028)
	elif e is InputEventKey and e.pressed:
		if e.physical_keycode == KEY_ESCAPE: Input.mouse_mode = Input.MOUSE_MODE_VISIBLE; mouse_captured = false
		if e.physical_keycode == KEY_R: net.send({ "t": "reload" })

func _look(rel: Vector2, sens: float) -> void:
	var s := sens * (cam.fov / 70.0)
	yaw -= rel.x * s
	pitch = clampf(pitch - rel.y * s, -1.2, 1.2)

# ------------------------------------------------------------------ UI
func _build_ui() -> void:
	ui = CanvasLayer.new()
	add_child(ui)
	var font_size := 22
	status = Label.new()
	status.position = Vector2(20, 16)
	status.add_theme_font_size_override("font_size", font_size)
	ui.add_child(status)
	toast_label = Label.new()
	toast_label.set_anchors_preset(Control.PRESET_CENTER_TOP)
	toast_label.position = Vector2(-300, 90); toast_label.size = Vector2(600, 40)
	toast_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	toast_label.add_theme_font_size_override("font_size", font_size)
	ui.add_child(toast_label)
	cross = Label.new()
	cross.text = "+"
	cross.set_anchors_preset(Control.PRESET_CENTER)
	cross.position = Vector2(-8, -18)
	cross.add_theme_font_size_override("font_size", 30)
	ui.add_child(cross)
	hp_bar = ProgressBar.new()
	hp_bar.set_anchors_preset(Control.PRESET_BOTTOM_LEFT)
	hp_bar.position = Vector2(20, -46); hp_bar.size = Vector2(260, 22)
	hp_bar.show_percentage = false
	var fill := StyleBoxFlat.new(); fill.bg_color = Color(0.86, 0.25, 0.25)
	hp_bar.add_theme_stylebox_override("fill", fill)
	ui.add_child(hp_bar)
	ammo_label = Label.new()
	ammo_label.set_anchors_preset(Control.PRESET_BOTTOM_RIGHT)
	ammo_label.position = Vector2(-430, -60)
	ammo_label.add_theme_font_size_override("font_size", 34)
	ui.add_child(ammo_label)
	stick_draw = Control.new()
	stick_draw.set_anchors_preset(Control.PRESET_FULL_RECT)
	stick_draw.mouse_filter = Control.MOUSE_FILTER_IGNORE
	stick_draw.draw.connect(func():
		if stick_id >= 0:
			stick_draw.draw_arc(stick_origin, 70, 0, TAU, 40, Color(1, 1, 1, 0.45), 3)
			stick_draw.draw_circle(stick_origin + Vector2(stick_vec.x, -stick_vec.y).limit_length(1.0) * 70, 26, Color(1, 1, 1, 0.5)))
	ui.add_child(stick_draw)
	btn_fire = _touch_button("FIRE", Vector2(-150, -170), Vector2(130, 130), Color(0.65, 0.12, 0.12, 0.6))
	btn_fire.button_down.connect(func(): firing = true)
	btn_fire.button_up.connect(func(): firing = false)
	btn_aim = _touch_button("AIM", Vector2(-290, -130), Vector2(96, 96), Color(0.1, 0.12, 0.15, 0.5))
	btn_aim.pressed.connect(func(): aiming = not aiming)
	btn_reload = _touch_button("RELOAD", Vector2(-130, -300), Vector2(96, 96), Color(0.1, 0.12, 0.15, 0.5))
	btn_reload.pressed.connect(func(): net.send({ "t": "reload" }))
	respawn_btn = Button.new()
	respawn_btn.text = "Come back at a town"
	respawn_btn.set_anchors_preset(Control.PRESET_CENTER)
	respawn_btn.position = Vector2(-170, 40); respawn_btn.size = Vector2(340, 64)
	respawn_btn.add_theme_font_size_override("font_size", 24)
	respawn_btn.visible = false
	respawn_btn.pressed.connect(func(): net.send({ "t": "deploy", "kind": "town", "id": randi() % 6 }))
	ui.add_child(respawn_btn)
	# Start: your name, then play.
	start_panel = PanelContainer.new()
	start_panel.set_anchors_preset(Control.PRESET_CENTER)
	start_panel.position = Vector2(-220, -120); start_panel.size = Vector2(440, 240)
	var box := VBoxContainer.new()
	box.add_theme_constant_override("separation", 14)
	var title := Label.new(); title.text = "DEADZONE"; title.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	title.add_theme_font_size_override("font_size", 40)
	name_edit = LineEdit.new(); name_edit.placeholder_text = "Your name"; name_edit.text = _profile().name
	name_edit.add_theme_font_size_override("font_size", 24)
	var play := Button.new(); play.text = "Play"; play.add_theme_font_size_override("font_size", 28)
	play.custom_minimum_size = Vector2(0, 64)
	play.pressed.connect(_on_play)
	box.add_child(title); box.add_child(name_edit); box.add_child(play)
	start_panel.add_child(box)
	ui.add_child(start_panel)
	_set_hud(false)

func _touch_button(text: String, pos: Vector2, size: Vector2, col: Color) -> Button:
	var b := Button.new()
	b.text = text
	b.set_anchors_preset(Control.PRESET_BOTTOM_RIGHT)
	b.position = pos; b.size = size
	var sb := StyleBoxFlat.new(); sb.bg_color = col; sb.set_corner_radius_all(int(size.x / 2)); sb.border_color = Color(1, 1, 1, 0.4); sb.set_border_width_all(2)
	for s in ["normal", "hover", "pressed", "focus"]: b.add_theme_stylebox_override(s, sb)
	b.add_theme_font_size_override("font_size", 20)
	b.focus_mode = Control.FOCUS_NONE
	ui.add_child(b)
	return b

func _set_hud(on: bool) -> void:
	for c in [hp_bar, ammo_label, cross, btn_fire, btn_aim, btn_reload]: c.visible = on

func _on_play() -> void:
	var nm := name_edit.text.strip_edges()
	if nm.length() < 2: nm = _profile().name
	_save_profile(nm)
	start_panel.visible = false
	_set_hud(true)
	_status("Connecting…")
	net.connect_to_world(1)

func _show_respawn(on: bool) -> void:
	respawn_btn.visible = on

func _status(t: String) -> void:
	status.text = t

func _toast(t: String) -> void:
	toast_label.text = t
	toast_until = Time.get_ticks_msec() + 3500
