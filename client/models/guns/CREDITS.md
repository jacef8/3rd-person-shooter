# Gun models

From **Ultimate Guns** by Quaternius (https://quaternius.com/packs/ultimategun.html), CC0 1.0 (public
domain). Taken from the copy in https://github.com/series-ai/jam-ready-assets
(`quaternius-ultimate-guns/3D/weapons/`, with its `License.txt`: CC0-1.0).

| File | Source | Used for |
| --- | --- | --- |
| carbine.glb | Guns/AssaultRifle2_1 | Assault rifle (game key `carbine`) |
| smg.glb | Guns/SubmachineGun_2 | SMG |
| dmr.glb | Guns/SniperRifle_6, scope taken off by `tools/build_dmr.mjs` | Marksman rifle |
| shotgun.glb | Guns/Shotgun_1 | Shotgun |
| lmg.glb | Guns/AssaultRifle2_3 | LMG |
| sidearm.glb | Guns/Pistol_5 | Sidearm |
| scope1-3.glb | Accessories/Scope_1-3 | Magnified optics |
| silencer.glb, silencerShort.glb | Accessories/Silencer_1, Silencer_Short | Suppressors |
| grip.glb | Accessories/Grip | Vertical grips |

Unchanged files apart from dmr.glb; `client/gunmodel.js` turns, scales and places them, and puts the gunsmith's other
parts on them. The rocket launcher is still built in code.
