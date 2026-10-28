// End-to-end check through the real HTTP API of an ISOLATED copy of the service (random port, temporary folders, its own token):
//   1. {$prevday} in a submitted address is replaced with yesterday's date (local calendar) before the browser opens it
//   2. the page scale reaches the browser in headless AND headed mode, and screenshots come out at the scaled layout size
//   3. a bad page scale is refused with a clear message
// Headed runs open a maximized Edge window for a few seconds. Nothing touches a service you are running.
//
//   node scale-and-prevday-check.mjs
import http from 'node:http';
import { startIsolatedService } from './isolated-service.mjs';

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  - ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Yesterday as yyyy-MM-dd in the local time zone, computed independently of the product's own function. */
function yesterdayLocal() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// A page that reports what it was asked for and what size it was laid out at.
const requests = [];
const site = http.createServer((req, res) => {
  requests.push(req.url);
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset=utf-8><title>Scale check</title><body style="margin:0;font:20px sans-serif">
<div style="padding:12px;background:#dbeafe">query: ${new URL(req.url, 'http://x').search.replace(/[<>&]/g, '')}</div>
<div style="height:1500px;background:linear-gradient(#fff,#93c5fd)"></div></body>`);
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${site.address().port}`;

async function run(svc, body) {
  const start = await svc.api('POST', '/api/automation/start', body);
  if (start.status !== 202) return { start, status: null, item: null };
  let status;
  for (let i = 0; i < 160; i += 1) {
    await sleep(500);
    status = (await svc.api('GET', '/api/automation/status')).json;
    if (status && !status.active) break;
  }
  const items = (await svc.api('GET', '/api/gallery')).json?.items ?? [];
  return { start, status, items };
}

let svc;
try {
  svc = await startIsolatedService();
  console.log(`      isolated service at ${svc.url} (temporary folders; yours is not involved)`);

  // ---- 1. {$prevday} -------------------------------------------------------------------------------------------------
  const expected = yesterdayLocal();
  const first = await run(svc, {
    urls: [`${base}/report?from={$prevday}T00:00:00%2B08:00%20to%20{$prevday}T23:59:00%2B08:00&day={$prevday}`],
    mode: 'headless', screenshotMode: 'viewport', extraWaitMs: 0, delayBetweenPagesMs: 0,
  });
  check('a run with {$prevday} in the address starts', first.start.status === 202, `HTTP ${first.start.status}`);
  check('the run completed', first.status?.state === 'completed', first.status?.message);
  const asked = requests.find((u) => u.startsWith('/report')) ?? '';
  check('the browser opened the address with yesterday\'s date in place of every {$prevday}', asked.includes(`day=${expected}`) && asked.includes(`from=${expected}T00:00:00`), asked);
  check('the placeholder text never reached the website', !requests.some((u) => /prevday|%7B/i.test(u)), requests.join(' | '));
  check('the encoded plus sign and spaces were kept as written', asked.includes('%2B08:00') && asked.includes('%20to%20'));
  check('the saved screenshot records the expanded address', first.items?.[0]?.url?.includes(`day=${expected}`), first.items?.[0]?.url);

  // ---- 2. page scale, headless ---------------------------------------------------------------------------------------
  for (const [percent, w, h] of [[50, 2560, 1440], [100, 1280, 720], [200, 640, 360]]) {
    const r = await run(svc, { urls: [`${base}/s${percent}`], mode: 'headless', screenshotMode: 'viewport', pageScalePercent: percent, extraWaitMs: 0, delayBetweenPagesMs: 0 });
    const item = r.items?.find((i) => i.url.endsWith(`/s${percent}`));
    check(`headless at ${percent}%: laid out and captured at ${w}x${h}`, item?.width === w && item?.height === h, item ? `${item.width}x${item.height}` : r.status?.message);
    check(`headless at ${percent}%: no scale warning`, (item?.warnings ?? []).length === 0, (item?.warnings ?? []).join(' '));
  }

  // ---- 2b. page scale, headed ----------------------------------------------------------------------------------------
  const headed = {};
  for (const percent of [100, 50]) {
    const r = await run(svc, { urls: [`${base}/h${percent}`], mode: 'headed', screenshotMode: 'viewport', pageScalePercent: percent, extraWaitMs: 1500, delayBetweenPagesMs: 0 });
    headed[percent] = r.items?.find((i) => i.url.endsWith(`/h${percent}`));
    check(`headed at ${percent}%: the run completed and saved a screenshot`, Boolean(headed[percent]), r.status?.message);
  }
  if (headed[100] && headed[50]) {
    console.log(`      headed screenshots: 100% = ${headed[100].width}x${headed[100].height}, 50% = ${headed[50].width}x${headed[50].height}`);
    check('headed at 50% shows twice as much of the page width as at 100%', Math.abs(headed[50].width / headed[100].width - 2) < 0.05, `${(headed[50].width / headed[100].width).toFixed(3)}x`);
    check('headed at 50% carries no scale warning (zooming out is exact)', headed[50].warnings.length === 0, headed[50].warnings.join(' '));
  }
  const zoomedIn = await run(svc, { urls: [`${base}/h200`], mode: 'headed', screenshotMode: 'viewport', pageScalePercent: 200, extraWaitMs: 1500, delayBetweenPagesMs: 0 });
  const z = zoomedIn.items?.find((i) => i.url.endsWith('/h200'));
  check('headed at 200% is captured and the limit is stated in a warning', Boolean(z) && z.warnings.some((w) => /zoomed in to 200 %/.test(w)), z?.warnings?.join(' '));

  // ---- 3. validation -------------------------------------------------------------------------------------------------
  for (const [value, label] of [[10, 'below the minimum'], [900, 'above the maximum'], [99.5, 'a fraction'], ['big', 'not a number']]) {
    const r = await svc.api('POST', '/api/automation/start', { urls: [`${base}/x`], pageScalePercent: value });
    check(`a page scale ${label} is refused`, r.status === 400 && /page scale/i.test(JSON.stringify(r.json)), `HTTP ${r.status}`);
  }
  // ---- 4. the service says what it can do, and a page that reads it passes the scale through ------------------------------
  const health = await (await fetch(`${svc.url}/api/health`)).json();
  check('the service advertises pageScale and datePlaceholder in /api/health', Array.isArray(health.features) && health.features.includes('pageScale') && health.features.includes('datePlaceholder'), JSON.stringify(health.features));
  const noScale = await run(svc, { urls: [`${base}/default`], mode: 'headless', screenshotMode: 'viewport', extraWaitMs: 0, delayBetweenPagesMs: 0 });
  const def = noScale.items?.find((i) => i.url.endsWith('/default'));
  check('leaving the page scale out means 100% (unchanged behaviour for existing clients)', def?.width === 1280 && def?.height === 720, def ? `${def.width}x${def.height}` : noScale.status?.message);
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
