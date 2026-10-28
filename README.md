# Browser Screenshot Automation & Gallery

Capture screenshots of a list of web pages with **Microsoft Edge**, save them on **your own computer**, and browse them in a gallery.

* The **web page** (React) is the control panel. It can be hosted on **GitHub Pages**.
* The **local service** (Node.js, Express, Playwright) runs **on your Windows computer**. It drives your installed Edge and stores the files.

> **Important: the local service is required.** A web page, including one on GitHub Pages, cannot open or control a browser by
> itself. All browser automation is done by the service running on your computer. If the service is not running, the web page
> says so and cannot capture anything.

There is no cloud storage and no database. Screenshots, the list of screenshots (a JSON file) and browser profiles live in
folders on your computer. Nothing is uploaded anywhere.

```
 GitHub Pages (or your own computer)           Your Windows computer
┌───────────────────────────────┐   HTTP on   ┌──────────────────────────────────────────┐
│  Web page (frontend/)         │ ──────────► │  Local service (service/) 127.0.0.1:4577 │
│  forms, progress, gallery     │  127.0.0.1  │   ├─ Playwright ──► Microsoft Edge       │
└───────────────────────────────┘  + token    │   ├─ screenshots/  (PNG files)           │
                                              │   └─ data/index.json (metadata)          │
                                              └──────────────────────────────────────────┘
```

---

## Contents

1. [What you need](#1-what-you-need)
2. [Quick start (about five minutes)](#2-quick-start)
3. [Using the application](#3-using-the-application)
4. [Signing in to websites](#4-signing-in-to-websites-headed-mode-and-profiles)
5. [Development](#5-development)
6. [Deploying the web page to GitHub Pages](#6-deploying-the-web-page-to-github-pages)
7. [Configuration reference](#7-configuration-reference)
8. [Security model](#8-security-model)
9. [Troubleshooting](#9-troubleshooting)
10. [Project layout](#10-project-layout)

---

## 1. What you need

| Requirement | Notes |
|---|---|
| Windows 10 or 11 | The scripts are `.bat` files. The service itself is plain Node.js. |
| **Microsoft Edge** (stable) | Already part of Windows. The service uses the copy that is installed; **no browser is downloaded**. |
| **Node.js 22.12 or newer** | LTS from <https://nodejs.org/en/download>. Check with `node --version`. |
| A GitHub account | Only if you want to host the web page on GitHub Pages. You can also run the page on your own computer. |

### Microsoft Edge: installation and detection

Edge is installed with Windows 10/11. If it was removed, install it from <https://www.microsoft.com/edge>.

The service finds it in the standard places (`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`, `C:\Program Files\…`, and
`%LOCALAPPDATA%\…`). Playwright uses its `msedge` channel, **not** Chrome and not a separately downloaded Chromium.

* Check detection at any time: the service prints the detected Edge version when it starts, and **Settings → Service details** shows the path.
* Edge installed somewhere unusual? Set `EDGE_PATH` in `service/.env`, for example  
  `EDGE_PATH=D:\Apps\Edge\Application\msedge.exe`.

### Playwright setup

Nothing extra. The service depends on `playwright-core`, which drives the Edge that is already installed. You do **not** run
`npx playwright install`, and no browser binaries are downloaded.

---

## 2. Quick start

### Step 1 — Get the project

Download the repository (green **Code** button → **Download ZIP**) and extract it somewhere, for example `C:\Tools\screenshot-gallery`.
Paths with spaces or accented letters are fine. Or with git:

```powershell
git clone https://github.com/<your-name>/<your-repo>.git
cd <your-repo>
```

### Step 2 — Install the service (once)

Double-click **`scripts\windows\install.bat`**. It checks Node.js and Edge, installs the packages, builds the service and creates `service\.env`.

### Step 3 — Start the service

Double-click **`scripts\windows\start-service.bat`** and keep the window open. It prints something like:

```
  Listening on   http://127.0.0.1:4577  (this computer only)
  Browser        Microsoft Edge 155.0.4283.62
  PAIRING TOKEN (paste it into the web page under Settings):
  1W4l68rd4xu9Yis6YBJSbNnO5Akqz8-P_o1IT7vfge8
```

### Step 4 — Open the web page and pair it

Pick one:

**A. The hosted page on GitHub Pages** (after [you deployed it](#6-deploying-the-web-page-to-github-pages))

1. In `service\.env` set `ALLOWED_ORIGINS=https://<your-name>.github.io` and (optional, for a one-click link)
   `FRONTEND_URL=https://<your-name>.github.io/<your-repo>/`. Restart the service.
2. Open the page → **Settings** → paste the pairing token → **Save and connect**.
   With `FRONTEND_URL` set, the service window prints a pairing link you can open instead.
3. Edge may ask whether this site may access devices on your computer. Choose **Allow**. This is Edge's *Local Network Access*
   protection: it is what lets a web page talk to the service on your computer, and nothing leaves your computer.

**B. The page on your own computer** (no GitHub, and no browser permission prompt)

Double-click **`scripts\windows\start-dev.bat`**. It starts the service and the page; open the address it prints
(`http://127.0.0.1:5173`, or the next free port). Pair with the token as above.

> Use **B** if your browser or a company policy blocks websites from reaching your computer. A page served from `127.0.0.1` needs no permission.

### Step 5 — Capture

On the **Dashboard**, paste some addresses (one per line), press **Start Automation**, and watch the progress bar. Screenshots appear in the **Gallery** as each page is saved.
Try [`examples\urls.txt`](examples/urls.txt) for a ready-made list.

---

## 3. Using the application

### Dashboard — Automation settings

| Setting | What it does |
|---|---|
| Browser | Microsoft Edge (the only supported browser). |
| Browser mode | **Headed** shows the Edge window while it works, **maximized** to fill the screen; **Headless** runs in the background. |
| Screenshot mode | **Full page** captures top to bottom; **Visible viewport** captures what fits in the window (in headed mode that is the maximized window, so the image size follows your screen). |
| Page scale | The browser's zoom, applied when the browser opens, in **headless and headed** mode. `100` is normal; `50` fits twice as much of the page on screen, `200` shows less, larger. Whole numbers from 25 to 500. See [Page scale](#page-scale-and-yesterdays-date). |
| Initial URL / Web addresses | One address per line. Lines starting with `#` are ignored; duplicates are removed. Addresses without `https://` get it added. `{$prevday}` is replaced with yesterday's date (see below). A new browser starts with two example addresses. |
| Follow links between pages | After each page, also visit the links found on it. |
| Maximum number of pages | Total pages captured, including your addresses. |
| Stay on the same site | Only follow links to the same origin (scheme + host + port). On by default. |
| Page load timeout | Give up on a page after this many seconds (1–120). |
| Extra wait after loading | Seconds to wait after the page loads, for content that draws late. |
| Delay between pages | A pause before the next page. |
| Output folder | A sub-folder of the screenshots folder. Letters, digits, spaces and `. _ - ( )` only; never an absolute path. |

Under **Sign-in and advanced options**: saved browser profile, pause for manual sign-in, scroll before full-page capture, ignore certificate errors.

### Page scale and yesterday's date

**Page scale** behaves like pressing Ctrl + / Ctrl − in Edge before the page loads, so the website itself lays out for the zoomed size.

| Mode | How it is applied | Screenshot size |
|---|---|---|
| Headless | The page is laid out in a window of `size ÷ scale` and drawn at `scale` pixels per CSS pixel. | Exact: a 50 % full-page capture is 2560 px wide when the base window is 1280. |
| Headed, 100 % or less | Edge's own zoom, set in the profile before it opens. | Within one pixel of the page's own layout size. |
| Headed, above 100 % | Edge's own zoom. | **Smaller than the page**, and the gallery card shows a warning saying so. This is a limit of how Playwright converts a zoomed window's screenshot; use Headless for an exact image at a larger scale. |

For a headed run the zoom is written into the browser profile's preferences just before Edge starts, and it is written again with the scale you choose on every headed run. With a **saved profile** that means the profile's default zoom is left at the last scale used in a headed run; it never affects headless runs (they use emulation) and the next headed run sets it again. Zoom levels you set per website in that profile are cleared so they cannot override the scale. Sign-ins and cookies in the profile are not touched.

**`{$prevday}`** in a web address is replaced, when you press **Start**, with **yesterday's date** in the form `yyyy-MM-dd` (for example `2026-10-27` on 28 October 2026). It uses your computer's own calendar and time zone, not UTC, so it is correct just after midnight. Every occurrence is replaced, case does not matter, and the percent-encoded spelling `%7B%24prevday%7D` works too. The page shows a preview of the resulting addresses above the Start button, and the screenshot's stored address is the real one that was opened.

A new browser starts with these two addresses (the Dynatrace problem list for yesterday, open and closed):

```
https://aaj23525.live.dynatrace.com/ui/problems?gtf={$prevday}T00:00:00%2B08:00%20to%20{$prevday}T23:59:00%2B08:00&gf=3826532857493469977
https://aaj23525.live.dynatrace.com/ui/problems?gtf={$prevday}T00:00:00%2B08:00%20to%20{$prevday}T23:59:00%2B08:00&gf=3826532857493469977&status=CLOSED
```

If you already had a saved form with an empty address list, it gets these once; after that, whatever you put in the list (including nothing) is kept. **Clear URL list** empties it.

### Controls

* **Start Automation** — captures every page automatically once it has loaded and the waiting time has passed. You never press a button per page.
* **Stop Automation** — ends the run within a second or two. Screenshots already saved are kept; the page in progress is abandoned.
* **Clear URL list** — empties the address fields.
* **Clear Gallery** — deletes all screenshots (after confirmation).

The panel shows pages done / total and a percentage, the current address and step, successful and failed counts, and — for failures — what went wrong with each address.

### What counts as success

| Page | Result |
|---|---|
| Normal page, redirects | Captured. The final address is stored. |
| HTTP 404 / 500 pages that render | Captured, marked **warning** with the status code. |
| A page whose "load" event never finishes | Captured after the timeout, marked **warning**. |
| Very tall pages | Captured up to `MAX_FULLPAGE_HEIGHT` (30,000 px by default), marked **warning**. |
| Downloads, no-content pages, DNS/connection/certificate/timeout errors, sites needing a password | **Failed**: listed with the reason; no image is stored. |
| Addresses on your own computer or private network | **Blocked** unless you allow them (see [Security](#8-security-model)). |

### Gallery

Thumbnail cards show the title, address, capture date/time, pixel size, and **Preview / Download / Delete** buttons. Click a thumbnail to open a large preview (arrow keys move between screenshots, Esc closes).
Select several cards to **Download selected** or **Delete selected**; **Download all (ZIP)** packs everything into one file; **Clear all** empties the gallery after confirmation. Sort by newest, oldest or page title.

ZIP files contain the PNGs (file names use only ASCII letters so Windows' own `tar` can extract them) plus `index.csv` with the full titles and addresses.

### Where files are stored

| What | Where (default) |
|---|---|
| Screenshots (PNG) | `service\screenshots\` — file names like `20261027-143005-123_Example-Domain_a1b2.png` |
| Gallery index (JSON) | `service\data\index.json` (with a `.bak` copy) |
| Thumbnails (cache) | `service\data\thumbs\` |
| Saved Edge profiles | `service\data\profiles\<name>\` |
| Pairing token | `service\data\pairing-token.txt` (readable only by you) |

Change the screenshot folder with `SCREENSHOTS_DIR` in `service\.env`. All of these are excluded from git. If the index is ever damaged it is set aside and rebuilt from the backup or the PNG files.

---

## 4. Signing in to websites (headed mode and profiles)

Pages behind a login need a signed-in browser.

1. On the Dashboard choose **Browser mode: Headed**.
2. Turn on **Use a saved browser profile** (give it a name, for example `work`).
3. Turn on **Pause so I can sign in first**.
4. Start. Edge opens the first address. **Sign in in the Edge window**, then press **Continue** on the Dashboard.
5. Later runs with the same profile are already signed in.

**Single sign-on, multi-factor prompts and CAPTCHAs** usually cannot be completed in headless mode. Sign in once in headed mode; the saved profile then keeps the session for headless runs as long as the site keeps it valid.

The profile is **separate from your everyday Edge profile** — it is never your real one. Its cookies stay in `service\data\profiles\` on your computer and are never sent to GitHub Pages or anywhere else. Delete a profile under **Settings → Saved browser profiles**. A profile can only be used by one run at a time.

---

## 5. Development

```powershell
# service (Node.js + Express + Playwright)
cd service
npm install
npm run dev          # restarts on changes (tsx watch)
npm run typecheck
npm test             # unit and API tests; no browser needed
npm run test:e2e     # drives the real Microsoft Edge on this computer

# web page (React + Vite + Tailwind)
cd ..\frontend
npm install
npm run dev          # http://127.0.0.1:5173 (next free port if taken)
npm run typecheck
npm test
npm run build        # production build in frontend\dist

# whole product in real Edge (needs both built; see e2e\ui-flow.mjs)
cd ..\e2e
npm install
node ui-flow.mjs --shots %TEMP%\ss3-shots
```

**Shared files.** The API contract (`service/src/shared/contract.ts`) and the address parser (`url-input.ts`) are the source of truth in `service/`; the web page keeps identical copies in `frontend/src/api/` so it can be built on its own. After editing them run `node scripts/sync-shared.mjs`. A test and the CI fail if the copies drift.

**Tech notes.** TypeScript 7, Vite 8, React 19, Tailwind CSS 4, Express 5, zod 4, Vitest 5. Live updates use Server-Sent Events read with `fetch`, because the browser's `EventSource` cannot send the token header.

---

## 6. Deploying the web page to GitHub Pages

The workflow `.github/workflows/deploy-pages.yml` builds `frontend/` and publishes it. It **never** deploys the service.

1. Push the repository to GitHub (`main` branch).
2. In the repository: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Push to `main` (or run the workflow from the **Actions** tab). The page appears at  
   `https://<your-name>.github.io/<your-repo>/`.

The workflow computes the Vite `base` path for you: `/<your-repo>/` normally, and `/` for a repository named `<your-name>.github.io`.
Serving from a **custom domain** at its root? Add a repository variable **`PAGES_BASE`** with the value `/` (Settings → Secrets and variables → Actions → Variables).

Then tell your local service which page may use it, in `service\.env`:

```
ALLOWED_ORIGINS=https://<your-name>.github.io
```

Restart the service. (This is the *origin* — scheme, host, no path.) Commands to publish from a fresh clone:

```powershell
git init -b main
git add .
git commit -m "Screenshot gallery"
git remote add origin https://github.com/<your-name>/<your-repo>.git
git push -u origin main
```

A GitHub Pages site is public; the page itself contains no secrets (the token is typed in by you and never stored in the source).

---

## 7. Configuration reference

All optional. Copy `service\.env.example` to `service\.env` (the installer does this) and edit.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `4577` | Port on `127.0.0.1`. |
| `ALLOWED_ORIGINS` | *(empty)* | Websites allowed to use the service, exact origins, comma separated. |
| `ALLOW_LOCALHOST_ORIGINS` | `true` | Also allow pages served from `localhost` / `127.0.0.1` (for `start-dev.bat`). |
| `FRONTEND_URL` | *(empty)* | If set, the start-up message prints a one-click pairing link. |
| `PAIRING_TOKEN` | *(random)* | Fixed token. Leave empty to generate and store one. |
| `SCREENSHOTS_DIR` | `screenshots` | Where PNGs are saved. |
| `DATA_DIR` | `data` | Index, thumbnails, profiles, token. |
| `EDGE_PATH` | *(auto)* | Full path to `msedge.exe`. |
| `MAX_FULLPAGE_HEIGHT` | `30000` | Taller pages are cut off at this height (px). |
| `ALLOW_PRIVATE_TARGETS` | `false` | Allow capturing `localhost` / private-network addresses. |
| `ALLOWED_TARGET_HOSTS` | *(empty)* | Allow only these host names even though private targets are blocked. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`, `silent`. |

Web page: the service address and the form values are kept in your browser's local storage (preferences only — **never** screenshots). The pairing token is kept for the tab only unless you tick *Remember the token on this device*. `frontend\.env.example` lists the one build-time setting, `VITE_BASE`.

---

## 8. Security model

The service is designed so that only **you**, from a page **you allowed**, can use it:

* **Loopback only.** It listens on `127.0.0.1` and refuses to start on any other address. Other computers cannot reach it.
* **Pairing token.** Every endpoint except `/api/health` needs `Authorization: Bearer <token>`. The token is 256 random bits, compared in constant time, stored in a file only you can read, and never printed except in the start-up window. Repeated wrong tokens are slowed down (HTTP 429). The token is **not** in the page source: you paste it in.
* **Origin allow-list.** Only the exact origins in `ALLOWED_ORIGINS` (and local development pages) get CORS access; any other website receives `403`. CORS is not trusted alone — the token is still required.
* **Host check.** Requests whose `Host` header is not `127.0.0.1`/`localhost` are rejected (`421`), which defeats DNS-rebinding attacks.
* **No request forgery (SSRF).** The browser is only sent to `http(s)` addresses. By default addresses on your computer or private network (`localhost`, `192.168.x.x`, `10.x.x.x`, `169.254.169.254`, IPv6 equivalents) are blocked — **including after redirects and for frames inside pages**, and after DNS resolution. Set `ALLOW_PRIVATE_TARGETS=true` only if you want to capture local or intranet pages.
* **Safe file paths.** Output folders are validated (no absolute paths, `..`, drive letters, reserved Windows names); stored file names and IDs are validated again on every access; links and junctions that point outside the screenshots folder are refused.
* **Local data stays local.** Images are fetched with the token and shown from `blob:` URLs, so the token is never in a URL, log or `Referer`. Nothing is sent to GitHub Pages, analytics or cloud storage.
* **A separate browser profile.** Automation never touches your everyday Edge profile.

### Why does Edge ask for permission on the hosted page?

Recent Edge/Chrome versions protect your computer from websites by asking before a page may talk to devices or programs on it (*Local Network Access*). When the hosted page first contacts the service, Edge shows a prompt — choose **Allow**. If you chose *Block*, click the lock icon next to the address → **Site settings** → set **Local network access** to *Allow*, then reload. Managed computers can be pre-approved with the Edge policy `LocalNetworkAccessAllowedForUrls`. If that is not possible, use `start-dev.bat` to serve the page from your own computer.

---

## 9. Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| The page says **"The local service is not reachable"** | The service is not running, or the address in **Settings** is wrong. Run `start-service.bat`; the default address is `http://127.0.0.1:4577`. |
| The page says **"Waiting for permission"** | Edge is showing (or hid) its *allow access to devices on your computer* prompt. Look near the address bar and choose **Allow**. |
| Connected before, now **"Your browser blocked access to your computer"** | You blocked the permission. Lock icon → Site settings → *Local network access* → Allow. Or use `start-dev.bat`. |
| **"The service does not allow this website"** | Add the page's origin to `ALLOWED_ORIGINS` in `service\.env` (for example `https://you.github.io`) and restart the service. |
| **"Pairing token was not accepted"** | Copy the token again from the service window (or `service\data\pairing-token.txt`). After 10 wrong tries wait a minute. |
| **"Microsoft Edge was not found"** | Install Edge, or set `EDGE_PATH` in `service\.env`. `Settings → Service details` shows what was detected. |
| **"The running service is an older version…"**, or the red message `Unrecognized key: "pageScalePercent"` | The page was updated but the service was still running the code it started with. Close the service window (or press Ctrl+C in it, or run `stop-service.bat`) and start it again with `start-service.bat`. The page, not the service, updates by itself in `start-dev.bat`, so after any update restart the service. At the default 100 % page scale an older service still works; any other scale needs the restart. |
| **"Port 4577 is already in use"** | Another copy of the service is running. Run `stop-service.bat`, or set a different `PORT` (and the same port in the page's Settings). |
| **"This browser profile is already open"** | A previous run's Edge window is still open, or another run uses that profile name. Close it, or choose another name. |
| A page fails with **"Blocked"** | It points at `localhost` or a private address. Set `ALLOW_PRIVATE_TARGETS=true` (or list the host in `ALLOWED_TARGET_HOSTS`) if that is intended. |
| **"Sign-in required"** | The site asks for a user name/password. Use Headed mode with a saved profile and sign in manually (see [section 4](#4-signing-in-to-websites-headed-mode-and-profiles)). |
| **"Certificate problem"** | The site's certificate is invalid or self-signed. If you trust the site, tick *Ignore certificate errors*. |
| A **full-page capture is cut off** | The page is taller than `MAX_FULLPAGE_HEIGHT`. Raise it in `service\.env` (up to 100000). |
| Images look **blank in the lower part** | The page loads content as you scroll. Keep *Scroll the page before a full-page capture* on and add *Extra wait*. |
| `install.bat` closes immediately | Open a Command Prompt, run it there, and read the message. Usually Node.js is missing or too old. |
| Thumbnails are **full-size images** | The optional `sharp` module could not be installed. Everything works; thumbnails are just larger. |
| ZIP extracts with missing names in old tools | Names are ASCII by design. Open `index.csv` inside the ZIP for the real titles. |
| Page works locally but the **deployed page is blank** | The base path is wrong. For a project site it must be `/<repo>/`; for a custom domain set the `PAGES_BASE` variable to `/`. |

Run the service with `LOG_LEVEL=debug` for more detail. Nothing in the logs contains the pairing token.

---

## 10. Project layout

```
.
├─ service/                  Local automation service (Node.js, Express, Playwright)
│  ├─ src/                   index.ts, server.ts, config.ts, http/, automation/, browser/, storage/, shared/
│  ├─ test/                  unit + API tests;  test/e2e/ drives real Edge
│  └─ .env.example           settings template (copy to .env)
├─ frontend/                 Web page (React, TypeScript, Vite, Tailwind)
│  ├─ src/                   pages/, components/, api/, state/, lib/
│  └─ .env.example           build setting template
├─ e2e/                      Whole-product test in real Edge (page + service + Edge)
├─ scripts/
│  ├─ windows/               install.bat, start-service.bat, start-dev.bat, stop-service.bat
│  └─ *.mjs                  helpers used by the .bat files and the workflows
├─ examples/urls.txt         Example address list
├─ docs/                     SPEC.md (requirements), FINDINGS.md (verified facts)
└─ .github/workflows/        deploy-pages.yml (GitHub Pages), ci.yml (checks)
```

Verified behaviour of Edge, Playwright and the browser's local-network rules, with the experiments behind each decision, is in [`docs/FINDINGS.md`](docs/FINDINGS.md).
