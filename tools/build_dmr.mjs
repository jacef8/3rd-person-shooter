// Scoped rifles with the scope taken off: the marksman rifles (deer rifle: SniperRifle_6; Mini-14: SniperRifle_2),
// from Quaternius "Ultimate Guns" (CC0; client/models/guns/CREDITS.md),
// a wood-stocked bolt-style hunting rifle, with its built-in scope taken off (the lens pieces, and the
// tube and rings above the receiver) so the gunsmith's sights go on it like on every other gun.
// Usage: node tools/build_dmr.mjs <SniperRifle_6.glb> [out = client/models/guns/dmr.glb]
import { NodeIO } from '@gltf-transform/core';
import { prune } from '@gltf-transform/functions';

const [src, out = 'client/models/guns/dmr.glb'] = process.argv.slice(2);
const CUT_Y = 0.40;   // the receiver's top in the model's own units: everything wholly above it is the scope
const io = new NodeIO();
const doc = await io.read(src);
for (const mesh of doc.getRoot().listMeshes()) {
  for (const prim of mesh.listPrimitives()) {
    if (/glass/i.test(prim.getMaterial()?.getName() || '')) { mesh.removePrimitive(prim); prim.dispose(); continue; }
    const pos = prim.getAttribute('POSITION'), idx = prim.getIndices();
    if (!idx) continue;
    const keep = [], v = [0, 0, 0];
    const y = (i) => (pos.getElement(i, v), v[1]);
    for (let t = 0; t < idx.getCount(); t += 3) {
      const a = idx.getScalar(t), b = idx.getScalar(t + 1), c = idx.getScalar(t + 2);
      if (Math.min(y(a), y(b), y(c)) > CUT_Y) continue;
      keep.push(a, b, c);
    }
    idx.setArray(new (idx.getArray().constructor)(keep));
  }
}
await doc.transform(prune());
await io.write(out, doc);
console.log('wrote', out);
