# ☀️ Sun Tracker

A phone app (installable web app / PWA) that shows the **closest towns with sunny weather** around you
for the next days, so you can see where to travel for sun.

- Uses your phone's location (or a town you pick).
- Checks the forecast in ~250 towns spread evenly around you (towns with 5,000+ people, from GeoNames),
  up to 2,500 km away.
- 16-day daily forecast per town: sunshine hours, chance of rain, temperatures.
- Shows how long the sun lasts: "☀️ 6 sunny days in a row · Sat 4 → Thu 9", plus a 16-day colour strip.
- Each sunny day is confirmed against 51 ECMWF ensemble scenarios (**sun chance %**); tap a town for day-by-day details,
  a forecast-reliability marker, and a Directions button (Google Maps).
- Filters: distance, minimum sunny days in a row, how many days ahead, how strict "sunny" is,
  and sort by closest / longest sun / most sunny days / soonest.
- Map view coloured by length of the sunny spell.
- Tap a day to see it **hour by hour** (condition, temperature, chance of sun and rain).
- **45-day forecast** for any place from ECMWF's extended-range ensemble (51 scenarios); beyond two
  weeks it shows the likely trend rather than pretending to know the exact day.

No account, no API key, no server: weather comes from the free [Open-Meteo](https://open-meteo.com/) API.
Forecasts are cached for an hour.

## Put it on your phone

1. On GitHub: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. Push to `main` (or re-run the "Deploy to GitHub Pages" workflow). The site appears at
   `https://<your-username>.github.io/Sun-Tracker/`.
3. Open that link on your phone:
   - **Android (Chrome):** menu ⋮ → *Add to Home screen* / *Install app*.
   - **iPhone (Safari):** Share → *Add to Home Screen*.
4. Allow location access when asked.

## How the weather is decided

Each day shows one simple verdict: ☀️ Sunny, 🌤️ Maybe sunny, ☁️ Cloudy, 🌧️ Rain or ❄️ Snow.

- **Sunny** — the main forecast has ≤ 60% cloud between 9:00 and 17:00 (and little rain risk),
  **and** at least 75% of the 51 ECMWF ensemble scenarios agree.
- **Maybe sunny** — only one of the two says sunny (or 50–75% of the scenarios do).
- **Rain** — at least 1 mm with a 50%+ chance, or 5 mm or more.
- **Cloudy** — everything else.

Cloud cover is used rather than "sunshine hours", because some models report hours of sunshine
under 100% cloud.

**Hour by hour** (tap a day): ☀️ sun chance is a weighted vote of three independent forecasts –
the share of the 51 ECMWF scenarios with the sun mostly out (≤ 60% cloud), the main Open-Meteo model
and DWD ICON – and the label (Sunny / Mostly sunny / Partly cloudy / Cloudy) is derived from that same
number. No single source is trusted alone: compared with Yr, each one is badly wrong at different
hours. 💧 rain chance is Open-Meteo's hourly precipitation probability, which tracks Yr within a few
points and is the same number the daily "Rain" verdict uses, so the two views never contradict each
other. The ECMWF scenarios' hourly rain is not used: it is a 3-hour total spread over hours and comes
from an older run.

**Checks:** `tests/verify.py` compares daily verdicts with independent forecasters (MET Norway / Yr,
wttr.in) and backtests them against satellite-measured sunshine; `tests/audit-hourly.py` compares
every hourly number with Yr, wttr.in and a second model. Both run from the Actions tab.

Each ensemble scenario counts against Open-Meteo's free limit (600 calls/minute, 10,000/day), so the
double-check runs for your location plus the ~60 most promising towns. Towns that weren't checked
can only be "maybe"; tapping one checks it on demand. If the per-minute limit is hit, the app waits a minute and continues.

## Run locally

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

## Rebuild the town list

```sh
npm i --no-save all-the-cities@3.1.0
node scripts/build-cities.js
```
