'use strict';

// ---------- Config ----------
const FORECAST_API = 'https://api.open-meteo.com/v1/forecast';
const ENSEMBLE_API = 'https://ensemble-api.open-meteo.com/v1/ensemble';
const DAILY_VARS = [
  'weather_code', 'temperature_2m_max', 'temperature_2m_min', 'sunshine_duration',
  'daylight_duration', 'precipitation_sum', 'precipitation_probability_max',
];
const FORECAST_DAYS = 10;
const TARGET_PLACES = 250;   // how many towns to check per search
const BATCH_SIZE = 50;       // locations per API request
const CONCURRENCY = 3;
const CACHE_TTL_MS = 60 * 60 * 1000;
// Sunny days are double-checked against the 51 ECMWF ensemble scenarios. Every scenario counts
// against Open-Meteo's free limit (600 calls/minute), so only the best candidates are checked.
const ENS_DAYS = 10;
const ENS_MAX_PLACES = 80;
const ENS_BATCH = 20;
const MAX_CLOUD = 60;        // daytime (9-17) cloud cover % that still counts as sunny
const SURE = 75;             // % of scenarios that must be sunny for a "Sunny" day
const MAYBE = 50;            // below SURE but at least this (or main forecast alone): "Maybe sunny"
const DEFAULTS = { radius: '700', minStreak: '2', window: '7', sort: 'nearest' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SNOW_CODES = new Set([71, 73, 75, 77, 85, 86]);
const ICON = { sun: '☀️', maybe: '🌤️', cloud: '☁️', rain: '🌧️', snow: '❄️', na: '·' };
const LABEL = { sun: 'Sunny', maybe: 'Maybe sunny', cloud: 'Cloudy', rain: 'Rain', snow: 'Snow', na: 'No data' };

// ---------- Small helpers ----------
const $ = sel => document.querySelector(sel);
const store = {
  get(key, fallback = null) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked */ }
  },
};
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const flag = cc => cc && cc.length === 2
  ? String.fromCodePoint(...[...cc.toUpperCase()].map(c => 0x1f1e6 + c.charCodeAt(0) - 65)) : '';
const toRad = d => d * Math.PI / 180;

function distanceKm(a, b) {
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}
function compass(a, b) {
  const y = Math.sin(toRad(b.lon - a.lon)) * Math.cos(toRad(b.lat));
  const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) -
    Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lon - a.lon));
  const deg = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8];
}
const dateOf = iso => new Date(iso + 'T12:00:00');
const fmtDay = iso => dateOf(iso).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' });
const fmtWeekday = iso => dateOf(iso).toLocaleDateString(undefined, { weekday: 'short' });
const fmtRange = (a, b) => a === b ? fmtDay(a) : `${fmtDay(a)} – ${fmtDay(b)}`;

// ---------- State ----------
const state = {
  cities: null,
  origin: null,        // {lat, lon, label}
  places: [],          // places checked: {name, cc, lat, lon, pop, dist, dir, isHome}
  forecasts: [],       // daily forecast per place (same order)
  ens: [],             // ensemble per place: {dates, members: [[daytime cloud % per member] per day]} or null
  ensMode: 'pending',  // pending | done | failed
  fetchedAt: 0,
  results: [],
  settings: { ...DEFAULTS, ...store.get('settings', {}) },
  map: null,
  mapLayer: null,
  loading: false,
};

// ---------- Places ----------
async function loadCities() {
  if (state.cities) return state.cities;
  const text = await (await fetch('data/cities.tsv')).text();
  state.cities = text.trim().split('\n').map(line => {
    const [name, cc, lat, lon, pop] = line.split('\t');
    return { name, cc, lat: +lat, lon: +lon, pop: +pop };
  }); // already sorted by population, largest first
  return state.cities;
}

function nearestCity(point) {
  let best = null, bestD = Infinity;
  for (const c of state.cities) {
    if (Math.abs(c.lat - point.lat) > 1) continue;
    const d = distanceKm(point, c);
    if (d < bestD) { bestD = d; best = c; }
  }
  return best ? { city: best, dist: bestD } : null;
}

// Pick a well spread set of towns within the radius: divide the area into a grid and keep
// the most populous town in each cell, so we cover the whole area instead of one big city's suburbs.
function selectPlaces(origin, radiusKm) {
  const cell = Math.max(10, radiusKm * Math.sqrt(Math.PI / TARGET_PLACES));
  const kmPerLon = 111.32 * Math.cos(toRad(origin.lat));
  const latSpan = radiusKm / 110.57 + 0.1;
  const taken = new Map();
  for (const c of state.cities) {
    if (Math.abs(c.lat - origin.lat) > latSpan) continue;
    const dist = distanceKm(origin, c);
    if (dist > radiusKm || dist < 3) continue;
    let dLon = c.lon - origin.lon;
    if (dLon > 180) dLon -= 360; else if (dLon < -180) dLon += 360;
    const key = Math.floor((c.lat - origin.lat) * 110.57 / cell) + ':' + Math.floor(dLon * kmPerLon / cell);
    if (!taken.has(key)) taken.set(key, { ...c, dist, dir: compass(origin, c) });
  }
  const list = [...taken.values()].sort((a, b) => a.dist - b.dist).slice(0, TARGET_PLACES + 60);
  const home = { name: origin.label, cc: origin.cc || '', lat: origin.lat, lon: origin.lon, pop: 0, dist: 0, dir: '', isHome: true };
  return [home, ...list];
}

// ---------- Weather ----------
// Sunshine-duration numbers count sun through thin high cloud generously (some models report
// 10 h of "sun" under 100% cloud), so sunny days are judged mainly by daytime cloud cover.
const DAY_HOURS = [9, 16];   // local hours averaged for "daytime" cloud cover

// Average of hourly values per date over DAY_HOURS: {date: mean}
function daytimeMeans(times, values) {
  const acc = {};
  times.forEach((t, k) => {
    const hour = +t.slice(11, 13), v = values[k];
    if (hour < DAY_HOURS[0] || hour > DAY_HOURS[1] || v == null) return;
    const a = acc[t.slice(0, 10)] || (acc[t.slice(0, 10)] = [0, 0]);
    a[0] += v; a[1]++;
  });
  const out = {};
  for (const [d, [sum, n]] of Object.entries(acc)) out[d] = Math.round(sum / n);
  return out;
}

function normalizeDaily(d, h) {
  const cloud = h?.cloud_cover ? daytimeMeans(h.time, h.cloud_cover) : {};
  return d.time.map((date, i) => ({
    cloud: cloud[date],
    date,
    code: d.weather_code?.[i],
    tmax: d.temperature_2m_max?.[i],
    tmin: d.temperature_2m_min?.[i],
    sun: d.sunshine_duration?.[i],
    daylight: d.daylight_duration?.[i],
    rainSum: d.precipitation_sum?.[i],
    rainProb: d.precipitation_probability_max?.[i],
  }));
}

// Fetches JSON for many locations at once. If Open-Meteo's per-minute limit is hit,
// waits a minute and tries once more.
async function fetchMulti(api, batch, extra, onWait) {
  const params = new URLSearchParams({
    latitude: batch.map(p => p.lat.toFixed(3)).join(','),
    longitude: batch.map(p => p.lon.toFixed(3)).join(','),
    timezone: 'auto',
    ...extra,
  });
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${api}?${params}`);
    if (res.ok) {
      const json = await res.json();
      return Array.isArray(json) ? json : [json];
    }
    let reason = '';
    try { reason = (await res.json()).reason || ''; } catch { /* ignore */ }
    if (res.status === 429 && attempt === 0 && !/daily|hourly/i.test(reason)) {
      onWait?.();
      await sleep(61000);
      continue;
    }
    throw new Error(`Weather service error ${res.status}${reason ? ': ' + reason : ''}`);
  }
}

async function fetchBatch(batch, onWait) {
  const arr = await fetchMulti(FORECAST_API, batch,
    { daily: DAILY_VARS.join(','), hourly: 'cloud_cover', forecast_days: String(FORECAST_DAYS) }, onWait);
  return arr.map(item => item && item.daily ? normalizeDaily(item.daily, item.hourly) : null);
}

// members[day] = daytime cloud cover (%) of each ensemble member
function parseEnsemble(h) {
  const per = Object.keys(h).filter(k => k.startsWith('cloud_cover')).map(k => daytimeMeans(h.time, h[k]));
  const dates = [...new Set(h.time.map(t => t.slice(0, 10)))];
  return { dates, members: dates.map(d => per.map(m => m[d]).filter(v => v != null)) };
}

async function fetchEnsembleBatch(batch, onWait) {
  const arr = await fetchMulti(ENSEMBLE_API, batch,
    { hourly: 'cloud_cover', models: 'ecmwf_ifs025', forecast_days: String(ENS_DAYS) }, onWait);
  return arr.map(item => item && item.hourly ? parseEnsemble(item.hourly) : null);
}

// Pick which towns get the (expensive) sun-chance check: your location, the nearest towns
// with some sun in the main forecast, then the towns with the most sunny days.
function pickForEnsemble(places, forecasts) {
  const cand = places.map((p, i) => ({
    p, i,
    n: (forecasts[i] || []).slice(0, ENS_DAYS).filter(d => mainSaysSunny(d, MAX_CLOUD + 15)).length,
  })).filter(c => !c.p.isHome && c.n > 0);
  const picked = new Set(places[0]?.isHome ? [0] : []);
  [...cand].sort((a, b) => a.p.dist - b.p.dist).slice(0, ENS_MAX_PLACES / 2).forEach(c => picked.add(c.i));
  for (const c of [...cand].sort((a, b) => b.n - a.n || a.p.dist - b.p.dist)) {
    if (picked.size >= ENS_MAX_PLACES + 1) break;
    picked.add(c.i);
  }
  return [...picked];
}

async function fetchEnsembles(places, indices, onProgress, onWait) {
  const out = new Array(places.length).fill(null);
  for (let b = 0; b < indices.length; b += ENS_BATCH) {
    const idx = indices.slice(b, b + ENS_BATCH);
    const res = await fetchEnsembleBatch(idx.map(i => places[i]), onWait);
    idx.forEach((i, k) => { out[i] = res[k] || null; });
    onProgress(Math.min(b + ENS_BATCH, indices.length), indices.length);
  }
  return out;
}

async function fetchForecasts(places, onProgress, onWait) {
  const batches = [];
  for (let i = 0; i < places.length; i += BATCH_SIZE) batches.push(places.slice(i, i + BATCH_SIZE));
  const out = new Array(batches.length);
  let next = 0, done = 0;
  async function worker() {
    while (next < batches.length) {
      const idx = next++;
      out[idx] = await fetchBatch(batches[idx], onWait);
      onProgress(++done, batches.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));
  return out.flat();
}

// ---------- Analysis ----------
const sunRatio = day => day.daylight > 0 ? day.sun / day.daylight : 0;
const mainSaysSunny = (day, maxCloud = MAX_CLOUD) =>
  day.cloud != null && day.cloud <= maxCloud && sunRatio(day) >= 0.5 && (day.rainProb ?? 0) < 40;
const isRainy = day => (day.rainSum ?? 0) >= 5 || ((day.rainSum ?? 0) >= 1 && (day.rainProb ?? 0) >= 50);

// % of ensemble scenarios whose daytime cloud cover is low enough to count as sunny (null = unknown).
function sunChance(ens, day) {
  if (!ens) return null;
  const i = ens.dates.indexOf(day.date);
  const members = i >= 0 ? ens.members[i] : null;
  if (!members || !members.length) return null;
  return Math.round(100 * members.filter(c => c <= MAX_CLOUD).length / members.length);
}

// sun   = main forecast sunny AND 75%+ of scenarios agree
// maybe = only one of them says sunny (or 50-75% of scenarios), or it couldn't be double-checked
// rain  = 1 mm+ with 50%+ chance, or 5 mm+
function classify(day, chance, ensMode) {
  if (day.cloud == null && day.sun == null) return 'na';
  if (isRainy(day)) return SNOW_CODES.has(day.code) ? 'snow' : 'rain';
  const main = mainSaysSunny(day);
  if (chance != null) {
    if (main && chance >= SURE) return 'sun';
    if (main || chance >= MAYBE) return 'maybe';
  } else if (main) {
    return ensMode === 'done' ? 'maybe' : 'sun';
  }
  return 'cloud';
}

function analyze(place, days, ens, s, pi) {
  const windowDays = +s.window, minStreak = +s.minStreak;
  const chances = days.map(d => sunChance(ens, d));
  const kinds = days.map((d, i) => classify(d, chances[i], state.ensMode));
  const win = Math.min(windowDays, days.length);
  let sunnyCount = 0, rainCount = 0, expected = 0, best = null, first = null, run = null;
  const closeRun = () => {
    if (!run) return;
    if (!best || run.len > best.len) best = run;
    if (!first && run.len >= minStreak) first = run;
    run = null;
  };
  for (let i = 0; i < win; i++) {
    if (chances[i] != null) expected += chances[i] / 100;
    if (kinds[i] === 'rain' || kinds[i] === 'snow') rainCount++;
    if (kinds[i] === 'sun') {
      sunnyCount++;
      run = run ? { ...run, len: run.len + 1, end: i } : { start: i, end: i, len: 1 };
    } else closeRun();
  }
  closeRun();
  const highlight = s.sort === 'most' ? best : (first || best);
  let avgMax = null;
  if (highlight) {
    const temps = days.slice(highlight.start, highlight.end + 1).map(d => d.tmax).filter(t => t != null);
    if (temps.length) avgMax = Math.round(temps.reduce((a, b) => a + b, 0) / temps.length);
  }
  return {
    place, pi, days, kinds, chances, sunnyCount, rainCount, expected, windowDays: win,
    best, first, highlight, avgMax,
    qualifies: !!first,
  };
}

function sortResults(list, sort) {
  const by = {
    nearest: (a, b) => a.place.dist - b.place.dist,
    most: (a, b) => b.sunnyCount - a.sunnyCount || b.expected - a.expected || a.place.dist - b.place.dist,
  }[sort] || ((a, b) => a.place.dist - b.place.dist);
  return list.slice().sort(by);
}

// ---------- Rendering ----------
function setStatus(html, kind = '') {
  const el = $('#status');
  if (!html) { el.hidden = true; return; }
  el.hidden = false;
  el.className = 'status ' + kind;
  el.innerHTML = html;
}

function stripHtml(r) {
  return '<div class="strip">' + r.days.slice(0, r.windowDays).map((d, i) =>
    `<div class="d ${r.kinds[i]}${i === 0 ? ' today' : ''}" title="${esc(fmtDay(d.date) + ': ' + LABEL[r.kinds[i]])}">` +
    `<span>${ICON[r.kinds[i]]}</span><small>${i === 0 ? 'Today' : esc(fmtWeekday(d.date))}</small></div>`).join('') + '</div>';
}

function headline(r) {
  const h = r.highlight;
  if (!h) {
    return `No sunny days in the next ${r.windowDays} days` + (r.rainCount ? ` · 🌧️ rain on ${r.rainCount}` : '');
  }
  const label = h.len === 1 ? '1 sunny day' : `${h.len} sunny days`;
  const temp = r.avgMax != null ? ` · ${r.avgMax}°` : '';
  return `<b>☀️ ${label}</b> · ${esc(fmtRange(r.days[h.start].date, r.days[h.end].date))}${temp}`;
}

function cardHtml(r, idx) {
  const p = r.place;
  const name = p.isHome ? `📍 ${esc(p.name)}` : `${flag(p.cc)} ${esc(p.name)}`;
  const dist = p.isHome ? 'You are here' : `${Math.round(p.dist)} km ${p.dir}`;
  return `<article class="card${p.isHome ? ' home' : ''}" data-idx="${idx}">
    <div class="card-head"><span class="card-name">${name}</span><span class="card-dist">${dist}</span></div>
    <div class="card-line">${headline(r)}</div>
    ${stripHtml(r)}
  </article>`;
}

function render() {
  if (!state.forecasts.length) return;
  const s = state.settings;
  const all = state.places.map((p, i) => state.forecasts[i] ? analyze(p, state.forecasts[i], state.ens[i], s, i) : null).filter(Boolean);
  const home = all.find(r => r.place.isHome);
  const others = all.filter(r => !r.place.isHome);
  const matches = sortResults(others.filter(r => r.qualifies), s.sort);
  state.results = [home, ...matches].filter(Boolean);

  $('#homeCard').innerHTML = home ? cardHtml(home, 0) : '';
  const what = s.minStreak === '1' ? 'a sunny day' : `${s.minStreak}+ sunny days in a row`;
  $('#summary').textContent = matches.length
    ? `${matches.length} places within ${s.radius} km with ${what} in the next ${s.window} days:`
    : '';
  $('#results').innerHTML = matches.length
    ? matches.map((r, i) => cardHtml(r, i + (home ? 1 : 0))).join('')
    : `<div class="empty">No places within ${s.radius} km with ${what} in the next ${s.window} days.<br>Try a bigger distance or fewer days in a row.</div>`;
  updateLocationText();
  if (!$('#mapView').hidden) renderMap();
}

function updateLocationText() {
  if (!state.origin) return;
  const ago = state.fetchedAt ? Math.round((Date.now() - state.fetchedAt) / 60000) : null;
  const when = ago == null ? '' : ago < 1 ? ' · updated just now' : ` · updated ${ago} min ago`;
  $('#locationText').textContent = `${state.origin.label}${state.origin.cc ? ', ' + state.origin.cc : ''}${when}`;
}

// ---------- Map ----------
function streakColor(len) {
  const v = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  if (!len) return v('--c0');
  if (len <= 2) return v('--c2');
  if (len <= 4) return v('--c3');
  if (len <= 6) return v('--c5');
  return v('--c7');
}

async function loadLeaflet() {
  if (window.L) return;
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js';
    s.onload = resolve; s.onerror = () => reject(new Error('Could not load the map library'));
    document.head.appendChild(s);
  });
}

async function renderMap() {
  try { await loadLeaflet(); } catch (e) { $('#map').textContent = e.message; return; }
  if (!state.map) {
    state.map = L.map('map', { zoomControl: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18, attribution: '© OpenStreetMap contributors',
    }).addTo(state.map);
    state.mapLayer = L.layerGroup().addTo(state.map);
  }
  state.mapLayer.clearLayers();
  if (!state.origin) return;
  const bounds = [[state.origin.lat, state.origin.lon]];
  state.results.forEach((r, idx) => {
    const p = r.place;
    const len = r.highlight ? r.highlight.len : 0;
    const m = p.isHome
      ? L.circleMarker([p.lat, p.lon], { radius: 9, color: '#111', weight: 3, fillColor: streakColor(len), fillOpacity: 1 })
      : L.circleMarker([p.lat, p.lon], { radius: 7, color: '#00000055', weight: 1, fillColor: streakColor(len), fillOpacity: .95 });
    m.bindPopup(`<b>${p.isHome ? '📍 ' : flag(p.cc) + ' '}${esc(p.name)}</b><br>${p.isHome ? 'You are here' : Math.round(p.dist) + ' km ' + p.dir}<br>` +
      `${headline(r)}<br><button class="btn" data-open="${idx}">Details</button>`);
    m.addTo(state.mapLayer);
    bounds.push([p.lat, p.lon]);
  });
  state.map.invalidateSize();
  state.map.fitBounds(bounds, { padding: [20, 20], maxZoom: 9 });
}

// ---------- Detail sheet ----------
function saveCache() {
  if (!state.cacheKey) return;
  store.set('forecastCache3', {
    key: state.cacheKey, ts: state.fetchedAt, places: state.places,
    forecasts: state.forecasts, ens: state.ens, ensMode: state.ensMode,
  });
}

function openDetail(idx) {
  let r = state.results[idx];
  if (!r) return;
  const p = r.place, pi = r.pi;
  $('#detailTitle').textContent = `${p.isHome ? '📍' : flag(p.cc)} ${p.name}`;
  $('#detailSub').textContent = p.isHome ? 'Your location' : `${Math.round(p.dist)} km ${p.dir} of you`;
  $('#directionsLink').href = `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lon}`;
  const renderRows = () => {
    $('#detailRows').innerHTML = r.days.map((d, i) => `
      <li class="row ${r.kinds[i]}${i >= 5 ? ' far' : ''}" data-day="${i}">
        <span class="row-day">${i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : esc(fmtDay(d.date))}</span>
        <span class="row-icon">${ICON[r.kinds[i]]}</span>
        <span class="row-label">${LABEL[r.kinds[i]]}</span>
        <span class="row-temp">${d.tmax != null ? Math.round(d.tmax) + '°' : ''}<small>${d.tmin != null ? ' ' + Math.round(d.tmin) + '°' : ''}</small></span>
        <span class="row-more">›</span>
      </li>`).join('');
  };
  state.detail = { place: p, get days() { return r.days; } };
  renderRows();
  $('#detail').showModal();
  if (state.ens[pi] || state.ensMode !== 'done') return;
  // This town wasn't double-checked yet: do it now.
  fetchEnsembleBatch([p])
    .then(([ens]) => {
      state.ens[pi] = ens;
      saveCache();
      r = analyze(p, r.days, ens, state.settings, pi);
      renderRows();
      render();
    })
    .catch(() => {});
}

// ---------- Hour-by-hour sheet ----------
// WMO weather codes -> precipitation type
function hourCondition(h) {
  const c = h.code, night = !h.isDay;
  if (c >= 95) return ['⛈️', 'Thunderstorm'];
  if ((c >= 71 && c <= 77) || c === 85 || c === 86) return ['🌨️', 'Snow'];
  if (c >= 80 && c <= 82) return ['🌦️', 'Showers'];
  if (c >= 61 && c <= 67) return ['🌧️', 'Rain'];
  if (c >= 51 && c <= 57) return ['🌦️', 'Drizzle'];
  if (c === 45 || c === 48) return ['🌫️', 'Fog'];
  const cl = h.cloud ?? 100;
  if (cl <= 20) return night ? ['🌙', 'Clear'] : ['☀️', 'Sunny'];
  if (cl <= 50) return night ? ['🌙', 'Mostly clear'] : ['🌤️', 'Mostly sunny'];
  if (cl <= 85) return ['⛅', 'Partly cloudy'];
  return ['☁️', 'Cloudy'];
}

const hourCache = new Map();
async function fetchHourly(p) {
  const key = `${p.lat.toFixed(3)},${p.lon.toFixed(3)}`;
  const hit = hourCache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.data;
  const [[f], [e]] = await Promise.all([
    fetchMulti(FORECAST_API, [p], {
      hourly: 'weather_code,cloud_cover,temperature_2m,precipitation_probability,precipitation,is_day',
      forecast_days: String(FORECAST_DAYS),
    }),
    fetchMulti(ENSEMBLE_API, [p], { hourly: 'cloud_cover', models: 'ecmwf_ifs025', forecast_days: String(ENS_DAYS) })
      .catch(() => [null]),
  ]);
  const h = f.hourly, eh = e?.hourly;
  const members = eh ? Object.keys(eh).filter(k => k.startsWith('cloud_cover')) : [];
  const ensIdx = eh ? new Map(eh.time.map((t, i) => [t, i])) : new Map();
  const data = h.time.map((t, i) => {
    const j = ensIdx.get(t);
    const vals = j == null ? [] : members.map(k => eh[k][j]).filter(v => v != null);
    return {
      time: t, code: h.weather_code[i], cloud: h.cloud_cover[i], temp: h.temperature_2m[i],
      rainProb: h.precipitation_probability[i], rain: h.precipitation[i], isDay: h.is_day[i] === 1,
      // share of forecast scenarios with little cloud (sun likely) at this hour
      sunChance: vals.length ? Math.round(100 * vals.filter(v => v <= 50).length / vals.length) : null,
    };
  });
  hourCache.set(key, { ts: Date.now(), data });
  return data;
}

async function openHours(dayIdx) {
  const { place: p, days } = state.detail || {};
  const day = days?.[dayIdx];
  if (!day) return;
  $('#hoursTitle').textContent = dayIdx === 0 ? 'Today' : dayIdx === 1 ? 'Tomorrow' :
    dateOf(day.date).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  $('#hoursSub').textContent = p.name;
  $('#hourRows').innerHTML = '<li class="muted">Loading…</li>';
  $('#hours').showModal();
  try {
    const all = await fetchHourly(p);
    const now = new Date();
    const nowKey = `${day.date}T${String(now.getHours()).padStart(2, '0')}`;
    const hours = all.filter(h => h.time.startsWith(day.date) && (dayIdx > 0 || h.time.slice(0, 13) >= nowKey));
    $('#hourRows').innerHTML = hours.map(h => {
      const [icon, label] = hourCondition(h);
      const rain = h.rainProb != null && h.rainProb >= 10 ? `<span class="chip rain-chip">💧 ${h.rainProb}%</span>` : '';
      const sun = h.isDay && h.sunChance != null ? `<span class="chip sun-chip">☀️ ${h.sunChance}%</span>` : '';
      return `<li class="hour${h.isDay ? '' : ' night'}">
        <span class="h-time">${h.time.slice(11, 16)}</span>
        <span class="h-icon">${icon}</span>
        <span class="h-label">${label}</span>
        <span class="h-chips">${sun}${rain}</span>
        <span class="h-temp">${h.temp != null ? Math.round(h.temp) + '°' : ''}</span>
      </li>`;
    }).join('') || '<li class="muted">No hourly data for this day.</li>';
  } catch (e) {
    $('#hourRows').innerHTML = `<li class="muted">Couldn't load hourly forecast (${esc(e.message)}).</li>`;
  }
}

// ---------- Location ----------
function getGps() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Location is not supported on this device'));
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      err => reject(new Error(err.code === 1 ? 'Location permission denied' : 'Could not get your location')),
      { enableHighAccuracy: false, timeout: 15000, maximumAge: 10 * 60 * 1000 },
    );
  });
}

function labelFor(point) {
  const near = nearestCity(point);
  if (!near) return { label: `${point.lat.toFixed(2)}, ${point.lon.toFixed(2)}`, cc: '' };
  return { label: (near.dist > 8 ? 'Near ' : '') + near.city.name, cc: near.city.cc };
}

async function setOrigin(point, source) {
  await loadCities();
  const { label, cc } = point.label ? point : labelFor(point);
  state.origin = { lat: point.lat, lon: point.lon, label, cc, source };
  store.set('origin', state.origin);
  updateLocationText();
}

// ---------- Main flow ----------
function cacheKey() {
  const o = state.origin;
  return `fc:${o.lat.toFixed(2)},${o.lon.toFixed(2)}:${state.settings.radius}`;
}

async function refresh({ force = false } = {}) {
  if (state.loading || !state.origin) return;
  state.loading = true;
  $('#refreshBtn').classList.add('spin');
  try {
    await loadCities();
    const key = cacheKey();
    const cached = store.get('forecastCache3');
    if (!force && cached && cached.key === key && Date.now() - cached.ts < CACHE_TTL_MS) {
      state.places = cached.places; state.forecasts = cached.forecasts; state.fetchedAt = cached.ts;
      state.ens = cached.ens || []; state.ensMode = cached.ensMode || 'failed'; state.cacheKey = key;
      setStatus('');
      render();
      return;
    }
    const places = selectPlaces(state.origin, +state.settings.radius);
    const progress = (label, done, total) => setStatus(
      `${label}<div class="progress"><div style="width:${Math.round(100 * done / total)}%"></div></div>`);
    const onWait = () => setStatus('⏳ Weather service is busy – continuing in 1 minute…');
    progress(`Checking the weather in ${places.length} towns…`, 0, 1);
    const forecasts = await fetchForecasts(places,
      (done, total) => progress(`Checking the weather in ${places.length} towns…`, done, total), onWait);
    state.places = places; state.forecasts = forecasts; state.fetchedAt = Date.now();
    state.ens = []; state.ensMode = 'pending'; state.cacheKey = key;
    render();

    const picks = pickForEnsemble(places, forecasts);
    const ensLabel = `Double-checking sunny days for the ${picks.length} best places…`;
    progress(ensLabel, 0, 1);
    try {
      state.ens = await fetchEnsembles(places, picks, (done, total) => progress(ensLabel, done, total), onWait);
      state.ensMode = 'done';
      setStatus('');
    } catch (e) {
      console.error(e);
      state.ensMode = 'failed';
      setStatus(`⚠️ Couldn't double-check sunny days (${esc(e.message)}). Results may be less reliable.`, 'error');
    }
    saveCache();
    render();
  } catch (e) {
    console.error(e);
    const offline = !navigator.onLine ? ' You seem to be offline.' : '';
    setStatus(`⚠️ ${esc(e.message || 'Something went wrong')}.${offline} <button class="btn ghost" id="retryBtn">Retry</button>`, 'error');
    $('#retryBtn')?.addEventListener('click', () => refresh({ force: true }));
  } finally {
    state.loading = false;
    $('#refreshBtn').classList.remove('spin');
  }
}

async function locateAndRefresh(force = false) {
  setStatus('Getting your location…');
  try {
    const point = await getGps();
    await setOrigin(point, 'gps');
  } catch (e) {
    if (!state.origin) {
      setStatus(`⚠️ ${esc(e.message)}. <button class="btn ghost" id="pickBtn">Choose a town</button>`, 'error');
      $('#pickBtn').addEventListener('click', openLocationDialog);
      $('#locationText').textContent = 'Location unknown – tap to choose';
      return;
    }
    // Keep the previously saved location if GPS fails.
  }
  await refresh({ force });
}

function openLocationDialog() {
  $('#placeSearch').value = '';
  $('#placeResults').innerHTML = '';
  $('#locationDialog').showModal();
  loadCities();
}

function searchPlaces(q) {
  q = q.trim().toLowerCase();
  if (q.length < 2 || !state.cities) return [];
  const norm = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const nq = norm(q);
  const out = [];
  for (const c of state.cities) {
    const n = norm(c.name);
    if (n.startsWith(nq)) out.push(c);
    if (out.length >= 12) break;
  }
  if (out.length < 12) {
    for (const c of state.cities) {
      if (out.length >= 12) break;
      if (!out.includes(c) && norm(c.name).includes(nq)) out.push(c);
    }
  }
  return out;
}

function bindUi() {
  for (const id of Object.keys(DEFAULTS)) {
    const el = $('#' + id);
    el.value = state.settings[id];
    el.addEventListener('change', () => {
      state.settings[id] = el.value;
      store.set('settings', state.settings);
      if (id === 'radius') refresh(); else render();
    });
  }
  $('#refreshBtn').addEventListener('click', () => {
    if (state.origin?.source === 'gps') locateAndRefresh(true);
    else refresh({ force: true });
  });
  $('#locationBtn').addEventListener('click', openLocationDialog);
  document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === tab));
    const isMap = tab.dataset.tab === 'map';
    $('#listView').hidden = isMap;
    $('#mapView').hidden = !isMap;
    if (isMap) renderMap();
  }));
  document.addEventListener('click', e => {
    const card = e.target.closest('.card');
    if (card) return openDetail(+card.dataset.idx);
    const open = e.target.closest('[data-open]');
    if (open) return openDetail(+open.dataset.open);
    const dayRow = e.target.closest('#detailRows .row');
    if (dayRow) return openHours(+dayRow.dataset.day);
    const close = e.target.closest('[data-close]');
    if (close) return close.closest('dialog').close();
  });
  document.querySelectorAll('dialog').forEach(d => d.addEventListener('click', e => {
    if (e.target === d) d.close(); // tap on backdrop
  }));
  $('#useGps').addEventListener('click', () => {
    $('#locationDialog').close();
    locateAndRefresh(true);
  });
  $('#placeSearch').addEventListener('input', async e => {
    await loadCities();
    const results = searchPlaces(e.target.value);
    $('#placeResults').innerHTML = results.map((c, i) =>
      `<li data-i="${i}">${flag(c.cc)} ${esc(c.name)} <small>${esc(c.cc)} · pop. ${c.pop.toLocaleString()}</small></li>`).join('');
    $('#placeResults').onclick = ev => {
      const li = ev.target.closest('li'); if (!li) return;
      const c = results[+li.dataset.i];
      $('#locationDialog').close();
      setOrigin({ lat: c.lat, lon: c.lon, label: c.name, cc: c.cc }, 'manual').then(() => refresh());
    };
  });
}

async function init() {
  bindUi();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  const saved = store.get('origin');
  if (saved) {
    state.origin = saved;
    updateLocationText();
    await refresh();                        // show cached/saved location instantly
    if (saved.source === 'gps') locateAndRefresh(); // then update to where we are now
  } else {
    locateAndRefresh();
  }
  setInterval(updateLocationText, 60000);
}

init();
