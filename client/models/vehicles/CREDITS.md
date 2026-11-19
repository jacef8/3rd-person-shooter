# Vehicle models

Microsoft **Remix 3D** models, released by Microsoft as CC0 (public domain) when Remix 3D closed;
taken from the copies in the Ethereal / IR Engine open asset kit,
https://github.com/ir-engine/ir-engine-assets-basic (`assets/cars/`; its `assets/AUTHOR.MD` records
"Remix 3D retirement - All items CC0 Microsoft & Remix 3D").

| File | Source |
| --- | --- |
| sedan.glb | Sedan.glb |
| suv.glb | SUV.glb |
| classic.glb | RavenRancherBlue.glb |
| pickup.glb | PickupTruck.glb |
| motorcycle.glb | Motorcycle.glb |
| bus.glb | PublicBus.glb |
| tractor.glb | see below |

**Changes** (`tools/build_vehicles.mjs`): specular-glossiness materials converted to metal-roughness,
the parts baked into one mesh, triangles cut to 7,000-9,000, textures shrunk to JPEG, and each set to
one unit long with its front at +Z and its wheels on the ground. The game scales each to the ride it
stands in for, and fades and dusts the roadside wrecks.

## tractor.glb

`tractor.glb` from **Kenney's Car Kit**, https://kenney.nl/assets/car-kit (Kenney, www.kenney.nl),
licensed **CC0 1.0** (public domain); taken from the copy of Kenney's kits at
https://github.com/shorepine/kenney (`3d/car/tractor.glb` with `3d/car/Textures/colormap.png`).
Changed by `tools/build_vehicles.mjs` as above, and its body moved from the grey swatch of its colour
sheet to the red one.
