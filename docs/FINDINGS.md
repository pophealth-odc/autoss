# Verified findings

Facts established by running experiments on the target machine (Windows 11, Node 24.18, Microsoft Edge 155.0.4283.62,
Playwright 1.64.1). Where a design decision depends on one of these, it is listed here so it can be re-checked when
Edge or Playwright changes.

## Calling the local service from a hosted (GitHub Pages) page

| Situation | Result in Edge 155 |
|---|---|
| HTTPS page on another origin, `fetch('http://127.0.0.1:PORT')`, permission not yet decided | The request is held while Edge shows its **Local Network Access** prompt. Nothing reaches the service until the user allows it. |
| Same, permission **granted** | Works. Normal CORS preflight + request; the service sees `Origin` and the `Authorization` header. |
| Same, permission **denied** | Fails immediately with `TypeError: Failed to fetch`. The service sees nothing. |
| Page served from `http://localhost:PORT` or `http://127.0.0.1:PORT` (for example `npm run preview`) | Works with **no prompt**. |

* The page's JavaScript sees the same `TypeError: Failed to fetch` for *service not running*, *permission denied*
  and *CORS rejected*. The browser console has the real reason. `navigator.permissions.query({name:'local-network-access'})`
  is the only signal that separates "denied" from the rest.
* `fetch(..., { targetAddressSpace: 'loopback' })` is accepted for `127.0.0.1`. The value `'local'` is rejected with
  an explicit "target address space mismatch" error, so never pass `'local'` for loopback addresses.
* The permission names `local-network-access`, `loopback-network` and `local-network` all exist in `navigator.permissions`
  and change together. Playwright can only grant `local-network-access`.
* The first connection attempt can hang for as long as the prompt is open, so the UI must not use a short timeout
  for it and must tell the user to look for the prompt.
* Managed devices can pre-allow the site with the Edge policy `LocalNetworkAccessAllowedForUrls`
  (also `LoopbackNetworkAllowedForUrls`), available since Edge 140.

## Playwright and Edge

* `chromium.launch({ channel: 'msedge' })` uses the installed Edge; no browser download is needed. Launch takes ~0.3 s.
* A second persistent context on a profile that is open fails with the unhelpful "Target page, context or browser has been
  closed". While a profile is open, `<profile>/lockfile` exists and opening it fails with `EBUSY`; the lock disappears
  after a clean close *and* after a hard kill, so there are no stale locks. The service checks this before launching.
* If the browser process dies mid-navigation, `page.goto` rejects with "Target page, context or browser has been closed" and
  `page.close`, `context.close`, `browser.disconnected` all fire.
* `context.route()` does **not** see redirect hops, so it cannot enforce an address policy. The CDP `Fetch` domain at the
  request stage does: every hop of a redirect chain, iframes and popups are paused and can be refused before any request
  leaves the machine (verified: the "internal" server received zero requests). Cost: ~4 ms per navigation.
* A route/event handler that throws crashes the Node process. Every browser-event handler in the service catches its own errors.
* `--block-new-web-contents` does not stop `window.open`; an init script that replaces `window.open` does, and extra tabs
  (including Edge's `edge://downloads-hub/` tab opened for downloads) are closed after each page.
* Navigating to a download rejects with "Download is starting". HTTP 204 rejects with `net::ERR_ABORTED`. HTTP 401
  rejects with `net::ERR_INVALID_AUTH_CREDENTIALS`. Redirects to `file:`, `data:`, `edge:` fail with `net::ERR_UNSAFE_REDIRECT`;
  a direct `page.goto('file:///...')` would succeed, which is why URLs are validated before navigation.
* HTTP 404/500 pages render and can be screenshotted. A page whose `load` event never fires (a hanging image) times out on
  `goto` but is still usable and can be captured; a server that never answers leaves the page unusable.
* 40,000 px tall full-page screenshots work (1.1 s). `fullPage` combined with `clip` produces a height-limited capture.
* Chromium refuses to connect to "unsafe" ports (for example 1, 25, 6000) regardless of the service's own policy.

## Maximized headed windows

Checked in Edge 155 on a display scaled to 250 % (`devicePixelRatio` 2.5):

* `--start-maximized` opens the window maximized for fresh and saved profiles, and for every new tab. CDP
  `Browser.setWindowBounds` with `windowState: 'maximized'` also works and is used as a safety net.
* A context with a fixed `viewport` keeps the **page emulated at that size inside the maximized window** (1280 x 720 in a
  1550 x 830 window). A headed run therefore needs `viewport: null` so the page fills the window.
* Playwright throws when `deviceScaleFactor` is combined with `viewport: null`. With a null viewport the screen's own scaling
  applies, so screenshots must use `scale: 'css'` (already the case): without it a 1527 px wide viewport became a 3820 px image.
* Headless has no window; it keeps the requested viewport and a device scale factor of 1.

## Page scale (browser zoom)

Measured in Edge 155 on a display scaled to 250 % (nominal `devicePixelRatio` 2.5):

* **Headless** has no window, so the zoom is emulated: viewport `size / scale` with `deviceScaleFactor = scale`. Layout, media
  queries and `scale: 'css'` screenshots then match a zoomed browser exactly (50 % of 1280 x 720 -> 2560 x 1440, ratio 0.5).
* **Headed** uses Edge's own zoom. Playwright has no zoom API; Edge honours the default zoom stored in the profile's
  `Default/Preferences` (`partition.default_zoom_level.x`, a level where scale = 1.2 ^ level) when the file is written before
  the browser starts. Per-site zoom levels in the same file override it, so they are cleared.
* In a zoomed headed window `devicePixelRatio` scales WITH the zoom (2.5 -> 1.25 at 50 %, 5 at 200 %). Playwright's
  `scale: 'css'` conversion divides by the nominal 2.5, so the image is off by exactly the zoom factor (50 % -> twice as
  large, 200 % -> half). A `clip` of `layout x zoom` corrects it when zoomed OUT (50 % -> 3055 x 1370 for a 3056 x 1370
  layout); zoomed IN the clip is clamped to the visible region. Overriding the device metrics through DevTools does not help:
  Edge applies its zoom on top again (the layout doubled at 50 %). Capturing at device resolution and resampling works but a
  full-page 50 % capture of a tall page exceeds sharp's pixel limit on a high-density display. Zoomed-in headed captures are
  therefore taken as they are and flagged with a warning.
* A headed run without a saved profile now runs on a temporary profile folder (so the zoom can be written before launch); it
  is deleted after the browser has closed.

## White area in a screenshot (the page does not fill the image)

Reproduced with a saved profile whose Preferences held a per-site zoom for the website, as the user's Dynatrace profile did
(`partition.per_host_zoom_levels` = `-1.22`, about 80 %). Measured with a red frame on the page's edge and the decoded PNG:

* A zoom Edge **remembers for a website overrides** both the default zoom and the requested page scale (requested 50 % and
  100 % both gave the 80 % layout). The layout was 1910 x 856 inside a 2386 x 1069 image: the page filled only the top-left
  80 %, the rest was blank. Headless was affected too: layout 1600 x 900 squeezed into a 1280 x 720 image.
* Edge keeps those levels in `partition.per_host_zoom_levels`; clearing only `profile.per_host_zoom_levels` (an older Chromium
  location) does nothing. Both are now emptied before every launch with a saved profile, headless and headed.
* The applied zoom can be read from the page whatever its cause: `outerWidth / innerWidth` (window width is zoom-free, layout
  width is zoomed) gave 1.005, 0.503, 2.010 and 0.804 for 100 %, 50 %, 200 % and a site zoom of 80 %. Capture uses this
  measurement, not the requested percentage, as a safety net.
* In a visible window the **first full-page screenshot** of a page is taken from the old layout and changes it (the scrollbar
  column goes away: `clientWidth` 1513 -> 1528 on a 250 % display), so it comes out 1 px narrower and 2 px shorter than the
  page (1512 x 2998 for a 1513 x 3000 page). Every later capture is exact. A viewport screenshot and waiting do not trigger the
  change; a tiny full-page screenshot does, so one is taken before measuring.
* Size checks cannot see this defect (the image dimensions were valid). The tests decode the PNG and locate the frame.

## ZIP files

* `archiver` 8 is ESM-only (`import { ZipArchive } from 'archiver'`), has no bundled types (`@types/archiver` 8 is separate).
* Entries with non-Latin names are valid UTF-8 ZIP entries and `Expand-Archive` extracts them, but the `tar` that ships with
  Windows (bsdtar) prints "Archive entry has empty or unreadable filename" on a Western code page. ZIP entry names are
  therefore ASCII-only; the full Unicode titles are kept in `index.csv` inside the archive.

## Windows file system

* Renaming over one destination from many writers at once fails with `EPERM`; writes to one file are serialised.
* Node mode bits are ignored on Windows; the pairing token file is restricted with `icacls /inheritance:r /grant:r USER:F`.

## Toolchain (all verified together)

TypeScript 7.0.2 (native compiler), Vite 8, Vitest 5, Express 5.3, zod 4.6, archiver 8, sharp 0.35 (prebuilt binary, no compiler),
tsx 4.23, Node 24 with `process.loadEnvFile()`.
