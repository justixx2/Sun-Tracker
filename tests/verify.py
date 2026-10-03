"""Accuracy check for Sun Tracker's day classification.

Part 1: compare today's 7-day verdicts with independent forecasters (MET Norway / Yr, wttr.in).
Part 2: backtest the main-forecast rule over the last ~30 days against what actually happened
        (satellite-measured sunshine; ERA5 reanalysis precipitation).
Run: python3 tests/verify.py   (needs internet)
"""
import json, math, statistics as st, sys, urllib.request, urllib.error
from datetime import datetime, timedelta, timezone

CITIES = [("Druskininkai LT", 54.02, 23.97), ("Vilnius LT", 54.69, 25.28), ("Krakow PL", 50.06, 19.94),
          ("Berlin DE", 52.52, 13.40), ("Vaslui RO", 46.64, 27.73), ("Malaga ES", 36.72, -4.42)]
UA = {"User-Agent": "SunTracker-verify/1.0 github.com/justixx2/Sun-Tracker"}
MAX_CLOUD = 60          # daytime cloud % that still counts as sunny (app default)
SURE, MAYBE = 75, 50

def get(url, tries=3):
    import time
    req = urllib.request.Request(url, headers=UA)
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            body = e.read().decode()[:150]
            if e.code == 429 and attempt < tries - 1:
                time.sleep(65); continue
            return {"error": f"{e.code} {body}"}
        except Exception as e:
            if attempt < tries - 1: time.sleep(5); continue
            return {"error": str(e)}

def day_mean(times, vals, day, h0=9, h1=16):
    v = [vals[i] for i, t in enumerate(times) if t.startswith(day) and h0 <= int(t[11:13]) <= h1 and vals[i] is not None]
    return st.mean(v) if v else None

# ---------- the app's rule (keep in sync with app.js classify) ----------
def app_verdict(cloud, sun_ratio, rain_sum, rain_prob, chance):
    wet = (rain_sum or 0) >= 1
    if wet and (rain_prob or 0) >= 50: return "rain"
    main = sun_ratio >= 0.65 and (rain_prob or 0) < 40 and (cloud is None or cloud <= MAX_CLOUD)
    if chance is not None:
        if main and chance >= SURE: return "sun"
        if main or chance >= MAYBE: return "maybe"
    elif main: return "maybe"
    return "rain" if wet else "cloud"

def simple(v):  # collapse to sun / cloud / rain for comparison
    return {"sun": "SUN", "maybe": "maybe", "partly": "cloud", "cloud": "cloud", "rain": "RAIN", "snow": "RAIN"}[v]

# ---------- Part 1 ----------
def ours(lat, lon):
    f = get(f"https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}&timezone=auto&forecast_days=8"
            "&daily=sunshine_duration,daylight_duration,precipitation_sum,precipitation_probability_max&hourly=cloud_cover")
    e = get(f"https://ensemble-api.open-meteo.com/v1/ensemble?latitude={lat}&longitude={lon}&timezone=auto"
            "&forecast_days=8&models=ecmwf_ifs025&hourly=cloud_cover")
    out = {}
    if "error" in f: return {}, 0
    d, h = f["daily"], f["hourly"]
    eh = e.get("hourly", {})
    keys = [k for k in eh if k.startswith("cloud_cover")]
    for i, day in enumerate(d["time"]):
        cloud = day_mean(h["time"], h["cloud_cover"], day)
        members = [day_mean(eh["time"], eh[k], day) for k in keys] if keys else []
        members = [m for m in members if m is not None]
        chance = round(100 * sum(m <= MAX_CLOUD for m in members) / len(members)) if members else None
        ratio = d["sunshine_duration"][i] / d["daylight_duration"][i] if d["daylight_duration"][i] else 0
        out[day] = (app_verdict(cloud, ratio, d["precipitation_sum"][i], d["precipitation_probability_max"][i], chance),
                    round(cloud) if cloud is not None else None, chance, d["precipitation_sum"][i], d["precipitation_probability_max"][i])
    return out, f.get("utc_offset_seconds", 0)

def yr(lat, lon, offset):
    """MET Norway: daytime (local 09-17) cloud fraction + precipitation -> verdict."""
    j = get(f"https://api.met.no/weatherapi/locationforecast/2.0/compact?lat={lat:.2f}&lon={lon:.2f}")
    if "error" in j: return {}, j["error"]
    acc = {}
    for ts in j["properties"]["timeseries"]:
        t = datetime.fromisoformat(ts["time"].replace("Z", "+00:00")) + timedelta(seconds=offset)
        det = ts["data"]["instant"]["details"]
        day = t.strftime("%Y-%m-%d"); a = acc.setdefault(day, {"cloud": [], "rain": 0.0, "sym": []})
        if 9 <= t.hour <= 16: a["cloud"].append(det.get("cloud_area_fraction", 0))
        for key, hrs in (("next_1_hours", 1), ("next_6_hours", 6)):
            if key in ts["data"]:
                if 6 <= t.hour <= 17 or key == "next_6_hours":
                    a["sym"].append(ts["data"][key]["summary"]["symbol_code"])
                if key == "next_1_hours":
                    a["rain"] += ts["data"][key]["details"].get("precipitation_amount", 0)
                break
        else:
            continue
        if "next_1_hours" not in ts["data"] and "next_6_hours" in ts["data"]:
            a["rain"] += ts["data"]["next_6_hours"]["details"].get("precipitation_amount", 0)
    out = {}
    for day, a in acc.items():
        if not a["cloud"]: continue
        c = st.mean(a["cloud"])
        v = "RAIN" if a["rain"] >= 1 else "SUN" if c <= MAX_CLOUD else "cloud"
        out[day] = (v, round(c), round(a["rain"], 1))
    return out, None

def wttr(lat, lon):
    j = get(f"https://wttr.in/{lat},{lon}?format=j1")
    if "error" in j: return {}, j["error"]
    out = {}
    for w in j.get("weather", []):
        hrs = [h for h in w["hourly"] if 900 <= int(h["time"]) <= 1500]
        c = st.mean(int(h["cloudcover"]) for h in hrs)
        rain = float(w.get("totalSnow_cm", 0)) * 10 + sum(float(h["precipMM"]) for h in w["hourly"])
        out[w["date"]] = ("RAIN" if rain >= 1 else "SUN" if c <= MAX_CLOUD else "cloud", round(c), round(rain, 1))
    return out, None

def part1():
    print("=" * 100)
    print("PART 1: today's forecast — Sun Tracker vs independent forecasters (daytime 9-17 local)")
    print("=" * 100)
    agree = total = 0; disagreements = []
    for name, lat, lon in CITIES:
        o, off = ours(lat, lon)
        y, ye = yr(lat, lon, off)
        w, we = wttr(lat, lon)
        print(f"\n{name}" + (f"  [yr error: {ye}]" if ye else "") + (f"  [wttr error: {we}]" if we else ""))
        print(f"  {'day':10s} {'SunTracker':28s} {'Yr (MET Norway)':22s} {'wttr.in':18s}")
        for day in sorted(o)[:7]:
            v, cloud, chance, rs, rp = o[day]
            ours_s = f"{simple(v):6s} cl{cloud} ch{chance} r{rs}/{rp}%"
            ys = f"{y[day][0]:6s} cl{y[day][1]} r{y[day][2]}" if day in y else "-"
            ws = f"{w[day][0]:6s} cl{w[day][1]} r{w[day][2]}" if day in w else "-"
            print(f"  {day:10s} {ours_s:28s} {ys:22s} {ws:18s}")
            for other in (y.get(day), w.get(day)):
                if not other or simple(v) == "maybe": continue
                total += 1
                if simple(v) == other[0] or (simple(v) == "cloud" and other[0] == "cloud"): agree += 1
                elif simple(v) == "SUN" and other[0] != "SUN": disagreements.append(f"{name} {day}: we SUN, other {other}")
                elif simple(v) == "RAIN" and other[0] != "RAIN": disagreements.append(f"{name} {day}: we RAIN, other {other}")
    print(f"\nAgreement on definite days (excluding 'maybe'): {agree}/{total} = {round(100*agree/max(total,1))}%")
    print("Days we call SUN/RAIN but another source disagrees:")
    for d in disagreements: print("   ", d)

# ---------- Part 2: backtest ----------
def clear_sky_ghi(lat, lon, t_utc):
    doy = t_utc.timetuple().tm_yday
    decl = 23.44 * math.sin(math.radians(360 / 365 * (doy - 81)))
    eot = 9.87 * math.sin(math.radians(2 * 360 / 365 * (doy - 81))) - 7.53 * math.cos(math.radians(360 / 365 * (doy - 81))) - 1.5 * math.sin(math.radians(360 / 365 * (doy - 81)))
    solar_time = t_utc.hour + t_utc.minute / 60 + lon / 15 + eot / 60
    ha = 15 * (solar_time - 12)
    cz = math.sin(math.radians(lat)) * math.sin(math.radians(decl)) + math.cos(math.radians(lat)) * math.cos(math.radians(decl)) * math.cos(math.radians(ha))
    return 0 if cz <= 0.05 else 1098 * cz * math.exp(-0.057 / cz)   # Haurwitz model

def part2():
    print("\n" + "=" * 100)
    print("PART 2: backtest — forecasts made 1/3/5 days ahead vs what actually happened (last ~30 days)")
    print("  actual sun = satellite-measured solar radiation vs clear-sky (09-17 local, ≥60% = sunny, ≤40% = cloudy)")
    print("  actual rain = ERA5 reanalysis precipitation ≥1 mm")
    print("=" * 100)
    leads = [1, 3, 5]
    stats = {L: {"sun_pred": 0, "sun_hit": 0, "sun_actual": 0, "sun_found": 0, "rain_pred": 0, "rain_hit": 0, "rain_actual": 0, "rain_found": 0, "n": 0} for L in leads}
    end = (datetime.now(timezone.utc) - timedelta(days=6)).date(); start = end - timedelta(days=28)
    for name, lat, lon in CITIES:
        vars_ = ",".join([f"cloud_cover_previous_day{L}" for L in leads] + [f"precipitation_previous_day{L}" for L in leads])
        pr = get(f"https://previous-runs-api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}&timezone=auto"
                 f"&start_date={start}&end_date={end}&hourly={vars_}")
        sat = get(f"https://satellite-api.open-meteo.com/v1/archive?latitude={lat}&longitude={lon}&timezone=auto"
                  f"&start_date={start}&end_date={end}&hourly=shortwave_radiation")
        era = get(f"https://archive-api.open-meteo.com/v1/archive?latitude={lat}&longitude={lon}&timezone=auto"
                  f"&start_date={start}&end_date={end}&daily=precipitation_sum&hourly=cloud_cover")
        errs = [x["error"] for x in (pr, sat, era) if "error" in x]
        if errs:
            print(f"{name}: errors {errs}"); continue
        off = pr.get("utc_offset_seconds", 0)
        ph, sh, eh = pr["hourly"], sat["hourly"], era["hourly"]
        line = []
        for k, day in enumerate(era["daily"]["time"]):
            # actual sunniness from satellite
            obs = cs = 0
            for i, t in enumerate(sh["time"]):
                if t.startswith(day) and 9 <= int(t[11:13]) <= 16 and sh["shortwave_radiation"][i] is not None:
                    tu = datetime.fromisoformat(t) - timedelta(seconds=off) + timedelta(minutes=-30)
                    obs += sh["shortwave_radiation"][i]; cs += clear_sky_ghi(lat, lon, tu)
            if cs == 0: continue
            k_ratio = obs / cs
            actual_sun = k_ratio >= 0.6; actual_cloud = k_ratio <= 0.4
            actual_rain = (era["daily"]["precipitation_sum"][k] or 0) >= 1
            line.append(f"{day[5:]}:{'S' if actual_sun else 'C' if actual_cloud else 'p'}{'R' if actual_rain else ''}")
            for L in leads:
                c = day_mean(ph["time"], ph[f"cloud_cover_previous_day{L}"], day)
                r = sum(ph[f"precipitation_previous_day{L}"][i] or 0 for i, t in enumerate(ph["time"]) if t.startswith(day))
                if c is None: continue
                s = stats[L]; s["n"] += 1
                pred_sun = c <= MAX_CLOUD and r < 1
                pred_rain = r >= 1
                s["sun_pred"] += pred_sun; s["sun_hit"] += pred_sun and actual_sun
                s["sun_actual"] += actual_sun; s["sun_found"] += actual_sun and pred_sun
                s["rain_pred"] += pred_rain; s["rain_hit"] += pred_rain and actual_rain
                s["rain_actual"] += actual_rain; s["rain_found"] += actual_rain and pred_rain
                if pred_sun and actual_cloud: print(f"   MISS {name} {day} (lead {L}d): forecast sunny (cloud {round(c)}%), satellite says cloudy ({round(100*k_ratio)}% of clear-sky)")
        print(f"{name} actual: " + " ".join(line))
    print("\nSummary (main-forecast rule: daytime cloud ≤60% and <1 mm rain):")
    for L in leads:
        s = stats[L]
        pct = lambda a, b: f"{round(100*a/b)}%" if b else "-"
        print(f"  {L} day(s) ahead: forecast 'sunny' was right {pct(s['sun_hit'], s['sun_pred'])} ({s['sun_hit']}/{s['sun_pred']});"
              f" caught {pct(s['sun_found'], s['sun_actual'])} of actual sunny days |"
              f" forecast 'rain' right {pct(s['rain_hit'], s['rain_pred'])} ({s['rain_hit']}/{s['rain_pred']});"
              f" caught {pct(s['rain_found'], s['rain_actual'])} of rainy days  (n={s['n']})")

if __name__ == "__main__":
    which = sys.argv[1:] or ["2", "1"]
    if "2" in which: part2()
    if "1" in which: part1()
