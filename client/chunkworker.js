// Builds the near world's buildings off the page's thread, so walking or driving into new ground
// doesn't stall the game while hundreds of walls, roofs and pieces of furniture are laid out.
// The page sends a chunk's boxes and building records; this sends back flat typed arrays (handed
// over, not copied), which the page only has to wrap as meshes.
import { buildChunkBuffers, chunkTransfer } from '/chunkgeo.js';

self.onmessage = (e) => {
  const { id, req } = e.data;
  try {
    const out = buildChunkBuffers(req);
    self.postMessage({ id, out }, chunkTransfer(out));
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
