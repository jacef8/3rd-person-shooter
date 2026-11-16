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

**Changes** (`tools/build_vehicles.mjs`): specular-glossiness materials converted to metal-roughness,
the parts baked into one mesh, triangles cut to 7,000-9,000, textures shrunk to JPEG, and each set to
one unit long with its front at +Z and its wheels on the ground. The game scales each to the ride it
stands in for, and fades and dusts the roadside wrecks.
