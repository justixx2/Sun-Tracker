// Opens the real app in a headless phone-sized browser against the LIVE Open-Meteo API
// (no mocks), pretending to be at LAT/LON (default Kraków), and prints what the app shows.
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
  // Wait until both steps (forecast + double-check) are done, or an error is shown.
  await page.waitForFunction(() => (document.querySelector('#status').hidden && document.querySelector('#homeCard .card')) ||
    document.querySelector('.status.error'), null, { timeout: 180000 });
  const err = await page.$('.status.error');
  if (err) throw new Error('App showed error: ' + await err.innerText());

  const text = el => el.innerText.replace(/\s+/g, ' ').trim();
  console.log(`Live API calls: ${apiCalls}, failed: ${apiFailures}`);
  console.log('Location:', await page.textContent('#locationText'));
  console.log(await page.textContent('#summary'));
  console.log('\nClosest sunny places:\n' + (await page.$$eval('.card', els => els.slice(0, 12)
    .map(e => e.innerText.replace(/\s+/g, ' ').trim()))).join('\n'));

  await page.selectOption('#sort', 'most');
  console.log('\nMost sun:\n' + (await page.$$eval('#results .card', els => els.slice(0, 5)
    .map(e => e.innerText.replace(/\s+/g, ' ').trim()))).join('\n'));

  // DETAIL=home shows the day-by-day list for your own location instead of the top result.
  const card = await page.$(process.env.DETAIL === 'home' ? '#homeCard .card' : '#results .card');
  if (card) {
    await card.click();
    await page.waitForSelector('#detailRows li');
    await page.waitForTimeout(3000); // let an on-demand double-check finish
    console.log('\nDetail for', await page.textContent('#detailTitle'));
    for (const li of await page.$$('#detailRows li')) console.log('  ' + text(li));
  }
  await page.screenshot({ path: 'live-check.png', fullPage: false });
  if (errors.length) throw new Error('Page errors: ' + errors.join('; '));
  if (apiFailures) throw new Error(`${apiFailures} weather API calls failed`);
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
