# -*- coding: utf-8 -*-
"""Fetch ICES CTD profiles from EMODnet Physics' ERDDAP into the observation
store, as an ordinary collection like any other.

    python tools/fetch_observations.py --dataset data/nwes-3nm-aug2015
    python tools/fetch_observations.py --bbox 50,62,-5,10 --from 2015-08-01 --to 2015-08-31
    python tools/fetch_observations.py --dataset data/nwes-3nm-aug2015 --dry-run

The area and period come either from a processed dataset (its domain and time
axis, with a little slack) or from --bbox/--from/--to. The casts are screened,
written as a DTV observation CSV plus sidecar (profiles: station = cast, one
row per depth), and handed to obs_ingest.py -- so they are classified, stored
and matched exactly as an uploaded file would be, and every run over that area
and period sees them. Nothing is fetched at view time: a recording made today
shows the same casts next year.

The raw ERDDAP response is cached (data/observations/_cache/), because choosing
which casts to keep is the part that gets revisited and the download is the
part that is slow and rate-limited. The prepared CSV and sidecar are kept
beside it.

Quality control: ICES publishes SeaDataNet/ODV flags, but in this collection
they are overwhelmingly absent -- for 2015 North Sea CTDs almost every QV_ODV_*
is NaN. So an explicitly bad flag rejects a value, and everything else is
screened on physical range instead. That is weaker than a flag-based screen and
it is the honest ceiling of what this source supports; the caption in any figure
built from it should say "ICES CTD, range-screened", not "quality-controlled".
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import io
import json
import os
import sys
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import obs_ingest  # noqa: E402

ERDDAP = "https://erddap.emodnet-physics.eu/erddap/tabledap/ICES_CTD.csv"

# output column -> (ERDDAP column, flag column, plausible range, units, long name)
CHANNELS = {
    "temp": ("Temperature", "QV_ODV_4", (-2.5, 35.0), "degC", "Water temperature"),
    "salt": ("Practical_Salinity", "QV_ODV_5", (0.0, 41.0), "PSU", "Practical salinity"),
    "chla": ("Chlorophyll_a_ug_l", "QV_ODV_25", (0.0, 50.0), "ug/l", "Chlorophyll-a"),
}
ID_COLS = ("time", "latitude", "longitude", "Cruise", "Station", "Bot_Depth", "depth")

# SeaDataNet L20: 1 good, 2 probably good, 5/6 changed/below-detection are usable;
# 3 probably bad, 4 bad, 8 interpolated, 9 missing are not.
BAD_FLAGS = {"3", "4", "8", "9"}

MIN_LEVELS = 4          # fewer than this is a bottle sample, not a profile
MIN_SPAN_M = 5.0        # a profile that spans less than this shows no structure
MAX_LEVELS = 120        # thinned evenly beyond this, both ends kept


def log(msg):
    print(f"[ctd] {msg}", flush=True)


def num(x):
    try:
        v = float(x)
        return v if v == v else None       # NaN -> None
    except (TypeError, ValueError):
        return None


def fetch(box, t0, t1, cache):
    """ERDDAP tabledap query for the box and time range, cached on disk."""
    if os.path.exists(cache) and os.path.getsize(cache) > 0:
        log(f"cache hit {os.path.basename(cache)} ({os.path.getsize(cache)/1e6:.1f} MB)")
        return open(cache, encoding="utf-8", errors="replace").read()
    cols = ",".join(ID_COLS + tuple(c for ch in CHANNELS.values() for c in ch[:2]))
    q = (f"{cols}"
         f"&time>={t0:%Y-%m-%dT%H:%M:%SZ}&time<={t1:%Y-%m-%dT%H:%M:%SZ}"
         f"&latitude>={box[0]}&latitude<={box[1]}"
         f"&longitude>={box[2]}&longitude<={box[3]}")
    # '<' and '>' are structural in ERDDAP's query grammar but must still reach
    # it percent-encoded; sending them raw returns 400.
    url = ERDDAP + "?" + urllib.parse.quote(q, safe="=&,.:-")
    log(f"GET {url[:110]}...")
    with urllib.request.urlopen(url, timeout=900) as r:
        raw = r.read().decode("utf-8", "replace")
    os.makedirs(os.path.dirname(cache) or ".", exist_ok=True)
    tmp = cache + ".part"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(raw)
    os.replace(tmp, cache)
    log(f"cached {len(raw)/1e6:.1f} MB")
    return raw


def parse_casts(raw):
    """Group the flat table into casts keyed by cruise/station/minute."""
    casts = {}
    for r in csv.DictReader(io.StringIO(raw)):
        if r.get("time") in (None, "", "UTC"):
            continue                                  # the units row
        lat, lon, z = num(r["latitude"]), num(r["longitude"]), num(r["depth"])
        if lat is None or lon is None or z is None:
            continue
        key = (r.get("Cruise", ""), r.get("Station", ""), r["time"][:16])
        c = casts.setdefault(key, {"lat": lat, "lon": lon, "time": r["time"], "levels": {}})
        lv = c["levels"].setdefault(round(z, 2), {})
        for out, (col, flag, (lo, hi), _u, _n) in CHANNELS.items():
            v = num(r.get(col))
            if v is None or not (lo <= v <= hi):
                continue
            if str(r.get(flag, "")).strip() in BAD_FLAGS:
                continue
            lv[out] = v
    return casts


def thin(depths, cap):
    """Evenly keep at most `cap` levels, always both ends."""
    n = len(depths)
    if n <= cap:
        return depths
    keep = {0, n - 1} | {round(i * (n - 1) / (cap - 1)) for i in range(cap)}
    return [depths[i] for i in sorted(keep)]


def screen(casts, box, t0, t1, want):
    """Casts inside the box and period with a real profile -> CSV rows."""
    rows, dropped, kept, per = [], dict(outside=0, time=0, short=0, flat=0, novar=0), 0, {k: 0 for k in want}
    for (cruise, station, _t), c in sorted(casts.items()):
        if not (box[0] <= c["lat"] <= box[1] and box[2] <= c["lon"] <= box[3]):
            dropped["outside"] += 1
            continue
        when = dt.datetime.fromisoformat(c["time"].replace("Z", "+00:00"))
        if not (t0 <= when <= t1):
            dropped["time"] += 1
            continue
        depths = sorted(c["levels"])
        if len(depths) < MIN_LEVELS:
            dropped["short"] += 1
            continue
        if depths[-1] - depths[0] < MIN_SPAN_M:
            dropped["flat"] += 1
            continue
        depths = thin(depths, MAX_LEVELS)
        has = [k for k in want if sum(k in c["levels"][d] for d in depths) >= MIN_LEVELS]
        if not has:
            dropped["novar"] += 1
            continue
        kept += 1
        for k in has:
            per[k] += 1
        cid = f"{cruise}/{station}".strip("/") or f"{c['lat']:.3f}N{c['lon']:.3f}E"
        # one cast per (cruise, station, minute): a station re-occupied later
        # in the cruise is a different cast
        sid = f"{cid}@{when:%Y%m%dT%H%M}"
        for d in depths:
            lv = c["levels"][d]
            rows.append([sid, cid, c["time"], f"{c['lat']:.4f}", f"{c['lon']:.4f}", f"{d:g}"]
                        + [("" if k not in has or lv.get(k) is None else f"{lv[k]:.3f}") for k in want])
    return rows, dropped, kept, per


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0],
                                 formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__)
    ap.add_argument("--dataset", help="processed dataset directory: take its domain and time axis")
    ap.add_argument("--bbox", help="lat0,lat1,lon0,lon1 (instead of --dataset)")
    ap.add_argument("--from", dest="t_from", help="first day, YYYY-MM-DD (instead of --dataset)")
    ap.add_argument("--to", dest="t_to", help="last day, YYYY-MM-DD (instead of --dataset)")
    ap.add_argument("--pad", type=float, default=0.25,
                    help="degrees of slack around a dataset's domain (0.25)")
    ap.add_argument("--vars", default="temp,salt,chla", help="channels to keep (temp,salt,chla)")
    ap.add_argument("--id", help="collection id (default ices-ctd-<from>-<to>)")
    ap.add_argument("--title", help="collection title")
    ap.add_argument("--cache", default=None, help="raw ERDDAP CSV (default under data/observations/_cache)")
    ap.add_argument("--store", default=obs_ingest.STORE, help="observation store")
    ap.add_argument("--dry-run", action="store_true", help="report only; write nothing to the store")
    a = ap.parse_args(argv)

    want = [v.strip() for v in a.vars.split(",") if v.strip() in CHANNELS]
    if a.dataset:
        meta = json.load(open(os.path.join(a.dataset, "meta.json"), encoding="utf-8"))
        start = dt.datetime.fromisoformat(meta["startDate"]).replace(tzinfo=dt.timezone.utc)
        span = (meta.get("nDays") or 1) * (meta.get("stepDays") or 1.0)
        # a few days of slack so the viewer's +/- window has casts at both ends
        t0 = start - dt.timedelta(days=4)
        t1 = start + dt.timedelta(days=span + 4)
        box = (round(meta["latMin"] - a.pad, 3), round(meta["latMax"] + a.pad, 3),
               round(meta["lonMin"] - a.pad, 3), round(meta["lonMax"] + a.pad, 3))
        region = meta.get("title", os.path.basename(os.path.normpath(a.dataset)))
    elif a.bbox and a.t_from and a.t_to:
        box = tuple(float(x) for x in a.bbox.split(","))
        t0 = dt.datetime.fromisoformat(a.t_from).replace(tzinfo=dt.timezone.utc)
        t1 = dt.datetime.fromisoformat(a.t_to).replace(tzinfo=dt.timezone.utc) + dt.timedelta(days=1)
        region = f"{box[0]}–{box[1]} N, {box[2]}–{box[3]} E"
    else:
        ap.error("give --dataset, or --bbox with --from and --to")
    log(f"{region}: {box[0]}..{box[1]}N {box[2]}..{box[3]}E, {t0:%Y-%m-%d} .. {t1:%Y-%m-%d}")

    cid = a.id or f"ices-ctd-{t0:%Y%m%d}-{t1:%Y%m%d}"
    work = os.path.join(a.store, "_cache")
    cache = a.cache or os.path.join(
        work, f"ices_ctd_{box[0]}_{box[1]}_{box[2]}_{box[3]}_{t0:%Y%m%d}_{t1:%Y%m%d}.csv")
    casts = parse_casts(fetch(box, t0, t1, cache))
    log(f"{len(casts)} casts in the response")
    rows, dropped, kept, per = screen(casts, box, t0, t1, want)
    log("dropped: " + (", ".join(f"{k} {v}" for k, v in dropped.items() if v) or "none"))
    if not kept:
        log("nothing survived screening; the store is left alone")
        return 1
    log(f"kept {kept} casts, {len(rows)} levels — " + ", ".join(f"{k}:{n}" for k, n in per.items()))

    os.makedirs(work, exist_ok=True)
    csv_path = os.path.join(work, f"{cid}.csv")
    side_path = os.path.join(work, f"{cid}.json")
    tmp = csv_path + ".part"
    with open(tmp, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["station", "station_name", "time", "lat", "lon", "depth"] + want)
        w.writerows(rows)
    os.replace(tmp, csv_path)
    side = {
        "format": obs_ingest.FORMAT,
        "id": cid,
        "title": a.title or f"ICES CTD — {region}",
        "description": (f"CTD casts from the ICES database via EMODnet Physics ERDDAP, fetched "
                        f"{dt.date.today().isoformat()} with tools/fetch_observations.py. Range-screened, "
                        f"not quality-controlled: explicit SeaDataNet bad flags (3, 4, 8, 9) rejected, values "
                        f"kept only inside physical ranges; a cast needs >= {MIN_LEVELS} levels spanning "
                        f">= {MIN_SPAN_M:.0f} m, and is thinned to {MAX_LEVELS} levels."),
        "source": "ICES CTD via EMODnet Physics ERDDAP",
        "url": ERDDAP,
        "time_zone": "UTC",
        "vertical_units": "m",
        "variables": {k: {"units": CHANNELS[k][3], "long_name": CHANNELS[k][4]}
                      for k in want if per[k]},
    }
    tmp = side_path + ".part"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        json.dump(side, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp, side_path)

    doc, files = obs_ingest.ingest(csv_path, side_path, cid=cid, out_root=a.store, dry_run=a.dry_run)
    print(obs_ingest.report(doc, files))
    return 0


if __name__ == "__main__":
    sys.exit(main())
