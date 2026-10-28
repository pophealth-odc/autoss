// End-to-end check of the reported defect: a screenshot that has a WHITE AREA because the page does not fill the image.
//
// A real run through the HTTP API of an ISOLATED copy of the service (random port, temporary folders, its own token), with a
// saved browser profile that remembers an 80 % zoom for the website - exactly what the user's profile held for their Dynatrace
// site. A red frame sits on the very edge of the page, so any white area shows up as red that does not reach the image edge.
// The saved PNG FILE is decoded and measured; image dimensions alone cannot show this defect.
//
//   node fill-check.mjs
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import { startIsolatedService } from './isolated-service.mjs';

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  - ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Decodes an 8-bit RGB/RGBA PNG into raw pixels, without any image library. */
function decodePng(png) {
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20), colorType = png[25];
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!channels || png[24] !== 8) throw new Error(`unsupported PNG (type ${colorType})`);
  const idat = [];
  for (let p = 8; p < png.length; ) {
    const len = png.readUInt32BE(p);
    if (png.toString('ascii', p + 4, p + 8) === 'IDAT') idat.push(png.subarray(p + 8, p + 8 + len));
    p += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? out[y * stride + x - channels] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? out[(y - 1) * stride + x - channels] : 0;
      const v = raw[src + x];
      let r;
      if (filter === 0) r = v;
      else if (filter === 1) r = v + a;
      else if (filter === 2) r = v + b;
      else if (filter === 3) r = v + ((a + b) >> 1);
      else { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); r = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      out[y * stride + x] = r & 255;
    }
  }
  return { width, height, channels, data: out };
}

/** Does the red frame reach all four edges of the image? */
function frame(png) {
  const d = decodePng(png);
  const red = (x, y) => { const i = (y * d.width + x) * d.channels; return d.data[i] > 200 && d.data[i + 1] < 60 && d.data[i + 2] < 60; };
  const midY = d.height >> 1, midX = d.width >> 1;
  let left = -1, right = -1, top = -1, bottom = -1;
  for (let x = 0; x < d.width; x += 1) if (red(x, midY)) { if (left < 0) left = x; right = x; }
  for (let y = 0; y < d.height; y += 1) if (red(midX, y)) { if (top < 0) top = y; bottom = y; }
  const t = 3;
  return { width: d.width, height: d.height, left, right, top, bottom, fills: left >= 0 && left <= t && right >= d.width - 1 - t && top >= 0 && top <= t && bottom >= d.height - 1 - t };
}

// The "dashboard": an app that fills the whole window, like Dynatrace does, with the long query string of the real URLs.
const site = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><meta charset="utf-8"><title>Problems - Dashboard</title><style>html,body{margin:0;height:100%;background:#fff}' +
    '#app{position:fixed;inset:0;border:8px solid #e00;box-sizing:border-box;background:#fff;font:700 28px sans-serif;color:#06c;padding:24px}</style><div id="app">Problems</div>');
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${site.address().port}`;
const ADDRESS = `${base}/ui/problems?gtf={$prevday}T00:00:00%2B08:00%20to%20{$prevday}T23:59:00%2B08:00&gf=3826532857493469977&status=CLOSED`;

let svc;
try {
  svc = await startIsolatedService();
  console.log(`      isolated service at ${svc.url} (temporary folders; yours is not involved)`);

  // A saved profile that remembers an 80 % zoom for the site, like the user's.
  const profileDir = path.join(svc.dir, 'data', 'profiles', 'dyna');
  fs.mkdirSync(path.join(profileDir, 'Default'), { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'Default', 'Preferences'), JSON.stringify({ partition: { per_host_zoom_levels: { x: { '127.0.0.1': { last_modified: '13437642747453333', zoom_level: -1.2239 } } } } }));

  const runs = [
    { label: 'headless, viewport', mode: 'headless', screenshotMode: 'viewport' },
    { label: 'headless, full page', mode: 'headless', screenshotMode: 'fullPage' },
    { label: 'headed,   viewport', mode: 'headed', screenshotMode: 'viewport' },
    { label: 'headed,   full page', mode: 'headed', screenshotMode: 'fullPage' },
  ];
  for (const r of runs) {
    const start = await svc.api('POST', '/api/automation/start', {
      urls: [ADDRESS], mode: r.mode, screenshotMode: r.screenshotMode, persistentProfile: true, profileName: 'dyna', extraWaitMs: 800, delayBetweenPagesMs: 0, autoScroll: false,
    });
    if (start.status !== 202) { check(`${r.label}: the run starts`, false, JSON.stringify(start.json)); continue; }
    let status;
    for (let i = 0; i < 160; i += 1) { await sleep(500); status = (await svc.api('GET', '/api/automation/status')).json; if (status && !status.active) break; }
    const items = (await svc.api('GET', '/api/gallery')).json.items;
    const item = items.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))[0];
    if (!item || status?.state !== 'completed') { check(`${r.label}: the run captured a page`, false, status?.message); continue; }
    const file = path.join(svc.dir, 'shots', item.folder, item.filename);
    const f = frame(fs.readFileSync(file));
    console.log(`      ${r.label}: image ${f.width}x${f.height}, red frame x ${f.left}..${f.right} y ${f.top}..${f.bottom}`);
    check(`${r.label}: the page fills the whole image (no white area)`, f.fills, `frame x ${f.left}..${f.right} of ${f.width}, y ${f.top}..${f.bottom} of ${f.height}`);
    check(`${r.label}: the recorded size equals the real size of the saved file`, item.width === f.width && item.height === f.height, `${item.width}x${item.height} vs ${f.width}x${f.height}`);
    await svc.api('DELETE', `/api/gallery/${item.id}`);
  }
} catch (error) {
  check('check completed', false, error instanceof Error ? error.message : String(error));
} finally {
  await svc?.stop();
  site.closeAllConnections();
  site.close();
}
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed.`);
process.exit(failed ? 1 : 0);
