# Animal models

Built by `tools/build_animals.mjs`. Each file is one skinned mesh in metres, facing +Z, feet on y = 0,
centred on x/z, with clips named `idle`, `walk`, `run`, `death` (plus the extras listed).

| File | Source | Author | Licence |
| --- | --- | --- | --- |
| deer.glb | `Deer.glb` from the **Ultimate Animated Animal Pack**, https://quaternius.com/packs/ultimateanimatedanimals.html, taken from the copy in https://github.com/trebeljahr/quaternius-showcase (`public/glb/animals_pack/`) | Quaternius | CC0 1.0 (public domain) |
| dog.glb | `ShibaInu.glb` from the same pack and copy | Quaternius | CC0 1.0 (public domain) |
| horse.glb | `Horse.glb` from the same pack and copy (the horse you ride) | Quaternius | CC0 1.0 (public domain) |
| hog.glb | `Pig_Pink_01` from the **Microsoft Rocketbox** avatar library, https://github.com/microsoft/Microsoft-Rocketbox (`Assets/Animals/Pig_Pink_01/Export/Pig_Pink_01.fbx`, `Textures/Pig_pink_color.tga`) | Microsoft (Rocketbox Studios) | MIT (notice below) |
| gator.glb | Modelled and animated in code by `tools/build_animals.mjs` for this project (no free alligator could be found) | this project | same as the project |

**Changes**

- **deer.glb**: clips kept and renamed `Idle` -> `idle`, `Walk` -> `walk`, `Gallop` -> `run`,
  `Death` -> `death`, `Eating` -> `eat`; the rest dropped. Recoloured as a white-tailed deer (tan-brown
  coat, white belly, throat and inner legs) and its seven flat-colour materials baked into vertex
  colours, so it is one primitive with one material. Scaled to 1.5 m to the ear tips (~1.0 m at the
  shoulder, 1.54 m long), keyframes resampled, vertices quantized.
- **dog.glb**: clips `idle`, `walk`, `run` (`Gallop`), `death`, `attack`; recoloured to a brown dog
  with a tan muzzle, chest and legs; materials baked into vertex colours; scaled to 0.7 m to the ear
  tips (~0.5 m at the shoulder, 0.94 m long).
- **horse.glb**: clips `idle`, `walk`, `run` (`Gallop`), `death`, `eat`; a bay horse (its browns
  kept, black mane and tail); materials baked into vertex colours; scaled to 2.3 m to the ear tips
  with its head up (~1.6 m at the withers, 2.7 m long).
- **hog.glb**: the rigged but unanimated farm pig, read with three.js's FBXLoader. Its colour map
  regraded from pink to a dark, grizzled feral-hog brown-black and shrunk to 512 px JPEG; the bump and
  specular maps left out. The clips `idle`, `walk`, `run` and `death` were keyframed for it in the
  build script. Centimetres to metres: 0.73 m tall, 1.36 m long.
- **gator.glb**: built from scratch: a lofted body with scute rows and a double tail crest, a
  hinged lower jaw, eyes and sprawled five/four-toed legs, coloured with vertex colours (near-black
  olive back, cream belly), 24 bones; clips `idle`, `walk`, `run`, `attack` (jaw snap) and `death`
  (rolls belly-up). 2.9 m long.

### Microsoft Rocketbox licence (MIT)

```
MIT License

Copyright (c) 2020 Microsoft

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
