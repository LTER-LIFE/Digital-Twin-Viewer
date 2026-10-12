r"""Rebuild the bundled default dataset (Dutch Wadden Sea 2015) from its source
NetCDF. Generic conversion lives in nc_pipeline.py.

The source .nc is hundreds of MB and is deliberately NOT in the repository (see
"Example applications and the bundled dataset" in README.md), so it has to be
located at run time:

  python preprocess.py                      # looks in the repo root
  python preprocess.py path\to\file.nc      # explicit path
  set WADEMOAAS_SRC_NC=D:\data\file.nc      # or point the env var at it
  python preprocess.py

Ask a maintainer for the current file if you do not have it; the default name
below is the one the bundled dataset was built from.
"""
import os
import sys

from nc_pipeline import process

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_NC = "yearly_dws_500m.3d.2015_hydro_bio.nc"
OUT = os.path.join(HERE, "data", "default")


def find_source(argv):
    """Explicit argument, then $WADEMOAAS_SRC_NC, then the repo root."""
    if len(argv) > 1:
        return argv[1], "command line"
    env = os.environ.get("WADEMOAAS_SRC_NC")
    if env:
        return env, "WADEMOAAS_SRC_NC"
    return os.path.join(HERE, DEFAULT_NC), "repo root"


if __name__ == "__main__":
    src, where = find_source(sys.argv)
    if not os.path.isfile(src):
        print(f"Source NetCDF not found ({where}):\n  {os.path.abspath(src)}\n")
        print("The .nc is not kept in the repository because it is far too large")
        print("and nothing but this script reads it. Point one of these at a copy:")
        print(f"  python preprocess.py <path to {DEFAULT_NC}>")
        print("  set WADEMOAAS_SRC_NC=<path>   (PowerShell: $env:WADEMOAAS_SRC_NC='<path>')")
        sys.exit(1)
    print(f"[preprocess] source ({where}): {os.path.abspath(src)}")
    meta = process(src, OUT)
    print(f"OK: {meta['title']} — {meta['nx']}x{meta['ny']}, {meta['nDays']} steps -> {OUT}")
