#!/usr/bin/env node
// A static server that behaves like GitHub Pages for the checks: dist/ under /backroad-rally/, gzip for text types
// only (HTML, JS, CSS, JSON, SVG; binaries go as they are), `Cache-Control: max-age=600`, ETag and 304s.
// (`vite preview` 404s module scripts with Vite 8, and python's http.server neither compresses nor sends max-age,
// so load times and caching measured through either differ from the live site.)
//
//   node tools/check/serve.mjs [--port 4173] [--dir dist] [--base /backroad-rally/]
import { createServer } from 'node:http';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { extname, join, normalize, resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : d;
};
const port = Number(arg('--port', '4173'));
const dir = resolve(arg('--dir', 'dist'));
const base = arg('--base', '/backroad-rally/');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.glb': 'model/gltf-binary', '.bin': 'application/octet-stream',
  '.gz': 'application/gzip', '.opus': 'audio/ogg', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.woff2': 'font/woff2', '.png': 'image/png', '.wasm': 'application/wasm', '.txt': 'text/plain',
};
const TEXT = new Set(['.html', '.js', '.css', '.json', '.svg', '.txt']);
const gzCache = new Map();

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (!url.pathname.startsWith(base)) {
    res.writeHead(404).end();
    return;
  }
  let rel = decodeURIComponent(url.pathname.slice(base.length)) || 'index.html';
  if (rel.endsWith('/')) rel += 'index.html';
  const file = normalize(join(dir, rel));
  if (!file.startsWith(dir)) {
    res.writeHead(403).end();
    return;
  }
  let st;
  try {
    st = statSync(file);
  } catch {
    res.writeHead(404).end();
    return;
  }
  const ext = extname(file);
  const etag = `"${st.size.toString(16)}-${st.mtimeMs.toString(16)}"`;
  const headers = { 'Content-Type': TYPES[ext] ?? 'application/octet-stream', 'Cache-Control': 'max-age=600', ETag: etag, 'Last-Modified': st.mtime.toUTCString() };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers).end();
    return;
  }
  if (TEXT.has(ext) && /\bgzip\b/.test(req.headers['accept-encoding'] ?? '')) {
    let gz = gzCache.get(file);
    if (!gz || gz.etag !== etag) gzCache.set(file, (gz = { etag, body: gzipSync(readFileSync(file)) }));
    res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip', 'Content-Length': gz.body.length, Vary: 'Accept-Encoding' }).end(req.method === 'HEAD' ? undefined : gz.body);
    return;
  }
  // ranges for the streamed music (<audio> seeks)
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (range) {
    const start = range[1] ? Number(range[1]) : st.size - Number(range[2]);
    const end = range[1] && range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
    res.writeHead(206, { ...headers, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') res.end();
    else createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, 'Accept-Ranges': 'bytes', 'Content-Length': st.size });
  if (req.method === 'HEAD') res.end();
  else createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => console.log(`serving ${dir} at http://127.0.0.1:${port}${base}`));
