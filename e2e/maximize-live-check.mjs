// Proves that a HEADED run opens a maximized Edge window and that the screenshot fills it.
//
//   node maximize-live-check.mjs
//
// It starts its OWN throw-away copy of the service (see isolated-service.mjs) and a local test page, so it never touches a
// service you are running, its pairing token or gallery, and it uses no internet. A maximized Edge window appears on screen
// for a few seconds. Windows itself is asked for the window state (IsZoomed), not just the browser.
import { execFile } from 'node:child_process';
import http from 'node:http';
import { promisify } from 'node:util';
import { startIsolatedService } from './isolated-service.mjs';

const run = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  - ' + detail : ''}`);
};

/** Runs PowerShell without any command-line quoting problems. */
async function ps(script) {
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 10_000_000,
  });
  return stdout.trim();
}

/** Edge processes started directly by `parentPid` (the browser itself, not its helper processes). */
async function edgeChildrenOf(parentPid) {
  const out = await ps(`Get-CimInstance Win32_Process -Filter "Name='msedge.exe' AND ParentProcessId=${Number(parentPid)}" | Select-Object -ExpandProperty ProcessId`);
  return out.split(/\s+/).filter(Boolean).map(Number);
}

/** Asks Windows for the visible top-level Edge windows of the given processes, and for the size of the work area. */
function windowQuery(pids) {
  return `
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public delegate bool EnumProc(IntPtr h, IntPtr p);
public class NativeWin {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", CharSet = CharSet.Auto)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
'@
$ids = @(${pids.join(',')})
$found = New-Object System.Collections.ArrayList
$cb = [EnumProc]{
  param($h, $p)
  $procId = [uint32]0
  [void][NativeWin]::GetWindowThreadProcessId($h, [ref]$procId)
  if (($ids -contains [int]$procId) -and [NativeWin]::IsWindowVisible($h)) {
    $sb = New-Object System.Text.StringBuilder 64
    [void][NativeWin]::GetClassName($h, $sb, 64)
    if ($sb.ToString() -eq 'Chrome_WidgetWin_1') {
      $r = New-Object NativeWin+RECT
      [void][NativeWin]::GetWindowRect($h, [ref]$r)
      [void]$found.Add([pscustomobject]@{ Zoomed = [NativeWin]::IsZoomed($h); Width = $r.Right - $r.Left; Height = $r.Bottom - $r.Top })
    }
  }
  return $true
}
# Wait for the window to appear, let it settle, then read it once more.
for ($i = 0; $i -lt 40 -and $found.Count -eq 0; $i++) {
  [void][NativeWin]::EnumWindows($cb, [IntPtr]::Zero)
  if ($found.Count -eq 0) { Start-Sleep -Milliseconds 250 }
}
Start-Sleep -Milliseconds 700
$found.Clear()
[void][NativeWin]::EnumWindows($cb, [IntPtr]::Zero)
Add-Type -AssemblyName System.Windows.Forms
$wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
[pscustomobject]@{ windows = @($found); workWidth = $wa.Width; workHeight = $wa.Height } | ConvertTo-Json -Compress -Depth 4
`;
}

// A small local page to capture.
const site = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(
    '<!doctype html><title>Window size check</title><body style="margin:0;font:28px sans-serif">' +
      '<div style="padding:24px;background:#dbeafe">Maximize check: this page fills the browser window</div>' +
      '<div style="height:900px;background:linear-gradient(#fff,#93c5fd)"></div></body>',
  );
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const pageUrl = `http://127.0.0.1:${site.address().port}/`;

let svc;
try {
  svc = await startIsolatedService();
  console.log(`      test copy of the service: ${svc.url} (temporary folders, not your service)`);

  const start = await svc.api('POST', '/api/automation/start', {
    urls: [pageUrl],
    mode: 'headed',
    screenshotMode: 'viewport',
    extraWaitMs: 6000,
    delayBetweenPagesMs: 0,
  });
  check('a headed run starts', start.status === 202, `HTTP ${start.status}`);

  let edge = [];
  for (let i = 0; i < 80 && edge.length === 0; i += 1) {
    await sleep(250);
    edge = await edgeChildrenOf(svc.child.pid);
  }
  check('the service opened its own Edge browser', edge.length > 0, `pid ${edge.join(',')}`);

  const info = JSON.parse(await ps(windowQuery(edge)));
  const windows = [].concat(info.windows ?? []).sort((a, b) => b.Width * b.Height - a.Width * a.Height);
  const win = windows[0];
  console.log(`      Windows reports: ${JSON.stringify(win ?? null)}; work area ${info.workWidth}x${info.workHeight}`);
  check('Edge shows a visible window', Boolean(win));
  check('Windows says the window is maximized (IsZoomed)', Boolean(win?.Zoomed));
  check('the window covers the whole work area', Boolean(win) && win.Width >= info.workWidth - 2 && win.Height >= info.workHeight - 2, `${win?.Width}x${win?.Height}`);

  let status;
  for (let i = 0; i < 120; i += 1) {
    await sleep(500);
    status = (await svc.api('GET', '/api/automation/status')).json;
    if (status && !status.active) break;
  }
  check('the run completed', status?.state === 'completed', `${status?.state}: ${status?.message}`);

  const gallery = (await svc.api('GET', '/api/gallery')).json;
  const item = gallery?.items?.[0];
  check('a screenshot was saved', Boolean(item));
  if (item) {
    console.log(`      screenshot: ${item.width}x${item.height} px`);
    check('the screenshot is not the old fixed 1280 px wide viewport', item.width !== 1280, `${item.width}`);
    check('the screenshot width matches the maximized window (CSS pixels, not multiplied by screen scaling)', item.width <= info.workWidth && item.width > info.workWidth - 40, `${item.width} within ${info.workWidth}`);
  }

  let remaining = edge;
  for (let i = 0; i < 40 && remaining.length > 0; i += 1) {
    await sleep(250);
    remaining = await edgeChildrenOf(svc.child.pid);
  }
  check('the Edge window closed when the run ended', remaining.length === 0);
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
