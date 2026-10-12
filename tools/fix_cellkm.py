# -*- coding: utf-8 -*-
"""Correct cellKm (and everything derived from it) in already-processed datasets.

Re-running the whole pipeline would take half an hour per dataset on the cluster
to change three numbers and rescale two series, all of which are exactly
recoverable: the areas are linear in cell area, so the stored values only need
the ratio applied.

    python tools/fix_cellkm.py data [--apply]

Dry run by default.
"""
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from nc_pipeline import _cell_km                        # noqa: E402


class NoDS:
    variables = {}


def fix(d, apply_it):
    mp = os.path.join(d, "meta.json")
    lp = os.path.join(d, "latlon.bin")
    if not os.path.exists(mp):
        return
    with open(mp, encoding="utf-8") as f:
        m = json.load(f)
    name = os.path.basename(d)
    if not os.path.exists(lp):
        print(f"{name:28s} no latlon.bin — cannot measure, left alone")
        return

    ll = np.fromfile(lp, dtype="<f4").reshape(m["ny"], m["nx"], 2)
    got = _cell_km(NoDS(), ll[..., 0], ll[..., 1])
    old = m.get("cellKm")
    if old and abs(got - old) / got < 0.02:
        print(f"{name:28s} {old} km — already right")
        return

    ratio = (got / old) ** 2 if old else 1.0
    print(f"{name:28s} {old} -> {got} km   (areas x{ratio:.1f})")
    if not apply_it:
        return

    m["cellKm"] = got
    m["extentKm"] = [m["nx"] * got, m["ny"] * got]
    st = m.get("stats") or {}
    for key in ("exposedKm2", "floodedKm2"):
        if isinstance(st.get(key), list):
            st[key] = [round(v * ratio, 2) for v in st[key]]
    tmp = mp + ".part"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(m, f)
    os.replace(tmp, mp)
    print(f"{'':28s} written")


if __name__ == "__main__":
    root = sys.argv[1]
    apply_it = "--apply" in sys.argv
    for name in sorted(os.listdir(root)):
        p = os.path.join(root, name)
        if os.path.isdir(p):
            fix(p, apply_it)
    if not apply_it:
        print("\n(dry run — pass --apply to write)")
