"""
Convert a GETM-style NetCDF file (2D bathymetry + time series of water
elevation, dry cells = fill value) into the binary format the WebGL
viewer reads.

Usage:  process(nc_path, out_dir)  ->  meta dict

Outputs in out_dir:
  terrain.bin  float32[ny*nx]   bed/land elevation, m, +up (land filled)
  masks.bin    uint8[ny*nx]     bit0 land, bit1 intertidal
  elev.bin     int16[nT*ny*nx]  water level, cm; dry cells hold the nearest
                                wet level clamped just below the bed
  latlon.bin   float32[ny*nx*2] per-cell (lat, lon); written whenever the file
                                has usable coordinates, so the viewer can read
                                out true positions on curvilinear/rotated grids
  flow.bin     uint8[nT*ny*nx*2] velocity (u, v) along the GRID axes, written
                                when the file has a u/v pair; drives the
                                animated flow layer. See _write_flow.
  var_<key>.u16.bin
               uint16[nfr*ny*nx] one scalar variable over its true value range.
                                See _extract_variables for why uint16.
  vgrid.bin    uint16[ny*nx*nz] layer fraction of the local water column,
                                cell-major, bed first; written when the file
                                has a 4-D (time, level, y, x) grid. The viewer
                                multiplies it by the water depth it already
                                animates to get every layer's depth, which is
                                why no 4-D thickness field is ever stored.
  cellmap.bin  int32[ny*nx]     grid cell -> column index, -1 on land
  col_<key>.u16.bin
               uint16[ncol*nT*nz] the full 4-D field, level fastest then time
                                then cell, bed first, 0 = no data. Written only
                                for variables named with --profiles. One cell's
                                whole history is contiguous, so the viewer
                                fetches a vertical profile with one ranged read
                                instead of pulling the entire field.
  meta.json    dims, extents, dates, per-step stats
  status.json  progress ("stage", "pct") — updated while running

All binary output is written little-endian explicitly ('<i2', '<u2'): the
viewer reads it into a JavaScript typed array, which uses the *reader's* byte
order, so relying on the writer's native order would corrupt the field on a
big-endian host with no error anywhere.

CLI:
  python nc_pipeline.py <file.nc> [out_dir]            full conversion
  python nc_pipeline.py --latlon <file.nc> <out_dir>   refresh only latlon.bin
                                                       + its meta.json keys

  --vars a,b,c       export only these variables (any dimensionality)
  --profiles a,b,c   also write the column store for these 4-D variables, so
                     the viewer can draw vertical profiles and sections. Off by
                     default: a column store is ~230 MB per variable-year, and
                     a GETM/ERSEM file carries 67 4-D fields.
                     Each one also gets a depth-averaged map product.
"""
import json
import os
import re

# stop HDF5 from holding OS locks on .nc files (Windows stale-lock failures) —
# must be set before netCDF4/HDF5 is imported below
os.environ.setdefault("HDF5_USE_FILE_LOCKING", "FALSE")

import numpy as np
import netCDF4 as nc
from scipy.ndimage import distance_transform_edt

CLAMP_BELOW = 0.07  # m below terrain for dry cells

# Scalar variables are stored as uint16 over their true [min, max]. uint8 over
# a 1-99 percentile range (what this pipeline used to write) is fine for a
# colour drape but not for numbers anyone reads: on this dataset it quantises
# chlorophyll to 0.35 mg/m3 steps and clips the top and bottom percentile flat,
# so a timeseries of a bloom plateaus at a value the model never produced.
# uint16 costs one extra byte per cell per step and drops the relative error
# from ~0.4% to ~0.002%, with no clipping at all.
VAR_MAX = 65535

# Fill cells that are only *nearly* the declared fill value. The wave/wind
# fields in the 2015 hydro+bio file hold -9998 where the file says
# _FillValue = -9999, which is enough to defeat netCDF4's exact-match masking:
# the sentinel then survives into the data, so the colour scale minimum reads
# -9998 and the uint16 quantisation spends its whole range spanning it. Any
# cell within FILL_TOL of a sentinel is treated as missing instead.
FILL_TOL = 1.0
# The tolerance only applies to sentinels this far out of band. A fill value of
# -10 (this file's bathymetry) or -999 (its lat/lon) is close enough to real
# data that widening it by +/-1 could swallow genuine cells; those still match
# exactly, which is what netCDF4 already does for them.
FILL_TOL_MIN_ABS = 1000.0
# Checked in addition to each variable's own attributes, because some variables
# that write -9999/-9998 into the grid declare NaN as their _FillValue and so
# advertise no usable sentinel at all.
FILL_SENTINELS = (-9999.0,)


def _fill_values(var):
    """Out-of-band fill sentinels to test against, from the variable's own
    attributes plus the known ones."""
    out = []
    for attr in ("_FillValue", "missing_value"):
        fv = getattr(var, attr, None) if var is not None else None
        if fv is None:
            continue
        for x in np.atleast_1d(fv).ravel():
            x = float(x)
            if np.isfinite(x) and abs(x) >= FILL_TOL_MIN_ABS:
                out.append(x)
    out.extend(FILL_SENTINELS)
    return out


def _fill_hit(data, var):
    """Boolean array: cells within FILL_TOL of a fill sentinel."""
    data = np.asarray(data, np.float64)
    hit = np.zeros(data.shape, bool)
    for fv in _fill_values(var):
        hit |= np.abs(data - fv) <= FILL_TOL
    return hit


def _masked(a, var=None):
    """np.ma.masked_invalid, plus near-fill cells (see FILL_TOL)."""
    m = np.ma.masked_invalid(a)
    return np.ma.masked_where(_fill_hit(np.ma.getdata(m), var), m, copy=False)


def satellite_attr():
    from satellite import ATTRIBUTION
    return ATTRIBUTION


def _status(out_dir, stage, pct, extra=None):
    st = {"stage": stage, "pct": round(pct, 1)}
    if extra:
        st.update(extra)
    tmp = os.path.join(out_dir, "status.json.tmp")
    with open(tmp, "w") as f:
        json.dump(st, f)
    os.replace(tmp, os.path.join(out_dir, "status.json"))


def _grid_north_deg(lat2d, lon2d):
    """Compass bearing (deg CW from true north) of the +row direction, which the
    viewer draws along world -Z. Zero for a plain north-aligned grid; ~-17 for
    the rotated Dutch Wadden Sea GETM grid. The median shrugs off the noisier
    bearings at the domain edges."""
    dlat = np.gradient(lat2d, axis=0)
    dlon = np.gradient(lon2d, axis=0)
    bearing = np.degrees(np.arctan2(
        dlon * 111320.0 * np.cos(np.radians(lat2d)), dlat * 111320.0))
    return round(float(np.median(bearing)), 3)


def _cell_km(ds, lat2d, lon2d):
    """Length of a grid cell's side in km.

    Measured from the coordinate grid whenever there is one, because that is the
    only quantity that means the same thing for every grid the pipeline accepts:
    a projected run carries metres on `xc`, a spherical one carries degrees under
    the same name, and a curvilinear one carries neither uniformly. Reading the
    axis and hoping the units attribute is honest is how a 3 nm shelf grid came
    to describe itself as 500 m, which scaled every area by 114 and shrank the
    typed-coordinate tolerance below the cell size.

    Cells are rarely exactly square -- on a spherical grid dx shrinks with
    latitude -- and the viewer wants one number, so this returns the side of the
    square with the same area, and takes the median over the interior to ignore
    ragged edges.
    """
    if lat2d is not None and lon2d is not None:
        lat = np.asarray(lat2d, dtype="f8")
        lon = np.asarray(lon2d, dtype="f8")
        if lat.ndim == 2 and min(lat.shape) > 2:
            def hav(a1, o1, a2, o2):
                r = np.pi / 180.0
                d = (np.sin((a2 - a1) * r / 2) ** 2
                     + np.cos(a1 * r) * np.cos(a2 * r) * np.sin((o2 - o1) * r / 2) ** 2)
                return 2 * 6371.0088 * np.arcsin(np.sqrt(np.clip(d, 0, 1)))

            dx = hav(lat[:, :-1], lon[:, :-1], lat[:, 1:], lon[:, 1:])
            dy = hav(lat[:-1, :], lon[:-1, :], lat[1:, :], lon[1:, :])
            dx = dx[np.isfinite(dx) & (dx > 0)]
            dy = dy[np.isfinite(dy) & (dy > 0)]
            if dx.size and dy.size:
                return float(round(np.sqrt(np.median(dx) * np.median(dy)), 4))

    # no coordinates: a projected axis in metres is the next best thing
    for cn in ("xc", "x"):
        v = ds.variables.get(cn)
        if v is not None and v.ndim == 1 and v.shape[0] > 1:
            dx = float(np.abs(np.diff(v[:2])[0]))
            units = str(getattr(v, "units", "m")).lower()
            if "degree" in units or units.startswith("deg"):
                continue                      # degrees are not a length
            return dx / 1000.0 if "m" in units and "k" not in units else dx
    return 0.5


def _write_latlon(lat2d, lon2d, out_dir):
    """float32[ny*nx*2] of interleaved (lat, lon) -> latlon.bin.
    Returns the meta.json keys describing it."""
    if lat2d is None or lon2d is None:
        return {"hasLatLon": False, "gridNorthDeg": 0.0}
    ll = np.stack([np.asarray(lat2d, np.float32),
                   np.asarray(lon2d, np.float32)], axis=-1)
    ll.astype("<f4").tofile(os.path.join(out_dir, "latlon.bin"))
    return {"hasLatLon": True, "gridNorthDeg": _grid_north_deg(lat2d, lon2d)}


# candidate (eastward-ish, northward-ish) velocity component name pairs
_FLOW_PAIRS = (("u", "v"), ("uu", "vv"), ("u10", "v10"), ("ubar", "vbar"),
               ("uvel", "vvel"), ("u_velocity", "v_velocity"),
               ("eastward_velocity", "northward_velocity"),
               ("eastward_sea_water_velocity", "northward_sea_water_velocity"))


def _find_flow_pair(ds, n_t, ny, nx):
    """Locate a 3D (u, v) velocity pair on the model grid. Returns
    (uname, vname, uvar, vvar) or None."""
    for un, vn in _FLOW_PAIRS:
        uv, vv = ds.variables.get(un), ds.variables.get(vn)
        if uv is None or vv is None:
            continue
        if uv.shape == (n_t, ny, nx) and vv.shape == (n_t, ny, nx):
            return un, vn, uv, vv
    return None


def _write_flow(uvar, vvar, uname, vname, out_dir, n_t, ny, nx):
    """Export the velocity field for the viewer's flow animation.

    flow.bin       uint8[n_t*ny*nx*2], interleaved (u, v), symmetric about 128
                   so 128 decodes to exactly zero.
                   encode:  b = round(sign(c)*sqrt(|c|/scale) * 127) + 128
                   decode:  s = (b-128)/127;  c = sign(s)*s*s*scale
                   The square root spends resolution where the data actually
                   lives: precision is ~constant in RELATIVE terms, so slow
                   flow (the bulk) stays smooth while the fast tidal jets are
                   represented at full magnitude. Plain linear coding forces a
                   choice between the two — scaling to the 2.9 m/s peak coarsens
                   the 0.24 m/s median to ~10%, while scaling to a percentile
                   silently clips the jets to a fraction of their true speed.
    var_speed.u16.bin  the derived |velocity| magnitude, as an ordinary scalar
                   variable so it gets a colormap drape, a legend and a
                   timeseries for free

    NOTE the components are stored exactly as the model reports them, along the
    GRID axes (+u = +column/xc, +v = +row/yc) — NOT geographic east/north. The
    viewer draws in grid space too, so it maps u -> +X and v -> -Z with no
    rotation. Verified against this dataset by checking that strong flow runs
    parallel to the coastline; the east/north reading scores 3x worse.

    Returns (flow_meta, speed_descriptor, speed_step_stats).
    """
    # scale = the full magnitude range (with headroom), sampled over ~40 frames.
    # The sqrt coding keeps small values precise, so unlike linear coding there
    # is no reason to clip the peaks.
    step = max(1, n_t // 40)
    comps, speeds = [], []
    for t in range(0, n_t, step):
        a = _masked(uvar[t], uvar); b = _masked(vvar[t], vvar)
        comps.append(np.abs(np.concatenate([np.ma.compressed(a), np.ma.compressed(b)])))
        speeds.append(np.ma.compressed(np.ma.sqrt(a * a + b * b)))
    comps = np.concatenate([c for c in comps if c.size]) if comps else np.zeros(1)
    speeds = np.concatenate([s for s in speeds if s.size]) if speeds else np.zeros(1)
    scale = float(comps.max()) * 1.25          # headroom for unsampled frames
    if not np.isfinite(scale) or scale <= 0:
        scale = 1.0
    scale = max(scale, 0.05)
    sp_hi = float(np.percentile(speeds, 99.0))
    if not np.isfinite(sp_hi) or sp_hi <= 0:
        sp_hi = scale

    fpath = os.path.join(out_dir, "flow.bin")
    sname = "var_speed.u16.bin"
    spath = os.path.join(out_dir, sname)
    inv_scale = 1.0 / scale
    prev_mask = idx = None
    clipped = 0
    true_max = 0.0
    # Speed is buffered rather than streamed because it has to be quantised
    # against its own true maximum, which is only known once every frame has
    # been read — and re-reading u and v to find it would double the slowest
    # part of the conversion. float32 here is ~4 bytes per cell per step.
    speed_frames = np.empty((n_t, ny, nx), np.float32)
    s_min, s_mean, s_max = [], [], []
    with open(fpath, "wb") as ff:
        for t in range(n_t):
            a = _masked(uvar[t], uvar)
            b = _masked(vvar[t], vvar)
            m = np.ma.getmaskarray(a) | np.ma.getmaskarray(b)
            au = np.ma.filled(a, 0.0); av = np.ma.filled(b, 0.0)
            if m.any():
                # nearest-fill dry/land cells so bilinear sampling stays smooth at
                # coastlines — zero-filling would stall particles against the shore.
                # The mask is constant for GETM output, so this EDT runs once.
                if idx is None or not np.array_equal(m, prev_mask):
                    idx = distance_transform_edt(
                        m, return_distances=False, return_indices=True)
                    prev_mask = m
                au = au[tuple(idx)]; av = av[tuple(idx)]
            q = np.empty((ny, nx, 2), np.uint8)
            for c, arr in ((0, au), (1, av)):
                mag = np.abs(arr) * inv_scale
                clipped += int((mag > 1.0).sum())
                z = np.sign(arr) * np.sqrt(np.minimum(mag, 1.0))
                q[:, :, c] = (np.clip(np.round(z * 127.0) + 128.0, 1.0, 255.0)
                              ).astype(np.uint8)
            q.tofile(ff)
            sp = np.hypot(au, av)
            speed_frames[t] = sp
            true_max = max(true_max, float(sp.max()))
            # statistics over real cells only — the nearest-filled land would
            # otherwise pull the domain mean toward whatever the coast is doing
            real = sp[~m] if m.any() else sp.ravel()
            if real.size:
                s_min.append(_sig(real.min()))
                s_mean.append(_sig(real.mean()))
                s_max.append(_sig(real.max()))
            else:
                s_min.append(None); s_mean.append(None); s_max.append(None)
            if t % 25 == 0 or t == n_t - 1:
                _status(out_dir, "exporting flow field", 88 + 4 * (t + 1) / n_t,
                        {"step": t + 1, "of": n_t})
    if clipped:
        print(f"[pipeline] WARNING: {clipped} velocity components exceeded the "
              f"{scale:.3g} m/s scale and were clipped")

    sp_top = max(true_max, 1e-6)
    with open(spath, "wb") as fs:
        for t in range(n_t):
            q = np.clip(speed_frames[t] * (VAR_MAX / sp_top), 0.0, VAR_MAX)
            np.rint(q).astype("<u2").tofile(fs)
    del speed_frames

    flow_meta = {
        "hasFlow": True,
        "scale": round(scale, 6),
        "nFrames": int(n_t),
        "uName": uname, "vName": vname,
        # components lie along the grid axes, so the viewer needs no rotation
        "gridAligned": True,
        "maxSpeed": round(true_max, 4),
    }
    speed_var = {
        "key": "speed", "name": "speed", "long": "current speed", "units": "m/s",
        "file": sname, "bytes": 2,
        "dataMin": 0.0, "dataMax": _sig(sp_top),
        # display default stays the 99th percentile: keying the colour scale to
        # the peak leaves everything but the inlet jets in the bottom fifth
        "lo": 0.0, "hi": _sig(sp_hi),
        "colormap": _variable_colormap("speed", "current speed", "m/s"),
        "nFrames": int(n_t), "static": False, "layer": None, "layerLabel": None,
    }
    print(f"[pipeline] flow '{uname}/{vname}' -> flow.bin "
          f"({n_t} frames, +/-{scale:.3g} m/s sqrt-coded, peak {true_max:.3g} m/s)")
    print(f"[pipeline] variable 'speed' -> {sname} (0..{sp_top:.3g} m/s)")
    return flow_meta, speed_var, {"min": s_min, "mean": s_mean, "max": s_max}


def _vertical_datum(ds, *variables):
    """The datum elevations are measured against, if the file says so.

    It usually does not, and inventing one would be worse than admitting it:
    "+1.2 m" means something very different against NAP, against MSL, and
    against an arbitrary model zero. The viewer prints "not stated in the
    source file" when this returns None rather than guessing.
    """
    keys = ("vertical_datum", "datum", "vertical_crs", "geoid_name",
            "vertical_coordinate_system")
    for holder in (*variables, ds):
        if holder is None:
            continue
        for k in keys:
            val = getattr(holder, k, None)
            if val:
                return str(val).strip()
    return None


def _find_var(ds, names, ndim, exclude=()):
    for n in names:
        if n in ds.variables and ds.variables[n].ndim == ndim:
            return ds.variables[n]
    for n, v in ds.variables.items():
        if v.ndim == ndim and n not in exclude:
            return v
    return None


# variables that are grid geometry / already handled, never a model variable
_SKIP_VARS = {"latc", "lonc", "latitude", "longitude", "lat", "lon", "xc", "yc",
               "x", "y", "time", "zc", "z", "level", "layers", "sigma",
               "bathymetry", "bathy", "depth", "h"}


def _variable_colormap(name, long_name, units, dmin=None, dmax=None):
    """Pick a colormap from a variable's name, long name, units and value range.

    Mirrors defaultCmap() in js/colormaps.js, which is the version that actually
    decides what the viewer shows -- the app re-classifies whenever meta.json
    holds the fallback, so a dataset built before a rule existed still benefits.
    This one exists so meta.json is right for anything else that reads it.
    Change both together, in the same order: first match wins.
    """
    s = " ".join(str(t) for t in (name, long_name, units) if t).lower()

    def has(*w):
        return any(x in s for x in w)

    def word(*w):
        # whole-token match, for short names that are substrings of other words:
        # "ess" sits inside "stress", "hs" inside "flashes"
        return any(re.search(r"(^|[^a-z0-9])%s($|[^a-z0-9])" % x, s) for x in w)

    signed = (dmin is not None and dmax is not None
              and float(dmin) < 0 < float(dmax))

    # A signed component or anomaly carries its meaning in the sign, which a
    # sequential map cannot show: an eastward and a westward wind of the same
    # strength must not be the same colour.
    if signed and (has("anomaly", "residual", "difference", "delta", "gradient", "divergence")
                   or has("eastward", "northward", "westward", "southward",
                          "easternwind", "southernwind")
                   or word("u", "v", "uu", "vv", "east", "west", "north", "south",
                           "component")):
        return "vik"

    # 0 and 360 are the same bearing, so the map has to close on itself
    if has("direction", "bearing", "heading", "azimuth", "phase") or (
            has("angle") and has("deg")):
        return "romaO"

    if has("shear", "stress") or word("tau", "taub", "tauc", "tauw"):
        return "lajolla"
    if has("wave height", "waveheight", "significant wave") or word("hs", "swh", "hsig"):
        return "davos"
    if has("period", "zero crossing") or word("tz", "tp", "tm"):
        return "turku"

    if has("temperature", "temp", "sst", "theta"):
        return "thermal"
    if has("salin", "salt") or word("psu", "sal"):
        return "haline"
    if (has("chlorophyll", "phytoplankton", "phyto", "diatom", "algae", "flagel")
            or word("chl", "chla") or has("p1_", "p2_", "p3_", "p4_")):
        return "algae"
    if (has("sediment", "turbid", "silt", "clay", "sand", "extinction", "attenuation",
            "backscatter", "secchi", "suspended")
            or word("spm", "ssc", "tsm", "ess", "kd")):
        return "turbid"
    if has("detritus", "organic", "carbon") or word("poc", "pon", "doc", "om"):
        return "bamako"
    if (has("nitrate", "nitrogen", "nitrite", "phosph", "silicate", "ammoni", "nutrient")
            or word("o2", "oxygen", "n1p", "n3n", "n4n", "n5s", "ph")):
        return "nuuk"
    if (has("zooplankton", "macrofauna", "invertebrate", "benthos", "benthic",
            "fauna", "bacteria") or word("z4", "z5", "z6")):
        return "turku"
    if (has("speed", "velocity", "current", "orbital", "wind", "discharge", "transport")
            or word("m/s", "m s-1")):
        return "speed"
    if (has("bathym", "topograph", "bed level", "seabed", "orography")
            or word("elevation", "zb")):
        return "oleron"
    if has("depth", "thickness"):
        return "devon"

    return "viridis"


# ========================================================== 4-D vertical grid
#
# A 4-D field (time, level, y, x) carries one value per sigma layer. Three
# measured facts about this model's output shape everything below; each was
# checked against the GETM/ERSEM run rather than assumed.
#
#   * The layer thicknesses sum to bathymetry + elev to 6e-6 m, so the vertical
#     grid is consistent with the terrain and water level the viewer already
#     animates.
#   * The layer FRACTIONS h/D are time-invariant to ~4e-5 of the water depth
#     (max 7.9e-3 over a month). So the entire 4-D thickness field collapses to
#     one (level, cell) array: 1.3 MB instead of 230 MB a year, and the viewer
#     rebuilds every layer depth from the water level it already has. Measured
#     round-trip error of the reconstructed thickness is 0.5 mm median, 3 cm at
#     the 99.9th percentile, 8.3 cm worst case.
#   * GETM writes a dummy level 0 that is fill everywhere, so the level
#     dimension is one longer than the number of real layers.
#
# Canonical order everywhere downstream is BED FIRST, surface last, whatever
# order the file used. The viewer never has to ask.

VGRID_SAMPLES = 12          # timesteps sampled when building the fraction field
COL_MISSING = 0             # column codes are 1..65535; 0 means "no data"
COL_MAX = 65535


def _is_4d(v, n_t, ny, nx):
    return v.ndim == 4 and v.shape[0] == n_t and v.shape[-2:] == (ny, nx)


def _thickness_var(ds, n_t, ny, nx):
    """The 4-D layer-thickness variable, by name first then by long_name."""
    for n in ("h", "dz", "thickness", "layer_thickness"):
        v = ds.variables.get(n)
        if v is not None and _is_4d(v, n_t, ny, nx):
            return n, v
    for n, v in ds.variables.items():
        if _is_4d(v, n_t, ny, nx) and "thickness" in str(
                getattr(v, "long_name", "")).lower():
            return n, v
    return None, None


def _surface_is_last(ds, n_t, ny, nx, lev):
    """Which end of the level axis is the free surface?

    Decided from light where the file carries it: irradiance can only decrease
    away from the surface, so it settles the question with physics instead of a
    convention. Falling back to "last index is the surface" matches GETM, ROMS
    and Delft3D-FM, and meta.json records which of the two answered, because
    getting this backwards silently plots every profile upside down.
    """
    for n, v in ds.variables.items():
        s = (n + " " + str(getattr(v, "long_name", ""))).lower()
        if not _is_4d(v, n_t, ny, nx):
            continue
        if not any(w in s for w in ("irradiance", "radiation", "light",
                                    "par", "eir", "swr")):
            continue
        for t in {n_t // 2, 0}:
            a = _masked(v[t], v)
            hi, lo = np.ma.median(a[lev[-1]]), np.ma.median(a[lev[0]])
            if hi is np.ma.masked or lo is np.ma.masked:
                continue
            if abs(float(hi) - float(lo)) > 1e-9:
                return bool(float(hi) > float(lo)), n
    return True, None


def _vertical_grid(ds, out_dir, n_t, ny, nx, land):
    """Detect the sigma grid and write vgrid.bin. Returns a meta dict or None.

    vgrid.bin  uint16[ny*nx][nz]  layer fraction of the local water column,
                                  cell-major, bed first. Decode f = v/65535.
    """
    hname, hv = _thickness_var(ds, n_t, ny, nx)
    if hv is None:
        return None

    # which indices of the level axis carry data at all — GETM's level 0 never
    # does, and a model that writes a clean axis simply has none to drop
    probe = [_masked(hv[t], hv) for t in {0, n_t // 2, n_t - 1}]
    real = [k for k in range(hv.shape[1])
            if any(p[k].count() for p in probe)]
    if len(real) < 2:
        return None
    dropped = hv.shape[1] - len(real)

    surf_last, light = _surface_is_last(ds, n_t, ny, nx, real)
    lev = list(real) if surf_last else list(reversed(real))   # bed -> surface
    nz = len(lev)

    # fraction field, as the median over sampled steps. The median rather than
    # one step because a drying cell's column collapses to the model's minimum
    # layer thickness and would otherwise set the geometry for all time.
    step = max(1, n_t // VGRID_SAMPLES)
    acc = []
    for t in range(0, n_t, step):
        h = _masked(hv[t], hv)[lev]
        D = h.sum(axis=0)
        with np.errstate(invalid="ignore", divide="ignore"):
            f = np.ma.filled(h / D[None, :, :], np.nan)
        f[:, np.ma.filled(D, 0.0) <= 0.05] = np.nan      # drying: meaningless
        acc.append(f)
    with np.errstate(invalid="ignore"):
        frac = np.nanmedian(np.stack(acc), axis=0)

    good = np.isfinite(frac).all(axis=0) & ~land
    tot = np.where(good, frac.sum(axis=0), 1.0)
    frac = np.where(good[None, :, :], frac / tot[None, :, :], 0.0)

    # cell-major: the viewer wants a whole column at once
    out = np.rint(np.clip(frac, 0.0, 1.0) * COL_MAX).astype("<u2")
    out.reshape(nz, -1).T.copy().tofile(os.path.join(out_dir, "vgrid.bin"))

    print(f"[pipeline] vertical grid: {nz} layers from '{hname}'"
          + (f" (dropped {dropped} empty level{'s' if dropped != 1 else ''})" if dropped else "")
          + f", surface {'last' if surf_last else 'first'} in file"
          + (f" per '{light}'" if light else " by convention")
          + f", {int(good.sum())} columns")
    return {
        "nLayers": nz,
        "file": "vgrid.bin",
        "thicknessVar": hname,
        "surfaceLastInFile": bool(surf_last),
        "orientationFrom": light or "convention (last level is the surface)",
        "droppedLevels": int(dropped),
        "_lev": lev,                       # file indices, bed -> surface
        "_frac": frac,                     # (nz, ny, nx) float, sums to 1
        "_good": good,
    }


def _write_cellmap(out_dir, land):
    """cellmap.bin int32[ny*nx]: grid cell -> column index, -1 on land.

    Columns exist only for sea cells, which halves every column store; the map
    is what lets the viewer turn a picked cell into a file offset.
    """
    sea = (~land).ravel()
    cmap = np.full(sea.size, -1, "<i4")
    cmap[sea] = np.arange(int(sea.sum()), dtype="<i4")
    cmap.tofile(os.path.join(out_dir, "cellmap.bin"))
    return int(sea.sum()), sea


def _write_columns(v, var, lev, sea, ncol, out_dir, key, n_t, vmin, vmax):
    """Write col_<key>.u16.bin: uint16[column][time][level], bed first.

    Level fastest, then time, then cell. One cell's entire history is therefore
    contiguous — 7.3 kB for a year of daily output — so the viewer fetches a
    profile with a single ranged read instead of pulling the whole field.

    0 codes "no data" (land, dry, below the bed) and real values occupy
    1..65535. Spending one quantum on an explicit gap is worth it: the
    alternative is nearest-filling, which is a rendering convenience for the
    drape and would be an invention in a number someone reads off a profile.
    """
    nz = len(lev)
    path = os.path.join(out_dir, f"col_{key}.u16.bin")
    inv = (COL_MAX - 1) / (vmax - vmin) if vmax > vmin else 0.0
    out = np.memmap(path, dtype="<u2", mode="w+", shape=(ncol, n_t, nz))
    try:
        for t in range(n_t):
            a = _masked(v[t], var)[lev]                 # (nz, ny, nx)
            q = np.rint(np.clip((np.ma.filled(a, vmin) - vmin) * inv,
                                0, COL_MAX - 1)) + 1
            q[np.ma.getmaskarray(a)] = COL_MISSING
            out[:, t, :] = q.reshape(nz, -1)[:, sea].T.astype("<u2")
        out.flush()
    finally:
        del out
    return {"file": f"col_{key}.u16.bin", "bytes": 2, "nLayers": nz,
            "nFrames": int(n_t), "missing": COL_MISSING,
            "codeMin": 1, "codeMax": COL_MAX}


def _sig(x, digits=6):
    """Round to significant digits — plain decimal rounding would flatten a
    6.9e-05 nitrate value to zero in meta.json."""
    return float(f"{float(x):.{digits}g}")


def _extract_variables(ds, out_dir, exclude, ny, nx, n_t, vgrid=None,
                       profiles=(), only=None, sea=None, ncol=0):
    """Export every extra scalar field (temperature, salinity, plankton, …) as
    uint16 over its true value range, one value per cell per timestep, plus
    per-timestep domain statistics.

    Two passes over each variable. The first finds the exact global min/max and
    accumulates the per-step statistics from the *unfilled* data; the second
    quantises and writes. A single pass would have to guess the range from
    sampled frames and either clip the peaks or waste resolution on headroom —
    the whole point of moving off uint8 was to stop doing that.

    Masked cells are nearest-filled on write so linear texture sampling doesn't
    bleed at coastlines. That fill is a rendering convenience and NOT data: the
    viewer suppresses those cells on read using the land mask and the wet test.

    A 4-D (time, level, y, x) field collapses to the surface layer for the map
    drape, as it always did. Naming it in `profiles` additionally writes the
    full column store and a depth-averaged field as a variable in its own
    right. That one is derived here rather than in the viewer because it is a
    MAP — the viewer only ever holds the columns it was asked for.

    Returns a list of variable descriptors for meta.json, and a dict of
    per-variable per-step statistics.
    """
    variables = []
    var_stats = {}
    lev = vgrid["_lev"] if vgrid else None
    frac = vgrid["_frac"] if vgrid else None

    for name, v in ds.variables.items():
        if name in exclude or name.lower() in _SKIP_VARS:
            continue
        if only is not None and name.lower() not in only:
            continue
        sh = v.shape
        n_layers = None
        layer = None
        products = []            # (suffix, label_suffix, reader, want_column)

        if v.ndim == 2 and sh == (ny, nx):
            nfr, static = 1, True
            products = [("", "", lambda t, v=v: _masked(v[:], v), False)]
        elif v.ndim == 3 and sh == (n_t, ny, nx):
            nfr, static = n_t, False
            products = [("", "", lambda t, v=v: _masked(v[t], v), False)]
        elif _is_4d(v, n_t, ny, nx):
            nfr, static = n_t, False
            lv = lev if lev is not None else list(range(sh[1]))
            n_layers = len(lv)
            layer = lv[-1]                       # surface, in FILE indices
            wanted = name.lower() in profiles
            products = [("", "", lambda t, v=v, k=lv[-1]: _masked(v[t], v)[k],
                         wanted)]
            if wanted and frac is not None:
                products.append((
                    "-avg", ", depth-averaged",
                    lambda t, v=v, lv=lv: _depth_avg(_masked(v[t], v)[lv], frac),
                    False))
        else:
            continue

        long_name = str(getattr(v, "long_name", "") or "")
        units = str(getattr(v, "units", "") or "")
        base_key = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "var"

        for suffix, label, frame, want_column in products:
            # near-fill cells are silently dropped by frame(); say so, so a file
            # whose fill values are off by a bit isn't quietly "fixed" without a word
            if not suffix:
                raw0 = v[:] if static else (v[0] if v.ndim == 3 else v[0, layer])
                near = int((_fill_hit(np.ma.getdata(raw0), v)
                            & ~np.ma.getmaskarray(raw0)).sum())
                if near:
                    print(f"[pipeline] '{name}': {near} cells within {FILL_TOL} of a "
                          f"fill value treated as missing (first frame)")

            # ---- pass 1: exact range + per-step domain statistics ----
            vmin, vmax = np.inf, -np.inf
            s_min, s_mean, s_max = [], [], []
            for t in range(nfr):
                c = np.ma.compressed(frame(t))
                if c.size:
                    lo_t, hi_t = float(c.min()), float(c.max())
                    vmin = min(vmin, lo_t)
                    vmax = max(vmax, hi_t)
                    s_min.append(_sig(lo_t))
                    s_mean.append(_sig(c.mean()))
                    s_max.append(_sig(hi_t))
                else:
                    s_min.append(None)
                    s_mean.append(None)
                    s_max.append(None)
            if not np.isfinite(vmin) or not np.isfinite(vmax):
                continue
            if vmax - vmin < 1e-12:
                vmax = vmin + 1.0

            # display default: the 1-99 percentile, which is a far better first
            # colour scale than the full range when a handful of cells are extreme.
            # It no longer limits what is STORED — the user can widen it in the app.
            step = 1 if nfr <= 40 else max(1, nfr // 40)
            sample = [np.ma.compressed(frame(t)) for t in range(0, nfr, step)]
            sample = [c for c in sample if c.size]
            allv = np.concatenate(sample) if sample else np.array([vmin, vmax])
            lo, hi = (float(x) for x in np.percentile(allv, [1.0, 99.0]))
            if not (np.isfinite(lo) and np.isfinite(hi)) or hi - lo < 1e-12:
                lo, hi = vmin, vmax
            # ---- pass 2: quantise and write ----
            inv = VAR_MAX / (vmax - vmin)
            key = base_key + suffix
            fname = f"var_{key}.u16.bin"
            path = os.path.join(out_dir, fname)
            prev_mask = idx = None
            with open(path, "wb") as f:
                for t in range(nfr):
                    a = frame(t)
                    m = np.ma.getmaskarray(a)
                    if m.any():
                        if idx is None or not np.array_equal(m, prev_mask):
                            idx = distance_transform_edt(
                                m, return_distances=False, return_indices=True)
                            prev_mask = m
                        filled = np.ma.filled(a, 0.0)[tuple(idx)]
                    else:
                        filled = np.ma.filled(a, 0.0)
                    q = np.clip((filled - vmin) * inv, 0.0, VAR_MAX)
                    np.rint(q).astype("<u2").tofile(f)

            desc = {
                "key": key, "name": name + suffix, "long": long_name + label,
                "units": units,
                "file": fname, "bytes": 2,
                "dataMin": _sig(vmin), "dataMax": _sig(vmax),
                "lo": _sig(lo), "hi": _sig(hi),
                "colormap": _variable_colormap(name + suffix, long_name + label,
                                               units, vmin, vmax),
                "nFrames": int(nfr), "static": bool(static),
                "layer": (int(layer) if (layer is not None and not suffix) else None),
                "layerLabel": (f"surface layer (k = {n_layers} of {n_layers})"
                               if (layer is not None and not suffix) else
                               (f"all {n_layers} layers" if suffix == "-avg" else None)),
            }

            # ---- the column store, for variables asked for by name ----
            if want_column and sea is not None and ncol:
                _status(out_dir, f"column store: {name}", 93)
                desc["column"] = _write_columns(
                    v, v, lev, sea, ncol, out_dir, key, n_t, vmin, vmax)
                print(f"[pipeline] column store '{name}' -> col_{key}.u16.bin "
                      f"({ncol} columns x {n_t} steps x {len(lev)} layers, "
                      f"{ncol * n_t * len(lev) * 2 / 1e6:.0f} MB)")

            variables.append(desc)
            if not static and nfr == n_t:
                var_stats[key] = {"min": s_min, "mean": s_mean, "max": s_max}
            print(f"[pipeline] variable '{name + suffix}' -> {fname} "
                  f"({nfr} frame{'s' if nfr != 1 else ''}, "
                  f"{vmin:.4g}..{vmax:.4g} {units}, step {(vmax - vmin) / VAR_MAX:.3g})")
    return variables, var_stats


def _depth_avg(col, frac):
    """Depth-weighted mean of a (level, y, x) slab, bed first.

    Weighted by the stored layer fractions rather than this step's thicknesses:
    they sum to exactly 1, cost nothing to carry, and differ from the true
    thickness by 0.04 % of a layer. Reading h again per timestep would double
    the I/O of every depth-averaged field to buy that back.
    """
    w = np.ma.masked_where(np.ma.getmaskarray(col), np.broadcast_to(frac, col.shape))
    tot = w.sum(axis=0)
    out = (col * w).sum(axis=0) / np.ma.masked_less_equal(tot, 1e-9)
    return np.ma.masked_invalid(out)


def _drop_stale_variables(out_dir, variables):
    """Remove variable blobs left by an earlier run that this one did not write.

    Reprocessing an existing dataset overwrites terrain/elev/flow in place, but
    a variable whose name or storage format changed lands in a NEW file and the
    old one just sits there — 23 MB apiece for the uint8 files this pipeline
    used to emit, silently doubling the dataset on disk and in the image. Runs
    only after the replacements are safely written, so a failed conversion never
    destroys the previous export.
    """
    keep = {v["file"] for v in variables}
    for name in os.listdir(out_dir):
        stale = name.startswith("param_") and name.endswith(".bin")
        stale |= name.startswith("var_") and name.endswith(".bin")
        if stale and name not in keep:
            try:
                os.remove(os.path.join(out_dir, name))
                print(f"[pipeline] removed stale {name}")
            except OSError as e:
                print(f"[pipeline] could not remove stale {name}: {e}")


def process(nc_path, out_dir, only=None, profiles=()):
    os.makedirs(out_dir, exist_ok=True)
    _status(out_dir, "reading", 0)

    # the server process is long-lived: a handle leaked on error keeps the
    # .nc locked on Windows, breaking any later upload with the same name
    ds = nc.Dataset(nc_path)
    try:
        return _process(ds, nc_path, out_dir, only, profiles)
    finally:
        ds.close()


def _process(ds, nc_path, out_dir, only=None, profiles=()):
    coord_names = ("latc", "lonc", "latitude", "longitude", "lat", "lon",
                   "xc", "yc", "x", "y", "time")
    bvar = _find_var(ds, ("bathymetry", "bathy", "depth", "h"), 2, exclude=coord_names)
    evar = _find_var(ds, ("elev", "elevation", "eta", "zeta", "ssh"), 3)
    if bvar is None or evar is None:
        raise ValueError("Could not find a 2D bathymetry and a 3D elevation variable")
    # names of the vars we've consumed, so they aren't re-exported as parameters
    bname = next((n for n, v in ds.variables.items() if v is bvar), None)
    ename = next((n for n, v in ds.variables.items() if v is evar), None)

    bathy = _masked(bvar[:], bvar)
    ny, nx = bathy.shape
    n_t = evar.shape[0]
    if evar.shape[1] != ny or evar.shape[2] != nx:
        raise ValueError(f"elev grid {evar.shape[1:]} does not match bathymetry {bathy.shape}")

    # --- true per-cell coordinates ---
    # Read here, before anything that needs a cell size: the coordinate grid is
    # the only dependable measure of one, and the areas in the statistics below
    # are computed from it. Read on its own, so that a failed imagery download
    # later cannot cost us the coordinate readout too.
    import satellite
    lat2d = lon2d = None
    try:
        lat2d, lon2d = satellite.read_latlon(nc_path)
    except Exception as e:
        print(f"[pipeline] lat/lon unavailable: {e}")

    cell_km = _cell_km(ds, lat2d, lon2d)
    cell_area = cell_km * cell_km
    print(f"[pipeline] cell size {cell_km:.4g} km "
          f"({'measured from the coordinate grid' if lat2d is not None else 'from the model axis'})")

    # --- time axis ---
    start_date, step_days = "2015-01-01", 1.0
    tvar = ds.variables.get("time")
    if tvar is not None and tvar.ndim == 1 and tvar.shape[0] == n_t:
        try:
            units = getattr(tvar, "units", None)
            cal = getattr(tvar, "calendar", "standard")
            d0 = nc.num2date(tvar[0], units, cal)
            start_date = f"{d0.year:04d}-{d0.month:02d}-{d0.day:02d}"
            if n_t > 1:
                dt = nc.num2date(tvar[1], units, cal) - d0
                step_days = dt.total_seconds() / 86400.0
        except Exception:
            pass

    # --- lat/lon extents (for the hover tooltip) ---
    def _rng(names):
        for n in names:
            if n in ds.variables:
                v = np.ma.masked_invalid(ds.variables[n][:])
                if v.count():
                    return float(v.min()), float(v.max())
        return 0.0, 0.0
    lat_min, lat_max = _rng(("latc", "latitude", "lat"))
    lon_min, lon_max = _rng(("lonc", "longitude", "lon"))

    # --- terrain: +up, land filled with nearest sea height + gentle rise ---
    land = np.ma.getmaskarray(bathy)
    terrain = np.where(land, 0.0, -np.ma.filled(bathy, 0.0)).astype(np.float64)
    if land.any() and (~land).any():
        dist, (iy, ix) = distance_transform_edt(land, return_distances=True, return_indices=True)
        nearest = terrain[iy, ix]
        rise = np.minimum(1.0 + 1.15 * np.sqrt(dist), 9.0)
        terrain = np.where(land, np.maximum(nearest, 0.2) + rise, terrain)
    terrain = terrain.astype(np.float32)

    # --- per-step water level, filled + clamped under terrain where dry ---
    ever_wet = np.zeros((ny, nx), bool)
    ever_dry = np.zeros((ny, nx), bool)
    stats = {"exposedKm2": [], "floodedKm2": [], "meanLevel": [], "wetCells": []}
    elev_out = np.empty((n_t, ny, nx), "<i2")

    for d in range(n_t):
        e = _masked(evar[d], evar)
        dry = np.ma.getmaskarray(e)
        wet = ~dry
        ever_wet |= wet
        ever_dry |= dry & ~land

        if dry.any() and wet.any():
            idx = distance_transform_edt(dry, return_distances=False, return_indices=True)
            filled = np.ma.filled(e, 0.0)[tuple(idx)]
            filled = np.where(dry, np.minimum(filled, terrain - CLAMP_BELOW), filled)
        elif wet.any():
            filled = np.ma.filled(e, 0.0)
        else:
            filled = terrain - CLAMP_BELOW
        elev_out[d] = np.clip(np.round(filled * 100.0), -30000, 30000).astype(np.int16)

        stats["wetCells"].append(int(wet.sum()))
        stats["exposedKm2"].append(round(float((dry & ~land).sum()) * cell_area, 2))
        stats["meanLevel"].append(round(float(e.mean()), 4) if wet.any() else 0.0)
        if d % 10 == 0 or d == n_t - 1:
            _status(out_dir, "processing time steps", 5 + 80 * (d + 1) / n_t,
                    {"step": d + 1, "of": n_t})

    intertidal = ever_wet & ever_dry
    for d in range(n_t):
        wet_d = (elev_out[d].astype(np.float32) * 0.01) > terrain
        stats["floodedKm2"].append(round(float((wet_d & intertidal).sum()) * cell_area, 2))

    _status(out_dir, "writing files", 86)
    masks = (land.astype(np.uint8) | (intertidal.astype(np.uint8) << 1)).astype(np.uint8)
    terrain.astype("<f4").tofile(os.path.join(out_dir, "terrain.bin"))
    masks.tofile(os.path.join(out_dir, "masks.bin"))
    elev_out.tofile(os.path.join(out_dir, "elev.bin"))

    # velocity pair -> animated flow field + a derived "current speed" drape.
    # Handled before _extract_variables so u/v are excluded from it: as independent
    # scalars they'd each be normalized against their own range, which destroys
    # the vector relationship and makes direction unrecoverable.
    flow_meta = {"hasFlow": False}
    speed_var = None
    speed_stats = None
    consumed = {bname, ename}
    pair = _find_flow_pair(ds, n_t, ny, nx)
    if pair is not None:
        uname, vname, uvar, vvar = pair
        _status(out_dir, "exporting flow field", 88)
        flow_meta, speed_var, speed_stats = _write_flow(
            uvar, vvar, uname, vname, out_dir, n_t, ny, nx)
        consumed |= {uname, vname}

    # the sigma grid, if the file has one: one fraction field stands in for
    # every layer thickness at every timestep (see the 4-D section above)
    _status(out_dir, "vertical grid", 90)
    vgrid = _vertical_grid(ds, out_dir, n_t, ny, nx, land)
    ncol, sea = 0, None
    if vgrid is not None and profiles:
        ncol, sea = _write_cellmap(out_dir, land)

    # extra scalar fields (temperature, salinity, plankton, …) as colormap drapes
    _status(out_dir, "extracting variables", 92)
    variables, var_stats = _extract_variables(
        ds, out_dir, consumed, ny, nx, n_t, vgrid=vgrid,
        profiles={p.lower() for p in profiles},
        only=only, sea=sea, ncol=ncol)
    if speed_var is not None:
        variables.insert(0, speed_var)
        if speed_stats is not None:
            var_stats["speed"] = speed_stats
    stats["vars"] = var_stats
    # the real layer count, not the length of the level dimension: GETM pads it
    # with a dummy level that is fill everywhere
    n_layers = vgrid["nLayers"] if vgrid else None
    _drop_stale_variables(out_dir, variables)

    geo = _write_latlon(lat2d, lon2d, out_dir)

    # real-world imagery drape (best effort — needs internet + coordinates)
    sat_ok = False
    if lat2d is not None:
        try:
            _status(out_dir, "fetching satellite imagery", 92)
            sat_ok = bool(satellite.fetch(lat2d, lon2d, out_dir))
        except Exception as e:
            print(f"[pipeline] satellite imagery skipped: {e}")

    title = getattr(ds, "title", None) or os.path.splitext(os.path.basename(nc_path))[0]
    title = str(title).replace("_", " ")
    t_min = float(terrain.min())
    meta = {
        "title": title,
        "nx": int(nx), "ny": int(ny), "nDays": int(n_t),
        "cellKm": cell_km, "extentKm": [nx * cell_km, ny * cell_km],
        "startDate": start_date, "stepDays": step_days,
        "terrainMin": t_min, "terrainMax": float(terrain.max()),
        "baseHeight": min(-55.0, t_min - 8.0),
        "latMin": lat_min, "latMax": lat_max, "lonMin": lon_min, "lonMax": lon_max,
        **geo,
        "verticalDatum": _vertical_datum(ds, evar, bvar),
        "nLayers": n_layers,
        "vgrid": ({k: v for k, v in vgrid.items() if not k.startswith("_")}
                  if vgrid else None),
        "cellmap": ({"file": "cellmap.bin", "nColumns": ncol}
                    if ncol else None),
        "flow": flow_meta,
        "seaCells": int((~land).sum()),
        "intertidalCells": int(intertidal.sum()),
        "elevScale": 0.01,
        "satellite": sat_ok,
        "satelliteAttribution": satellite_attr() if sat_ok else "",
        "variables": variables,
        # Same list under the old key, for external scripts that read `params`.
        # This does NOT make an older viewer build work on new data: those
        # descriptors point at var_<key>.u16.bin, which such a build neither
        # looks for nor knows how to decode. The app reads `variables` first and
        # falls back to `params` only for datasets processed before the rename.
        "params": variables,
        "stats": stats,
    }
    with open(os.path.join(out_dir, "meta.json"), "w") as f:
        json.dump(meta, f)
    _status(out_dir, "done", 100)
    return meta


def refresh_latlon(nc_path, out_dir):
    """Write latlon.bin and patch its meta.json keys for an already-processed
    dataset — no need to re-run the (slow) full conversion just to pick up
    true coordinates. Returns the meta keys written."""
    import satellite
    lat2d, lon2d = satellite.read_latlon(nc_path)
    if lat2d is None:
        raise ValueError("no usable lat/lon in file")
    geo = _write_latlon(lat2d, lon2d, out_dir)

    mp = os.path.join(out_dir, "meta.json")
    if os.path.isfile(mp):
        with open(mp) as f:
            meta = json.load(f)
        ny, nx = lat2d.shape
        if (meta.get("ny"), meta.get("nx")) != (ny, nx):
            raise ValueError(f"grid {ny}x{nx} does not match dataset "
                             f"{meta.get('ny')}x{meta.get('nx')} in {mp}")
        meta.update(geo)
        with open(mp, "w") as f:
            json.dump(meta, f)
    return geo


if __name__ == "__main__":
    import sys
    args = sys.argv[1:]
    if args and args[0] == "--latlon":
        if len(args) < 3:
            print("usage: python nc_pipeline.py --latlon <file.nc> <dataset_dir>")
            sys.exit(1)
        g = refresh_latlon(args[1], args[2])
        print(f"OK: latlon.bin -> {args[2]} (grid north {g['gridNorthDeg']}°)")
        sys.exit(0)
    opts = {}
    rest = []
    i = 0
    while i < len(args):
        a = args[i]
        if a in ("--vars", "--profiles") and i + 1 < len(args):
            opts[a[2:]] = [x.strip() for x in args[i + 1].split(",") if x.strip()]
            i += 2
            continue
        rest.append(a)
        i += 1
    src = rest[0]
    out = rest[1] if len(rest) > 1 else os.path.join(os.path.dirname(__file__), "data", "dataset")
    only = {x.lower() for x in opts["vars"]} if "vars" in opts else None
    if only is not None:
        # the elevation and bathymetry the viewer is built on are found by name,
        # not by this list, but a user restricting variables still means "and
        # whatever you need" — so they are never filtered out here
        pass
    m = process(src, out, only=only, profiles=opts.get("profiles", ()))
    nl = m.get("nLayers")
    print(f"OK: {m['title']} — {m['nx']}x{m['ny']}, {m['nDays']} steps"
          + (f", {nl} layers" if nl else "") + f" -> {out}")
