# -*- coding: utf-8 -*-
"""Split a CSV into one file per value of a column.

    python tools/split_csv.py MWTL_Turbidity.csv --by referentievlak --out <dir>
        -> <dir>/MWTL_Turbidity.WATSGL.csv, <dir>/MWTL_Turbidity.BODM.csv, ...

An observation collection has ONE vertical reference, but Rijkswaterstaat
exports (Waterinfo/DONAR, the MWTL WFS layers) give each row its own: a
sampling height in cm below the water surface (referentievlak WATSGL), above
the bed (BODM), or on NAP. Splitting on that column gives one file per
reference, each of which maps its height column onto a single vertical kind in
its sidecar (examples/observations/rws_mwtl_spm_*.json).

Values listed with --keep are written; the rest are counted and reported.
Standard library only.
"""
import argparse
import csv
import os
import sys
from collections import Counter


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0],
                                 formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__)
    ap.add_argument("csv", help="input CSV (UTF-8, header row)")
    ap.add_argument("--by", required=True, help="column whose values name the output files")
    ap.add_argument("--keep", default=None, help="comma-separated values to write (default: all)")
    ap.add_argument("--out", default=None, help="output folder (default: beside the input)")
    a = ap.parse_args(argv)

    keep = None if a.keep is None else {v.strip() for v in a.keep.split(",") if v.strip()}
    out_dir = a.out or os.path.dirname(os.path.abspath(a.csv))
    os.makedirs(out_dir, exist_ok=True)
    stem = os.path.splitext(os.path.basename(a.csv))[0]
    writers, files, counts, skipped = {}, {}, Counter(), Counter()
    with open(a.csv, encoding="utf-8-sig", newline="") as f:
        rd = csv.reader(f)
        head = next(rd)
        try:
            col = head.index(a.by)
        except ValueError:
            sys.exit(f"no column {a.by!r}; the header has {', '.join(head)}")
        for row in rd:
            v = row[col].strip() if col < len(row) else ""
            if keep is not None and v not in keep:
                skipped[v] += 1
                continue
            if v not in writers:
                safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in v) or "blank"
                path = os.path.join(out_dir, f"{stem}.{safe}.csv")
                files[v] = (open(path + ".part", "w", encoding="utf-8", newline=""), path)
                writers[v] = csv.writer(files[v][0], lineterminator="\n")
                writers[v].writerow(head)
            writers[v].writerow(row)
            counts[v] += 1
    for v, (fh, path) in files.items():
        fh.close()
        os.replace(path + ".part", path)
        print(f"{counts[v]:>8} rows  {a.by}={v}  -> {path}")
    for v, n in skipped.most_common():
        print(f"{n:>8} rows  {a.by}={v or '(blank)'}  skipped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
