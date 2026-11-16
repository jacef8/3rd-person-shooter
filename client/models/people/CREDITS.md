# People models

All of these come from **Mixamo** (Adobe, https://www.mixamo.com): its characters and animations are
free to use, royalty-free, in personal and commercial projects, games included. They reached this
project through two public repositories, rebuilt by `tools/build_people.mjs`:

- **Characters** `swat1`, `swat2`, `swat3` (SWAT officers) and `james`, `liza`, `remy` (civilians):
  from https://github.com/MaxiGarcia13/conter-strai (Apache-2.0), `assets/glb/characters/`
  `soldiers/swat-1..3.glb` and `civilians/{james,liza,remy}.glb`.
- **Animations** (rifle aiming idle, rifle hold, idle, sprint, crouch idle, and 8-way rifle walk,
  run and crouch-walk): from https://github.com/chetansinghsajwan/unity-titanfall (MIT),
  `Assets/Charcters/Animations/Locomotions/*.fbx`.

**Changes:** each character keeps only its mesh and skin, with fewer triangles (about 22,000) and its
textures shrunk (colour 1024 px JPEG, others 512 px; hair and lashes cut-outs as PNG). The clips are
read with three.js's FBXLoader, the hips keys turned to the characters' armature, the other bones'
positions and every scale dropped, and packed into `anims.glb`.
