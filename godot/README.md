# Deadzone: Godot client

A native client for the same game server (`server/`), which is unchanged: it connects to
`/world/<id>` like the web client and speaks the same JSON messages.

- `scripts/main.gd`: start screen, player, camera, controls (phone and keyboard/mouse), other
  players and Rogues, shooting, HUD.
- `scripts/world.gd`: the county from `map/`: ground tiles around you, a coarse whole-county ground,
  water, buildings and roads per 400 m cell, collision for walls near you.
- `scripts/net.gd`: the WebSocket connection (the web build connects back to the host that served
  it; native builds to the live server, or `DEADZONE_HOST`).
- `map/`: baked by `node tools/export_godot_map.mjs` from the same generator the server uses.

Build everything (map, web build into `web/`, served at `/g/`; APK with `ANDROID=1`):

    tools/build_godot.sh            # needs Godot 4.5.1 + export templates
    ANDROID=1 tools/build_godot.sh  # also needs apksigner/zipalign and a debug keystore

Milestone 1 (now): walk and run the real county, see everyone live, shoot. Next: animated character
models, trees, the full HUD (bag, map, contacts), vehicles and boats, sound.
