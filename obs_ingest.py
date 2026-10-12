# -*- coding: utf-8 -*-
"""Ingest field observations into the Digital Twin Viewer.

    python obs_ingest.py add jetty.csv --meta jetty.json
    python obs_ingest.py add rws_waves.nc --vars hm0,tm02,wl --from 2015-01-01 --to 2015-12-31
    python obs_ingest.py check sibes.csv --meta sibes.json      # dry run, report only
    python obs_ingest.py list
    python obs_ingest.py remove nioz-jetty

Two inputs are accepted, both described in OBSERVATIONS.md:

  * the DTV observation package: a CSV (wide or long) plus an optional JSON
    sidecar naming units, stations, time zone and the like;
  * a CF-1.8 discrete-sampling-geometry NetCDF (featureType timeSeries, point,
    profile, trajectory), which already says most of that itself.

Either way the data are reduced to one long table -- station, time, position,
vertical coordinate, variable, value, flag -- and then CLASSIFIED from what the
data actually do, not from what a file claims: how many stations, how often
each was visited, whether a visit samples several depths, whether the platform
moved. The result decides how the viewer shows it:

    timeseries          fixed station, repeated in time      -> chart overlay + skill
    timeseries_profile  fixed station, depth-resolved visits -> chart + vertical panel
    profiles            one-off depth-resolved casts         -> vertical panel
    survey              many stations, each rarely visited   -> map points coloured by value
    trajectory          moving platform                      -> map points

The compiled collection is written to data/observations/<id>/ and listed in
data/observations/index.json. Observations belong to no single model run: the
viewer picks up every collection that overlaps the open dataset in space and
time, and matches variables through obs_vocab.json at view time.

Only numpy (and netCDF4 for .nc input) are needed -- the same packages the .nc
pipeline already uses -- so this runs inside the container and behind the
upload button as well as from a shell.
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import gzip
import hashlib
import io
import json
import math
import os
import re
import shutil
import sys
import unicodedata

import numpy as np

APP_DIR = os.path.dirname(os.path.abspath(__file__))
STORE = os.path.join(APP_DIR, "data", "observations")
VOCAB_PATH = os.path.join(APP_DIR, "obs_vocab.json")
FORMAT = "dtv-observations/1"

# ---------------------------------------------------------------- thresholds
# Visits: records of one station closer together than this belong to the same
# visit (a CTD cast takes minutes; consecutive bottle samples a few more).
VISIT_GAP_S = 30 * 60
# A visit that samples at least this many distinct depths is a profile.
PROFILE_LEVELS = 3
# Positions of one station spread over more than this (degrees, ~500 m) mean a
# moving platform rather than a fixed station.
MOVING_DEG = 0.005
# ... unless they fall on at most this many distinct places, each visited at
# least twice: that is a station that was RELOCATED (RWS moved several MWTL
# stations by kilometres over the decades), and each position becomes a fixed
# station of its own.
RELOCATED_MAX_POSITIONS = 3
# Cadence of a station's visits (median spacing).
CONTINUOUS_S = 3 * 3600          # <= 3 h: a continuous record
DISCRETE_S = 45 * 86400          # <= 45 d: repeated sampling; beyond: sparse
# A collection with at least this many stations, each visited at most this
# often per year, is a spatial survey (SIBES, MWTL benthos) -- the information
# is in the map, not in any one station's time series.
SURVEY_MIN_STATIONS = 20
SURVEY_MAX_VISITS_PER_YEAR = 4
# Depth-resolved stations visited less often than this are a set of one-off
# casts, not a moored profiler.
PROFILE_SERIES_MAX_S = 7 * 86400

FLAG_GOOD, FLAG_SUSPECT, FLAG_BELOW_DL, FLAG_ABOVE = 0, 1, 2, 3

VERTICAL_KINDS = {
    # canonical name: meaning (see OBSERVATIONS.md)
    "depth": "metres below the water surface, positive down",
    "height_above_bed": "metres above the sea bed, positive up",
    "elevation": "metres relative to the stated vertical datum, positive up",
    "sediment_depth": "metres below the sediment surface, positive down",
}

# Column-name aliases for the reserved CSV columns, compared after norm().
RESERVED = {
    "time": ["time", "datetime", "datetimeutc", "timestamp", "isotime", "tijdstip", "dateandtime", "timeutc"],
    "date": ["date", "datum", "day", "samplingdate", "sampledate"],
    "clock": ["clocktime", "hourminute", "hhmm", "tijd"],
    "lat": ["lat", "latitude", "ywgs84", "breedtegraad", "decimallatitude"],
    "lon": ["lon", "long", "longitude", "lng", "xwgs84", "lengtegraad", "decimallongitude"],
    "x": ["x", "easting", "xcoord", "xrd", "xutm"],
    "y": ["y", "northing", "ycoord", "yrd", "yutm"],
    "wkt": ["wkt", "geom", "geometry", "the_geom"],
    "station": ["station", "stationid", "stationcode", "site", "siteid", "location", "locationcode",
                "locatie", "locatiecode", "code", "samplingstationid", "stationnumber", "cast", "castid"],
    "station_name": ["stationname", "name", "naam", "sitename", "locationname", "locatienaam"],
    "depth": ["depth", "depthm", "sampledepth", "sampledepthm", "pressuredepth", "diepte"],
    "height_above_bed": ["heightabovebed", "hab", "habm", "heightabovebottom"],
    "elevation": ["elevation", "z", "zm", "height", "hoogte"],
    "sediment_depth": ["sedimentdepth", "coredepth", "depthinsediment"],
    "variable": ["variable", "parameter", "param", "quantity", "grootheid", "parametercode"],
    "value": ["value", "val", "meetwaarde", "result", "measurement"],
    "units": ["units", "unit", "eenheid", "eenheidcode"],
    "flag": ["flag", "qc", "quality", "qualityflag", "kwaliteitswaardecode", "qualitycode"],
    "qualifier": ["qualifier", "limietsymbool", "limit", "censor", "detectionlimitflag", "lessthan"],
}
# Suffixes of auxiliary columns in a wide table: flags attach to their variable,
# the rest are ignored unless the sidecar names them as variables.
FLAG_SUFFIXES = ("_qc", "_flag", "_quality", "_q")
AUX_SUFFIXES = ("_std", "_sd", "_n", "_count", "_src", "_source", "_interval", "_interval_min",
                "_provider_flag", "_min", "_max", "_unit", "_units", "_method")
MISSING = {"", "na", "n/a", "nan", "null", "none", "-", "--", "missing", "-999", "-999.0",
           "-9999", "-9999.0", "-99", "999999", "1e+35", "9.96921e+36", "9.9692099683868690e+36"}


def log(msg):
    print(f"[obs] {msg}", flush=True)


def norm(s):
    """Compare names loosely: lower case, accents stripped, only [a-z0-9]."""
    s = unicodedata.normalize("NFKD", str(s)).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]", "", s.lower())


def slugify(s, fallback="obs"):
    s = unicodedata.normalize("NFKD", str(s)).encode("ascii", "ignore").decode().lower()
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s[:60] or fallback


# ================================================================ vocabulary
class Vocab:
    """Quantity names and unit conversions, shared with the browser."""

    def __init__(self, path=VOCAB_PATH):
        with open(path, encoding="utf-8") as f:
            self.doc = json.load(f)
        self.quantities = self.doc["quantities"]
        self.units = self.doc["units"]
        self.elements = [norm(e) for e in self.doc.get("elements", [])]
        self._alias = {}
        self._std = {}
        for qid, q in self.quantities.items():
            for a in q.get("aliases", []):
                self._alias.setdefault(norm(a), qid)
            self._alias.setdefault(norm(qid), qid)
            for s in q.get("standard_names", []):
                self._std.setdefault(s.lower(), qid)

    def quantity(self, name, standard_name=None, explicit=None):
        if explicit:
            if explicit in self.quantities:
                return explicit
            return self._alias.get(norm(explicit))
        if standard_name and standard_name.lower() in self._std:
            return self._std[standard_name.lower()]
        n = norm(name)
        if n in self._alias:
            return self._alias[n]
        # "temp_1m", "chla_surface": a known name followed by a qualifier
        m = re.match(r"^([a-z]+?)(\d+m|surface|bottom|avg|mean)$", n)
        if m and m.group(1) in self._alias:
            return self._alias[m.group(1)]
        return None

    @staticmethod
    def _clean_units(u):
        s = str(u or "").strip().lower()
        s = s.replace("µ", "u").replace("μ", "u").replace("^", "").replace("**", "")
        s = s.replace("·", " ").replace("⁻¹", "-1").replace("⁻²", "-2").replace("⁻³", "-3")
        s = s.replace("²", "2").replace("³", "3").replace(" per ", "/")
        return re.sub(r"\s+", " ", s)

    def parse_units(self, u, group=None):
        """-> dict(group, factor, offset, element, approx) or None.

        `group` is the quantity's unit group when known; ambiguous spellings
        ('um' is a micrometre and a micromole per litre) are resolved inside it.
        """
        s = self._clean_units(u)
        groups = [group] if group in self.units else []
        groups += [g for g in self.units if g not in groups]

        def lookup(key, element):
            for g in groups:
                spec = self.units[g]
                if key in spec.get("factors", {}):
                    return dict(group=g, factor=spec["factors"][key], offset=0.0,
                                element=element, approx=False)
                if key in spec.get("offsets", {}):
                    return dict(group=g, factor=1.0, offset=spec["offsets"][key],
                                element=element, approx=False)
                if key in spec.get("approx", {}):
                    return dict(group=g, factor=spec["approx"][key], offset=0.0,
                                element=element, approx=True)
            return None

        # the whole spelling first: 'deg c' is Celsius, not degrees of carbon
        hit = lookup(s.replace(" ", ""), None)
        if hit:
            return hit
        # then an element tag after the numerator: 'mg c/m2', 'ug chl-a/l', 'mmol n m-3'
        toks = s.split(" ")
        if len(toks) >= 2:
            head, rest = toks[0], " ".join(toks[1:])
            m = re.match(r"^([a-z0-9\-]+)(.*)$", rest)
            if m:
                el = norm(m.group(1))
                if el in self.elements:
                    canon = "chl" if el.startswith("chl") else el
                    tail = m.group(2).strip()
                    return lookup((head + tail).replace(" ", ""), canon)
        return None

    def conversion(self, from_u, to_u, group=None):
        """Factor/offset taking values in `from_u` to `to_u`, or None.

        Returns (factor, offset, approx, note). value_to = value_from*factor + offset.
        """
        a = self.parse_units(from_u, group)
        b = self.parse_units(to_u, group)
        if not a or not b or a["group"] != b["group"]:
            return None
        if a["element"] and b["element"] and a["element"] != b["element"]:
            return None
        # to base: v*fa + oa ; from base: (x - ob)/fb
        factor = a["factor"] / b["factor"]
        offset = (a["offset"] - b["offset"]) / b["factor"]
        note = None
        if bool(a["element"]) != bool(b["element"]):
            note = "element not stated on one side"
        return factor, offset, a["approx"] or b["approx"], note


# ================================================================ coordinates
def utm_to_latlon(e, n, zone, south=False):
    """Inverse transverse Mercator on WGS84/GRS80 (Snyder 1987, eq. 8-12..8-18).
    Accurate to a few cm inside the zone -- far below a model cell."""
    a, f, k0 = 6378137.0, 1 / 298.257223563, 0.9996
    e2 = f * (2 - f)
    ep2 = e2 / (1 - e2)
    x = np.asarray(e, float) - 500000.0
    y = np.asarray(n, float) - (10000000.0 if south else 0.0)
    m = y / k0
    mu = m / (a * (1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256))
    e1 = (1 - math.sqrt(1 - e2)) / (1 + math.sqrt(1 - e2))
    p1 = (mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * np.sin(2 * mu)
          + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * np.sin(4 * mu)
          + (151 * e1 ** 3 / 96) * np.sin(6 * mu) + (1097 * e1 ** 4 / 512) * np.sin(8 * mu))
    c1 = ep2 * np.cos(p1) ** 2
    t1 = np.tan(p1) ** 2
    n1 = a / np.sqrt(1 - e2 * np.sin(p1) ** 2)
    r1 = a * (1 - e2) / (1 - e2 * np.sin(p1) ** 2) ** 1.5
    d = x / (n1 * k0)
    lat = p1 - (n1 * np.tan(p1) / r1) * (
        d ** 2 / 2 - (5 + 3 * t1 + 10 * c1 - 4 * c1 ** 2 - 9 * ep2) * d ** 4 / 24
        + (61 + 90 * t1 + 298 * c1 + 45 * t1 ** 2 - 252 * ep2 - 3 * c1 ** 2) * d ** 6 / 720)
    lon0 = math.radians(zone * 6 - 183)
    lon = lon0 + (d - (1 + 2 * t1 + c1) * d ** 3 / 6
                  + (5 - 2 * c1 + 28 * t1 - 3 * c1 ** 2 + 8 * ep2 + 24 * t1 ** 2) * d ** 5 / 120) / np.cos(p1)
    return np.degrees(lat), np.degrees(lon)


def rd_to_latlon(x, y):
    """Dutch RD New (EPSG:28992) to WGS84, Schreutelkamp & Strang van Hees
    approximation; ~1 m, which is what RD-referenced field data are good for."""
    dx = (np.asarray(x, float) - 155000.0) * 1e-5
    dy = (np.asarray(y, float) - 463000.0) * 1e-5
    K = [(0, 1, 3235.65389), (2, 0, -32.58297), (0, 2, -0.24750), (2, 1, -0.84978),
         (0, 3, -0.06550), (2, 2, -0.01709), (1, 0, -0.00738), (4, 0, 0.00530),
         (2, 3, -0.00039), (4, 1, 0.00033), (1, 1, -0.00012)]
    L = [(1, 0, 5260.52916), (1, 1, 105.94684), (1, 2, 2.45656), (3, 0, -0.81885),
         (1, 3, 0.05594), (3, 1, -0.05607), (0, 1, 0.01199), (3, 2, -0.00256),
         (1, 4, 0.00128), (0, 2, 0.00022), (2, 0, -0.00022), (5, 0, 0.00026)]
    lat = 52.15517440 + sum(c * dx ** p * dy ** q for p, q, c in K) / 3600.0
    lon = 5.38720621 + sum(c * dx ** p * dy ** q for p, q, c in L) / 3600.0
    return lat, lon


def project_to_latlon(x, y, crs):
    """x/y in a projected CRS -> lat/lon. pyproj when it is installed; otherwise
    the two systems Dutch coastal data actually arrive in."""
    code = str(crs or "").upper().replace("EPSG:", "").strip()
    try:
        from pyproj import Transformer
        tr = Transformer.from_crs(f"EPSG:{code}", "EPSG:4326", always_xy=True)
        lon, lat = tr.transform(np.asarray(x, float), np.asarray(y, float))
        return np.asarray(lat), np.asarray(lon)
    except ImportError:
        pass
    if code == "28992":
        return rd_to_latlon(x, y)
    m = re.fullmatch(r"(258|326|327)(\d\d)", code)
    if m:
        return utm_to_latlon(x, y, int(m.group(2)), south=m.group(1) == "327")
    if code in ("4326", "4258", "CRS84"):
        return np.asarray(y, float), np.asarray(x, float)
    raise ValueError(f"cannot convert coordinates from EPSG:{code} without pyproj "
                     f"(pip install pyproj); RD New (28992) and UTM (258xx/326xx) work without it")


_WKT = re.compile(r"POINT\s*Z?\s*\(\s*([-+0-9.eE]+)\s+([-+0-9.eE]+)", re.I)


# ================================================================ time
def tzinfo_of(spec):
    """'UTC', '+01:00', 'UTC+1', 'Europe/Amsterdam' -> tzinfo."""
    if spec in (None, "", "UTC", "utc", "Z", "GMT"):
        return dt.timezone.utc
    m = re.fullmatch(r"(?:UTC|GMT)?\s*([+-])(\d{1,2})(?::?(\d\d))?", str(spec).strip())
    if m:
        off = dt.timedelta(hours=int(m.group(2)), minutes=int(m.group(3) or 0))
        return dt.timezone(off if m.group(1) == "+" else -off)
    try:
        from zoneinfo import ZoneInfo
        return ZoneInfo(str(spec))
    except Exception as e:
        raise ValueError(f"unknown time zone {spec!r} -- use 'UTC', an offset like "
                         f"'+01:00', or an IANA name (needs the tzdata package): {e}")


class TimeParser:
    """String -> epoch seconds (UTC). Remembers whether any value carried only a
    date, because a sample 'on 14 July' is not a sample at midnight."""

    def __init__(self, fmt=None, tz=None):
        self.fmt = fmt
        self.tz = tzinfo_of(tz)
        self.tz_stated = tz not in (None, "")
        self.date_only = 0
        self.naive = 0
        self.cache = {}

    def __call__(self, s, clock=None):
        s = str(s).strip()
        if clock:
            s = f"{s} {str(clock).strip()}"
        if s in self.cache:
            return self.cache[s]
        if self.fmt:
            d = dt.datetime.strptime(s, self.fmt)
            if not re.search(r"%[HIMSXcTRp]", self.fmt):
                d = d.replace(hour=12)
                self.date_only += 1
        else:
            iso = s.replace(" ", "T", 1) if re.match(r"^\d{4}-\d\d-\d\d \d", s) else s
            iso = re.sub(r"(\.\d{6})\d+", r"\1", iso)            # >6 fractional digits
            try:
                d = dt.datetime.fromisoformat(iso.replace("Z", "+00:00"))
            except ValueError:
                raise ValueError(f"time {s!r} is not ISO 8601; give 'time_format' "
                                 f"(a strptime pattern such as '%m/%d/%Y %H:%M') in the sidecar")
            if re.fullmatch(r"\d{4}-\d\d-\d\d", s):
                # a date with no time: the middle of that day, and say so
                d = d.replace(hour=12)
                self.date_only += 1
        if d.tzinfo is None:
            self.naive += 1
            d = d.replace(tzinfo=self.tz)
        v = int(round(d.timestamp()))
        self.cache[s] = v
        return v


_EPOCH = dt.datetime(1970, 1, 1, tzinfo=dt.timezone.utc)


def utc_of(ts):
    """Epoch seconds -> aware UTC datetime, by addition: the library's own
    conversion fails on Windows before 1970, and Balgzand starts in 1967."""
    return _EPOCH + dt.timedelta(seconds=int(ts))


def iso(ts):
    return utc_of(ts).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_bound(s):
    if not s:
        return None
    d = dt.datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    if d.tzinfo is None:
        d = d.replace(tzinfo=dt.timezone.utc)
    return int(d.timestamp())


# ================================================================ the long table
class Table:
    """All observations of one input, one row per value."""

    def __init__(self):
        self.st_ids, self.st_names, self.st_pos = [], [], []   # station table
        self._st = {}
        self.vars = []                                          # dicts
        self._var = {}
        self.cols = {k: [] for k in ("s", "t", "lat", "lon", "z", "v", "x", "f")}
        self.zkind = None
        self.warnings = []
        self.info = []

    def station(self, sid, name=None, lat=None, lon=None):
        key = str(sid)
        i = self._st.get(key)
        if i is None:
            i = self._st[key] = len(self.st_ids)
            self.st_ids.append(key)
            self.st_names.append(name or key)
            self.st_pos.append((lat, lon))
        elif name and self.st_names[i] == key:
            self.st_names[i] = name
        return i

    def variable(self, key, **kw):
        i = self._var.get(key)
        if i is None:
            i = self._var[key] = len(self.vars)
            self.vars.append(dict(key=key, **kw))
        return i

    def add(self, s, t, lat, lon, z, x, v, f=FLAG_GOOD):
        c = self.cols
        c["s"].append(s); c["t"].append(t); c["lat"].append(lat); c["lon"].append(lon)
        c["z"].append(z); c["x"].append(x); c["v"].append(v); c["f"].append(f)

    def add_block(self, s, t, lat, lon, z, x, v, f):
        """Bulk append of equal-length numpy arrays (NetCDF path)."""
        c = self.cols
        for k, a in (("s", s), ("t", t), ("lat", lat), ("lon", lon), ("z", z),
                     ("x", x), ("v", v), ("f", f)):
            c[k].append(np.asarray(a))

    def freeze(self):
        """Lists (or lists of arrays) -> numpy arrays."""
        out = {}
        dtypes = dict(s=np.int32, t=np.int64, lat=np.float64, lon=np.float64,
                      z=np.float64, x=np.int16, v=np.float64, f=np.int8)
        for k, a in self.cols.items():
            if a and isinstance(a[0], np.ndarray):
                out[k] = np.concatenate(a).astype(dtypes[k]) if a else np.zeros(0, dtypes[k])
            else:
                out[k] = np.array(a, dtype=dtypes[k]) if a else np.zeros(0, dtypes[k])
        self.a = out
        return out


# ================================================================ CSV package
def _num(s, decimal_comma=False):
    """'12.5' -> (12.5, flag); '<0.05' -> (0.05, BELOW_DL); missing -> (None, _)."""
    s = str(s).strip()
    if s.lower() in MISSING:
        return None, FLAG_GOOD
    flag = FLAG_GOOD
    if s[:1] in "<>":
        flag = FLAG_BELOW_DL if s[0] == "<" else FLAG_ABOVE
        s = s[1:].strip()
    if decimal_comma:
        s = s.replace(".", "").replace(",", ".") if re.fullmatch(r"-?[\d.]+,\d+", s) else s.replace(",", ".")
    try:
        v = float(s)
    except ValueError:
        return None, FLAG_GOOD
    if not math.isfinite(v):
        return None, FLAG_GOOD
    return v, flag


_UNIT_IN_HEADER = re.compile(r"^(.*?)\s*[\[(]([^\])]*)[\])]\s*$")


def read_sidecar(path):
    if not path:
        return {}
    with open(path, encoding="utf-8-sig") as f:
        doc = json.load(f)
    fmt = doc.get("format")
    if fmt and not str(fmt).startswith("dtv-observations/"):
        raise ValueError(f"{path}: format {fmt!r} is not a DTV observation sidecar")
    return doc


def _reserved_role(name):
    n = norm(name)
    for role, names in RESERVED.items():
        if n in names:
            return role
    return None


def read_csv_package(path, meta, t_lo=None, t_hi=None):
    """CSV (wide or long) + sidecar -> Table."""
    tab = Table()
    opener = gzip.open if path.lower().endswith(".gz") else open
    with opener(path, "rt", encoding="utf-8-sig", errors="replace") as f:
        raw = f.read()
    lines = raw.splitlines()

    # leading '# key: value' comments are metadata; any other '#' line is ignored
    head_meta, body = {}, []
    for ln in lines:
        if ln.startswith("#") and not body:
            m = re.match(r"#\s*([A-Za-z_][\w ]*?)\s*:\s*(.*)$", ln)
            if m:
                head_meta[m.group(1).strip().lower().replace(" ", "_")] = m.group(2).strip()
            continue
        if ln.strip():
            body.append(ln)
    for k, v in head_meta.items():
        meta.setdefault(k, v)
    if not body:
        raise ValueError(f"{path}: no data rows")

    sample = "\n".join(body[:50])
    delim = meta.get("delimiter")
    if not delim:
        try:
            delim = csv.Sniffer().sniff(sample, delimiters=",;\t|").delimiter
        except csv.Error:
            delim = ","
    decimal_comma = meta.get("decimal") == "," or (
        delim == ";" and meta.get("decimal") is None
        and re.search(r"(^|;)-?\d+,\d+(;|$)", sample, re.M) is not None)
    rows = csv.reader(io.StringIO("\n".join(body)), delimiter=delim)
    header = next(rows)

    rename = {norm(k): v for k, v in (meta.get("columns") or {}).items()}
    ignore = {norm(c) for c in meta.get("ignore", [])}
    declared = meta.get("variables") or {}
    declared_n = {norm(k): k for k in declared}

    cols = []                 # (index, base name, units from header)
    for i, h in enumerate(header):
        h = h.strip()
        h = rename.get(norm(h), h)
        m = _UNIT_IN_HEADER.match(h)
        name, unit = (m.group(1).strip(), m.group(2).strip()) if m else (h, None)
        cols.append((i, name, unit))

    role = {}
    # Two passes: a column renamed (or named) exactly as a role -- 'time',
    # 'variable', 'depth' -- is that role; only then do the looser aliases fill
    # the roles still empty. Otherwise an export with both 'grootheid' and a
    # 'parameter_code' renamed to 'variable' would take whichever came first.
    for exact in (True, False):
        for i, name, unit in cols:
            if norm(name) in ignore or i in role.values():
                continue
            r = name.strip().lower() if exact else _reserved_role(name)
            if exact and r not in RESERVED:
                continue
            # a declared variable wins over a reserved name ('depth' as a
            # measured water depth, say), but only when the sidecar says so
            if r and norm(name) not in declared_n and r not in role:
                role[r] = i
    long_form = "value" in role and "variable" in role

    # vertical coordinate: at most one
    vkinds = [k for k in VERTICAL_KINDS if k in role]
    if len(vkinds) > 1:
        raise ValueError(f"{path}: more than one vertical column ({', '.join(vkinds)}); keep one")
    tab.zkind = vkinds[0] if vkinds else meta.get("vertical")
    zcol = role.get(vkinds[0]) if vkinds else None
    # sampling heights are often given in cm, or as a negative height below the
    # surface (RWS 'bemonsteringshoogte' -100 = 1 m deep): say so once, here
    zscale = {"m": 1.0, "cm": 0.01, "mm": 0.001, "dm": 0.1}.get(
        str(meta.get("vertical_units", "m")).lower())
    if zscale is None:
        raise ValueError(f"vertical_units must be m, dm, cm or mm, not {meta.get('vertical_units')!r}")
    natural = {"depth": "down", "sediment_depth": "down", "height_above_bed": "up", "elevation": "up"}
    if meta.get("vertical_positive") and tab.zkind in natural \
            and meta["vertical_positive"] != natural[tab.zkind]:
        zscale = -zscale

    # variables
    var_cols = []             # (index, key, units, flag column index)
    if not long_form:
        by_norm = {norm(n): (i, n, u) for i, n, u in cols}
        used = set(role.values())
        flag_of = {}
        for i, name, unit in cols:
            nn = name.lower()
            for suf in FLAG_SUFFIXES:
                if nn.endswith(suf) and norm(name[: -len(suf)]) in by_norm:
                    flag_of[norm(name[: -len(suf)])] = i
                    used.add(i)
        for i, name, unit in cols:
            if i in used or norm(name) in ignore:
                continue
            if declared and norm(name) not in declared_n:
                tab.info.append(f"column '{name}' not listed under 'variables' — skipped")
                continue
            if not declared and name.lower().endswith(AUX_SUFFIXES):
                tab.info.append(f"column '{name}' looks auxiliary — skipped (list it under 'variables' to keep it)")
                continue
            key = declared_n.get(norm(name), name)
            var_cols.append((i, key, unit, flag_of.get(norm(name))))

    # stations from the sidecar; one may also fix the sensor's vertical
    # position ("elevation": -1.5 for a jetty sensor at -1.5 m NAP) when the
    # rows themselves carry none
    st_table = meta.get("stations") or {}
    st_z = {}
    for sid, s in st_table.items():
        si = tab.station(sid, s.get("name"), s.get("lat"), s.get("lon"))
        for k in VERTICAL_KINDS:
            if s.get(k) is not None:
                if zcol is not None:
                    raise ValueError(f"station {sid!r} fixes '{k}' but the file also has a vertical column")
                if tab.zkind and tab.zkind != k:
                    raise ValueError(f"stations mix vertical kinds ({tab.zkind}, {k}); use one")
                tab.zkind = k
                st_z[si] = float(s[k])
    default_station = meta.get("default_station")
    if default_station is None and len(st_table) == 1:
        default_station = next(iter(st_table))

    tp = TimeParser(meta.get("time_format"), meta.get("time_zone"))
    crs = meta.get("crs")
    good_flags = meta.get("flags", {}).get("good")
    bad_flags = meta.get("flags", {}).get("bad")
    good_flags = None if good_flags is None else {str(g).strip() for g in good_flags}
    bad_flags = None if bad_flags is None else {str(g).strip() for g in bad_flags}
    flag_note = [0, 0]   # values dropped by flag, flags seen but undeclared

    def flag_ok(raw_flag):
        if raw_flag is None or str(raw_flag).strip() == "":
            return True
        fl = str(raw_flag).strip()
        fl2 = fl[:-2] if fl.endswith(".0") else fl
        if good_flags is not None:
            return fl in good_flags or fl2 in good_flags
        if bad_flags is not None:
            return not (fl in bad_flags or fl2 in bad_flags)
        flag_note[1] += 1
        return True

    if "time" not in role and "date" not in role:
        raise ValueError(f"{path}: no time column (expected 'time', or 'date' [+ 'clock'])")
    tcol = role.get("time", role.get("date"))
    ccol = role.get("clock") if "time" not in role else None

    pos_cache = {}
    n_rows = n_bad_time = 0
    xy_rows = []              # rows with projected coordinates, converted in bulk
    for r in rows:
        if not r or all(not c.strip() for c in r):
            continue
        n_rows += 1
        get = lambda c: r[c] if c is not None and c < len(r) else ""   # noqa: E731
        try:
            t = tp(get(tcol), get(ccol) if ccol is not None else None)
        except ValueError as e:
            n_bad_time += 1
            if n_bad_time == 1:
                tab.warnings.append(str(e))
            continue
        if (t_lo is not None and t < t_lo) or (t_hi is not None and t > t_hi):
            continue

        # position
        lat = lon = None
        if "lat" in role and "lon" in role:
            lat, _ = _num(get(role["lat"]), decimal_comma)
            lon, _ = _num(get(role["lon"]), decimal_comma)
        elif "wkt" in role:
            m = _WKT.search(get(role["wkt"]))
            if m:
                lon, lat = float(m.group(1)), float(m.group(2))
        elif "x" in role and "y" in role:
            x, _ = _num(get(role["x"]), decimal_comma)
            y, _ = _num(get(role["y"]), decimal_comma)
            if x is not None and y is not None:
                lat, lon = ("xy", (x, y))

        sid = get(role["station"]).strip() if "station" in role else ""
        sname = get(role["station_name"]).strip() if "station_name" in role else ""
        if not sid:
            if sname:
                sid = sname
            elif lat == "xy":
                sid = pos_cache.setdefault(("xy", round(lon[0], 1), round(lon[1], 1)),
                                           f"x{lon[0]:.0f} y{lon[1]:.0f}")
            elif lat is not None:
                sid = pos_cache.setdefault((round(lat, 5), round(lon, 5)),
                                           f"{lat:.5f}N {lon:.5f}E")
            elif default_station:
                sid = default_station
            else:
                raise ValueError(f"{path}: row {n_rows} has no station and no position; give "
                                 f"'station', 'lat'/'lon', or a 'stations' table in the sidecar")
        si = tab.station(sid, sname or None)
        if lat is None and si < len(tab.st_pos) and tab.st_pos[si][0] is not None:
            lat, lon = tab.st_pos[si]
        if lat is None:
            continue

        z = st_z.get(si)
        if zcol is not None:
            z, _ = _num(get(zcol), decimal_comma)
            if z is not None:
                z = z * zscale

        def put(xi, v, fl):
            if lat == "xy":
                xy_rows.append(len(tab.cols["t"]))
                tab.add(si, t, lon[0], lon[1], z, xi, v, fl)
            else:
                tab.add(si, t, lat, lon, z, xi, v, fl)

        if long_form:
            vname = get(role["variable"]).strip()
            if not vname or norm(vname) in ignore:
                continue
            if declared and norm(vname) not in declared_n:
                continue
            unit = get(role["units"]).strip() if "units" in role else None
            v, fl = _num(get(role["value"]), decimal_comma)
            if v is None:
                continue
            q = get(role["qualifier"]).strip() if "qualifier" in role else ""
            if q.startswith("<"):
                fl = FLAG_BELOW_DL
            elif q.startswith(">"):
                fl = FLAG_ABOVE
            if "flag" in role and not flag_ok(get(role["flag"])):
                flag_note[0] += 1
                continue
            key = declared_n.get(norm(vname), vname)
            xi = tab.variable(key, units_in=unit)
            if unit and not tab.vars[xi].get("units_in"):
                tab.vars[xi]["units_in"] = unit
            elif unit and tab.vars[xi].get("units_in") and norm(unit) != norm(tab.vars[xi]["units_in"]):
                tab.vars[xi].setdefault("_mixed_units", set()).add(unit)
            put(xi, v, fl)
        else:
            for ci, key, unit, fci in var_cols:
                v, fl = _num(get(ci), decimal_comma)
                if v is None:
                    continue
                if fci is not None and not flag_ok(get(fci)):
                    flag_note[0] += 1
                    continue
                xi = tab.variable(key, units_in=unit)
                put(xi, v, fl)

    if n_bad_time:
        tab.warnings.append(f"{n_bad_time} of {n_rows} rows had an unreadable time and were skipped")
    if tp.date_only:
        tab.info.append(f"times carry only a date ({tp.date_only} distinct days); each is placed at "
                        f"12:00 UTC of that day and compared with a +/-12 h tolerance")
    if tp.naive and not tp.tz_stated:
        tab.warnings.append("times carry no UTC offset and the sidecar gives no 'time_zone' — UTC assumed")
    if flag_note[0]:
        tab.info.append(f"{flag_note[0]} values dropped by their quality flag")
    if flag_note[1]:
        tab.warnings.append(f"{flag_note[1]} values carry a quality flag but the sidecar declares no "
                            f"'flags': {{'good': [...]}} — flags were NOT applied")

    for var in tab.vars:
        mixed = var.pop("_mixed_units", None)
        if mixed:
            raise ValueError(f"variable '{var['key']}' arrives in several units "
                             f"({var.get('units_in')}, {', '.join(sorted(mixed))}); split it or convert first")

    a = tab.freeze()
    if xy_rows:
        idx = np.array(xy_rows)
        if not crs:
            raise ValueError(f"{path}: projected x/y columns need 'crs' in the sidecar (e.g. 'EPSG:28992')")
        la, lo = project_to_latlon(a["lat"][idx], a["lon"][idx], crs)
        a["lat"][idx], a["lon"][idx] = la, lo
        tab.info.append(f"{len(idx)} positions converted from {crs}")
    return tab


# ================================================================ CF NetCDF
def _decode_strings(var):
    import netCDF4
    x = var[:]
    if x.dtype.kind in ("S", "U") and x.ndim >= 2:
        x = netCDF4.chartostring(x)
    return np.array([str(s).strip() if not np.ma.is_masked(s) else "" for s in np.ravel(x)])


def _coord(ds, kind):
    """Find a coordinate variable by CF conventions."""
    std = {"time": ("time",), "lat": ("latitude",), "lon": ("longitude",),
           "z": ("depth", "altitude", "height", "height_above_sea_floor")}[kind]
    for name, v in ds.variables.items():
        sn = getattr(v, "standard_name", "").lower()
        ax = getattr(v, "axis", "").upper()
        if sn in std or (kind == "time" and ax == "T") or (kind == "z" and ax == "Z"):
            return name
    for name in {"time": ("time", "t"), "lat": ("lat", "latitude"), "lon": ("lon", "longitude"),
                 "z": ("z", "depth", "pres")}[kind]:
        if name in ds.variables and (kind != "z" or ds.variables[name].ndim <= 1
                                     or getattr(ds.variables[name], "positive", None)):
            return name
    return None


def read_cf_netcdf(path, meta, t_lo=None, t_hi=None):
    """CF-1.8 discrete sampling geometry -> Table.

    Every data variable is broadcast against the coordinates it shares
    dimensions with and flattened, which covers the orthogonal and incomplete
    multidimensional representations; a contiguous ragged array is expanded
    through its count variable first.
    """
    import netCDF4
    tab = Table()
    ds = netCDF4.Dataset(path)
    ds.set_auto_mask(True)
    try:
        ft = str(getattr(ds, "featureType", "")).strip()
        for k in ("title", "summary", "source", "institution", "license", "references"):
            if hasattr(ds, k):
                meta.setdefault(k if k != "summary" else "description", str(getattr(ds, k)))
        names = {k: _coord(ds, k) for k in ("time", "lat", "lon", "z")}
        if not names["time"] or not names["lat"] or not names["lon"]:
            raise ValueError(f"{path}: needs time, latitude and longitude coordinates")
        tv = ds.variables[names["time"]]
        tunits = getattr(tv, "units", "")
        tcal = getattr(tv, "calendar", "standard")

        # instance (station / profile / trajectory) identity
        inst_var = next((n for n, v in ds.variables.items() if hasattr(v, "cf_role")), None)
        inst_dim = ds.variables[inst_var].dimensions[0] if inst_var else None
        ids = _decode_strings(ds.variables[inst_var]) if inst_var else None
        name_var = None
        if inst_var:
            for n, v in ds.variables.items():
                if n != inst_var and v.dimensions[:1] == (inst_dim,) and "name" in n.lower():
                    name_var = n
        st_names = _decode_strings(ds.variables[name_var]) if name_var else None

        # contiguous ragged array: count variable -> instance index per element
        ragged = {}
        for n, v in ds.variables.items():
            if hasattr(v, "sample_dimension"):
                cnt = np.asarray(v[:]).astype(int)
                ragged[v.sample_dimension] = np.repeat(np.arange(len(cnt)), cnt)

        # time window on a shared 1-D time axis, applied before broadcasting
        tsel = slice(None)
        if tv.ndim == 1 and (t_lo or t_hi):
            tt = netCDF4.num2date(tv[:], tunits, tcal, only_use_cftime_datetimes=False,
                                  only_use_python_datetimes=True)
            ep = np.array([d.replace(tzinfo=dt.timezone.utc).timestamp() for d in tt])
            idx = np.nonzero((ep >= (t_lo or -1e18)) & (ep <= (t_hi or 1e18)))[0]
            if not len(idx):
                raise ValueError(f"{path}: no times inside the requested window")
            tsel = slice(int(idx[0]), int(idx[-1]) + 1)
        tdim = tv.dimensions[0] if tv.ndim == 1 else None

        def read(n):
            v = ds.variables[n]
            if tdim and tdim in v.dimensions and tsel != slice(None):
                sl = tuple(tsel if d == tdim else slice(None) for d in v.dimensions)
                return np.ma.filled(v[sl].astype(float), np.nan), v.dimensions
            data = v[:]
            if data.dtype.kind in "fiu":
                data = np.ma.filled(data.astype(float), np.nan)
            return data, v.dimensions

        coords = {k: read(n) for k, n in names.items() if n}
        tdata, tdims = coords["time"]
        tflat = np.asarray(tdata, float)
        ok_t = np.isfinite(tflat)
        conv = netCDF4.num2date(tflat[ok_t], tunits, tcal, only_use_cftime_datetimes=False,
                                only_use_python_datetimes=True)
        tsec = np.full(tflat.shape, np.nan)
        tsec[ok_t] = [d.replace(tzinfo=dt.timezone.utc).timestamp() for d in np.ravel(conv)]
        coords["time"] = (tsec, tdims)

        # z: which kind?
        if names["z"]:
            zv = ds.variables[names["z"]]
            sn = getattr(zv, "standard_name", "").lower()
            positive = getattr(zv, "positive", "down" if sn == "depth" else "up").lower()
            if sn == "height_above_sea_floor":
                tab.zkind = "height_above_bed"
            elif positive == "down":
                tab.zkind = "depth"
            else:
                tab.zkind = "elevation"
                meta.setdefault("vertical_datum", getattr(zv, "vertical_datum", None)
                                or getattr(zv, "datum", None))

        # stations
        st_lat, st_lon = coords["lat"][0], coords["lon"][0]
        if inst_var is not None:
            for i, sid in enumerate(ids):
                nm = st_names[i] if st_names is not None else None
                la = float(st_lat[i]) if coords["lat"][1] == (inst_dim,) else None
                lo = float(st_lon[i]) if coords["lon"][1] == (inst_dim,) else None
                tab.station(sid or f"{inst_dim}{i}", nm or None, la, lo)

        # data variables
        coord_names = set(n for n in names.values() if n) | {inst_var, name_var}
        ancillary = set()
        for v in ds.variables.values():
            ancillary.update(str(getattr(v, "ancillary_variables", "")).split())
        include = meta.get("include") or None
        include = [s.strip() for s in include.split(",")] if isinstance(include, str) else include
        exclude = set(meta.get("ignore") or [])
        declared = meta.get("variables") or {}
        quality = meta.get("quality") or {}

        def is_aux(n, v):
            nl = n.lower()
            return (nl.startswith(("qc_", "valid_", "src_", "flag_", "quality_"))
                    or hasattr(v, "flag_values") or hasattr(v, "flag_meanings")
                    or hasattr(v, "sample_dimension") or n in ancillary
                    or v.dtype.kind not in "f")

        candidates = []
        for n, v in ds.variables.items():
            if n in coord_names or n in exclude:
                continue
            if include is not None and n not in include:
                continue
            if declared and include is None and n not in declared:
                continue
            if include is None and not declared and is_aux(n, v):
                continue
            if v.ndim == 0 or (inst_dim and v.dimensions == (inst_dim,)):
                continue            # per-station attribute, not a measurement
            candidates.append(n)
        if not candidates:
            raise ValueError(f"{path}: no measurement variables found")

        for n in candidates:
            v = ds.variables[n]
            data, dims = read(n)
            data = np.asarray(data, float)

            # quality: sidecar mask, CF ancillary flags, or a valid_<name> mask
            good = np.isfinite(data)
            q = quality.get(n)
            mask_name = (q or {}).get("mask")
            if not mask_name and f"valid_{n}" in ds.variables:
                mask_name = f"valid_{n}"
                tab.info.append(f"{n}: masked with {mask_name} (1 = valid)")
            if mask_name:
                m, mdims = read(mask_name)
                goodvals = set((q or {}).get("good", [1]))
                mm = np.isin(np.nan_to_num(np.asarray(m, float), nan=-1), list(goodvals))
                good &= np.broadcast_to(mm, data.shape) if mdims == dims else mm

            def bc(arr_dims):
                arr, adims = arr_dims
                if adims == dims:
                    return np.asarray(arr)
                if all(d in dims for d in adims):
                    shape = [arr.shape[adims.index(d)] if d in adims else 1 for d in dims]
                    order = [adims.index(d) for d in dims if d in adims]
                    return np.broadcast_to(np.transpose(arr, order).reshape(shape), data.shape)
                # instance-level coordinate on a ragged element dimension
                if len(dims) == 1 and dims[0] in ragged and adims == (inst_dim,):
                    return np.asarray(arr)[ragged[dims[0]]]
                return None

            tt = bc(coords["time"])
            la, lo = bc(coords["lat"]), bc(coords["lon"])
            if tt is None or la is None or lo is None:
                tab.warnings.append(f"{n}: dimensions {dims} do not line up with time/lat/lon — skipped")
                continue
            zz = bc(coords["z"]) if "z" in coords else None
            if inst_dim in dims:
                sidx = np.broadcast_to(np.arange(len(ids)).reshape(
                    [len(ids) if d == inst_dim else 1 for d in dims]), data.shape)
            elif len(dims) == 1 and dims[0] in ragged:
                sidx = ragged[dims[0]]
            else:
                sidx = None
            keep = good & np.isfinite(tt) & np.isfinite(la) & np.isfinite(lo)
            if t_lo is not None:
                keep &= tt >= t_lo
            if t_hi is not None:
                keep &= tt <= t_hi
            nk = int(keep.sum())
            if not nk:
                tab.info.append(f"{n}: no valid values in the window")
                continue
            units = getattr(v, "units", None)
            xi = tab.variable(n, units_in=units, standard_name=getattr(v, "standard_name", None),
                              long_name=getattr(v, "long_name", None))
            la_k, lo_k = la[keep], lo[keep]
            if sidx is None:
                # free points: one station per distinct position
                pid = {}
                sidx_k = np.array([pid.setdefault((round(a, 5), round(b, 5)),
                                                  tab.station(f"{a:.5f}N {b:.5f}E"))
                                   for a, b in zip(la_k, lo_k)], dtype=np.int32)
            else:
                sidx_k = np.asarray(sidx)[keep]
            tab.add_block(sidx_k, np.round(tt[keep]).astype(np.int64), la_k, lo_k,
                          zz[keep] if zz is not None else np.full(nk, np.nan),
                          np.full(nk, xi, np.int16), data[keep], np.zeros(nk, np.int8))
            log(f"  {n}: {nk:,} values")
        if not tab.vars:
            raise ValueError(f"{path}: nothing left after quality screening")
        if ft:
            tab.info.append(f"file declares featureType '{ft}'")
    finally:
        ds.close()
    tab.freeze()
    return tab


# ================================================================ classification
def visit_ids(t, z):
    """Label each record of ONE station (sorted by t) with its visit.

    A visit is what one deployment of an instrument samples in one go: a cast,
    a bottle rosette, one row of a continuous record. Records sharing a
    timestamp are always one visit. Otherwise a new visit starts after a gap of
    VISIT_GAP_S, or as soon as a depth repeats -- a CTD cast stamps every level
    a few seconds apart but never returns to a depth, while a continuous
    record at one depth returns to it every sample.
    """
    n = len(t)
    if n == 0:
        return np.zeros(0, int)
    zr = np.where(np.isfinite(z), np.round(z, 1), np.nan)
    if not np.isfinite(zr).any():
        # no vertical coordinate: every distinct timestamp is its own visit
        return np.concatenate([[0], np.cumsum(np.diff(t) > 0)])
    ut, first = np.unique(t, return_index=True)
    vid_of_t = np.zeros(len(ut), int)
    v, seen, prev = 0, set(), None
    bounds = list(first) + [n]
    for k, tk in enumerate(ut):
        zs = {(None if x != x else float(x)) for x in zr[bounds[k]:bounds[k + 1]]}
        if prev is not None and (tk - prev > VISIT_GAP_S or (zs & seen)):
            v += 1
            seen = set()
        seen |= zs
        vid_of_t[k] = v
        prev = tk
    return vid_of_t[np.searchsorted(ut, t)]


def split_relocated(tab):
    """A fixed station whose position changed a few times keeps a fixed station
    per position, each compared at its own model cell, instead of being read as
    a moving platform. The longest-used position keeps the station's id; the
    others get '<id>@<first year>-<last year>'."""
    a = tab.a
    if not len(a["s"]):
        return
    order = np.lexsort((a["t"], a["s"]))
    bounds = np.flatnonzero(np.diff(a["s"][order])) + 1
    for g in np.split(order, bounds):
        t, lat, lon, z = a["t"][g], a["lat"][g], a["lon"][g], a["z"][g]
        if not (np.isfinite(lat).any() and np.isfinite(lon).any()):
            continue
        if (np.nanmax(lat) - np.nanmin(lat) <= MOVING_DEG
                and np.nanmax(lon) - np.nanmin(lon) <= MOVING_DEG):
            continue
        vid = visit_ids(t, z)
        starts = np.flatnonzero(np.r_[True, np.diff(vid) > 0])
        ends = list(starts[1:]) + [len(t)]
        if np.isfinite(z).any():
            zr = np.round(z, 1)
            lv = [len(np.unique(zr[a0:a1][np.isfinite(zr[a0:a1])])) for a0, a1 in zip(starts, ends)]
            if np.median(lv) >= PROFILE_LEVELS:
                continue                        # casts: positions are kept per cast
        vpos = [(np.nanmedian(lat[a0:a1]), np.nanmedian(lon[a0:a1])) for a0, a1 in zip(starts, ends)]
        clusters = []                           # [lat, lon, [visit indices]]
        for k, (la, lo) in enumerate(vpos):
            for c in clusters:
                if abs(c[0] - la) <= MOVING_DEG and abs(c[1] - lo) <= MOVING_DEG:
                    c[2].append(k)
                    break
            else:
                clusters.append([la, lo, [k]])
        if len(clusters) > RELOCATED_MAX_POSITIONS or min(len(c[2]) for c in clusters) < 2:
            continue                            # a platform that moves
        clusters.sort(key=lambda c: -len(c[2]))
        si = int(a["s"][g[0]])
        sid, name = tab.st_ids[si], tab.st_names[si]
        moved = []
        for la, lo, ks in clusters[1:]:
            y0 = utc_of(t[starts[ks[0]]]).year
            y1 = utc_of(t[starts[ks[-1]]]).year
            span = f"{y0}" if y0 == y1 else f"{y0}-{y1}"
            ni = tab.station(f"{sid}@{span}", f"{name} ({span.replace('-', '–')} position)",
                             float(la), float(lo))
            for k in ks:
                a["s"][g[starts[k]:ends[k]]] = ni
            moved.append(f"{span} ({len(ks)} visits)")
        dkm = max(111.2 * np.hypot(c[0] - clusters[0][0],
                                   (c[1] - clusters[0][1]) * np.cos(np.radians(c[0])))
                  for c in clusters[1:])
        tab.info.append(f"station {sid} was relocated (up to {dkm:.1f} km): kept as {len(clusters)} "
                        f"fixed stations — earlier/other positions {', '.join(moved)}")


def classify(tab):
    """Per-station kind and cadence, and the collection's kind. Decided from the
    sampling itself: a file's own label can be wrong or absent."""
    a = tab.a
    out = []
    order = np.lexsort((a["t"], a["s"]))
    s_sorted = a["s"][order]
    bounds = np.flatnonzero(np.diff(s_sorted)) + 1
    groups = np.split(order, bounds) if len(order) else []
    years_all = []
    for g in groups:
        si = int(a["s"][g[0]])
        t = a["t"][g]
        lat, lon = a["lat"][g], a["lon"][g]
        z = a["z"][g]
        vid = visit_ids(t, z)
        nvis = int(vid[-1]) + 1
        starts = np.flatnonzero(np.r_[True, np.diff(vid) > 0])
        vstart = t[starts]
        # distinct depth levels per visit
        levels = []
        if np.isfinite(z).any():
            zr = np.round(z, 1)
            ok = np.isfinite(zr)
            for a0, a1 in zip(starts, list(starts[1:]) + [len(t)]):
                zz = zr[a0:a1][ok[a0:a1]]
                levels.append(len(np.unique(zz)))
        med_levels = float(np.median(levels)) if levels else 0.0
        # A platform moves when its VISITS are in different places. A ship
        # drifting a few hundred metres during one cast is still taking one
        # profile; a ferry logging every minute along its route is not.
        ends = list(starts[1:]) + [len(t)]
        if nvis > 1:
            vlat = np.array([np.nanmedian(lat[a0:a1]) for a0, a1 in zip(starts, ends)])
            vlon = np.array([np.nanmedian(lon[a0:a1]) for a0, a1 in zip(starts, ends)])
        else:
            vlat, vlon = lat, lon
        moving = (np.nanmax(vlat) - np.nanmin(vlat) > MOVING_DEG
                  or np.nanmax(vlon) - np.nanmin(vlon) > MOVING_DEG)
        if med_levels >= PROFILE_LEVELS:
            # depth-resolved visits are casts wherever they were taken; each
            # cast keeps its own position when the profiles are written
            moving = False
        dts = np.diff(vstart)
        dt_med = float(np.median(dts)) if len(dts) else None
        yrs = sorted({utc_of(x).year for x in vstart})
        years_all.extend(yrs)
        span_years = max(1.0, (vstart[-1] - vstart[0]) / (365.25 * 86400)) if len(vstart) > 1 else 1.0
        visits_per_year = nvis / span_years

        if moving:
            kind = "trajectory"
        elif med_levels >= PROFILE_LEVELS:
            kind = "profiles" if (nvis == 1 or (dt_med or 0) > PROFILE_SERIES_MAX_S) \
                else "timeseries_profile"
        elif nvis == 1:
            kind = "point"
        else:
            kind = "timeseries"
        cadence = None
        if dt_med is not None:
            cadence = ("continuous" if dt_med <= CONTINUOUS_S
                       else "discrete" if dt_med <= DISCRETE_S else "sparse")
        zs = np.unique(np.round(z[np.isfinite(z)], 1))
        out.append(dict(index=si, kind=kind, cadence=cadence, dt_median_s=dt_med,
                        n_visits=nvis, visits_per_year=visits_per_year,
                        levels=med_levels, moving=bool(moving), years=yrs,
                        depths=[float(x) for x in zs[:12]] if len(zs) <= 12 else None,
                        n=int(len(g)), t0=int(t[0]), t1=int(t[-1]),
                        lat=float(np.nanmedian(lat)), lon=float(np.nanmedian(lon))))

    kinds = [s["kind"] for s in out]
    n = len(out)
    count = {k: kinds.count(k) for k in set(kinds)}
    if not n:
        coll = "empty"
    elif count.get("profiles", 0) >= 0.5 * n:
        coll = "profiles"
    elif count.get("trajectory", 0) >= 0.5 * n:
        coll = "trajectory"
    elif (n >= SURVEY_MIN_STATIONS
          and np.median([s["visits_per_year"] for s in out]) <= SURVEY_MAX_VISITS_PER_YEAR
          and count.get("timeseries_profile", 0) < 0.5 * n):
        coll = "survey"
    elif count.get("timeseries_profile", 0) >= 0.5 * n:
        coll = "timeseries_profile"
    elif count.get("timeseries", 0) + count.get("point", 0) == n and count.get("timeseries", 0):
        coll = "timeseries"
    elif count.get("point", 0) == n:
        coll = "survey"
    else:
        coll = "mixed"
    return coll, out


# ================================================================ variables
def describe_variables(tab, meta, vocab):
    """Units, quantity, level and value range of every variable, checked."""
    declared = {norm(k): v for k, v in (meta.get("variables") or {}).items()}
    a = tab.a
    out = {}
    for xi, var in enumerate(tab.vars):
        d = declared.get(norm(var["key"]), {})
        units = d.get("units") or var.get("units_in")
        std = d.get("standard_name") or var.get("standard_name")
        q = vocab.quantity(var["key"], std, d.get("quantity"))
        qd = vocab.quantities.get(q) if q else None
        vals = a["v"][a["x"] == xi]
        flags = a["f"][a["x"] == xi]
        if not len(vals):
            continue
        info = dict(
            label=d.get("long_name") or var.get("long_name") or (qd["label"] if qd else var["key"]),
            units=units or "", quantity=q, standard_name=std,
            level=d.get("level") or meta.get("level") or (
                "profile" if tab.zkind else None),
            model=d.get("model") or [],
            # a level carries its datum: NAP gauge vs a model zero is an offset,
            # not an error, and the viewer has to know which it is looking at
            datum=d.get("datum") or (meta.get("vertical_datum") if tab.zkind == "elevation" else None),
            n=int(len(vals)),
            nBelowDL=int((flags == FLAG_BELOW_DL).sum()),
            min=round(float(np.nanmin(vals)), _decimals(vals)),
            max=round(float(np.nanmax(vals)), _decimals(vals)),
        )
        notes = []
        if not units:
            notes.append("no units given")
        if q is None:
            notes.append("not in the vocabulary — shown, but only compared if 'model' names a model variable")
        elif units:
            conv = vocab.conversion(units, qd["units"], qd.get("group"))
            if conv is None:
                notes.append(f"units '{units}' do not convert to {qd['units']} ({q}); it will not be compared")
            elif conv[2]:
                notes.append(f"'{units}' converts to {qd['units']} only approximately")
        info["notes"] = notes
        out[var["key"]] = info
        for n in notes:
            tab.warnings.append(f"{var['key']}: {n}")
    return out


# ================================================================ writing
def _decimals(vals):
    """Decimal places that keep ~6 significant digits for this variable."""
    m = np.nanmax(np.abs(vals)) if len(vals) else 0
    if not np.isfinite(m) or m == 0:
        return 6
    return int(min(9, max(0, 5 - math.floor(math.log10(m)))))


def _jlist(arr, dec=None):
    """numpy -> JSON-ready list with NaN as null."""
    if dec is not None:
        arr = np.round(arr.astype(float), dec)
    out = arr.tolist()
    if arr.dtype.kind == "f":
        out = [None if (x != x) else x for x in out]
    return out


def _year_start(y):
    return int(dt.datetime(y, 1, 1, tzinfo=dt.timezone.utc).timestamp())


def _write_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".part"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, separators=(",", ":"), allow_nan=False)
    os.replace(tmp, path)


def write_collection(tab, meta, vocab, cid, out_root, inputs, dry_run=False):
    split_relocated(tab)
    a = tab.a
    coll_kind, stations = classify(tab)
    variables = describe_variables(tab, meta, vocab)
    keys = [v["key"] for v in tab.vars]
    dec = {xi: _decimals(a["v"][a["x"] == xi]) for xi in range(len(keys))}
    zdec = 2

    lat_ok = np.isfinite(a["lat"])
    bbox = [float(a["lat"][lat_ok].min()), float(a["lat"][lat_ok].max()),
            float(a["lon"][lat_ok].min()), float(a["lon"][lat_ok].max())] if lat_ok.any() else None
    doc = dict(
        format=FORMAT, id=cid,
        title=meta.get("title") or cid,
        description=meta.get("description"),
        source=meta.get("source") or meta.get("institution"),
        license=meta.get("license"), citation=meta.get("citation") or meta.get("references"),
        url=meta.get("url"),
        ingested=dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        inputs=inputs,
        kind=coll_kind,
        bbox=bbox,
        time=[iso(a["t"].min()), iso(a["t"].max())] if len(a["t"]) else None,
        vertical=dict(kind=tab.zkind, meaning=VERTICAL_KINDS.get(tab.zkind),
                      datum=meta.get("vertical_datum")) if tab.zkind else None,
        timePrecision="day" if any("only a date" in i for i in tab.info) else None,
        comparison=meta.get("comparison") or {},
        variables=variables,
        nRecords=int(len(a["v"])),
        stations=[], profiles=None, points=None,
        warnings=tab.warnings, info=tab.info,
        color=meta.get("color"),
    )
    root = os.path.join(out_root, cid)
    files = {}                                   # relative path -> object

    as_points = coll_kind in ("survey", "trajectory")
    used_slugs = set()
    prof_by_year, pts_by_year = {}, {}
    order = np.lexsort((a["z"], a["t"], a["s"]))
    s_sorted = a["s"][order]
    bounds = np.flatnonzero(np.diff(s_sorted)) + 1
    groups = {int(a["s"][g[0]]): g for g in (np.split(order, bounds) if len(order) else [])}

    for st in stations:
        si = st["index"]
        g = groups[si]
        sid, name = tab.st_ids[si], tab.st_names[si]
        kind = st["kind"]
        if as_points or kind in ("point", "trajectory"):
            for k in g:
                y = utc_of(a["t"][k]).year
                pts_by_year.setdefault(y, []).append(k)
            if not as_points:
                kind = "point"
            continue
        if kind == "profiles":
            gt = g[np.argsort(a["t"][g], kind="stable")]
            vid = visit_ids(a["t"][gt], a["z"][gt])
            for k in range(int(vid[-1]) + 1):
                sel = gt[vid == k]
                y = utc_of(a["t"][sel[0]]).year
                prof_by_year.setdefault(y, []).append((si, sel))
            continue
        # timeseries / timeseries_profile: one file per station-year
        slug = slugify(sid, f"s{si}")
        while slug in used_slugs:
            slug += "-x"
        used_slugs.add(slug)
        rec = dict(id=sid, name=name, lat=round(st["lat"], 6), lon=round(st["lon"], 6),
                   kind=kind, cadence=st["cadence"], dtMedianS=st["dt_median_s"],
                   nVisits=st["n_visits"], depths=st["depths"], years=st["years"],
                   t0=iso(st["t0"]), t1=iso(st["t1"]), file=f"ts/{slug}", vars={})
        yrs = np.array([utc_of(x).year for x in a["t"][g]])
        for y in sorted(set(yrs.tolist())):
            gy = g[yrs == y]
            body = {"year": y, "vars": {}}
            for xi in sorted(set(a["x"][gy].tolist())):
                gv = gy[a["x"][gy] == xi]
                gv = gv[np.argsort(a["t"][gv], kind="stable")]
                entry = {"t": ((a["t"][gv] - _year_start(y)) // 60).astype(int).tolist(),
                         "v": _jlist(a["v"][gv], dec[xi])}
                if np.isfinite(a["z"][gv]).any():
                    entry["z"] = _jlist(a["z"][gv], zdec)
                if (a["f"][gv] != 0).any():
                    entry["f"] = a["f"][gv].astype(int).tolist()
                body["vars"][keys[xi]] = entry
                vr = rec["vars"].setdefault(keys[xi], {"n": 0, "years": []})
                vr["n"] += len(gv)
                vr["years"].append(y)
            files[f"ts/{slug}/{y}.json"] = body
        doc["stations"].append(rec)

    if prof_by_year:
        summary = {}
        for y, casts in sorted(prof_by_year.items()):
            arr = []
            for si, sel in casts:
                sel = sel[np.argsort(a["z"][sel], kind="stable")]
                zs = np.unique(np.round(a["z"][sel], zdec))
                zs = zs[np.isfinite(zs)]
                vals = {}
                for xi in sorted(set(a["x"][sel].tolist())):
                    col = np.full(len(zs), np.nan)
                    m = sel[a["x"][sel] == xi]
                    pos = np.searchsorted(zs, np.round(a["z"][m], zdec))
                    ok = (pos < len(zs))
                    col[pos[ok]] = a["v"][m][ok]
                    vals[keys[xi]] = _jlist(col, dec[xi])
                t0 = int(a["t"][sel].min())
                arr.append(dict(id=f"{tab.st_ids[si]}@{iso(t0)[:16]}", station=tab.st_ids[si],
                                name=tab.st_names[si],
                                lat=round(float(np.nanmedian(a["lat"][sel])), 6),
                                lon=round(float(np.nanmedian(a["lon"][sel])), 6),
                                time=iso(t0), z=_jlist(zs, zdec), v=vals))
            files[f"profiles/{y}.json"] = {"year": y, "zkind": tab.zkind, "casts": arr}
            summary[str(y)] = len(arr)
        doc["profiles"] = {"years": summary, "n": sum(summary.values())}

    if pts_by_year:
        summary = {}
        for y, idx in sorted(pts_by_year.items()):
            idx = np.array(idx)
            # one row per (station, time, z) visit, columns per variable
            keyrows = {}
            rows = []
            for k in idx:
                kk = (int(a["s"][k]), int(a["t"][k]), None if not np.isfinite(a["z"][k]) else round(float(a["z"][k]), zdec))
                r = keyrows.get(kk)
                if r is None:
                    r = keyrows[kk] = len(rows)
                    rows.append([kk, float(a["lat"][k]), float(a["lon"][k])])
            vals = {keys[xi]: np.full(len(rows), np.nan) for xi in sorted(set(a["x"][idx].tolist()))}
            flg = {}
            for k in idx:
                kk = (int(a["s"][k]), int(a["t"][k]), None if not np.isfinite(a["z"][k]) else round(float(a["z"][k]), zdec))
                r = keyrows[kk]
                vals[keys[int(a["x"][k])]][r] = a["v"][k]
                if a["f"][k]:
                    flg.setdefault(keys[int(a["x"][k])], {})[r] = int(a["f"][k])
            body = {
                "year": y,
                "station": [tab.st_ids[r[0][0]] for r in rows],
                "lat": [round(r[1], 6) for r in rows],
                "lon": [round(r[2], 6) for r in rows],
                "t": [(r[0][1] - _year_start(y)) // 60 for r in rows],
                "v": {k: _jlist(v, dec[keys.index(k)]) for k, v in vals.items()},
            }
            if any(r[0][2] is not None for r in rows):
                body["z"] = [r[0][2] for r in rows]
            if flg:
                body["f"] = {k: {str(r): f for r, f in d.items()} for k, d in flg.items()}
            files[f"points/{y}.json"] = body
            summary[str(y)] = len(rows)
        doc["points"] = {"years": summary, "n": sum(summary.values()),
                         "nStations": len({tab.st_ids[int(s)] for s in a["s"]})}

    kinds_st = [s["kind"] for s in stations]
    doc["summary"] = {k: kinds_st.count(k) for k in sorted(set(kinds_st))}
    doc["nStations"] = len(stations)
    if dry_run:
        return doc, files

    # a unique scratch name: a previous run killed half-way may have left its
    # own behind, still locked by a sync client, and must not block this one
    for d in os.listdir(out_root) if os.path.isdir(out_root) else []:
        if d.startswith(cid + ".part"):
            shutil.rmtree(os.path.join(out_root, d), ignore_errors=True)
    tmp_root = f"{root}.part{os.getpid()}"
    for rel, obj in files.items():
        _write_json(os.path.join(tmp_root, rel), obj)
    _write_json(os.path.join(tmp_root, "collection.json"), doc)
    _swap_dir(tmp_root, root)
    rebuild_index(out_root)
    return doc, files


def _swap_dir(tmp, root):
    """Move a freshly written collection into place.

    Renaming a directory fails on Windows while anything holds a handle on a
    file inside it -- OneDrive and virus scanners open new files right after
    they are written. Retry for a few seconds, then fall back to copying, so a
    finished ingest is never lost to a sync client's timing.
    """
    import time
    for attempt in range(12):
        try:
            if os.path.isdir(root):
                shutil.rmtree(root)
            os.replace(tmp, root)
            return
        except PermissionError:
            time.sleep(0.25 * (attempt + 1))
    shutil.copytree(tmp, root, dirs_exist_ok=True)
    shutil.rmtree(tmp, ignore_errors=True)


def rebuild_index(out_root=STORE):
    """index.json: what the viewer reads first to find collections that overlap
    the open dataset, without opening any of them."""
    cols = []
    if os.path.isdir(out_root):
        for d in sorted(os.listdir(out_root)):
            if ".part" in d or d.startswith("_"):
                continue
            p = os.path.join(out_root, d, "collection.json")
            if not os.path.isfile(p):
                continue
            try:
                c = json.load(open(p, encoding="utf-8"))
            except Exception:
                continue
            cols.append(dict(
                id=c["id"], title=c.get("title"), kind=c.get("kind"), bbox=c.get("bbox"),
                time=c.get("time"), source=c.get("source"), nStations=c.get("nStations"),
                nRecords=c.get("nRecords"), color=c.get("color"),
                variables={k: dict(quantity=v.get("quantity"), units=v.get("units"),
                                   label=v.get("label")) for k, v in c.get("variables", {}).items()},
                path=f"{d}/collection.json"))
    _write_json(os.path.join(out_root, "index.json"), {"format": FORMAT, "collections": cols})
    return cols


# ================================================================ entry points
def _sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def ingest(path, meta_path=None, cid=None, title=None, variables=None, t_from=None,
           t_to=None, out_root=STORE, dry_run=False, vocab=None):
    """Read, classify and (unless dry_run) write one collection. Returns the
    collection document, which doubles as the report."""
    vocab = vocab or Vocab()
    meta = read_sidecar(meta_path)
    if title:
        meta["title"] = title
    if variables:
        meta["include"] = [v.strip() for v in variables.split(",") if v.strip()]
    t_lo = parse_bound(t_from or (meta.get("time_range") or [None, None])[0])
    t_hi = parse_bound(t_to or (meta.get("time_range") or [None, None])[1])
    ext = os.path.splitext(path[:-3] if path.lower().endswith(".gz") else path)[1].lower()
    log(f"reading {os.path.basename(path)}")
    if ext in (".nc", ".nc4", ".cdf", ".netcdf"):
        tab = read_cf_netcdf(path, meta, t_lo, t_hi)
    else:
        tab = read_csv_package(path, meta, t_lo, t_hi)
        if meta.get("include") and not meta.get("variables"):
            keep = {norm(k) for k in meta["include"]}
            xs = [i for i, v in enumerate(tab.vars) if norm(v["key"]) in keep]
            m = np.isin(tab.a["x"], xs)
            tab.a = {k: v[m] for k, v in tab.a.items()}
        if t_lo is not None or t_hi is not None:
            m = np.ones(len(tab.a["t"]), bool)
            if t_lo is not None:
                m &= tab.a["t"] >= t_lo
            if t_hi is not None:
                m &= tab.a["t"] <= t_hi
            tab.a = {k: v[m] for k, v in tab.a.items()}
    a = tab.a
    if not len(a["v"]):
        raise ValueError("no observations survived reading and screening")
    # drop stations that ended up with nothing, then out-of-range positions
    bad = ~((a["lat"] >= -90) & (a["lat"] <= 90) & (a["lon"] >= -180) & (a["lon"] <= 360))
    if bad.any():
        tab.warnings.append(f"{int(bad.sum())} values with impossible coordinates dropped")
        tab.a = {k: v[~bad] for k, v in a.items()}
    cid = slugify(cid or meta.get("id") or os.path.splitext(os.path.basename(path))[0])
    inputs = [dict(file=os.path.basename(p), sha256=_sha256(p), bytes=os.path.getsize(p))
              for p in [path] + ([meta_path] if meta_path else [])]
    doc, files = write_collection(tab, meta, vocab, cid, out_root, inputs, dry_run)
    return doc, files


def report(doc, files=None):
    lines = [f"collection '{doc['id']}' — {doc.get('title')}",
             f"  kind: {doc['kind']}   stations: {doc['nStations']} ({', '.join(f'{k} {v}' for k, v in doc['summary'].items())})",
             f"  time: {doc['time'][0]} .. {doc['time'][1]}" if doc.get("time") else "  time: —",
             f"  area: {doc['bbox'][0]:.3f}..{doc['bbox'][1]:.3f} N, {doc['bbox'][2]:.3f}..{doc['bbox'][3]:.3f} E"
             if doc.get("bbox") else "  area: —",
             f"  vertical: {doc['vertical']['kind']} ({doc['vertical']['meaning']})" if doc.get("vertical")
             else "  vertical: none (values are not depth-resolved)",
             f"  records: {doc['nRecords']:,}"]
    lines.append("  variables:")
    for k, v in doc["variables"].items():
        q = v["quantity"] or "—"
        lines.append(f"    {k:<18} {v['units'] or '?':<12} quantity={q:<30} n={v['n']:,}"
                     + (f"  level={v['level']}" if v.get("level") else "")
                     + (f"  datum={v['datum']}" if v.get("datum") else "")
                     + (f"  (<DL {v['nBelowDL']})" if v["nBelowDL"] else ""))
    if doc.get("profiles"):
        lines.append(f"  profiles: {doc['profiles']['n']} casts")
    if doc.get("points"):
        lines.append(f"  points: {doc['points']['n']} samples at {doc['points']['nStations']} stations")
    if files is not None:
        size = sum(len(json.dumps(o, separators=(',', ':'))) for o in files.values())
        lines.append(f"  output: {len(files)} data files, {size / 1e6:.1f} MB")
    for w in doc.get("warnings", []):
        lines.append(f"  WARNING {w}")
    for i in doc.get("info", []):
        lines.append(f"  note    {i}")
    return "\n".join(lines)


def _rmtree_retry(path, attempts=12):
    """rmtree that waits out a sync client briefly holding a handle (OneDrive
    locks a folder for a moment after the files in it are deleted)."""
    import time
    for attempt in range(attempts):
        try:
            shutil.rmtree(path)
            return True
        except FileNotFoundError:
            return True
        except PermissionError:
            time.sleep(0.25 * (attempt + 1))
    return False


def remove(cid, out_root=STORE):
    root = os.path.join(out_root, slugify(cid))
    if not os.path.isdir(root):
        raise ValueError(f"no collection '{cid}'")
    # leftovers of earlier removals that a sync client would not let go of
    for d in os.listdir(out_root):
        if d.startswith("_trash-"):
            shutil.rmtree(os.path.join(out_root, d), ignore_errors=True)
    if not _rmtree_retry(root):
        # still locked: take it out of the store's namespace (the index skips
        # '_' folders) and let the next removal sweep it up
        trash = os.path.join(out_root, f"_trash-{slugify(cid)}-{os.getpid()}")
        try:
            os.replace(root, trash)
        except OSError:
            cj = os.path.join(root, "collection.json")
            if os.path.isfile(cj):
                os.remove(cj)                 # unlisted, even if its folder stays
    rebuild_index(out_root)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0],
                                 formatter_class=argparse.RawDescriptionHelpFormatter,
                                 epilog=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("add", "check"):
        p = sub.add_parser(name, help="ingest a file" if name == "add" else "dry run: report only")
        p.add_argument("file")
        p.add_argument("--meta", help="JSON sidecar (default: <file>.json if present)")
        p.add_argument("--id", help="collection id (default: from sidecar or file name)")
        p.add_argument("--title")
        p.add_argument("--vars", help="comma-separated variables to keep")
        p.add_argument("--from", dest="t_from", help="first time to keep (ISO 8601)")
        p.add_argument("--to", dest="t_to", help="last time to keep (ISO 8601)")
        p.add_argument("--store", default=STORE)
    sub.add_parser("list").add_argument("--store", default=STORE)
    p = sub.add_parser("remove")
    p.add_argument("id")
    p.add_argument("--store", default=STORE)
    sub.add_parser("reindex").add_argument("--store", default=STORE)
    args = ap.parse_args(argv)

    if args.cmd in ("add", "check"):
        meta = args.meta
        if not meta:
            guess = os.path.splitext(args.file)[0] + ".json"
            meta = guess if os.path.isfile(guess) else None
        doc, files = ingest(args.file, meta, args.id, args.title, args.vars, args.t_from,
                            args.t_to, args.store, dry_run=args.cmd == "check")
        print(report(doc, files))
        if args.cmd == "add":
            print(f"written to {os.path.join(args.store, doc['id'])}")
    elif args.cmd == "list":
        for c in rebuild_index(args.store):
            t = c.get("time") or ["?", "?"]
            print(f"{c['id']:<32} {c['kind']:<18} {c.get('nStations', 0):>5} st  "
                  f"{t[0][:10]}..{t[1][:10]}  {', '.join(c['variables'])}")
    elif args.cmd == "remove":
        remove(args.id, args.store)
        print(f"removed {args.id}")
    elif args.cmd == "reindex":
        print(f"{len(rebuild_index(args.store))} collections")
    return 0


if __name__ == "__main__":
    sys.exit(main())
