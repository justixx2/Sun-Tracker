'use strict';

// ---------- Config ----------
const FORECAST_API = 'https://api.open-meteo.com/v1/forecast';
const ENSEMBLE_API = 'https://ensemble-api.open-meteo.com/v1/ensemble';
const DAILY_VARS = [
  'weather_code', 'temperature_2m_max', 'temperature_2m_min', 'sunshine_duration',
  'daylight_duration', 'precipitation_sum', 'precipitation_probability_max',
];
const FORECAST_DAYS = 16;
const TARGET_PLACES = 250;   // how many towns to check per search
const BATCH_SIZE = 50;       // locations per API request
const CONCURRENCY = 3;
const CACHE_TTL_MS = 60 * 60 * 1000;
// Sun chance comes from the 51-member ECMWF ensemble. Every member counts against Open-Meteo's
// free limit (600 calls/minute), so we only check the best candidates and the first 10 days.
const ENS_DAYS = 10;
const ENS_MAX_PLACES = 80;
const ENS_BATCH = 20;
const SURE = 50;             // % of scenarios that must agree for a "sunny" day
const DEFAULTS = { radius: '700', minStreak: '2', window: '10', sort: 'nearest', strictness: '0.65' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SNOW_CODES = new Set([71, 73, 75, 77, 85, 86]);

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
const fmtRange = (a, b) => a === b ? fmtDay(a) : `${fmtDay(a)} → ${fmtDay(b)}`;
const confidence = i => i <= 2 ? 'high' : i <= 6 ? 'med' : 'low';

// ---------- State ----------
const state = {
  cities: null,
  origin: null,        // {lat, lon, label}
  places: [],          // places checked: {name, cc, lat, lon, pop, dist, dir, isHome}
  forecasts: [],       // daily forecast per place (same order)
  ens: [],             // ensemble sunshine per place: {dates, members: [[seconds per member] per day]} or null
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
function normalizeDaily(d) {
  return d.time.map((date, i) => ({
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
  const arr = await fetchMulti(FORECAST_API, batch, { daily: DAILY_VARS.join(','), forecast_days: String(FORECAST_DAYS) }, onWait);
  return arr.map(item => item && item.daily ? normalizeDaily(item.daily) : null);
}

function parseEnsemble(d) {
  const keys = Object.keys(d).filter(k => k.startsWith('sunshine_duration'));
  return {
    dates: d.time,
    members: d.time.map((_, i) => keys.map(k => d[k][i]).filter(v => v != null).map(Math.round)),
  };
}

async function fetchEnsembleBatch(batch, onWait) {
  const arr = await fetchMulti(ENSEMBLE_API, batch,
    { daily: 'sunshine_duration', models: 'ecmwf_ifs025', forecast_days: String(ENS_DAYS) }, onWait);
  return arr.map(item => item && item.daily ? parseEnsemble(item.daily) : null);
}

// Pick which towns get the (expensive) sun-chance check: your location, the nearest towns
// with some sun in the main forecast, then the towns with the most sunny days.
function pickForEnsemble(places, forecasts) {
  const cand = places.map((p, i) => ({
    p, i,
    n: (forecasts[i] || []).slice(0, ENS_DAYS).filter(d => mainSaysSunny(d, 0.5)).length,
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
const mainSaysSunny = (day, threshold) =>
  day.sun != null && day.daylight != null && sunRatio(day) >= threshold && (day.rainProb ?? 0) < 40;

// % of ensemble scenarios where at least `threshold` of the daylight is sunny (null = unknown).
function sunChance(ens, day, threshold) {
  if (!ens || !day.daylight) return null;
  const i = ens.dates.indexOf(day.date);
  const members = i >= 0 ? ens.members[i] : null;
  if (!members || !members.length) return null;
  return Math.round(100 * members.filter(v => v / day.daylight >= threshold).length / members.length);
}

// sun   = main forecast sunny AND most scenarios agree
// maybe = only one of them says sunny, or the sun chance could not be checked
function classify(day, threshold, chance, ensMode) {
  if (day.sun == null || day.daylight == null) return 'na';
  const prob = day.rainProb ?? 0;
  const wet = (day.rainSum ?? 0) >= 1;
  if (wet && SNOW_CODES.has(day.code)) return 'snow';
  if (wet && prob >= 50) return 'rain';
  const main = mainSaysSunny(day, threshold);
  if (chance != null) {
    const likely = chance >= SURE;
    if (main && likely) return 'sun';
    if (main || likely) return 'maybe';
  } else if (main) {
    return ensMode === 'done' ? 'maybe' : 'sun';
  }
  if (sunRatio(day) >= threshold * 0.55) return 'partly';
  return wet ? 'rain' : 'cloud';
}

function analyze(place, days, ens, s, pi) {
  const threshold = +s.strictness, windowDays = +s.window, minStreak = +s.minStreak;
  const chances = days.map(d => sunChance(ens, d, threshold));
  const kinds = days.map((d, i) => classify(d, threshold, chances[i], state.ensMode));
  const win = Math.min(windowDays, days.length);
  let sunnyCount = 0, maybeCount = 0, expected = 0, best = null, first = null, run = null;
  for (let i = 0; i < win; i++) {
    if (kinds[i] === 'maybe') maybeCount++;
    if (chances[i] != null) expected += chances[i] / 100;
  }
  const closeRun = () => {
    if (!run) return;
    if (!best || run.len > best.len) best = run;
    if (!first && run.len >= minStreak) first = run;
    run = null;
  };
  for (let i = 0; i < win; i++) {
    if (kinds[i] === 'sun') {
      sunnyCount++;
      run = run ? { ...run, len: run.len + 1, end: i } : { start: i, end: i, len: 1 };
    } else closeRun();
  }
  closeRun();
  // How long does a run actually last, even past the window? ("a week of sun" may continue)
  for (const r of [best, first]) {
    if (!r || r.totalLen) continue;
    let j = r.end + 1;
    while (j < days.length && kinds[j] === 'sun') j++;
    r.totalLen = j - r.start;
  }
  // Closest/soonest: show the first spell long enough; longest/most/reliable: show the longest spell.
  const highlight = ['longest', 'most', 'reliable'].includes(s.sort) ? best : (first || best);
  let avgMax = null, sure = null;
  if (highlight) {
    const span = i => i >= highlight.start && i < highlight.start + (highlight.totalLen || highlight.len);
    const avg = arr => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null;
    avgMax = avg(days.filter((d, i) => span(i) && d.tmax != null).map(d => d.tmax));
    sure = avg(chances.filter((c, i) => span(i) && c != null));
  }
  return {
    place, pi, days, kinds, chances, sunnyCount, maybeCount, expected, windowDays: win,
    best, first, highlight, avgMax, sure,
    qualifies: !!first,
  };
}

function sortResults(list, sort) {
  const by = {
    nearest: (a, b) => a.place.dist - b.place.dist,
    longest: (a, b) => (b.best?.totalLen || 0) - (a.best?.totalLen || 0) || b.sunnyCount - a.sunnyCount || a.place.dist - b.place.dist,
    most: (a, b) => b.sunnyCount - a.sunnyCount || (b.best?.len || 0) - (a.best?.len || 0) || a.place.dist - b.place.dist,
    soonest: (a, b) => (a.first?.start ?? 99) - (b.first?.start ?? 99) || a.place.dist - b.place.dist,
    reliable: (a, b) => b.expected - a.expected || b.sunnyCount - a.sunnyCount || a.place.dist - b.place.dist,
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
  const cells = r.days.map((d, i) => {
    const title = `${fmtDay(d.date)}: ${r.kinds[i]}${r.chances[i] != null ? ` (sun chance ${r.chances[i]}%)` : ''}`;
    const cls = ['d', r.kinds[i], i >= r.windowDays ? 'out' : '', i === 0 ? 'today' : ''].join(' ');
    return `<div class="${cls}" title="${esc(title)}">${dateOf(d.date).getDate()}</div>`;
  }).join('');
  const labels = r.days.map(d => `<span>${esc(fmtWeekday(d.date).slice(0, 2))}</span>`).join('');
  return `<div class="strip">${cells}</div><div class="strip-labels">${labels}</div>`;
}

function headline(r) {
  const h = r.highlight;
  if (!h) return `<span class="badge none">No sure sunny days</span> in the next ${r.windowDays} days` +
    (r.maybeCount ? ` · ${r.maybeCount} maybe` : '');
  const days = r.days;
  const len = h.totalLen || h.len;
  const label = len >= 7 ? `${len} days of sun` : len === 1 ? '1 sunny day' : `${len} sunny days in a row`;
  const cls = len >= 7 ? 'badge week' : 'badge';
  const temp = r.avgMax != null ? ` · ~${r.avgMax}°C` : '';
  const sure = r.sure != null ? ` · <b>${r.sure}% sure</b>` : '';
  const maybe = r.maybeCount ? ` (+${r.maybeCount} maybe)` : '';
  return `<span class="${cls}">☀️ ${label}</span> ${esc(fmtRange(days[h.start].date, days[h.start + len - 1].date))}${temp}${sure}` +
    ` · ${r.sunnyCount}/${r.windowDays} days sunny${maybe}`;
}

function cardHtml(r, idx) {
  const p = r.place;
  const name = p.isHome ? `🏠 ${esc(p.name)}` : `${flag(p.cc)} ${esc(p.name)}`;
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
  const minLabel = s.minStreak === '1' ? 'at least 1 sunny day' : `${s.minStreak}+ sunny days in a row`;
  const checked = state.ens.filter(Boolean).length;
  const ensNote = state.ensMode === 'done' ? ` Sun chance checked for the ${checked} most promising places.`
    : state.ensMode === 'failed' ? ' Sun chance unavailable – using the main forecast only.' : '';
  $('#summary').textContent =
    `${matches.length} of ${others.length} towns within ${s.radius} km have ${minLabel} in the next ${s.window} days.${ensNote}`;
  $('#results').innerHTML = matches.length
    ? matches.map((r, i) => cardHtml(r, i + (home ? 1 : 0))).join('')
    : `<div class="empty">No sunny spells found with these settings.<br>Try a bigger distance, fewer days in a row, or a longer “Within” window.</div>`;
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
  if (len === 1) return v('--c1');
  if (len === 2) return v('--c2');
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
    const len = r.highlight ? (r.highlight.totalLen || r.highlight.len) : 0;
    const m = p.isHome
      ? L.circleMarker([p.lat, p.lon], { radius: 9, color: '#111', weight: 3, fillColor: streakColor(len), fillOpacity: 1 })
      : L.circleMarker([p.lat, p.lon], { radius: 7, color: '#00000055', weight: 1, fillColor: streakColor(len), fillOpacity: .95 });
    m.bindPopup(`<b>${p.isHome ? '🏠 ' : flag(p.cc) + ' '}${esc(p.name)}</b><br>${p.isHome ? 'You are here' : Math.round(p.dist) + ' km ' + p.dir}<br>` +
      `${headline(r)}<br><button class="btn" data-open="${idx}">Details</button>`);
    m.addTo(state.mapLayer);
    bounds.push([p.lat, p.lon]);
  });
  state.map.invalidateSize();
  state.map.fitBounds(bounds, { padding: [20, 20], maxZoom: 9 });
}

// ---------- Detail sheet ----------
function pillStyle(pct, kind) {
  if (pct == null) return '';
  const a = Math.min(1, pct / 100) * 0.85 + 0.1;
  return kind === 'sun' ? `background: rgba(251,191,36,${a})` : `background: rgba(96,165,250,${a})`;
}

function saveCache() {
  if (!state.cacheKey) return;
  store.set('forecastCache', {
    key: state.cacheKey, ts: state.fetchedAt, places: state.places,
    forecasts: state.forecasts, ens: state.ens, ensMode: state.ensMode,
  });
}

function openDetail(idx) {
  let r = state.results[idx];
  if (!r) return;
  const p = r.place, pi = r.pi;
  $('#detailTitle').textContent = `${p.isHome ? '🏠' : flag(p.cc)} ${p.name}`;
  $('#detailSub').textContent = (p.isHome ? 'Your location' : `${Math.round(p.dist)} km ${p.dir} of you`) +
    (p.pop ? ` · pop. ${p.pop.toLocaleString()}` : '');
  $('#directionsLink').href = `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lon}`;
  $('#mapsLink').href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.name + (p.cc ? ', ' + p.cc : ''))}`;
  const pct = Math.round(+state.settings.strictness * 100);
  const renderRows = loading => {
    $('#detailRows').innerHTML = r.days.map((d, i) => {
      const hours = d.sun != null ? (d.sun / 3600).toFixed(1) : '–';
      const share = d.sun != null && d.daylight ? Math.round(100 * d.sun / d.daylight) : null;
      const sc = r.chances[i];
      return `<tr class="${r.kinds[i] === 'sun' ? 'sunny-row' : r.kinds[i] === 'maybe' ? 'maybe-row' : ''}">
        <td><span class="conf ${confidence(i)}">●</span> ${esc(fmtDay(d.date))}</td>
        <td><span class="dot ${r.kinds[i]}" style="margin:0"></span></td>
        <td>${hours} h${share != null ? ` <span class="muted small">(${share}%)</span>` : ''}</td>
        <td>${sc != null ? `<span class="pill" style="${pillStyle(sc, 'sun')}">${sc}%</span>` : loading ? '…' : '–'}</td>
        <td>${d.rainProb != null ? `<span class="pill" style="${pillStyle(d.rainProb, 'rain')}">${d.rainProb}%</span>` : '–'}</td>
        <td>${d.tmax != null ? Math.round(d.tmax) : '–'}° / ${d.tmin != null ? Math.round(d.tmin) : '–'}°</td>
      </tr>`;
    }).join('');
  };
  const note = () => {
    const ens = state.ens[pi];
    $('#ensembleNote').textContent = ens
      ? `Sun chance = share of ${ens.members[0]?.length || 51} forecast scenarios with ${pct}%+ sunshine (first ${ENS_DAYS} days).`
      : 'Sun probabilities are unavailable right now – striped days are unconfirmed.';
  };
  $('#detail').showModal();
  if (state.ens[pi]) { renderRows(false); note(); return; }
  renderRows(true);
  $('#ensembleNote').textContent = 'Loading sun probabilities…';
  fetchEnsembleBatch([p])
    .then(([ens]) => {
      state.ens[pi] = ens;
      saveCache();
      r = analyze(p, r.days, ens, state.settings, pi);
      if (!$('#detail').open) return render();
      renderRows(false); note();
      render();
    })
    .catch(() => { renderRows(false); note(); });
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
    const cached = store.get('forecastCache');
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
    const onWait = () => setStatus('⏳ Weather service is busy (free limit per minute) – continuing in 1 minute…');
    progress(`Checking the weather in ${places.length} towns…`, 0, 1);
    const forecasts = await fetchForecasts(places,
      (done, total) => progress(`Checking the weather in ${places.length} towns…`, done, total), onWait);
    state.places = places; state.forecasts = forecasts; state.fetchedAt = Date.now();
    state.ens = []; state.ensMode = 'pending'; state.cacheKey = key;
    render();

    const picks = pickForEnsemble(places, forecasts);
    const ensLabel = `Checking sun chance (51 scenarios) for ${picks.length} best places…`;
    progress(ensLabel, 0, 1);
    try {
      state.ens = await fetchEnsembles(places, picks, (done, total) => progress(ensLabel, done, total), onWait);
      state.ensMode = 'done';
      setStatus('');
    } catch (e) {
      console.error(e);
      state.ensMode = 'failed';
      setStatus(`⚠️ Couldn't load sun chance (${esc(e.message)}). Showing the main forecast only.`, 'error');
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
