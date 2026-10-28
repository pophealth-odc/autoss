// Confirms that the page running on localhost can pair with the already-running service, using the exact pairing link
// that is given to the user. Uses a throw-away headless Edge profile; does not touch the user's browser.
//
//   node localhost-check.mjs <page-url> <service-url> <token>
import { chromium } from 'playwright-core';

const [pageUrl, serviceUrl, token] = process.argv.slice(2);
if (!pageUrl || !serviceUrl || !token) {
  console.error('Usage: node localhost-check.mjs <page-url> <service-url> <token>');
  process.exit(2);
}

const browser = await chromium.launch({ channel: 'msedge', headless: true });
let ok = false;
try {
  const page = await (await browser.newContext({ viewport: { width: 1360, height: 900 } })).newPage();
  const permissionRequests = [];
  page.on('console', (m) => { if (/permission|local network|loopback/i.test(m.text())) permissionRequests.push(m.text().slice(0, 160)); });
  await page.goto(`${pageUrl.replace(/\/$/, '')}/#/connect?service=${encodeURIComponent(serviceUrl)}&token=${encodeURIComponent(token)}`);
  await page.getByRole('dialog').getByRole('button', { name: 'Pair' }).click();
  await page.getByTestId('connection-label').first().waitFor();
  const deadline = Date.now() + 30000;
  let label = '';
  while (Date.now() < deadline) {
    label = await page.getByTestId('connection-label').first().innerText();
    if (/Connected/.test(label)) break;
    await page.waitForTimeout(250);
  }
  ok = /Connected/.test(label);
  console.log(ok ? 'PASS  the page on localhost paired with the service and shows "Connected"' : `FAIL  badge says "${label}"`);
  console.log('      address bar after pairing :', page.url().replace(token, '[token removed]'));
  console.log('      browser permission messages:', permissionRequests.length === 0 ? 'none' : permissionRequests.join(' | '));
} catch (error) {
  console.log('FAIL ', error instanceof Error ? error.message.split('\n')[0] : String(error));
} finally {
  await browser.close();
}
process.exit(ok ? 0 : 1);
