// Static files for the hub and the world servers. Text (HTML, JS, CSS, JSON) is gzipped once and
// cached, which matters on a phone: the game's code and the real-world map data are a few
// megabytes raw. Data that is stored compressed (elevation.bin lives on disk as elevation.bin.gz)
// is sent as it is, and the browser unpacks it.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.md': 'text/plain; charset=utf-8' };
const TEXT = new Set(['.html', '.js', '.css', '.json', '.svg', '.webmanifest', '.md']);
const zipped = new Map();   // file -> { mtimeMs, gz }
const GZ = { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' };

/** Serve `url` from the first [prefix, directory] root it falls under. False if it's under none. */
export function serveStatic(req, res, url, roots) {
  for (const [prefix, dir] of roots) {
    if (!url.startsWith(prefix)) continue;
    const file = path.join(dir, url.slice(prefix.length) || 'index.html');
    if (!file.startsWith(dir)) return false;
    send(req, res, file);
    return true;
  }
  return false;
}

function send(req, res, file) {
  const ext = path.extname(file), type = MIME[ext] || 'application/octet-stream';
  const gzipOk = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
  const notFound = () => { res.writeHead(404); res.end('Not found'); };
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      // Stored compressed.
      return fs.readFile(`${file}.gz`, (e2, gz) => {
        if (e2) return notFound();
        if (gzipOk) { res.writeHead(200, { 'Content-Type': type, ...GZ }); return res.end(gz); }
        zlib.gunzip(gz, (e3, raw) => { if (e3) return notFound(); res.writeHead(200, { 'Content-Type': type }); res.end(raw); });
      });
    }
    fs.readFile(file, (e2, data) => {
      if (e2) return notFound();
      if (!gzipOk || !TEXT.has(ext) || data.length < 1024) { res.writeHead(200, { 'Content-Type': type }); return res.end(data); }
      const hit = zipped.get(file);
      const done = (gz) => { res.writeHead(200, { 'Content-Type': type, ...GZ }); res.end(gz); };
      if (hit && hit.mtimeMs === st.mtimeMs) return done(hit.gz);
      zlib.gzip(data, { level: 6 }, (e3, gz) => {
        if (e3) { res.writeHead(200, { 'Content-Type': type }); return res.end(data); }
        zipped.set(file, { mtimeMs: st.mtimeMs, gz });
        done(gz);
      });
    });
  });
}
