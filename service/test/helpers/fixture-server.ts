import http from 'node:http';
import type { AddressInfo } from 'node:net';

/** Minimal valid one-page PDF. */
const PDF = Buffer.from(
  '%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n' +
    '4 0 obj<</Length 44>>stream\nBT /F1 24 Tf 20 100 Td (Hello PDF) Tj ET\nendstream endobj\n' +
    '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R/Size 6>>\n%%EOF',
);

export interface FixtureServer {
  url: string;
  port: number;
  hits: Map<string, number>;
  close(): Promise<void>;
}

/**
 * A local web site with the kinds of pages the capture code has to cope with. Nothing leaves the machine.
 * The `/never-answers`, `/hang-img` routes intentionally keep connections open until the server closes.
 */
export async function startFixtureServer(): Promise<FixtureServer> {
  const hits = new Map<string, number>();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fixture');
    const key = url.pathname + (url.pathname === '/img.png' ? `?${url.searchParams.get('i')}` : '');
    hits.set(key, (hits.get(key) ?? 0) + 1);

    const page = (body: string, title: string, status = 200) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta charset="utf-8"><title>${title}</title><body style="margin:0;font:20px sans-serif">${body}</body>`);
    };

    switch (url.pathname) {
      case '/ok':
        return page('<h1>Hello fixture</h1><p>An ordinary page.</p><a href="/page2">next</a><a href="/page3">third</a><a href="/ok#section">same page</a><a href="http://other.invalid/x">elsewhere</a>', 'OK page');
      case '/page2':
        return page('<h1>Page two</h1><a href="/ok">back</a>', 'Page two');
      case '/page3':
        return page('<h1>Page three</h1>', 'Page three');
      case '/title-chars':
        return page('<h1>Odd title</h1>', 'a<b>:"/\\|?*  日本語 🙂 CON');
      case '/tall': {
        const px = Number(url.searchParams.get('px') ?? 3000);
        const bands = Array.from({ length: Math.ceil(px / 500) }, (_, i) => `<div style="height:500px;background:hsl(${(i * 47) % 360} 70% 60%)">band ${i}</div>`).join('');
        return page(`<header style="position:fixed;top:0;left:0;right:0;height:40px;background:#000;color:#fff">FIXED</header>${bands}`, `Tall ${px}`);
      }
      case '/lazy':
        return page(
          '<h1>lazy</h1><div style="height:2500px"></div>' +
            [0, 1, 2].map((i) => `<img loading="lazy" width="300" height="200" src="/img.png?i=${i}">`).join(''),
          'Lazy page',
        );
      case '/img.png':
        res.writeHead(200, { 'content-type': 'image/svg+xml' });
        return void res.end('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><rect width="300" height="200" fill="green"/></svg>');
      case '/redirect-chain':
        res.writeHead(301, { location: '/redirect-chain-2' });
        return void res.end();
      case '/redirect-chain-2':
        res.writeHead(302, { location: '/ok' });
        return void res.end();
      case '/redirect-to':
        res.writeHead(302, { location: url.searchParams.get('target') ?? '/ok' });
        return void res.end();
      case '/status/404':
        return page('<h1 style="color:#b00">Custom 404</h1>', 'Not Found Page', 404);
      case '/status/500':
        return page('<h1>Custom 500</h1>', 'Server Error Page', 500);
      case '/download':
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="x.bin"' });
        return void res.end(Buffer.alloc(2000));
      case '/pdf':
        res.writeHead(200, { 'content-type': 'application/pdf' });
        return void res.end(PDF);
      case '/json':
        res.writeHead(200, { 'content-type': 'application/json' });
        return void res.end('{"hello":"world"}');
      case '/empty':
        res.writeHead(204);
        return void res.end();
      case '/basic-auth':
        res.writeHead(401, { 'www-authenticate': 'Basic realm="fixture"', 'content-type': 'text/html' });
        return void res.end('<h1>401</h1>');
      case '/slow': {
        const ms = Number(url.searchParams.get('ms') ?? 1500);
        return void setTimeout(() => page('<h1>slow</h1>', 'Slow page'), ms);
      }
      case '/frame':
        // An app that fills the viewport exactly, like a dashboard: a red frame sits on the very edge of the viewport, so a
        // screenshot that is padded, cropped or mis-scaled shows up as a missing or short frame.
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return void res.end(
          '<!doctype html><meta charset="utf-8"><title>Frame</title><style>html,body{margin:0;height:100%;background:#fff}' +
            '#app{position:fixed;inset:0;border:8px solid #e00;box-sizing:border-box;background:#fff;display:flex;align-items:center;justify-content:center;font:700 36px sans-serif;color:#06c}</style>' +
            '<div id="app"></div><script>app.textContent=innerWidth+" x "+innerHeight</script>',
        );
      case '/frame-tall':
        // A document taller than the viewport with a red frame around the WHOLE document and a fixed header.
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return void res.end(
          '<!doctype html><meta charset="utf-8"><title>Tall frame</title><style>html,body{margin:0}' +
            'body{min-height:3000px;border:8px solid #e00;box-sizing:border-box;background:linear-gradient(#fff,#cfe)}' +
            '#hdr{position:fixed;top:8px;left:8px;right:8px;height:40px;background:#036;color:#fff;font:700 24px sans-serif}</style><div id="hdr">FIXED HEADER</div>',
        );
      case '/never-answers':
        return; // the connection stays open
      case '/never-load':
        return page('<h1>The load event never fires</h1><img src="/hang-img">', 'Never-load page');
      case '/hang-img':
        return;
      case '/dialog':
        return page('<script>alert("hello");</script><h1>after the alert</h1>', 'Dialog page');
      case '/popup':
        return page('<script>window.open("/page2","_blank");</script><h1>opens a popup</h1>', 'Popup page');
      case '/spa':
        return page('<div id="app">loading…</div><script>setTimeout(()=>{document.getElementById("app").innerHTML="<h1>Rendered by script</h1>"},700)</script>', 'SPA page');
      default:
        res.writeHead(404, { 'content-type': 'text/plain' });
        return void res.end('not found');
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    hits,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
