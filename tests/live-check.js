// Opens the real app in a headless phone-sized browser against the LIVE Open-Meteo API
// (no mocks), pretending to be in Kraków, and prints what the app shows.
// Usage: python3 -m http.server 8765 & node tests/live-check.js
const { chromium } = require('playwright');

const LAT = +(process.env.LAT || 50.06), LON = +(process.env.LON || 19.94);

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    geolocation: { latitude: LAT, longitude: LON }, permissions: ['geolocation'],
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  let apiCalls = 0, apiFailures = 0;
  page.on('response', r => {
    if (r.url().includes('open-meteo.com')) { apiCalls++; if (!r.ok()) apiFailures++; }
  });

  await page.goto('http://localhost:8765/');
  await page.waitForFunction(() => document.querySelector('#homeCard .card') || document.querySelector('.status.error'),
    null, { timeout: 90000 });
  const err = await page.$('.status.error');
  if (err) throw new Error('App showed error: ' + await err.innerText());

  console.log(`Live API calls: ${apiCalls}, failed: ${apiFailures}`);
  console.log('Location:', await page.textContent('#locationText'));
  console.log(await page.textContent('#summary'));
  const cards = await page.$$eval('.card', els => els.slice(0, 15).map(e => {
    const name = e.querySelector('.card-name').innerText;
    const dist = e.querySelector('.card-dist').innerText;
    const line = e.querySelector('.card-line').innerText;
    return `${name.padEnd(28)} ${dist.padEnd(14)} ${line}`;
  }));
  console.log('\nTop results (sorted by closest):\n' + cards.join('\n'));

  await page.selectOption('#sort', 'longest');
  const longest = await page.$$eval('#results .card', els => els.slice(0, 5).map(e =>
    `${e.querySelector('.card-name').innerText} (${e.querySelector('.card-dist').innerText}): ${e.querySelector('.card-line').innerText}`));
  console.log('\nLongest sunny spells:\n' + longest.join('\n'));

  const first = await page.$('#results .card');
  if (first) {
    await first.click();
    await page.waitForFunction(() => !document.querySelector('#ensembleNote').textContent.startsWith('Loading'), null, { timeout: 60000 });
    console.log('\nDetail for', await page.textContent('#detailTitle'), '-', await page.textContent('#ensembleNote'));
    const rows = await page.$$eval('#detailRows tr', trs => trs.map(tr => [...tr.cells].map(c => c.innerText.trim()).join(' | ')));
    console.log(rows.join('\n'));
  }
  await page.screenshot({ path: 'live-check.png', fullPage: false });
  if (errors.length) throw new Error('Page errors: ' + errors.join('; '));
  if (apiFailures) throw new Error(`${apiFailures} weather API calls failed`);
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
