## The connection to a Deadzone world server: the same JSON messages the web client sends and gets.
extends Node

signal message(m: Dictionary)
signal opened
signal closed

const DEFAULT_HOST := "deadzone-server-production-c9ff7400.up.railway.app"

var ws := WebSocketPeer.new()
var url := ""
var _was_open := false

func connect_to_world(world_id: int = 1) -> void:
	url = _base_url() + "/world/%d" % world_id
	ws = WebSocketPeer.new()
	ws.inbound_buffer_size = 4 * 1024 * 1024
	var err := ws.connect_to_url(url)
	if err != OK:
		push_warning("connect failed: %s" % err)

## On the web build, connect back to whatever host served the page; elsewhere, the live server.
func _base_url() -> String:
	if OS.has_feature("web"):
		var proto = JavaScriptBridge.eval("location.protocol")
		var host = JavaScriptBridge.eval("location.host")
		return ("wss://" if str(proto) == "https:" else "ws://") + str(host)
	var env := OS.get_environment("DEADZONE_HOST")
	if env != "":
		return env
	return "wss://" + DEFAULT_HOST

## The same server over http(s), for the map (/gmap/).
func http_base() -> String:
	var b := _base_url()
	return b.replace("wss://", "https://").replace("ws://", "http://")

func send(m: Dictionary) -> void:
	if ws.get_ready_state() == WebSocketPeer.STATE_OPEN:
		ws.send_text(JSON.stringify(m))

func is_open() -> bool:
	return ws.get_ready_state() == WebSocketPeer.STATE_OPEN

func _process(_dt: float) -> void:
	ws.poll()
	var st := ws.get_ready_state()
	if st == WebSocketPeer.STATE_OPEN:
		if not _was_open:
			_was_open = true
			opened.emit()
		while ws.get_available_packet_count() > 0:
			var txt := ws.get_packet().get_string_from_utf8()
			var m = JSON.parse_string(txt)
			if m is Dictionary:
				message.emit(m)
	elif st == WebSocketPeer.STATE_CLOSED and _was_open:
		_was_open = false
		closed.emit()
