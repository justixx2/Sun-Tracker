"""Hour-by-hour audit: compares every candidate number for the hourly view with independent sources.

For each city, for today and tomorrow (local time), prints per hour:
  main   Open-Meteo best-match model: cloud %, weather code, mm, precipitation_probability
  icon   DWD ICON (regional high-res) cloud %, mm
  ENS    ECMWF 51-member ensemble: median cloud, sun chance (members <=50% cloud),
         rain chance with two thresholds, and whether the hourly values are 3-hour blocks
  Yr     MET Norway: cloud %, mm, probability_of_precipitation, symbol
  wttr   wttr.in (3-hourly): cloud %, chance of rain, chance of sunshine
Then summarises how far each candidate rain % is from Yr and wttr.
Run: python3 tests/audit-hourly.py   (needs internet)
"""
import json, statistics as st, sys, time, urllib.request, urllib.error
from datetime import datetime, timedelta, timezone

CITIES = [("Druskininkai LT", 54.02, 23.97), ("Vilnius LT", 54.69, 25.28),
          ("Krakow PL", 50.06, 19.94), ("Malaga ES", 36.72, -4.42)]
UA = {"User-Agent": "SunTracker-audit/1.0 github.com/justixx2/Sun-Tracker"}

def get(url, tries=3):
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

def pct(vals, test):
    return round(100 * sum(1 for v in vals if test(v)) / len(vals)) if vals else None

def median(vals):
    return round(st.median(vals)) if vals else None

def openmeteo(lat, lon):
    P = f"latitude={lat}&longitude={lon}&timezone=auto&forecast_days=10"
    main = get(f"https://api.open-meteo.com/v1/forecast?{P}&hourly=weather_code,cloud_cover,precipitation_probability,precipitation,is_day,temperature_2m")
    icon = get(f"https://api.open-meteo.com/v1/forecast?{P}&models=icon_seamless&hourly=cloud_cover,precipitation")
    ens = get(f"https://ensemble-api.open-meteo.com/v1/ensemble?{P}&models=ecmwf_ifs025&hourly=cloud_cover,precipitation")
    return main, icon, ens

def yr(lat, lon, offset_s):
    j = get(f"https://api.met.no/weatherapi/locationforecast/2.0/complete?lat={lat:.2f}&lon={lon:.2f}")
    out = {}
    if "error" in j: return out, j["error"]
    for ts in j["properties"]["timeseries"]:
        t = datetime.fromisoformat(ts["time"].replace("Z", "+00:00")) + timedelta(seconds=offset_s)
        d = ts["data"]; inst = d["instant"]["details"]
        nxt = d.get("next_1_hours")
        out[t.strftime("%Y-%m-%dT%H:00")] = {
            "cloud": inst.get("cloud_area_fraction"),
            "mm": nxt["details"].get("precipitation_amount") if nxt else None,
            "prob": nxt["details"].get("probability_of_precipitation") if nxt else None,
            "sym": nxt["summary"]["symbol_code"] if nxt else (d.get("next_6_hours", {}).get("summary", {}).get("symbol_code")),
        }
    return out, None

def wttr(lat, lon):
    j = get(f"https://wttr.in/{lat},{lon}?format=j1")
    out = {}
    if "error" in j: return out, j["error"]
    for w in j.get("weather", []):
        for h in w["hourly"]:
            hh = int(h["time"]) // 100
            out[f"{w['date']}T{hh:02d}:00"] = {
                "cloud": int(h["cloudcover"]), "rain": int(h["chanceofrain"]), "sun": int(h["chanceofsunshine"]),
                "mm": float(h["precipMM"]), "desc": h["weatherDesc"][0]["value"],
            }
    return out, None

def main():
    diffs = {"main_prob": [], "ens_r01": [], "ens_r003": [], "blend": []}
    diffs_w = {"main_prob": [], "ens_r01": [], "ens_r003": [], "blend": []}
    cloud_diffs = {"main": [], "icon": [], "ens_median": [], "avg(main,ens)": [], "avg(main,icon,ens)": []}
    for name, lat, lon in CITIES:
        m, ic, e = openmeteo(lat, lon)
        errs = [x["error"] for x in (m, ic, e) if "error" in x]
        if errs:
            print(f"\n##### {name}: errors {errs}"); continue
        off = m["utc_offset_seconds"]
        y, ye = yr(lat, lon, off)
        w, we = wttr(lat, lon)
        h, ih, eh = m["hourly"], ic["hourly"], e["hourly"]
        ck = [k for k in eh if k.startswith("cloud_cover")]
        pk = [k for k in eh if k.startswith("precipitation")]
        eidx = {t: i for i, t in enumerate(eh["time"])}
        iidx = {t: i for i, t in enumerate(ih["time"])}
        # Are ensemble hourly precipitation values 3-hour blocks spread evenly?
        m01 = eh.get("precipitation_member01") or eh.get("precipitation")
        nz = [i for i in range(2, min(len(m01), 144)) if m01[i] and m01[i] > 0]
        blocks = sum(1 for i in nz if (m01[i] == m01[i-1] or m01[i] == m01[i+1] if i + 1 < len(m01) else False))
        local_now = datetime.now(timezone.utc) + timedelta(seconds=off)
        today = local_now.strftime("%Y-%m-%d")
        tomorrow = (local_now + timedelta(days=1)).strftime("%Y-%m-%d")
        print(f"\n##### {name}  local time now {local_now:%Y-%m-%d %H:%M}  (UTC{off/3600:+.0f})"
              + (f"  [Yr error: {ye}]" if ye else "") + (f"  [wttr error: {we}]" if we else ""))
        print(f"  ensemble precipitation: {blocks}/{len(nz)} non-zero hours equal a neighbour (high = 3-hour sums spread over hours)")
        print("  time  | main: cloud code  mm prob | icon: cloud mm | ENS: cloud sun% r>=.1 r>=.03 | Yr: cloud  mm prob symbol | wttr: cloud rain% sun% desc")
        for day in (today, tomorrow):
            print(f"  --- {day}")
            for i, t in enumerate(h["time"]):
                if not t.startswith(day): continue
                hh = int(t[11:13])
                if hh < 6 or hh > 21: continue
                j = eidx.get(t); k = iidx.get(t)
                clouds = [eh[x][j] for x in ck if eh[x][j] is not None] if j is not None else []
                rains = [eh[x][j] for x in pk if eh[x][j] is not None] if j is not None else []
                ens_cloud, ens_sun = median(clouds), pct(clouds, lambda v: v <= 50)
                r01, r003 = pct(rains, lambda v: v >= 0.1), pct(rains, lambda v: v >= 0.03)
                prob = h["precipitation_probability"][i]
                blend = round((prob + r01) / 2) if prob is not None and r01 is not None else None
                yy = y.get(t, {}); ww = w.get(t)
                nz = lambda v: '-' if v is None else v
                ys = f"{nz(yy.get('cloud')):>5} {nz(yy.get('mm')):>4} {nz(yy.get('prob')):>4} {str(nz(yy.get('sym')))[:16]:16s}" if yy else f"{'-':>5} {'-':>4} {'-':>4} {'':16s}"
                ws = f"{ww['cloud']:>5} {ww['rain']:>4} {ww['sun']:>4} {ww['desc'][:14]}" if ww else ""
                print(f"  {t[11:16]} | {h['cloud_cover'][i]:>5} {h['weather_code'][i]:>4} {h['precipitation'][i]:>4} {str(prob):>4} | "
                      f"{str(ih['cloud_cover'][k] if k is not None else '-'):>5} {str(ih['precipitation'][k] if k is not None else '-'):>4} | "
                      f"{str(ens_cloud):>5} {str(ens_sun):>4} {str(r01):>5} {str(r003):>5} | {ys} | {ws}")
                if yy.get("prob") is not None and 6 <= hh <= 21:
                    for key, val in (("main_prob", prob), ("ens_r01", r01), ("ens_r003", r003), ("blend", blend)):
                        if val is not None: diffs[key].append(abs(val - yy["prob"]))
                    mc, icc = h["cloud_cover"][i], (ih["cloud_cover"][k] if k is not None else None)
                    a2 = (mc + ens_cloud) / 2 if mc is not None and ens_cloud is not None else None
                    a3 = (mc + icc + ens_cloud) / 3 if None not in (mc, icc, ens_cloud) else None
                    for key, val in (("main", mc), ("icon", icc), ("ens_median", ens_cloud), ("avg(main,ens)", a2), ("avg(main,icon,ens)", a3)):
                        if val is not None and yy.get("cloud") is not None: cloud_diffs[key].append(abs(val - yy["cloud"]))
                if ww and 6 <= hh <= 21:
                    for key, val in (("main_prob", prob), ("ens_r01", r01), ("ens_r003", r003), ("blend", blend)):
                        if val is not None: diffs_w[key].append(abs(val - ww["rain"]))
    print("\n=== Average difference from Yr's rain probability (today+tomorrow, 06-21, all cities) ===")
    for k, v in diffs.items(): print(f"  {k:10s} {round(st.mean(v)) if v else '-'} points  (n={len(v)})")
    print("=== Average difference from wttr.in chance of rain ===")
    for k, v in diffs_w.items(): print(f"  {k:10s} {round(st.mean(v)) if v else '-'} points  (n={len(v)})")
    print("=== Average cloud-cover difference from Yr ===")
    for k, v in cloud_diffs.items(): print(f"  {k:20s} {round(st.mean(v)) if v else '-'} points  (n={len(v)})")

if __name__ == "__main__":
    main()
