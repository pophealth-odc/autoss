# End-to-end checks

These scripts test the **whole product in real Microsoft Edge**: the built web page (served exactly as GitHub Pages serves it,
under a sub-path, with no single-page-app fallback), the real local service, real Edge automation, and the gallery.
They need Windows with Edge installed. They use throw-away folders and ports on `127.0.0.1` and never touch your own Edge profile.

Prepare once (from the repository root):

```powershell
cd service;  npm ci; npm run build
cd ..\frontend; npm ci
$env:VITE_BASE = '/screenshot-gallery/'; npx vite build --outDir dist-pages   # the sub-path build the checks serve
cd ..\e2e; npm ci
```

| Command | What it proves |
|---|---|
| `npm test` | 44 checks of the full user flow: honest "not connected" states, the default addresses and the `{$prevday}` preview, pairing link, validation, a three-page run, progress, gallery cards, thumbnails, sort, preview, downloads, ZIP, reload persistence, delete/clear confirmations, Stop, and the page noticing that the service stopped. |
| `npm run test:responsive` | 42 checks at desktop, laptop, tablet and phone widths (and 320 px): no horizontal scrolling, navigation reachable, buttons large enough. |
| `npm run test:dev-script` | Runs `scripts\windows\start-dev.bat`: the page picks a free port, the service starts, and a page served from this computer pairs without a browser permission prompt. Needs port 4577 free. |
| `npm run test:maximize` | A headed run through an isolated copy of the service: Windows itself reports the Edge window as maximized and the screenshot fills it. A maximized window appears for a few seconds. |
| `npm run test:scale` | 22 checks through the HTTP API of an isolated service: `{$prevday}` becomes yesterday's date before the browser opens the address, and the page scale reaches headless and headed browsers with the right screenshot sizes. Headed runs open a window briefly. |

| `npm run test:fill` | The "white area" defect, measured in the saved PNG files: a real run through an isolated service with a saved profile that remembers an 80 % zoom for the website. A red frame on the page's edge must reach all four edges of the image, headless and headed, viewport and full page. Image dimensions alone cannot show this defect, which is why earlier size checks did not catch it. |
| `npm run test:old-service` | The built page against a stand-in **older** service (no feature list, strict about unknown settings), as when the page was updated but the service was not restarted: the default scale still works, any other scale is explained ("start the service again"), and the raw `Unrecognized key` message never appears. |
| `npm run test:current-service` | The built page against a **current** service: the page scale is sent, applied, and the screenshot has the scaled size. |

`isolated-service.mjs` starts the throw-away copy of the service these checks use (random port, temporary folders, its own token). They never touch a service you are running. `dashboard-shot.mjs` and `localhost-check.mjs` are helpers for looking at the Dashboard and for confirming a running page can pair with a running service.

Add `-- --shots <folder>` to `npm test` / `npm run test:responsive` to save screenshots of each step for a visual review.

The service's own browser tests (`cd service; npm run test:e2e`) cover redirects, request-forgery blocking, downloads, hung pages, dialogs, pop-ups, persistent profiles and process clean-up.
