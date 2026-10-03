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

## How "sunny" is decided

Two independent checks must agree before a day counts as **☀️ sunny**:

1. **Main forecast:** sunshine ÷ daylight is at least your chosen level (default 65%) and the chance of rain is below 40%.
2. **Sun chance:** at least 75% of the 51 ECMWF ensemble scenarios reach that same sunshine level
   (deep gold when 90%+).

If only one of them says sunny, the day is **maybe sunny** (striped). Days with ≥1 mm of likely
precipitation are rain or snow. Cards show how sure the sunny spell is (average sun chance), and
"Most reliable sun" sorts by expected sunny days.

Each ensemble scenario counts against Open-Meteo's free limit (600 calls/minute, 10,000/day), so the
sun chance is checked for your location plus the ~80 most promising towns, for the first 10 days.
Days beyond that, and towns that weren't checked, can only be "maybe". Tapping any town checks it
on demand. If the per-minute limit is hit, the app waits a minute and continues.

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
