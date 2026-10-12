"""
Fetch real-world satellite imagery (Esri World Imagery tiles) for a dataset's
lat/lon grid and store it next to the dataset:

  satellite.jpg  stitched web-mercator image covering the domain
  satuv.bin      float32[ny*nx*2] per-cell UV into satellite.jpg
                 (computed from the actual latc/lonc grid, so curvilinear
                  grids drape correctly)

Also flips meta.json's "satellite" flag when a meta.json already exists.

CLI:  python satellite.py <file.nc> <data/dir>
"""
import io
import json
import math
import os
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import numpy as np

TILE_URL = ("https://server.arcgisonline.com/ArcGIS/rest/services/"
            "World_Imagery/MapServer/tile/{z}/{y}/{x}")
ATTRIBUTION = "Imagery © Esri, Maxar, Earthstar Geographics"
MAX_DIM = 6144
TILE = 256


def _merc(lat, lon, z):
    """lat/lon (deg, arrays ok) -> fractional web-mercator tile coords."""
    n = 2 ** z
    x = (np.asarray(lon, float) + 180.0) / 360.0 * n
    lr = np.radians(np.clip(np.asarray(lat, float), -85.05, 85.05))
    y = (1.0 - np.arcsinh(np.tan(lr)) / math.pi) / 2.0 * n
    return x, y


def _get_tile(z, x, y):
    req = urllib.request.Request(
        TILE_URL.format(z=z, x=x, y=y),
        headers={"User-Agent": "digital-twin-viewer/1.0"})
    for attempt in range(2):
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return r.read()
        except Exception:
            if attempt:
                return None
    return None


def fetch(lat2d, lon2d, out_dir):
    """Download + stitch imagery for the grid; returns True on success."""
    from PIL import Image

    lat2d = np.asarray(lat2d, float)
    lon2d = np.asarray(lon2d, float)
    lat_min, lat_max = float(lat2d.min()), float(lat2d.max())
    lon_min, lon_max = float(lon2d.min()), float(lon2d.max())
    if lat_max - lat_min < 1e-6 or lon_max - lon_min < 1e-6:
        return False

    # highest zoom whose stitched image fits in MAX_DIM
    for z in range(13, 3, -1):
        x_w, y_s = _merc(lat_min, lon_min, z)   # south edge -> largest y
        x_e, y_n = _merc(lat_max, lon_max, z)
        tx0, tx1 = int(math.floor(x_w)), int(math.floor(x_e))
        ty0, ty1 = int(math.floor(y_n)), int(math.floor(y_s))
        w, h = (tx1 - tx0 + 1) * TILE, (ty1 - ty0 + 1) * TILE
        if w <= MAX_DIM and h <= MAX_DIM:
            break

    coords = [(x, y) for y in range(ty0, ty1 + 1) for x in range(tx0, tx1 + 1)]
    print(f"[satellite] zoom {z}, {len(coords)} tiles -> {w}x{h}px")
    with ThreadPoolExecutor(max_workers=8) as ex:
        blobs = list(ex.map(lambda c: _get_tile(z, c[0], c[1]), coords))

    failed = sum(b is None for b in blobs)
    if failed > len(coords) * 0.1:
        raise IOError(f"satellite tile download failed ({failed}/{len(coords)} tiles)")

    img = Image.new("RGB", (w, h), (90, 100, 90))
    for (x, y), blob in zip(coords, blobs):
        if blob is None:
            continue
        try:
            tile = Image.open(io.BytesIO(blob)).convert("RGB")
            img.paste(tile, ((x - tx0) * TILE, (y - ty0) * TILE))
        except Exception:
            pass
    img.save(os.path.join(out_dir, "satellite.jpg"), quality=88)

    # per-cell UV into the stitched image (v=0 at the south/bottom edge,
    # matching three.js' default flipY texture orientation)
    fx, fy = _merc(lat2d, lon2d, z)
    u = (fx - tx0) / (tx1 + 1 - tx0)
    v = 1.0 - (fy - ty0) / (ty1 + 1 - ty0)
    uv = np.stack([u, v], axis=-1).astype(np.float32)
    uv.tofile(os.path.join(out_dir, "satuv.bin"))

    mp = os.path.join(out_dir, "meta.json")
    if os.path.isfile(mp):
        with open(mp) as f:
            meta = json.load(f)
        meta["satellite"] = True
        meta["satelliteAttribution"] = ATTRIBUTION
        with open(mp, "w") as f:
            json.dump(meta, f)
    return True


def read_latlon(nc_path):
    """Full 2D lat/lon arrays from a NetCDF file. Coordinates are often
    masked over land, so masked cells are reconstructed by fitting a smooth
    quadratic surface lat/lon = f(row, col) to the valid cells (map
    projections are smooth, so this extrapolates accurately).
    Returns (lat2d, lon2d) or (None, None)."""
    import netCDF4 as nc

    # close on every path — a leaked handle keeps the .nc locked on Windows
    ds = nc.Dataset(nc_path)
    try:
        return _read_latlon(ds)
    finally:
        ds.close()


def _read_latlon(ds):
    lat = lon = None
    for names in (("latc", "lonc"), ("latitude", "longitude"), ("lat", "lon")):
        if names[0] in ds.variables and names[1] in ds.variables:
            lat = np.ma.masked_invalid(ds.variables[names[0]][:])
            lon = np.ma.masked_invalid(ds.variables[names[1]][:])
            break
    if lat is None:
        return None, None
    if lat.ndim == 1 and lon.ndim == 1:
        lon, lat = np.meshgrid(lon, lat)
        lat, lon = np.ma.masked_invalid(lat), np.ma.masked_invalid(lon)
    if lat.ndim != 2:
        return None, None

    ny, nx = lat.shape
    ii, jj = np.mgrid[0:ny, 0:nx]

    def fill(a):
        m = np.ma.getmaskarray(a)
        if not m.any():
            return np.ma.filled(a, 0.0)
        if m.sum() > a.size - 16:
            return None
        iv, jv = ii[~m].astype(float), jj[~m].astype(float)
        vals = np.ma.compressed(a)
        if iv.size > 20000:                      # subsample for the fit
            sel = np.random.default_rng(0).choice(iv.size, 20000, replace=False)
            iv, jv, vals = iv[sel], jv[sel], vals[sel]
        basis = lambda i, j: np.column_stack(
            [np.ones_like(i), j, i, j * j, i * i, i * j])
        coef, *_ = np.linalg.lstsq(basis(iv, jv), vals, rcond=None)
        full = (basis(ii.ravel().astype(float), jj.ravel().astype(float)) @ coef
                ).reshape(ny, nx)
        return np.where(m, full, np.ma.filled(a, 0.0))

    return fill(lat), fill(lon)


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("usage: python satellite.py <file.nc> <dataset_dir>")
        sys.exit(1)
    lat2d, lon2d = read_latlon(sys.argv[1])
    if lat2d is None:
        print("no usable lat/lon in file")
        sys.exit(2)
    ok = fetch(lat2d, lon2d, sys.argv[2])
    print("OK" if ok else "skipped (degenerate coordinates)")
