# People models

- **What:** the outfits Swat, Worker, Farmer, Punk, Adventurer, Casual Character and Beach Character,
  and their shared skeleton and animations, from the **Ultimate Modular Men** pack.
- **Author:** Quaternius (https://quaternius.com/packs/ultimatemodularcharacters.html), also
  published on Poly Pizza (e.g. Swat: https://poly.pizza/m/Btfn3G5Xv4).
- **License:** CC0 1.0 Universal (public domain), https://creativecommons.org/publicdomain/zero/1.0/.
  Attribution isn't required; given anyway.
- **Changes** (`tools/build_characters.mjs`): each outfit file keeps only its mesh and skin (the
  animations are stripped, the vertex data quantized); `anims.glb` holds the skeleton and the 16
  clips the game plays, from the Swat file, resampled. The game recolours materials at runtime
  (skin tones, the Rogues' black gear).
- Swat.glb used as the source has SHA-256
  `a835107bac833eb916c494e10997ae1709e85957ea6f6c59ace3c9a66f6d1fec`, the same file Poly Pizza serves.
