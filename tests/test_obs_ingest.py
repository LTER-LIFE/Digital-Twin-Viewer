# -*- coding: utf-8 -*-
"""Tests for obs_ingest.py on small synthetic files, one per sampling geometry.

    python tests/test_obs_ingest.py          # or: pytest tests/

Each case builds its input in a temporary directory, ingests it into a
temporary store, and checks what the classifier decided and what was written.
"""
import datetime as dt
import json
import math
import os
import shutil
import sys
import tempfile

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import obs_ingest as oi  # noqa: E402

VOCAB = oi.Vocab()


class Tmp:
    def __enter__(self):
        self.dir = tempfile.mkdtemp(prefix="obs_test_")
        self.store = os.path.join(self.dir, "store")
        return self

    def __exit__(self, *a):
        shutil.rmtree(self.dir, ignore_errors=True)

    def write(self, name, text):
        p = os.path.join(self.dir, name)
        with open(p, "w", encoding="utf-8") as f:
            f.write(text)
        return p

    def side(self, name, obj):
        return self.write(name, json.dumps(obj))

    def load(self, cid, rel):
        with open(os.path.join(self.store, cid, rel), encoding="utf-8") as f:
            return json.load(f)


def iso(d):
    return d.strftime("%Y-%m-%dT%H:%M:%S")


# ------------------------------------------------------------------ vocabulary
def test_units():
    c = VOCAB.conversion
    assert c("mg/l", "mg/m3")[0] == 1000
    assert c("µg/l", "mg Chl/m3")[0] == 1 and c("µg/l", "mg Chl/m3")[3]   # element unstated on one side
    assert c("g C/m2", "mg C/m2")[0] == 1000
    assert c("g AFDM/m2", "mg C/m2") is None                    # different element: never converts
    f, o, approx, _ = c("K", "degC")
    assert f == 1 and abs(o + 273.15) < 1e-9
    assert c("deg C", "degC")[0] == 1                           # not 'degrees of carbon'
    assert c("cm/s", "m/s")[0] == 0.01
    assert c("umol/l", "mmol N/m3")[0] == 1
    assert c("g/kg", "PSU")[2] is True                          # approximate
    assert c("m", "degC") is None


def test_quantities():
    q = VOCAB.quantity
    assert q("T") == "sea_water_temperature"
    assert q("sal") == "sea_water_salinity"
    assert q("Hm0") == "significant_wave_height"
    assert q("hs-out") == "significant_wave_height"
    assert q("x", "sea_water_temperature") == "sea_water_temperature"
    assert q("chla_surface") == "chlorophyll_a"
    assert q("percentage_mud") == "mud_fraction"
    assert q("y2c") == "deposit_feeders_carbon"
    assert q("nonsense_variable") is None


def test_projections():
    # Waterinfo publishes both: EPSG:25831 x/y and the WKT point it maps to
    la, lo = oi.utm_to_latlon(712678.22430728, 5922713.53302676, 31)
    assert abs(la - 53.41055305157381) < 2e-5 and abs(lo - 6.199994766129746) < 2e-5
    la, lo = oi.rd_to_latlon(155000, 463000)                    # Amersfoort, the RD origin
    assert abs(la - 52.15517440) < 1e-6 and abs(lo - 5.38720621) < 1e-6
    la, lo = oi.rd_to_latlon(116000, 553000)                    # Texel, ~53.0 N 4.8 E
    assert 52.9 < la < 53.1 and 4.7 < lo < 4.9


# ------------------------------------------------------------------ geometries
def test_wide_continuous_timeseries():
    with Tmp() as T:
        t0 = dt.datetime(2015, 1, 1)
        rows = ["time,temp [degC],temp_qc,sal [psu],temp_std"]
        for h in range(24 * 10):
            d = t0 + dt.timedelta(hours=h)
            qc = 4 if h == 5 else 0
            rows.append(f"{iso(d)},{5 + math.sin(h / 4):.3f},{qc},{30 + h * 0.001:.3f},0.1")
        csvp = T.write("jetty.csv", "\n".join(rows))
        side = T.side("jetty.json", {
            "format": "dtv-observations/1", "title": "Jetty", "time_zone": "UTC",
            "stations": {"JETTY": {"name": "NIOZ jetty", "lat": 53.0017, "lon": 4.7894}},
            "flags": {"good": [0]},
        })
        doc, files = oi.ingest(csvp, side, out_root=T.store)
        assert doc["kind"] == "timeseries", doc["kind"]
        st = doc["stations"][0]
        assert st["cadence"] == "continuous" and st["name"] == "NIOZ jetty"
        assert set(doc["variables"]) == {"temp", "sal"}           # temp_std skipped as auxiliary
        assert doc["variables"]["temp"]["quantity"] == "sea_water_temperature"
        assert doc["variables"]["sal"]["quantity"] == "sea_water_salinity"
        assert doc["variables"]["temp"]["n"] == 239               # one flagged bad value dropped
        body = T.load("jetty", "ts/jetty/2015.json")
        assert body["vars"]["temp"]["t"][:2] == [0, 60]          # minutes since 1 Jan
        idx = json.load(open(os.path.join(T.store, "index.json")))
        assert idx["collections"][0]["id"] == "jetty"


def test_long_format_with_wkt_offsets_and_detection_limits():
    with Tmp() as T:
        rows = ["locatiecode;naam;tijdstip;parameter_code;grootheid;meetwaarde;eenheid;limietsymbool;geom"]
        k = 0
        for st, (lon, lat) in {"MARSDND": (4.75, 53.0), "VLIESM": (5.15, 53.3), "DOOVBWT": (5.05, 53.05)}.items():
            for m in range(1, 13):
                for par, unit, val in (("NO3", "umol/l", "12,5"), ("ZS", "mg/l", "23,4"), ("CHLFa", "ug/l", "0,5")):
                    lim = "<" if (par == "CHLFa" and m == 1) else ""
                    rows.append(f"{st};{st} name;2015-{m:02d}-10T10:00:00+01:00;{par};Concentratie;"
                                f"{val};{unit};{lim};POINT ({lon} {lat})")
                    k += 1
        csvp = T.write("mwtl.csv", "\n".join(rows))
        side = T.side("mwtl.json", {"format": "dtv-observations/1",
                                    "columns": {"parameter_code": "variable"}})
        doc, _ = oi.ingest(csvp, side, out_root=T.store)
        assert doc["kind"] == "timeseries", doc["kind"]
        assert doc["nStations"] == 3
        assert doc["stations"][0]["cadence"] == "discrete"
        v = doc["variables"]
        assert v["NO3"]["quantity"] == "nitrate" and v["ZS"]["quantity"] == "suspended_particulate_matter"
        assert v["CHLFa"]["quantity"] == "chlorophyll_a" and v["CHLFa"]["nBelowDL"] == 3
        assert abs(v["NO3"]["min"] - 12.5) < 1e-9                 # decimal comma read
        body = T.load("mwtl", "ts/marsdnd/2015.json")
        assert body["vars"]["NO3"]["t"][0] == (9 * 24 + 9) * 60   # 10 Jan 10:00 +01:00 = 09:00 UTC


def test_survey():
    with Tmp() as T:
        rng = np.random.default_rng(1)
        rows = ["station,date,lat,lon,median_grain_size [um],percentage_mud [%]"]
        for y in (2014, 2015):
            for s in range(60):
                lat = 53.0 + (s // 10) * 0.05
                lon = 4.8 + (s % 10) * 0.08
                rows.append(f"S{s},{y}-07-{1 + s % 28:02d},{lat:.5f},{lon:.5f},"
                            f"{150 + rng.normal(0, 20):.1f},{abs(rng.normal(5, 3)):.2f}")
        csvp = T.write("sibes.csv", "\n".join(rows))
        doc, _ = oi.ingest(csvp, None, cid="sibes", out_root=T.store)
        assert doc["kind"] == "survey", doc["kind"]
        assert doc["points"]["n"] == 120 and doc["points"]["nStations"] == 60
        assert any("only a date" in i for i in doc["info"])
        body = T.load("sibes", "points/2015.json")
        assert len(body["station"]) == 60 and set(body["v"]) == {"median_grain_size", "percentage_mud"}
        assert body["t"][0] % (24 * 60) == 12 * 60                # date-only placed at noon
        assert doc["variables"]["median_grain_size"]["quantity"] == "median_grain_size"


def test_profiles():
    with Tmp() as T:
        rows = ["station,time,lat,lon,depth,temp,salt"]
        for c in range(6):
            t0 = dt.datetime(2015, 8, 3 + c * 4, 10)
            for k, d in enumerate(np.arange(1, 40, 2.0)):
                tt = t0 + dt.timedelta(seconds=10 * k)            # every level its own stamp
                rows.append(f"C{c},{iso(tt)}Z,{55 + c * 0.3},{3 + c * 0.2},{d},{16 - d * 0.2:.2f},{34.5 + d * 0.01:.3f}")
        csvp = T.write("ctd.csv", "\n".join(rows))
        doc, _ = oi.ingest(csvp, None, out_root=T.store)
        assert doc["kind"] == "profiles", doc["kind"]
        assert doc["profiles"]["n"] == 6
        assert doc["vertical"]["kind"] == "depth"
        body = T.load("ctd", "profiles/2015.json")
        cast = body["casts"][0]
        assert len(cast["z"]) == 20 and set(cast["v"]) == {"temp", "salt"}


def test_mooring_is_timeseries_profile():
    with Tmp() as T:
        rows = ["time,depth,temp [degC]"]
        t0 = dt.datetime(2015, 1, 1)
        for k in range(6 * 24 * 3):
            tt = t0 + dt.timedelta(minutes=10 * k)
            for d in (2, 8, 15):
                rows.append(f"{iso(tt)}Z,{d},{8 - d * 0.1:.2f}")
        csvp = T.write("mooring.csv", "\n".join(rows))
        side = T.side("mooring.json", {"format": "dtv-observations/1",
                                       "stations": {"M1": {"lat": 53.4, "lon": 5.3}}})
        doc, _ = oi.ingest(csvp, side, out_root=T.store)
        assert doc["kind"] == "timeseries_profile", doc["kind"]
        st = doc["stations"][0]
        assert st["depths"] == [2.0, 8.0, 15.0] and st["cadence"] == "continuous"


def test_naive_time_zone_and_projected_coordinates():
    with Tmp() as T:
        rows = ["code,x,y,datum,tijd,T"]
        rows += [f"A,116000,553000,2015-03-0{d},14:30,{6 + d}" for d in range(1, 8)]
        csvp = T.write("rd.csv", "\n".join(rows))
        side = T.side("rd.json", {"format": "dtv-observations/1", "crs": "EPSG:28992",
                                  "time_zone": "+01:00"})
        doc, _ = oi.ingest(csvp, side, out_root=T.store)
        st = doc["stations"][0]
        assert 52.9 < st["lat"] < 53.1 and 4.7 < st["lon"] < 4.9
        body = T.load("rd", "ts/a/2015.json")
        # 1 March 14:30 at +01:00 = 13:30 UTC
        assert body["vars"]["T"]["t"][0] == ((31 + 28) * 24 * 60) + 13 * 60 + 30


def test_vertical_units_and_sign():
    with Tmp() as T:
        rows = ["station,time,lat,lon,bemonsteringshoogte,temp"]
        rows += [f"S,2015-0{m}-01T10:00:00Z,53,5,-100,{m}" for m in range(1, 9)]
        csvp = T.write("h.csv", "\n".join(rows))
        side = T.side("h.json", {"format": "dtv-observations/1",
                                 "columns": {"bemonsteringshoogte": "depth"},
                                 "vertical_units": "cm", "vertical_positive": "up"})
        doc, _ = oi.ingest(csvp, side, out_root=T.store)
        assert doc["stations"][0]["depths"] == [1.0], doc["stations"][0]["depths"]


def test_flags_without_convention_are_reported_not_applied():
    with Tmp() as T:
        rows = ["time,lat,lon,temp,temp_qc"] + [f"2015-01-0{d}T00:00:00Z,53,5,{d},{d % 3}" for d in range(1, 9)]
        csvp = T.write("f.csv", "\n".join(rows))
        doc, _ = oi.ingest(csvp, None, out_root=T.store)
        assert doc["variables"]["temp"]["n"] == 8
        assert any("flags were NOT applied" in w for w in doc["warnings"])


def test_cf_netcdf_timeseries_with_valid_mask():
    try:
        import netCDF4
    except ImportError:
        print("  (netCDF4 not installed — skipped)")
        return
    with Tmp() as T:
        p = os.path.join(T.dir, "waves.nc")
        ds = netCDF4.Dataset(p, "w")
        ds.featureType = "timeSeries"
        ds.Conventions = "CF-1.8"
        ds.title = "Synthetic waves"
        ds.createDimension("station", 3)
        ds.createDimension("time", 144)
        ds.createDimension("name_strlen", 8)
        t = ds.createVariable("time", "f8", ("time",))
        t.units = "seconds since 1970-01-01 00:00:00"
        t.standard_name = "time"
        t0 = dt.datetime(2015, 1, 1, tzinfo=dt.timezone.utc).timestamp()
        t[:] = t0 + np.arange(144) * 600
        sc = ds.createVariable("station_code", "S1", ("station", "name_strlen"))
        sc.cf_role = "timeseries_id"
        chars = np.full((3, 8), b"", dtype="S1")
        chars[:, 0] = [b"A", b"B", b"C"]
        sc[:] = chars
        la = ds.createVariable("lat", "f8", ("station",)); la.standard_name = "latitude"
        lo = ds.createVariable("lon", "f8", ("station",)); lo.standard_name = "longitude"
        la[:] = [53.2, 53.4, 53.5]; lo[:] = [4.9, 5.3, 6.0]
        h = ds.createVariable("hm0", "f4", ("station", "time"), fill_value=np.nan)
        h.units = "m"
        vals = 1 + 0.2 * np.sin(np.arange(144) / 10)[None, :] * np.ones((3, 1))
        vals[2, :50] = np.nan
        h[:] = vals
        v = ds.createVariable("valid_hm0", "i1", ("station", "time"), fill_value=-1)
        mask = np.ones((3, 144), "i1"); mask[0, :10] = 0
        v[:] = mask
        q = ds.createVariable("qc_frozen", "i1", ("station", "time"))
        q[:] = 0
        ds.close()
        doc, _ = oi.ingest(p, None, out_root=T.store)
        assert doc["kind"] == "timeseries", doc["kind"]
        assert set(doc["variables"]) == {"hm0"}                   # qc_/valid_ are not measurements
        assert doc["variables"]["hm0"]["n"] == 144 * 3 - 10 - 50
        assert doc["variables"]["hm0"]["quantity"] == "significant_wave_height"
        assert doc["stations"][0]["cadence"] == "continuous"


def test_dry_run_writes_nothing():
    with Tmp() as T:
        csvp = T.write("d.csv", "time,lat,lon,temp\n2015-01-01T00:00:00Z,53,5,4\n2015-01-02T00:00:00Z,53,5,5\n")
        doc, files = oi.ingest(csvp, None, out_root=T.store, dry_run=True)
        assert not os.path.exists(T.store) and files



def test_benthos_groups_and_pre_1970_station_series():
    # Balgzand-like: two stations, carbon per feeding group in g C/m2, from 1967
    with Tmp() as T:
        rows = ["station,time,lat,lon,epibenthos,deposit_feeders,suspension_feeders,endobenthos"]
        for st, (la, lo) in {"BALG-B": (52.936, 4.821), "BALG-Sl": (52.922, 4.814)}.items():
            for y in range(1967, 1972):
                for m in (3, 8):
                    rows.append(f"{st},{y}-{m:02d}-15,{la},{lo},0.2,5.1,12.3,1.4")
        side = T.side("b.json", {"format": oi.FORMAT, "variables": {
            k: {"units": "g C/m2", "level": "bed"}
            for k in ("epibenthos", "deposit_feeders", "suspension_feeders", "endobenthos")}})
        doc, _ = oi.ingest(T.write("b.csv", "\n".join(rows)), side, cid="b", out_root=T.store)
        assert doc["kind"] == "timeseries" and doc["nStations"] == 2
        assert doc["time"][0].startswith("1967-03-15")             # before the epoch, on Windows too
        q = {k: v["quantity"] for k, v in doc["variables"].items()}
        assert q == {"epibenthos": "epibenthos_carbon", "deposit_feeders": "deposit_feeders_carbon",
                     "suspension_feeders": "suspension_feeders_carbon", "endobenthos": "endobenthos_carbon"}, q
        assert VOCAB.quantity("y1c") == "epibenthos_carbon" and VOCAB.quantity("Y5c") == "endobenthos_carbon"
        st = doc["stations"][0]
        body = T.load("b", f"{st['file']}/1967.json")
        assert len(body["vars"]["epibenthos"]["t"]) == 2


def test_relocated_station_is_split_not_a_trajectory():
    # one MWTL station moved ~2.8 km after ten years: two fixed stations, not a ship
    with Tmp() as T:
        rows = ["station,time,lat,lon,spm [mg/l]"]
        for y in range(2000, 2012):
            for m in range(1, 13):
                la, lo = (53.3506, 6.9100) if y < 2010 else (53.3349, 6.9439)
                rows.append(f"BOCHTVWTM,{y}-{m:02d}-10T10:00:00Z,{la},{lo},{20 + m}")
        doc, _ = oi.ingest(T.write("w.csv", "\n".join(rows)), None, cid="w", out_root=T.store)
        assert doc["kind"] == "timeseries", doc["kind"]
        ids = sorted(s["id"] for s in doc["stations"])
        assert ids == ["BOCHTVWTM", "BOCHTVWTM@2010-2011"], ids
        assert all(s["kind"] == "timeseries" for s in doc["stations"])
        assert any("relocated" in i for i in doc["info"])
    # a platform that really moves stays a trajectory
    with Tmp() as T:
        rows = ["station,time,lat,lon,temp"]
        for k in range(40):
            rows.append(f"FERRY,2015-06-01T{k // 4:02d}:{(k % 4) * 15:02d}:00Z,{53 + k * 0.01},{4.8 + k * 0.01},{15 + k * 0.01}")
        doc, _ = oi.ingest(T.write("f.csv", "\n".join(rows)), None, cid="f", out_root=T.store)
        assert doc["kind"] == "trajectory", doc["kind"]

if __name__ == "__main__":
    failed = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"ok    {name}")
            except Exception as e:                                 # noqa: BLE001
                failed += 1
                import traceback
                print(f"FAIL  {name}: {e!r}")
                traceback.print_exc()
    print(f"{'all passed' if not failed else f'{failed} failed'}")
    sys.exit(1 if failed else 0)
