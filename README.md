# ☀️ Sun Tracker

A phone app (installable web app / PWA) that shows the **closest towns with sunny weather** around you
for the next days, so you can see where to travel for sun.

- Uses your phone's location (or a town you pick).
- Checks the forecast in ~250 towns spread evenly around you (towns with 5,000+ people, from GeoNames),
  up to 2,500 km away.
- 16-day daily forecast per town: sunshine hours, chance of rain, temperatures.
- Shows how long the sun lasts: "☀️ 6 sunny days in a row · Sat 4 → Thu 9", plus a 16-day colour strip.
- Tap a town for day-by-day details, including a **sun chance %** from 51 ECMWF ensemble scenarios,
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

For each day: sunshine duration ÷ daylight duration. A day is **sunny** when that is at least the
chosen threshold (default 65%) and the chance of rain is below 40%. Lower values count as partly
cloudy / cloudy, and days with ≥1 mm of likely precipitation as rain or snow. Forecasts are most
reliable for the first 2–3 days and get rough after ~7.

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
