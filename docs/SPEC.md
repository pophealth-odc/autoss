# Project: Browser Screenshot Automation & Local Gallery

> Original requirements, saved verbatim from the project brief. This file is the source of truth for scope.
> Derived documents: `docs/REQUIREMENTS.md` (atomic checklist), `docs/CONTRACT.md` (architecture + API contract).

Build a complete, responsive web application called **Browser Screenshot Automation & Gallery**.

## 1. Project objective

Create an application that automatically navigates through a list of web pages using Microsoft Edge, captures screenshots of each page, saves them to the user's local computer, and displays the captured images in an in-application gallery.

The application interface must be deployable to GitHub Pages. Because GitHub Pages cannot control a locally installed browser, implement a separate local automation service that runs on the user's Windows computer.

Do not use cloud storage or a database.

## 2. Technology stack

### Frontend
- React
- TypeScript
- Vite
- Tailwind CSS
- Responsive design for desktop and tablet
- Localhost API communication with the automation service

### Local automation service
- Node.js
- Express
- Playwright
- Microsoft Edge stable channel
- ZIP generation using a suitable Node.js library

Use Playwright's Microsoft Edge channel (`msedge`) rather than launching Google Chrome or a separate Chromium browser.

## 3. Application interface

Create a modern dashboard with the following sections:

### A. Automation settings
- Browser selection dropdown with Microsoft Edge as the only supported browser.
- Browser mode selection:
  - Headed: show the Edge window during automation.
  - Headless: run Edge in the background.
- Screenshot mode:
  - Full-page screenshot.
  - Visible viewport screenshot.
- Input field for the initial URL.
- Multiline input for multiple URLs, one URL per line.
- Optional setting to follow links between pages, with a configurable maximum number of pages and same-origin restriction by default.
- Page load timeout setting.
- Additional wait time after page loading.
- Delay between pages.
- Output folder setting, if supported by the local service.

### B. Automation controls
Include:
- Start Automation
- Stop Automation
- Clear URL List
- Clear Gallery

Automatically begin capturing each page after navigation and the configured waiting conditions are satisfied. Do not require the user to press a screenshot button for every page.

Display a progress bar showing completed pages, total pages, and percentage complete.

Show the current URL, current status, successful captures, and failed captures.

Support stopping the automation safely without losing screenshots already captured.

### C. Local screenshot gallery

Display screenshots in a responsive grid of thumbnail cards.

Each card must display:
- Screenshot thumbnail.
- Page title, when available.
- Source URL.
- Capture date and time.
- Image dimensions.
- Individual Download button.
- Delete button.
- Preview button.

Clicking a thumbnail should open a larger image preview in a modal.

Add options to:
- Select multiple screenshots.
- Download selected screenshots.
- Download all screenshots as a single ZIP file.
- Delete selected screenshots.
- Clear all screenshots after confirmation.
- Sort by newest, oldest, or page title.

The gallery must refresh after every successful screenshot capture.

## 4. Screenshot storage

Save screenshot files to a local directory on the user's computer, such as:

`./screenshots/`

Generate unique filenames containing a timestamp and a sanitized page title.

Maintain a local metadata index, such as a JSON file, containing the screenshot filename, page title, source URL, timestamp, dimensions, and capture status.

The JSON metadata file must remain local. Do not upload screenshots or metadata to GitHub Pages, external APIs, or cloud storage.

When the frontend is reopened, retrieve the gallery contents from the local automation service.

Do not use browser localStorage or IndexedDB as the primary screenshot storage mechanism.

## 5. Automatic browser navigation

Use Playwright to launch Microsoft Edge.

For each configured URL:

1. Navigate to the URL.
2. Wait for the page to reach an appropriate load state.
3. Wait for the configured additional delay.
4. Capture a full-page or viewport screenshot according to the selected setting.
5. Save the screenshot to the local screenshot directory.
6. Register its metadata.
7. Update the gallery and progress bar.
8. Continue to the next URL.

Handle redirects, timeouts, unavailable pages, and screenshot errors gracefully.

Do not assume every page can be captured successfully.

For pages that require authentication, allow the user to log in manually in headed mode. Support an optional persistent local Edge profile so the user can reuse an authenticated session. Store browser profile data locally and never transmit credentials or cookies to GitHub Pages.

Headless mode should be optional. Explain that some SSO, MFA, CAPTCHA, and interactive authentication flows may require headed mode and manual login.

## 6. Local automation API

Implement a local Express service with endpoints such as:

- `GET /api/health` — check whether the service is running.
- `POST /api/automation/start` — start the screenshot workflow.
- `POST /api/automation/stop` — stop the workflow.
- `GET /api/automation/status` — retrieve current progress.
- `GET /api/gallery` — retrieve screenshot metadata.
- `GET /api/gallery/:id/image` — retrieve a screenshot image.
- `GET /api/gallery/:id/download` — download an individual image.
- `POST /api/gallery/download-zip` — create and download a ZIP containing all screenshots or the selected screenshots.
- `DELETE /api/gallery/:id` — delete one screenshot.
- `DELETE /api/gallery` — clear the gallery.

Use WebSocket or Server-Sent Events to update progress in real time.

Validate all inputs and implement appropriate error handling.

Protect the local service against unauthorized requests, unsafe filesystem paths, and server-side request forgery. Do not expose the service to the public internet.

## 7. GitHub Pages deployment

Configure the frontend for GitHub Pages deployment using Vite's correct base path and a GitHub Actions workflow.

The GitHub Pages frontend must:
- Load independently.
- Display whether the local automation service is connected.
- Show a helpful setup message when the service is unavailable.
- Allow users to configure the local service URL.
- Never pretend browser automation works when the local service is disconnected.

Document clearly that the local Node.js service must run on the user's computer for screenshot automation to work.

Configure localhost CORS appropriately, and use a secure local authentication mechanism or pairing token between the frontend and local service. Restrict allowed origins to the intended GitHub Pages deployment and localhost development origins. Never embed a secret API key in frontend source code.

## 8. User experience

Use a professional dashboard layout with:
- Sidebar navigation.
- Automation dashboard.
- Screenshot gallery.
- Settings page.
- Connection status indicator.
- Progress bar.
- Success and error notifications.
- Loading indicators.
- Confirmation dialogs for destructive actions.
- Empty gallery state with setup instructions.

Make the application usable without a database account or cloud subscription.

## 9. Project structure and deliverables

Create a complete working project with separate frontend and local-service directories.

Include:
- All frontend source files.
- All local automation service source files.
- `package.json` files and required dependencies.
- Playwright setup instructions.
- Microsoft Edge installation and detection instructions.
- `.gitignore` excluding screenshots, browser profiles, secrets, and local configuration.
- GitHub Actions workflow for GitHub Pages deployment.
- `.env.example` for local configuration, without real secrets.
- README with setup, development, build, deployment, and troubleshooting instructions.
- Windows startup scripts for installing dependencies and starting the local service.
- Example URL list for testing.

Provide complete code, not pseudocode or placeholder functions.

## 10. Acceptance criteria

The application is complete when:

1. The frontend deploys successfully to GitHub Pages.
2. The local service can launch Microsoft Edge.
3. The user can select headed or headless mode.
4. Multiple URLs can be processed sequentially.
5. Screenshots are captured automatically after navigation.
6. Screenshots are saved to the local filesystem.
7. The gallery updates automatically.
8. Individual screenshots can be downloaded.
9. All screenshots can be downloaded in one ZIP file.
10. Screenshots remain available after restarting the frontend or local service.
11. Automation progress and errors are displayed accurately.
12. No cloud storage or database is required.
13. The implementation does not claim that a GitHub Pages website can directly control the user's browser without a local automation service.

First generate the project structure, then implement the backend, frontend, and GitHub Pages workflow. Finally, provide exact commands to run the application locally and deploy the frontend.
